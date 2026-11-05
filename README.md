<h1 align="center">API Gateway</h1>

<p align="center">Model-based routing · Independent key pools · Concurrent transparent streaming</p>
<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

A lightweight gateway for official model APIs. Change the base URL, keep the official request format, and let each provider's ordered key pool handle failures and cooldowns.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Client usage](#client-usage)
- [Routing decisions](#routing-decisions)
- [Complete request lifecycle](#complete-request-lifecycle)
- [FIFO and concurrent traffic](#fifo-and-concurrent-traffic)
- [Retries, cooldowns and recovery](#retries-cooldowns-and-recovery)
- [Live model discovery](#live-model-discovery)
- [Streaming and timeouts](#streaming-and-timeouts)
- [Logs and latency metrics](#logs-and-latency-metrics)
- [Configuration](#configuration)
- [Deployment and network access](#deployment-and-network-access)
- [Optional physical-interface egress](#optional-physical-interface-egress)
- [Limits and troubleshooting](#limits-and-troubleshooting)
- [Tests](#tests)

## Features

- Model routing for GLM, Qwen, Kimi, DeepSeek, MiniMax, OpenAI, Anthropic, Gemini, Doubao and StepFun.
- Independent FIFO key pools: keep using the first eligible key; rotate on failure. No load balancing or cross-provider fallback.
- Concurrent forwarding without a fixed per-key cap or a central waiting queue.
- OpenAI and Anthropic Messages requests routed to provider-native endpoints; bodies, model names, tool calls and SSE bytes preserved.
- Live official model discovery; scoped cooldowns and controlled recovery using real requests.
- Metadata-only JSON logs and keep-alive connections. Node.js built-ins only; the optional Linux egress helper uses Python 3's standard library.

## Quick start

Requires **Node.js 22.21+**; on Node.js 24, use **24.5+** for native proxy support.

```bash
git clone git@github.com:LMDHQ-0420/api-gateway.git
cd api-gateway
npm run init-keys
```

Add keys to the relevant files, one key per line. Initialization preserves existing files. Blank lines and `#` comments are ignored; duplicates are removed within each pool.

```text
keys/
├── glm/keys.txt
├── qwen/keys.txt
├── kimi/keys.txt
└── <provider>/keys.txt
```

```bash
npm start
```

Default address: `http://127.0.0.1:3000`. Optional overrides go in `.env`, copied from `.env.example`. Missing or empty key files leave that provider unconfigured without blocking others, except for the optional legacy GLM fallback. Restart after changing keys or configuration. `keys/`, `.env` and legacy key files are Git-ignored; custom private config/key locations also need an ignore rule.

## Architecture

```mermaid
flowchart TB
    C["Downstream clients<br/>SDK / Claude Code / HTTP"] --> I
    subgraph CFG["Startup configuration"]
        F["providers.json / .env"] --> B["Validate providers<br/>Read and deduplicate keys"]
        K["keys/provider/keys.txt"] --> B
    end
    subgraph GW["API Gateway - one Node.js process"]
        I["Request ID + metadata logs<br/>Optional gateway authentication"] --> BODY["Buffer request body<br/>Enforce size limit; inspect model once"]
        BODY --> TYPE{"Request endpoint?"}
        TYPE -->|GET /v1/models| D["Parallel model discovery<br/>models.mjs"]
        TYPE -->|Other endpoints| R["Select exactly one provider<br/>Map native protocol path"]
        B -.->|Routing rules| R
        R -->|GLM selected| G["GLM FIFO key pool<br/>A → B → C"]
        R -->|Qwen selected| Q["Qwen FIFO key pool<br/>X → Y"]
        R -->|Another provider selected| O["Kimi / DeepSeek / others<br/>Independent FIFO per provider"]
        B --> G
        B --> Q
        B --> O
        G --> A["Pick first eligible unseen key<br/>Track active requests; bounded retries<br/>Single-flight soft recovery if eligible"]
        Q --> A
        O --> A
        A --> T["Replace credentials; keep body bytes<br/>HTTP/HTTPS keep-alive agents<br/>Per-attempt timeout"]
        A -->|No candidate| E["429 or 503<br/>Retry-After when all keys cool"]
        P["Forward headers and raw body/SSE<br/>Backpressure + cancellation<br/>No replay after headers are sent"] --> C
        E --> C
        D --> J["Normalize + deduplicate catalogs<br/>Publish discovered routing IDs"] --> C
        I -.-> L["JSON metadata logs<br/>No keys, headers or payloads"]
        A -.-> L
        P -.-> L
    end
    T --> NET{"Configured network path"}
    NET -->|System route| U["Selected official provider<br/>Only that provider receives the request"]
    NET -->|Optional local relay| H["Loopback CONNECT relay<br/>DNS + TCP pinned to physical NIC<br/>TLS stays end-to-end"] --> U
    U -->|Normal non-retry response| P
    U -->|Normal retryable error before headers| A
    D -.->|Same queue| G
    D -.->|Same queue| Q
    D -.->|Same queue| O
    D -.->|Official catalog calls| T
    U -.->|Catalog response| D
```

Solid arrows show the main request/control flow; dotted arrows show configuration, shared state, metadata or helper calls. The provider branches are alternatives: **one normal request selects exactly one provider**. Catalog discovery is the separate, explicitly parallel path.

| Component | Responsibility |
| --- | --- |
| [server.mjs](server.mjs) | Ingress/auth, body buffering, key queues, transport, retry loop, streaming and cancellation |
| [routing.mjs](routing.mjs) | Provider validation/loading, model inspection, provider selection and native path mapping |
| [attempts.mjs](attempts.mjs) | In-flight tracking and single-flight recovery; ordinary calls are neither capped nor queued |
| [retry.mjs](retry.mjs) | Bounded GLM error inspection, official-code classification and reset/Retry-After parsing |
| [models.mjs](models.mjs) | Parallel official catalog queries, pagination, deduplication and discovered routing snapshots |
| [transport.mjs](transport.mjs) | Dedicated HTTP/HTTPS keep-alive agents and explicit optional egress |
| [observe.mjs](observe.mjs) | Raw-byte response observer; first-byte/content timing without payload logs |
| [scripts/direct-egress.py](scripts/direct-egress.py) | Optional Linux physical-interface DNS/TCP relay; no TLS decryption or key access |

## Client usage

For an OpenAI-compatible client, set `base_url` to `http://127.0.0.1:3000/v1`. Keep the official request format and choose a real provider model ID:

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_CLIENT_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

Without `GATEWAY_TOKEN`, clients may keep their existing key parameter. With it enabled, use that gateway token via `Authorization: Bearer <token>` or Claude-compatible `x-api-key`. The gateway always replaces upstream credentials with the selected official pool key, and strips client cookies and alternate authentication headers. Transparency covers payloads and native protocol behavior, not authentication, hop-by-hop headers, aggregate catalogs or gateway-generated errors.

| Endpoint | Behavior |
| --- | --- |
| `/v1/chat/completions` | OpenAI-format request; select provider by model |
| `/v1/messages` | Claude Code / Anthropic request; map to official Messages path |
| `/v1/messages/count_tokens` | Official counting endpoint, if supported by the selected provider |
| `GET /v1/models` | Aggregate live official catalogs; see the discovery flow |
| `/api/paas/v4/...`, `/api/coding/paas/v4/...` | Recognize GLM native paths |
| `/providers/<id>/<official-path>` | Explicit provider selection, including requests without model |

For example, `/providers/kimi/v1/files` forwards to Kimi's `/v1/files`. Scoped URLs also support binary/multipart payloads within `MAX_BODY_BYTES`; they do not require model inference. Other endpoints are passed to the configured official service and must be supported there.

### Claude Code

Use the gateway origin **without appending `/v1`**:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_AUTH_TOKEN=gateway
export ANTHROPIC_MODEL=glm-5.3
export ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3
export ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.3
export ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.3
claude
```

Replace `gateway` with `GATEWAY_TOKEN` when enabled. Model IDs in examples are request examples, not access or quota guarantees; select IDs supported by your account/endpoint. The gateway does not rename Claude aliases. An explicit base URL such as `http://127.0.0.1:3000/providers/glm` also works.

| Provider | Configured Messages prefix |
| --- | --- |
| GLM | `/api/anthropic/v1` |
| Qwen | `/apps/anthropic/v1` |
| Kimi API / DeepSeek / MiniMax | `/anthropic/v1` |
| Anthropic / StepFun | `/v1` |
| Doubao | `/api/compatible/v1` |

These paths come from [providers.json](providers.json). Match origins and paths to your region and plan; a subscription key may require a different endpoint. Kimi Code needs its own compatible origin/path configuration. Providers without `messagesBasePath`, such as the shipped OpenAI/Gemini entries, return `501 unsupported_protocol` for Messages. There is no OpenAI-to-Anthropic body conversion; catalog-listed image/audio models are not automatically usable with Claude Code.

## Routing decisions

```mermaid
flowchart TD
    S["Buffered request + URL"] --> X{"Explicit /providers/id/path URL?"}
    X -->|Yes| P["Select enabled provider by id<br/>No model inference required<br/>Unknown provider → 404"]
    X -->|No| N["Identify unique native path match<br/>Conflicting paths → 400"]
    N --> V{"Unscoped JSON and model valid?"}
    V -->|No| BAD["400 invalid_json / invalid_model"]
    V -->|Yes| M["Resolve model in this priority order"]
    M --> E{"Configured exact model match?"}
    E -->|Yes| CH["One matching provider<br/>Ambiguous match → 400"]
    E -->|No| D{"Match a discovered model ID?"}
    D -->|Yes| CH
    D -->|No| F{"Match the longest model prefix?"}
    F -->|Yes| CH
    F -->|No| NF{"Native path selects a provider?"}
    NF -->|Yes| CH
    NF -->|No| ERR["400 unknown_model / provider_required"]
    CH --> C{"Native path and model agree?"}
    C -->|No| MIS["400 provider_path_mismatch"]
    C -->|Yes| MAP["OpenAI: basePath<br/>Messages: messagesBasePath<br/>Preserve native path and query"]
    P --> MAP
    MAP --> PROTO{"Requested protocol configured?"}
    PROTO -->|Yes| END["Use only this provider key pool"]
    PROTO -->|No| UNSUP["501 unsupported_protocol"]
```

Exact model IDs take priority over discovered IDs, then the longest configured prefix. Conflicting matches fail instead of silently selecting a provider. Native path/model mismatches fail; explicit provider URLs deliberately pin the provider. Queries and body model names are preserved. A configured model is a routing rule, not a fabricated `/v1/models` entry or a declaration of current availability.

## Complete request lifecycle

```mermaid
flowchart TD
    S["Normal provider request<br/>GET /v1/models follows its own flow"] --> AUTH{"Gateway token accepted or disabled?"}
    AUTH -->|No| UNAUTH["401 gateway_unauthorized"]
    AUTH -->|Yes| READ["Validate URL; buffer original bytes<br/>Attach client-cancellation signal"]
    READ --> SIZE{"Within MAX_BODY_BYTES?"}
    SIZE -->|No| LARGE["413 request_too_large"]
    SIZE -->|Yes| ROUTE["Resolve provider and protocol path<br/>Routing errors return immediately"]
    ROUTE --> POOL{"Provider has loaded keys?"}
    POOL -->|No| EMPTY["503 provider_not_configured"]
    POOL -->|Yes| PICK["Skip seen and cooling keys<br/>Else consider one eligible soft recovery"]
    PICK --> FOUND{"Candidate available?"}
    FOUND -->|No| EXHAUST["all_keys_unavailable<br/>429 for capacity; 503 for other failures<br/>No sleep or central waiting queue"]
    FOUND -->|Yes| SEND["Mark key seen; record in-flight count<br/>Send unchanged body using pool credentials"]
    SEND --> HEAD{"Headers arrive before transport failure?"}
    HEAD -->|No| FAIL["Record network/timeout failure<br/>or classify retryable HTTP error"]
    HEAD -->|Yes| RETRY{"Configured retry status or 5xx?"}
    RETRY -->|Yes| FAIL
    FAIL --> ROTATE["Move key to tail once per version<br/>Apply cooldown when applicable<br/>Release this attempt; keep other calls alive"] --> PICK
    RETRY -->|No| FORWARD["Commit downstream headers<br/>Pipe original body / SSE with backpressure"]
    FORWARD --> COMPLETE{"Response fully forwarded?"}
    COMPLETE -->|Yes| DONE["Keep order; release tracking<br/>Full 2xx recovery may clear matching cooldown<br/>Log request_end"]
    COMPLETE -->|No| BROKEN["No replay after headers<br/>Client cancel: abort upstream, no rotation<br/>Upstream abort: rotate for later calls"]
```

1. Validate the gateway token and origin-form URL; enforce the body limit while buffering the original bytes.
2. Inspect JSON model metadata once, resolve the provider and protocol path, and create a request-local `seen` set.
3. Select the first eligible unseen key. Only if none exists, check controlled soft recovery eligibility.
4. Replace credentials and send the exact body through the official connection. Record the attempt before sending; ordinary requests do not wait for a local slot.
5. Retry eligible failures with another unseen key. Fully forward every other response, including non-retryable 4xx errors.
6. Once downstream headers are committed, stop retrying. Complete or cancel the response, release tracking, and write one final request record.

Gateway-generated routing/auth/configuration failures return immediately. Each normal request tries each key in its selected provider pool at most once; retries may still duplicate work already accepted upstream. There is no cross-provider fallback and no model rewriting.

## FIFO and concurrent traffic

```mermaid
sequenceDiagram
    participant C1 as Client 1
    participant C2 as Client 2
    participant G as Gateway
    participant Q as Provider pool
    participant A as Official API using key A
    participant B as Official API using key B
    C1->>G: Request R1
    G->>Q: First eligible key in [A, B, C]
    Q-->>G: A
    G->>A: R1 original body
    C2->>G: Request R2
    G->>Q: First eligible key in [A, B, C]
    Q-->>G: A
    G->>A: R2 original body
    Note over G,A: R1 and R2 run concurrently<br/> no fixed local cap or waiting queue
    A-->>G: R2 receives 429 / 1302
    G->>Q: A to tail<br/> [B, C, A]<br/> A cools for 5 s by default
    Note over Q: Other failures from the same old version do not rotate A again
    G->>B: Retry R2 once with B<br/> unchanged body
    A-->>G: R1 accepted earlier continues streaming
    G-->>C1: R1 stream forwarded<br/> never cancelled by R2
    B-->>G: R2 succeeds
    G-->>C2: R2 response forwarded
    Note over Q,B: Success does not rotate B<br/> later eligible calls keep using B
```

A **key queue orders credentials, not downstream requests**. Many concurrent calls may use the same healthy head. `in_flight` measures activity in this gateway; it neither sets nor reveals the official account's concurrency limit. Usage by other applications sharing an account is invisible here.

| Event | Queue effect |
| --- | --- |
| A succeeds in `[A, B, C]` | Keep `[A, B, C]`; continue using A |
| A fails with a retryable error | Move to `[B, C, A]`; skip A while its matching cooldown applies |
| A's cooldown expires | A becomes eligible at its current position; it is not promoted to the head |
| Another call reports the same old failure version | Do not rotate again or extend the newer cooldown |
| Client cancels | Abort only its upstream call; do not blame or rotate the key |
| Qwen key fails | GLM/Kimi queues are unaffected |

More configured keys do not imply more usable capacity: keys can lack quota, share the same account, or be used externally. Successful short probes and successful token counting do not establish sustained generation capacity.

## Retries, cooldowns and recovery

### Default error handling

| Condition before downstream headers | Handling | Default cooldown |
| --- | --- | --- |
| `401` | Rotate and retry | 5 min, global to the key |
| `402` or unclassified `429` | Rotate and retry | 30 s, scoped |
| GLM `429 / 1302` | Rotate and retry | 5 s, scoped |
| GLM `429 / 1308` or `1310` | Rotate and retry | Valid official reset time, otherwise 15 min |
| GLM `429 / 1113` | Rotate and retry | 1 h, scoped |
| `403`, `408`, `5xx` | Rotate and retry | No additional default cooldown |
| Connection failure or timeout | Rotate and retry | No additional default cooldown |
| Other HTTP statuses, including `400`, `404`, `422` | Pass original response through | No rotation |

`retryStatuses` can customize status-based retries per provider; `5xx` remains retryable. Scoped cooldowns use **protocol + official endpoint path without query + model**. Authentication cooldown is global to that key. Generation, `count_tokens`, OpenAI and model discovery can therefore have different eligibility on the same credential.

GLM error inspection is limited to HTTP 429, 64 KiB and 250 ms; decoded errors have the same size limit. Unknown/unsupported/oversized errors use generic handling. Reset times must be explicit `next_flush_time`/`reset_at` fields or reset-labeled timestamps, in the future and no more than 7 days away; timezone-less Chinese GLM timestamps use UTC+08:00. Official `Retry-After` may extend cooling, with its extension capped at one hour. A zero base/auth cooldown disables the corresponding cooling rule.

### Controlled recovery

```mermaid
flowchart TD
    S["Incoming real request"] --> N{"Unseen, non-cooling key exists?"}
    N -->|Yes| PAR["Normal concurrent attempt<br/>No recovery probe needed"]
    N -->|No| SOFT{"Unseen GLM soft quota/balance candidate?<br/>No auth cooldown or official retry/reset deadline"}
    SOFT -->|No| ERROR["No eligible candidate<br/>Return pool exhaustion; do not queue"]
    SOFT -->|Yes| TIME{"RECOVERY_PROBE_MS elapsed for the key?<br/>Default 60 s; 0 disables recovery"}
    TIME -->|No| ERROR
    TIME -->|Yes| ONE{"No provider probe in flight?<br/>Provider start interval elapsed?"}
    ONE -->|No| ERROR
    ONE -->|Yes| PROBE["Send this same request with original body<br/>At most one probe per provider"]
    PROBE --> OK{"2xx fully forwarded and version still matches?"}
    OK -->|Yes| CLEAR["Clear only the matching scope cooldown<br/>Keep FIFO order; log key_recovered"]
    OK -->|No| KEEP["Keep cooldown, or replace it after a new failure<br/>Release probe tracking; no background loop"]
    EXP["Ordinary cooldown expiry also restores eligibility<br/>The key stays at its current queue position"] -.-> N
```

Recovery is **request-driven, not a scheduled health checker**. `RECOVERY_PROBE_MS` defaults to 60 s. Each provider permits one recovery attempt in flight and spaces starts by `min(15000, RECOVERY_PROBE_MS)` milliseconds; each key must also satisfy its own interval. No background inference is generated. Only GLM quota/balance failures without an explicit official retry/reset deadline qualify. `401`, short rate cooldowns and explicit deadlines do not qualify for early probing.

Only a fully forwarded 2xx with the matching failure version clears that scope. Failed/cancelled/interrupted/non-2xx attempts do not recover the key; a new failure may update its cooldown. Normal cooldown expiry works independently. HTTP 2xx still does not prove response-body business success.

### Pool exhaustion

`all_keys_unavailable` includes provider, actual attempt count and failure indexes; optional `cooling_keys` includes skipped indexes, statuses and remaining cooldown milliseconds, never full keys.

| Normal-request failure mix | Gateway status |
| --- | --- |
| Ignoring `401`, at least one failure remains and all remaining statuses are `402`/`429` | `429` |
| All failures are `401`, or other server/transport failures are present | `503` |

If every key is currently cooling, include `Retry-After`. For capacity exhaustion, derive it from the earliest non-auth cooldown; otherwise use the earliest cooldown. If no recovery attempt is currently eligible, return immediately rather than sleeping or queuing. The client decides whether/when to retry.

## Live model discovery

```mermaid
flowchart TD
    S["GET /v1/models"] --> P["Enabled providers with loaded key pools"]
    P --> HAS{"Any configured pool?"}
    HAS -->|No| NONE["503 no_configured_providers"]
    HAS -->|Yes| FAN["Start one worker per provider<br/>Independent total deadline, default 10 s"]
    FAN --> G["GLM official modelsPath<br/>Shared GLM FIFO queue"]
    FAN --> Q["Qwen official modelsPath<br/>Shared Qwen FIFO queue"]
    FAN --> O["Other configured providers<br/>Their own FIFO queues"]
    G --> RESULT["Each worker validates JSON and pages<br/>Retry eligible errors with unseen keys<br/>Collect models or a provider error"]
    Q --> RESULT
    O --> RESULT
    RESULT --> ANY{"At least one catalog succeeded?<br/>An empty valid list counts as success"}
    ANY -->|Yes| MERGE["Deduplicate IDs<br/>Exact mapping → prefix → config order<br/>Set owned_by to selected provider"]
    MERGE --> SNAP["Publish discovered routing snapshot<br/>No stale discovered IDs for failed providers"]
    SNAP --> OK["200 object=list, data=[...]<br/>Optional errors=[...] for failed providers"]
    ANY -->|No| CLEAR["Publish an empty discovered snapshot<br/>Configured routing rules remain"]
    CLEAR --> ERROR["all_model_lists_unavailable<br/>429 only if every provider error is 402/429<br/>Otherwise 503"]
```

Every aggregate request queries official APIs again; there is no cached response or static model fallback. The per-provider deadline covers connection setup, all key retries, body reads and pages. Each page is limited to 4 MiB before/after decompression, with at most 100 pages; Anthropic-style `has_more`/`last_id` pagination is supported.

Catalog workers use `KeyQueue.next(..., "models")` directly and share queue ordering/auth cooldowns with inference. They do **not** use `Attempts` recovery probing or ordinary-request in-flight tracking. Aggregate all-failed status uses provider error statuses: all must be 402/429 for a 429; otherwise 503. This is separate from normal-request mixed-auth exhaustion classification.

An explicit model mapping is authoritative: if its canonical provider did not list the ID successfully, the gateway does not substitute another provider's copy. Otherwise the longest matching prefix wins, then configuration order. Empty successful lists are valid. IDs are compared case-insensitively for deduplication; original returned IDs are retained. Failed providers go into `errors`, not `data`; failed providers' previous discovered IDs are cleared when publishing the new snapshot. Configured exact/prefix rules remain.

A successful list query establishes only catalog access, **not generation quota, endpoint compatibility or sustained capacity**. Provider-specific list URLs use normal transparent forwarding and return the official body, rather than aggregation.

## Streaming and timeouts

```mermaid
sequenceDiagram
    participant C as Downstream
    participant G as Gateway
    participant U as Official provider
    C->>G: Upload original request body
    Note over C,G: request_body_ms
    G->>G: Inspect model once<br/> select provider and key
    Note right of G: routing_ms
    G->>U: Connect/reuse connection<br/> send original bytes
    Note over G,U: Hard deadline until headers: UPSTREAM_TIMEOUT_MS, default 120 s
    U-->>G: Non-retry response headers
    G-->>C: Immediately send cleaned response headers
    Note over G,U: Hard deadline cleared<br/> socket inactivity timeout remains
    U-->>G: First body chunk<br/> possibly an SSE ping
    G-->>C: Forward bytes immediately
    Note right of G: first_byte_ms / first_content_ms
    loop Text, thinking or tool deltas
        U-->>G: Next original chunk
        G-->>C: Forward with downstream backpressure
    end
    U-->>G: Official response completes
    G-->>C: Finish response<br/> release tracking
    Note over C,G: duration_ms covers upload, retries, upstream work and full output
    Note over G,U: Client disconnect aborts its upstream call<br/> a started stream is never replayed
```

The hard response-header deadline defaults to 120 s **per attempt**, including DNS, connect, TLS, request sending and partial response headers. After headers arrive, only socket inactivity is timed; a healthy SSE stream may run longer than 120 s in total. Retrying several keys can therefore make the full request much longer than one attempt's deadline.

The gateway immediately forwards non-retry response headers and pipes raw chunks with backpressure. It does not disable thinking, shorten context/output, rewrite models, force streaming, race inference calls or replay a committed response. It strips hop-by-hop headers and `set-cookie`; SSE receives `x-accel-buffering: no` when absent. Configure reverse proxies to avoid extra buffering. A downstream disconnect aborts that call; an upstream body interruption may rotate the key for later calls, but the current response cannot be retried safely.

## Logs and latency metrics

JSON lines go to stdout. A normal request emits `request_start` → `route_selected` → one or more `upstream_attempt`/`upstream_response` events → `request_end`. Failures add `key_rotated`; cooldowns add `cooldown_skipped`/`pool_cooldown`; first recognizable SSE content adds `first_content`; recovery adds `key_recovered`. Discovery emits provider-level results. `runtime_config` records effective process settings, including systemd overrides.

| Field | Meaning |
| --- | --- |
| `request_id` | Gateway-generated request correlation ID |
| `key_index` | Deduplicated startup index; stable across rotation, may change after file edits and restart |
| `in_flight` | That key's active normal attempts in this gateway, including response streaming; not external usage or an official limit |
| `request_bytes` / `request_body_ms` | Buffered bytes / receiving and buffering time |
| `routing_ms` | JSON inspection and provider/path selection after buffering |
| `upstream_response.response_headers_ms` | Header wait for that one attempt |
| `request_end.response_headers_ms` | Total time to final forwarded headers, including upload/routing/retries |
| `first_byte_ms` | First response-body byte; may be a ping rather than content |
| `first_content_ms` / `first_content_kind` | First recognized uncompressed SSE text, thinking or tool delta; not necessarily answer text |
| `response_bytes` / `duration_ms` | Forwarded body bytes / complete request duration |
| `transport.request_sent_ms` | Attempt time until Node finishes writing the request, not confirmation of remote processing |
| `transport.wait_after_upload_ms` | Header time minus local request-write completion; includes network and provider wait |
| Transport failure `phase` | `upload_or_connection` or `waiting_headers`; not a precise diagnosis of the cause |

Final outcomes are `success`, `http_error`, `partial_success` (aggregate catalogs), `client_disconnected` and `upstream_interrupted`. Success means HTTP forwarding completed, not that payload-level business logic succeeded. Compressed/non-SSE responses do not expose content timing. In latency reports, separate generation from `count_tokens` and catalogs; report sample windows, success denominators and unfinished requests. Fast failures can lower an average without improving service capacity.

Logs contain metadata only: no key values, auth/other headers, prompts, response bodies or query strings. Unknown path components become `:redacted`; logged model strings are capped at 200 characters. Do not put secrets in model names. For a user systemd deployment:

```bash
journalctl --user -u api-gateway.service -f -o cat
```

Use the terminal for `npm start`, or `docker logs -f api-gateway` for Docker. Journal/container logging controls retention.

## Configuration

Copy [.env.example](.env.example) to `.env`. Values below are defaults; service-manager environment variables may override them.

| Variable | Default / purpose |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` |
| `PROVIDERS_FILE` | `providers.json` |
| `GATEWAY_TOKEN` | Empty; optional client access token |
| `KEYS_FILE` | `keys.txt`; legacy GLM fallback when its dedicated pool is empty |
| `UPSTREAM_ORIGIN` | Unset; optional GLM origin override |
| `UPSTREAM_TIMEOUT_MS` | `120000`; per-attempt header deadline, then socket inactivity timeout |
| `UPSTREAM_KEEPALIVE_MS` | `60000`; idle connection reuse, respecting shorter official hints |
| `UPSTREAM_PROXY_URL` | Empty; system routing without inheriting other applications' proxy environment |
| `MODELS_TIMEOUT_MS` | `10000`; complete discovery deadline per provider |
| `MAX_BODY_BYTES` | `33554432` (32 MiB) |
| `KEY_COOLDOWN_MS` / `AUTH_COOLDOWN_MS` | `30000` / `300000`; `0` disables the corresponding cooling rule |
| `RATE_COOLDOWN_MS` / `QUOTA_COOLDOWN_MS` / `BALANCE_COOLDOWN_MS` | `5000` / `900000` / `3600000`; classified GLM defaults |
| `RECOVERY_PROBE_MS` | `60000`; `0` disables early soft recovery |

Provider definitions live in [providers.json](providers.json). `keysFile` is relative to that config file. Configure `id`, `origin`, `basePath`, `models`, `modelPrefixes`, and optionally `messagesBasePath`, `messagesAuth`, `modelsPath`, `nativePrefixes`, `auth`, `headers`, `retryStatuses`, and `enabled`. `models` controls exact routing, including endpoint IDs such as `ep-...`; it does not populate the live catalog. Add a provider, then run `npm run init-keys` to initialize its file. Use a separate ignored config for private endpoint overrides and point `PROVIDERS_FILE` to it.

## Deployment and network access

`npm start` loads `.env`; use a process manager such as systemd or Docker for persistence. To expose the gateway to a LAN, listen on a reachable interface (for example `HOST=0.0.0.0`) and use the server's LAN address in clients. The host firewall and any WSL/Windows forwarding must also allow the selected port; changing `HOST` alone does not establish forwarding. Example port 3000 is the project default, not a promise about a deployment's actual port.

### systemd on Linux

Create the user unit directory with `mkdir -p ~/.config/systemd/user`. Create `~/.config/systemd/user/api-gateway.service`, replacing `/absolute/path/api-gateway` and `/usr/bin/node` with your installation paths:

```ini
[Unit]
Description=API Gateway

[Service]
WorkingDirectory=/absolute/path/api-gateway
ExecStart=/usr/bin/node --env-file-if-exists=.env /absolute/path/api-gateway/server.mjs
Restart=always
RestartSec=5
TimeoutStopSec=15
UMask=0077

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now api-gateway.service
```

If the user service must remain active after logout, enable lingering with `loginctl enable-linger "$USER"` where permitted. Apply future key/config changes with `systemctl --user restart api-gateway.service`; restarts reset in-memory state and may interrupt long calls.

### Docker

Prepare local key files first:

```bash
docker build -t api-gateway .
docker run -d --name api-gateway --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --mount type=bind,src="$PWD/keys",dst=/app/keys,readonly \
  --mount type=bind,src="$PWD/providers.json",dst=/app/providers.json,readonly \
  api-gateway
```

The image excludes keys and `.env`. Mounted files must be readable by the container user; use `--user "$(id -u):$(id -g)"` if needed. For LAN publication, choose the desired host bind address instead of `127.0.0.1`. With `--env-file .env`, keep `HOST=0.0.0.0` inside the container. Configure reverse-proxy streaming and, for browser use, same-origin access or your own CORS policy.

## Optional physical-interface egress

```mermaid
flowchart LR
    G["Gateway HTTP/HTTPS agents"] --> MODE{"UPSTREAM_PROXY_URL"}
    MODE -->|Empty| R["System DNS and route<br/>May include a system TUN"] --> U["Official HTTPS API"]
    MODE -->|http://127.0.0.1:39081| H["Optional local CONNECT helper<br/>direct-egress.py"]
    H --> ALLOW{"HTTPS origin on allowlist?"}
    ALLOW -->|No| DENY["403 Forbidden"]
    ALLOW -->|Yes| DNS["Real DNS on specified physical NIC<br/>TTL cache; per-host query coordination"]
    DNS --> TCP["TCP pinned to same physical NIC<br/>Opaque full-duplex TLS forwarding"] --> U
    G -.->|End-to-end TLS; official certificate verified by Node| U
```

The optional Linux helper is for deployments where system routing/TUN interferes with direct provider access. It is not required on networks where system routing works normally.

```bash
python3 scripts/direct-egress.py \
  --interface <physical-interface> \
  --dns-server <network-DNS-server> \
  --providers-file providers.json
```

Set `UPSTREAM_PROXY_URL=http://127.0.0.1:39081` and restart the gateway. The loopback-only helper reads configured HTTPS origins, never key files. DNS follows TTL with per-host lookup coordination; TCP binds the same interface and uses the system backlog for connection bursts. TLS remains end-to-end and certificates are still checked by Node. Linux must permit `SO_BINDTODEVICE`; IPv4 only. Interface/DNS changes require updated arguments. Containers need a reachable helper address rather than their own loopback; the standard Node image does not bundle Python or this optional helper. With egress unset, no local relay is used, but system-level TUN routing may still apply.

## Limits and troubleshooting

| Symptom / boundary | Interpretation |
| --- | --- |
| A key passes a short test but production gets 429 | Point-in-time success is not sustained quota/concurrency capacity; check classified errors and external account usage |
| `/v1/models` or `count_tokens` succeeds but generation fails | Different endpoint/scope; catalog/counting access is not generation capacity |
| First chunk is fast but completion is slow | Full duration includes provider thinking, tool/output generation, retries and downstream backpressure |
| Low first-byte time without `first_content_ms` | Could be SSE heartbeats, compressed data, non-SSE, or an unrecognized/empty stream |
| `all_keys_unavailable` | All unseen candidates are cooling or failed; eligible recovery may already be occupied or not due |
| Model or native-path conflict | Fix exact/prefix mappings or use `/providers/<id>` |
| More gateway processes | Each has its own FIFO/cooldown/recovery state; there is no distributed coordination |
| Restart | Keys/rules reload; in-memory order, cooldowns, discovered models and tracking reset; long calls may be interrupted |
| Uploads and account-owned resources | Body is buffered within the configured limit; files/tasks are not pinned to their originating key |
| Committed response | No safe replay after downstream headers; HTTP 200 business/SSE errors stay transparent |
| Supported transport | HTTP/SSE; no WebSocket or protocol translation |

Run a single instance if one shared ordering is required. More keys on the same account do not necessarily increase limits. This gateway routes traffic; it does not create extra provider quota or guarantee upstream availability.

## Tests

```bash
npm test
```

Tests use local mock providers, not real keys or paid inference. Linux egress tests require optional Python 3; TLS tests use temporary OpenSSL-generated certificates when available. Mermaid diagrams above render directly on GitHub.
