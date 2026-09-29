// dsh-raw-dump（0.2.0 适配版）测试：不联网、不依赖宿主。
//   node test/core.test.mjs
//
// 覆盖四层：
//   1. 纯函数：URL 路径匹配（0.2.0 的 /anthropic/messages）、header 三态、配置归一化、
//      UTF-8 安全截断、文件名解析、两种协议的 body 形状识别
//   2. 落盘格式：合法 JSON 缩进落盘、非 JSON/截断/超时包成 _dsh 包装、原子写
//   3. fetch 包装：命中/跳过、包装还原、响应体克隆（注入假 target，不动真 globalThis.fetch）
//   4. 落盘端到端：mock 的 Messages SSE 与 OpenAI 兼容 SSE 端点 → 日期目录/一请求一文件
//      → list/get/sweep

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  baseName,
  createCapture,
  dateStamp,
  describeResponse,
  describeWire,
  fileFacts,
  formatForFile,
  isDateDir,
  isDumpFile,
  normalizeBody,
  parseDumpFile,
  projectHeaders,
  renderPage,
  resolveConfig,
  safeUrl,
  shouldCapture,
  SUFFIXES,
} from "../lib/core.js";

const silent = () => {};

/** 0.2.0 的 Messages SSE 片段（与真实端点同形：event: + data:） */
const MESSAGES_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"deepseek-flash","content":[],"usage":{"input_tokens":34,"output_tokens":0}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"收到"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

/** 0.2.0 的 Messages 请求体（Anthropic 形态：system 顶层 + content 块 + input_schema） */
function messagesPayload(extra = {}) {
  return JSON.stringify({
    model: "deepseek-flash",
    max_tokens: 64,
    stream: true,
    system: [{ type: "text", text: "你是一个测试助手。", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "你好" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "我先看看" },
          { type: "tool_use", id: "toolu_1", name: "noop", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ],
    tools: [{ name: "noop", description: "什么都不做", input_schema: { type: "object", properties: {}, additionalProperties: false } }],
    dsh_plugin_packages: { version: 1, packages: [{ name: "@laogou0927/dsh-raw-dump", version: "0.2.0" }] },
    ...extra,
  });
}

async function makeDir(prefix = "dsh-raw-dump-test-") {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 造一个只提供 fetch 的假全局，避免污染真 globalThis。 */
function fakeTarget(fetchImpl) {
  return { fetch: fetchImpl };
}

function okResponse(body = "{}", init = {}) {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });
}

/** 列出根目录下所有落盘文件：`<date>/<name>`。 */
async function listFiles(root) {
  const days = (await readdir(root).catch(() => [])).filter(isDateDir).sort();
  const out = [];
  for (const day of days) {
    for (const name of (await readdir(join(root, day)).catch(() => [])).sort()) out.push(`${day}/${name}`);
  }
  return out;
}

/** 从根目录取出唯一的请求体文件（.request.json，非 headers）。 */
async function readRequestJson(root) {
  const files = (await listFiles(root)).filter((f) => f.endsWith(SUFFIXES.request));
  assert.equal(files.length, 1, `期望 1 个 .request.json，实得 ${files.length}: ${files.join(", ")}`);
  return { path: files[0], text: await readFile(join(root, files[0]), "utf8") };
}

// ─────────────────────────────── 纯函数 ───────────────────────────────

test("shouldCapture 命中 0.2.0 的动作端点，跳过无关 URL（大小写不敏感）", () => {
  const cfg = resolveConfig({});
  // 0.2.0 的默认端点：deepseek-official / deepseek-account 的 Messages 传输
  assert.equal(shouldCapture("https://api.deepseek.com/anthropic/messages", cfg), true);
  assert.equal(shouldCapture("https://api.deepseek.com/anthropic/messages?beta=1", cfg), true);
  // pi-ai 的 openai-completions
  assert.equal(shouldCapture("https://api.deepseek.com/v1/chat/completions", cfg), true);
  assert.equal(shouldCapture("http://127.0.0.1:8788/v1/chat/completions", cfg), true);
  assert.equal(shouldCapture("https://API.DEEPSEEK.COM/CHAT/COMPLETIONS", cfg), true);
  // 其它网关/官方形态
  assert.equal(shouldCapture("https://api.anthropic.com/v1/messages", cfg), true);
  assert.equal(shouldCapture("https://api.openai.com/v1/responses", cfg), true);
  // 无关端点
  assert.equal(shouldCapture("https://api.deepseek.com/files", cfg), false);
  assert.equal(shouldCapture("https://api.deepseek.com/anthropic/models", cfg), false);
  const all = resolveConfig({ matchAll: true });
  assert.equal(shouldCapture("https://example.com/anything", all), true);
});

