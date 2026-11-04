import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { observeResponse } from '../observe.mjs';
async function observe(chunks,enabled=true){
 const state={provider:'glm',inspect_sse:enabled};const logs=[];const meter=observeResponse(state,performance.now(),(event,fields)=>logs.push({event,...fields}));
 const output=[];Readable.from(chunks).pipe(meter);for await(const chunk of meter)output.push(chunk);
 return {state,logs,output:Buffer.concat(output)};
}
test('first meaningful Anthropic delta ignores pings and message_start without changing bytes',async()=>{
 const original=Buffer.from('event: message_start\ndata: {"type":"message_start"}\n\nevent: ping\ndata: {"type":"ping"}\n\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"SECRET_THINKING"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"SECRET_OUTPUT"}}\n\n');
 const {state,logs,output}=await observe([original.subarray(0,137),original.subarray(137)]);
 assert.deepEqual(output,original);assert.equal(state.first_content_kind,'thinking');assert.ok(state.first_content_ms>=0);
 assert.equal(state.response_bytes,original.length);assert.equal(logs.length,1);assert.ok(!JSON.stringify(logs).includes('SECRET'));
});
test('OpenAI delta split across UTF-8 chunks is observed once without changing text',async()=>{
 const original=Buffer.from('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n');
 const point=original.indexOf(Buffer.from('你好'))+1;
 const {output,state,logs}=await observe([original.subarray(0,point),original.subarray(point)]);
 assert.deepEqual(output,original);assert.equal(state.first_content_kind,'text');assert.equal(logs.length,1);
});
test('tool deltas are recognized but arguments never appear in metrics',async()=>{
 const original=Buffer.from('data: {"type":"content_block_delta","delta":{"partial_json":"SECRET_TOOL_ARGUMENT"}}\n\n');
 const {state,logs}=await observe([original]);assert.equal(state.first_content_kind,'tool');assert.ok(!JSON.stringify(logs).includes('SECRET'));
});
test('opaque compressed/non-SSE bytes are counted without parsing',async()=>{
 const bytes=Buffer.from([0,255,128,1]);const {output,state,logs}=await observe([bytes],false);
 assert.deepEqual(output,bytes);assert.equal(state.response_bytes,4);assert.equal(state.first_content_ms,undefined);assert.equal(logs.length,0);
});
test('oversized and malformed SSE lines do not block or alter passthrough',async()=>{
 const original=Buffer.from('data: broken\n\ndata: '+ 'x'.repeat(70000));
 const {output,logs}=await observe([original.subarray(0,40000),original.subarray(40000)]);assert.deepEqual(output,original);assert.equal(logs.length,0);
});
