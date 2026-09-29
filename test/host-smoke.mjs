// dsh-raw-dump（0.2.0 适配版）宿主集成冒烟：不启动 cordis，用手写假 ctx 调用 apply()，
// 把注册出来的事件监听 / web 路由 / 工具 / 命令 真正跑一遍。
//
// 这一步的价值：重启 dsh web 之前就能发现宿主接口拼错（路由字段名、
// output.render 形状、ctx.effect/ctx.inject 调用顺序）的问题。
// 0.2.0 的三条接口纪律在这里被钉住：webServer.register 只吃一个参数、
// tools.register 的 parameters 是 raw JSON Schema、commands handler 返回 { kind, text }。
//
//   node test/host-smoke.mjs

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, name as pluginName } from "../lib/index.js";

const dir = await mkdtemp(join(tmpdir(), "dsh-raw-dump-host-"));

// ── 假 ctx：只记下 apply() 真正用到的那几件事 ────────────────────────
const disposers = [];
const logged = [];
const fakeHost = {
  effect(execute, label) {
    registered.effects.push(label);
    const disposer = execute();
    if (typeof disposer === "function") disposers.push(disposer);
    return typeof disposer === "function" ? disposer : () => {};
  },
  webServer: {
    // 0.2.0 的 webServer.register(route) 只接受一个参数（第二个已被忽略），
    // 并且**返回一个真正能摘掉路由的 disposer** —— 这里照抄这个语义，
    // 好让"没把 disposer 交回去"这种重载级 bug 在本测试里就现形。
    register(route, ...extra) {
      assert.equal(extra.length, 0, `webServer.register 只能传一个参数，实得 ${extra.length + 1} 个`);
      registered.routes.push(route);
      return () => {
        const at = registered.routes.indexOf(route);
        if (at >= 0) registered.routes.splice(at, 1);
      };
    },
  },
};

const registered = { routes: [], tools: [], commands: [], events: [], effects: [], injected: [] };

const fakeTools = {
  register(definition) {
    registered.tools.push(definition);
    return () => {
      const at = registered.tools.indexOf(definition);
      if (at >= 0) registered.tools.splice(at, 1);
    };
  },
};
const fakeCommands = {
  register(definition) {
    registered.commands.push(definition);
    return () => {
      const at = registered.commands.indexOf(definition);
      if (at >= 0) registered.commands.splice(at, 1);
    };
  },
};

/**
 * 复刻 cordis 的关键行为：ctx 是严格代理，**没声明 inject 的服务属性不能直接读**
 * （读到就抛 "cannot get property X without inject"）。
 * 没有这层代理，冒烟测试就抓不到真实的加载期错误。
 */
const ALLOWED = new Set(["effect", "inject", "get", "on", "logger"]);
const fakeLogger = {
  info: (message) => logged.push(String(message)),
  warn: (message) => logged.push(String(message)),
};
const rawCtx = {
  logger: fakeLogger,
  effect(execute, label) {
    registered.effects.push(label);
    const disposer = execute();
    if (typeof disposer === "function") disposers.push(disposer);
    return typeof disposer === "function" ? disposer : () => {};
  },
  inject(deps, callback) {
    registered.injected.push(deps);
    // cordis 的 ctx.inject 会带上服务可用的子 ctx；这里直接把假 host 传进去
    callback(fakeHost);
    return { dispose() {} };
  },
  // 只有 ctx.get(...) 是安全的服务探测方式
  get(service) {
    if (service === "tools") return fakeTools;
    if (service === "commands") return fakeCommands;
    return undefined;
  },
  on(event, listener, options) {
    registered.events.push({ event, options });
    return () => {};
  },
};

const ctx = new Proxy(rawCtx, {
  get(target, property, receiver) {
    if (typeof property === "symbol" || ALLOWED.has(property) || property in target) {
      return Reflect.get(target, property, receiver);
    }
    throw new Error(`cannot get property "${String(property)}" without inject`);
  },
});

const realFetch = globalThis.fetch;
apply(ctx, { directory: dir, headerAllow: [] });

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

