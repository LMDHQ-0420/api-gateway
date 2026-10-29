import http from 'node:http';
import https from 'node:https';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream';
import { discoverModels } from './models.mjs';
import { loadProviderDefinitions, prepareProviders, routeRequest, RoutingError } from './routing.mjs';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

// Only fixed API path components are logged; queries and resource IDs are omitted.
const LOG_PATH_PARTS = new Set(('api paas coding anthropic apps compatible compatible-mode v1 v1beta v4 chat completions messages count_tokens models files content embeddings responses images generations edits audio speech transcriptions translations batches tokenize rerank providers').split(' '));
function logPath(path) {
  return path.split('?')[0].split('/').slice(0, 16)
    .map(part => !part || LOG_PATH_PARTS.has(part) ? part : ':redacted').join('/');
}

function requestModel(body, headers) {
  if (!/(?:^|\/)json(?:\s*;|$)|\+json(?:\s*;|$)/i.test(headers['content-type'] || '')) return undefined;
  try {
    const model = JSON.parse(body.toString('utf8'))?.model;
    return typeof model === 'string' ? model.slice(0, 200) : undefined;
  } catch { return undefined; }
}

function cleanHeaders(headers) {
  const excluded = new Set(HOP_HEADERS);
  for (const token of (headers.connection ?? '').split(',')) excluded.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key)));
}

