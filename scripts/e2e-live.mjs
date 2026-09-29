// 真实端点端到端：把 dsh-raw-dump 的包装层接到真 globalThis.fetch 上，真的发一次
// 0.2.0 的动作请求，然后核对：
//   1) 落盘的 request.text 与发送前算好的 payload JSON 等值
//   2) 服务端返回的是合法 SSE，且响应体（开启抓取时）也被落盘
//   3) 调用方拿到的 Response 完全没被影响
//   4) 元数据里的端点名 / 协议判定 / 字节数 / 打码都对
//
// 两种协议：
//   --protocol messages（默认）→ POST {root}/anthropic/v1/messages
//       这就是 DSH 0.2.0 的 deepseek-official / deepseek-account 真正打的端点
//       （dsh-llm-deepseek: fetch(`${messagesApiRoot(baseURL)}/messages`)，baseURL 默认
//        https://api.deepseek.com/anthropic，messagesApiRoot 会补一段 /v1）
//   --protocol chat            → POST {root}/v1/chat/completions
//       pi-ai 的 openai-completions 走这条
//
// 密钥来源（按顺序）：DEEPSEEK_API_KEY 环境变量 → $DSH_HOME/.credentials.yaml 的 refs。
// 用法：node scripts/e2e-live.mjs [--protocol messages|chat] [--keep] [--response]
//
// 任何一步失败都以非零码退出；脚本不打印密钥内容。

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCapture, isDateDir, SUFFIXES } from "../lib/core.js";

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const withResponse = argv.includes("--response");
const protocolIndex = argv.indexOf("--protocol");
const protocol = protocolIndex >= 0 ? String(argv[protocolIndex + 1] ?? "messages") : "messages";
if (protocol !== "messages" && protocol !== "chat") {
  console.error(`未知协议 "${protocol}"：只支持 messages | chat`);
  process.exit(2);
}

/** 列出落盘文件：`<date>/<name>`。 */
async function listFiles(root) {
  const days = (await readdir(root).catch(() => [])).filter(isDateDir).sort();
  const out = [];
  for (const day of days) {
    for (const name of (await readdir(join(root, day)).catch(() => [])).sort()) out.push(`${day}/${name}`);
  }
  return out;
}

function resolveKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  const home = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
  try {
    const text = readFileSync(join(home, ".credentials.yaml"), "utf8");
    const match = /^refs:\s*\n(?:[ \t]+.*\n)*?[ \t]+DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(text);
    if (match) return match[1];
  } catch { /* 没有凭据文件就走下面的报错 */ }
  return null;
}

const apiKey = resolveKey();
if (!apiKey) {
  console.error("跳过：没找到 DEEPSEEK_API_KEY（环境变量或 <DSH_HOME>/.credentials.yaml）");
  process.exit(2);
}

const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";

