import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createGateway } from '../server.mjs';
import { prepareProviders, routeRequest } from '../routing.mjs';

const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'client-key' };
const body = model => Buffer.from(JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] }));
const examples = JSON.parse(await readFile(new URL('../providers.json', import.meta.url), 'utf8')).providers;

async function listen(server, t) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t, handler, provider = {}, options = {}) {
  const calls = [];
  const origin = await listen(http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    handler(req, res, calls);
  }), t);
  const definition = { id: 'glm', origin, basePath: '/api/paas/v4', messagesBasePath: '/api/anthropic/v1',
    messagesAuth: 'x-api-key', modelPrefixes: ['glm-'], keys: ['a', 'b'], ...provider };
  const url = await listen(createGateway({ providers: [definition], logger: () => {}, ...options }), t);
  return { url, calls };
}

for (const [model, id, path] of [
  ['glm-5.3', 'glm', '/api/anthropic/v1/messages'],
  ['qwen3.8-max', 'qwen', '/apps/anthropic/v1/messages'],
  ['kimi-k2.6', 'kimi', '/anthropic/v1/messages'],
  ['deepseek-reasoner', 'deepseek', '/anthropic/v1/messages'],
  ['MiniMax-M2.7', 'minimax', '/anthropic/v1/messages'],
  ['claude-sonnet-4-6', 'anthropic', '/v1/messages'],
  ['doubao-test', 'doubao', '/api/compatible/v1/messages'],
  ['step-3.5-flash', 'stepfun', '/v1/messages'],
]) {
  test(`${id}: Messages uses official Anthropic path, independently from OpenAI path`, () => {
    const providers = prepareProviders(examples);
    const route = routeRequest('/v1/messages?beta=true&x=%2F', headers, body(model), providers);
    assert.equal(route.provider.id, id);
    assert.equal(route.path, path + '?beta=true&x=%2F');
    assert.equal(route.protocol, 'anthropic');
    assert.equal(routeRequest('/v1/chat/completions', headers, body(model), providers).path,
      route.provider.basePath + '/chat/completions');
  });
}

test('Messages preserves body, official response, query and Anthropic headers', async t => {
  const official = '{ "id":"msg_test", "type":"message", "content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1} }';
  const { url, calls } = await setup(t, (_req, res) => { res.setHeader('x-request-id', 'official-id'); res.end(official); });
  const original = '{ "model":"glm-5.3", "max_tokens":16, "system":[{"type":"text","text":"help"}], "messages":[], "tools":[{"name":"test","input_schema":{"type":"object"}}], "thinking":{"type":"enabled","budget_tokens":1024} }';
  const response = await fetch(`${url}/v1/messages?beta=true`, { method: 'POST', headers: {
    ...headers, 'anthropic-beta': 'interleaved-thinking-2025-05-14', 'user-agent': 'claude-test',
  }, body: original });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), official);
  assert.equal(response.headers.get('x-request-id'), 'official-id');
  assert.equal(calls[0].path, '/api/anthropic/v1/messages?beta=true');
  assert.equal(calls[0].body.toString(), original);
  assert.equal(calls[0].headers['x-api-key'], 'a');
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
  assert.equal(calls[0].headers['user-agent'], 'claude-test');
});

test('concurrent OpenAI and Messages requests share head key with isolated authentication', async t => {
  const { url, calls } = await setup(t, (_req, res) => res.end('ok'));
  await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const path = i % 2 ? '/v1/messages' : '/v1/chat/completions';
    assert.equal(await (await fetch(url + path, { method: 'POST', headers, body: body('glm-5.3') })).text(), 'ok');
  }));
  assert.equal(calls.length, 12);
  for (const call of calls) {
    if (call.path.includes('/anthropic/')) {
      assert.equal(call.headers['x-api-key'], 'a');
      assert.equal(call.headers.authorization, undefined);
    } else {
      assert.equal(call.headers.authorization, 'Bearer a');
      assert.equal(call.headers['x-api-key'], undefined);
    }
  }
});

test('Messages quota failover replays bytes and updates the shared OpenAI queue', async t => {
  const { url, calls } = await setup(t, (req, res) => {
    if (req.headers['x-api-key'] === 'a') { res.writeHead(429); return res.end('limited'); }
    res.end('ok');
  });
  const original = body('glm-5.3');
  assert.equal((await fetch(`${url}/v1/messages`, { method: 'POST', headers, body: original })).status, 200);
  assert.equal((await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: original })).status, 200);
  assert.deepEqual(calls.map(call => call.headers['x-api-key'] || call.headers.authorization), ['a', 'b', 'Bearer b']);
  assert.deepEqual(calls[0].body, original);
  assert.deepEqual(calls[1].body, original);
});

