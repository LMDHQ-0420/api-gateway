import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 100;

class ListError extends Error {
  constructor(code, status = 502, retry = false) {
    super(code);
    Object.assign(this, { code, status, retry });
  }
}

async function readList(response) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) throw new ListError('model_list_too_large');
      chunks.push(chunk);
    }
    let bytes = Buffer.concat(chunks);
    const encoding = (response.headers['content-encoding'] || 'identity').toLowerCase();
    const options = { maxOutputLength: MAX_RESPONSE_BYTES };
    if (encoding === 'gzip') bytes = gunzipSync(bytes, options);
    else if (encoding === 'deflate') bytes = inflateSync(bytes, options);
    else if (encoding === 'br') bytes = brotliDecompressSync(bytes, options);
    else if (encoding !== 'identity') throw new ListError('invalid_model_list');
    const result = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(result?.data) || result.data.some(model =>
      !model || typeof model.id !== 'string' || !model.id.trim())) {
      throw new ListError('invalid_model_list');
    }
    return result;
  } catch (error) {
    if (error instanceof ListError) throw error;
    if (!response.complete) throw new ListError('network_error', 502, true);
    throw new ListError('invalid_model_list');
  }
}

async function queryProvider(provider, queue, request, parentSignal, timeoutMs, log) {
  const started = performance.now();
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]);
  const seen = new Set();
  let attempt;
  while (!signal.aborted && (attempt = queue.next(seen))) {
    seen.add(attempt.id);
    const fields = { provider: provider.id, key_index: attempt.id, attempt: seen.size, operation: 'models' };
    log('upstream_attempt', fields);
    try {
      let path = provider.modelsPath;
      const models = new Map();
      const cursors = new Set();
      for (let page = 0; page < MAX_PAGES; page++) {
        const pageStarted = performance.now();
        const response = await request(provider, path, attempt.key, signal);
        const status = response.statusCode;
        log('upstream_response', { ...fields, page: page + 1, status,
          upstream_host: provider.origin.host, response_headers_ms: Math.round(performance.now() - pageStarted) });
        if (status < 200 || status >= 300) {
          response.destroy();
          throw new ListError('models_endpoint_error', status, provider.retryStatuses.includes(status) || status >= 500);
        }
        const list = await readList(response);
        for (const model of list.data) models.set(model.id, model);
        if (!list.has_more) {
          log('models_provider_end', { ...fields, outcome: 'success', model_count: models.size,
            duration_ms: Math.round(performance.now() - started) });
          return { provider, models: [...models.values()] };
        }
        // Anthropic-style cursor pagination, sharing the same key and time budget.
        if (typeof list.last_id !== 'string' || !list.last_id || cursors.has(list.last_id)) {
          throw new ListError('invalid_model_pagination');
        }
        cursors.add(list.last_id);
        const next = new URL(provider.modelsPath, provider.origin);
        next.searchParams.set('after_id', list.last_id);
        path = next.pathname + next.search;
      }
      throw new ListError('model_list_too_many_pages');
    } catch (error) {
      if (parentSignal.aborted) return { provider, error: { provider: provider.id, code: 'request_aborted' } };
      if (!(error instanceof ListError)) error = new ListError('network_error', 502, true);
      if (signal.aborted) error = new ListError('models_timeout', 504, true);
      if (error.retry) {
        queue.fail(attempt);
        log('key_rotated', { ...fields, status: error.status, reason: error.code, action: 'move_to_tail' });
      }
      log('models_attempt_error', { ...fields, status: error.status, error_code: error.code });
      const failure = { provider: provider.id, code: error.code, status: error.status, attempts: seen.size };
      if (!error.retry || signal.aborted) return { provider, error: failure };
      if (!queue.next(seen)) return { provider, error: failure };
    }
  }
  return { provider, error: { provider: provider.id, code: 'models_timeout', status: 504, attempts: seen.size } };
}

function chooseSource(id, sources, providers) {
  const name = id.toLowerCase();
  const exact = providers.filter(provider => provider.enabled && provider.models.some(model => model.toLowerCase() === name));
  // An explicit mapping is authoritative, even when its upstream list failed.
  if (exact.length) return exact.length === 1 ? sources.find(source => source.provider === exact[0]) : undefined;
  const ranked = sources.map(source => ({ source, length: Math.max(0, ...source.provider.modelPrefixes
    .filter(prefix => name.startsWith(prefix.toLowerCase())).map(prefix => prefix.length)) }));
  ranked.sort((a, b) => b.length - a.length);
  // Equal model IDs without a canonical prefix use configuration order.
  return ranked[0]?.source;
}

export async function discoverModels({ providers, queues, request, signal, timeoutMs, log = () => {} }) {
  const active = providers.filter(provider => queues.get(provider.id));
  if (!active.length) return { status: 503, body: { error: {
    code: 'no_configured_providers', message: '尚未配置任何已启用厂商的 API key。',
  } } };
  const results = await Promise.all(active.map(provider => queryProvider(provider, queues.get(provider.id), request, signal, timeoutMs, log)));
  const errors = results.filter(result => result.error).map(result => result.error);
  for (const error of errors) log('models_provider_end', { ...error, outcome: 'error' });
  const successful = results.filter(result => !result.error);
  const candidates = new Map();
  for (const result of successful) {
    for (const model of result.models) {
      const id = model.id.toLowerCase();
      if (!candidates.has(id)) candidates.set(id, []);
      candidates.get(id).push({ provider: result.provider, model });
    }
  }
  const data = [];
  const discovered = new Map(providers.map(provider => [provider, new Set()]));
  for (const [id, sources] of candidates) {
    const chosen = chooseSource(id, sources, providers);
    if (!chosen) continue;
    const { provider, model } = chosen;
    const created = Number.isFinite(model.created) ? model.created :
      (typeof model.created_at === 'string' ? Math.floor(Date.parse(model.created_at) / 1000) : 0);
    data.push({ id: model.id, object: 'model', created: Number.isFinite(created) ? created : 0, owned_by: provider.id });
    discovered.get(provider).add(id);
  }
  // Publish the entire routing snapshot together, including empty successful lists.
  if (!signal.aborted) for (const [provider, models] of discovered) provider.discoveredModels = models;
  if (!successful.length) return { status: errors.every(error => [402, 429].includes(error.status)) ? 429 : 503,
    body: { error: { code: 'all_model_lists_unavailable', message: '所有已配置厂商的官方模型列表均查询失败。', providers: errors } } };
  return { status: 200, body: { object: 'list', data, ...(errors.length ? { errors } : {}) } };
}
