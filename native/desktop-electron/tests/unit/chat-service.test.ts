/**
 * Unit tests for the Chat service.
 *
 * Three layers, in order of how much they are worth:
 *
 *  1. **The SSE reader.** This is the part that a real server exercises in ways
 *     a developer never does by hand. A `fetch` body arrives in chunks the
 *     sender did not choose: one read routinely carries six whole frames and
 *     half of a seventh. Every case below is one of those — a frame split
 *     across reads, several frames in one read, a corrupted frame in the middle
 *     of a good stream — because those are the shapes that turn a working
 *     parser into one that silently drops half an answer.
 *  2. **The pure mappings.** The wire's vocabulary is not the contract's, and
 *     every difference (nested usage, a synthesized assistant id, an absent
 *     `titleSource`, an unknown finish reason) is resolved by a function with
 *     no I/O. Those functions are testable, so they are tested.
 *  3. **The turn state machine**, driven through a fake `fetch`. What is
 *     asserted is the property the UI depends on: **every turn ends, exactly
 *     once**. A stopped turn, a dropped socket and a clean finish all produce
 *     one terminal frame and no more.
 *
 * No filesystem, no socket, no Electron. The attachment picker is injected and
 * the transport is handed a fake `fetch`.
 */

import { describe, expect, test } from 'vitest';

import { AnonymousSseReader } from '../../src/main/chat/sse.js';
import {
  isRetryableFinish,
  parseWireChunk,
  previewOf,
  toConversation,
  toMessage,
  toModelDescriptor,
  type WireChunk,
} from '../../src/main/chat/wire.js';
import { decodeDroppedFile, safeFileName } from '../../src/main/chat/attachments.js';
import { ChatService, pickDefaultModel } from '../../src/main/chat/service.js';
import { JunoTransport, type AccessTokenSource } from '../../src/main/auth/transport.js';
import { SecretString } from '../../src/main/auth/keychain.js';
import type { ChannelLogger } from '../../src/main/logger.js';
import type { StreamFrame } from '../../src/shared/contracts/chat.js';

/* -------------------------------------------------------------------------- */
/* 1. The SSE reader                                                           */
/* -------------------------------------------------------------------------- */

