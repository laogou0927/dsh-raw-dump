// 真实端点 · 多轮（含工具调用）：复刻 DSH 0.2.0 实际的请求形状，验证两轮报文都被逐字节落盘。
//
// 默认走 messages 协议（0.2.0 的 deepseek-official / deepseek-account 真正打的端点）：
//   turn 1：system + user + tools(echo)          → 期望模型发起 tool_use
//   turn 2：assistant(text + tool_use) 与 user(tool_result) 按 Messages 的 wire 形状回传
// --protocol chat 时改用 OpenAI 形状（tool_calls / role:"tool"）。
//
// 用法：node scripts/e2e-live-turns.mjs [--protocol messages|chat] [--keep]
// 失败非零退出；不打印密钥。

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCapture, isDateDir, SUFFIXES } from "../lib/core.js";
import { endpointOf, parseSse, resolveKey, turn1Body, turn2Body, wireProtocolOf } from "./protocol.mjs";

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const protocolIndex = argv.indexOf("--protocol");
const protocol = protocolIndex >= 0 ? String(argv[protocolIndex + 1] ?? "messages") : "messages";
if (protocol !== "messages" && protocol !== "chat") {
  console.error(`未知协议 "${protocol}"：只支持 messages | chat`);
  process.exit(2);
}

const apiKey = resolveKey();
if (!apiKey) {
  console.error("跳过：没找到 DEEPSEEK_API_KEY");
  process.exit(2);
}

const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";
const endpoint = endpointOf(protocol, apiKey);
const dir = await mkdtemp(join(tmpdir(), "dsh-raw-dump-turns-"));

const payload1 = turn1Body(protocol, model);
const capture = createCapture({ directory: dir, captureResponse: true, headerAllow: [] }, { warn: (m) => console.warn("[warn]", m) });
const realFetch = globalThis.fetch;
capture.install();

async function post(payload) {
  const response = await globalThis.fetch(endpoint.url, {
    method: "POST",
    headers: endpoint.headers,
    body: payload,
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text;
}

const problems = [];
let turn2Payload = null;
try {
  const first = parseSse(await post(payload1), protocol);
  console.log(`turn1   finish=${first.finish} tool_calls=${first.toolCalls.length} content=${JSON.stringify(first.content.slice(0, 40))}`);
  if (first.toolCalls.length === 0) problems.push("模型没有发起工具调用，无法验证多轮形状");

  turn2Payload = turn2Body(protocol, model, first);
  const second = parseSse(await post(turn2Payload), protocol);
  console.log(`turn2   finish=${second.finish} content=${JSON.stringify(second.content.slice(0, 60))}`);
  if (!second.content && second.finish !== "stop" && second.finish !== "end_turn") problems.push("第二轮没有正常收尾");
} catch (error) {
  problems.push(`请求失败：${String(error?.message ?? error)}`);
} finally {
  await capture.flush();
  capture.uninstall();
}

if (globalThis.fetch !== realFetch) problems.push("卸载后 globalThis.fetch 未还原");
const stats = capture.stats;
const finalStatus = await capture.status();
// 一请求一文件：两轮 = 两个 .request.json + 两个 .response.json（headerAllow 未配，所以没有 headers 文件）
const days = (await readdir(dir).catch(() => [])).filter(isDateDir).sort();
const files = [];
for (const day of days) {
  for (const name of (await readdir(join(dir, day)).catch(() => [])).sort()) files.push(`${day}/${name}`);
}
const requestFiles = files.filter((f) => f.endsWith(SUFFIXES.request));
const payloads = [];
for (const name of requestFiles) payloads.push(JSON.parse(await readFile(join(dir, name), "utf8")));

if (stats.writeErrors !== 0) problems.push(`写盘失败 ${stats.writeErrors} 次`);
if (requestFiles.length !== 2) problems.push(`期望 2 个 .request.json，实得 ${requestFiles.length}：${files.join(", ")}`);
if (payloads[0] && JSON.stringify(payloads[0]) !== JSON.stringify(JSON.parse(payload1))) problems.push("turn1 落盘内容与发送 payload 不等值");
if (payloads[1] && turn2Payload && JSON.stringify(payloads[1]) !== JSON.stringify(JSON.parse(turn2Payload))) problems.push("turn2 落盘内容与发送 payload 不等值");

if (payloads[1] && protocol === "messages") {
  const roles = payloads[1].messages.map((m) => m.role);
  if (roles.join(",") !== "user,assistant,user") problems.push(`turn2 消息角色序列意外：${roles.join(",")}`);
  const assistantWire = payloads[1].messages[1];
  const toolUse = assistantWire.content?.find((block) => block.type === "tool_use");
  if (!toolUse || typeof toolUse.id !== "string" || typeof toolUse.name !== "string") {
    problems.push("turn2 的 assistant.content 里没有按 wire 形状保留 tool_use");
  }
  const resultWire = payloads[1].messages[2];
  const toolResult = resultWire.content?.find((block) => block.type === "tool_result");
  if (!toolResult || toolResult.tool_use_id !== toolUse?.id) problems.push("turn2 的 tool_result.tool_use_id 与 tool_use.id 不匹配");
  if (payloads[1].system?.[0]?.type !== "text") problems.push("turn2 的 system 顶层字段没有保留");
} else if (payloads[1]) {
  const roles = payloads[1].messages.map((m) => m.role);
  if (roles.join(",") !== "system,user,assistant,tool") problems.push(`turn2 消息角色序列意外：${roles.join(",")}`);
  const assistantWire = payloads[1].messages[2];
  if (!Array.isArray(assistantWire.tool_calls) || assistantWire.tool_calls[0]?.function?.arguments === undefined) {
    problems.push("turn2 的 assistant.tool_calls 未按 wire 形状保留");
  }
  const toolWire = payloads[1].messages[3];
  if (typeof toolWire.tool_call_id !== "string" || toolWire.tool_call_id.length === 0) problems.push("turn2 的 role:tool 缺少 tool_call_id");
}

console.log(`协议   ${protocol}（wire=${wireProtocolOf(protocol)}）`);
console.log(`端点   ${endpoint.url}`);
console.log(`落盘   ${files.join(", ")} · ${stats.records} 条 · ${finalStatus.diskBytes} 字节 · 克隆跳过 ${stats.cloneSkipped}`);
console.log(`等值比对 turn1=${payloads[0] ? JSON.stringify(payloads[0]) === JSON.stringify(JSON.parse(payload1)) : false} turn2=${payloads[1] && turn2Payload ? JSON.stringify(payloads[1]) === JSON.stringify(JSON.parse(turn2Payload)) : false}`);

if (problems.length > 0) {
  console.error("\n失败：");
  for (const p of problems) console.error("  ✖ " + p);
  if (keep) console.error(`保留目录：${dir}`);
  else await rm(dir, { recursive: true, force: true });
  process.exit(1);
}

console.log("\n✔ 多轮（含 tool_use/tool_result）报文按 JSON 等值落盘成独立文件");
if (keep) console.log(`保留目录：${dir}`);
else await rm(dir, { recursive: true, force: true });