test('Messages count_tokens uses official path and body without local estimation', async t => {
  const { url, calls } = await setup(t, (_req, res) => res.end('{"input_tokens":123}'));
  const response = await fetch(`${url}/v1/messages/count_tokens`, { method: 'POST', headers, body: body('glm-5.3') });
  assert.equal(await response.text(), '{"input_tokens":123}');
  assert.equal(calls[0].path, '/api/anthropic/v1/messages/count_tokens');
});

test('native official Messages paths stay unchanged and select Messages credentials', async t => {
  const { url, calls } = await setup(t, (_req, res) => res.end('ok'));
  for (const path of ['/api/anthropic/v1/messages', '/providers/glm/api/anthropic/v1/messages']) {
    assert.equal((await fetch(url + path, { method: 'POST', headers, body: body('glm-5.3') })).status, 200);
  }
  assert.ok(calls.every(call => call.path === '/api/anthropic/v1/messages' && call.headers['x-api-key'] === 'a'));
});

test('provider-scoped Messages supports explicit provider selection without rewriting model aliases', async t => {
  const { url, calls } = await setup(t, (_req, res) => res.end('ok'));
  const original = body('claude-alias');
  assert.equal((await fetch(`${url}/providers/glm/v1/messages`, { method: 'POST', headers, body: original })).status, 200);
  assert.equal(calls[0].path, '/api/anthropic/v1/messages');
  assert.deepEqual(calls[0].body, original);
});

test('SSE Anthropic events stream incrementally and retain message_stop', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const first = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n';
  const last = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const { url } = await setup(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(first);
    await gate; res.end(last);
  });
  const response = await fetch(`${url}/v1/messages`, { method: 'POST', headers, body: body('glm-5.3') });
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), first);
  release();
  let rest='';for(;;){const part=await reader.read();if(part.done)break;rest+=Buffer.from(part.value).toString();}
  assert.equal(rest,last);
});

test('unsupported Messages protocol returns clear Anthropic error without upstream call', async t => {
  const { url, calls } = await setup(t, () => assert.fail('must not contact OpenAI'), {
    id: 'openai', basePath: '/v1', messagesBasePath: null, modelPrefixes: ['gpt-'],
  });
  const response = await fetch(`${url}/v1/messages`, { method: 'POST', headers, body: body('gpt-4.1') });
  assert.equal(response.status, 501);
  const result = await response.json();
  assert.equal(result.type, 'error');
  assert.equal(result.error.type, 'api_error');
  assert.equal(result.error.code, 'unsupported_protocol');
  assert.equal(calls.length, 0);
});

test('gateway auth and malformed Messages requests use Anthropic error envelope', async t => {
  const { url, calls } = await setup(t, () => assert.fail('must not send unauthenticated request'), {}, { gatewayToken: 'secret' });
  const response = await fetch(`${url}/v1/messages`, { method: 'POST', headers, body: body('glm-5.3') });
  assert.equal(response.status, 401);
  const result = await response.json();
  assert.equal(result.type, 'error');
  assert.equal(result.error.type, 'authentication_error');
  assert.equal(calls.length, 0);
  const invalid = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { ...headers, 'x-api-key': 'secret' }, body: '{' });
  assert.equal((await invalid.json()).error.type, 'invalid_request_error');
});

test('exhausted Messages pool returns Anthropic rate-limit error', async t => {
  const { url, calls } = await setup(t, (_req, res) => { res.writeHead(429);res.end('secret upstream error'); });
  const response = await fetch(`${url}/v1/messages`, { method: 'POST', headers, body: body('glm-5.3') });
  assert.equal(response.status, 429);
  const result=await response.json();
  assert.equal(result.error.type, 'rate_limit_error');
  assert.equal(result.error.code, 'all_keys_unavailable');
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(result).includes('secret upstream'));
});

test('invalid Messages configuration is rejected at startup', () => {
  const base={id:'glm',origin:'http://localhost',basePath:'/v1'};
  for(const messagesBasePath of ['https://other.test/v1','//other/v1','/api/v1/','/api/../v1']){
    assert.throws(()=>prepareProviders([{...base,messagesBasePath}]));
  }
  assert.throws(()=>prepareProviders([{...base,messagesAuth:'unsupported'}]));
});


test('Claude Code base URL with duplicate v1 returns actionable error instead of upstream 404', async t => {
  const {url,calls}=await setup(t,()=>assert.fail('invalid URL must not reach upstream'));
  for(const path of ['/v1/v1/messages','/providers/glm/v1/v1/messages']){
    const response=await fetch(url+path,{method:'POST',headers,body:body('glm-5.3')});
    assert.equal(response.status,400);
    assert.equal((await response.json()).error.code,'invalid_anthropic_base_url');
  }
  assert.equal(calls.length,0);
});