/** 按协议给出：端点、鉴权 header、请求体。 */
function buildRequest() {
  if (protocol === "messages") {
    // 0.2.0 的默认 baseURL 是 https://api.deepseek.com/anthropic，messagesApiRoot 再补 /v1
    const root = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic").replace(/\/+$/, "");
    const url = root.endsWith("/v1") ? `${root}/messages` : `${root}/v1/messages`;
    return {
      url,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        stream: true,
        system: [{ type: "text", text: "你是一个测试助手。只回答“收到”。" }],
        messages: [{ role: "user", content: [{ type: "text", text: "请确认收到（含中文，用于校验 UTF-8 往返）。" }] }],
        tools: [{
          name: "noop",
          description: "什么都不做",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
        }],
      }),
    };
  }
  const root = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  return {
    url: `${root}/v1/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你是一个测试助手。只回答“收到”。" },
        { role: "user", content: "请确认收到（含中文，用于校验 UTF-8 往返）。" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
      tools: [{
        type: "function",
        function: {
          name: "noop",
          description: "什么都不做",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      }],
    }),
  };
}

const request = buildRequest();
// CLI 的协议名 → describeWire/describeResponse 的协议名
const wireProtocol = protocol === "messages" ? "messages" : "chat-completions";
const dir = await mkdtemp(join(tmpdir(), "dsh-raw-dump-e2e-"));

const capture = createCapture({
  directory: dir,
  captureResponse: withResponse,
  headerAllow: ["content-type", "x-api-key", "authorization", "anthropic-version"],
}, { warn: (message) => console.warn("[warn]", message) });

const realFetch = globalThis.fetch;
if (typeof realFetch !== "function") { console.error("跳过：globalThis.fetch 不存在"); process.exit(2); }
capture.install();

let response;
try {
  response = await globalThis.fetch(request.url, { method: "POST", headers: request.headers, body: request.body });
} catch (error) {
  capture.uninstall();
  console.error("请求失败（网络或端点不可达）：", String(error?.message ?? error));
  process.exit(1);
}

const status = response.status;
let sse = "";
try { sse = await response.text(); } catch (error) { console.error("读响应失败：", String(error?.message ?? error)); }
await capture.flush();
capture.uninstall();

const problems = [];
if (globalThis.fetch !== realFetch) problems.push("卸载后 globalThis.fetch 未还原");
if (status !== 200) problems.push(`HTTP ${status}：${sse.slice(0, 300)}`);
const stats = capture.stats;
const finalStatus = await capture.status();
if (stats.captured !== 1) problems.push(`captured 期望 1，实得 ${stats.captured}`);
if (stats.writeErrors !== 0) problems.push(`写盘失败 ${stats.writeErrors} 次`);
if (!sse.includes("data:")) problems.push("响应不是 SSE 流");

const files = await listFiles(dir);
const requestPaths = files.filter((f) => f.endsWith(SUFFIXES.request));
const expectedCount = withResponse ? 4 : 2;
if (files.length !== expectedCount) problems.push(`期望 ${expectedCount} 个文件，实得 ${files.length}：${files.join(", ")}`);

let asked = null;
let answeredBody = null;
let requestFileText = "";
if (requestPaths.length === 1) {
  requestFileText = await readFile(join(dir, requestPaths[0]), "utf8");
  for (const name of files) {
    const text = await readFile(join(dir, name), "utf8");
    try { JSON.parse(text); } catch (error) { problems.push(`${name} 不是合法 JSON：${error.message}`); }
    if (!text.endsWith("\n")) problems.push(`${name} 没有以换行结尾`);
  }
  if (!requestFileText.includes("\n  ")) problems.push("请求体文件看起来没有被格式化（没有缩进）");
  asked = JSON.parse(requestFileText);

  const metaPath = files.find((f) => f.endsWith(SUFFIXES.requestHeaders));
  if (metaPath) {
    const meta = JSON.parse(await readFile(join(dir, metaPath), "utf8"))._dsh;
    if (meta.url !== request.url) problems.push(`url 记录不符：${meta.url} ≠ ${request.url}`);
    if (meta.endpoint !== "messages" && protocol === "messages") problems.push(`端点名不符：${meta.endpoint}`);
    if (meta.endpoint !== "completions" && protocol === "chat") problems.push(`端点名不符：${meta.endpoint}`);
    if (meta.wire?.protocol !== wireProtocol) problems.push(`协议判定不符：${meta.wire?.protocol} ≠ ${wireProtocol}`);
    if (meta.bodyBytes !== Buffer.byteLength(request.body)) problems.push(`meta.bodyBytes=${meta.bodyBytes} 与 payload 字节数不符`);
    if (meta.model !== model) problems.push(`解析出的 model 不符：${meta.model}`);
    if (meta.stream !== true) problems.push("解析出的 stream 不为 true");
    if (protocol === "messages" && meta.headers["x-api-key"] !== "<redacted>") problems.push("x-api-key 未被打码");
    if (protocol === "chat" && meta.headers.authorization !== "<redacted>") problems.push("authorization 未被打码");
    if (meta.headers["content-type"] !== "application/json") problems.push("content-type 未被记录");
  } else {
    problems.push("缺少 .request.headers.json（headerAllow 已配置）");
  }
  // 磁盘是格式化 JSON：逐字节比对走"紧凑化后与紧凑 payload 相同"
  if (JSON.stringify(asked) !== JSON.stringify(JSON.parse(request.body))) {
    problems.push("落盘请求体与发送前算好的 payload JSON 不等值");
  }
  if (protocol === "messages") {
    if (asked.system?.[0]?.text !== "你是一个测试助手。只回答“收到”。") problems.push("system 内容往返失败");
    if (asked.messages?.[0]?.content?.[0]?.text !== "请确认收到（含中文，用于校验 UTF-8 往返）。") problems.push("中文内容往返失败");
    if (asked.tools?.[0]?.input_schema?.type !== "object") problems.push("tools[].input_schema 未被原样保留");
  } else {
    if (asked.messages?.[1]?.content !== "请确认收到（含中文，用于校验 UTF-8 往返）。") problems.push("中文内容往返失败");
    if (asked.tools?.[0]?.function?.name !== "noop") problems.push("tools 结构未被原样保留");
  }
} else {
  problems.push(`期望 1 个 .request.json，实得 ${requestPaths.length}`);
}

if (withResponse) {
  const responsePath = files.find((f) => f.endsWith(SUFFIXES.response));
  if (!responsePath) problems.push("--response 开启但没有 .response.json");
  else {
    const parsed = JSON.parse(await readFile(join(dir, responsePath), "utf8"));
    answeredBody = parsed.payload ?? null;
    if (!String(answeredBody ?? "").includes("data:")) problems.push("落盘的响应体不是 SSE");
    const meta = JSON.parse(await readFile(join(dir, files.find((f) => f.endsWith(SUFFIXES.responseHeaders))), "utf8"))._dsh;
    if (meta.status !== 200) problems.push(`响应元数据 status=${meta.status}`);
    if (meta.body?.captured !== true) problems.push("响应元数据标了未捕获");
    if (meta.protocol !== wireProtocol) problems.push(`响应侧协议判定不符：${meta.protocol} ≠ ${wireProtocol}`);
  }
}

console.log("── dsh-raw-dump 真实端点端到端（dsh 0.2.0 适配版）──");
console.log(`协议   ${protocol}`);
console.log(`端点   ${request.url}`);
console.log(`模型   ${model}`);
console.log(`状态   HTTP ${status} · SSE ${sse.length} 字节`);
console.log(`落盘   ${files.join(", ") || "(无)"}`);
console.log(`目录   ${finalStatus.directory} · ${finalStatus.dateDirs} 个日期目录 · ${finalStatus.fileCount} 个文件 · ${finalStatus.diskBytes} 字节`);
console.log(`请求体 ${asked ? `与 payload JSON 等值=${JSON.stringify(asked) === JSON.stringify(JSON.parse(request.body))}；文件 ${Buffer.byteLength(requestFileText)} 字节` : "(缺失)"}`);
if (withResponse) console.log(`响应体 落盘 ${Buffer.byteLength(String(answeredBody ?? ""))} 字节`);

if (problems.length > 0) {
  console.error("\n失败：");
  for (const p of problems) console.error("  ✖ " + p);
  if (keep) console.error(`保留目录：${dir}`);
  else await rm(dir, { recursive: true, force: true });
  process.exit(1);
}

console.log("\n✔ 全部通过：发出去的每个字节都按 JSON 等值落盘成一个独立文件");
if (keep) console.log(`保留目录：${dir}`);
else await rm(dir, { recursive: true, force: true });
