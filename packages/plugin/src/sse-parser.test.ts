/**
 * SSEParser unit tests. The parser is the innermost piece of the direct
 * streaming path — if it mishandles chunk boundaries or multi-event
 * blocks, every chat turn using DirectTransport will misrender.
 *
 * Cases:
 *   - happy path single event
 *   - multiple events in one chunk
 *   - line split across chunk boundary
 *   - [DONE] sentinel (ignored)
 *   - error frame (data field is valid JSON)
 *   - done frame with usage
 *   - empty keep-alive (double-newline with no content)
 */
import { describe, expect, it } from 'vitest';
import { SSEParser } from './sse-parser';

describe('SSEParser.push: single event', () => {
  it('parses a complete event in one chunk', () => {
    const p = new SSEParser();
    const frames = p.push('event: message_start\ndata: {"type":"message_start"}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('message_start');
    expect((frames[0].data as any).type).toBe('message_start');
  });

  it('returns an empty array for an incomplete event (no double-newline yet)', () => {
    const p = new SSEParser();
    const frames = p.push('event: message_start\ndata: {"type":"ms"}');
    expect(frames).toHaveLength(0);
  });

  it('completes a partial line buffered from the previous push', () => {
    const p = new SSEParser();
    // First chunk: event line complete, data line split mid-way
    p.push('event: content_block_start\ndata: {"ind');
    // Second chunk: rest of data + double newline
    const frames = p.push('ex":0}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('content_block_start');
    expect((frames[0].data as any).index).toBe(0);
  });
});

describe('SSEParser.push: multiple events per chunk', () => {
  it('emits two frames when a chunk contains two complete events', () => {
    const p = new SSEParser();
    const chunk =
      'event: content_block_start\ndata: {"index":0}\n\n' +
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n';
    const frames = p.push(chunk);
    expect(frames).toHaveLength(2);
    expect(frames[0].event).toBe('content_block_start');
    expect(frames[1].event).toBe('content_block_delta');
    expect((frames[1].data as any).delta.text).toBe('hi');
  });
});

describe('SSEParser.push: [DONE] sentinel', () => {
  it('emits a frame with data=null for the [DONE] line', () => {
    const p = new SSEParser();
    const frames = p.push('event: message_stop\ndata: [DONE]\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('message_stop');
    expect(frames[0].data).toBeNull();
  });
});

describe('SSEParser.push: error frame', () => {
  it('parses an Anthropic error event', () => {
    const p = new SSEParser();
    const frames = p.push(
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('error');
    const data = frames[0].data as any;
    expect(data.error.type).toBe('overloaded_error');
  });
});

describe('SSEParser.push: done frame with usage', () => {
  it('parses a message_delta event carrying usage + stop_reason', () => {
    const p = new SSEParser();
    const frames = p.push(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
    );
    expect(frames).toHaveLength(1);
    const data = frames[0].data as any;
    expect(data.delta.stop_reason).toBe('end_turn');
    expect(data.usage.output_tokens).toBe(42);
  });
});

describe('SSEParser.push: keep-alive blocks', () => {
  it('produces no frame for an empty double-newline keep-alive', () => {
    const p = new SSEParser();
    const frames = p.push('\n\n');
    expect(frames).toHaveLength(0);
  });
});

describe('SSEParser.push: OpenAI eventless data frames', () => {
  // OpenAI / OpenAI-compatible streams emit `data:` lines with NO `event:`
  // field. The parser MUST surface these — dropping them returns NOTHING for
  // every OpenAI stream (the core bug this fixes).
  it('emits a frame for a data-only block (no event: field)', () => {
    const p = new SSEParser();
    const frames = p.push(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('');
    expect(frames[0].hadData).toBe(true);
    expect((frames[0].data as any).choices[0].delta.content).toBe('hi');
  });

  it('surfaces a mid-stream eventless error frame', () => {
    const p = new SSEParser();
    const frames = p.push(
      'data: {"error":{"message":"rate limited","type":"rate_limit_error"}}\n\n',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('');
    expect((frames[0].data as any).error.message).toBe('rate limited');
  });

  it('emits an eventless [DONE] frame with data=null but hadData=true', () => {
    const p = new SSEParser();
    const frames = p.push('data: [DONE]\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('');
    expect(frames[0].data).toBeNull();
    // hadData distinguishes this terminator from a bare keep-alive.
    expect(frames[0].hadData).toBe(true);
  });

  it('flush surfaces a buffered eventless data frame on stream end', () => {
    const p = new SSEParser();
    p.push('data: {"choices":[{"delta":{"content":"tail"}}]}');
    const frames = p.flush();
    expect(frames).toHaveLength(1);
    expect((frames[0].data as any).choices[0].delta.content).toBe('tail');
  });

  it('still drops a bare keep-alive (no data line) — hadData=false', () => {
    const p = new SSEParser();
    // A comment-only keep-alive must NOT produce a frame.
    expect(p.push(': ping\n\n')).toHaveLength(0);
  });
});

describe('SSEParser.flush', () => {
  it('returns remaining buffered event on flush', () => {
    const p = new SSEParser();
    p.push('event: message_stop\ndata: {"type":"message_stop"}');
    // No double-newline yet — flush should emit the partial block.
    const frames = p.flush();
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('message_stop');
  });

  it('returns empty array when buffer is empty', () => {
    const p = new SSEParser();
    expect(p.flush()).toHaveLength(0);
  });
});
