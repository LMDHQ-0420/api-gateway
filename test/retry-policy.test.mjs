import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createGateway, KeyQueue } from '../server.mjs';
import { classifyRetry } from '../retry.mjs';
const now=Date.parse('2026-11-03T12:00:00Z');
const policy=code=>classifyRetry('glm',429,{error:{code}}, {}, now);

test('GLM rate, period quota, and balance have different cooling durations',()=>{
 const q=new KeyQueue(['a'],{now:()=>now});
 for(const [code,expected] of [['1302',5000],['1308',900000],['1310',900000],['1113',3600000]]){
  const a=q.next(new Set(),code);
  assert.equal(q.fail(a,{status:429,...policy(code)}).cooldown_ms,expected);
 }
});
test('quota reset fields and labeled Chinese timestamps override fallback',()=>{
 for(const error of [
  {code:'1310',next_flush_time:'2026-11-03T12:02:00Z'},
  {code:1308,reset_at:(now+120000)/1000},
  {code:'1310',message:'您的限额将在 2026-11-03 20:02:00 重置。private-message'},
 ]){
  const p=classifyRetry('glm',429,{error},{},now);
  assert.equal(p.resetAfterMs,120000);
  const q=new KeyQueue(['a'],{now:()=>now});
  assert.equal(q.fail(q.next(new Set()),{status:429,...p}).cooldown_ms,120000);
  assert.ok(!JSON.stringify(p).includes('private-message'));
 }
});
test('invalid, ambiguous, past, and excessively distant resets use fallback',()=>{
 for(const next_flush_time of ['tomorrow','2020-01-01T00:00:00Z','2027-01-01T00:00:00Z','11/04/2026 01:00','2026-11-03T24:00:00Z','2026-11-31T01:00:00Z']){
  assert.equal(classifyRetry('glm',429,{error:{code:'1310',next_flush_time}},{},now).resetAfterMs,0);
 }
 assert.equal(classifyRetry('glm',429,{error:{code:'1310',message:'prompt contains 2026-11-03 20:02:00'}},{},now).resetAfterMs,0);
});
test('codes are provider and status specific; arbitrary text and codes are never exported',()=>{
 for(const [provider,status,data] of [['qwen',429,{error:{code:'1310'}}],['glm',400,{error:{code:'1310'}}],['glm',429,{error:{code:'PRIVATE_SECRET',message:'SECRET'}}]]){
  const p=classifyRetry(provider,status,data,{},now);
  assert.equal(p.kind,'generic');assert.equal(p.official_error_code,undefined);
  assert.ok(!JSON.stringify(p).includes('SECRET'));
 }
});
test('Retry-After supports seconds and dates and extends short rate cooling',()=>{
 for(const value of ['120',new Date(now+120000).toUTCString()]){
  const p=classifyRetry('glm',429,{error:{code:'1302'}},{'retry-after':value},now);
  assert.equal(p.retryAfterMs,120000);
  const q=new KeyQueue(['a'],{now:()=>now});assert.equal(q.fail(q.next(new Set()),{status:429,...p}).cooldown_ms,120000);
 }
});
test('zero general cooldown disables classified quota cooling too',()=>{
 const q=new KeyQueue(['a'],{cooldownMs:0});
 assert.equal(q.fail(q.next(new Set()),{status:429,...policy('1310')}).cooldown_ms,0);
 assert.ok(q.next(new Set()));
});

async function listen(server,t){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections?.();server.close();});
 return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t,handler){
 const logs=[];const origin=await listen(http.createServer(handler),t);
 const url=await listen(createGateway({providers:[{id:'glm',origin,basePath:'/v1',keys:['PRIVATE_KEY'],modelPrefixes:['glm-']}],logger:line=>logs.push(JSON.parse(line))}),t);
 const call=()=>fetch(url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'glm-test',messages:[]})});
 return {url,call,logs};
}
for(const encoding of ['identity','gzip'])test(`bounded ${encoding} error parsing exports only safe code and cooldown`,async t=>{
 const {call,logs}=await setup(t,(_req,res)=>{
  const bytes=Buffer.from(JSON.stringify({error:{code:'1310',message:'PRIVATE_BODY PRIVATE_KEY'}}));
  res.writeHead(429,{'content-encoding':encoding});res.end(encoding==='gzip'?gzipSync(bytes):bytes);
 });
 const first=await call();const body=await first.text();assert.equal(first.status,429);
 assert.ok(!body.includes('PRIVATE'));
 const rotation=logs.find(d=>d.event==='key_rotated');
 assert.equal(rotation.official_error_code,'1310');assert.equal(rotation.cooldown_ms,900000);
 assert.ok(!JSON.stringify(logs).includes('PRIVATE'));
 const second=await call();assert.equal(second.status,429);assert.equal((await second.json()).error.attempts,0);
});
test('catalog applies same classified cooldown policy',async t=>{
 const {url,logs}=await setup(t,(_req,res)=>{res.writeHead(429);res.end('{"error":{"code":"1113"}}');});
 assert.equal((await fetch(url+'/v1/models')).status,429);
 assert.equal(logs.find(d=>d.event==='key_rotated').cooldown_ms,3600000);
});
test('oversized or malformed retry body safely falls back without changing status',async t=>{
 for(const body of ['not JSON','x'.repeat(70000)]){
  const {call,logs}=await setup(t,(_req,res)=>{res.writeHead(429);res.end(body);});
  const r=await call();await r.text();assert.equal(r.status,429);
  assert.equal(logs.find(d=>d.event==='key_rotated').cooldown_ms,30000);
 }
});
test('compressed error expansion is capped',async t=>{
 const {call,logs}=await setup(t,(_req,res)=>{
  res.writeHead(429,{'content-encoding':'gzip'});
  res.end(gzipSync(JSON.stringify({error:{code:'1310',message:'x'.repeat(100000)}})));
 });
 const r=await call();await r.text();assert.equal(r.status,429);
 assert.equal(logs.find(d=>d.event==='key_rotated').cooldown_ms,30000);
});
test('hanging retry error body cannot block failover indefinitely',async t=>{
 const {call,logs}=await setup(t,(_req,res)=>{res.writeHead(429);res.flushHeaders();});
 const start=performance.now();const r=await call();await r.text();
 assert.equal(r.status,429);assert.ok(performance.now()-start<2000);
 assert.equal(logs.find(d=>d.event==='key_rotated').cooldown_ms,30000);
});
test('client cancellation during error inspection does not rotate or cool a key',async t=>{
 let arrived;const upstreamArrived=new Promise(resolve=>{arrived=resolve;});
 const {call,url,logs}=await setup(t,(_req,res)=>{res.writeHead(429);res.flushHeaders();arrived();});
 const controller=new AbortController();
 const request=fetch(url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'glm-test',messages:[]}),signal:controller.signal});
 await upstreamArrived;controller.abort();await assert.rejects(request);
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(logs.filter(d=>d.event==='key_rotated').length,0);
});
