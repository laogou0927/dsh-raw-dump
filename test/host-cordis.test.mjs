// 真实 cordis 宿主测试：用 DSH 0.2.0 运行时里**真实的** @deepseek-ai/cordis（4.0.4）
// 加载本插件，真跑一遍 ctx.effect / ctx.inject / ctx.on({global:true}) /
// ctx.get("tools") / ctx.get("commands") / webServer 路由 / llm/stream session 归属。
//
// 为什么需要它：test/host-smoke.mjs 用的是手写假 ctx，只能证明"我们照着以为的接口写了"。
// 这个文件证明"0.2.0 的 cordis 真的会接受这种写法"——包括严格代理、fiber 生命周期、
// 瀑布式 llm/stream 的 next() 语义、以及 disposer 是否真的把 globalThis.fetch 还原。
//
// 需要一份可加载的 cordis：用 DSH_CORDIS_DIR 指向含 node_modules 的目录，
// 例如解包出来的 <rt>（里面是 node_modules/@deepseek-ai/cordis）。
// 找不到就跳过（退出码 0），不让没装 DSH 0.2.0 的机器红掉。
//
//   node test/host-cordis.test.mjs

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { apply, inject, name as pluginName } from "../lib/index.js";

const candidates = [
  process.env.DSH_CORDIS_DIR,
  process.env.DSH_RUNTIME_DIR,
].filter((v) => typeof v === "string" && v.length > 0).map((v) => resolve(v));

let cordisEntry = null;
for (const dir of candidates) {
  const entry = join(dir, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js");
  if (existsSync(entry)) { cordisEntry = entry; break; }
}
if (cordisEntry === null) {
  console.log("跳过：没找到可加载的 @deepseek-ai/cordis（设置 DSH_CORDIS_DIR 指向含 node_modules 的运行时目录）");
  process.exit(0);
}

const { Context } = await import(pathToFileURL(cordisEntry).href);

const dir = await mkdtemp(join(tmpdir(), "dsh-raw-dump-cordis-"));
const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

// ── 真实 cordis 根上下文 + 三个假宿主服务 ────────────────────────────
const root = new Context({});
root.logger.level = 99;                       // 静音，别把日志刷到测试输出里

const routes = new Map();
const tools = new Map();
const commands = new Map();
const llmStreams = [];

root.provide("webServer", {
  port: 0,
  host: "127.0.0.1",
  register(route) {
    if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  },
});
root.provide("tools", {
  register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); },
});
root.provide("commands", {
  register(definition) { commands.set(definition.name, definition); return () => commands.delete(definition.name); },
});

/**
 * 最小 llm 服务，形状照着 dsh-llm 的 LlmRuntime.stream：
 *   stream(options) { return ctx.waterfall(this, "llm/stream", options, () => adapterStream(options)) }
 * 适配器的网络请求发生在消费者 next() 这个流的时候 —— 正是本插件依赖的时机。
 */
const llm = {
  stream(options) {
    return root.waterfall(this, "llm/stream", options, () => this.adapterStream(options));
  },
  async *adapterStream(options) {
    llmStreams.push("adapter-pull");
    const response = await fetch(options.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: options.body,
    });
    yield { type: "response", status: response.status, text: await response.text() };
  },
};

const realFetch = globalThis.fetch;
// 顺序说明：llm 是本插件的 inject 依赖，所以必须在加载插件行之前就位
// （真实 DSH 里 llm 行排在插件行之前）。
root.provide("llm", llm);
const fiber = root.plugin({ name: pluginName, inject, apply }, { directory: dir, headerAllow: ["content-type"] });
await fiber.await();

// ── 加载期：包装、路由、工具、命令 ───────────────────────────────────
check(globalThis.fetch !== realFetch, "加载后 globalThis.fetch 没有被包装");
check(globalThis.fetch?.__dshRawDump === true, "包装缺少 __dshRawDump 标记");
for (const path of ["/dsh-raw-dump", "/dsh-raw-dump/api/status", "/dsh-raw-dump/api/list", "/dsh-raw-dump/api/get", "/dsh-raw-dump/api/sweep"]) {
  check(routes.has(path), `真实 cordis 下缺少路由 ${path}`);
}
check(routes.size === 5, `路由数应为 5，实得 ${routes.size}`);
check(tools.has("raw_dump_status"), "真实 cordis 下没注册 raw_dump_status 工具");
check(commands.has("raw-dump"), "真实 cordis 下没注册 /raw-dump 命令");

