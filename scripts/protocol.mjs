// 两种 wire 协议的公共知识：端点字面量、鉴权 header、请求体形状、SSE 解析。
//
// DSH 0.2.0 的实际情况（对着 dsh-llm-deepseek / dsh-llm-pi-ai 源码核对过）：
//   messages —— deepseek-official / deepseek-account：POST {root}/v1/messages
//               root 默认 https://api.deepseek.com/anthropic（messagesApiRoot 补 /v1）
//               body：system 顶层 + messages[].content 块 + tools[].input_schema
//   chat     —— pi-ai 的 openai-completions：POST {root}/chat/completions
//               body：messages[].content 字符串 + tools[].function.parameters
//
// 两个 e2e 脚本共用这里，免得端点/形状在两处漂移。

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 密钥来源：DEEPSEEK_API_KEY 环境变量 → <DSH_HOME>/.credentials.yaml 的 refs。 */
export function resolveKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  const home = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
  try {
    const text = readFileSync(join(home, ".credentials.yaml"), "utf8");
    const match = /^refs:\s*\n(?:[ \t]+.*\n)*?[ \t]+DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(text);
    if (match) return match[1];
  } catch { /* 没有凭据文件 */ }
  return null;
}

export const PROTOCOLS = ["messages", "chat"];

/** describeWire / describeResponse 使用的协议名。 */
export function wireProtocolOf(protocol) {
  return protocol === "messages" ? "messages" : "chat-completions";
}

/** 端点：{ url, headers, authHeaderName }。 */
export function endpointOf(protocol, apiKey) {
  if (protocol === "messages") {
    const root = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic").replace(/\/+$/, "");
    return {
      url: root.endsWith("/v1") ? `${root}/messages` : `${root}/v1/messages`,
      authHeaderName: "x-api-key",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
    };
  }
  const root = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  return {
    url: `${root}/v1/chat/completions`,
    authHeaderName: "authorization",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
  };
}

/** 工具声明的两种形状。 */
export function toolsOf(protocol) {
  const messagesTool = {
    name: "echo",
    description: "回显传入的文本",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
      additionalProperties: false,
    },
  };
  const chatTool = {
    type: "function",
    function: {
      name: "echo",
      description: "回显传入的文本",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "要回显的文本" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  };
  return protocol === "messages" ? [messagesTool] : [chatTool];
}

const SYSTEM_TEXT = "你必须使用 echo 工具回显用户的话，不要直接回答。";
const USER_TEXT = "请回显：多轮测试一二三";

/** 第一轮请求体。 */
export function turn1Body(protocol, model) {
  if (protocol === "messages") {
    return JSON.stringify({
      model,
      max_tokens: 256,
      stream: true,
      system: [{ type: "text", text: SYSTEM_TEXT }],
      messages: [{ role: "user", content: [{ type: "text", text: USER_TEXT }] }],
      tools: toolsOf(protocol),
    });
  }
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: SYSTEM_TEXT },
      { role: "user", content: USER_TEXT },
    ],
    stream: true,
    stream_options: { include_usage: true },
    tools: toolsOf(protocol),
    max_tokens: 256,
  });
}

/** 第二轮请求体：把第一轮的助手输出与工具结果按各自协议回传。 */
export function turn2Body(protocol, model, first) {
  const echoed = JSON.stringify({ echoed: "多轮测试一二三" });
  if (protocol === "messages") {
    const assistantContent = [
      ...first.content ? [{ type: "text", text: first.content }] : [],
      ...first.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })),
    ];
    return JSON.stringify({
      model,
      max_tokens: 256,
      stream: true,
      system: [{ type: "text", text: SYSTEM_TEXT }],
      messages: [
        { role: "user", content: [{ type: "text", text: USER_TEXT }] },
        { role: "assistant", content: assistantContent },
        {
          role: "user",
          content: first.toolCalls.map((call) => ({
            type: "tool_result",
            tool_use_id: call.id,
            content: [{ type: "text", text: echoed }],
          })),
        },
      ],
      tools: toolsOf(protocol),
    });
  }
  const call = first.toolCalls[0];
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: SYSTEM_TEXT },
      { role: "user", content: USER_TEXT },
      {
        role: "assistant",
        content: first.content,
        ...first.reasoning ? { reasoning_content: first.reasoning } : {},
        ...call ? { tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : {},
      },
      { role: "tool", tool_call_id: call.id, content: echoed },
    ],
    stream: true,
    stream_options: { include_usage: true },
    tools: toolsOf(protocol),
    max_tokens: 256,
  });
}

/**
 * 极简 SSE 解析，归一成 { content, reasoning, toolCalls:[{id,name,input}], finish }。
 * Messages 走 event:/data: 信封（content_block_delta / input_json_delta），
 * Chat 走 data: {...choices[].delta}。
 */
export function parseSse(raw, protocol) {
  const out = { content: "", reasoning: "", toolCalls: [], finish: null };
  if (protocol === "messages") {
    const blocks = new Map();
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data.length === 0) continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event.type === "content_block_start") {
        const block = event.content_block ?? {};
        if (block.type === "tool_use") {
          blocks.set(event.index, { id: block.id ?? "", name: block.name ?? "", json: "" });
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") out.content += delta.text;
        else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") out.reasoning += delta.thinking;
        else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const current = blocks.get(event.index);
          if (current) current.json += delta.partial_json;
        }
      } else if (event.type === "message_delta") {
        if (event.delta?.stop_reason) out.finish = event.delta.stop_reason;
      }
    }
    for (const block of blocks.values()) {
      let input = {};
      try { input = block.json.length > 0 ? JSON.parse(block.json) : {}; } catch { input = {}; }
      out.toolCalls.push({ id: block.id, name: block.name, input });
    }
    return out;
  }
  const calls = new Map();
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]" || data.length === 0) continue;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") out.content += delta.content;
    if (typeof delta.reasoning_content === "string") out.reasoning += delta.reasoning_content;
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      calls.set(index, current);
    }
    if (choice.finish_reason) out.finish = choice.finish_reason;
  }
  for (const call of calls.values()) {
    let input = {};
    try { input = call.arguments.length > 0 ? JSON.parse(call.arguments) : {}; } catch { input = {}; }
    out.toolCalls.push({ id: call.id, name: call.name, input });
  }
  return out;
}
