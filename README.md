# dsh-raw-dump（DSH 0.2.0 适配版）

**线级 LLM 报文落盘** —— 一个 DeepSeek Harness 插件：包装 `globalThis.fetch`，把每次发往模型端点的**原始请求体**原样追加写到磁盘（每请求一组 JSON 文件），并提供一个只读浏览页。

这个仓库是 **DSH 0.2.0 适配版**（对应 0.1.5 版 `@rain-kl/dsh-raw-dump`：用途相同，改的是它赖以工作的两件事 —— **端点**与**宿主接口**；本版包名改为 `@laogou0927/dsh-raw-dump`）。

## 安装

从 GitHub 装（`dsh plugin add` 支持 git 地址）：

```sh
dsh plugin --profile web add github:laogou0927/dsh-raw-dump
```

或从本地目录装：

```sh
dsh plugin --profile web add /path/to/dsh-raw-dump
```

（`dsh plugin` 会转发给 pnpm，并把声明了 `dsh.bundle` 的依赖自动加进 profile 的 `dsh.profile.bundles`。）然后重启 `dsh web`。无构建步骤：纯 ESM，不依赖任何第三方包，不注册 client bundle。

> ⚠️ **不要和 0.1.5 版（`@rain-kl/dsh-raw-dump`）同时启用**。两者会嵌套包装 `fetch`，同一次请求被写两遍；而且它们的 bundle patch 用的是同一个 loader 行 id（`dsh-raw-dump`），只启用其中一个。

---

## 0.2.0 到底改了什么（本版本的由来）

### 1. 端点从 OpenAI 兼容搬到了 Anthropic Messages（**这是 0.1.5 版在 0.2.0 上一条都抓不到的原因**）

| | 0.1.5 | 0.2.0 |
| --- | --- | --- |
| 端点 | `https://api.deepseek.com/chat/completions` | `https://api.deepseek.com/anthropic/v1/messages` |
| 协议 | Chat Completions | Anthropic Messages |
| 源码 | `dsh-llm-deepseek`: `fetch(\`${baseURL}/chat/completions\`)` | `fetch(\`${messagesApiRoot(baseURL)}/messages\`)`；`messagesApiRoot()` 在 base 不以 `/v1` 结尾时补 `/v1`，默认 baseURL 是 `https://api.deepseek.com/anthropic` |

`deepseek-official`（API key）与 `deepseek-account`（账号登录）**共用同一个适配器**，所以两个 provider 都打这条 Messages 端点；0.2.0 的 `@deepseek-ai/*` 树里已经**没有 `/chat/completions`**。pi-ai 的 `openai-completions` 协议仍然打 `{baseURL}/chat/completions`（其内置 deepseek 路由的 baseURL 是 `https://api.deepseek.com`，无 `/v1`）。

所以本版本的默认匹配是：

```js
["/chat/completions", "/messages", "/responses", "/v1/completions", "/v1/messages", "/v1/responses"]
```

并且**按路径边界匹配**（`/messages` 命中 `/anthropic/v1/messages`，不命中 `/messages-archive`）。0.1.5 那套纯子串匹配也能用，显式写 `matchMode: substring` 即可。

### 2. 修掉三处 0.1.5 就带着的缺陷

| 缺陷 | 后果 | 本版本的处理 |
| --- | --- | --- |
| `createCapture()` 没拿到 `AsyncLocalStorage` | `attributeSession` 形同虚设，落盘的 `sessionId` **永远是 `null`** | 把 sessionScope 真正传进抓取层（真实 cordis 宿主测试里断言了归属成立） |
| `webServer.register()` 的返回值被丢掉 | 路由注册在 `ctx.effect` 里 `return undefined` → 没人回收 → **热重载一次就撞 `duplicate exact route`**，插件 fiber 回滚、fetch 包装被卸掉、抓取静默停止 | 收集每个路由的 disposer 并在 effect 里交回去 |
| 工具/命令注册没挂在本 fiber 上 | 同上：重载时重名注册直接抛错 | 注册包在 `ctx.effect` 里，把返回的 disposer 交回去 |

三处都在 `test/host-smoke.mjs` 与 `test/host-cordis.test.mjs` 里被钉住（含"加载 → 释放 → 再加载一次"的往返）。

### 3. 新增账号凭证要打码

0.2.0 的账号 provider 用 `x-dsh-auth-token` 送 token（无 `Bearer` 前缀）。它已加进默认 `redactHeaders`；**如果你在 patch 里手写了 `redactHeaders`，请把 `x-dsh-auth-token` 一起写上**（本文件夹的 `cordis.patch.yml` 已经写了）。