export function parseKeys(text, { allowEmpty = false } = {}) {
  const keys = [...new Set(text.replace(/^\uFEFF/, '').split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#')))];
  if (!keys.length && !allowEmpty) throw new Error('keys.txt 中没有可用的 API key，请每行填写一个 key。');
  if (keys.some(key => !/^[\x21-\x7e]+$/.test(key))) {
    throw new Error('API key 必须是可用于 HTTP 请求头的 ASCII 字符。');
  }
  return keys;
}

export class KeyQueue {
  constructor(keys) {
    this.entries = [...new Set(keys)].map((key, index) => ({ key, id: index + 1, version: 0 }));
    if (!this.entries.length) throw new Error('至少需要一个 key');
  }

  next(seen) {
    const entry = this.entries.find(item => !seen.has(item.id));
    return entry && { ...entry };
  }

  fail(attempt) {
    const index = this.entries.findIndex(item => item.id === attempt.id);
    const entry = this.entries[index];
    // 同一代 key 的多个并发失败只移动一次，避免旧请求打乱新队列。
    if (!entry || entry.version !== attempt.version) return;
    this.entries.splice(index, 1);
    entry.version++;
    this.entries.push(entry);
  }
}

function jsonError(res, status, code, message, details = {}) {
  if (res.destroyed || res.headersSent) return;
  res.gatewayErrorCode = code;
  const types = { 401: 'authentication_error', 403: 'permission_error', 413: 'request_too_large', 429: 'rate_limit_error', 504: 'timeout_error' };
  const payload = res.gatewayProtocol === 'anthropic'
    ? { type: 'error', error: { type: types[status] || (status >= 500 ? 'api_error' : 'invalid_request_error'), code, message, ...details } }
    : { error: { code, message, ...details } };
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function authorized(header, token) {
  if (!token) return true;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sendUpstream(provider, path, req, body, key, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const { origin } = provider;
    const headers = cleanHeaders(req.headers);
    delete headers.host;
    // 不携带客户端其他格式的认证信息或官方会话 cookie。
    delete headers['x-api-key'];
    delete headers['x-goog-api-key'];
    delete headers.authorization;
    delete headers.cookie;
    for (const [name, value] of Object.entries(provider.headers)) headers[name] ??= value;
    if (provider.auth === 'x-api-key') headers['x-api-key'] = key;
    else headers.authorization = `Bearer ${key}`;
    headers['content-length'] = String(body.length);
    const transport = origin.protocol === 'https:' ? https : http;
    const upstream = transport.request({
      protocol: origin.protocol, hostname: origin.hostname, port: origin.port,
      method: req.method, path, headers, signal,
    }, resolve);
    upstream.on('error', reject);
    upstream.setTimeout(timeoutMs, () => {
      const error = new Error('Upstream timeout');
      error.code = 'ETIMEDOUT';
      upstream.destroy(error);
    });
    upstream.end(body);
  });
}

export function createGateway({ keys, upstreamOrigin = 'https://open.bigmodel.cn',
  providers: definitions,
  timeoutMs = 120_000, modelsTimeoutMs = 10_000, maxBodyBytes = 32 * 1024 * 1024, gatewayToken = '',
  logger = message => console.log(message) }) {
  // 保留原单池 API 供现有集成使用；正常启动通过 providers.json 加载多厂商。
  const legacy = definitions === undefined;
  const providers = prepareProviders(definitions ?? [{ id: 'glm', origin: upstreamOrigin,
    basePath: '/api/paas/v4', keys }]);
  const queues = new Map(providers.map(provider => {
    const loaded = parseKeys((provider.keys ?? []).join('\n'), { allowEmpty: true });
    return [provider.id, provider.enabled && loaded.length ? new KeyQueue(loaded) : null];
  }));
  for (const value of [timeoutMs, modelsTimeoutMs, maxBodyBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('超时和请求大小必须是正整数');
  }
  return http.createServer(async (req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    const state = { method: req.method, path: logPath(req.url || ''), attempts: 0 };
    // Never forward Error objects, headers, query strings, or payloads to the logger.
    // A broken log sink must not change routing or response behavior.
    const log = (event, fields = {}) => {
      if (event === 'upstream_attempt' && fields.operation === 'models') state.attempts++;
      try { logger(JSON.stringify({ time: new Date().toISOString(), event, request_id: requestId, ...fields })); }
      catch { /* The transport remains usable if the log sink fails. */ }
    };
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      const ended = res.writableFinished;
      log('request_end', { ...state, status: res.headersSent ? res.statusCode : null,
        outcome: !ended ? (state.error_code === 'upstream_interrupted' ? 'upstream_interrupted' : 'client_disconnected')
          : res.statusCode >= 400 ? 'http_error' : state.partial_failure ? 'partial_success' : 'success',
        ...(res.gatewayErrorCode ? { error_code: res.gatewayErrorCode } : {}),
        duration_ms: Math.round(performance.now() - started) });
    };
    res.once('finish', complete);
    res.once('close', complete);
    log('request_start', { method: state.method, path: state.path });
    res.gatewayProtocol = /\/v1\/messages(?:\/|$)/.test((req.url || '').split('?')[0]) ? 'anthropic' : 'openai';
    const clientAuth = req.headers.authorization ?? (req.headers['x-api-key'] ? `Bearer ${req.headers['x-api-key']}` : undefined);
    if (!authorized(clientAuth, gatewayToken)) {
      req.resume();
      return jsonError(res, 401, 'gateway_unauthorized', '网关访问口令无效。');
    }
    // 只接受 origin-form，不能由请求 URL 覆盖上游主机。
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
      req.resume();
      return jsonError(res, 400, 'invalid_url', '请求必须使用以 / 开头的官方 API 路径。');
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    const failures = [];
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          jsonError(res, 413, 'request_too_large', '请求体超过网关 MAX_BODY_BYTES 配置。');
          req.resume();
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      state.model = requestModel(body, req.headers);
      const pathname = req.url.split('?')[0];
      if (!legacy && req.method === 'GET' && pathname === '/v1/models') {
        state.protocol = 'models';
        const catalog = await discoverModels({ providers, queues, signal: controller.signal, timeoutMs: modelsTimeoutMs, log,
          request: (provider, path, key, signal) => sendUpstream(provider, path, {
            method: 'GET', headers: { accept: 'application/json', 'accept-encoding': 'identity' },
          }, Buffer.alloc(0), key, modelsTimeoutMs, signal),
        });
        if (controller.signal.aborted) return;
        state.protocol = 'models';
        state.model_count = catalog.body.data?.length || 0;
        state.partial_failure = Boolean(catalog.body.errors?.length);
        state.error_code = catalog.body.error?.code;
        const result = Buffer.from(JSON.stringify(catalog.body));
        res.writeHead(catalog.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': result.length });
        return res.end(result);
      }
      let route;
      try {
        route = legacy ? { provider: providers[0], path: req.url } : routeRequest(req.url, req.headers, body, providers);
      } catch (error) {
        if (!(error instanceof RoutingError)) throw error;
        return jsonError(res, error.status, error.code, error.message, error.details);
      }
      const { provider, path } = route;
      Object.assign(state, { provider: provider.id, protocol: route.protocol || 'openai',
        upstream_host: provider.origin.host, upstream_path: logPath(path) });
      log('route_selected', { ...state });
      // Per-request protocol settings keep concurrent OpenAI/Messages requests isolated.
      const upstreamProvider = route.protocol === 'anthropic' ? { ...provider,
        auth: provider.messagesAuth, headers: { 'anthropic-version': '2023-06-01', ...provider.headers },
      } : provider;
      const queue = queues.get(provider.id);
      if (!queue) {
        return jsonError(res, 503, 'provider_not_configured', '该厂商尚未配置可用 key，请填写对应的 key 文件并重启。',
          { provider: provider.id });
      }
      const seen = new Set();
      let attempt;
      while (!controller.signal.aborted && (attempt = queue.next(seen))) {
        seen.add(attempt.id);
        state.attempts = seen.size;
        state.key_index = attempt.id;
        const attemptStarted = performance.now();
        const attemptFields = { provider: provider.id, key_index: attempt.id, attempt: seen.size };
        log('upstream_attempt', attemptFields);
        let upstream;
        try {
          upstream = await sendUpstream(upstreamProvider, path, req, body, attempt.key, timeoutMs, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return;
          queue.fail(attempt);
          failures.push({ key_index: attempt.id, reason: error.code === 'ETIMEDOUT' ? 'timeout' : 'network_error' });
          log('key_rotated', { ...attemptFields, reason: error.code === 'ETIMEDOUT' ? 'timeout' : 'network_error',
            action: 'move_to_tail', duration_ms: Math.round(performance.now() - attemptStarted) });
          continue;
        }
        const status = upstream.statusCode;
        log('upstream_response', { ...attemptFields, status,
          response_headers_ms: Math.round(performance.now() - attemptStarted) });
        if (provider.retryStatuses.includes(status) || status >= 500) {
          // 错误正文可能包含敏感信息；聚合错误仅报告索引和 HTTP 状态。
          upstream.destroy();
          queue.fail(attempt);
          failures.push({ key_index: attempt.id, status });
          log('key_rotated', { ...attemptFields, status, reason: 'http_error', action: 'move_to_tail' });
          continue;
        }
        const headers = cleanHeaders(upstream.headers);
        delete headers['set-cookie'];
        // 直接转发原始字节，包括压缩内容和 SSE；背压及断开交由 pipeline 处理。
        state.stream = (headers['content-type'] || '').includes('text/event-stream');
        res.writeHead(status, headers);
        res.flushHeaders();
        upstream.once('aborted', () => {
          if (!controller.signal.aborted) {
            queue.fail(attempt);
            state.error_code = 'upstream_interrupted';
            log('key_rotated', { ...attemptFields, reason: 'upstream_interrupted', action: 'move_to_tail' });
          }
        });
        pipeline(upstream, res, () => {
          res.removeListener('close', cancel);
        });
        return;
      }
      const allLimited = failures.length > 0 && failures.every(item => [402, 429].includes(item.status));
      jsonError(res, allLimited ? 429 : 503, 'all_keys_unavailable',
        '当前厂商的所有 API key 均已限额或不可用，请稍后重试，或检查账号额度及 key 状态。',
        { provider: provider.id, attempts: failures.length, failures });
    } catch {
      jsonError(res, 400, 'request_read_error', '无法完整读取请求。');
    } finally {
      if (!res.headersSent || res.writableEnded) res.removeListener('close', cancel);
    }
  });
}

async function main() {
  const providers = await loadProviderDefinitions(process.env.PROVIDERS_FILE || 'providers.json', parseKeys, {
    legacyKeysFile: process.env.KEYS_FILE || 'keys.txt', legacyOrigin: process.env.UPSTREAM_ORIGIN,
  });
  const server = createGateway({
    providers,
    timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 120000),
    modelsTimeoutMs: Number(process.env.MODELS_TIMEOUT_MS || 10000),
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 33554432),
    gatewayToken: process.env.GATEWAY_TOKEN || '',
  });
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须在 1–65535 之间');
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`API gateway listening on ${process.env.HOST || '127.0.0.1'}:${port}`);
    for (const provider of providers) {
      console.log(`${provider.id}: ${provider.enabled === false ? 'disabled' : `${provider.keys.length} keys loaded`}`);
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 10000).unref();
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('启动失败：请检查 providers.json、key 文件、环境变量及端口占用；key 不会输出到日志。');
    process.exitCode = 1;
  });
}
