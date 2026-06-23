/**
 * Incremental SSE parser for Anthropic streaming responses.
 *
 * Handles the realities of ReadableStream delivery:
 *   - lines split across chunk boundaries
 *   - multiple events in a single chunk
 *   - [DONE] sentinel (ignored; we rely on message_stop + done frame)
 *
 * Usage:
 *   const parser = new SSEParser();
 *   for await (const chunk of reader) {
 *     for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
 *       // { event, data } — event is the SSE `event:` field, data is
 *       // the parsed JSON object from the `data:` field.
 *     }
 *   }
 *
 * Frames with an empty or missing data field are emitted with data=null.
 * Parse errors yield data=null rather than throwing — the caller handles
 * the null case gracefully (the SSE stream will typically carry an error
 * frame before closing).
 */

export interface SSEFrame {
  event: string;
  data: unknown;
  /**
   * True when the SSE block carried a `data:` line, regardless of whether it
   * also carried an `event:` line. OpenAI / OpenAI-compatible streams emit
   * `data:`-only frames (no `event:` field), so the parser must surface them
   * and let the consumer (via passEventlessFrames) decide.
   *
   * `data` may still be null for such a frame (e.g. `data: [DONE]` or a
   * parse error) — `hadData` distinguishes "data line was present but parsed
   * to null" from "no data line at all" (a bare keep-alive).
   */
  hadData: boolean;
}

export class SSEParser {
  private buffer = '';

  /**
   * Push a new decoded chunk and get back any complete SSE frames.
   * Partial lines are retained in the buffer and completed on the
   * next push.
   */
  push(chunk: string): SSEFrame[] {
    this.buffer += chunk;
    const frames: SSEFrame[] = [];

    // SSE event blocks are delimited by double newlines (\n\n).
    // Split on \n\n, keeping any trailing partial block in the buffer.
    const blocks = this.buffer.split('\n\n');
    this.buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      const frame = parseBlock(block);
      // Emit frames that carry an event name (Anthropic/OpenRouter) OR a data
      // payload (OpenAI/OpenAI-compatible frames have no `event:` field).
      // Empty keep-alives (\n\n with neither) produce no frame.
      if (frame.event || frame.hadData) {
        frames.push(frame);
      }
    }

    return frames;
  }

  /** Flush any remaining buffer content as a final frame (on stream end). */
  flush(): SSEFrame[] {
    if (!this.buffer.trim()) return [];
    const frame = parseBlock(this.buffer);
    this.buffer = '';
    return frame.event || frame.hadData ? [frame] : [];
  }
}

function parseBlock(block: string): SSEFrame {
  let event = '';
  let dataStr = '';
  let hadData = false;

  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // Multiple data: lines per spec are concatenated with \n —
      // Anthropic only uses one data: line per block, but handle both.
      hadData = true;
      const piece = line.slice(5).trim();
      dataStr = dataStr ? dataStr + '\n' + piece : piece;
    }
  }

  // [DONE] is the SSE stream terminator — no JSON to parse.
  if (dataStr === '[DONE]') {
    return { event, data: null, hadData };
  }

  if (!dataStr) return { event, data: null, hadData };

  try {
    return { event, data: JSON.parse(dataStr), hadData };
  } catch {
    return { event, data: null, hadData };
  }
}