// ── 运行期：llm/stream 的 sessionId 归属 + 抓取 ──────────────────────
const sink = createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"deepseek-flash"}}\n\n');
  res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
});
await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${sink.address().port}/anthropic/messages`;
const body = JSON.stringify({
  model: "deepseek-flash",
  max_tokens: 32,
  stream: true,
  system: [{ type: "text", text: "系统" }],
  messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
});

try {
  // 把注册出来的路由挂到真 http server 上：验证 0.2.0 的 handler(req,res) 契约
  const host = createServer(async (req, res) => {
    const route = routes.get(new URL(req.url ?? "/", "http://x").pathname);
    if (route === undefined) { res.writeHead(404); res.end("no route"); return; }
    await route.handler(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  const hostBase = `http://127.0.0.1:${host.address().port}`;

  const chunks = [];
  const stream = root.llm.stream({ sessionId: "session-cordis-1", url: endpoint, body, provider: "test", model: "deepseek-flash" });
  for await (const chunk of stream) chunks.push(chunk);
  check(chunks.length === 1 && chunks[0].status === 200, "llm.stream 的消费结果不对");
  check(llmStreams.length === 1, "适配器拉取没有被走到");

  // 等落盘完成：轮询插件自己的 status 路由
  let status = null;
  for (let i = 0; i < 60; i += 1) {
    const response = await fetch(`${hostBase}/dsh-raw-dump/api/status`);
    status = (await response.json()).status;
    if (status.records >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check(status !== null && status.installed === true, "status 路由没有报告 installed");
  check(status !== null && status.records === 1, `status.records 期望 1，实得 ${status?.records}`);
  check(status !== null && status.fileCount === 2, `status.fileCount 期望 2，实得 ${status?.fileCount}`);
  check(status !== null && status.captured === 1, "status.captured 期望 1");

  const listResponse = await fetch(`${hostBase}/dsh-raw-dump/api/list?limit=5`);
  const list = await listResponse.json();
  check(list.ok === true && list.records.length === 1, `list 期望 1 条，实得 ${list.records?.length}`);
  check(list.records[0]?.sessionId === "session-cordis-1", `list 的 sessionId 归属失败：${list.records[0]?.sessionId}`);
  check(list.records[0]?.endpoint === "messages", `list 的端点名不对：${list.records[0]?.endpoint}`);
  check(list.records[0]?.wire?.protocol === "messages", "list 的协议判定不对");

  const detailResponse = await fetch(`${hostBase}/dsh-raw-dump/api/get?id=${encodeURIComponent(list.records[0].id)}`);
  const detail = await detailResponse.json();
  check(detail.ok === true && detail.records.length === 1, "get 没有取到记录");
  check(JSON.stringify(JSON.parse(detail.records[0].request.text)) === JSON.stringify(JSON.parse(body)),
    "落盘请求体与发送字节 JSON 不等值");
  check(detail.records[0].headers["content-type"] === "application/json", "headerAllow 名单没有生效");

  // 工具真的能用真实 cordis 的 tools 服务跑起来
  const tool = tools.get("raw_dump_status");
  const toolValue = await tool.execute({ action: "status" }, { signal: new AbortController().signal });
  const rendered = tool.output.render({ action: "status" }, toolValue);
  check(Array.isArray(rendered) && rendered[0]?.type === "text", "工具 output.render 没有产出 text 块");
  check(String(rendered[0]?.text).includes(dir), "工具状态文本不含落盘目录");

  // 命令同样
  const command = commands.get("raw-dump");
  const commandResult = await command.handler({ name: "raw-dump", rawInput: "path" });
  check(commandResult?.kind === "success" && commandResult.text === dir, `命令 path 输出不对：${commandResult?.text}`);

  await new Promise((resolve) => host.close(resolve));
} finally {
  await new Promise((resolve) => sink.close(resolve));
}

// 卸载：fiber.dispose() 必须把包装和注册都收回去 ──────────────────────
// 这是 0.1.5 版本最要命的一处：路由/工具/命令都没把 disposer 交回去，
// 于是重载一次就会撞上 "duplicate exact route" 并把整个插件带下去。
await fiber.dispose();
check(globalThis.fetch === realFetch, "fiber 释放后 globalThis.fetch 没有还原");
check(routes.size === 0, `fiber 释放后仍留着路由：${[...routes.keys()].join(", ")}`);
check(tools.size === 0, "fiber 释放后工具没被收回");
check(commands.size === 0, "fiber 释放后命令没被收回");

// 重载一次必须能干净重来（等价于 profile 热重载）
const again = root.plugin({ name: pluginName, inject, apply }, { directory: dir, headerAllow: ["content-type"] });
await again.await();
check(routes.size === 5, `重载后路由数应为 5，实得 ${routes.size}`);
check(tools.size === 1 && commands.size === 1, "重载后工具/命令没重新注册");
check(globalThis.fetch?.__dshRawDump === true, "重载后 fetch 包装没有重新装上");
await again.dispose();
check(routes.size === 0 && tools.size === 0 && commands.size === 0, "第二次释放没有清干净");

await rm(dir, { recursive: true, force: true });

console.log("── dsh-raw-dump（0.2.0）真实 cordis 宿主测试 ──");
console.log(`cordis    ${cordisEntry}`);
console.log(`路由/工具/命令  加载 5/1/1 · 释放后 ${routes.size}/${tools.size}/${commands.size} · 重载后再次 ${routes.size}/${tools.size}/${commands.size}`);

if (problems.length > 0) {
  console.error("\n失败：");
  for (const problem of problems) console.error("  ✖ " + problem);
  process.exit(1);
}
console.log("\n✔ 真实 cordis 4.0.4 下加载 / 运行 / 卸载全部成立");
