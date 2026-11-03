import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway, KeyQueue } from '../server.mjs';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, handler, options = {}) {
  const calls = []; const logs = [];
  const origin = await listen(http.createServer((req, res) => {
    calls.push({ key: req.headers.authorization, path: req.url }); handler(req, res, calls);
  }), t);
  const url = await listen(createGateway({ providers: [{ id: 'glm', origin, basePath: '/v1', keys: ['a', 'b', 'c'], modelPrefixes: ['glm-'],
    messagesBasePath: '/anthropic/v1' }], logger: line => logs.push(JSON.parse(line)), ...options }), t);
  const chat = (model = 'glm-test', path = '/v1/chat/completions') => fetch(url + path, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [] }) });
  return { url, chat, calls, logs };
}

test('cooling keys are skipped, expiry returns them in FIFO order, success does not rotate', () => {
  let now = 0; const q = new KeyQueue(['a','b','c'], { cooldownMs: 100, now: () => now });
  const a = q.next(new Set(), 'chat'); q.fail(a, { status: 429 });
  const b = q.next(new Set(), 'chat'); assert.equal(b.key, 'b'); q.fail(b, { status: 429 });
  const c = q.next(new Set(), 'chat'); assert.equal(c.key, 'c'); q.fail(c, { status: 429 });
  assert.equal(q.next(new Set(), 'chat'), undefined);
  now = 100;
  assert.equal(q.next(new Set(), 'chat').key, 'a');
  assert.equal(q.next(new Set(), 'chat').key, 'a');
});

test('quota cooling is scoped, authentication cooling applies across all models and protocols', () => {
  const q = new KeyQueue(['a']);
  q.fail(q.next(new Set(), 'openai:model1'), { status: 429 });
  assert.equal(q.next(new Set(), 'openai:model1'), undefined);
  assert.equal(q.next(new Set(), 'openai:model2').key, 'a');
  assert.equal(q.next(new Set(), 'models').key, 'a');
  q.fail(q.next(new Set(), 'anthropic:model1'), { status: 401 });
  assert.equal(q.next(new Set(), 'openai:model2'), undefined);
  assert.equal(q.next(new Set(), 'models'), undefined);
});

test('stale concurrent failures do not extend cooling or move keys twice', () => {
  let now = 0; const q = new KeyQueue(['a','b'], { cooldownMs: 100, now: () => now });
  const a = q.next(new Set(), 'chat');
  assert.deepEqual(q.fail(a, { status: 429 }), { cooldown_ms: 100 });
  now = 80;
  assert.equal(q.fail(a, { status: 429, retryAfterMs: 1000 }), null);
  assert.equal(q.cooling('chat')[0].retry_after_ms, 20);
  assert.deepEqual(q.entries.map(e => e.key), ['b','a']);
});

test('zero cooldown preserves immediate retries; Retry-After is bounded and cache size is bounded', () => {
  const off = new KeyQueue(['a'], { cooldownMs: 0, authCooldownMs: 0 });
  off.fail(off.next(new Set()), { status: 429, retryAfterMs: 10000 });
  assert.equal(off.next(new Set()).key, 'a');
  const q = new KeyQueue(['a'], { now: () => 0 });
  q.fail(q.next(new Set(), 'retry'), { status: 429, retryAfterMs: 9_000_000 });
  assert.equal(q.cooling('retry')[0].retry_after_ms, 3_600_000);
  for (let i=0;i<100;i++) q.fail(q.next(new Set(), `model${i}`), { status: 429 });
  assert.ok(q.entries[0].cooldowns.size <= 64);
  assert.throws(() => new KeyQueue(['a'], { cooldownMs: -1 }));
});

test('repeated exhausted requests fail promptly without contacting known limited keys again', async t => {
  const { chat, calls, logs } = await setup(t, (_req, res) => { res.writeHead(429);res.end('private-error'); });
  const first = await chat(); assert.equal(first.status, 429);
  assert.equal((await first.json()).error.attempts, 3);
  const second = await chat(); assert.equal(second.status, 429);
  const body = await second.json();
  assert.equal(body.error.attempts, 0); assert.equal(body.error.cooling_keys.length, 3);
  assert.ok(Number(second.headers.get('retry-after')) > 0);
  assert.equal(calls.length, 3);
  assert.ok(logs.some(l => l.event === 'cooldown_skipped'));
  assert.ok(!JSON.stringify(logs).includes('private-error'));
});

test('scoped quota does not block other models, count_tokens, Messages, or model catalog', async t => {
  let limited = true;
  const { url, chat, calls } = await setup(t, (req, res) => {
    if (req.url === '/v1/models') return res.end('{"data":[{"id":"glm-test"}]}');
    res.writeHead(limited ? 429 : 200);res.end('ok');
  });
  await (await chat()).text(); assert.equal(calls.length, 3);
  limited = false;
  assert.equal(await (await chat('glm-other')).text(), 'ok');
  assert.equal(await (await chat('glm-test', '/v1/messages/count_tokens')).text(), 'ok');
  assert.equal(await (await chat('glm-test', '/v1/messages')).text(), 'ok');
  assert.equal((await fetch(url+'/v1/models')).status, 200);
  assert.equal((await chat()).status, 429);
});

test('cached authentication failure is skipped by catalog; original healthy results still merge', async t => {
  let phase = 'chat';
  const { url, chat, calls } = await setup(t, (req, res) => {
    if (phase === 'chat') { res.writeHead(401); return res.end('private-auth-error'); }
    res.end('{"data":[]}');
  });
  assert.equal((await chat()).status, 503); phase = 'catalog';
  const response = await fetch(url+'/v1/models'); const body = await response.json();
  assert.equal(response.status, 503); assert.equal(calls.length, 3);
  assert.equal(body.error.providers[0].code, 'keys_cooling_down');
  assert.equal(body.error.providers[0].attempts, 0);
});

test('successful head stays active while previously limited key remains skipped', async t => {
  const { chat, calls } = await setup(t, (req, res) => {
    res.writeHead(req.headers.authorization === 'Bearer a' ? 429 : 200);res.end('ok');
  });
  for (let i=0;i<5;i++) assert.equal(await (await chat()).text(), 'ok');
  assert.deepEqual(calls.map(c => c.key), ['Bearer a','Bearer b','Bearer b','Bearer b','Bearer b','Bearer b']);
});

test('HTTP Retry-After is honored for a limited request', async t => {
  const { chat } = await setup(t, (_req, res) => {
    res.writeHead(429, { 'retry-after': '120' });res.end('limited');
  });
  await (await chat()).text();
  const response = await chat(); await response.text();
  assert.ok(Number(response.headers.get('retry-after')) >= 119);
});
