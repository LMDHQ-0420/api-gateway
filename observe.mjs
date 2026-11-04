import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

// This observer never changes payloads and stores no content in logs. Parse only
// until the first meaningful SSE delta, with a bounded line buffer.
export function observeResponse(state, started, log) {
  const elapsed = () => Math.round(performance.now() - started);
  let decoder = state.inspect_sse ? new StringDecoder('utf8') : null;
  let pending = '';
  state.response_bytes = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    state.response_bytes += chunk.length;
    state.first_byte_ms ??= elapsed();
    if (decoder) {
      const lines = (pending + decoder.write(chunk)).split('\n');
      pending = lines.pop();
      if (pending.length > 65536) { pending = ''; decoder = null; }
      for (const line of lines) {
        if (!line.startsWith('data:') || line.length > 65536) continue;
        try {
          const data = JSON.parse(line.slice(5).trim());
          const delta = data.delta;
          let kind;
          if (data.type === 'content_block_delta') {
            if (typeof delta?.text === 'string' && delta.text.length) kind = 'text';
            else if (typeof delta?.thinking === 'string' && delta.thinking.length) kind = 'thinking';
            else if (typeof delta?.partial_json === 'string' && delta.partial_json.length) kind = 'tool';
          }
          const choice = data.choices?.[0]?.delta;
          if (!kind && choice) {
            if (typeof choice.content === 'string' && choice.content.length) kind = 'text';
            else if (typeof choice.reasoning_content === 'string' && choice.reasoning_content.length) kind = 'thinking';
            else if (Array.isArray(choice.tool_calls) && choice.tool_calls.length) kind = 'tool';
          }
          if (kind) {
            state.first_content_ms = elapsed(); state.first_content_kind = kind;
            log('first_content', { provider: state.provider, first_content_ms: state.first_content_ms, kind });
            decoder = null; pending = ''; break;
          }
        } catch { /* Non-JSON events, pings, and DONE remain opaque passthrough. */ }
      }
    }
    callback(null, chunk);
  } });
}
