<h1 align="center">API Gateway</h1>

<p align="center">Model-based routing. Independent key queues. Transparent streaming.</p>
<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

A lightweight gateway that routes requests to official model providers. Each provider has its own API key queue: keep using the current key until a quota or account failure occurs, then move it to the back and retry the next key.

## Features

- Built-in routing for GLM, Qwen, Kimi, DeepSeek, MiniMax, OpenAI, Claude, Gemini, Doubao and StepFun.
- Independent, ordered key pools with bounded retries; no load balancing or cross-provider fallback.
- Live model discovery from configured official APIs, with failed providers reported separately.
- Original request bodies, model names, tool calls and SSE response bytes preserved.
- Standard SDKs and HTTP clients supported by changing the base URL.
- Node.js built-in modules only; no third-party runtime dependencies.

## Quick start

Requires **Node.js 22.9+**.

```bash
git clone git@github.com:LMDHQ-0420/api-gateway.git
cd api-gateway
npm run init-keys
```

Add official API keys to `keys/<provider>/keys.txt`, one key per line. For example, use `keys/glm/keys.txt` and `keys/qwen/keys.txt`. Blank lines and `#` comments are allowed; duplicates are removed. Initialization preserves existing files.

```bash
npm start
```

The gateway listens on `http://127.0.0.1:3000`. Restart after changing keys or configuration. Providers without keys do not prevent startup.

## Usage

Set your OpenAI-compatible client's base URL to `http://127.0.0.1:3000/v1`. The request's `model` selects the official provider and its key pool.

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_CLIENT_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

Change `model` to select another provider. Set `stream: true` for SSE; use `curl -N` to display it immediately. Without `GATEWAY_TOKEN`, your existing client key can stay unchanged; upstream authentication always uses the selected pool key.

| Endpoint | Behavior |
| --- | --- |
| `/v1/chat/completions` | Route by `model`, map to the provider's official base path |
| `/v1/models` | Query official model lists for enabled providers with loaded keys |
| `/api/paas/v4/...` | Preserve GLM's official path |
| `/api/coding/paas/v4/...` | Preserve GLM's Coding Plan path |
| `/providers/<id>/<official-path>` | Select a provider explicitly; useful for requests without `model` |

For example, `/providers/kimi/v1/files` forwards to Kimi's `/v1/files`.

`GET /v1/models` queries official APIs in parallel on every request and returns a deduplicated OpenAI-style list. Each entry's `owned_by` identifies its provider. Failed or unsupported providers are excluded from `data` and reported in an optional `errors` array; if all queries fail, the endpoint returns `429` or `503`. No static example models are substituted. Newly discovered IDs are registered for routing, even without a matching prefix.

Discovery uses the same key queues as inference. A successful catalog request does not guarantee quota or access for every listed model. Provider-specific list URLs still return the original official response.

**Protocols stay provider-native.** Claude uses `/v1/messages` and the official Messages body. Gemini uses its official OpenAI-compatible endpoint. The gateway does not convert Chat Completions, Messages or other protocols.

## Key queues

```text
GLM:  [A, B, C] → A succeeds → [A, B, C]
GLM:  [A, B, C] → A fails    → [B, C, A] → retry with B
Qwen: [X, Y]   → unaffected
```

HTTP `401`, `402`, `403`, `408`, `429`, `5xx`, connection failures and timeouts trigger rotation. Other responses pass through unchanged. Each request tries each key in its selected pool at most once.

If the pool is exhausted, the gateway returns `error.code: "all_keys_unavailable"`, the provider ID and per-key failure indices. The status is `429` when every failure is quota/balance-related, otherwise `503`. Full keys are never included.

## Configuration

Copy `.env.example` to `.env` for optional overrides:

| Variable | Default |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` |
| `PROVIDERS_FILE` | `providers.json` |
| `GATEWAY_TOKEN` | Empty; optional client access token |
| `UPSTREAM_TIMEOUT_MS` | `120000` per upstream inactivity interval |
| `MODELS_TIMEOUT_MS` | `10000` total discovery time per provider |
| `MAX_BODY_BYTES` | `33554432` (32 MiB) |

Edit [providers.json](providers.json) to change official endpoints, regions or model rules. Each entry defines `id`, `origin`, `basePath`, `keysFile`, `modelPrefixes` and `models`. Key paths are relative to the configuration file. Configured exact model matches take priority, followed by discovered IDs, then the longest prefix. Use `models` for explicit routing overrides, including Doubao endpoint IDs such as `ep-...`; this does not add entries to the live catalog. Duplicate discovered IDs prefer an explicit mapping, then the provider's model prefix, then configuration order.

Additional options include `modelsPath` (defaults to `<basePath>/models`), `enabled`, `nativePrefixes`, `auth` (`bearer` or `x-api-key`), default `headers` and `retryStatuses`. Add another entry and run `npm run init-keys` to create a new provider pool. Match the official endpoint to your key's region and plan. For GLM Coding Plan on the unified route, change GLM's `basePath` accordingly.

With `GATEWAY_TOKEN` enabled, clients use `Authorization: Bearer <token>` or Claude's `x-api-key`. Key files and `.env` are Git-ignored; add custom key-file locations to `.gitignore` too. Legacy root `keys.txt` remains a GLM fallback when its dedicated file is empty.

## Docker

Prepare your local `keys/` files first, then run:

```bash
docker build -t api-gateway .
docker run -d --name api-gateway --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --mount type=bind,src="$PWD/keys",dst=/app/keys,readonly \
  --mount type=bind,src="$PWD/providers.json",dst=/app/providers.json,readonly \
  api-gateway
```

The image excludes keys and `.env`. Ensure mounted files are readable by the container user; set `--user "$(id -u):$(id -g)"` if needed. When using `--env-file .env`, keep `HOST=0.0.0.0` inside the container. Disable reverse-proxy buffering for SSE. Browser access requires a same-origin proxy or your own CORS policy.

## Limits

Queues are in memory and independent per process; run one instance for a shared ordering. Requests are buffered for retries, while responses stream directly. Streams cannot be replayed after output starts, and retries may duplicate upstream work. Account-owned files and tasks are not bound to their originating key. HTTP `200` business errors are passed through without rotation. Automatic model detection expects uncompressed JSON; use provider-specific URLs for uploads. HTTP/SSE only; no WebSocket or protocol conversion.

## Tests

```bash
npm test
```

Tests use local mock providers and require no real keys or paid API calls.
