import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createGateway, parseKeys } from '../server.mjs';
import { prepareProviders, routeRequest, loadProviderDefinitions } from '../routing.mjs';

const examples = JSON.parse(await readFile(new URL('../providers.json', import.meta.url), 'utf8')).providers;
const jsonHeaders = { 'content-type': 'application/json' };
const payload = model => Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }] }));

async function listen(server, t) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function mock(t, handler = (_req, res) => res.end('ok')) {
  const calls = [];
  const origin = await listen(http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ headers: req.headers, path: req.url, method: req.method, body: Buffer.concat(chunks) });
    handler(req, res, calls);
  }), t);
  return { origin, calls };
}

async function gateway(t, providers, options = {}) {
  return listen(createGateway({ providers, logger: () => {}, ...options }), t);
}

function definition(id, origin, extra = {}) {
  return { id, origin, basePath: '/v1', modelPrefixes: [`${id}-`], keys: [`${id}-a`, `${id}-b`], ...extra };
}

test('built-in model families select their own official provider and base path', () => {
  const providers = prepareProviders(examples);
  const cases = [
    ['glm-4.7', 'glm', '/api/paas/v4'], ['qwen3-coder-plus', 'qwen', '/compatible-mode/v1'],
    ['kimi-k2.5', 'kimi', '/v1'], ['moonshot-v1-8k', 'kimi', '/v1'],
    ['deepseek-reasoner', 'deepseek', '/v1'], ['MiniMax-M2.7', 'minimax', '/v1'],
    ['gpt-4.1', 'openai', '/v1'], ['claude-sonnet-4-6', 'anthropic', '/v1'],
    ['gemini-2.5-pro', 'gemini', '/v1beta/openai'], ['doubao-test', 'doubao', '/api/v3'],
    ['step-3.5-flash', 'stepfun', '/v1'],
  ];
  for (const [model, id, basePath] of cases) {
    const route = routeRequest('/v1/chat/completions?x=%2F&x=2', jsonHeaders, payload(model), providers);
    assert.equal(route.provider.id, id);
    assert.equal(route.path, `${basePath}/chat/completions?x=%2F&x=2`);
  }
});

test('exact model mapping takes precedence, then longest prefix; model is never rewritten', () => {
  const providers = prepareProviders([
    definition('one', 'http://localhost', { modelPrefixes: ['model-'] }),
    definition('two', 'http://localhost', { modelPrefixes: ['model-special-'], models: ['model-exact'] }),
  ]);
  for (const model of ['model-special-new', 'model-exact']) {
    const body = payload(model);
    assert.equal(routeRequest('/v1/chat/completions', jsonHeaders, body, providers).provider.id, 'two');
    assert.equal(JSON.parse(body).model, model);
  }
  assert.equal(routeRequest('/v1/chat/completions', jsonHeaders, payload('model-other'), providers).provider.id, 'one');
});

test('ambiguous and unknown models do not silently use another provider', () => {
  const providers = prepareProviders([
    definition('one', 'http://localhost', { modelPrefixes: ['same-'] }),
    definition('two', 'http://localhost', { modelPrefixes: ['same-'] }),
  ]);
  assert.throws(() => routeRequest('/v1/chat/completions', jsonHeaders, payload('same-name'), providers), { code: 'ambiguous_model' });
  assert.throws(() => routeRequest('/v1/chat/completions', jsonHeaders, payload('unknown'), providers), { code: 'unknown_model' });
});

test('native official paths survive, including GLM Coding Plan', () => {
  const providers = prepareProviders(examples);
  for (const path of ['/api/paas/v4/chat/completions', '/api/coding/paas/v4/chat/completions']) {
    const route = routeRequest(`${path}?a=%2F`, jsonHeaders, payload('glm-4.7'), providers);
    assert.equal(route.path, `${path}?a=%2F`);
    assert.equal(route.provider.id, 'glm');
  }
  assert.throws(() => routeRequest('/api/paas/v4/chat/completions', jsonHeaders, payload('qwen-plus'), providers), { code: 'provider_path_mismatch' });
});