test("shouldCapture 默认按路径边界匹配：/messages 不吃 /messages-archive", () => {
  const cfg = resolveConfig({});
  assert.equal(shouldCapture("https://gw.example.com/messages", cfg), true);
  assert.equal(shouldCapture("https://gw.example.com/messages/attachments", cfg), true);
  assert.equal(shouldCapture("https://gw.example.com/messages-archive", cfg), false);
  assert.equal(shouldCapture("https://gw.example.com/v2/chat/completions-extra", cfg), false);
  // 显式退回旧语义时，子串匹配会命中
  const legacy = resolveConfig({ matchMode: "substring" });
  assert.equal(legacy.matchMode, "substring");
  assert.equal(shouldCapture("https://gw.example.com/messages-archive", legacy), true);
  // 非法 URL 退回子串比较，宁可多抓不要漏抓
  assert.equal(shouldCapture("/anthropic/messages", cfg), true);
});

test("describeWire 同时认 Messages 与 Chat Completions，非 JSON 返回 null", () => {
  const messages = describeWire(messagesPayload());
  assert.equal(messages.protocol, "messages");
  assert.equal(messages.model, "deepseek-flash");
  assert.equal(messages.stream, true);
  assert.equal(messages.messages, 3);
  assert.equal(messages.blocks, 4);              // 1 + 2 + 1 个内容块
  assert.equal(messages.systemChars, "你是一个测试助手。".length);
  assert.equal(messages.tools, 1);

  const chat = describeWire(JSON.stringify({
    model: "deepseek-flash",
    stream: true,
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "noop", parameters: { type: "object" } } }],
  }));
  assert.equal(chat.protocol, "chat-completions");
  assert.equal(chat.messages, 2);
  assert.equal(chat.blocks, 0);
  assert.equal(chat.tools, 1);

  // system 是纯字符串的 Messages 变体也算 Messages
  assert.equal(describeWire(JSON.stringify({ system: "sys", messages: [], model: "m" })).protocol, "messages");
  assert.equal(describeWire("data: x"), null);
  assert.equal(describeWire(""), null);
  assert.equal(describeWire('[1,2]'), null);
});

