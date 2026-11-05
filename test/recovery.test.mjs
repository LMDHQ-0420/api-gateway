import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../server.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, handler, options = {}) {
  const logs = [];
  const origin = await listen(http.createServer(handler), t);
  const url = await listen(createGateway({ providers: [{ id: 'glm', origin, basePath: '/v1',
    messagesBasePath: '/anthropic/v1', keys: ['a','b'], modelPrefixes: ['glm-'] }],
    logger: line => logs.push(JSON.parse(line)), ...options }), t);
  const post = (extra = {}) => fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"model":"glm-test","messages":[{"role":"user","content":"unchanged"}]}', ...extra });
  return { post, logs };
}

test('64 downstream requests reach the healthy official head concurrently without a gateway queue', async t => {
  const responses = []; const keys = []; let allArrived;
  const barrier = new Promise(resolve => { allArrived = resolve; });
  const { post, logs } = await setup(t, (req, res) => {
    responses.push(res); keys.push(req.headers.authorization);
    if (responses.length === 64) allArrived();
  });
  const controller = new AbortController();
  const requests = Array.from({ length: 64 }, async () => {
    const response = await post({ signal: controller.signal }); return { status: response.status, body: await response.text() };
  });
  let deadline;
  try {
    await Promise.race([barrier, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('requests were serialized')), 2000); })]);
    assert.deepEqual([...new Set(keys)], ['Bearer a']);
    assert.equal(Math.max(...logs.filter(r => r.event === 'upstream_attempt').map(r => r.in_flight)), 64);
    for (const response of responses) response.end('exact-response');
    const results = await Promise.all(requests);
    assert.ok(results.every(r => r.status === 200 && r.body === 'exact-response'));
  } finally { clearTimeout(deadline); controller.abort(); await Promise.allSettled(requests); }
});

test('a successful real generation recovers soft cooldown without rewriting request bytes', async t => {
  const bodies = []; let phase = 'fail';
  const { post, logs } = await setup(t, async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); bodies.push(Buffer.concat(chunks));
    if (phase === 'fail') { res.writeHead(429); return res.end('{"error":{"code":"1113"}}'); }
    res.end('{"type":"message","content":[{"type":"text","text":"ok"}]}');
  }, { balanceCooldownMs: 5000, recoveryProbeMs: 60 });
  assert.equal((await post()).status, 429); assert.equal(bodies.length, 2);
  assert.equal((await post()).status, 429); assert.equal(bodies.length, 2);
  phase = 'healthy'; await sleep(80);
  const response = await post(); assert.equal(response.status, 200); await response.text(); await sleep(10);
  const next = await post(); assert.equal(next.status, 200); await next.text();
  assert.ok(bodies.every(b => b.equals(bodies[0])));
  assert.equal(logs.filter(r => r.event === 'key_recovered').length, 1);
  assert.equal(logs.filter(r => r.event === 'upstream_attempt' && r.recovery_probe).length, 1);
});

test('4xx and interrupted recovery responses retain cooldown; no synthetic inference or waiting is added', async t => {
  for (const interrupted of [false, true]) {
    let phase = 'fail', calls = 0;
    const { post, logs } = await setup(t, (_req, res) => {
      calls++;
      if (phase === 'fail') { res.writeHead(429); return res.end('{"error":{"code":"1113"}}'); }
      if (!interrupted) { res.writeHead(400); return res.end('official error'); }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: incomplete\n\n');
      setTimeout(() => res.destroy(), 5);
    }, { balanceCooldownMs: 5000, recoveryProbeMs: 60 });
    await (await post()).text(); phase = 'probe'; await sleep(80);
    assert.equal(calls, 2);
    const response = await post();
    if (interrupted) await assert.rejects(response.text()); else assert.equal(response.status, 400);
    assert.equal((await post()).status, 429); assert.equal(calls, 3);
    assert.equal(logs.filter(r => r.event === 'key_recovered').length, 0);
  }
});

test('a recovery slot is held until the complete response, not just successful headers', async t => {
  let phase = 'fail', stream;
  const { post, logs } = await setup(t, (_req, res) => {
    if (phase === 'fail') { res.writeHead(429); return res.end('{"error":{"code":"1113"}}'); }
    stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n');
  }, { balanceCooldownMs: 5000, recoveryProbeMs: 60 });
  await (await post()).text(); phase = 'healthy'; await sleep(80);
  const probe = await post();
  await sleep(80); assert.equal((await post()).status, 429);
  assert.equal(logs.filter(r => r.event === 'key_recovered').length, 0);
  stream.end('data: [DONE]\n\n'); await probe.text(); await sleep(10);
  assert.equal(logs.filter(r => r.event === 'key_recovered').length, 1);
});

test('timeout logs distinguish waiting for headers from upload/connection without exposing request data', async t => {
  const { post, logs } = await setup(t, () => {}, { timeoutMs: 30 });
  await (await post()).text();
  const timeouts = logs.filter(r => r.event === 'key_rotated' && r.reason === 'timeout');
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts.every(r => r.transport.phase === 'waiting_headers' && r.transport.elapsed_ms >= 20));
  assert.ok(!JSON.stringify(timeouts).includes('unchanged'));
});

test('a concurrency rejection rotates new work without cancelling another accepted response', async t => {
  let first = true;
  const { post, logs } = await setup(t, (req, res) => {
    if (req.headers.authorization === 'Bearer a') {
      if (first) { first = false; return setTimeout(() => res.end('accepted-original'), 70); }
      res.writeHead(429); return res.end('{"error":{"code":"1302"}}');
    }
    res.end('fallback');
  });
  const original = post(); await sleep(20);
  const retry = await post(); assert.equal(await retry.text(), 'fallback');
  assert.equal(await (await original).text(), 'accepted-original');
  assert.equal(logs.filter(r => r.event === 'key_rotated').length, 1);
});
