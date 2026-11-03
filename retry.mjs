import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

const MAX_RESET_MS = 7 * 24 * 60 * 60 * 1000;
const GLM_CODES = new Set(['1113', '1302', '1308', '1310']);

function retryAfter(value, now) {
  if (typeof value !== 'string') return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 3_600_000)) : 0;
}

function resetAfter(error, now) {
  // Accept only explicit epoch/ISO fields or timestamps adjacent to the reset label.
  // GLM's timezone-less Chinese reset messages are interpreted as UTC+08:00.
  const parse = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    if (typeof value !== 'string') return NaN;
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return NaN;
    const [year, month, day, hour, minute, second] = value.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2}):([0-9]{2})/).slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
        hour > 23 || minute > 59 || second > 59) return NaN;
    const iso = value.replace(' ', 'T');
    return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : iso + '+08:00');
  };
  for (const field of ['next_flush_time', 'reset_at']) {
    const delta = parse(error?.[field]) - now;
    if (delta > 0 && delta <= MAX_RESET_MS) return delta;
  }
  const message = typeof error?.message === 'string' ? error.message : '';
  const match = /(?:限额将在|将于|重置时间[：:]?|reset(?:s)?(?:\s+at)?[：:]?)\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)/i.exec(message);
  const delta = match ? parse(match[1]) - now : NaN;
  return delta > 0 && delta <= MAX_RESET_MS ? delta : 0;
}

export function classifyRetry(providerId, status, data, headers = {}, now = Date.now()) {
  const policy = { kind: 'generic', retryAfterMs: retryAfter(headers['retry-after'], now) };
  if (providerId !== 'glm' || status !== 429) return policy;
  const error = data?.error;
  const code = typeof error?.code === 'number' || typeof error?.code === 'string' ? String(error.code) : '';
  if (!GLM_CODES.has(code)) return policy;
  policy.official_error_code = code;
  policy.kind = code === '1302' ? 'rate_limit' : code === '1113' ? 'balance' : 'quota';
  if (policy.kind === 'quota') policy.resetAfterMs = resetAfter(error, now);
  return policy;
}

export async function readRetryPolicy(response, providerId, { signal, now = Date.now(), readTimeoutMs = 250, maxBytes = 65536 } = {}) {
  const fallback = classifyRetry(providerId, response.statusCode, null, response.headers, now);
  // Other providers retain HTTP/Retry-After handling; never interpret their numeric codes as GLM codes.
  if (providerId !== 'glm' || response.statusCode !== 429 || signal?.aborted) {
    response.destroy();
    return fallback;
  }
  const abort = () => response.destroy();
  const timer = setTimeout(abort, readTimeoutMs);
  timer.unref();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const chunks = []; let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > maxBytes) return fallback;
      chunks.push(chunk);
    }
    let bytes = Buffer.concat(chunks);
    const encoding = (response.headers['content-encoding'] || 'identity').toLowerCase();
    const options = { maxOutputLength: maxBytes };
    if (encoding === 'gzip') bytes = gunzipSync(bytes, options);
    else if (encoding === 'deflate') bytes = inflateSync(bytes, options);
    else if (encoding === 'br') bytes = brotliDecompressSync(bytes, options);
    else if (encoding !== 'identity') return fallback;
    return classifyRetry(providerId, response.statusCode, JSON.parse(bytes.toString('utf8')), response.headers, now);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    response.destroy();
  }
}
