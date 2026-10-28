import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createGateway, KeyQueue, parseKeys } from '../server.mjs';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t, handler, options = {}) {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ key: req.headers.authorization, path: req.url, method: req.method,
      headers: req.headers, body: Buffer.concat(chunks) });
    handler(req, res, calls);
  });
  const origin = await listen(upstream, t);
  const gateway = createGateway({ keys: ['a', 'b', 'c'], upstreamOrigin: origin, logger: () => {}, ...options });
  const url = await listen(gateway, t);
  return { url, calls };
}

test('key loading: BOM, CRLF, empty lines, comments, duplicates', () => {
  assert.deepEqual(parseKeys('\uFEFFa\r\n\r\nb\n# comment\na\n'), ['a', 'b']);
  assert.throws(() => parseKeys(' \n'));
  assert.throws(() => parseKeys('a\u0000b'));
});

test('stale concurrent failure moves a key only once', () => {
  const queue = new KeyQueue(['a', 'b', 'c']);
  const a = queue.next(new Set());
  queue.fail(a);
  queue.fail(queue.next(new Set()));
  queue.fail(a);
  assert.deepEqual(queue.entries.map(item => item.key), ['c', 'a', 'b']);
});

test('success sticks to head; exact method, path, query, body and custom headers survive', async t => {
  const { url, calls } = await setup(t, (_req, res) => res.end('{"ok":true}'));
  const body = '{ "model": "glm-4.7", "unknown": [1,2] }';
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`${url}/api/paas/v4/chat/completions?x=%2F&x=2`, {
      method: 'POST', headers: { authorization: 'Bearer original-client-key', 'content-type': 'application/json', 'x-custom': 'value' }, body,
    });
    assert.equal(await response.text(), '{"ok":true}');
  }
  assert.deepEqual(calls.map(item => item.key), ['Bearer a', 'Bearer a', 'Bearer a']);
  assert.equal(calls[0].path, '/api/paas/v4/chat/completions?x=%2F&x=2');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.toString(), body);
  assert.equal(calls[0].headers['x-custom'], 'value');
});

test('limited key moves to tail, retry uses next, following requests stick to successful key', async t => {
  const { url, calls } = await setup(t, (req, res) => {
    res.statusCode = req.headers.authorization === 'Bearer a' ? 429 : 200;
    res.end('ok');
  });
  await (await fetch(url)).text();
  await (await fetch(url)).text();
  assert.deepEqual(calls.map(item => item.key), ['Bearer a', 'Bearer b', 'Bearer b']);
});

test('all limited: each key once, structured 429; next request can recover queue head', async t => {
  let recover = false;
  const { url, calls } = await setup(t, (_req, res) => {
    res.statusCode = recover ? 200 : 429;
    res.end('upstream secret');
  });
  const response = await fetch(url);
  assert.equal(response.status, 429);
  const result = await response.json();
  assert.equal(result.error.code, 'all_keys_unavailable');
  assert.equal(result.error.attempts, 3);
  assert.equal(JSON.stringify(result).includes('upstream secret'), false);
  recover = true;
  assert.equal((await fetch(url)).status, 200);
  assert.deepEqual(calls.map(item => item.key), ['Bearer a', 'Bearer b', 'Bearer c', 'Bearer a']);
});

test('authentication and server errors rotate; all failures return 503', async t => {
  const { url, calls } = await setup(t, (_req, res, seen) => {
    res.statusCode = [401, 403, 503][(seen.length - 1) % 3];
    res.end('failed');
  });
  const response = await fetch(url);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.attempts, 3);
  assert.equal(calls.length, 3);
});

test('invalid parameters and policy errors pass through, without rotating keys', async t => {
  const { url, calls } = await setup(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'official-id' });
    res.end('{"error":{"code":"1214","message":"invalid"}}');
  });
  const response = await fetch(url);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('x-request-id'), 'official-id');
  assert.equal(await response.text(), '{"error":{"code":"1214","message":"invalid"}}');
  assert.equal(calls.length, 1);
});

