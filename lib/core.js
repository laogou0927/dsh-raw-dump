// dsh-raw-dump 核心：线级 fetch 抓取 + 一请求一文件落盘
//
// 为什么是 fetch 层：DSH 里 `llm/stream` 的 waterfall（dsh-llm/lib/index.js）拿到的是
// provider 中立的 GenerateOptions；真正的报文是在适配器内部拼出来的，只有到 fetch 那一行
// 才 JSON.stringify({...body, ...extensions.fields})。所以「发出去的字节」只有在 fetch
// 这一层才看得见，且要在 provider 扩展字段注入**之后**。
//
// DSH 0.2.0 的动作端点（本文件按这个改：这是 0.1.5 版本在 0.2.0 上抓不到东西的唯一原因）：
//   - deepseek-official / deepseek-account → Messages 协议
//     dsh-llm-deepseek/lib/index.js:
//       fetch(`${messagesApiRoot(connection.baseURL)}/messages`)
//       messagesApiRoot() 在 base 不以 /v1 结尾时补一段 "/v1"
//     默认 baseURL "https://api.deepseek.com/anthropic"
//     ⇒ POST https://api.deepseek.com/anthropic/v1/messages
//   - pi-ai 的 openai-completions 协议 → POST {baseURL}/chat/completions
//     （pi-ai 内置 deepseek 路由的 baseURL 是 https://api.deepseek.com，无 /v1）
//   - pi-ai 的 anthropic-messages 协议 → POST {baseURL}/v1/messages?beta=true
// 三者 body 都是 JSON；协议差异只在字段名（system / messages[].content 块 /
// tools[].input_schema 对 OpenAI 的 messages / tools[].function.parameters）。
// 本文件两种协议都识别，元数据里标 wire.protocol。
//
// 落盘布局（一请求一文件，纯 JSON，VS Code 打开即可折叠/高亮）：
//
//   <directory>/<YYYY-MM-DD>/
//     08-15-25.123-ab12cd34.request.json          ← 请求体，格式化 JSON
//     08-15-25.123-ab12cd34.request.headers.json  ← 仅当 headerAllow 配了名字
//     08-15-25.123-ab12cd34.response.json         ← 仅 captureResponse: true；响应体
//     08-15-25.123-ab12cd34.response.headers.json ← 仅 captureResponse + headerAllow
//
// 文件内容纪律：
//   - 能解析成 JSON 的 body → 写**格式化后的原始 JSON 值**（不是被转义的字符串）。
//   - 不能解析 / 被截断 / 读超时 → 写 { "_dsh": {…原因…}, "payload": "<原始文本>" }，
//     绝不产出非法 JSON，也不假装内容完整。
//   - 请求侧只用 .request.json 的**存在**就代表"字节已落盘"，所以不需要额外元数据文件；
//     bytes/truncated 这类信息写在 headers 侧（配了 headerAllow 时）或由文件大小体现。
//
// 三条硬约束：
//   1. 绝不干扰请求 —— 抓取失败只记数并 warn，永远把原 fetch 的结果原样返回。
//   2. 绝不给调用方增加等待 —— 解析/写盘全在后台 promise 里，await 处只有真正的 fetch。
//   3. 落盘的 body 就是发出去的那个字符串（格式化只改空白，不改值）。

import { mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import os from "node:os";

/**
 * 默认抓取的 URL 路径（大小写不敏感，按**路径边界**匹配 —— 见 shouldCapture）。
 *
 * 每个条目都是一条端点路径形态（0.2.0 的真实字面量见文件头注释）：
 *   - `/messages`         —— deepseek-official / deepseek-account 的
 *                            `https://api.deepseek.com/anthropic/v1/messages`，
 *                            以及 pi-ai 的 anthropic-messages、Anthropic 官方端点
 *   - `/chat/completions` —— pi-ai 的 openai-completions 等 OpenAI 兼容端点
 *   - `/responses`        —— OpenAI Responses API
 *
 * `/v1/...` 这类带版本前缀的写法保留着，是为了让"按子串匹配"的旧配置继续能用；
 * 默认的边界匹配下它们与不带前缀的形态等价。
 */
export const DEFAULT_MATCH = [
  "/chat/completions",
  "/messages",
  "/responses",
  "/v1/completions",
  "/v1/messages",
  "/v1/responses",
];

/**
 * 这些 header 一律以 <redacted> 落盘。
 *
 * `x-dsh-auth-token` 是 0.2.0 新增的账号凭证（dsh-llm-deepseek-account 用
 * `headers: { "x-dsh-auth-token": token }` 送账号 token，无 Bearer 前缀），
 * 属于必须打码的名字 —— 0.1.5 的名单里没有它。
 */
export const DEFAULT_REDACT_HEADERS = [
  "authorization",
  "api-key",
  "x-api-key",
  "x-dsh-auth-token",
  "x-deepseek-auth-token",
  "proxy-authorization",
  "cookie",
  "set-cookie",
];

export const DEFAULTS = {
  enabled: true,
  /** 落盘根目录；留空 = <DSH_HOME>/dsh-raw-dump */
  directory: "",
  /** 抓取哪些 URL 路径（大小写不敏感）；默认按路径边界匹配 */
  match: DEFAULT_MATCH,
  /** matchMode: "path"（默认，路径边界）| "substring"（旧的子串匹配） */
  matchMode: "path",
  /** true = 不看 match，抓所有 fetch（噪音大，仅排查用） */
  matchAll: false,
  /** 请求体保留上限（字节）；超出只留前缀并标 truncated */
  maxRequestBodyBytes: 16 * 1024 * 1024,
  /** 是否抓响应体（每请求多一个 .response.json） */
  captureResponse: false,
  maxResponseBodyBytes: 8 * 1024 * 1024,
  /** 读响应体 clone 分支的最长等待（毫秒）；到时按已读内容落盘并标 timedOut */
  responseReadTimeoutMs: 5000,
  /** 这些 header 以 <redacted> 落盘 */
  redactHeaders: DEFAULT_REDACT_HEADERS,
  /** 额外记录哪些 header：null = 一个都不记（默认）；[] = 记全部；名单 = 只记名单 */
  headerAllow: null,
  /** 目录内 <date>/ 保留天数；0 = 永不自动清理 */
  retentionDays: 0,
  /** 浏览接口一次最多回看多少条 */
  indexLimit: 2000,
  debug: false,
};

/** <DSH_HOME>（与 dsh-home-paths 的约定一致）。 */
export function findDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  if (configured) return configured;
  return join(os.homedir(), ".dsh");
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 配置归一化：字符串/数字边界一律钳到合法值，非法值退回默认。 */
export function resolveConfig(raw = {}, env = process.env) {
  const cfg = { ...DEFAULTS, ...(raw ?? {}) };
  const directory = typeof cfg.directory === "string" && cfg.directory.trim()
    ? resolve(cfg.directory.trim())
    : join(findDshHome(env), "dsh-raw-dump");
  const match = Array.isArray(cfg.match)
    ? cfg.match.filter((m) => typeof m === "string" && m.length > 0)
    : [];
  const redactHeaders = Array.isArray(cfg.redactHeaders)
    ? cfg.redactHeaders.filter((h) => typeof h === "string" && h.length > 0).map((h) => h.toLowerCase())
    : [];
  // headerAllow 的三态：未配置 = 一个都不记（null）；显式 [] = 记全部非敏感项；名单 = 只记名单内
  const allowExplicit = Array.isArray(raw?.headerAllow);
  const allowed = allowExplicit
    ? raw.headerAllow.filter((h) => typeof h === "string" && h.length > 0).map((h) => h.toLowerCase())
    : [];
  const headerAllow = allowExplicit && allowed.length === 0 ? [] : (allowed.length > 0 ? allowed : null);
  return {
    ...cfg,
    directory,
    match: match.length > 0 ? match : [...DEFAULT_MATCH],
    redactHeaders: redactHeaders.length > 0 ? redactHeaders : [...DEFAULT_REDACT_HEADERS],
    headerAllow,
    matchMode: cfg.matchMode === "substring" ? "substring" : "path",
    maxRequestBodyBytes: positiveInt(cfg.maxRequestBodyBytes, DEFAULTS.maxRequestBodyBytes),
    maxResponseBodyBytes: positiveInt(cfg.maxResponseBodyBytes, DEFAULTS.maxResponseBodyBytes),
    responseReadTimeoutMs: positiveInt(cfg.responseReadTimeoutMs, DEFAULTS.responseReadTimeoutMs),
    retentionDays: Math.min(3650, Math.max(0, Number(cfg.retentionDays) || 0)),
    indexLimit: Math.min(20000, Math.max(50, Number(cfg.indexLimit) || DEFAULTS.indexLimit)),
    matchAll: cfg.matchAll === true,
    captureResponse: cfg.captureResponse === true,
    debug: cfg.debug === true,
  };
}

// ───────────────────────────── 命名与判定 ─────────────────────────────

/** 日期目录：YYYY-MM-DD */
export function dateStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 文件基名：HH-MM-SS.mmm-<8 位短 id>（字典序 = 时间序，且自带毫秒消歧） */
export function baseName(now, id) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}-${String(id).replace(/-/g, "").slice(0, 8)}`;
}

export const SUFFIXES = {
  request: ".request.json",
  requestHeaders: ".request.headers.json",
  response: ".response.json",
  responseHeaders: ".response.headers.json",
};

/** 只认本插件写的 jsON 文件 */
export function isDumpFile(name) {
  return name.endsWith(".json") && /^\d{2}-\d{2}-\d{2}\.\d{3}-[0-9a-f]{8}\.(request|response)(\.headers)?\.json$/.test(name);
}

/** 日期目录名 */
export function isDateDir(name) {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

/** 把一个文件名拆成 { base, kind }；不是本插件的文件返回 null。 */
export function parseDumpFile(name) {
  const match = /^(\d{2}-\d{2}-\d{2}\.\d{3}-[0-9a-f]{8})\.(request|response)(\.headers)?\.json$/.exec(name);
  if (!match) return null;
  return { base: match[1], kind: match[2], headers: match[3] !== undefined };
}

/**
 * URL 是否命中抓取白名单。
 *
 * 两种模式：
 *   - "path"（默认）：needle 必须落在**路径边界**上 —— 路径以 needle 结尾，
 *     或 needle 之后紧跟 `/`（`/messages` 命中 `/anthropic/messages` 与 `/v1/messages/…`，
 *     但不命中 `/messages-archive`）。这样 `/messages` 这种短针既能覆盖 0.2.0 的
 *     `/anthropic/messages`，又不会把无关端点拖进来。
 *   - "substring"：0.1.5 的旧行为（在任何位置出现即命中），显式配置时才用。
 *
 * URL 解析失败（相对路径、非 http 形态）时退回子串比较，宁可多抓不要漏抓。
 */
export function shouldCapture(url, cfg) {
  if (cfg.matchAll) return true;
  const raw = String(url);
  const mode = cfg.matchMode === "substring" ? "substring" : "path";
  if (mode === "substring") {
    const lower = raw.toLowerCase();
    return cfg.match.some((needle) => lower.includes(String(needle).toLowerCase()));
  }
  let pathname = null;
  try {
    pathname = new URL(raw).pathname.toLowerCase();
  } catch {
    pathname = null;
  }
  if (pathname === null) {
    const lower = raw.toLowerCase();
    return cfg.match.some((needle) => lower.includes(String(needle).toLowerCase()));
  }
  return cfg.match.some((needle) => {
    const at = pathname.indexOf(String(needle).toLowerCase());
    if (at === -1) return false;
    return at + needle.length === pathname.length || pathname[at + needle.length] === "/";
  });
}

/** URL 只留 origin + pathname（query 里可能带 key/token）。 */
export function safeUrl(raw) {
  try {
    const u = new URL(String(raw));
    const pathname = u.pathname;
    const slash = pathname.lastIndexOf("/");
    return {
      full: u.origin + pathname,
      host: u.host,
      pathname,
      // 端点名（`/anthropic/messages` → `messages`），列表/工具里扫读用
      endpoint: slash === -1 ? pathname : pathname.slice(slash + 1),
    };
  } catch {
    return { full: String(raw).slice(0, 512), host: "", pathname: "", endpoint: "" };
  }
}

/**
 * 从请求体里抽出「便于扫读」的字段。两种协议都认：
 *
 *   Messages（0.2.0 默认，Anthropic 形态）：model / stream / system / messages[].content 块 /
 *     tools[].input_schema / metadata.user_id
 *   Chat Completions（OpenAI 形态）：model / stream / messages[].content 字符串或块 /
 *     tools[].function.parameters / tool_calls / role:"tool" / stream_options
 *
 * 协议判定只认**协议特有的强信号**，绝不用"content 是数组"这种两边都成立的特征 ——
 * OpenAI 的多模态消息（`image_url`）content 同样是数组，早期版本就是栽在这里：
 * 一条真实的 pi-ai 请求（808 条消息、365 条带 tool_calls、tools[].function）里
 * 有 1 条 image_url 消息，就被错判成了 messages。信号打平或都没有时，用 URL 路径兜底。
 *
 * 只读结构，不改 body 一个字节；解析失败一律 null / 0，不影响落盘内容。
 *
 * @param bodyText - 发出去的请求体原文
 * @param [options] - `{ pathname }`：URL 路径，作为协议判定的兜底依据
 */
export function describeWire(bodyText, options = {}) {
  const raw = typeof bodyText === "string" ? bodyText : "";
  if (!raw.startsWith("{")) return null;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
  const tools = Array.isArray(parsed.tools) ? parsed.tools : null;
  // system 是 Anthropic 形态的顶层字段：字符串或内容块数组
  const system = parsed.system;
  const systemChars = typeof system === "string"
    ? system.length
    : Array.isArray(system)
      ? system.reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : 0), 0)
      : 0;

  // ── 协议证据：只数协议特有的特征 ──────────────────────────────────
  const score = { messages: 0, chat: 0 };
  if (typeof system === "string" || Array.isArray(system)) score.messages += 3;
  for (const tool of tools ?? []) {
    if (tool?.input_schema !== undefined) score.messages += 3;        // Anthropic 工具声明
    if (tool?.function !== undefined || tool?.type === "function") score.chat += 3;
  }
  if (parsed.stream_options !== undefined) score.chat += 2;           // OpenAI 专有
  if (parsed.store !== undefined) score.chat += 1;
  let blocks = 0;
  for (const message of messages ?? []) {
    if (message?.tool_calls !== undefined) score.chat += 3;
    if (message?.role === "tool") score.chat += 3;                    // OpenAI 的工具结果角色
    if (!Array.isArray(message?.content)) continue;
    blocks += message.content.length;
    for (const block of message.content) {
      const type = block?.type;
      if (type === "tool_use" || type === "tool_result" || type === "thinking" || type === "redacted_thinking") {
        score.messages += 3;
      }
      if (type === "image_url" || type === "input_audio") score.chat += 2;
      if (block?.cache_control !== undefined) score.messages += 2;
    }
  }

  let protocol;
  if (score.messages > score.chat) protocol = "messages";
  else if (score.chat > score.messages) protocol = "chat-completions";
  else protocol = protocolFromPath(options.pathname) ?? "unknown";

  return {
    protocol,
    model: typeof parsed.model === "string" ? parsed.model : null,
    stream: typeof parsed.stream === "boolean" ? parsed.stream : null,
    messages: messages === null ? 0 : messages.length,
    blocks,
    systemChars,
    tools: tools === null ? 0 : tools.length,
  };
}

/**
 * 用 URL 路径兜底判定协议；认不出返回 null。
 * 容忍误传完整 URL（带 scheme 时先取出 pathname 再判）。
 */
export function protocolFromPath(value) {
  const raw = String(value ?? "");
  if (raw.length === 0) return null;
  let path = raw.toLowerCase();
  if (path.includes("://")) {
    try { path = new URL(raw).pathname.toLowerCase(); } catch { return null; }
  }
  if (/(^|\/)messages$/.test(path)) return "messages";
  if (path.includes("/chat/completions") || /(^|\/)completions$/.test(path) || /(^|\/)responses$/.test(path)) {
    return "chat-completions";
  }
  return null;
}

/** header 过滤：headerAllow=null 一个不记；[] 记全部非敏感项；名单只记名单内；敏感名一律 <redacted>。 */
export function projectHeaders(headers, cfg) {
  if (!headers || cfg.headerAllow === null) return {};
  const allow = Array.isArray(cfg.headerAllow) && cfg.headerAllow.length > 0
    ? new Set(cfg.headerAllow)
    : null;
  const redact = new Set(cfg.redactHeaders);
  const out = {};
  const entries = typeof headers.entries === "function" ? [...headers.entries()] : Object.entries(headers);
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName).toLowerCase();
    if (allow && !allow.has(name)) continue;
    out[name] = redact.has(name) ? "<redacted>" : String(rawValue);
  }
  return out;
}

function utf8Length(text) {
  return Buffer.byteLength(text, "utf8");
}

// ───────────────────────────── 格式化输出 ─────────────────────────────

/**
 * 把待落盘文本整成「VS Code 打开就好看」的 JSON 文本。
 *
 * 两条路径：
 *   - 文本本身就是合法 JSON → 重新缩进 2 空格输出，**值一个字节都不改**（只改空白）。
 *     超大 JSON 不缩进：单行字符串加长数组缩进后会膨胀数倍，而且缩进本身也要花时间。
 *   - 不是合法 JSON（截断、非 JSON 的 body、带 SSE 前缀的文本、gzip 二进制）→ 包成
 *     { _dsh: { reason, bytes, truncated, timedOut }, payload: "<原始文本>" }，
 *     保证文件永远是合法 JSON，同时明确标注它不是原始 JSON。
 */
export function formatForFile(text, { reason = "非 JSON 文本", bytes, truncated = false, timedOut = false, maxPrettyBytes = 8 * 1024 * 1024 } = {}) {
  const raw = typeof text === "string" ? text : "";
  const size = bytes ?? utf8Length(raw);
  const trimmed = raw.trim();
  if (trimmed.length > 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      const parsed = JSON.parse(trimmed);
      const pretty = size <= maxPrettyBytes;
      return { text: (pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed)) + "\n", pretty, wrapped: false };
    } catch { /* 落下去当文本处理 */ }
  }
  const wrapper = {
    _dsh: {
      format: "text",
      reason,
      bytes: size,
      truncated,
      timedOut,
    },
    payload: raw,
  };
  return { text: JSON.stringify(wrapper, null, 2) + "\n", pretty: true, wrapped: true };
}

// ───────────────────────────── 写盘 ─────────────────────────────

/** 单实例内串行的写盘队列；失败只记数，不抛给调用方。 */
function createWriter(cfg, stats, onError) {
  let queue = Promise.resolve();
  let lastDir = null;

  /** 原子写：先写 .tmp 再 rename，避免 VS Code 读到写了一半的文件。 */
  async function writeAtomic(path, text) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  }

  async function writeFiles(directory, files) {
    queue = queue.then(async () => {
      try {
        const dir = join(cfg.directory, directory);
        if (lastDir !== dir) {
          await mkdir(dir, { recursive: true });
          lastDir = dir;
        }
        for (const file of files) {
          const path = join(dir, file.name);
          await writeAtomic(path, file.text);
          stats.files += 1;
          stats.bytes += utf8Length(file.text);
          stats.lastFile = path;
        }
        stats.records += 1;
      } catch (error) {
        stats.writeErrors += 1;
        onError(error);
      }
    });
    return queue;
  }

  return { writeFiles, flush: () => queue };
}

/** 扫描根目录，返回按名字升序的日期目录与其文件。 */
export async function scanTree(directory) {
  let names = [];
  try { names = await readdir(directory); } catch { return []; }
  const days = [];
  for (const name of names) {
    if (!isDateDir(name)) continue;
    let entries = [];
    try { entries = await readdir(join(directory, name)); } catch { continue; }
    const files = [];
    for (const entry of entries) {
      if (!isDumpFile(entry)) continue;
      let size = 0;
      try { size = (await stat(join(directory, name, entry))).size; } catch { continue; }
      files.push({ name: entry, bytes: size });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    days.push({ date: name, files, bytes: files.reduce((sum, f) => sum + f.bytes, 0) });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}

/** 把根目录下的文件汇总成 { files, bytes }（兼容旧接口形状）。 */
export async function fileFacts(directory) {
  const days = await scanTree(directory);
  const files = [];
  for (const day of days) for (const file of day.files) files.push({ ...file, date: day.date });
  return { files, bytes: files.reduce((sum, f) => sum + f.bytes, 0), days };
}

/** 读一个文件的原始文本；不存在返回 null。 */
async function readText(path) {
  try {
    const handle = await open(path, "r");
    try { return await handle.readFile("utf8"); } catch { return null; } finally { try { await handle.close(); } catch { /* 已关闭 */ } }
  } catch {
    return null;
  }
}

/**
 * 把一组文件还原成浏览接口/工具用的记录形状。
 *
 * 两个细节：
 *   - 时间从文件名重建：base 是 HH-MM-SS.mmm-<id>，毫秒在 [9,12)。
 *   - 请求体在磁盘上是**格式化过的** JSON，原始空白已不可考，所以这里给出的是等值重建
 *     文本（紧凑 JSON），并标 exact:false —— 不假装它就是发出去的原始字节。
 *     绝对字节数走 headers 侧的 _dsh.bodyBytes / 文件大小。
 */
async function loadRecord(directory, day, base) {
  const dir = join(directory, day);
  const requestFile = `${base}${SUFFIXES.request}`;
  const requestText = await readText(join(dir, requestFile));
  if (requestText === null) return null;
  const requestHeadersText = await readText(join(dir, `${base}${SUFFIXES.requestHeaders}`));
  const requestMeta = safeJson(requestHeadersText)?._dsh ?? null;
  const responseText = await readText(join(dir, `${base}${SUFFIXES.response}`));
  const responseMeta = safeJson(await readText(join(dir, `${base}${SUFFIXES.responseHeaders}`)))?._dsh ?? null;

  let requestJson = null;
  try { requestJson = JSON.parse(requestText); } catch { /* 不是 JSON，保持 null */ }
  const requestWrapped = requestJson !== null && typeof requestJson === "object" && requestJson._dsh !== undefined && "payload" in requestJson;
  const requestBodyText = requestWrapped ? String(requestJson.payload ?? "") : requestText;
  // 两种协议都由 describeWire 认；老文件没有 wire 元数据时退回同一套判定。
  // 路径作为兜底依据（body 信号打平或都没有时用它）。
  const wire = describeWire(requestBodyText, { pathname: safeUrl(requestMeta?.url ?? "").pathname });
  // 详情接口手里有 body，就以 body 重算的结果为准（与下面的 model/stream 同一套优先级）。
  // 这样早先版本判错的老记录也能显示正确 —— 元数据里的值只是抓取当时的记录。
  const wireShape = wire === null
    ? (requestMeta?.wire ?? null)
    : {
      protocol: wire.protocol,
      messages: wire.messages,
      blocks: wire.blocks,
      systemChars: wire.systemChars,
      tools: wire.tools,
    };

  const record = {
    v: 1,
    id: `${day}/${base}`,
    base,
    date: day,
    phase: "asked",
    at: `${day}T${base.slice(0, 2)}:${base.slice(3, 5)}:${base.slice(6, 8)}.${base.slice(9, 12)}`,
    sessionId: requestMeta?.sessionId ?? null,
    url: requestMeta?.url ?? null,
    endpoint: requestMeta?.endpoint ?? null,
    protocol: wireShape?.protocol ?? null,
    wire: wireShape,
    method: requestMeta?.method ?? null,
    model: wire?.model ?? requestMeta?.model ?? null,
    stream: wire?.stream ?? requestMeta?.stream ?? null,
    headers: requestMeta?.headers ?? {},
    request: {
      kind: requestMeta?.bodyKind ?? (requestWrapped ? "text" : "json"),
      captured: requestWrapped ? requestJson._dsh?.captured !== false : true,
      ...requestWrapped && requestJson._dsh?.reason ? { reason: requestJson._dsh.reason } : {},
      bytes: requestMeta?.bodyBytes ?? Buffer.byteLength(requestBodyText, "utf8"),
      truncated: requestMeta?.bodyTruncated === true || requestJson?._dsh?.truncated === true,
      // exact=false：磁盘上是格式化 JSON，原始空白不可考（值完全一致）
      exact: false,
      text: requestWrapped ? requestBodyText : compact(requestJson, requestText),
      file: join(dir, requestFile),
    },
  };

  if (responseText !== null) {
    const responseJson = safeJson(responseText);
    const responseWrapped = responseJson !== null && typeof responseJson === "object" && responseJson._dsh !== undefined && "payload" in responseJson;
    const bodyText = responseWrapped ? String(responseJson.payload ?? "") : responseText;
    record.response = {
      status: responseMeta?.status ?? null,
      // 响应侧协议由 SSE 形态自己说了算（message_* → Messages，choices → Chat Completions）
      protocol: describeResponse(bodyText) ?? responseMeta?.protocol ?? null,
      captured: responseMeta?.body?.captured !== false,
      ...responseMeta?.body?.reason ? { reason: responseMeta.body.reason } : {},
      bytes: responseMeta?.body?.bytes ?? Buffer.byteLength(bodyText, "utf8"),
      truncated: responseMeta?.body?.truncated === true || responseJson?._dsh?.truncated === true,
      timedOut: responseMeta?.body?.timedOut === true || responseJson?._dsh?.timedOut === true,
      exact: false,
      text: responseWrapped ? bodyText : compact(responseJson, responseText),
      file: join(dir, `${base}${SUFFIXES.response}`),
    };
    record.responseStatus = record.response.status;
    record.durationMs = responseMeta?.durationMs ?? null;
    record.responseHeaders = responseMeta?.headers ?? {};
    record.phase = "asked+answered";
  }
  return record;
}

/**
 * 从响应文本判定协议（只看前若干字节的形态，不做完整解析）。
 *   Messages      → SSE 事件名 `message_start` / `content_block_delta` …
 *   ChatCompletions → `data: {"choices":…` / `"object":"chat.completion…"`
 * 认不出返回 null（例如非 200 的 JSON 错误体）。
 */
export function describeResponse(text) {
  const head = (typeof text === "string" ? text : "").slice(0, 4096);
  if (head.length === 0) return null;
  if (/event:\s*message_start|"type"\s*:\s*"content_block_delta"|"type"\s*:\s*"message_start"/.test(head)) return "messages";
  if (/"choices"\s*:|"object"\s*:\s*"chat\.completion/.test(head)) return "chat-completions";
  return null;
}

function safeJson(text) {
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); } catch { return null; }
}

function compact(parsed, fallback) {
  if (parsed === null || parsed === undefined) return fallback ?? "";
  try { return JSON.stringify(parsed); } catch { return fallback ?? ""; }
}

// ───────────────────────────── 抓取 ─────────────────────────────

function clipUtf8(text, maxBytes) {
  if (utf8Length(text) <= maxBytes) return { text, truncated: false };
  const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
  let end = buf.length;
  while (end > 0) {
    let start = end - 1;
    let back = 0;
    while (start > 0 && (buf[start] & 0b1100_0000) === 0b1000_0000) { start -= 1; back += 1; }
    const lead = buf[start];
    const width = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (back === width - 1) break;
    end = start;
  }
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * 把 fetch 的 body 归一成字符串或标记为不可捕获。
 * 覆盖：字符串 / Buffer-or-typed-array / URLSearchParams / Blob / ReadableStream。
 * 不覆盖：async-iterable body —— 直接标记 unsupported，而不是偷偷抽干流。
 * 返回 stream 分支时带 `next`：必须把它交回 fetch，否则真请求读到的是空流。
 */
export async function normalizeBody(body, maxBytes) {
  if (body === undefined || body === null) return { kind: "empty", text: "", captured: true };
  if (typeof body === "string") {
    const clipped = clipUtf8(body, maxBytes);
    return { kind: "string", text: clipped.text, bytes: utf8Length(body), captured: true, truncated: clipped.truncated };
  }
  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    const slice = buf.subarray(0, maxBytes);
    return { kind: "bytes", text: slice.toString("utf8"), bytes: buf.length, captured: true, truncated: buf.length > slice.length };
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    const text = body.toString();
    const clipped = clipUtf8(text, maxBytes);
    return { kind: "urlencoded", text: clipped.text, bytes: utf8Length(text), captured: true, truncated: clipped.truncated };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    const buf = Buffer.from(await body.arrayBuffer());
    const slice = buf.subarray(0, maxBytes);
    return { kind: "blob", text: slice.toString("utf8"), bytes: buf.length, captured: true, truncated: buf.length > slice.length };
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    // tee：一支给真请求，一支给我们读；我们这支出错也只是丢一份抓取
    const [pass, mirror] = body.tee();
    const pending = (async () => {
      const reader = mirror.getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
          total += buf.length;
          if (total <= maxBytes) chunks.push(buf);
        }
      } catch (error) {
        return { kind: "stream", text: "", bytes: total, captured: false, reason: String(error?.message ?? error) };
      } finally {
        try { reader.releaseLock(); } catch { /* 已释放 */ }
      }
      return {
        kind: "stream",
        text: Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8"),
        bytes: total,
        captured: true,
        truncated: total > maxBytes,
      };
    })();
    return { kind: "stream", stream: pass, pending, captured: true };
  }
  return { kind: typeof body, text: "", captured: false, reason: "unsupported body type" };
}

/**
 * 读一个有界前缀（响应体用）。非流式 body 走 text()。
 *
 * 超时是必需的：我们读的是 clone 出来的一支，如果上游消费者提前停止拉取
 * （例如 agent 拿到完整回答后就不再读剩余的 usage chunk），这一支永远等不到 EOF，
 * 后台任务就会挂着、文件永远不落盘。到时按已读到的字节落盘并标 timedOut。
 *
 * 两条实现纪律：
 *   1. 不能 await 一个已经挂起的 `reader.read()` —— 它可能永远不 settle。
 *   2. 收尾**绝不 cancel**：undici 的 Response.clone() 是 tee，取消 clone 分支会连带
 *      影响另一支，真实 DSH 启动下会让适配器判定 "DeepSeek stream consumer stopped"
 *      并以 fatal 结束整个 turn。只 releaseLock 是安全的。
 */
async function readBounded(response, maxBytes, timeoutMs = 5000) {
  const body = response?.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    let finished = false;
    const deadline = Date.now() + Math.max(200, timeoutMs);
    try {
      while (Date.now() < deadline) {
        const remain = deadline - Date.now();
        let timer = null;
        const result = await Promise.race([
          reader.read().catch(() => ({ done: true, failed: true })),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), remain); }),
        ]);
        if (timer) clearTimeout(timer);
        if (result === null) break;
        if (result.failed) break;
        if (result.done) { finished = true; break; }
        const buf = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
        total += buf.length;
        if (total <= maxBytes) chunks.push(buf);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* 有挂起读时必然抛错，忽略 */ }
    }
    return {
      text: Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8"),
      bytes: total,
      captured: true,
      truncated: total > maxBytes,
      ...finished ? {} : { timedOut: true },
    };
  }
  // 标准 Response 的 body 一定有 getReader；这里兜住自定义/测试替身
  if (typeof response?.text === "function") {
    try {
      const text = await response.text();
      const clipped = clipUtf8(text, maxBytes);
      return { text: clipped.text, bytes: utf8Length(text), captured: true, truncated: clipped.truncated };
    } catch (error) {
      return { text: "", bytes: 0, captured: false, reason: String(error?.message ?? error) };
    }
  }
  return { text: "", bytes: 0, captured: false, reason: "no readable body" };
}

// ───────────────────────────── 对外工厂 ─────────────────────────────

/**
 * 只依赖路径的轻量摘要：只读两个 headers 元数据文件（通常几百字节），不碰大 body 文件。
 * 真实请求体动辄几十 KB 到几 MB，列表绝不能把它读进来。
 */
async function summarizeFiles(directory, day, base, files = {}) {
  const dir = join(directory, day);
  const requestMeta = safeJson(await readText(join(dir, `${base}${SUFFIXES.requestHeaders}`)))?._dsh ?? null;
  const responseMeta = safeJson(await readText(join(dir, `${base}${SUFFIXES.responseHeaders}`)))?._dsh ?? null;
  const requestFile = files.request;
  const responseFile = files.response;
  const requestDisk = requestFile?.bytes ?? 0;
  const responseDisk = responseFile?.bytes ?? 0;
  const requestBytes = requestMeta?.bodyBytes ?? requestDisk;
  return {
    // 文件名里的时间就是本地时间，和目录名一致；元数据里的 at 是 UTC
    at: `${day}T${base.slice(0, 2)}:${base.slice(3, 5)}:${base.slice(6, 8)}.${base.slice(9, 12)}`,
    atUtc: requestMeta?.at ?? null,
    id: `${day}/${base}`,
    phase: responseFile ? "asked+answered" : "asked",
    sessionId: requestMeta?.sessionId ?? null,
    url: requestMeta?.url ?? null,
    endpoint: requestMeta?.endpoint ?? null,
    protocol: requestMeta?.wire?.protocol ?? null,
    wire: requestMeta?.wire ?? null,
    method: requestMeta?.method ?? null,
    model: requestMeta?.model ?? null,
    stream: requestMeta?.stream ?? null,
    requestBytes,
    requestDiskBytes: requestDisk,
    requestTruncated: requestMeta?.bodyTruncated === true,
    requestCaptured: requestMeta?.bodyReason === undefined,
    ...requestMeta?.bodyReason ? { requestReason: requestMeta.bodyReason } : {},
    responseStatus: responseMeta?.status ?? null,
    // 响应体真实字节（SSE 原文），与 .response.json 的文件大小不同（格式化后更小）
    responseBytes: responseMeta?.body?.bytes ?? responseDisk,
    responseDiskBytes: responseDisk,
    responseCaptured: responseMeta?.body?.captured ?? null,
    responseTimedOut: responseMeta?.body?.timedOut === true,
    durationMs: responseMeta?.durationMs ?? null,
    responseHeaders: responseMeta?.headers ?? {},
    files: [requestFile?.name, responseFile?.name].filter(Boolean),
  };
}

/** 已知一个条目的完整记录时，转成列表用的摘要（不重复读盘）。 */
function summarizeRecord(record, files = {}) {
  return {
    at: record.at,
    atUtc: record.requestMetaAt ?? null,
    id: record.id,
    seq: null,
    phase: record.phase,
    sessionId: record.sessionId ?? null,
    url: record.url,
    method: record.method ?? null,
    model: record.model ?? null,
    stream: record.stream ?? null,
    requestBytes: record.request?.bytes ?? 0,
    requestDiskBytes: files.requestBytes ?? 0,
    requestTruncated: record.request?.truncated === true,
    requestCaptured: record.request?.captured !== false,
    responseStatus: record.responseStatus ?? null,
    responseBytes: record.response?.bytes ?? 0,
    responseDiskBytes: files.responseBytes ?? 0,
    responseCaptured: record.response?.captured ?? null,
    responseTimedOut: record.response?.timedOut === true,
    durationMs: record.durationMs ?? null,
    responseHeaders: record.responseHeaders ?? {},
    error: record.error ?? null,
    files: files.files ?? [],
  };
}

/**
 * 安装线级抓取。
 * @param {object} rawConfig - 归一化前的插件配置
 * @param {object} [deps] - 测试注入点：{ target, warn, sessionScope, now }
 */
export function createCapture(rawConfig = {}, deps = {}) {
  const cfg = resolveConfig(rawConfig);
  const target = deps.target ?? globalThis;
  const warn = deps.warn ?? ((message) => console.warn(`[dsh-raw-dump] ${message}`));
  const sessionScope = deps.sessionScope ?? null;
  const clock = typeof deps.now === "function" ? deps.now : () => new Date();
  const stats = {
    startedAt: new Date().toISOString(),
    seen: 0,
    captured: 0,
    skipped: 0,
    failed: 0,
    writeErrors: 0,
    readErrors: 0,
    cloneSkipped: 0,
    records: 0,
    files: 0,
    bytes: 0,
    lastAt: null,
    lastFile: null,
  };
  const writer = createWriter(cfg, stats, (error) => warn(`落盘失败: ${error?.message ?? error}`));
  const inflight = new Set();
  let installed = false;
  let original = null;

  const now = () => clock();
  const sessionIdOf = () => {
    try { return sessionScope?.getStore?.() ?? null; } catch { return null; }
  };

  function track(promise) {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise));
    return promise;
  }

  /** 组装并写出一个请求的全部文件。 */
  function writeExchange(fields) {
    const { id, method, url, body, headers, movedAt, status, startedMs, responseRead, responseHeaders, finishedAt } = fields;
    const day = dateStamp(movedAt);
    const base = baseName(movedAt, id);
    const files = [];
    const requestFormatted = formatForFile(body.text ?? "", {
      reason: body.captured === false ? (body.reason ?? "未捕获") : "非 JSON 文本",
      bytes: body.bytes ?? utf8Length(body.text ?? ""),
      truncated: body.truncated === true,
    });
    files.push({ name: `${base}${SUFFIXES.request}`, text: requestFormatted.text });

    // 从原始文本解析出便于扫读的字段（两种协议都认）；解析失败一律 null / 0，不影响落盘内容。
    // 路径一起传进去：body 里的协议信号打平或都没有时，靠 URL 兜底。
    const rawRequestText = body.text ?? "";
    const endpoint = safeUrl(url);
    const wire = describeWire(rawRequestText, { pathname: endpoint.pathname });
    const model = wire?.model ?? null;
    const stream = wire?.stream ?? null;
    // 元数据里只留形状，不留正文：system 200 KB 也不必在元数据里再抄一遍
    const wireMeta = wire === null ? undefined : {
      protocol: wire.protocol,
      messages: wire.messages,
      blocks: wire.blocks,
      systemChars: wire.systemChars,
      tools: wire.tools,
    };

    const headerText = (payload) => JSON.stringify(payload, null, 2) + "\n";
    // 元数据文件**总是**写：它不只装 header，还装 bodyBytes / bodyTruncated / bodyReason /
    // sessionId / model —— 缺了它，列表接口就只能拿文件大小当字节数、
    // 也无法区分"body 没抓到"和"body 是空的"。headerAllow=null 时 headers 就是 {}。
    {
      files.push({
        name: `${base}${SUFFIXES.requestHeaders}`,
        text: headerText({
          _dsh: {
            at: movedAt.toISOString(),
            id,
            host: endpoint.host,
            method,
            url: endpoint.full,
            endpoint: endpoint.endpoint,
            model,
            stream,
            sessionId: sessionIdOf(),
            ...wireMeta === undefined ? {} : { wire: wireMeta },
            bodyKind: body.kind,
            bodyBytes: body.bytes ?? utf8Length(rawRequestText),
            bodyTruncated: body.truncated === true,
            ...body.captured === false ? { bodyReason: body.reason ?? "unknown" } : {},
            requestFile: `${base}${SUFFIXES.request}`,
            headers: projectHeaders(headers, cfg),
          },
        }),
      });
    }

    if (responseRead) {
      const rawResponseText = responseRead.text ?? "";
      const responseFormatted = formatForFile(rawResponseText, {
        reason: "SSE/文本响应",
        bytes: responseRead.bytes ?? 0,
        truncated: responseRead.truncated === true,
        timedOut: responseRead.timedOut === true,
      });
      files.push({ name: `${base}${SUFFIXES.response}`, text: responseFormatted.text });
      // 协议由响应自己说了算：SSE 的 `event: message_*` 是 Messages，`data: {...choices}` 是
      // Chat Completions。认不出（例如非 200 的错误 JSON）就不写协议字段。
      const responseProtocol = describeResponse(rawResponseText);
      files.push({
        name: `${base}${SUFFIXES.responseHeaders}`,
        text: headerText({
          _dsh: {
            at: finishedAt.toISOString(),
            id,
            url: endpoint.full,
            endpoint: endpoint.endpoint,
            status: status ?? null,
            durationMs: Date.now() - startedMs,
            ...responseProtocol === null ? {} : { protocol: responseProtocol },
            body: {
              bytes: responseRead.bytes ?? 0,
              captured: responseRead.captured !== false,
              truncated: responseRead.truncated === true,
              timedOut: responseRead.timedOut === true,
              ...responseRead.captured === false ? { reason: responseRead.reason ?? "unknown" } : {},
              file: `${base}${SUFFIXES.response}`,
            },
            headers: responseHeaders,
          },
        }),
      });
    }

    stats.lastAt = movedAt.toISOString();
    if (cfg.debug) warn(`write ${day}/${base} files=${files.map((f) => f.name).join(",")}`);
    return writer.writeFiles(day, files);
  }

  function install() {
    if (installed) return false;
    const fetchImpl = target.fetch;
    if (typeof fetchImpl !== "function") {
      warn("globalThis.fetch 不存在，跳过安装");
      return false;
    }
    original = fetchImpl;
    const wrapped = async function wrappedFetch(input, init) {
      stats.seen += 1;
      const url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url ?? "");
      if (!cfg.enabled || !shouldCapture(url, cfg)) {
        stats.skipped += 1;
        return original.call(this, input, init);
      }
      const method = String(init?.method ?? (typeof input === "object" ? input?.method : undefined) ?? "GET").toUpperCase();
      const id = randomUUID();
      let normalized;
      try {
        normalized = await normalizeBody(init?.body, cfg.maxRequestBodyBytes);
      } catch (error) {
        normalized = { kind: "unknown", text: "", captured: false, reason: String(error?.message ?? error) };
      }
      // stream body 必须换成 tee 出来的一支再发，否则真请求读到的是空流
      const nextInit = normalized.stream ? { ...(init ?? {}), body: normalized.stream } : init;
      const startedMs = Date.now();
      let response;
      try {
        response = await original.call(this, input, nextInit);
      } catch (error) {
        stats.failed += 1;
        track((async () => {
          try {
            const at = now();
            const day = dateStamp(at);
            const base = baseName(at, id);
            await writer.writeFiles(day, [
              {
                name: `${base}${SUFFIXES.request}`,
                text: JSON.stringify({
                  _dsh: { format: "text", reason: "请求未完成（fetch 抛错）", bytes: 0, truncated: false, timedOut: false },
                  payload: "",
                }, null, 2) + "\n",
              },
              {
                name: `${base}${SUFFIXES.responseHeaders}`,
                text: JSON.stringify({
                  _dsh: {
                    at: at.toISOString(),
                    id,
                    url: safeUrl(url).full,
                    method,
                    durationMs: Date.now() - startedMs,
                    error: String(error?.message ?? error),
                    headers: projectHeaders(init?.headers, cfg),
                  },
                }, null, 2) + "\n",
              },
            ]);
          } catch (inner) {
            stats.readErrors += 1;
            warn(`失败记录落盘失败: ${inner?.message ?? inner}`);
          }
        })());
        throw error;
      }
      stats.captured += 1;
      // 关键：必须在同步块里先克隆响应。DSH 的适配器拿到响应后立即开始流式消费 body，
      // 等到后台任务再 clone 就已经是 "Body has already been consumed" 了。
      let mirror = null;
      if (cfg.captureResponse && typeof response?.clone === "function") {
        try {
          mirror = response.clone();
        } catch (error) {
          mirror = null;
          stats.cloneSkipped += 1;
          if (cfg.debug) warn(`响应克隆失败，跳过响应体: ${error?.message ?? error}`);
        }
      }
      track((async () => {
        try {
          const body = normalized.pending ? await normalized.pending : normalized;
          const responseRead = mirror
            ? await readBounded(mirror, cfg.maxResponseBodyBytes, cfg.responseReadTimeoutMs)
            : null;
          await writeExchange({
            id,
            method,
            url,
            body,
            headers: init?.headers,
            movedAt: now(),
            status: response?.status,
            startedMs,
            responseRead,
            responseHeaders: mirror ? projectHeaders(mirror.headers, cfg) : {},
            finishedAt: now(),
          });
        } catch (error) {
          stats.readErrors += 1;
          warn(`抓取失败: ${error?.message ?? error}`);
        }
      })());
      return response;
    };
    // 打标记：避免被重复包装，也让还原时能认出自己
    Object.defineProperty(wrapped, "__dshRawDump", { value: true, enumerable: false });
    target.fetch = wrapped;
    installed = true;
    return true;
  }

  function uninstall() {
    if (!installed) return false;
    try {
      if (target.fetch === original || target.fetch?.__dshRawDump === true) {
        target.fetch = original;
      } else {
        warn("fetch 已被别的插件再包装，跳过还原以免破坏它的外层");
      }
    } catch (error) {
      warn(`还原 fetch 失败: ${error?.message ?? error}`);
    }
    installed = false;
    return true;
  }

  async function flush() {
    await writer.flush();
    await Promise.allSettled([...inflight]);
  }

  async function status() {
    const { files, bytes, days } = await fileFacts(cfg.directory);
    return {
      enabled: cfg.enabled,
      installed,
      directory: cfg.directory,
      layout: "<date>/<HH-MM-SS.mmm-id>.request.json | .request.headers.json | .response.json | .response.headers.json（格式化 JSON，一请求一文件）",
      /** 这套默认值是给 DSH 0.2.0 的动作端点用的（/anthropic/messages 与 /chat/completions） */
      target: "dsh 0.2.0",
      match: cfg.match,
      matchMode: cfg.matchMode,
      matchAll: cfg.matchAll,
      captureResponse: cfg.captureResponse,
      maxRequestBodyBytes: cfg.maxRequestBodyBytes,
      maxResponseBodyBytes: cfg.maxResponseBodyBytes,
      responseReadTimeoutMs: cfg.responseReadTimeoutMs,
      retentionDays: cfg.retentionDays,
      redactHeaders: cfg.redactHeaders,
      headerAllow: cfg.headerAllow,
      ...stats,
      dateDirs: days.length,
      fileCount: files.length,
      diskBytes: bytes,
      files: files.slice(-20),
    };
  }

  /** 最近 limit 条摘要（新→旧），只读文件名与两个 headers 元数据文件，绝不读大 body。 */
  async function list({ limit = 100, sessionId = null } = {}) {
    const want = Math.min(cfg.indexLimit, Math.max(1, Number(limit) || 100));
    const days = await scanTree(cfg.directory);
    const out = [];
    for (let i = days.length - 1; i >= 0 && out.length < want; i -= 1) {
      const day = days[i];
      for (let j = day.files.length - 1; j >= 0 && out.length < want; j -= 1) {
        const parsed = parseDumpFile(day.files[j].name);
        if (!parsed || parsed.kind !== "request" || parsed.headers) continue;
        const key = `${day.date}/${parsed.base}`;
        if (out.some((entry) => entry.id === key)) continue;
        const request = day.files[j];
        const response = day.files.find((f) => f.name === `${parsed.base}${SUFFIXES.response}`);
        const summary = await summarizeFiles(cfg.directory, day.date, parsed.base, { request, response });
        if (sessionId && summary.sessionId !== sessionId) continue;
        out.push(summary);
      }
    }
    return out;
  }

  /** 取一个 id（"<date>/<base>"）的全部内容。 */
  async function get(id) {
    const text = String(id ?? "");
    const slash = text.lastIndexOf("/");
    if (slash <= 0) return null;
    const day = text.slice(0, slash);
    const base = text.slice(slash + 1);
    // 只接受本插件自己的命名，避免路径穿越与误读
    if (!isDateDir(day) || parseDumpFile(`${base}${SUFFIXES.request}`) === null || base.includes("..")) return null;
    const record = await loadRecord(cfg.directory, day, base);
    return record === null ? null : [record];
  }

  /** 手工清理：按天数删旧日期目录，或 drain=true 清空根目录内本插件的日期目录。 */
  async function sweep({ days = cfg.retentionDays, drain = false } = {}) {
    const all = await scanTree(cfg.directory);
    const cutoff = Date.now() - Math.max(0, Number(days) || 0) * 86400_000;
    const removed = [];
    for (const entry of all) {
      let stale = drain;
      if (!drain) {
        if (Number(days) === 0) continue;
        try {
          const info = await stat(join(cfg.directory, entry.date));
          stale = info.mtimeMs < cutoff;
        } catch { stale = false; }
      }
      if (!stale) continue;
      try {
        await rm(join(cfg.directory, entry.date), { recursive: true, force: true });
        removed.push({ name: entry.date, bytes: entry.bytes, files: entry.files.length });
      } catch (error) {
        warn(`删除 ${entry.date} 失败: ${error?.message ?? error}`);
      }
    }
    return {
      removed,
      freedBytes: removed.reduce((sum, f) => sum + f.bytes, 0),
      freedFiles: removed.reduce((sum, f) => sum + (f.files ?? 0), 0),
    };
  }

  /** 删除某个日期的单个条目（供接口/工具按需调用）。 */
  async function drop(id) {
    const text = String(id ?? "");
    const slash = text.lastIndexOf("/");
    if (slash <= 0) return 0;
    const day = text.slice(0, slash);
    const base = text.slice(slash + 1);
    if (!isDateDir(day)) return 0;
    let removed = 0;
    for (const suffix of Object.values(SUFFIXES)) {
      try { await unlink(join(cfg.directory, day, `${base}${suffix}`)); removed += 1; } catch { /* 本来就没有 */ }
    }
    return removed;
  }

  return { cfg, install, uninstall, flush, status, list, get, sweep, drop, stats };
}

/** 只读浏览页（无外部资源；请求体按 JSON 展示，可切 Raw）。 */
export function renderPage(basePath) {
  return `<!doctype html>
<meta charset="utf-8">
<title>dsh-raw-dump</title>
<style>
  :root { color-scheme: light dark }
  body { font: 13px/1.5 ui-monospace, Consolas, monospace; margin: 0; padding: 12px }
  h1 { font-size: 15px; margin: 0 0 8px }
  #meta { opacity: .78; margin-bottom: 8px; white-space: pre-wrap }
  table { border-collapse: collapse; width: 100% }
  th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid #8884; white-space: nowrap }
  tr.row { cursor: pointer }
  tr.row:hover { background: #8882 }
  #detail { margin-top: 12px }
  pre { white-space: pre-wrap; word-break: break-all; max-height: 60vh; overflow: auto; border: 1px solid #8884; padding: 8px }
  .hint { opacity: .7 }
  button, input, select { font: inherit }
  input { width: 22em }
</style>
<h1>dsh-raw-dump · 线级原始报文 <span class="hint">(dsh 0.2.0)</span></h1>
<div id="meta">loading…</div>
<div><button id="reload">刷新</button> <button id="toggle">Raw / 折叠</button>
  <input id="session" placeholder="按 sessionId 过滤（可留空）"> <button id="filter">过滤</button>
  <span class="hint">点一行看完整报文；磁盘上一个请求一个 .request.json / .response.json</span></div>
<table><thead><tr>
  <th>时间</th><th>端点</th><th>协议</th><th>model</th><th>session</th><th>status</th><th>请求</th><th>响应</th><th>耗时</th><th>文件</th>
</tr></thead><tbody id="rows"></tbody></table>
<div id="detail"></div>
<script>
const BASE = ${JSON.stringify(basePath)};
let raw = false;
let lastId = null;
const fmt = (n) => n == null || n === 0 ? '' : n < 1024 ? n + ' B'
  : (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MiB' : (n / 1024).toFixed(1) + ' KiB');
const short = (id) => !id ? '' : (id.length > 12 ? id.slice(0, 12) + '…' : id);
async function load() {
  const session = document.getElementById('session').value.trim();
  const res = await fetch(BASE + '/api/list?limit=200' + (session ? '&session=' + encodeURIComponent(session) : ''));
  const data = await res.json();
  const s = data.status;
  document.getElementById('meta').textContent =
    '目录 ' + s.directory + '\\n' + (s.target ? '目标 ' + s.target + ' · ' : '')
    + '匹配(' + (s.matchMode || 'path') + ') ' + (s.match || []).join(', ') + (s.matchAll ? ' +matchAll' : '') + '\\n'
    + '日期目录 ' + s.dateDirs + ' 个 · 文件 ' + s.fileCount + ' · 占用 ' + (fmt(s.diskBytes) || '0 B')
    + ' · 已抓 ' + s.captured + ' 次请求 · 跳过 ' + s.skipped + ' · 写失败 ' + s.writeErrors
    + '\\n最近一次 ' + (s.lastAt || '(还没有)');
  const rows = document.getElementById('rows');
  rows.textContent = '';
  for (const r of data.records) {
    const tr = document.createElement('tr');
    tr.className = 'row';
    const cells = [r.at, r.endpoint || (r.url || '').replace(/^https?:\\/\\/[^/]+/, ''), r.protocol || '',
      r.model || '', short(r.sessionId), r.responseStatus ?? '', fmt(r.requestBytes),
      fmt(r.responseBytes), r.durationMs == null ? '' : r.durationMs + ' ms', (r.files || [])[0] || ''];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    tr.onclick = () => show(r.id);
    rows.appendChild(tr);
  }
}
async function show(id) {
  lastId = id;
  const res = await fetch(BASE + '/api/get?id=' + encodeURIComponent(id));
  const data = await res.json();
  const box = document.getElementById('detail');
  box.textContent = '';
  for (const rec of data.records || []) {
    const head = document.createElement('div');
    head.textContent = id + ' · ' + (rec.method || 'POST') + ' ' + (rec.url || '')
      + (rec.protocol ? ' · ' + rec.protocol : '')
      + (rec.sessionId ? ' · session ' + rec.sessionId : '')
      + ' · ' + (rec.request?.file || '') + ' · ' + fmt(rec.request?.bytes)
      + (rec.response ? ' | ' + rec.response.file + ' · HTTP ' + rec.response.status : '');
    box.appendChild(head);
    if (rec.request) box.appendChild(pre(rec.request.text));
    if (rec.response) box.appendChild(pre(rec.response.text));
  }
}
function pre(text) {
  const el = document.createElement('pre');
  const value = text || '';
  if (raw) { el.textContent = value; return el; }
  try { el.textContent = JSON.stringify(JSON.parse(value), null, 2); }
  catch { el.textContent = value; }
  return el;
}
document.getElementById('reload').onclick = () => load();
document.getElementById('filter').onclick = () => load();
document.getElementById('session').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
document.getElementById('toggle').onclick = () => { raw = !raw; if (lastId) show(lastId); };
load();
</script>`;
}
