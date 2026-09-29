// dsh-raw-dump 宿主端入口（适配 DSH 0.2.0，运行在 cordis 4 的宿主平面上）
//
// 唯一职责：把 globalThis.fetch 包一层，把每次发往模型端点的**原始请求体**追加落盘。
// 抓取逻辑全在 lib/core.js（可单测、不依赖 cordis）；这里只做宿主装配：
//
//   1. ctx.effect() 内 install/uninstall，保证 profile 热重载时不留下野包装
//   2. 可选 Session 归属：把 llm/stream 的 options.sessionId 通过 AsyncLocalStorage
//      放到该次拉取的执行上下文里，fetch 层就能读到（没有也不影响抓取）
//   3. 只读浏览接口：/dsh-raw-dump（页面）+ /api/list · /api/get · /api/status · /api/sweep
//   4. 一个 raw_dump_status 工具，便于 agent 自查抓取状态
//
// 0.2.0 上的三处接口纪律（都已按 0.2.0 的源码核对）：
//   - webServer.register(route) 只吃一个参数，第二参数已无意义
//   - tools.register 的 parameters 是**raw JSON Schema 子集**（type/properties/…）
//   - commands.register 的 handler 拿到的还是 { name, rawInput }，返回 { kind, text }
//
// 不注册 client bundle：不需要编译步骤，纯宿主插件。

import { AsyncLocalStorage } from "node:async_hooks";
import { createCapture, renderPage, resolveConfig } from "./core.js";

// 包名必须与 package.json 的 name、cordis.patch.yml 里 loader 行的 name 完全一致：
// 加载器按这个 name 去 import，不一致就是 ERR_MODULE_NOT_FOUND。
export const name = "@laogou0927/dsh-raw-dump";

// 必需的宿主服务。注意 cordis 的 ctx 是严格代理：**没在 inject 里声明就读取属性会直接抛错**
// （"cannot get property X without inject"），所以可选的 tools/commands/webServer
// 一律走 ctx.get(...) 或 ctx.inject([...])，不要直接挂到 inject 上。
export const inject = ["llm"];

const BASE = "/dsh-raw-dump";

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({});
        return;
      }
      try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

/**
 * 把 llm/stream 的 sessionId 绑到「拉取流」的执行上下文上。
 * 适配器的网络请求发生在它自己的消费者拉取这个流的时候，所以包住迭代器的 next/return
 * 就足以让下面的 fetch 包装读到正确的 sessionId。返回 undefined 表示没有可用的 id。
 *
 * 0.2.0 里 `GenerateOptions.sessionId` 在 agent loop 构造的请求上**总是**带着
 * （dsh-agent-loop/lib/invariant.js: "a loop-built request must carry a session id"），
 * 类型是 dsh-session 的 SessionId 品牌（运行期就是字符串，`String()` 一定安全）。
 * 所以：拿不到就原样放行，拿到就归一成字符串再进 AsyncLocalStorage。
 */