test('network errors and timeouts exhaust queue with bounded attempts', async t => {
  const { url, calls } = await setup(t, (req, _res, seen) => {
    if (seen.length === 1) req.socket.destroy();
  }, { timeoutMs: 30 });
  const response = await fetch(url);
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.deepEqual(result.error.failures.map(item => item.reason), ['network_error', 'timeout', 'timeout']);
  assert.equal(calls.length, 3);
});

test('SSE is delivered incrementally, bytes unchanged, including DONE', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const first = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n';
  const { url } = await setup(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(first);
    await gate;
    res.end('data: [DONE]\n\n');
  });
  const response = await fetch(url);
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.equal(Buffer.from(chunk.value).toString(), first);
  release();
  let rest = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    rest += Buffer.from(part.value).toString();
  }
  assert.equal(rest, 'data: [DONE]\n\n');
});

test('compressed response remains valid', async t => {
  const { url } = await setup(t, (_req, res) => {
    const body = gzipSync('compressed original');
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': body.length });
    res.end(body);
  });
  assert.equal(await (await fetch(url)).text(), 'compressed original');
});

test('optional gateway token is checked before upstream request', async t => {
  const { url, calls } = await setup(t, (_req, res) => res.end('ok'), { gatewayToken: 'gateway-secret' });
  assert.equal((await fetch(url)).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer gateway-secret' } })).status, 200);
  assert.equal(calls[0].key, 'Bearer a');
});

test('oversized request returns 413 without upstream calls', async t => {
  const { url, calls } = await setup(t, (_req, res) => res.end('ok'), { maxBodyBytes: 4 });
  const response = await fetch(url, { method: 'POST', body: '12345' });
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test('concurrent successful requests all use the same head key', async t => {
  const { url, calls } = await setup(t, (_req, res) => res.end('ok'));
  await Promise.all(Array.from({ length: 20 }, async () => (await fetch(url)).text()));
  assert.equal(calls.length, 20);
  assert.ok(calls.every(item => item.key === 'Bearer a'));
});

test('multipart bytes and Coding Plan paths are forwarded without conversion', async t => {
  const { url, calls } = await setup(t, (_req, res) => res.end('ok'));
  const body = Buffer.from('--boundary\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n\x00\xff\r\n--boundary--\r\n', 'latin1');
  await (await fetch(`${url}/api/coding/paas/v4/files`, {
    method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=boundary' }, body,
  })).text();
  assert.equal(calls[0].path, '/api/coding/paas/v4/files');
  assert.deepEqual(calls[0].body, body);
  assert.equal(calls[0].headers['content-type'], 'multipart/form-data; boundary=boundary');
});

test('interrupted upstream stream is not replayed; later requests use next key', async t => {
  let cut;
  const gate = new Promise(resolve => { cut = resolve; });
  t.after(() => cut());
  const { url, calls } = await setup(t, async (_req, res, seen) => {
    if (seen.length > 1) return res.end('next-key');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    await gate;
    res.destroy();
  });
  const response = await fetch(url);
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'data: first\n\n');
  cut();
  await assert.rejects(reader.read());
  assert.equal(calls.length, 1);
  assert.equal(await (await fetch(url)).text(), 'next-key');
  assert.equal(calls[1].key, 'Bearer b');
});

test('request body is replayed identically on failover and original auth never reaches upstream', async t => {
  const { url, calls } = await setup(t, (_req, res, seen) => {
    res.statusCode = seen.length === 1 ? 429 : 200;
    res.end('ok');
  });
  const body = '{"messages":[{"role":"user","content":"原样重试"}],"stream":true}';
  assert.equal(await (await fetch(`${url}/api/paas/v4/chat/completions`, {
    method: 'POST', body, headers: { authorization: 'Bearer private-client-key' },
  })).text(), 'ok');
  assert.deepEqual(calls.map(item => item.body.toString()), [body, body]);
  assert.deepEqual(calls.map(item => item.key), ['Bearer a', 'Bearer b']);
});