### 4. 兼容性声明

0.2.0 起 `peerDependencies` 会被 semver 校验（`dsh-app-boot` 的 `evaluatePluginCompatibility`），而运行时版本是 `0.2.0-rc.1` 这种预发布：**`^0.2.0` 匹配不上它**（`>=0.2.0` 不含 `0.2.0-rc.1`）。所以本包声明：

```json
"peerDependencies": { "@deepseek-ai/dsh": "^0.2.0-rc.1" }
```

实测：`0.2.0-rc.1` ✅ · `0.2.0` ✅ · `0.2.5` ✅ · `0.3.0` ❌ · `0.1.5` ❌。装到 0.1.5 上会被明确拦下（这正是分两个文件夹的用意）；如果确实要强行装，用 `dsh plugin allow-version` 或插件页的版本豁免。

### 5. 宿主接口核对结果（0.2.0 无需改动的部分）

对着 0.2.0 源码逐条核过，以下都是**照旧可用**：`webServer.register({kind,path,handler})`（第二个 label 参数在 0.2.0 已被忽略，本版本不再传）、`handler(req,res)` 自己负责整段响应、工具定义形状 `{name,description,parameters,output:{schema,render},execute}`（`parameters` 仍是 **raw JSON Schema**；只有 `defineTool` 才吃属性映射表）、`commands.register({name,description,input:{hint},handler})` 与 `{kind:"success",text}`、`ctx.on(name, listener, {global:true})`、`ctx.effect/inject/get`、以及 `llm/stream` 瀑布上的 `options.sessionId`。

`console.log` 也换成了 `ctx.logger`：ACP 之类的 bundle 里 stdout 属于协议，往 stdout 打印会破坏它。

---

## 落盘内容

**一个请求一组文件**，放在按日期分的目录里：

```
<directory>/
  2026-09-29/
    08-44-20.503-b5979df0.request.json           ← 请求体：格式化好的纯 JSON
    08-44-20.503-b5979df0.request.headers.json   ← 元数据（URL/端点/协议/model/sessionId/字节数/header）
    08-44-20.503-b5979df0.response.json          ← 仅 captureResponse: true
    08-44-20.503-b5979df0.response.headers.json  ← 仅 captureResponse: true
```

文件名 = `HH-MM-SS.mmm-<8 位请求 id>`（字典序即时间序，毫秒自带消歧）。

**`.request.json` 就是发出去的请求体本身**，缩进 2 空格、合法 JSON —— VS Code 打开即可折叠、高亮、跳转。Messages 协议长这样：

```json
{
  "model": "deepseek-flash",
  "max_tokens": 32000,
  "stream": true,
  "system": [{ "type": "text", "text": "…", "cache_control": { "type": "ephemeral" } }],
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "…" }] },
    { "role": "assistant", "content": [
      { "type": "text", "text": "…" },
      { "type": "tool_use", "id": "toolu_…", "name": "read", "input": { "path": "…" } }
    ] },
    { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_…", "content": "…" }] }
  ],
  "tools": [{ "name": "read", "description": "…", "input_schema": { "type": "object", "…": "…" } }],
  "dsh_plugin_packages": { "version": 1, "packages": [ … ] }
}
```

`.request.headers.json` 只放元数据（body 不在里面）：

```json
{
  "_dsh": {
    "at": "2026-09-29T08:44:20.251Z",
    "id": "d1edd51c-5487-4496-80ab-d41374fc7b6b",
    "host": "api.deepseek.com",
    "method": "POST",
    "url": "https://api.deepseek.com/anthropic/v1/messages",
    "endpoint": "messages",
    "model": "deepseek-flash",
    "stream": true,
    "sessionId": "session-…",
    "wire": { "protocol": "messages", "messages": 3, "blocks": 7, "systemChars": 4821, "tools": 26 },
    "bodyKind": "string",
    "bodyBytes": 6099,
    "bodyTruncated": false,
    "requestFile": "08-44-20.251-d1edd51c.request.json",
    "headers": { "content-type": "application/json" }
  }
}
```

`wire` 是 0.2.0 新增的：一眼看出这是哪种协议、几条消息、几个内容块、system 多长、几个工具 —— 不读大 body 就能在列表里分辨。`protocol` 的判定同时认 Messages（`system` 顶层 / content 块 / `input_schema`）与 Chat Completions（字符串 content / `function.parameters`）。

### 内容纪律