test("describeResponse 从 SSE 形态认协议", () => {
  assert.equal(describeResponse(MESSAGES_SSE), "messages");
  assert.equal(describeResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'), "chat-completions");
  assert.equal(describeResponse('{"object":"chat.completion.chunk","choices":[]}'), "chat-completions");
  assert.equal(describeResponse('{"error":{"message":"bad key"}}'), null);
  assert.equal(describeResponse(""), null);
});

test("safeUrl 丢掉 query（key/token 不进盘）并给出端点名", () => {
  const parsed = safeUrl("https://api.deepseek.com/anthropic/messages?api_key=sk-secret&x=1");
  assert.equal(parsed.full, "https://api.deepseek.com/anthropic/messages");
  assert.equal(parsed.host, "api.deepseek.com");
  assert.equal(parsed.pathname, "/anthropic/messages");
  assert.equal(parsed.endpoint, "messages");
  assert.ok(!parsed.full.includes("sk-secret"));
  assert.equal(safeUrl("https://api.deepseek.com/v1/chat/completions?api_key=sk-secret").full,
    "https://api.deepseek.com/v1/chat/completions");
});

test("projectHeaders 三态：默认不记；[] 记全部非敏感；名单只记名单内且敏感名打码", () => {
  const headers = new Headers({
    authorization: "Bearer sk-secret",
    "content-type": "application/json",
    cookie: "sid=abc",
    "x-dsh-auth-token": "account-token",
    "x-api-key": "sk-abc",
  });
  assert.deepEqual(projectHeaders(headers, resolveConfig({})), {}, "未配置时一个 header 都不记");
  assert.deepEqual(projectHeaders(headers, resolveConfig({ headerAllow: [] })), {
    authorization: "<redacted>",
    "content-type": "application/json",
    cookie: "<redacted>",
    // 0.2.0 的账号凭证必须打码（0.1.5 的名单里没有它）
    "x-dsh-auth-token": "<redacted>",
    "x-api-key": "<redacted>",
  }, "显式空数组 = 记全部，但敏感名仍打码");
  const listed = resolveConfig({ headerAllow: ["Authorization", "content-type", "cookie", "x-dsh-auth-token"] });
  assert.deepEqual(projectHeaders(headers, listed), {
    authorization: "<redacted>",
    "content-type": "application/json",
    cookie: "<redacted>",
    "x-dsh-auth-token": "<redacted>",
  });
  assert.deepEqual(projectHeaders(headers, resolveConfig({ headerAllow: ["content-type"] })), {
    "content-type": "application/json",
  });
  assert.deepEqual(projectHeaders(undefined, listed), {});
  // 默认打码名单必须包含 0.2.0 新增的账号 token
  assert.ok(resolveConfig({}).redactHeaders.includes("x-dsh-auth-token"), "默认打码名单缺少 x-dsh-auth-token");
});

test("resolveConfig 钳住非法值并给出默认目录", () => {
  const cfg = resolveConfig({
    directory: "  ",
    maxRequestBodyBytes: -5,
    retentionDays: "  ",
    match: [],
    matchAll: "yes",
    captureResponse: 1,
  }, { DSH_HOME: "C:\\fake-home" });
  assert.equal(cfg.directory, join("C:\\fake-home", "dsh-raw-dump"));
  assert.equal(cfg.maxRequestBodyBytes, 16 * 1024 * 1024);
  assert.equal(cfg.retentionDays, 0);
  assert.deepEqual(cfg.match, ["/chat/completions", "/messages", "/responses", "/v1/completions", "/v1/messages", "/v1/responses"]);
  assert.equal(cfg.matchMode, "path");
  assert.equal(cfg.matchAll, false);       // 只有 === true 才算开
  assert.equal(cfg.captureResponse, false);
  // 显式目录一律 resolve 成绝对路径。期望值必须用**当前平台**的 resolve() 算，
  // 不能写死 "E:\\dumps" 这种 Windows 字面量 —— 在 POSIX 上 resolve() 会把它
  // 变成 cwd + "/E:\dumps"，CI（ubuntu）会因此挂掉。
  const absDir = resolve("dumps-fixture");
  assert.equal(resolveConfig({ directory: absDir }).directory, absDir);
  assert.equal(resolveConfig({ directory: "dumps-rel" }).directory, resolve("dumps-rel"));
  assert.equal(resolveConfig({ matchMode: "SUBSTRING" }).matchMode, "path");   // 非法值退回默认
  assert.equal(resolveConfig({ matchMode: "substring" }).matchMode, "substring");
});

test("normalizeBody：字符串/Buffer/空体各归一正确，未知类型标记未捕获", async () => {
  const max = 1024;
  assert.deepEqual(await normalizeBody(undefined, max), { kind: "empty", text: "", captured: true });
  assert.deepEqual(await normalizeBody("{\"a\":1}", max), {
    kind: "string", text: "{\"a\":1}", bytes: 7, captured: true, truncated: false,
  });
  const buf = await normalizeBody(Buffer.from("héllo"), max);
  assert.equal(buf.kind, "bytes");
  assert.equal(buf.text, "héllo");
  assert.equal(buf.bytes, 6);
  const params = await normalizeBody(new URLSearchParams({ a: "1", b: "2" }), max);
  assert.equal(params.kind, "urlencoded");
  assert.equal(params.text, "a=1&b=2");

  const unsupported = await normalizeBody({ async *[Symbol.asyncIterator]() {} }, max);
  assert.equal(unsupported.captured, false);
  assert.equal(unsupported.reason, "unsupported body type");
});

test("normalizeBody：超限按字节截断且不切碎多字节字符", async () => {
  const text = "中文".repeat(100);            // 每字 3 字节
  const out = await normalizeBody(text, 10);  // 10 字节落在第三个字中间
  assert.equal(out.truncated, true);
  assert.equal(out.bytes, 600);
  assert.equal(out.text, "中文中");            // 退到完整字符边界：3 个整字 = 9 字节
  assert.equal(Buffer.byteLength(out.text), 9);
  assert.ok(!out.text.includes("\uFFFD"));
  const exact = await normalizeBody("中文", 6);
  assert.equal(exact.truncated, false);
  assert.equal(exact.text, "中文");
});

test("normalizeBody：ReadableStream 走 tee，返回的 stream 仍能读出原文", async () => {
  const payload = JSON.stringify({ model: "deepseek-flash", stream: true });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  const normalized = await normalizeBody(stream, 1024);
  assert.equal(normalized.kind, "stream");
  assert.ok(normalized.stream instanceof ReadableStream);
  const captured = await normalized.pending;
  assert.equal(captured.text, payload);
  assert.equal(await new Response(normalized.stream).text(), payload);
});

// ─────────────────────────────── 落盘格式 ───────────────────────────────

test("formatForFile：合法 JSON 缩进落盘且值不变；非 JSON 包成 _dsh 包装", () => {
  const payload = JSON.stringify({ model: "m", messages: [{ role: "user", content: "你好" }], stream: true });
  const formatted = formatForFile(payload, { bytes: Buffer.byteLength(payload) });
  assert.equal(formatted.wrapped, false);
  assert.ok(formatted.text.includes('\n  "model": "m"'), "应当是缩进过的 JSON");
  assert.ok(formatted.text.endsWith("\n"), "文件应以换行结尾");
  assert.deepEqual(JSON.parse(formatted.text), JSON.parse(payload), "值必须逐字段相同");

  const sse = "data: {\"a\":1}\n\ndata: [DONE]\n\n";
  const wrapped = formatForFile(sse, { reason: "SSE/文本响应", bytes: 30, timedOut: true });
  assert.equal(wrapped.wrapped, true);
  const parsed = JSON.parse(wrapped.text);              // 必须是合法 JSON
  assert.equal(parsed.payload, sse);
  assert.equal(parsed._dsh.timedOut, true);
  assert.equal(parsed._dsh.format, "text");

  const truncated = formatForFile('{"model":"m","messages":[{"role":"user"', { reason: "截断", truncated: true });
  assert.equal(JSON.parse(truncated.text)._dsh.truncated, true);
  assert.equal(formatForFile("", { reason: "空" }).wrapped, true);
});

test("命名与解析：日期目录 / HH-MM-SS.mmm-id / 四种后缀", () => {
  const at = new Date(2026, 8, 25, 8, 15, 25, 123);
  assert.equal(dateStamp(at), "2026-09-25");
  assert.equal(baseName(at, "ab12cd34-ffff-0000"), "08-15-25.123-ab12cd34");
  const base = baseName(at, "ab12cd34");
  for (const suffix of Object.values(SUFFIXES)) assert.equal(isDumpFile(`${base}${suffix}`), true, suffix);
  assert.equal(isDumpFile("2026-09-25.jsonl"), false);
  assert.equal(isDumpFile("random.json"), false);
  assert.equal(isDateDir("2026-09-25"), true);
  assert.equal(isDateDir("2026-9-5"), false);
  assert.deepEqual(parseDumpFile(`${base}${SUFFIXES.responseHeaders}`), { base, kind: "response", headers: true });
  assert.deepEqual(parseDumpFile(`${base}${SUFFIXES.request}`), { base, kind: "request", headers: false });
  assert.equal(parseDumpFile("other.json"), null);
});

test("renderPage 输出自包含 HTML，且内嵌挂载路径", () => {
  const html = renderPage("/dsh-raw-dump");
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('const BASE = "/dsh-raw-dump"'));
  assert.ok(!html.includes("http://"), "不应有外部资源引用");
  assert.ok(html.includes(".request.json"), "页面应提到落盘布局");
  assert.ok(html.includes("0.2.0"), "页面应标出适配的 dsh 版本");
  assert.ok(html.includes("sessionId"), "页面应显示 session 列");
});

