<h1 align="center">API Gateway</h1>

<p align="center">按模型路由 · 独立 key 队列 · 流式透传</p>
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

轻量级多模型 API 网关，将请求分流到模型对应的官方服务。每个厂商维护独立的 key 队列：持续使用当前 key，遇到限额或账号故障后移到队尾，自动尝试下一个。

## 特性

- 内置 GLM、Qwen、Kimi、DeepSeek、MiniMax、OpenAI、Claude、Gemini、豆包和阶跃星辰路由。
- 各厂商独立按队列切换，重试有界，不做负载均衡或跨厂商兜底。
- 实时查询已配置官方 API 的模型列表，单独报告查询失败的厂商。
- 保留原始请求体、模型名、工具调用和 SSE 响应字节。
- 标准 SDK 和 HTTP 客户端修改基础 URL 即可接入。
- 仅使用 Node.js 内置模块，无第三方运行依赖。

## 快速开始

需要 **Node.js 22.9+**。

```bash
git clone git@github.com:LMDHQ-0420/api-gateway.git
cd api-gateway
npm run init-keys
```

将官方 API key 填入 `keys/<厂商>/keys.txt`，每行一个。例如 `keys/glm/keys.txt`、`keys/qwen/keys.txt`。支持空行和 `#` 注释，重复 key 自动去重。初始化不会覆盖已有文件。

```bash
npm start
```

默认监听 `http://127.0.0.1:3000`。修改 key 或配置后需要重启；未填写 key 的厂商不影响其他厂商启动。

## 调用

将 OpenAI 兼容客户端的基础 URL 改为 `http://127.0.0.1:3000/v1`，请求中的 `model` 自动决定官方厂商和 key 池。

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_CLIENT_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

切换 `model` 即选择其他厂商；设置 `stream: true` 使用 SSE，配合 `curl -N` 实时显示。未设置 `GATEWAY_TOKEN` 时，客户端可保留原来的 key 参数；发往官方的认证始终使用池中选定的 key。

| 接口 | 行为 |
| --- | --- |
| `/v1/chat/completions` | 根据 `model` 分流并映射官方基础路径 |
| `/v1/models` | 实时查询已启用且加载 key 的官方模型列表 |
| `/api/paas/v4/...` | 保留 GLM 官方路径 |
| `/api/coding/paas/v4/...` | 保留 GLM Coding Plan 路径 |
| `/providers/<id>/<官方路径>` | 显式选择厂商，适用于不带 `model` 的接口 |

例如 `/providers/kimi/v1/files` 转发到 Kimi 的 `/v1/files`。

`GET /v1/models` 每次并行查询官方接口，去重后返回 OpenAI 风格的列表，`owned_by` 标识来源厂商。失败或不支持列表接口的厂商不进入 `data`，会在可选的 `errors` 数组中说明；全部查询失败时返回 `429` 或 `503`。不会用配置中的示例模型补充结果。新发现的模型 ID 会自动注册路由，无需已有前缀。

查询列表与模型调用共用各厂商的 key 队列。列表查询成功不代表每个模型当前都有额度或调用权限；厂商专属列表 URL 仍原样返回官方响应。

**请求协议保持官方格式。** Claude 使用 `/v1/messages` 和官方 Messages 请求体；Gemini 使用其官方 OpenAI 兼容接口。网关不转换 Chat Completions、Messages 等协议。

## key 队列

```text
GLM:  [A, B, C] → A 成功 → [A, B, C]
GLM:  [A, B, C] → A 失败 → [B, C, A] → 使用 B 重试
Qwen: [X, Y]   → 不受影响
```

HTTP `401`、`402`、`403`、`408`、`429`、`5xx`，以及连接失败和超时会触发换号；其他响应原样返回。每个请求最多尝试所属池的每个 key 一次。

全部失败时返回 `error.code: "all_keys_unavailable"`，附带厂商 ID 和失败 key 索引。全部为限额或余额不足时返回 `429`，其余情况返回 `503`，不会包含完整 key。

## 配置

复制 `.env.example` 为 `.env`，按需调整：

| 变量 | 默认值 |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` |
| `PROVIDERS_FILE` | `providers.json` |
| `GATEWAY_TOKEN` | 空，可选网关访问口令 |
| `UPSTREAM_TIMEOUT_MS` | `120000`，每次等待上游数据的超时毫秒数 |
| `MODELS_TIMEOUT_MS` | `10000`，每个厂商查询列表的总超时毫秒数 |
| `MAX_BODY_BYTES` | `33554432`，即 32 MiB |

编辑 [providers.json](providers.json) 调整官方地址、地域和模型规则。每个厂商配置包含 `id`、`origin`、`basePath`、`keysFile`、`modelPrefixes` 和 `models`。key 路径相对配置文件解析；配置中的精确模型匹配优先，其次是已发现的模型 ID，最后取最长前缀。`models` 用于显式指定模型路由，包括豆包 `ep-...` 接入点 ID，不会直接添加到实时列表。多个厂商返回相同模型 ID 时，依次按显式映射、所属模型前缀、配置顺序选择来源。

其他选项包括 `modelsPath`（默认 `<basePath>/models`）、`enabled`、`nativePrefixes`、`auth`（`bearer` 或 `x-api-key`）、默认 `headers` 和 `retryStatuses`。新增厂商条目后运行 `npm run init-keys` 即可创建新池。官方地址需与 key 的地域和套餐匹配；统一入口使用 GLM Coding Plan 时，需相应修改 GLM 的 `basePath`。

启用 `GATEWAY_TOKEN` 后，客户端使用 `Authorization: Bearer <口令>` 或 Claude 的 `x-api-key`。key 文件和 `.env` 已加入 Git 忽略规则，自定义 key 文件位置也应加入 `.gitignore`。旧版根目录 `keys.txt` 仅在 GLM 专属文件为空时作为回退。

## Docker

先准备本地 `keys/` 文件，再运行：

```bash
docker build -t api-gateway .
docker run -d --name api-gateway --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --mount type=bind,src="$PWD/keys",dst=/app/keys,readonly \
  --mount type=bind,src="$PWD/providers.json",dst=/app/providers.json,readonly \
  api-gateway
```

镜像不包含 key 和 `.env`。挂载文件需允许容器用户读取，必要时指定 `--user "$(id -u):$(id -g)"`。使用 `--env-file .env` 时，容器内保持 `HOST=0.0.0.0`。SSE 反向代理需关闭响应缓冲；浏览器调用需配置同源代理或自行设置 CORS。

## 使用边界

队列保存在内存中，各进程独立；统一顺序请运行单实例。请求体暂存以支持重试，响应直接流式传递。已开始输出的流无法重放，重试可能导致上游重复处理。文件和任务等账号资源不会绑定原 key。HTTP `200` 中的业务错误直接透传，不触发换号。自动模型识别需要未压缩的 JSON，上传接口请使用厂商专属 URL。仅支持 HTTP/SSE，不提供 WebSocket 或协议转换。

## 测试

```bash
npm test
```

测试使用本地模拟厂商，不需要真实 key，不调用付费接口。