| 情况 | 文件长什么样 |
| --- | --- |
| body 是合法 JSON（DSH 的对话请求） | **原样 JSON 值**，只重新缩进；值一个字节都不改 |
| body 不是 JSON（表单、图片、自定义 payload） | `{ "_dsh": { "format": "text", … }, "payload": "<原始文本>" }` |
| body 被上限截断 | 同上包装，`_dsh.truncated: true` —— 绝不留半个字、绝不产出非法 JSON |
| 响应是 SSE（必然不是单个 JSON） | `.response.json` = `{ "_dsh": { "timedOut": … }, "payload": "event: …" }`，原文完整保留 |
| 读响应超过 `responseReadTimeoutMs` | 按已读内容落盘并标 `_dsh.timedOut: true`，不假装完整 |
| 真 fetch 抛错 | 请求侧留一个空包装文件，响应侧留 `.response.headers.json` 带 `error` |

所有写入都是**先写 `.tmp` 再 rename**，VS Code 里不会读到写了一半的文件。

### 字段速查

| 字段 | 含义 |
| --- | --- |
| `_dsh.bodyBytes` | **发出去的原始字节数**（不受缩进影响） |
| `_dsh.bodyTruncated` | 是否因超限只留了前缀（截断按 UTF-8 字符边界） |
| `_dsh.bodyKind` | `string` / `stream` / `bytes` / `urlencoded` / `blob` / `empty` |
| `_dsh.bodyReason` | 仅当这种 body 类型无法抓取（如 async-iterable）时出现 |
| `_dsh.url` | 只留 origin + pathname，**query 被丢掉**（key/token 不进盘） |
| `_dsh.endpoint` | 端点名（`/anthropic/v1/messages` → `messages`），列表里扫读用 |
| `_dsh.wire.protocol` | `messages` / `chat-completions`，从请求形状判定 |
| `_dsh.headers` | 默认**一个都不记**；见下面三态说明 |
| `_dsh.sessionId` | 靠 `llm/stream` 的 `options.sessionId` + AsyncLocalStorage 归属；拿不到就是 `null` |
| `_dsh.durationMs` | 从调用 fetch 到响应头返回（仅响应侧） |
| `cloneSkipped`（统计） | 响应不可克隆（已被消费）的次数 |

---

## 配置

loader 行的 `config:` 块（profile 的 patch 文件）接受：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 关掉即完全不装包装 |
| `directory` | `<DSH_HOME>/dsh-raw-dump` | 落盘根目录（下面按日期建子目录） |
| `match` | `['/chat/completions','/messages','/responses','/v1/completions','/v1/messages','/v1/responses']` | URL 路径白名单（大小写不敏感） |
| `matchMode` | `path` | `path` = 路径边界匹配；`substring` = 0.1.5 的旧语义（任何位置出现即命中） |
| `matchAll` | `false` | 抓所有 fetch（噪音大，仅排查用） |
| `maxRequestBodyBytes` | `16777216`（16 MiB） | 单请求保留上限；超出留前缀并标 `truncated` |
| `captureResponse` | `false` | 是否一并抓响应体（每请求多一对 `.response.*` 文件） |
| `maxResponseBodyBytes` | `8388608`（8 MiB） | 响应体保留上限 |
| `responseReadTimeoutMs` | `5000` | 读响应体 clone 分支的最长等待；到时按已读内容落盘并标 `timedOut` |
| `headerAllow` | 不配置 | **三态**：不配置 = 一个 header 都不记；显式 `[]` = 记全部非敏感项；给定名单 = 只记名单内 |
| `redactHeaders` | `['authorization','api-key','x-api-key','x-dsh-auth-token','x-deepseek-auth-token','proxy-authorization','cookie','set-cookie']` | 这些名字一律记成 `<redacted>` |
| `retentionDays` | `0` | `0` = 永不自动清理；`sweep` 按天数删**日期目录** |
| `attributeSession` | `true` | 是否用 AsyncLocalStorage 做 Session 归属 |
| `debug` | `false` | 把每次抓取写进宿主日志 |

想核对 0.2.0 的 Messages 端点带了哪些 header，可以写：

```yaml
headerAllow: [content-type, anthropic-version, anthropic-beta, x-deepseek-harness-session-id]
```

改完 patch 后需要重启（或让 profile 重载）才生效。

---

## 浏览接口

宿主 Web 服务注册在 `/dsh-raw-dump`（与主 UI 同源、同端口，走宿主自己的 Host/Origin 与浏览器会话 cookie 检查）：

