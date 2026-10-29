import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../server.mjs';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, handler, options = {}) {
  const logs = [];
  const origin = await listen(http.createServer(handler), t);
  const provider = { id: 'glm', origin, basePath: '/api/paas/v4', modelPrefixes: ['glm-'],
    messagesBasePath: '/api/anthropic/v1', keys: ['PRIVATE_KEY_ONE', 'PRIVATE_KEY_TWO'] };
  const url = await listen(createGateway({ providers: [provider], logger: line => logs.push(JSON.parse(line)), ...options }), t);
  return { url, logs };
}
const post = (url, path = '/v1/chat/completions', extra = {}) => fetch(url + path, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer CLIENT_SECRET',
    'x-custom': 'HEADER_SECRET', cookie: 'COOKIE_SECRET' },
  body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'PROMPT_SECRET' }] }), ...extra,
});
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('success logs route, key index, status and timing without payloads, headers or query', async t => {
  const { url, logs } = await setup(t, (_req, res) => res.end('RESPONSE_SECRET'));
  assert.equal(await (await post(url, '/v1/chat/completions?api_key=QUERY_SECRET')).text(), 'RESPONSE_SECRET');
  await settle();
  assert.deepEqual(logs.map(log => log.event), ['request_start', 'route_selected', 'upstream_attempt', 'upstream_response', 'request_end']);
  const end = logs.at(-1);
  assert.equal(end.model, 'glm-5.3'); assert.equal(end.provider, 'glm');
  assert.equal(end.upstream_path, '/api/paas/v4/chat/completions');
  assert.equal(end.protocol, 'openai'); assert.equal(end.key_index, 1);
  assert.equal(end.status, 200); assert.equal(end.outcome, 'success');
  assert.equal(end.attempts, 1); assert.ok(end.duration_ms >= 0);
  assert.equal(new Set(logs.map(log => log.request_id)).size, 1);
  for (const secret of ['PRIVATE_KEY', 'CLIENT_SECRET', 'HEADER_SECRET', 'COOKIE_SECRET', 'PROMPT_SECRET', 'RESPONSE_SECRET', 'QUERY_SECRET']) {
    assert.ok(!JSON.stringify(logs).includes(secret), secret);
  }
});

test('quota retry logs both attempts and final successful key', async t => {
  const { url, logs } = await setup(t, (req, res) => {
    if (req.headers.authorization.endsWith('ONE')) res.writeHead(429);
    res.end('SECRET_ERROR_OR_OUTPUT');
  });
  await (await post(url, '/v1/messages')).text(); await settle();
  assert.deepEqual(logs.filter(log => log.event === 'upstream_response').map(log => log.status), [429, 200]);
  assert.equal(logs.find(log => log.event === 'key_rotated').key_index, 1);
  assert.equal(logs.at(-1).key_index, 2); assert.equal(logs.at(-1).attempts, 2);
  assert.equal(logs.at(-1).protocol, 'anthropic'); assert.equal(logs.at(-1).outcome, 'success');
  assert.ok(!JSON.stringify(logs).includes('SECRET_ERROR_OR_OUTPUT'));
});

test('gateway failures and exhausted pools each produce one final error record', async t => {
  const { url, logs } = await setup(t, (_req, res) => { res.writeHead(429); res.end('PRIVATE_ERROR'); });
  await (await post(url)).text();
  await (await post(url, '/v1/messages', { body: '{' })).text(); await settle();
  const ends = logs.filter(log => log.event === 'request_end');
  assert.equal(ends.length, 2);
  assert.equal(ends[0].status, 429); assert.equal(ends[0].error_code, 'all_keys_unavailable');
  assert.equal(ends[1].status, 400); assert.equal(ends[1].error_code, 'invalid_json');
  assert.ok(ends.every(log => log.outcome === 'http_error'));
});

test('authentication failure logs result without reading or logging credentials', async t => {
  const { url, logs } = await setup(t, () => assert.fail('must not contact upstream'), { gatewayToken: 'GATEWAY_SECRET' });
  await (await post(url)).text(); await settle();
  assert.equal(logs.at(-1).status, 401); assert.equal(logs.at(-1).error_code, 'gateway_unauthorized');
  assert.equal(logs.at(-1).attempts, 0);
  assert.ok(!JSON.stringify(logs).includes('SECRET'));
});

test('interrupted SSE is logged as interrupted even after HTTP 200', async t => {
  const { url, logs } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: PRIVATE_STREAM\n\n');
    setTimeout(() => res.destroy(), 30);
  });
  const response = await post(url);
  await assert.rejects(() => response.text()); await settle();
  const ends = logs.filter(log => log.event === 'request_end');
  assert.equal(ends.length, 1); assert.equal(ends[0].status, 200);
  assert.equal(ends[0].stream, true); assert.equal(ends[0].outcome, 'upstream_interrupted');
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_STREAM'));
});

test('catalog logs individual provider results and partial overall success', async t => {
  const logs = [];
  const origin = await listen(http.createServer((req, res) => {
    if (req.url.startsWith('/bad')) { res.writeHead(401); return res.end('PRIVATE_ERROR'); }
    res.end(JSON.stringify({ data: [{ id: 'glm-PRIVATE_MODEL_LIST' }] }));
  }), t);
  const url = await listen(createGateway({ providers: [
    { id: 'glm', origin, keys: ['PRIVATE_KEY_ONE'], basePath: '/v1', modelPrefixes: ['glm-'] },
    { id: 'qwen', origin, keys: ['PRIVATE_KEY_TWO'], basePath: '/bad', modelPrefixes: ['qwen-'] },
  ], logger: line => logs.push(JSON.parse(line)) }), t);
  await (await fetch(url + '/v1/models')).text(); await settle();
  const results = logs.filter(log => log.event === 'models_provider_end');
  assert.equal(results.length, 2); assert.ok(results.some(log => log.outcome === 'error' && log.status === 401));
  assert.equal(logs.at(-1).outcome, 'partial_success'); assert.equal(logs.at(-1).model_count, 1);
  assert.equal(logs.at(-1).attempts, 2);
  assert.equal(new Set(logs.map(log => log.request_id)).size, 1);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
});

test('resource IDs and query strings are redacted, and logger failure does not break proxy', async t => {
  const { url, logs } = await setup(t, (_req, res) => res.end('ok'));
  await (await fetch(url + '/providers/glm/v1/files/PRIVATE_FILE_ID?token=PRIVATE_TOKEN')).text(); await settle();
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
  const other = await setup(t, (_req, res) => res.end('ok'), { logger: () => { throw Error('sink failed'); } });
  assert.equal(await (await post(other.url)).text(), 'ok');
});

test('client cancellation logs once and does not blame or rotate the upstream key', async t => {
  const { url, logs } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  });
  const controller = new AbortController();
  const response = await post(url, '/v1/messages', { signal: controller.signal });
  const reader = response.body.getReader(); await reader.read(); controller.abort();
  await settle();
  const ends = logs.filter(log => log.event === 'request_end');
  assert.equal(ends.length, 1); assert.equal(ends[0].outcome, 'client_disconnected');
  assert.equal(logs.filter(log => log.event === 'key_rotated').length, 0);
});

test('timeout records a safe reason for each attempt and final failure', async t => {
  const { url, logs } = await setup(t, () => {}, { timeoutMs: 30 });
  await (await post(url)).text(); await settle();
  const rotated = logs.filter(log => log.event === 'key_rotated');
  assert.equal(rotated.length, 2); assert.ok(rotated.every(log => log.reason === 'timeout'));
  assert.equal(logs.at(-1).status, 503); assert.equal(logs.at(-1).attempts, 2);
});