check(pluginName === "@laogou0927/dsh-raw-dump", "导出 name 与包名不一致");
check(registered.injected.some((d) => d.includes("webServer")), "没有注入 webServer");
check(registered.events.some((e) => e.event === "llm/stream" && e.options?.global === true), "没有全局 llm/stream 监听");
check(globalThis.fetch !== realFetch, "apply() 之后 globalThis.fetch 没有被包装");
check(globalThis.fetch?.__dshRawDump === true, "包装缺少 __dshRawDump 标记");

const tool = registered.tools.find((t) => t.name === "raw_dump_status");
check(tool !== undefined, "没有注册 raw_dump_status 工具");
check(tool?.parameters?.type === "object", "工具 parameters 不是 object schema");
check(tool?.parameters?.additionalProperties === false, "工具 parameters 缺少 additionalProperties:false");
check(typeof tool?.parameters?.properties?.action === "object", "工具 parameters 缺少 action 属性");
check(typeof tool?.output?.schema === "object", "工具缺少 output.schema");
check(typeof tool?.output?.render === "function", "工具缺少 output.render");
check(tool?.execute !== undefined, "工具缺少 execute");
check(registered.commands.some((c) => c.name === "raw-dump"), "没有注册 /raw-dump 命令");
check(registered.commands.find((c) => c.name === "raw-dump")?.input?.hint?.length > 0, "命令缺少 input.hint");

const paths = registered.routes.map((r) => r.path).sort();
for (const expected of ["/dsh-raw-dump", "/dsh-raw-dump/api/get", "/dsh-raw-dump/api/list", "/dsh-raw-dump/api/status", "/dsh-raw-dump/api/sweep"]) {
  check(paths.includes(expected), `缺少路由 ${expected}`);
}
check(registered.routes.every((r) => r.kind === "exact"), "路由 kind 不是 exact");
const toolNames = registered.tools.map((t) => t.name);
const commandNames = registered.commands.map((c) => c.name);

