import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createGateway } from '../server.mjs';
import { prepareProviders } from '../routing.mjs';

async function listen(server, t) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function upstream(t, handler) {
  const calls = [];
  const origin = await listen(http.createServer((req, res) => {
    calls.push({ path: req.url, key: req.headers.authorization || req.headers['x-api-key'], headers: req.headers });
    handler(req, res, calls);
  }), t);
  return { calls, origin };
}

const provider = (id, origin, options = {}) => ({ id, origin, basePath: '/v1',
  keys: [`${id}-a`, `${id}-b`], modelPrefixes: [`${id}-`], ...options });
const start = (t, providers, options = {}) => listen(createGateway({ providers, logger: () => {}, ...options }), t);
const reply = (res, ids) => res.end(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, created: 123 })) }));
const chat = (url, model) => fetch(`${url}/v1/chat/completions`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [] }) });

test('live catalog merges active providers, skips empty/disabled pools and excludes static examples', async t => {
  const a = await upstream(t, (_req, res) => reply(res, ['glm-5.3']));
  const b = await upstream(t, (_req, res) => reply(res, ['qwen-live']));
  const unused = await upstream(t, () => assert.fail('inactive pool must not be queried'));
  const url = await start(t, [provider('glm', a.origin, { basePath: '/api/paas/v4', models: ['glm-old'] }),
    provider('qwen', b.origin), provider('empty', unused.origin, { keys: [] }), provider('disabled', unused.origin, { enabled: false })]);
  const response = await fetch(`${url}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data, [
    { id: 'glm-5.3', object: 'model', created: 123, owned_by: 'glm' },
    { id: 'qwen-live', object: 'model', created: 123, owned_by: 'qwen' },
  ]);
  assert.equal(body.errors, undefined);
  assert.equal(a.calls[0].path, '/api/paas/v4/models');
  assert.equal(b.calls[0].key, 'Bearer qwen-a');
  assert.equal(unused.calls.length, 0);
});

test('catalog failure rotates same queue used by subsequent inference', async t => {
  const server = await upstream(t, (req, res) => {
    if (req.headers.authorization === 'Bearer glm-a') { res.writeHead(429); return res.end('limited'); }
    if (req.url === '/v1/models') return reply(res, ['glm-5.3']);
    res.end('chat-ok');
  });
  const url = await start(t, [provider('glm', server.origin)]);
  assert.equal((await fetch(`${url}/v1/models`)).status, 200);
  assert.equal(await (await chat(url, 'glm-5.3')).text(), 'chat-ok');
  assert.deepEqual(server.calls.map(call => call.key), ['Bearer glm-a', 'Bearer glm-b', 'Bearer glm-b']);
});

test('partial failure returns only live results and sanitized provider errors', async t => {
  const healthy = await upstream(t, (_req, res) => reply(res, ['glm-5.3']));
  const broken = await upstream(t, (_req, res) => { res.writeHead(401); res.end('private-secret-upstream-body'); });
  const url = await start(t, [provider('glm', healthy.origin), provider('qwen', broken.origin, { models: ['qwen-static'] })]);
  const response = await fetch(`${url}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map(model => model.id), ['glm-5.3']);
  assert.deepEqual(body.errors, [{ provider: 'qwen', code: 'models_endpoint_error', status: 401, attempts: 2 }]);
  assert.ok(!JSON.stringify(body).includes('private-secret'));
  assert.ok(!JSON.stringify(body).includes('qwen-a'));
  assert.equal(broken.calls.length, 2);
});

for (const [status, expected] of [[429, 429], [401, 503]]) {
  test(`all catalog requests fail with HTTP ${status}: returns bounded error ${expected}`, async t => {
    const server = await upstream(t, (_req, res) => { res.writeHead(status); res.end('error'); });
    const url = await start(t, [provider('glm', server.origin)]);
    const response = await fetch(`${url}/v1/models`);
    assert.equal(response.status, expected);
    const body = await response.json();
    assert.equal(body.error.code, 'all_model_lists_unavailable');
    assert.equal(body.error.providers[0].attempts, 2);
    assert.equal(server.calls.length, 2);
  });
}

test('no loaded keys returns configuration error without a fabricated list', async t => {
  const url = await start(t, [provider('glm', 'http://localhost', { keys: [] })]);
  const response = await fetch(`${url}/v1/models`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'no_configured_providers');
});

