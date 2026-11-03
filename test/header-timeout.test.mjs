import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createGateway } from '../server.mjs';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('partial headers cannot extend the response header deadline indefinitely', async t => {
  const sockets = new Set(); let connections = 0;
  const origin = await listen(net.createServer(socket => {
    sockets.add(socket); connections++;
    socket.on('error', () => {});
    socket.on('data', () => {});
    socket.write('HTTP/1.1 200 OK\r\nx-slow: ');
    const timer = setInterval(() => socket.write('a'), 5);
    socket.on('close', () => { clearInterval(timer); sockets.delete(socket); });
  }), t);
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const logs=[];
  const url = await listen(createGateway({ keys:['a','b'], upstreamOrigin:origin, timeoutMs:80,
    logger: line => logs.push(JSON.parse(line)) }), t);
  const start=performance.now();
  const response=await fetch(url, { signal: AbortSignal.timeout(1500) });
  const body=await response.json();
  assert.equal(response.status,503);
  assert.deepEqual(body.error.failures.map(item => item.reason),['timeout','timeout']);
  assert.equal(connections,2);
  assert.ok(performance.now()-start<1200);
  assert.equal(logs.filter(item=>item.event==='key_rotated'&&item.reason==='timeout').length,2);
});

test('response header deadline clears before a healthy long stream completes', async t => {
  const origin=await listen(http.createServer((_req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
    let count=0;
    const timer=setInterval(()=>{
      res.write('data: ok\n\n');
      if(++count===12){clearInterval(timer);res.end('data: [DONE]\n\n');}
    },15);
    res.on('close',()=>clearInterval(timer));
  }),t);
  const url=await listen(createGateway({keys:['a'],upstreamOrigin:origin,timeoutMs:80,logger:()=>{}}),t);
  const response=await fetch(url,{signal:AbortSignal.timeout(2000)});
  const text=await response.text();
  assert.equal(response.status,200);
  assert.equal((text.match(/data: ok/g)||[]).length,12);
  assert.ok(text.endsWith('data: [DONE]\n\n'));
});
