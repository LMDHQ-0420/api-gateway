import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../server.mjs';
async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, statuses) {
  const keys = statuses.map((_, i) => `test-key-${i}`);
  const origin = await listen(http.createServer((req, res) => {
    const index = keys.indexOf(req.headers.authorization.slice(7));
    res.writeHead(statuses[index]); res.end('{"error":{"message":"private-test-body"}}');
  }), t);
  const logs = [];
  const url = await listen(createGateway({ keys, upstreamOrigin: origin, keyCooldownMs: 20000,
    authCooldownMs: 500, logger: line => logs.push(JSON.parse(line)) }), t);
  const call = () => fetch(url + '/v1/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"model":"glm-test"}' });
  return { call, logs };
}
for (const status of [402, 429]) {
  test(`mixed 401/${status} exhaustion returns 429 and ignores auth expiry for retry timing`, async t => {
    const { call, logs } = await setup(t, [401, status]);
    for (let i = 0; i < 2; i++) {
      const response = await call(); assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get('retry-after')) >= 19);
      assert.equal((await response.json()).error.code, 'all_keys_unavailable');
    }
    assert.ok(!JSON.stringify(logs).includes('private-test-body'));
  });
}
test('all-auth and mixed transport/server failures remain 503', async t => {
  for (const statuses of [[401,401], [429,500]]) {
    const { call } = await setup(t, statuses);
    const response = await call(); assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'all_keys_unavailable');
  }
});