test('official empty list stays empty; invalid JSON and 404 do not cycle all keys', async t => {
  const empty = await upstream(t, (_req, res) => reply(res, []));
  const malformed = await upstream(t, (_req, res) => res.end('not JSON'));
  const missing = await upstream(t, (_req, res) => { res.writeHead(404); res.end('missing'); });
  const url = await start(t, [provider('empty', empty.origin, { models: ['empty-static'] }),
    provider('broken', malformed.origin), provider('missing', missing.origin)]);
  const response = await fetch(`${url}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data, []);
  assert.deepEqual(body.errors.map(error => error.code), ['invalid_model_list', 'models_endpoint_error']);
  assert.equal(malformed.calls.length, 1);
  assert.equal(missing.calls.length, 1);
});

test('slow provider is bounded by total time budget without blocking healthy result', async t => {
  const slow = await upstream(t, () => {});
  const healthy = await upstream(t, (_req, res) => reply(res, ['glm-5.3']));
  const url = await start(t, [provider('slow', slow.origin), provider('glm', healthy.origin)], { modelsTimeoutMs: 80 });
  const response = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data[0].id, 'glm-5.3');
  assert.equal(body.errors[0].code, 'models_timeout');
  assert.equal(slow.calls.length, 1);
});

test('cursor pagination uses provider auth, preserves endpoint query and same key', async t => {
  const server = await upstream(t, (req, res, calls) => {
    res.end(JSON.stringify(calls.length === 1
      ? { data: [{ id: 'claude-one', created_at: '2025-01-01T00:00:00Z' }], has_more: true, last_id: 'claude-one' }
      : { data: [{ id: 'claude-two' }], has_more: false }));
  });
  const url = await start(t, [provider('anthropic', server.origin, { auth: 'x-api-key',
    modelsPath: '/v1/models?limit=1', headers: { 'anthropic-version': '2023-06-01' } })]);
  const body = await (await fetch(`${url}/v1/models`)).json();
  assert.deepEqual(body.data.map(model => model.id), ['claude-one', 'claude-two']);
  assert.equal(body.data[0].created, 1735689600);
  assert.equal(server.calls[1].path, '/v1/models?limit=1&after_id=claude-one');
  assert.deepEqual(server.calls.map(call => call.key), ['anthropic-a', 'anthropic-a']);
  assert.equal(server.calls[0].headers['anthropic-version'], '2023-06-01');
});

test('repeating pagination cursor is rejected instead of looping', async t => {
  const server = await upstream(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: 'glm-one' }], has_more: true, last_id: 'glm-one' })));
  const url = await start(t, [provider('glm', server.origin)]);
  const response = await fetch(`${url}/v1/models`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.providers[0].code, 'invalid_model_pagination');
  assert.equal(server.calls.length, 2);
});

test('gzip catalogs are decoded without leaking caller credentials', async t => {
  const server = await upstream(t, (_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end(gzipSync(JSON.stringify({ data: [{ id: 'glm-5.3' }] })));
  });
  const url = await start(t, [provider('glm', server.origin)]);
  const response = await fetch(`${url}/v1/models`, { headers: { authorization: 'Bearer client-secret', cookie: 'session=private' } });
  assert.equal((await response.json()).data[0].id, 'glm-5.3');
  assert.equal(server.calls[0].headers.cookie, undefined);
  assert.equal(server.calls[0].key, 'Bearer glm-a');
});

test('discovered model without configured prefix is routable and removed on next empty catalog', async t => {
  let empty = false;
  const server = await upstream(t, (req, res) => req.url === '/v1/models' ? reply(res, empty ? [] : ['custom-live-id']) : res.end('routed'));
  const url = await start(t, [provider('qwen', server.origin)]);
  assert.equal((await chat(url, 'custom-live-id')).status, 400);
  await (await fetch(`${url}/v1/models`)).json();
  assert.equal(await (await chat(url, 'custom-live-id')).text(), 'routed');
  empty = true;
  assert.deepEqual((await (await fetch(`${url}/v1/models`)).json()).data, []);
  assert.equal((await chat(url, 'custom-live-id')).status, 400);
});

test('duplicate IDs select canonical source; explicit mapping overrides it', async t => {
  const a = await upstream(t, (req, res) => req.url === '/v1/models' ? reply(res, ['glm-live']) : res.end('qwen'));
  const b = await upstream(t, (req, res) => req.url === '/v1/models' ? reply(res, ['glm-live']) : res.end('glm'));
  for (const override of [false, true]) {
    const url = await start(t, [provider('qwen', a.origin, { models: override ? ['glm-live'] : [] }), provider('glm', b.origin)]);
    const body = await (await fetch(`${url}/v1/models`)).json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].owned_by, override ? 'qwen' : 'glm');
    assert.equal(await (await chat(url, 'glm-live')).text(), override ? 'qwen' : 'glm');
  }
});

test('provider-specific official list remains a transparent proxy', async t => {
  const original = '{ "object":"list", "data":[{"id":"glm-live","extra":"keep"}] }';
  const server = await upstream(t, (_req, res) => res.end(original));
  const url = await start(t, [provider('glm', server.origin)]);
  const response = await fetch(`${url}/providers/glm/v1/models?custom=%2F`);
  assert.equal(await response.text(), original);
  assert.equal(server.calls[0].path, '/v1/models?custom=%2F');
});

test('model list endpoint validates paths and requires gateway token before discovery', async t => {
  for (const modelsPath of ['https://other.example/models', '//other.example/models', '/models#secret', '/models\r\nheader']) {
    assert.throws(() => prepareProviders([provider('glm', 'http://localhost', { modelsPath })]));
  }
  const server = await upstream(t, (_req, res) => reply(res, ['glm-live']));
  const url = await start(t, [provider('glm', server.origin)], { gatewayToken: 'secret' });
  assert.equal((await fetch(`${url}/v1/models`)).status, 401);
  assert.equal(server.calls.length, 0);
  assert.equal((await fetch(`${url}/v1/models`, { headers: { authorization: 'Bearer secret' } })).status, 200);
});