test("fileFacts 汇总日期目录与文件（忽略无关文件）", async () => {
  const root = await makeDir();
  try {
    await mkdir(join(root, "2026-09-25"), { recursive: true });
    await mkdir(join(root, "not-a-date"), { recursive: true });
    const base = baseName(new Date(2026, 8, 25, 1, 2, 3, 4), "deadbeef");
    await writeFile(join(root, "2026-09-25", `${base}${SUFFIXES.request}`), "{}\n", "utf8");
    await writeFile(join(root, "2026-09-25", "junk.txt"), "x", "utf8");
    await writeFile(join(root, "README.md"), "x", "utf8");
    const facts = await fileFacts(root);
    assert.equal(facts.days.length, 1);
    assert.equal(facts.files.length, 1);
    assert.equal(facts.files[0].name, `${base}${SUFFIXES.request}`);
    assert.ok(facts.bytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─────────────────────────── fetch 包装层 ───────────────────────────

test("包装层：命中即抓（一请求一文件）、未命中直通、卸载后完全还原", async () => {
  const dir = await makeDir();
  try {
    const calls = [];
    const real = async (url, init) => {
      calls.push({ url, init });
      return okResponse("{\"ok\":true}");
    };
    const target = fakeTarget(real);
    const capture = createCapture({ directory: dir, headerAllow: ["content-type", "authorization"] }, { target, warn: silent });

    assert.equal(capture.install(), true);
    assert.equal(target.fetch.__dshRawDump, true);

    await target.fetch("https://registry.npmjs.org/x", { method: "GET" });
    assert.equal(capture.stats.skipped, 1);

    const payload = messagesPayload();
    await target.fetch("https://api.deepseek.com/anthropic/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-secret" },
      body: payload,
    });
    await capture.flush();

    // 真 fetch 必须仍然被调用，且拿到的是原始字节
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.body, payload);

    // 磁盘布局：<date>/<base>.request.json + .request.headers.json
    const files = await listFiles(dir);
    assert.equal(files.length, 2, files.join(", "));
    assert.ok(files.every((f) => /^\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}\.\d{3}-[0-9a-f]{8}\./.test(f)), files.join(", "));
    assert.ok(files.some((f) => f.endsWith(SUFFIXES.request)));
    assert.ok(files.some((f) => f.endsWith(SUFFIXES.requestHeaders)));

    const { text } = await readRequestJson(dir);
    const parsed = JSON.parse(text);
    assert.equal(parsed.model, "deepseek-flash");        // 是**真 JSON**，不是被转义的字符串
    assert.equal(parsed.stream, true);
    assert.equal(parsed.system[0].text, "你是一个测试助手。");
    assert.equal(parsed.messages[1].content[1].type, "tool_use");
    assert.equal(parsed.tools[0].input_schema.type, "object");
    assert.ok(parsed.dsh_plugin_packages.packages[0].name === "@laogou0927/dsh-raw-dump");
    assert.ok(text.includes("\n  "), "应当是缩进过的 JSON");

    // headers 侧只放元数据，且敏感名打码
    const metaPath = files.find((f) => f.endsWith(SUFFIXES.requestHeaders));
    const meta = JSON.parse(await readFile(join(dir, metaPath), "utf8"))._dsh;
    assert.equal(meta.headers.authorization, "<redacted>");
    assert.equal(meta.headers["content-type"], "application/json");
    assert.equal(meta.bodyBytes, Buffer.byteLength(payload));
    assert.equal(meta.model, "deepseek-flash");
    assert.equal(meta.url, "https://api.deepseek.com/anthropic/messages");
    assert.equal(meta.endpoint, "messages");
    assert.equal(meta.bodyTruncated, false);
    assert.equal(meta.wire.protocol, "messages");
    assert.equal(meta.wire.messages, 3);
    assert.equal(meta.wire.tools, 1);

    assert.equal(capture.uninstall(), true);
    assert.equal(target.fetch, real, "卸载后必须还原成原函数");
    assert.equal(capture.uninstall(), false, "重复卸载是 no-op");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("包装层：captureResponse=true 时克隆响应体落成 .response.json，且流仍可用", async () => {
  const dir = await makeDir();
  try {
    const sse = MESSAGES_SSE;
    const real = async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    const target = fakeTarget(real);
    const capture = createCapture({ directory: dir, captureResponse: true, headerAllow: [] }, { target, warn: silent });
    capture.install();

    const response = await target.fetch("https://api.deepseek.com/anthropic/messages", {
      method: "POST",
      body: messagesPayload(),
    });
    assert.equal(await response.text(), sse, "调用方必须拿到完整响应体");
    await capture.flush();

    const files = await listFiles(dir);
    assert.equal(files.length, 4, files.join(", "));
    const responsePath = files.find((f) => f.endsWith(SUFFIXES.response));
    assert.ok(responsePath, "缺少 .response.json");
    const parsedResponse = JSON.parse(await readFile(join(dir, responsePath), "utf8"));
    assert.equal(parsedResponse.payload, sse);                 // SSE 不是合法 JSON → _dsh 包装
    assert.equal(parsedResponse._dsh.timedOut, false);

    const metaPath = files.find((f) => f.endsWith(SUFFIXES.responseHeaders));
    const meta = JSON.parse(await readFile(join(dir, metaPath), "utf8"))._dsh;
    assert.equal(meta.status, 200);
    assert.equal(meta.endpoint, "messages");
    assert.equal(meta.protocol, "messages");                  // 从 SSE 形态认出来的
    assert.equal(meta.body.captured, true);
    assert.equal(meta.body.bytes, Buffer.byteLength(sse));
    assert.equal(capture.stats.writeErrors, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("包装层：真 fetch 抛错时落一条带 error 的记录并原样抛出", async () => {
  const dir = await makeDir();
  try {
    const boom = new Error("connect ECONNREFUSED");
    const target = fakeTarget(async () => { throw boom; });
    const capture = createCapture({ directory: dir, headerAllow: [] }, { target, warn: silent });
    capture.install();
    await assert.rejects(
      () => target.fetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" }),
      /ECONNREFUSED/,
    );
    await capture.flush();
    assert.equal(capture.stats.failed, 1);
    assert.equal(capture.stats.records, 1);
    const files = await listFiles(dir);
    const metaPath = files.find((f) => f.endsWith(SUFFIXES.responseHeaders));
    const meta = JSON.parse(await readFile(join(dir, metaPath), "utf8"))._dsh;
    assert.match(meta.error, /ECONNREFUSED/);
    // 请求侧仍然留下一个合法 JSON 文件（内容是空的包装），不会有半截文件
    const { text } = await readRequestJson(dir);
    assert.equal(JSON.parse(text).payload, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("包装层：响应不可克隆时不影响调用方，只记 cloneSkipped", async () => {
  const dir = await makeDir();
  try {
    const real = async () => ({
      status: 200,
      clone() { throw new Error("Body has already been consumed."); },
      body: null,
    });
    const target = fakeTarget(real);
    const capture = createCapture({ directory: dir, captureResponse: true, headerAllow: [] }, { target, warn: silent });
    capture.install();
    const response = await target.fetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    await capture.flush();
    assert.equal(capture.stats.cloneSkipped, 1);
    assert.equal(capture.stats.readErrors, 0);
    assert.equal(capture.stats.records, 1);
    assert.equal((await listFiles(dir)).length, 2, "只应有 request + request.headers");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("回归锁：响应体读取绝不调用 reader.cancel()（会打断上游 SSE 消费）", async () => {
  const dir = await makeDir();
  try {
    const calls = [];
    const explicitReader = {
      async read() { calls.push("read"); return { done: true, value: undefined }; },
      cancel() { calls.push("cancel"); return Promise.resolve(); },
      releaseLock() { calls.push("releaseLock"); },
    };
    const fakeBody = { getReader: () => explicitReader };
    const real = async () => ({ status: 200, headers: {}, body: fakeBody, clone: () => ({ status: 200, headers: {}, body: fakeBody }) });
    const target = fakeTarget(real);
    const capture = createCapture({ directory: dir, captureResponse: true, headerAllow: [] }, { target, warn: silent });
    capture.install();
    await target.fetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" });
    await capture.flush();
    assert.ok(calls.includes("read"), "没有读响应体");
    assert.ok(!calls.includes("cancel"), "出现了 cancel 调用：会让上游判定 stream consumer stopped");
    assert.equal(capture.stats.readErrors, 0);
    assert.equal((await listFiles(dir)).length, 4, "应该同时落 request 与 response");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("包装层：下游不拉完流时，响应体按超时收尾落盘而不是永远挂着", async () => {
  const dir = await makeDir();
  try {
    const stalled = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {\"a\":1}\n\n"));
        // 故意不 close：模拟上游消费者提前停止拉取
      },
    });
    const real = async () => new Response(stalled, { status: 200 });
    const target = fakeTarget(real);
    const capture = createCapture({ directory: dir, captureResponse: true, responseReadTimeoutMs: 300, headerAllow: [] }, { target, warn: silent });
    capture.install();
    await target.fetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" });

    const started = Date.now();
    await capture.flush();                     // 必须在超时后结束，而不是挂死
    assert.ok(Date.now() - started < 5000, "flush 等待过久");

    const responsePath = (await listFiles(dir)).find((f) => f.endsWith(SUFFIXES.response));
    const parsed = JSON.parse(await readFile(join(dir, responsePath), "utf8"));
    assert.equal(parsed._dsh.timedOut, true);
    assert.match(parsed.payload, /"a":1/);
    const list = await capture.list({ limit: 5 });
    assert.equal(list[0].responseTimedOut, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────── 落盘 + 浏览接口端到端 ───────────────────────

test("端到端：真 HTTP 打两种协议（Messages + Chat Completions）→ 一请求一文件 → list/get/sweep", async () => {
  const dir = await makeDir();
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8"), auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 按路径回对应协议的 SSE，模拟 0.2.0 的两个真实端点
      if ((req.url ?? "").endsWith("/messages")) res.write(MESSAGES_SSE);
      else res.write("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const target = fakeTarget(globalThis.fetch);
  const capture = createCapture({
    directory: dir,
    captureResponse: true,
    headerAllow: ["authorization", "content-type"],
  }, { target, warn: silent });
  capture.install();
  try {
    // ① 0.2.0 默认的 Messages 传输
    const messagesBody = messagesPayload();
    const messagesResponse = await target.fetch(`http://127.0.0.1:${port}/anthropic/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-live-secret" },
      body: messagesBody,
    });
    assert.match(await messagesResponse.text(), /message_stop/);

    // ② pi-ai 的 OpenAI 兼容传输
    const chatBody = JSON.stringify({
      model: "deepseek-v4.1-flash",
      messages: [{ role: "system", content: "系统提示" }, { role: "user", content: "你好" }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 128,
    });
    const chatResponse = await target.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-live-secret" },
      body: chatBody,
    });
    assert.match(await chatResponse.text(), /\[DONE\]/);

    // 未命中 URL 不落盘
    await target.fetch(`http://127.0.0.1:${port}/health`, { method: "GET" });
    await target.fetch(`http://127.0.0.1:${port}/anthropic/messages-archive`, { method: "GET" });

    assert.equal(received[0].body, messagesBody);       // 服务端收到的字节 == 我们落盘的字节
    assert.equal(received[1].body, chatBody);
    assert.equal(received[0].auth, "Bearer sk-live-secret");

    await capture.flush();
    const status = await capture.status();
    assert.equal(status.captured, 2);
    assert.equal(status.records, 2);                     // 一次请求 = 一条记录
    assert.equal(status.skipped, 2);                     // /health 与 /messages-archive
    assert.equal(status.dateDirs, 1);
    assert.equal(status.fileCount, 8);
    assert.equal(status.writeErrors, 0);
    assert.equal(status.directory, dir);
    assert.equal(status.target, "dsh 0.2.0");
    assert.equal(status.matchMode, "path");
    assert.match(status.layout, /request\.json/);

    const files = await listFiles(dir);
    assert.equal(files.length, 8, files.join(", "));
    for (const name of files) {
      const text = await readFile(join(dir, name), "utf8");
      JSON.parse(text);                                  // 每个文件都必须是合法 JSON
      assert.ok(text.endsWith("\n"));
    }
    const dayDir = files[0].split("/")[0];
    assert.equal((await readdir(join(dir, dayDir))).some((n) => n.endsWith(".tmp")), false, "不应留下 .tmp");

    const list = await capture.list({ limit: 10 });
    assert.equal(list.length, 2);
    // 新的在前：第二条是 chat
    assert.equal(list[0].model, "deepseek-v4.1-flash");
    assert.equal(list[0].endpoint, "completions");
    assert.equal(list[0].protocol, "chat-completions");
    assert.equal(list[1].model, "deepseek-flash");
    assert.equal(list[1].endpoint, "messages");
    assert.equal(list[1].protocol, "messages");
    assert.equal(list[1].wire.tools, 1);
    assert.equal(list[1].requestBytes, Buffer.byteLength(messagesBody));
    assert.equal(list[1].requestCaptured, true);
    assert.equal(list[1].responseStatus, 200);
    assert.ok(list[1].responseBytes > 0);
    assert.ok(list[1].files.some((f) => f.endsWith(SUFFIXES.request)));
    assert.ok(list[1].files.some((f) => f.endsWith(SUFFIXES.response)));
    assert.equal(list[0].sessionId, null);               // 没装 sessionScope 时不硬编
    assert.equal(list[0].at.slice(0, 10), dayDir);       // 列表时间与日期目录一致（本地时间）

    const detail = (await capture.get(list[1].id))[0];
    assert.equal(detail.request.exact, false);           // 格式化后已无原始空白，如实标注
    assert.deepEqual(JSON.parse(detail.request.text), JSON.parse(messagesBody));
    assert.equal(JSON.parse(detail.request.text).system[0].text, "你是一个测试助手。");
    assert.equal(detail.request.text.includes("你好"), true);   // 中文原样往返
    assert.equal(detail.protocol, "messages");
    assert.equal(detail.response.protocol, "messages");
    assert.equal(detail.headers.authorization, "<redacted>");
    assert.match(detail.response.text, /message_stop/);
    assert.equal(detail.responseStatus, 200);
    assert.ok(detail.response.file.endsWith(SUFFIXES.response));

    // 请求体里发出去的 dsh_plugin_packages 也被原样留下（0.2.0 在 llm/stream 之后才注入）
    assert.equal(JSON.parse(detail.request.text).dsh_plugin_packages.packages[0].version, "0.2.0");

    // 路径穿越 / 非法 id 一律拒绝
    assert.equal(await capture.get("../../etc/passwd"), null);
    assert.equal(await capture.get("2026-09-25/../2026-09-25/x"), null);
    assert.equal(await capture.get("nope"), null);

    const swept = await capture.sweep({ drain: true });
    assert.equal(swept.removed.length, 1);
    assert.equal(swept.freedFiles, 8);
    assert.ok(swept.freedBytes > 0);
    assert.equal((await capture.status()).fileCount, 0);
    assert.equal(await capture.get(list[0].id), null);
  } finally {
    capture.uninstall();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("端到端：同一天多次请求各占一个文件，list 按时间倒序", async () => {
  const dir = await makeDir();
  try {
    const target = fakeTarget(async () => okResponse());
    const capture = createCapture({ directory: dir, headerAllow: [] }, { target, warn: silent });
    capture.install();
    for (let i = 0; i < 3; i += 1) {
      await target.fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: `m${i}`, stream: true }),
      });
      await new Promise((resolve) => setTimeout(resolve, 5));   // 让文件名里的毫秒有区分
    }
    await capture.flush();
    assert.equal(capture.stats.records, 3);
    assert.equal((await listFiles(dir)).length, 6);              // 3 × (request + request.headers)
    const list = await capture.list({ limit: 10 });
    assert.equal(list.length, 3);
    assert.equal(list[0].model, "m2");                            // 新的在前
    assert.equal(list[2].model, "m0");
    assert.equal(new Set(list.map((r) => r.id)).size, 3, "每条记录必须是独立文件");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("端到端：sweep 按天数删日期目录，且不动无关文件", async () => {
  const dir = await makeDir();
  try {
    const old = join(dir, "2020-01-01");
    const fresh = join(dir, "2026-09-25");
    await mkdir(old, { recursive: true });
    await mkdir(fresh, { recursive: true });
    await writeFile(join(old, `${baseName(new Date(2020, 0, 1, 1, 1, 1, 1), "aaaaaaaa")}${SUFFIXES.request}`), "{}\n", "utf8");
    await writeFile(join(fresh, `${baseName(new Date(2026, 8, 25, 1, 1, 1, 1), "bbbbbbbb")}${SUFFIXES.request}`), "{}\n", "utf8");
    await writeFile(join(dir, "keep-me.txt"), "x", "utf8");
    const capture = createCapture({ directory: dir, retentionDays: 7 }, { target: fakeTarget(async () => okResponse()), warn: silent });

    // 目录 mtime 都是刚创建的，所以只应删掉手工回填 mtime 的那个
    const past = new Date(Date.now() - 30 * 86400_000);
    await utimes(old, past, past);
    const swept = await capture.sweep({ days: 7 });
    assert.deepEqual(swept.removed.map((r) => r.name), ["2020-01-01"]);
    assert.equal(swept.freedFiles, 1);
    const left = await readdir(dir);
    assert.ok(left.includes("2026-09-25"));
    assert.ok(left.includes("keep-me.txt"));
    assert.ok(!left.includes("2020-01-01"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("端到端：sessionScope 存在时才写 sessionId，并可按会话过滤", async () => {
  const dir = await makeDir();
  const store = new (await import("node:async_hooks")).AsyncLocalStorage();
  try {
    const target = fakeTarget(async () => okResponse());
    const capture = createCapture({ directory: dir, headerAllow: [] }, { target, warn: silent, sessionScope: store });
    capture.install();
    await store.run("session-abc", () => target.fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m" }),
    }));
    await capture.flush();
    const list = await capture.list({ limit: 5 });
    assert.equal(list[0].sessionId, "session-abc");
    assert.equal((await capture.list({ limit: 5, sessionId: "session-abc" })).length, 1);
    assert.equal((await capture.list({ limit: 5, sessionId: "other" })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