test('scoped URL resolves endpoints without model, preserving path and query', () => {
  const providers = prepareProviders(examples);
  const route = routeRequest('/providers/kimi/v1/files/file-123/content?x=%2F', {}, Buffer.alloc(0), providers);
  assert.equal(route.provider.id, 'kimi');
  assert.equal(route.path, '/v1/files/file-123/content?x=%2F');
  assert.throws(() => routeRequest('/providers/missing/v1/files', {}, Buffer.alloc(0), providers), { code: 'unknown_provider' });
  assert.throws(() => routeRequest('/v1/files', {}, Buffer.alloc(0), providers), { code: 'provider_required' });
});

test('malformed JSON and invalid model types have clear errors', () => {
  const providers = prepareProviders(examples);
  assert.throws(() => routeRequest('/v1/chat/completions', jsonHeaders, Buffer.from('{'), providers), { code: 'invalid_json' });
  for (const model of [null, 3, {}, '', '  ']) {
    assert.throws(() => routeRequest('/v1/chat/completions', jsonHeaders, payload(model), providers), { code: 'invalid_model' });
  }
});

test('unsafe upstream configuration fails at startup', () => {
  for (const origin of ['ftp://localhost', 'http://localhost/path', 'http://user:secret@localhost', 'http://localhost?x=y']) {
    assert.throws(() => prepareProviders([definition('one', origin)]));
  }
  assert.throws(() => prepareProviders([definition('one', 'http://localhost'), definition('one', 'http://localhost')]));
  assert.throws(() => prepareProviders([definition('one', 'http://localhost', { headers: { authorization: 'secret' } })]));
  assert.throws(() => prepareProviders([definition('one', 'http://localhost', { basePath: '//evil' })]));
});

test('providers have independent sticky queues and failover never crosses providers', async t => {
  const glm = await mock(t, (req, res) => {
    res.statusCode = req.headers.authorization === 'Bearer glm-a' ? 429 : 200;
    res.end('glm-ok');
  });
  const qwen = await mock(t);
  const url = await gateway(t, [definition('glm', glm.origin, { basePath: '/api/paas/v4' }),
    definition('qwen', qwen.origin, { basePath: '/compatible-mode/v1' })]);
  for (const model of ['glm-4.7', 'qwen-plus', 'glm-4.7', 'qwen-plus']) {
    const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: jsonHeaders, body: payload(model) });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.deepEqual(glm.calls.map(item => item.headers.authorization), ['Bearer glm-a', 'Bearer glm-b', 'Bearer glm-b']);
  assert.deepEqual(qwen.calls.map(item => item.headers.authorization), ['Bearer qwen-a', 'Bearer qwen-a']);
  assert.equal(glm.calls[0].path, '/api/paas/v4/chat/completions');
  assert.equal(qwen.calls[0].path, '/compatible-mode/v1/chat/completions');
});

test('pool exhaustion reports provider; other pools remain usable', async t => {
  const failed = await mock(t, (_req, res) => { res.statusCode = 429; res.end('limited'); });
  const healthy = await mock(t);
  const url = await gateway(t, [definition('glm', failed.origin), definition('kimi', healthy.origin)]);
  const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: jsonHeaders, body: payload('glm-4.7') });
  assert.equal(response.status, 429);
  const error = (await response.json()).error;
  assert.equal(error.provider, 'glm');
  assert.equal(error.attempts, 2);
  assert.equal(healthy.calls.length, 0);
  assert.equal((await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: jsonHeaders, body: payload('kimi-k2.5') })).status, 200);
});

test('DeepSeek HTTP 402 balance exhaustion rotates the provider queue', async t => {
  const upstream = await mock(t, (_req, res, calls) => { res.statusCode = calls.length === 1 ? 402 : 200; res.end('ok'); });
  const url = await gateway(t, [definition('deepseek', upstream.origin)]);
  assert.equal((await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: jsonHeaders, body: payload('deepseek-chat') })).status, 200);
  assert.deepEqual(upstream.calls.map(item => item.headers.authorization), ['Bearer deepseek-a', 'Bearer deepseek-b']);
});