// ── 把注册出来的路由挂到真 http 服务上打一遍 ──────────────────────────
const server = createServer(async (req, res) => {
  const route = registered.routes.find((r) => r.path === new URL(req.url ?? "/", "http://x").pathname);
  if (!route) { res.writeHead(404); res.end("no route"); return; }
  try { await route.handler(req, res); }
  catch (error) { res.writeHead(500); res.end(String(error?.message ?? error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function get(path, init) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 页面是 HTML */ }
  return { status: response.status, text, json };
}

try {
  // 页面
  const page = await get("/dsh-raw-dump");
  check(page.status === 200, `页面状态 ${page.status}`);
  check(page.text.includes("dsh-raw-dump"), "页面内容不含标题");

  // 状态
  const status = await get("/dsh-raw-dump/api/status");
  check(status.status === 200 && status.json?.ok === true, "status 路由不返回 ok:true");
  check(status.json?.status?.directory === dir, "status 里的 directory 不符");
  check(status.json?.status?.installed === true, "status.installed 不为 true");

  // 造一条记录：走被包装的 fetch 打到本地端点（用 0.2.0 的 Messages 端点形态）
  const sink = createServer((req, res) => { req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const payload = JSON.stringify({
    model: "deepseek-flash",
    max_tokens: 64,
    stream: true,
    system: [{ type: "text", text: "系统" }],
    messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
  });
  await fetch(`http://127.0.0.1:${sink.address().port}/anthropic/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await new Promise((resolve) => sink.close(resolve));

  const list = await get("/dsh-raw-dump/api/list?limit=10");
  check(list.status === 200 && list.json?.records?.length === 1, `list 期望 1 条，实得 ${list.json?.records?.length}`);
  const id = list.json?.records?.[0]?.id;
  check(typeof id === "string" && id.length > 0, "list 里没有 id");
  check(list.json?.records?.[0]?.requestBytes === Buffer.byteLength(payload), "list 的 requestBytes 不符");
  check(list.json?.records?.[0]?.endpoint === "messages", "list 里没有端点名");
  check(list.json?.records?.[0]?.protocol === "messages", "list 里协议判定不是 messages");
  check(list.json?.records?.[0]?.wire?.messages === 1, "list 里 wire.messages 不符");

  const detail = await get(`/dsh-raw-dump/api/get?id=${encodeURIComponent(id ?? "")}`);
  check(detail.status === 200, `get 状态 ${detail.status}`);
  check(detail.json?.records?.[0]?.request?.text === payload, "get 返回的 request.text 与发送字节不一致");

  const missing = await get("/dsh-raw-dump/api/get?id=nope");
  check(missing.status === 404, `未知 id 期望 404，实得 ${missing.status}`);

  const sweep405 = await get("/dsh-raw-dump/api/sweep", { method: "GET" });
  check(sweep405.status === 405, `GET sweep 期望 405，实得 ${sweep405.status}`);
  const sweep = await get("/dsh-raw-dump/api/sweep", { method: "POST", body: JSON.stringify({ drain: true }) });
  check(sweep.status === 200 && sweep.json?.removed?.length === 1, "drain 未删掉 1 个文件");
  check((await get("/dsh-raw-dump/api/get?id=" + encodeURIComponent(id ?? ""))).status === 404, "清空后仍能取到记录");

  // 工具：返回值要能被 output.render 吃下并产出文本块
  const toolResult = await tool.execute({ action: "status" }, { signal: new AbortController().signal });
  const rendered = tool.output.render({}, toolResult);
  check(Array.isArray(rendered) && rendered[0]?.type === "text", "output.render 未产出 text 块");
  check(String(rendered[0]?.text).includes(dir), "工具状态文本不含落盘目录");
  const swept = await tool.execute({ action: "drain" }, { signal: new AbortController().signal });
  check(typeof swept?.text === "string" && swept.text.length > 0, "drain 工具返回异常");

  // 命令
  const command = registered.commands.find((c) => c.name === "raw-dump");
  const pathOut = await command.handler({ rawInput: "path" });
  check(pathOut?.kind === "success" && pathOut.text === dir, "命令 path 输出不符");
  const statusOut = await command.handler({ rawInput: "status" });
  check(/安装=true/.test(String(statusOut?.text)), "命令 status 输出不含安装状态");
} finally {
  await new Promise((resolve) => server.close(resolve));
  for (const dispose of disposers.reverse()) {
    try { await dispose(); } catch (error) { problems.push(`disposer 抛错：${String(error?.message ?? error)}`); }
  }
  await rm(dir, { recursive: true, force: true });
}

check(globalThis.fetch === realFetch, "effect disposer 执行后 globalThis.fetch 没有还原");
// 卸载必须把路由/工具/命令都摘干净 —— 否则热重载时会撞 "duplicate exact route"
check(registered.routes.length === 0, `卸载后仍留着 ${registered.routes.length} 条路由：${registered.routes.map((r) => r.path).join(", ")}`);
check(registered.tools.length === 0, "卸载后工具没被收回");
check(registered.commands.length === 0, "卸载后命令没被收回");

console.log("── dsh-raw-dump（0.2.0 适配版）宿主集成冒烟 ──");
console.log(`路由 ${paths.length} 条：${paths.join(", ")}`);
console.log(`工具 ${toolNames.join(", ") || "(无)"} · 命令 ${commandNames.join(", ") || "(无)"}`);
console.log(`全局监听 ${registered.events.map((e) => e.event).join(", ") || "(无)"} · effect ${registered.effects.length} 个`);
console.log(`卸载后残留 路由=${registered.routes.length} 工具=${registered.tools.length} 命令=${registered.commands.length}`);
console.log(`宿主日志 ${logged.length} 条：${logged.slice(0, 2).join(" / ") || "(无)"}`);

if (problems.length > 0) {
  console.error("\n失败：");
  for (const p of problems) console.error("  ✖ " + p);
  process.exit(1);
}
console.log("\n✔ 宿主接口全部对上：路由 / 工具 / 命令 / 包装 均按约定注册并可用");