| 路由 | 说明 |
| --- | --- |
| `GET /dsh-raw-dump` | 浏览页：状态条 + 最近记录列表（含端点/协议/session 列与 sessionId 过滤）+ 点一行看完整报文（Raw / 折叠两种视图） |
| `GET /dsh-raw-dump/api/status` | 抓取统计、日期目录数、文件数与占用 |
| `GET /dsh-raw-dump/api/list?limit=200&session=<id>` | 最近记录摘要（新→旧，只读元数据，不碰大文件） |
| `GET /dsh-raw-dump/api/get?id=<date>/<base>` | 一个请求的完整内容（请求体 + 响应体） |
| `POST /dsh-raw-dump/api/sweep` | body `{"days":7}` 按天数删日期目录；`{"drain":true}` 清空 |

Agent 侧还有一个 `raw_dump_status` 工具（`action=status|sweep|drain`）和一个 `/raw-dump` 命令。

---

## 设计约束

- **不干扰请求**：任何抓取/写盘异常都被吞掉并只记数（`writeErrors` / `readErrors` / `cloneSkipped`），永远返回原 fetch 的结果。真 fetch 抛错时原样抛出，只额外记一条带 `error` 的元数据。
- **不给调用方增加等待**：`await` 只包住真正的 fetch；解析和写盘都在后台 promise 里，同一实例内串行写盘避免交错。
- **原子写**：先写 `.tmp` 再 `rename`，所以 VS Code 里永远读不到半截文件。
- **响应必须同步克隆**：DSH 的适配器拿到响应后立即开始流式消费 body，等后台任务再 `response.clone()` 就是 `Body has already been consumed.` —— 所以克隆发生在 fetch 返回的同一个同步块内，克隆失败只记数不报错。
- **绝不 cancel clone 分支**（踩过的坑）：undici 的 `Response.clone()` 是 tee，**对 clone 分支调用 `reader.cancel()` 会连带影响另一支**，真实启动下会让适配器判定 `DeepSeek stream consumer stopped`、整个 turn 以 fatal 结束。所以读到上限/超时后只 `releaseLock`，不 cancel；测试里用显式的假 reader 锁死这条约束。
- **落盘只改空白**：JSON 值一个字节都不改，只重新缩进；绝对字节数记在元数据 `bodyBytes` 里。列表接口返回的 `text` 是紧凑重建（`exact: false`），因为原始空白已不可考 —— 如实标注，不假装。
- **stream body 走 `tee`**：抓取分支出错只丢一份抓取，给真请求的那一支保持原样。
- **注册全部可回收**：路由 / 工具 / 命令 / fetch 包装都挂在 `ctx.effect` 上并把 disposer 交回去，fiber 释放或热重载后不留残留、也不会撞重名。
- **还原干净**：`ctx.effect` 的 disposer 里还原 `globalThis.fetch`；如果发现它已被别的插件再包一层，就跳过还原以免破坏对方的外层。

---

## 已知边界

- **请求体里的敏感信息不脱敏**：整个 system prompt、全部 tool schema、agent 读过的文件内容都会明文落盘。只有 header 名单会被替换。请把 `directory` 放在可信位置，并注意它可能很大。
- **一请求一文件，不去重**：同一条消息在连续多轮里重复出现不会去重。文件数 = 请求数 × (1~2) × (1~2)。
- **超大 JSON 不缩进**：超过 8 MiB 的 body 写成单行紧凑 JSON —— 缩进会让文件膨胀数倍且拖慢写入。文件仍是合法 JSON。
- **`sessionId` 靠 `llm/stream` 归属**：不带 `sessionId` 的手工调用（标题生成、compaction、`llm.stream()` 直调）记成 `null`；Messages 端点自己带的 `x-deepseek-harness-session-id` header 也能用来交叉核对（配 `headerAllow`）。
- **async-iterable body 不抓**：元数据里标 `bodyReason`，不去抽干流。
- **`captureResponse` 的代价**：每个 SSE 字节都会被读一份并留存（Messages 的思考流可达几十上百 KB，其中 98% 以上是重复的 JSON 信封），默认关闭。
- **响应体可能被标 `timedOut`**：读到 `responseReadTimeoutMs` 就按已读内容收尾、不再 cancel 该分支，所以流很长时最后一段可能缺失，文件里会明确标出来而不是假装完整。
- **包装是进程全局的**：与 `dsh-llm-trace` 或 `@deepseek-ai/dsh-experimental-inspector` 同时启用会嵌套包装，同一次请求会被抓两遍（两份文件，互不影响请求本身）。
- **`fetch` 引用被提前缓存的地方抓不到**：`dsh-llm-deepseek` 的 Messages 请求用的是裸 `fetch`（调用时解析），所以覆盖得到；pi-ai 通过 OpenAI/Anthropic SDK 发请求、SDK 走 `globalThis.fetch`，也覆盖得到。`DeepSeekFilesClient` 在构造时就取了 `globalThis.fetch`，那部分（图片上传 `/anthropic/v1/files`）取决于构造时机。