function withSessionScope(ctx, sessionScope) {
  ctx.on("llm/stream", (options, next) => {
    const raw = options?.sessionId;
    const sessionId = raw === undefined || raw === null ? "" : String(raw);
    if (sessionId.length === 0) return next();
    const source = next();
    // 下游返回的**不一定**是自带 next/return/throw 的生成器：st-bridge / preset-plus 这类
    // 插件在监听器里又调了一次 ctx.llm.stream(...) 并把它的返回值原样交出来，而那个返回值
    // 已经是本函数包装过的对象（异步可迭代、但没有 next）。直接照抄 source 的方法名会得到
    // 全 undefined 的迭代器，消费者 for await 时报 "undefined is not a function"。
    // 所以先拿到「真正的迭代器」再包：是迭代器就用它本身，否则调它的 Symbol.asyncIterator。
    if (source === null || typeof source !== "object") return source;
    if (typeof source[Symbol.asyncIterator] !== "function") return source;
    let target = source;
    if (typeof source.next !== "function") {
      try { target = source[Symbol.asyncIterator](); }
      catch { return source; }
      if (target === null || typeof target !== "object" || typeof target.next !== "function") return source;
    }
    const wrap = (method) => {
      const original = target?.[method];
      if (typeof original !== "function") return undefined;
      return (...args) => sessionScope.run(sessionId, () => original.apply(target, args));
    };
    const iterator = {
      next: wrap("next"),
      return: wrap("return"),
      throw: wrap("throw"),
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }, { global: true });
}

/**
 * 注册浏览接口。
 *
 * 0.2.0 的 `webServer.register(route)` 只接受一个参数（route），旧的第二个 "label"
 * 参数已被忽略；路由形状仍是 `{ kind: "exact" | "prefix", path, handler }`，
 * handler 拿到 (req, res) 并自己负责整段响应。
 *
 * **必须收集每个 register() 返回的 disposer 并在 effect 里交回去**：
 * 重复的 (kind, path) 会直接抛 "duplicate exact route"，所以热重载时如果不先释放旧路由，
 * 第二次注册就会抛错 → 本插件 fiber 回滚 → fetch 包装被卸掉、抓取静默停止。
 * （0.1.5 版本就是 return undefined 的写法，重载一次就废。）
 */
function installWebRoutes(ctx, capture) {
  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      const disposers = [];
      const route = (definition) => {
        disposers.push(host.webServer.register(definition));
      };

      route({
        kind: "exact",
        path: BASE,
        handler: (req, res) => {
          res.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
          });
          res.end(renderPage(BASE));
        },
      });

      route({
        kind: "exact",
        path: `${BASE}/api/status`,
        handler: async (req, res) => {
          try { sendJson(res, 200, { ok: true, status: await capture.status() }); }
          catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); }
        },
      });

      route({
        kind: "exact",
        path: `${BASE}/api/list`,
        handler: async (req, res) => {
          try {
            const query = new URL(req.url ?? "", "http://127.0.0.1").searchParams;
            const limit = Number(query.get("limit") ?? 100);
            const sessionId = query.get("session");
            const [status, records] = await Promise.all([
              capture.status(),
              capture.list({ limit: Number.isFinite(limit) ? limit : 100, sessionId: sessionId || null }),
            ]);
            sendJson(res, 200, { ok: true, status, records });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      });

      route({
        kind: "exact",
        path: `${BASE}/api/get`,
        handler: async (req, res) => {
          try {
            const query = new URL(req.url ?? "", "http://127.0.0.1").searchParams;
            const id = query.get("id") ?? "";
            const records = await capture.get(id);
            if (records === null) { sendJson(res, 404, { ok: false, error: "no record for id" }); return; }
            sendJson(res, 200, { ok: true, records });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      });

      route({
        kind: "exact",
        path: `${BASE}/api/sweep`,
        handler: async (req, res) => {
          if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
          try {
            const body = await readBody(req);
            const result = await capture.sweep({
              days: body?.days ?? capture.cfg.retentionDays,
              drain: body?.drain === true,
            });
            sendJson(res, 200, { ok: true, ...result, status: await capture.status() });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      });

      return () => {
        for (const dispose of disposers.reverse()) {
          try { dispose(); } catch { /* 已经被回收过 */ }
        }
      };
    }, "dsh-raw-dump: http routes");
  });
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config ?? {});
  if (cfg.enabled !== true) return;

  const sessionScope = cfg.attributeSession === false ? null : new AsyncLocalStorage();
  // sessionScope 必须**交给 createCapture**：抓取层就是靠它把 fetch 归到当前会话的。
  // （0.1.5 版本漏了这一步，AsyncLocalStorage 建了却没人用，落盘的 sessionId 永远是 null。）
  const capture = createCapture(config ?? {}, {
    ...(sessionScope === null ? {} : { sessionScope }),
    warn: (message) => ctx.logger?.warn?.(`[dsh-raw-dump] ${message}`),
  });

  ctx.effect(() => {
    const installed = capture.install();
    if (!installed) {
      ctx.logger?.warn?.("[dsh-raw-dump] 未能安装 fetch 包装；抓取未生效");
      return () => {};
    }
    ctx.logger?.info?.(`[dsh-raw-dump] 线级抓取已启用 -> ${capture.cfg.directory}`
      + `（match(${capture.cfg.matchMode})=${capture.cfg.match.join(", ")}${capture.cfg.matchAll ? " · matchAll" : ""}`
      + `${capture.cfg.captureResponse ? " · 含响应体" : ""}）`);
    return () => {
      capture.uninstall();
      ctx.logger?.info?.("[dsh-raw-dump] 线级抓取已卸载");
    };
  }, "dsh-raw-dump: fetch wrapper");

  if (sessionScope) withSessionScope(ctx, sessionScope);
  installWebRoutes(ctx, capture);

  // tools 走 ctx.get：没这个服务时静默跳过，而不是让整个插件加载失败。
  // 注册放进 ctx.effect 并把它返回的 disposer 交回去 —— 这样 profile 重载 / HMR 时
  // 工具会跟着本 fiber 一起收回（否则重载后重名注册会直接抛错）。
  const tools = ctx.get?.("tools");
  if (tools) {
    ctx.effect(() => tools.register({
      name: "raw_dump_status",
      description: "查看 dsh-raw-dump 的线级抓取状态：落盘目录、已抓条数、文件与占用、最近一次抓取；action=sweep 可按天数清理，action=drain 清空。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["status", "sweep", "drain"], description: "默认 status" },
          days: { type: "number", description: "sweep 时保留的天数；省略则用配置的 retentionDays" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute(args = {}) {
        const action = String(args?.action ?? "status");
        if (action === "sweep" || action === "drain") {
          const result = await capture.sweep(action === "drain"
            ? { drain: true }
            : { days: args?.days ?? capture.cfg.retentionDays });
          const status = await capture.status();
          return {
            text: `${action === "drain" ? "已清空" : "已清理"} ${result.removed.length} 个文件，`
              + `释放 ${result.freedBytes} 字节；目录现有 ${status.fileCount} 个文件 / ${status.diskBytes} 字节。`,
          };
        }
        const status = await capture.status();
        const files = status.files.slice(-6).map((f) => `  ${f.date ?? ""}/${f.name}  ${f.bytes} B`).join("\n");
        return {
          text: [
            `安装: ${status.installed ? "是" : "否"}（enabled=${status.enabled}）`,
            `目录: ${status.directory}`,
            `布局: ${status.layout}`,
            `匹配(${status.matchMode ?? "path"}): ${status.match.join(", ")}${status.matchAll ? " （matchAll）" : ""}`,
            `响应体: ${status.captureResponse ? "抓" : "不抓"}`,
            `见过: ${status.seen} / 命中: ${status.captured + status.failed} / 跳过: ${status.skipped}`,
            `已抓请求: ${status.records} 次 · 写失败 ${status.writeErrors} · 读失败 ${status.readErrors}`,
            `文件: ${status.dateDirs} 个日期目录 / ${status.fileCount} 个文件 / ${status.diskBytes} 字节`,
            `最近一次: ${status.lastAt ?? "(还没有)"}`,
            files ? `最近文件:\n${files}` : "",
          ].filter(Boolean).join("\n"),
        };
      },
    }), "dsh-raw-dump: raw_dump_status tool");
  }

  const commands = ctx.get?.("commands");
  if (commands) {
    ctx.effect(() => commands.register({
      name: "raw-dump",
      description: "线级报文落盘：status | sweep | drain | path",
      input: { hint: "status | sweep | drain | path" },
      handler: async (invocation) => {
        const sub = ((invocation.rawInput ?? "").trim().split(/\s+/)[0] || "status").toLowerCase();
        if (sub === "path") return { kind: "success", text: capture.cfg.directory };
        if (sub === "sweep" || sub === "drain") {
          const result = await capture.sweep(sub === "drain" ? { drain: true } : { days: capture.cfg.retentionDays });
          return { kind: "success", text: `删除 ${result.removed.length} 个日期目录（${result.freedFiles} 个文件），释放 ${result.freedBytes} 字节` };
        }
        const status = await capture.status();
        return {
          kind: "success",
          text: `安装=${status.installed} 目录=${status.directory} 命中=${status.captured} 请求数=${status.records} `
            + `日期目录=${status.dateDirs} 文件=${status.fileCount} 占用=${status.diskBytes}`,
        };
      },
    }), "dsh-raw-dump: raw-dump command");
  }
}
