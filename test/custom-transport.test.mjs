import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../server.mjs';
import { prepareProviders } from '../routing.mjs';
async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('custom provider transport applies to discovery and inference without changing other pools', async t => {
  const directCalls = [], proxyCalls = [];
  const upstream = await listen(http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    directCalls.push({ path: req.url, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/v1/models' ? JSON.stringify({data:[{id:'custom-test'}]}) : body);
  }), t);
  const proxy = await listen(http.createServer((req, res) => {
    proxyCalls.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(req.url.endsWith('/models') ? JSON.stringify({data:[{id:'official-test'}]}) : '{"ok":true}');
  }), t);
  const gateway = await listen(createGateway({ providers: [
    {id:'custom', origin:upstream, keys:['private-key'], models:['custom-test'], proxyUrl:''},
    {id:'official', origin:'http://official.invalid', keys:['official-key'], models:['official-test']},
  ], proxyUrl:proxy, logger:()=>{} }), t);
  const catalog = await (await fetch(gateway+'/v1/models')).json();
  assert.deepEqual(catalog.data.map(x=>x.id).sort(), ['custom-test','official-test']);
  const body = '{ "model": "custom-test", "messages": [] }';
  const response = await fetch(gateway+'/v1/chat/completions', {method:'POST',headers:{'content-type':'application/json'},body});
  assert.equal(await response.text(), body);
  assert.equal((await fetch(gateway+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'official-test'})})).status,200);
  assert.deepEqual(directCalls.map(x=>x.path),['/v1/models','/v1/chat/completions']);
  assert.ok(directCalls.every(x=>x.auth==='Bearer private-key'));
  assert.deepEqual(proxyCalls,['http://official.invalid/v1/models','http://official.invalid/v1/chat/completions']);
});
test('a provider may select its own explicit proxy', async t => {
  const calls=[];
  const proxy=await listen(http.createServer((req,res)=>{calls.push(req.url);res.end('own-proxy');}),t);
  const gateway=await listen(createGateway({providers:[{id:'custom',origin:'http://custom.invalid',keys:['key'],models:['custom-test'],proxyUrl:proxy}],logger:()=>{}}),t);
  assert.equal(await (await fetch(gateway+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:'{"model":"custom-test"}'})).text(),'own-proxy');
  assert.deepEqual(calls,['http://custom.invalid/v1/chat/completions']);
});
test('provider proxy rejects invalid values and credential-bearing URLs', () => {
  for (const proxyUrl of [null,false,1,'invalid','socks5://localhost','http://user:password@localhost','http://localhost/path','http://localhost?secret=x']) {
    assert.throws(()=>prepareProviders([{id:'custom',origin:'https://example.com',proxyUrl}]));
  }
});