---

## 开发与验证

```sh
node --check lib/core.js            # 语法
node test/core.test.mjs             # 24 个测试：纯函数 + 格式 + 包装层 + 双协议端到端（不联网）
node test/host-smoke.mjs            # 宿主冒烟：假 ctx（严格代理）跑一遍路由/工具/命令 + 卸载残留检查
DSH_CORDIS_DIR=<运行时目录> node test/host-cordis.test.mjs
                                    # 真 cordis 宿主：加载 → 抓取 → 释放 → 再加载一次
node scripts/e2e-live.mjs --protocol messages --response   # 真端点 · Messages
node scripts/e2e-live.mjs --protocol chat                  # 真端点 · Chat Completions
node scripts/e2e-live-turns.mjs                            # 真端点 · 两轮含 tool_use/tool_result
```

前三个不需要任何外部依赖，CI（`.github/workflows/ci.yml`）在 Node 20/22 上跑的就是它们；真端点脚本要密钥，只在本地手动跑。

`test/core.test.mjs` 用注入的假 `target` 与本地 `http` SSE 端点，不动真实 `globalThis.fetch`；`test/host-smoke.mjs` 用一个复刻 cordis 严格代理语义的假 ctx，能在重启宿主之前拦下"没 inject 就访问服务属性"这类加载期错误。

`test/host-cordis.test.mjs` 用 **0.2.0 运行时里真实的 `@deepseek-ai/cordis`（4.0.4）** 加载本插件，真跑 `ctx.effect` / `ctx.inject` / `ctx.on({global:true})` / `llm/stream` 瀑布 / webServer 路由 / 工具 / 命令，并断言：sessionId 归属成立、路由与工具命令在 fiber 释放后被收回、**重载一次仍能干净重来**。它需要一份可加载的 cordis；找不到就跳过，不会让没装 0.2.0 的机器红掉。

`DSH_CORDIS_DIR` 指向的目录，布局就是普通的 node_modules 根：

```
<DSH_CORDIS_DIR>/
  node_modules/@deepseek-ai/cordis/lib/index.js   ← 从 DSH 安装目录的 app.asar 里解出 dsh/node_modules 即可
  node_modules/@deepseek-ai/cosmokit/lib/index.js
  node_modules/@standard-schema/spec/dist/index.js
```

（桌面版把运行时打在 `resources/app.asar` 的 `dsh/node_modules/` 下；注意它的打包方式会在文件头留下 `;\n` / `ap` 之类的拼接残留，直接 JSON.parse `package.json` 会失败，解包后需要清掉再喂给 Node。）

> 注意：`node --test` 在本机沙箱里会因 `spawn EPERM` 失败，直接 `node test/xxx.mjs` 跑即可（这些文件用 `node:test`，自身就是可执行入口）。

### 已验证

| 验证 | 结果 |
| --- | --- |
| `test/core.test.mjs` | 24/24 通过（含 Messages 与 Chat Completions 双协议真 HTTP 端到端） |
| `test/host-smoke.mjs` | 通过；卸载后 路由=0 工具=0 命令=0 |
| `test/host-cordis.test.mjs`（真 cordis 4.0.4） | 通过；加载 5/1/1 → 释放 0/0/0 → 重载后仍能干净装载 |
| `scripts/e2e-live.mjs --protocol messages --response` | HTTP 200；`https://api.deepseek.com/anthropic/v1/messages`；落盘请求体与发送 payload JSON 等值 |
| `scripts/e2e-live.mjs --protocol chat` | HTTP 200；落盘等值 |
| `scripts/e2e-live-turns.mjs`（Messages 两轮） | turn1 `tool_use`、turn2 回传 `tool_result` 后正常收尾；两轮报文均等值落盘 |
| peer 范围 `^0.2.0-rc.1` | 真 semver 实测：`0.2.0-rc.1` ✅ `0.2.0` ✅ `0.2.5` ✅ `0.3.0` ❌ `0.1.5` ❌ |

真端点脚本的密钥取自 `DEEPSEEK_API_KEY` 或 `<DSH_HOME>/.credentials.yaml`，不打印密钥。它们比的是 **JSON 等值**（`JSON.stringify(parse(文件))` 对紧凑 payload）——磁盘上的文件已格式化，原始空白不可考。

---

## 许可

MIT