describe('AnonymousSseReader', () => {
  test('reads one complete frame', () => {
    const reader = new AnonymousSseReader();
    const { values, malformed } = reader.push('data: {"type":"delta","text":"hi"}\n\n');

    expect(malformed).toBe(0);
    expect(values).toEqual([{ type: 'delta', text: 'hi' }]);
    expect(reader.pending).toBe(0);
  });

  test('reassembles a frame split across three reads', () => {
    const reader = new AnonymousSseReader();

    /* Split inside the JSON, then again immediately before the blank line —
       the two places a naive `indexOf('\n\n')` per chunk gets wrong. */
    expect(reader.push('data: {"type":"del').values).toEqual([]);
    expect(reader.push('ta","text":"half"}').values).toEqual([]);
    expect(reader.pending).toBeGreaterThan(0);

    const { values } = reader.push('\n\n');
    expect(values).toEqual([{ type: 'delta', text: 'half' }]);
    expect(reader.pending).toBe(0);
  });

  test('splits a boundary that straddles two reads', () => {
    const reader = new AnonymousSseReader();

    expect(reader.push('data: {"type":"delta","text":"a"}\n').values).toEqual([]);
    const { values } = reader.push('\ndata: {"type":"delta","text":"b"}\n\n');

    expect(values).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
    ]);
  });

  test('returns every frame of a multi-frame read, in order', () => {
    const reader = new AnonymousSseReader();
    const chunk =
      'data: {"type":"meta","conversationId":"c1"}\n\n' +
      'data: {"type":"delta","text":"one"}\n\n' +
      'data: {"type":"delta","text":"two"}\n\n' +
      'data: {"type":"ping"}\n\n';

    const { values, malformed } = reader.push(chunk);

    expect(malformed).toBe(0);
    expect(values.map((value) => (value as { type: string }).type)).toEqual([
      'meta',
      'delta',
      'delta',
      'ping',
    ]);
    expect((values[1] as { text: string }).text).toBe('one');
    expect((values[2] as { text: string }).text).toBe('two');
  });

  test('drops a malformed frame and keeps reading the ones after it', () => {
    const reader = new AnonymousSseReader();
    const chunk =
      'data: {"type":"delta","text":"before"}\n\n' +
      'data: {"type":"delta","text":\n\n' + // truncated JSON
      'data: {"type":"delta","text":"after"}\n\n';

    const { values, malformed } = reader.push(chunk);

    expect(malformed).toBe(1);
    expect(reader.malformedTotal).toBe(1);
    /* The point of the test: the good frame *after* the bad one survives. */
    expect(values).toEqual([
      { type: 'delta', text: 'before' },
      { type: 'delta', text: 'after' },
    ]);
  });

  test('a malformed frame never leaks its payload into the result', () => {
    const reader = new AnonymousSseReader();
    const result = reader.push('data: {"type":"delta","text":"secret\n\n');

    expect(result.values).toEqual([]);
    expect(result.malformed).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('ignores comments, unknown fields and empty data', () => {
    const reader = new AnonymousSseReader();
    const chunk =
      ': keep-alive\n\n' +
      'event: wakeup\nid: 7\nretry: 500\n\n' + // the *other* dialect: no data
      'data:\n\n' +
      'data: {"type":"delta","text":"real"}\n\n';

    const { values, malformed } = reader.push(chunk);

    expect(malformed).toBe(0);
    expect(values).toEqual([{ type: 'delta', text: 'real' }]);
  });

  test('handles CRLF framing', () => {
    const reader = new AnonymousSseReader();
    const { values } = reader.push(
      'data: {"type":"delta","text":"a"}\r\n\r\ndata: {"type":"delta","text":"b"}\r\n\r\n',
    );

    expect(values).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
    ]);
  });

  test('joins a multi-line data field with newlines', () => {
    const reader = new AnonymousSseReader();
    const { values } = reader.push('data: {"type":"delta",\ndata: "text":"wrapped"}\n\n');

    expect(values).toEqual([{ type: 'delta', text: 'wrapped' }]);
  });

  test('an empty push changes nothing', () => {
    const reader = new AnonymousSseReader();
    reader.push('data: {"type":"ping"}');
    const before = reader.pending;

    expect(reader.push('').values).toEqual([]);
    expect(reader.pending).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Pure mappings                                                            */
/* -------------------------------------------------------------------------- */

describe('parseWireChunk', () => {
  test('classifies the frames this build renders', () => {
    expect(parseWireChunk({ type: 'delta', text: 'x' })).toEqual({ kind: 'delta', text: 'x' });
    expect(parseWireChunk({ type: 'reasoning', text: 'why', part: 2 })).toEqual({
      kind: 'reasoning',
      text: 'why',
      part: 2,
    });
    /* An absent `part` means the provider streamed unbroken prose — never
       inferred, so it must arrive as an explicit null. */
    expect(parseWireChunk({ type: 'reasoning', text: 'why' })).toEqual({
      kind: 'reasoning',
      text: 'why',
      part: null,
    });
  });

  test('drops the heartbeat and the frames with no surface to render into', () => {
    expect(parseWireChunk({ type: 'ping' }).kind).toBe('ignored');
    expect(parseWireChunk({ type: 'activity', event: {} }).kind).toBe('ignored');
    expect(parseWireChunk({ type: 'progress', stage: 'queued' }).kind).toBe('ignored');
  });

  test('reports a frame it should have understood as unreadable, not as ignored', () => {
    expect(parseWireChunk({ type: 'delta' }).kind).toBe('unreadable'); // no text
    expect(parseWireChunk({ type: 'something-new' }).kind).toBe('unreadable');
    expect(parseWireChunk(null).kind).toBe('unreadable');
    expect(parseWireChunk(42).kind).toBe('unreadable');
    expect(parseWireChunk({ noType: true }).kind).toBe('unreadable');
  });

  test('meta carries no assistant id, and says so', () => {
    const chunk = parseWireChunk({
      type: 'meta',
      conversationId: 'c1',
      userMessageId: 'm1',
      title: 'New chat',
      generationId: 'gen-1234567890',
    });

    expect(chunk).toEqual({
      kind: 'meta',
      conversationId: 'c1',
      userMessageId: 'm1',
      title: 'New chat',
      /* Absent on the wire — the caller decides, and the frame says nothing. */
      titleSource: null,
      generationId: 'gen-1234567890',
    });
    expect(chunk).not.toHaveProperty('assistantMessageId');
  });

  test('a title frame with no titleSource is the auto-titler', () => {
    const chunk = parseWireChunk({ type: 'title', conversationId: 'c1', title: 'Kettles' });
    expect(chunk).toEqual({ kind: 'title', conversationId: 'c1', title: 'Kettles', titleSource: 'ai' });
  });

  test('done nests the three flat usage fields and keeps the server ids', () => {
    const chunk = parseWireChunk({
      type: 'done',
      finishReason: 'stop',
      message: {
        id: 'srv-1',
        role: 'ASSISTANT',
        content: 'answer',
        createdAt: '2026-08-13T00:00:00.000Z',
        promptTokens: 120,
        completionTokens: 8,
        costUsd: 0.0004,
      },
    });

    expect(chunk.kind).toBe('done');
    const done = chunk as Extract<WireChunk, { kind: 'done' }>;
    expect(done.message.id).toBe('srv-1');
    expect(done.message.usage).toEqual({ promptTokens: 120, completionTokens: 8, costUsd: 0.0004 });
    /* Not on the wire at all — `serializeMessage` never sends it. */
    expect(done.message.reasoningEffort).toBeNull();
    expect(done.finishReason).toBe('stop');
  });

  test('an unknown finish reason becomes `unknown`, an absent one stays null', () => {
    const unknown = parseWireChunk({ type: 'error', message: 'no', finishReason: 'meteorite' });
    expect((unknown as Extract<WireChunk, { kind: 'error' }>).finishReason).toBe('unknown');

    const absent = parseWireChunk({ type: 'error', message: 'no' });
    expect((absent as Extract<WireChunk, { kind: 'error' }>).finishReason).toBeNull();
  });

  test('an approval is its own outcome — the turn is blocked, not merely noisy', () => {
    expect(parseWireChunk({ type: 'approval', approval: {} }).kind).toBe('approval');
  });
});

describe('entity mappings', () => {
  const wireConversation = {
    id: 'c1',
    title: 'Kettles',
    titleSource: 'manual',
    model: 'anthropic:claude-sonnet-5',
    pinned: false,
    archivedAt: null,
    lastMessageAt: '2026-08-13T00:00:00.000Z',
    createdAt: '2026-08-12T00:00:00.000Z',
  };

  test('a listed conversation reports no preview rather than a made-up one', () => {
    const conversation = toConversation(wireConversation);
    expect(conversation.preview).toBe('');
    expect(conversation.messageCount).toBe(0);
  });

  test('a titleSource this build does not know falls back instead of failing', () => {
    const conversation = toConversation({ ...wireConversation, titleSource: 'astrology' });
    expect(conversation.titleSource).toBe('default');
  });

  test('previewOf collapses whitespace, skips empty turns and truncates', () => {
    const message = (id: string, content: string) =>
      toMessage({
        id,
        role: 'ASSISTANT',
        content,
        createdAt: '2026-08-13T00:00:00.000Z',
      });

    expect(previewOf([message('a', 'first'), message('b', '  spread\n\nout  ')])).toBe('spread out');
    /* An empty trailing bubble (a turn that failed) must not blank the row. */
    expect(previewOf([message('a', 'kept'), message('b', '   ')])).toBe('kept');
    expect(previewOf([])).toBe('');

    const long = previewOf([message('a', 'x'.repeat(400))]);
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
  });

  test('usage is null when the server reported none of it', () => {
    const message = toMessage({
      id: 'm1',
      role: 'USER',
      content: 'hello',
      createdAt: '2026-08-13T00:00:00.000Z',
    });
    expect(message.usage).toBeNull();
    expect(message.attachments).toEqual([]);
    expect(message.sources).toEqual([]);
  });

  test('a non-image attachment is given no URL to render', () => {
    const message = toMessage({
      id: 'm1',
      role: 'USER',
      content: '',
      createdAt: '2026-08-13T00:00:00.000Z',
      attachments: [
        {
          id: 'a1',
          kind: 'FILE',
          fileName: 'notes.pdf',
          mimeType: 'application/pdf',
          size: 10,
          url: '/api/files/uploads/secret-key.pdf',
        },
      ],
    });
    expect(message.attachments[0]?.url).toBe('');
  });
});

describe('model catalogue', () => {
  const base = {
    id: 'anthropic:claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    provider: { id: 'anthropic', displayName: 'Anthropic' },
    modality: 'chat',
    availability: 'available',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    reasoning: { supported: true, canDisable: true },
    capabilities: { vision: true },
    contextWindowTokens: 200_000,
  };

  test('an available model is selectable and keeps its tiers', () => {
    const descriptor = toModelDescriptor(base);
    expect(descriptor.lockedReason).toBeNull();
    expect(descriptor.reasoningTiers).toEqual(['low', 'medium', 'high']);
    expect(descriptor.provider).toBe('Anthropic');
    expect(descriptor.canDisableReasoning).toBe(true);
    expect(descriptor.contextWindow).toBe(200_000);
  });

  test('a tier this build has never heard of is dropped, not fatal', () => {
    const descriptor = toModelDescriptor({
      ...base,
      supportedReasoningEfforts: ['low', 'transcendent', 'max'],
    });
    expect(descriptor.reasoningTiers).toEqual(['low', 'max']);
  });

  test('every unavailable state produces a reason the picker can show', () => {
    expect(toModelDescriptor({ ...base, availability: 'requires_plan', requiredPlan: 'pro' }).lockedReason)
      .toBe('Included with the PRO plan.');
    expect(toModelDescriptor({ ...base, availability: 'coming_soon' }).lockedReason).toBe(
      'Not available yet.',
    );
    expect(
      toModelDescriptor({
        ...base,
        availability: 'health_check_failed',
        availabilityReason: 'Provider is failing health checks.',
      }).lockedReason,
    ).toBe('Provider is failing health checks.');
  });

  test('pickDefaultModel never opens the composer on a model the account cannot call', () => {
    const models = [
      { id: 'a:locked', lockedReason: 'Included with the PRO plan.' },
      { id: 'b:open', lockedReason: null },
      { id: 'c:open', lockedReason: null },
    ];

    expect(pickDefaultModel(models, 'c:open')).toBe('c:open');
    expect(pickDefaultModel(models, 'a:locked')).toBe('b:open');
    expect(pickDefaultModel(models, 'z:missing')).toBe('b:open');
    expect(pickDefaultModel([], null)).toBe('anthropic:claude-sonnet-5');
  });
});

describe('isRetryableFinish', () => {
  test('does not invite the user to run the same request into the same wall', () => {
    expect(isRetryableFinish('model_context_window_exceeded')).toBe(false);
    expect(isRetryableFinish('sensitive')).toBe(false);
    expect(isRetryableFinish('user_stopped')).toBe(false);
    expect(isRetryableFinish('network_error')).toBe(true);
    expect(isRetryableFinish(null)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Attachment validation                                                    */
/* -------------------------------------------------------------------------- */

describe('decodeDroppedFile', () => {
  const bytes = Buffer.from('hello world', 'utf8');
  const good = {
    fileName: 'note.txt',
    mimeType: 'text/plain',
    size: bytes.byteLength,
    data: bytes.toString('base64'),
  };

  test('accepts a well-formed drop', () => {
    const result = decodeDroppedFile(good);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.file.bytes).toString('utf8')).toBe('hello world');
    expect(result.file.fileName).toBe('note.txt');
  });

  test('refuses a payload whose length disagrees with the size the UI showed', () => {
    const result = decodeDroppedFile({ ...good, size: good.size + 1 });
    expect(result.ok).toBe(false);
  });

  test('refuses something that is not base64 rather than silently truncating it', () => {
    /* `Buffer.from(x, 'base64')` discards what it cannot read, so without an
       explicit check this uploads as a shorter, valid-looking file. */
    const result = decodeDroppedFile({ ...good, data: 'not base64 !!!' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('base64');
  });

  test('refuses an empty file and an oversized one', () => {
    expect(decodeDroppedFile({ ...good, size: 0, data: '' }).ok).toBe(false);
    expect(decodeDroppedFile({ ...good, size: 40 * 1024 * 1024 }).ok).toBe(false);
  });

  test('tolerates a data: URL from a renderer that used readAsDataURL', () => {
    const result = decodeDroppedFile({ ...good, data: `data:text/plain;base64,${good.data}` });
    expect(result.ok).toBe(true);
  });

  test('keeps only a basename, so no directory can be echoed back', () => {
    const result = decodeDroppedFile({ ...good, fileName: '/Users/someone/Secret Folder/note.txt' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.fileName).toBe('note.txt');
  });
});

describe('safeFileName', () => {
  test('strips directories, traversal, control characters and bidi overrides', () => {
    expect(safeFileName('/etc/passwd')).toBe('passwd');
    expect(safeFileName('../../secrets.env')).toBe('secrets.env');
    expect(safeFileName('..')).toBe('');
    expect(safeFileName('re port.pdf')).toBe('report.pdf');
    expect(safeFileName('invoice‮gnp.exe')).toBe('invoicegnp.exe');
    expect(safeFileName('x'.repeat(400)).length).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The turn state machine                                                   */
/* -------------------------------------------------------------------------- */

const ORIGIN = 'https://chat.example.test';

const silentLogger: ChannelLogger = {
  channel: 'provider',
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function tokenSource(token = 'test-token-value'): AccessTokenSource {
  const secret = new SecretString(token);
  return {
    current: () => Promise.resolve(secret),
    afterUnauthorized: () => Promise.resolve(secret),
    reportTerminalRejection: () => undefined,
  };
}

/** An SSE response whose body this test drives frame by frame. */
function sseResponse(signal: AbortSignal | undefined): {
  response: Response;
  send: (chunk: string) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  /* Real `fetch` errors the body when the request signal aborts. Without this
     an abort would look like a stream that simply never produced anything. */
  signal?.addEventListener('abort', () => {
    try {
      controller?.error(new Error('aborted'));
    } catch {
      /* already closed */
    }
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }),
    send: (chunk) => controller?.enqueue(encoder.encode(chunk)),
    close: () => {
      try {
        controller?.close();
      } catch {
        /* already closed */
      }
    },
  };
}

interface Harness {
  service: ChatService;
  events: { channel: string; payload: unknown }[];
  frames: () => StreamFrame[];
  stream: () => ReturnType<typeof sseResponse>;
  requests: string[];
}

function harness(options: { onChat?: () => Response } = {}): Harness {
  const events: { channel: string; payload: unknown }[] = [];
  const requests: string[] = [];
  let live: ReturnType<typeof sseResponse> | null = null;

  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);

    if (url.pathname === '/api/chat') {
      if (options.onChat) return Promise.resolve(options.onChat());
      live = sseResponse(init?.signal ?? undefined);
      return Promise.resolve(live.response);
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, cancelled: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  const transport = new JunoTransport({
    origin: ORIGIN,
    appVersion: '0.0.0-test',
    fetchImpl,
    logger: silentLogger,
  });

  const service = new ChatService({
    transport,
    tokens: tokenSource(),
    emit: (channel, payload) => events.push({ channel, payload }),
    logger: silentLogger,
    fetchImpl,
    picker: { pick: () => Promise.resolve([]) },
  });

  return {
    service,
    events,
    requests,
    frames: () =>
      events
        .filter((event) => event.channel === 'chat:stream')
        .map((event) => (event.payload as { frame: StreamFrame }).frame),
    stream: () => {
      if (live === null) throw new Error('no stream was opened');
      return live;
    },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const isTerminal = (frame: StreamFrame): boolean => frame.type === 'done' || frame.type === 'error';

describe('ChatService turns', () => {
  test('every frame of a turn is keyed on the id chat:send returned', async () => {
    const h = harness();

    const admission = await h.service.send({
      conversationId: 'c1',
      clientMessageId: 'client-1',
      text: 'hello',
      attachmentIds: [],
      model: 'anthropic:claude-sonnet-5',
      reasoningEffort: 'medium',
    });

    expect(admission.conversationId).toBe('c1');
    expect(admission.assistantMessageId).not.toHaveLength(0);

    await waitFor(() => h.requests.includes('POST /api/chat'), 'the chat request');
    const stream = h.stream();
    stream.send('data: {"type":"meta","conversationId":"c1","userMessageId":"u1","title":"New chat"}\n\n');
    stream.send('data: {"type":"ping"}\n\n');
    stream.send('data: {"type":"delta","text":"Hi "}\n\ndata: {"type":"delta","text":"there"}\n\n');
    stream.send(
      'data: {"type":"done","finishReason":"stop","message":' +
        '{"id":"srv-9","role":"ASSISTANT","content":"Hi there","createdAt":"2026-08-13T00:00:00.000Z"}}\n\n',
    );

    await waitFor(() => h.frames().some(isTerminal), 'the terminal frame');

    const envelopes = h.events.filter((event) => event.channel === 'chat:stream');
    for (const envelope of envelopes) {
      const payload = envelope.payload as { conversationId: string; assistantMessageId: string };
      expect(payload.conversationId).toBe('c1');
      /* The renderer drops any frame whose id is not the one it was given. */
      expect(payload.assistantMessageId).toBe(admission.assistantMessageId);
    }

    const frames = h.frames();
    /* The heartbeat never reaches the renderer. */
    expect(frames.map((frame) => frame.type)).toEqual(['meta', 'delta', 'delta', 'done']);

    const meta = frames[0];
    expect(meta?.type).toBe('meta');
    if (meta?.type === 'meta') {
      /* Synthesized: the wire's meta has no assistant id. */
      expect(meta.assistantMessageId).toBe(admission.assistantMessageId);
      expect(meta.userMessageId).toBe('u1');
      expect(meta.titleSource).toBeNull();
    }

    const done = frames[3];
    if (done?.type === 'done') {
      /* The server's real id arrives here, and replaces ours in the store. */
      expect(done.message.id).toBe('srv-9');
      expect(done.finishReason).toBe('stop');
    }
  });

  test('a second send for the same conversation is refused, not queued', async () => {
    const h = harness();
    await h.service.send({
      conversationId: 'c1',
      clientMessageId: 'client-1',
      text: 'first',
      attachmentIds: [],
      model: 'm',
      reasoningEffort: null,
    });

    await expect(
      h.service.send({
        conversationId: 'c1',
        clientMessageId: 'client-2',
        text: 'second',
        attachmentIds: [],
        model: 'm',
        reasoningEffort: null,
      }),
    ).rejects.toThrow(/still answering/i);
  });

  test('a repeated clientMessageId returns the first admission and starts no second turn', async () => {
    const h = harness();
    const request = {
      conversationId: 'c1',
      clientMessageId: 'client-1',
      text: 'hello',
      attachmentIds: [] as string[],
      model: 'm',
      reasoningEffort: null,
    };

    const first = await h.service.send(request);
    const second = await h.service.send(request);

    expect(second).toEqual(first);
    await waitFor(() => h.requests.includes('POST /api/chat'), 'the chat request');
    expect(h.requests.filter((entry) => entry === 'POST /api/chat')).toHaveLength(1);
  });

  test('a dropped stream ends the turn instead of leaving it streaming forever', async () => {
    const h = harness();
    await h.service.send({
      conversationId: 'c1',
      clientMessageId: 'client-1',
      text: 'hello',
      attachmentIds: [],
      model: 'm',
      reasoningEffort: null,
    });

    await waitFor(() => h.requests.includes('POST /api/chat'), 'the chat request');
    const stream = h.stream();
    stream.send('data: {"type":"delta","text":"partial"}\n\n');
    stream.close(); // no `done`, no `error` — the socket simply ends

    await waitFor(() => h.frames().some(isTerminal), 'the terminal frame');

    const terminal = h.frames().find(isTerminal);
    expect(terminal?.type).toBe('error');
    if (terminal?.type === 'error') {
      expect(terminal.finishReason).toBe('network_error');
      /* Text arrived, so it is kept rather than thrown away. */
      expect(terminal.preservePartial).toBe(true);
      expect(terminal.retryable).toBe(true);
    }
  });

  test('stop is idempotent, keeps the partial answer, and ends the turn exactly once', async () => {
    const h = harness();
    await h.service.send({
      conversationId: 'c1',
      clientMessageId: 'client-1',
      text: 'hello',
      attachmentIds: [],
      model: 'm',
      reasoningEffort: null,
    });

    await waitFor(() => h.requests.includes('POST /api/chat'), 'the chat request');
    h.stream().send('data: {"type":"delta","text":"half an ans"}\n\n');
    await waitFor(() => h.frames().length > 0, 'the first delta');

    await expect(h.service.stop({ conversationId: 'c1' })).resolves.toEqual({ ok: true });
    /* Idempotent: a second stop, and a stop for a conversation that is not
       generating at all, both succeed and change nothing. */
    await expect(h.service.stop({ conversationId: 'c1' })).resolves.toEqual({ ok: true });
    await expect(h.service.stop({ conversationId: 'never-started' })).resolves.toEqual({ ok: true });

    await waitFor(() => h.frames().some(isTerminal), 'the terminal frame');

    const terminals = h.frames().filter(isTerminal);
    expect(terminals).toHaveLength(1);
    const terminal = terminals[0];
    if (terminal?.type === 'error') {
      expect(terminal.finishReason).toBe('user_stopped');
      /* Discarding half an answer because the user stopped it would defeat the
         entire point of the button. */
      expect(terminal.preservePartial).toBe(true);
    }
    expect(h.requests).toContain('POST /api/chat/cancel');

    /* And the conversation is free again. */
    await expect(
      h.service.send({
        conversationId: 'c1',
        clientMessageId: 'client-2',
        text: 'again',
        attachmentIds: [],
        model: 'm',
        reasoningEffort: null,
      }),
    ).resolves.toMatchObject({ conversationId: 'c1' });
  });

  test('an approval frame ends the turn with an explanation rather than hanging', async () => {
    const h = harness();
    await h.service.send({
      conversationId: 'c1',
      clientMessageId: 'client-1',
      text: 'hello',
      attachmentIds: [],
      model: 'm',
      reasoningEffort: null,
    });

    await waitFor(() => h.requests.includes('POST /api/chat'), 'the chat request');
    h.stream().send('data: {"type":"approval","approval":{"id":"a1"}}\n\n');

    await waitFor(() => h.frames().some(isTerminal), 'the terminal frame');
    const terminal = h.frames().find(isTerminal);
    expect(terminal?.type).toBe('error');
    if (terminal?.type === 'error') {
      expect(terminal.message).toMatch(/approve a connector action/i);
      expect(terminal.retryable).toBe(false);
    }
  });

  test('a non-2xx from /api/chat becomes one terminal error carrying the server sentence', async () => {
    const h = harness({
      onChat: () =>
        new Response(JSON.stringify({ error: "You're sending messages too quickly. Please slow down." }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await h.service.send({
      conversationId: 'c1',
      clientMessageId: 'client-1',
      text: 'hello',
      attachmentIds: [],
      model: 'm',
      reasoningEffort: null,
    });

    await waitFor(() => h.frames().some(isTerminal), 'the terminal frame');
    const terminal = h.frames().find(isTerminal);
    if (terminal?.type === 'error') {
      expect(terminal.message).toMatch(/too quickly/i);
      expect(terminal.preservePartial).toBe(false);
    }
    expect(h.frames().filter(isTerminal)).toHaveLength(1);
  });

  test('dispose ends every running turn', async () => {
    const h = harness();
    await h.service.send({
      conversationId: 'c1',
      clientMessageId: 'client-1',
      text: 'hello',
      attachmentIds: [],
      model: 'm',
      reasoningEffort: null,
    });
    await waitFor(() => h.requests.includes('POST /api/chat'), 'the chat request');

    h.service.dispose('You signed out of Juno.');

    const terminals = h.frames().filter(isTerminal);
    expect(terminals).toHaveLength(1);
    if (terminals[0]?.type === 'error') {
      expect(terminals[0].message).toBe('You signed out of Juno.');
    }
  });
});

describe('ChatService when signed out', () => {
  test('says so, rather than failing with something opaque', async () => {
    const notSignedIn = new Error('No Juno account is signed in on this device.');
    notSignedIn.name = 'NotSignedInError';

    const transport = new JunoTransport({
      origin: ORIGIN,
      appVersion: '0.0.0-test',
      fetchImpl: () => Promise.reject(new Error('the network must not be reached')),
      logger: silentLogger,
    });

    const service = new ChatService({
      transport,
      tokens: {
        current: () => Promise.reject(notSignedIn),
        afterUnauthorized: () => Promise.reject(notSignedIn),
        reportTerminalRejection: () => undefined,
      },
      emit: () => undefined,
      logger: silentLogger,
      picker: { pick: () => Promise.resolve([]) },
    });

    await expect(
      service.listConversations({ query: '', includeArchived: false, limit: 200 }),
    ).rejects.toThrow(/Sign in to your Juno account/i);

    await expect(service.models()).rejects.toThrow(/Sign in to your Juno account/i);
  });
});
