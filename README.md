# API Gateway

按模型选择官方厂商、按队列切换账号的轻量 API 网关。支持 GLM、Qwen、Kimi、DeepSeek、MiniMax 等厂商；各厂商独立维护自己的 key 池。

客户端继续使用官方 SDK 或 HTTP 请求，只修改访问 URL。网关读取 `model` 决定路由，替换发往官方的认证 key，保留请求体和响应正文。正常情况下持续使用队首账号；遇到限额或账号故障才换下一个账号。

基于 Node.js 内置模块实现，无第三方运行依赖，支持普通响应、SSE 流式输出、工具调用及厂商自定义参数的原样传递。

## 目录

- [快速开始](#快速开始)
- [支持的厂商](#支持的厂商)
- [调用方式](#调用方式)
- [独立 key 队列](#独立-key-队列)
- [配置与扩展](#配置与扩展)
- [错误响应](#错误响应)
- [部署](#部署)
- [透传边界](#透传边界)
- [测试](#测试)
- [常见问题](#常见问题)
- [项目结构](#项目结构)

## 快速开始

需要 Node.js **22.9+**。无需执行 `npm install`。

```bash
git clone git@github.com:LMDHQ-0420/api-gateway.git
cd api-gateway
npm run init-keys
```

初始化命令根据 `providers.json` 创建各厂商的 key 文件；已有文件会保留，不会覆盖或显示其中的内容。

填写你要使用的厂商 key，一行一个。例如：

```text
keys/glm/keys.txt
keys/qwen/keys.txt
keys/kimi/keys.txt
keys/deepseek/keys.txt
keys/minimax/keys.txt
```

每个文件示例：

```text
# 支持注释和空行
first-account-api-key
second-account-api-key
third-account-api-key
```

支持任意数量的 key；同一池中的重复 key 自动去重。key 作为标准官方 API key 使用，不填写 `Bearer ` 前缀。

```bash
npm start
```

默认监听 `http://127.0.0.1:3000`。未填写 key 的厂商不会阻止其他厂商启动；调用它时返回明确的配置错误。修改 key、模型规则或配置后需要重启服务。

试用 Qwen：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_EXISTING_CLIENT_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

将 `model` 换成 `glm-4.7`、`kimi-k2.5`、`deepseek-chat` 或 `MiniMax-M2.7`，网关自动选择对应厂商的独立池。使用的模型必须由你的官方账号实际开通。

## 支持的厂商

以下是仓库内置的路由配置，可以在 `providers.json` 中调整。

| 厂商 ID | 模型自动匹配规则 | 官方上游基础地址 | key 文件 |
| --- | --- | --- | --- |
| `glm` | `glm-`、`cogview-`、`cogvideo-` | `https://open.bigmodel.cn/api/paas/v4` | `keys/glm/keys.txt` |
| `qwen` | `qwen`、`qwq-`、`qvq-` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `keys/qwen/keys.txt` |
| `kimi` | `kimi-`、`moonshot-` | `https://api.moonshot.cn/v1` | `keys/kimi/keys.txt` |
| `deepseek` | `deepseek-` | `https://api.deepseek.com/v1` | `keys/deepseek/keys.txt` |
| `minimax` | `MiniMax-`、`abab` | `https://api.minimax.cn/v1` | `keys/minimax/keys.txt` |
| `openai` | `gpt-`、`chatgpt-`、`o1`、`o3`、`o4` 等 | `https://api.openai.com/v1` | `keys/openai/keys.txt` |
| `anthropic` | `claude-` | `https://api.anthropic.com/v1` | `keys/anthropic/keys.txt` |
| `gemini` | `gemini-` | `https://generativelanguage.googleapis.com/v1beta/openai` | `keys/gemini/keys.txt` |
| `doubao` | `doubao-`，以及手工配置的接入点 ID | `https://ark.cn-beijing.volces.com/api/v3` | `keys/doubao/keys.txt` |
| `stepfun` | `step-` | `https://api.stepfun.com/v1` | `keys/stepfun/keys.txt` |

模型匹配忽略大小写，发往官方的原始模型名称不会改写。新增同系列模型通常会自动匹配前缀，无需更新程序。

这里的“支持”指路由、认证 key 替换和 HTTP/SSE 透传。**网关不转换不同厂商的请求协议**：Claude 使用官方 Messages 请求结构和 `/v1/messages`；Gemini 在统一 `/v1/chat/completions` 入口使用其官方 OpenAI 兼容协议。不能把 Chat Completions 的请求体直接发给仅支持 Messages 的接口。

Qwen 默认使用中国北京地域按量付费端点，MiniMax 默认使用中国站。其他地域、国际站、Coding Plan 或工作空间专属域名须按相应账号修改配置，不能混用端点和 key。

官方参考：[GLM](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)、[Qwen 地址与地域](https://help.aliyun.com/zh/model-studio/base-url)、[Kimi](https://platform.kimi.com/docs/api/chat)、[DeepSeek](https://api-docs.deepseek.com/)、[MiniMax](https://platform.minimax.cn/docs/api-reference/text-openai-api)、[Claude](https://platform.claude.com/docs/en/api/overview)、[Gemini 兼容接口](https://ai.google.dev/gemini-api/docs/openai)、[豆包地址与认证](https://console.volcengine.com/ark/region%3Acn-beijing/docs/base-url-and-authentication)、[阶跃星辰](https://platform.stepfun.com/)。

## 调用方式

### 1. 统一地址，按 model 自动分流

OpenAI 兼容客户端使用：

```text
http://127.0.0.1:3000/v1
```

前端或调用端选择模型后，把官方模型名填入原来的 `model` 字段即可。不需要新增厂商字段、路由头或特殊请求格式。

以已使用 OpenAI 兼容 SDK 的 Python 项目为例，只改 `base_url`：

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_EXISTING_CLIENT_KEY",
    base_url="http://127.0.0.1:3000/v1",
)

response = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)
```

网关按厂商的 `basePath` 处理统一地址。例如：

```text
/v1/chat/completions + glm-4.7
  → open.bigmodel.cn/api/paas/v4/chat/completions
  → GLM 队列中的当前 key

/v1/chat/completions + qwen-plus
  → dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
  → Qwen 队列中的当前 key

/v1/chat/completions + deepseek-chat
  → api.deepseek.com/v1/chat/completions
  → DeepSeek 队列中的当前 key
```

请求方法、查询字符串和请求体不重写。工具调用、思考参数、多模态字段及未知扩展字段都保留；官方是否接受这些字段由对应官方接口决定。

### 2. 保留官方路径，只更换域名和端口

以下示例直接把官方 origin 替换为本服务：

```text
GLM:
https://open.bigmodel.cn/api/paas/v4/chat/completions
→ http://127.0.0.1:3000/api/paas/v4/chat/completions

GLM Coding Plan:
https://open.bigmodel.cn/api/coding/paas/v4/chat/completions
→ http://127.0.0.1:3000/api/coding/paas/v4/chat/completions

Qwen:
https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
→ http://127.0.0.1:3000/compatible-mode/v1/chat/completions

Kimi:
https://api.moonshot.cn/v1/chat/completions
→ http://127.0.0.1:3000/v1/chat/completions
```

这些原生路径直接透传；已配置的 GLM、Qwen、Gemini 兼容接口和豆包专属路径也能帮助确定厂商。共享的 `/v1` 路径通过 JSON 请求体中的 `model` 区分厂商。

若模型所属厂商与专属路径冲突，例如在 GLM 路径中请求 `qwen-plus`，返回 `provider_path_mismatch`；统一自动分流请使用 `/v1/...`。

### 3. 不带 model 的接口：使用厂商专属 URL

文件、模型列表、异步任务查询等请求可能没有 `model`。此时将 SDK 的基础地址改成带厂商名的 URL，其后的路径完全按官方转发：

```text
Kimi 官方基础地址：https://api.moonshot.cn
网关专属基础地址：http://127.0.0.1:3000/providers/kimi

官方请求：GET /v1/files/file-123/content
网关请求：GET /providers/kimi/v1/files/file-123/content
上游收到：GET /v1/files/file-123/content
```

如果 SDK 的 `base_url` 需要带 `/v1`，填写：

```text
http://127.0.0.1:3000/providers/kimi/v1
```

`/providers/<id>/` 后是完整官方路径，不会再套用 `basePath`。厂商专属 URL 优先决定路由，模型值原样交由该厂商校验。

### 4. 前端模型列表

```bash
curl http://127.0.0.1:3000/v1/models
```

返回 OpenAI 风格的 `{ "object": "list", "data": [...] }`，其中 `owned_by` 为厂商 ID。仅包含已填写 key 且启用的厂商在 `providers.json` 的 `models` 数组中列出的模型，可供前端下拉框使用。

该列表来自本地配置，不查询官方、不验证模型权限或实时可用性。前缀匹配可路由但未列入 `models` 的模型不会出现在列表中；要显示它，请添加到对应厂商的 `models` 数组。想获取某个厂商的官方列表，请使用其专属 URL，例如 `/providers/kimi/v1/models`。

### 5. 流式输出

保持官方的 `stream: true`，例如：

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_EXISTING_CLIENT_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

SSE 内容逐块传递，包括官方事件字段、工具调用片段和结束标记。不会拼接或重新编码输出。

## 独立 key 队列

假设 GLM 池是 `[G1, G2, G3]`，Qwen 池是 `[Q1, Q2]`：

1. 所有 GLM 请求使用 G1，所有 Qwen 请求使用 Q1；请求成功后队列不变。
2. G1 限额或故障时，GLM 队列变为 `[G2, G3, G1]`，同一请求用 G2 重试。
3. Qwen 队列仍是 `[Q1, Q2]`，不会受 GLM 的切换影响。
4. 每个请求最多尝试所属厂商的每个 key 一次；整个池都失败时返回错误。
5. 后续请求重新按照该池的当前队列尝试；已恢复的 key 可以再次使用。

**不做负载均衡，不在成功请求之间轮询，也不会跨厂商兜底或更换模型。**

默认会切换的情况：

| 情况 | 行为 |
| --- | --- |
| HTTP `429` | 视为限额，key 移到队尾并重试 |
| HTTP `402` | 视为余额不足，key 移到队尾并重试 |
| HTTP `401`、`403` | 认证或权限失败，key 移到队尾并重试 |
| HTTP `408`、`5xx` | 请求超时或上游故障，key 移到队尾并重试 |
| 连接失败、等待上游超时 | key 移到队尾并重试 |
| 其他状态，例如 `400`、`404`、`422` | 原样返回，不换 key |

`retryStatuses` 可按厂商调整；`5xx` 和连接故障始终重试。路由依据 HTTP 状态，不把所有业务报错都当作账号限额。

队列保存在单个进程内，重启后恢复为文件顺序。并发请求使用它们开始尝试时的队首；已经发出的请求不会强行改号。同一代 key 的多个并发失败只会移动一次。

## 配置与扩展

### 环境变量

```bash
cp .env.example .env
```

`npm start` 和 `npm run init-keys` 会自动读取 `.env`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；容器中或需要其他机器访问时设置 `0.0.0.0` |
| `PORT` | `3000` | 监听端口 |
| `PROVIDERS_FILE` | `providers.json` | 厂商配置文件；相对当前工作目录解析 |
| `UPSTREAM_TIMEOUT_MS` | `120000` | 每次尝试等待响应头或相邻响应数据的最长时间，毫秒 |
| `MAX_BODY_BYTES` | `33554432` | 请求体上限，默认 32 MiB；大文件可调大 |
| `GATEWAY_TOKEN` | 空 | 可选网关访问口令 |
| `KEYS_FILE` | `keys.txt` | 旧版 GLM 文件，专属 GLM 文件为空时才回退读取 |
| `UPSTREAM_ORIGIN` | 未设置 | 可选，仅覆盖 GLM 厂商的 `origin` |

`keysFile` 相对 **providers.json 所在目录**解析。不同厂商或不同地域的 key 应放入对应的池，不要混合填写。

### 厂商配置字段

| 字段 | 说明 |
| --- | --- |
| `id` | 唯一厂商 ID，用于专属 URL 和错误定位 |
| `origin` | 官方 origin，仅含协议、主机及可选端口，不带路径或凭据 |
| `basePath` | 把统一 `/v1/...` 映射到此官方基础路径 |
| `keysFile` | 此厂商的 key 文件路径 |
| `modelPrefixes` | 模型名前缀匹配，忽略大小写 |
| `models` | 精确匹配的模型名，同时用于 `/v1/models` 下拉列表 |
| `nativePrefixes` | 能确定此厂商的完整官方路径前缀，匹配后保持原路径 |
| `auth` | `bearer`（默认）或 `x-api-key` |
| `headers` | 默认上游请求头，例如 Claude 的 `anthropic-version`；客户端已提供时保留客户端值 |
| `retryStatuses` | 除始终重试的 `5xx` 外，允许切换 key 的错误状态，默认 `[401,402,403,408,429]` |
| `enabled` | 默认 `true`；设为 `false` 后不加载、不路由此厂商 |

匹配优先级：厂商专属 URL → 模型精确匹配 → 最长模型前缀匹配。专属官方路径用于辅助定位；模型与路径指向不同厂商时拒绝请求。多个厂商在同一优先级匹配时返回冲突提示，不随意选择一个厂商。

### 新增厂商

在 `providers.json` 的 `providers` 数组中增加一项，例如某个兼容 OpenAI 的官方服务：

```json
{
  "id": "newvendor",
  "origin": "https://api.example.com",
  "basePath": "/v1",
  "keysFile": "keys/newvendor/keys.txt",
  "modelPrefixes": ["newvendor-"],
  "models": ["newvendor-chat"]
}
```

将示例地址替换为真实官方地址，执行 `npm run init-keys`，填写新文件并重启。新增厂商通常不需要改代码。未使用 Bearer 或 `x-api-key`、需要请求签名或其他认证协议的厂商需要另行适配。

豆包等使用 `ep-...` 接入点 ID 时，将完整 ID 加入对应厂商的 `models`，网关会精确路由，传给官方的 ID 不变。`modelPrefixes` 仅匹配前缀，不是正则表达式。

如要通过百炼调用其托管的 DeepSeek，而非 DeepSeek 官方，请在 Qwen 池的 `models` 中精确列出该模型名，让精确匹配覆盖默认前缀。默认配置始终将 `deepseek-` 发往 DeepSeek 官方。

### 访问口令与 key 文件

默认本机运行时，客户端可以保留原来的认证参数；网关不会把它作为上游 key。设置 `GATEWAY_TOKEN` 后，客户端使用标准请求头：

```text
Authorization: Bearer YOUR_GATEWAY_TOKEN
```

Claude 官方 SDK 使用 `x-api-key: YOUR_GATEWAY_TOKEN` 也可验证网关口令。发往官方时替换为选定 key 的对应认证方式。

以下文件均不进入 Git：

```text
keys.txt
keys/**/keys.txt
*_keys.txt
.env
.env.*（保留 .env.example）
```

根目录旧的 `glm_keys.txt`、`qwen_keys.txt` 也在忽略范围。日志仅包含厂商 ID、key 索引和状态，不显示完整 key、请求正文或官方错误正文。使用自定义 `keysFile` 路径时，也请将新路径加入 `.gitignore`。

## 错误响应

网关自身错误使用统一包装：

```json
{
  "error": {
    "code": "all_keys_unavailable",
    "message": "当前厂商的所有 API key 均已限额或不可用，请稍后重试，或检查账号额度及 key 状态。",
    "provider": "qwen",
    "attempts": 2,
    "failures": [
      {"key_index": 1, "status": 429},
      {"key_index": 2, "status": 429}
    ]
  }
}
```

`key_index` 为该池去重后的原始顺序，从 1 开始；不是完整 key。网络故障的 `reason` 为 `network_error` 或 `timeout`。

| HTTP 状态 | code | 含义 |
| --- | --- | --- |
| `400` | `unknown_model` | 无法确定模型厂商，需要配置模型规则 |
| `400` | `provider_required` | 共享路径没有可用于路由的 `model`，请使用专属 URL |
| `400` | `invalid_json` / `invalid_model` | 自动路由请求不是有效 JSON，或 model 不是非空字符串 |
| `400` | `ambiguous_model` / `ambiguous_path` | 多个厂商规则冲突 |
| `400` | `provider_path_mismatch` | 模型与官方专属路径所属厂商不一致 |
| `401` | `gateway_unauthorized` | 网关口令不正确 |
| `404` | `unknown_provider` | 厂商专属 URL 中的厂商不存在或已禁用 |
| `413` | `request_too_large` | 请求体超过网关配置上限 |
| `429` | `all_keys_unavailable` | 该池所有 key 均返回限额或余额不足状态 |
| `503` | `all_keys_unavailable` | 该池全部尝试失败，包含认证、网络或服务故障 |
| `503` | `provider_not_configured` | 已识别厂商，但没有加载可用 key |

未触发换号的官方响应（例如参数错误）保留官方状态、正文和格式，不改造成网关错误结构。SDK 自带重试可能再次发送整个客户端请求，必要时在客户端调整其重试配置。

## 部署

### 本地或服务器

```bash
npm run init-keys
# 填写对应 key 文件
npm start
```

服务收到 `SIGINT` / `SIGTERM` 后停止接收新连接，最多等待 10 秒，再关闭剩余连接。

### Docker

先准备宿主机的 `keys` 目录和文件；容器读取挂载文件，镜像不会包含 key 或 `.env`。

```bash
docker build -t api-gateway .
docker run -d --name api-gateway --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --mount type=bind,src="$PWD/keys",dst=/app/keys,readonly \
  --mount type=bind,src="$PWD/providers.json",dst=/app/providers.json,readonly \
  api-gateway
```

如使用环境文件，增加 `--env-file .env`。Docker 镜像默认监听 `0.0.0.0`；若 `.env` 中配置了 `HOST=127.0.0.1`，请在容器启动参数中再增加 `-e HOST=0.0.0.0`。容器以 `node` 用户运行，宿主机文件需允许该用户读取；必要时用 `--user "$(id -u):$(id -g)"` 指定本机 UID/GID。

### Nginx 反向代理

SSE 需要关闭响应缓冲，例如在已有的 HTTPS server 中添加：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 3600s;
    client_max_body_size 32m;
}
```

外部访问时配置 HTTPS 和适当的网关访问限制。建议让浏览器通过你自己的后端调用，或通过同源反向代理访问；本服务没有额外注入跨域 CORS 策略。公开前端不应包含厂商真实 key。

**运行一个实例维护统一队列。** 多进程或多个容器的队列相互独立，本项目尚未实现 Redis 等共享队列。

## 透传边界

- 只做路由、路径映射和认证替换，不改写请求 JSON、模型名或返回正文，不转换厂商协议。
- 自动模型路由读取未压缩的 JSON 请求体；二进制上传或无法从请求体判断厂商的接口请使用厂商专属 URL。
- HTTP 逐跳头由代理重建，客户端其他格式的认证 key 和官方会话 cookie 不会跨账号传递。
- 响应按原始字节流转发，压缩响应不会被意外解压或重新编码。
- 请求体先在内存中暂存，以便切换 key 时原样重试；并发大文件会占用相应内存。
- SSE 一旦已经发送响应头或内容，中途异常就结束连接，并让后续请求使用更新后的队列；不能透明重放或拼接已经输出的内容。官方流内业务错误、`finish_reason` 等字段保持原样。
- 不解析 HTTP `200` 中的厂商业务错误。若某个原生接口把余额或限额写在成功状态正文里，该正文会直接透传；该类接口需要额外的业务错误适配才能自动换号。
- 连接断开或 `5xx` 时官方可能已经处理请求；自动重试不能保证不重复计费或不重复创建资源。
- 文件、异步任务、会话等属于特定官方账号。切换账号后不能保证访问原账号的资源；专属厂商 URL 只固定厂商，不绑定具体账号。
- 仅提供 HTTP/SSE 代理，不提供 WebSocket、实时语音协议转换或签名认证转换。
- 单次请求会在全部 key 都不可用时停止；不会等待配额恢复，也不会依照 `Retry-After` 阻塞整个队列。

## 测试

```bash
npm test
```

使用 Node.js 内置测试框架和本地模拟官方服务，不需要真实 key，不调用付费接口。覆盖：

- 成功后固定使用队首、失败移到队尾、遍历一轮后停止。
- GLM、Qwen、Kimi、DeepSeek、MiniMax 等内置模型路由。
- 厂商队列互相独立，并发请求不变成负载均衡。
- key 认证失败、余额不足、限额、连接失败与超时。
- 原始请求体重试、查询字符串、厂商路径、multipart 上传。
- SSE 增量透传、中断处理和压缩响应。
- Claude 认证替换、模型列表、未知模型、空池和配置冲突。
- key 文件读取、去重及旧版 GLM 文件回退。

GitHub Actions 在 Node.js 22 和 24 上运行测试。模拟测试不代表已验证你的真实账号、模型权限、地域和套餐配置。

## 常见问题

**填写 key 后为什么仍提示未配置？**

检查是否放进对应厂商的 `keysFile`，确认 `PROVIDERS_FILE` 指向正确配置，并重启服务。Docker 场景检查挂载和读取权限。启动日志会显示各池加载数量，不会显示内容。

**为什么一个厂商的全部 key 失败，不继续用其他厂商？**

模型通常归属于指定官方服务，用户选择的模型和请求协议不能随意替换。当前行为是报告该厂商池不可用，其他厂商池继续独立服务。

**旧版根目录 keys.txt 还能用吗？**

可以。只有 GLM 专属文件为空或不存在时才读取它；其他厂商不使用这个文件。推荐逐步迁移至 `keys/<厂商>/keys.txt`。

**为什么 GLM Coding Plan 在统一 /v1 路径下没有使用套餐地址？**

默认 GLM `basePath` 是普通 API 地址。使用 Coding Plan 时按官方修改为 `/api/coding/paas/v4`，或直接使用原生 `/api/coding/paas/v4/...` 路径，避免调用到不符合账号套餐的接口。

**为什么前端模型下拉框为空？**

`/v1/models` 只显示已加载 key 的池中显式配置的 `models`。填写 key、配置需要显示的官方模型名，并重启。

**接口参数、工具调用和思考内容会被过滤吗？**

不会。网关只读取 JSON 中的 `model` 做路由，其余请求体和响应体按字节传递。字段能否使用以及具体格式，以对应官方协议为准。

**如何新增不同地域或多个同厂商池？**

可以新增不同 `id` 的厂商配置，各自设置端点和 key 文件。模型规则重复时使用 `/providers/<id>/` 专属地址区分，或设置互不冲突的精确模型规则。

## 项目结构

```text
api-gateway/
├── server.mjs                 # HTTP 代理、独立 key 队列与重试
├── routing.mjs                # 配置加载、模型匹配与路径路由
├── providers.json             # 官方厂商及模型规则，不含 key
├── keys/                      # 本地私密 key，Git 忽略
│   ├── glm/keys.txt
│   ├── qwen/keys.txt
│   └── ...
├── scripts/init-keys.mjs       # 安全创建 key 文件，保留已有文件
├── test/                      # 模拟上游集成测试及路由测试
├── .github/workflows/test.yml # CI
├── .env.example               # 环境配置模板
├── Dockerfile
├── .dockerignore              # 镜像只复制必要源码和公开配置
└── package.json
```