test('Anthropic native body and API version survive, credentials are replaced', async t => {
  const upstream = await mock(t);
  const url = await gateway(t, [definition('anthropic', upstream.origin, {
    modelPrefixes: ['claude-'], auth: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' },
  })], { gatewayToken: 'gateway-token' });
  const body = '{ "model":"claude-test", "max_tokens":100, "messages":[] }';
  const response = await fetch(`${url}/v1/messages`, { method: 'POST', body, headers: {
    ...jsonHeaders, 'x-api-key': 'gateway-token', 'x-goog-api-key': 'unrelated', 'anthropic-version': '2023-06-01',
  } });
  assert.equal(response.status, 200);
  assert.equal(upstream.calls[0].path, '/v1/messages');
  assert.equal(upstream.calls[0].headers['x-api-key'], 'anthropic-a');
  assert.equal(upstream.calls[0].headers.authorization, undefined);
  assert.equal(upstream.calls[0].headers['x-goog-api-key'], undefined);
  assert.equal(upstream.calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(upstream.calls[0].body.toString(), body);
});

test('empty pool and unknown model return errors without contacting a different provider', async t => {
  const upstream = await mock(t);
  const url = await gateway(t, [definition('glm', upstream.origin, { keys: [] }), definition('kimi', upstream.origin)]);
  for (const [model, status, code] of [['glm-4.7', 503, 'provider_not_configured'], ['unrecognized', 400, 'unknown_model']]) {
    const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: jsonHeaders, body: payload(model) });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal(upstream.calls.length, 0);
});

test('model list queries official endpoints only for pools with keys', async t => {
  const upstream = await mock(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: 'glm-live-model' }] })));
  const url = await gateway(t, [definition('glm', upstream.origin, { models: ['glm-test'] }),
    definition('kimi', upstream.origin, { keys: [], models: ['kimi-test'] })]);
  const response = await fetch(`${url}/v1/models`);
  const body = await response.json();
  assert.equal(body.object, 'list');
  assert.deepEqual(body.data.map(item => [item.id, item.owned_by]), [['glm-live-model', 'glm']]);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].path, '/v1/models');
});

test('concurrent mixed-provider requests use each pool head without load balancing', async t => {
  const a = await mock(t);
  const b = await mock(t);
  const url = await gateway(t, [definition('glm', a.origin), definition('qwen', b.origin)]);
  await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST', headers: jsonHeaders, body: payload(i % 2 ? 'glm-4.7' : 'qwen-plus'),
    });
    assert.equal(await response.text(), 'ok');
  }));
  assert.equal(a.calls.length, 10);
  assert.equal(b.calls.length, 10);
  assert.ok(a.calls.every(item => item.headers.authorization === 'Bearer glm-a'));
  assert.ok(b.calls.every(item => item.headers.authorization === 'Bearer qwen-a'));
});

test('provider file resolves key paths relative to config and falls back to legacy GLM keys', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'api-gateway-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'keys'));
  await writeFile(join(dir, 'keys/qwen.txt'), 'qwen-a\nqwen-b\nqwen-a\n');
  await writeFile(join(dir, 'legacy.txt'), 'glm-old\n');
  const config = { providers: [
    { id: 'glm', origin: 'http://localhost', keysFile: 'keys/missing.txt' },
    { id: 'qwen', origin: 'http://localhost', keysFile: 'keys/qwen.txt' },
    { id: 'kimi', origin: 'http://localhost', keysFile: 'keys/absent.txt' },
  ] };
  await writeFile(join(dir, 'providers.json'), JSON.stringify(config));
  const providers = await loadProviderDefinitions(join(dir, 'providers.json'), parseKeys, { legacyKeysFile: join(dir, 'legacy.txt') });
  assert.deepEqual(providers.map(item => item.keys), [['glm-old'], ['qwen-a', 'qwen-b'], []]);
});

test('key initialization preserves existing files and never prints their contents', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'api-gateway-init-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'keys'));
  const existing = 'example-private-test-value\n';
  await writeFile(join(dir, 'keys/glm.txt'), existing);
  const config = { providers: [
    { id: 'glm', origin: 'http://localhost', keysFile: 'keys/glm.txt' },
    { id: 'qwen', origin: 'http://localhost', keysFile: 'keys/qwen.txt' },
  ] };
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify(config));
  const script = fileURLToPath(new URL('../scripts/init-keys.mjs', import.meta.url));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [script], {
    env: { ...process.env, PROVIDERS_FILE: configPath },
  });
  assert.equal(await readFile(join(dir, 'keys/glm.txt'), 'utf8'), existing);
  assert.match(await readFile(join(dir, 'keys/qwen.txt'), 'utf8'), /^# qwen:/);
  assert.ok(!stdout.includes(existing.trim()) && !stderr.includes(existing.trim()));
});
