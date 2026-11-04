import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createUpstreamAgents } from '../transport.mjs';
import { createGateway } from '../server.mjs';

async function listen(server,t){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections?.();server.close();});
 return `http://127.0.0.1:${server.address().port}`;
}
test('dedicated keep-alive agents are bounded while active requests are not serialized',()=>{
 const a=createUpstreamAgents();
 assert.equal(a.http.options.timeout,60000);assert.equal(a.https.options.timeout,60000);
 assert.equal(a.http.maxSockets,Infinity);assert.equal(a.https.maxFreeSockets,64);
 assert.notEqual(a.http,http.globalAgent);assert.notEqual(a.https,https.globalAgent);
 a.http.destroy();a.https.destroy();
 for(const proxyUrl of ['socks5://127.0.0.1:1','http://user:secret@localhost:1','http://localhost/path'])assert.throws(()=>createUpstreamAgents({proxyUrl}));
 assert.throws(()=>createUpstreamAgents({keepAliveMs:0}));
});
test('explicit HTTP proxy receives official route and response bytes stay unchanged',async t=>{
 const calls=[];
 const proxy=await listen(http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  calls.push({url:req.url,auth:req.headers.authorization,body:Buffer.concat(chunks).toString()});
  res.end('raw response');
 }),t);
 const gateway=await listen(createGateway({providers:[{id:'glm',origin:'http://upstream.invalid',basePath:'/v1',keys:['official-key'],modelPrefixes:['glm-']}],proxyUrl:proxy,logger:()=>{}}),t);
 const body='{ "model":"glm-test", "messages":[] }';
 const r=await fetch(gateway+'/v1/chat/completions?x=%2F',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer client-key'},body});
 assert.equal(await r.text(),'raw response');
 assert.deepEqual(calls,[{url:'http://upstream.invalid/v1/chat/completions?x=%2F',auth:'Bearer official-key',body}]);
});
test('completed successful responses reuse a connection and log upload/header timing',async t=>{
 const ports=[];const logs=[];
 const origin=await listen(http.createServer((req,res)=>{ports.push(req.socket.remotePort);res.end('ok');}),t);
 const url=await listen(createGateway({keys:['a'],upstreamOrigin:origin,logger:line=>logs.push(JSON.parse(line))}),t);
 for(let i=0;i<2;i++)assert.equal(await(await fetch(url)).text(),'ok');
 assert.equal(ports[0],ports[1]);
 const transport=logs.filter(d=>d.event==='upstream_response').map(d=>d.transport);
 assert.equal(transport[0].reused_socket,false);assert.equal(transport[1].reused_socket,true);
 assert.ok(transport[1].request_sent_ms>=0);assert.ok(transport[1].wait_after_upload_ms>=0);
});

// Ephemeral test-only TLS credentials are generated locally and never committed.
const dir=mkdtempSync(join(tmpdir(),'gateway-tls-test-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
const tlsOptions=generated.status===0?{key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))}:null;
async function tunnel(t,originPort){
 const seen=[];const sockets=new Set();
 const proxy=http.createServer();
 proxy.on('connect',(req,client,head)=>{
  seen.push({url:req.url,headers:req.headers});
  const upstream=net.connect(originPort,'127.0.0.1',()=>{
   client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);
  });
  for(const s of [client,upstream]){sockets.add(s);s.on('error',()=>{});s.on('close',()=>{sockets.delete(s);client.destroy();upstream.destroy();});}
 });
 t.after(()=>{for(const socket of sockets)socket.destroy();});
 return {url:await listen(proxy,t),seen};
}
function request(url,agent){return new Promise((resolve,reject)=>{
 const req=https.get(url,{agent,headers:{authorization:'Bearer official-private-key'}},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(Buffer.concat(chunks).toString()));
 });req.on('error',reject);
});}
test('HTTPS CONNECT keeps official auth inside TLS and reuses the tunnel',{skip:!tlsOptions},async t=>{
 const auth=[];const origin=https.createServer(tlsOptions,(req,res)=>{auth.push(req.headers.authorization);res.end('secure response');});
 await listen(origin,t);const proxy=await tunnel(t,origin.address().port);
 const agents=createUpstreamAgents({proxyUrl:proxy.url});agents.https.options.ca=tlsOptions.cert;
 t.after(()=>{agents.http.destroy();agents.https.destroy();});
 const url=`https://localhost:${origin.address().port}/v1/messages`;
 assert.equal(await request(url,agents.https),'secure response');assert.equal(await request(url,agents.https),'secure response');
 assert.deepEqual(auth,['Bearer official-private-key','Bearer official-private-key']);assert.equal(proxy.seen.length,1);
 assert.equal(proxy.seen[0].headers.authorization,undefined);assert.equal(proxy.seen[0].headers['x-api-key'],undefined);
});
test('HTTPS proxy still verifies upstream certificates',{skip:!tlsOptions},async t=>{
 const origin=https.createServer(tlsOptions,(_req,res)=>res.end('must not accept untrusted cert'));await listen(origin,t);
 const proxy=await tunnel(t,origin.address().port);const a=createUpstreamAgents({proxyUrl:proxy.url});
 t.after(()=>{a.http.destroy();a.https.destroy();});
 await assert.rejects(request(`https://localhost:${origin.address().port}/`,a.https));
});
