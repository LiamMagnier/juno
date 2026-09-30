/**
 * Recorded-shape provider traffic for the adapter tests.
 *
 * The adapters are exercised through their real SDKs, with only the transport
 * replaced: each helper builds the HTTP response a lab (or Juno's proxy) sends,
 * byte for byte in the shape the SDK parses, and `recordingFetch` keeps every
 * request body so a test can assert on exactly what went over the wire. The
 * event sequences below follow the Anthropic Messages and OpenAI streaming
 * formats as documented and as observed from the proxy.
 */

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A transport that answers each request with the next response in `replies`
 *  and records what it was sent. */
export function recordingFetch(replies: Array<() => Response>): { fetch: FetchFn; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let next = 0;
  const fetch: FetchFn = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    requests.push({ url, headers, body: JSON.parse(raw) as Record<string, unknown> });
    const reply = replies[next] ?? replies[replies.length - 1];
    next += 1;
    if (!reply) throw new Error('recordingFetch: no reply scripted');
    return reply();
  };
  return { fetch, requests };
}

/** An Anthropic Messages stream: `event: <type>` / `data: <json>` pairs. */
export function anthropicStream(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** An OpenAI-style stream: `data: <json>` lines ending with `data: [DONE]`. */
export function openAIStream(chunks: Array<Record<string, unknown>>): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * One Anthropic turn, in the order the API streams it: `message_start`, then
 * each content block as start / deltas / stop, then `message_delta` with the
 * stop reason and output usage, then `message_stop`.
 */
export function anthropicTurn(options: {
  id?: string;
  model?: string;
  blocks: Array<
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string }
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stopReason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: {
        id: options.id ?? 'msg_01',
        type: 'message',
        role: 'assistant',
        model: options.model ?? 'claude-sonnet-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: options.usage.input_tokens,
          output_tokens: 1,
          cache_read_input_tokens: options.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: options.usage.cache_creation_input_tokens ?? 0,
        },
      },
    },
  ];
  options.blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      // Thinking arrives in pieces; the signature arrives once, last.
      const half = Math.ceil(block.thinking.length / 2);
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking.slice(0, half) } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking.slice(half) } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else if (block.type === 'redacted_thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data: block.data } });
    } else if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      const json = JSON.stringify(block.input);
      const cut = Math.ceil(json.length / 2);
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, cut) } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(cut) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: options.stopReason, stop_sequence: null },
    usage: { output_tokens: options.usage.output_tokens },
  });
  events.push({ type: 'message_stop' });
  return events;
}
