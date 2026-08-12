/**
 * The Chat surface's main-process service.
 *
 * One class, one method per invoke channel in
 * `src/shared/contracts/chat.ts`, plus three pushed events. It owns every piece
 * of chat state that lives in main: which conversations have been seen, which
 * turns are running, and whether the backend is reachable.
 *
 * ============================================================================
 * THE ROUTES, AS THEY ACTUALLY ARE
 *
 * Verified against the Next app in this repository, not against a plan:
 *
 *   GET    /api/conversations?q=            → {conversations: ClientConversation[]}
 *   POST   /api/conversations               → {conversation}                 (201)
 *   GET    /api/conversations/{id}          → {conversation, messages, artifacts}
 *   PATCH  /api/conversations/{id}          → {conversation}
 *   DELETE /api/conversations/{id}          → {ok: true}
 *   POST   /api/conversations/{id}/fork     → {conversation}
 *   PATCH  /api/messages/{id}               → {ok, version}
 *   POST   /api/chat                        → text/event-stream
 *   POST   /api/chat/cancel                 → {ok, cancelled}
 *   GET    /api/v1/models                   → {models: [...], manifestVersion}
 *   GET    /api/settings                    → {settings: {defaultModel, …}}
 *   POST   /api/v1/attachments              → {attachment}                   (201)
 *
 * **Conversation CRUD is not under `/api/v1`.** Only the model catalogue and
 * the attachment upload are. One bearer authenticates all of it:
 * `getCurrentUser()` in `src/lib/session.ts` reads the `Authorization` header
 * first and never falls back to a cookie.
 * ============================================================================
 *
 * ## Four decisions that are not obvious from the contract
 *
 * **1. A new conversation is created before the turn starts.**
 * `chat:send` must answer with a real `conversationId` — the renderer takes it
 * straight to `chat:get-conversation`, and its stream subscription drops any
 * frame whose `conversationId` is not the one it is showing. `POST /api/chat`
 * would eventually reveal the id on the `meta` frame, which is far too late. So
 * a `null` conversationId is turned into a real one with `POST
 * /api/conversations` first, and the turn is sent against it.
 *
 * The cost is exact and worth naming: the backend's durable idempotency pair
 * (`clientRequestId` + `clientMessageId`) is **only accepted for a submission
 * with no `conversationId`** — `clientSubmissionMetadataIssue` in
 * `src/lib/chat-origin.ts` rejects the pair outright otherwise. Pre-creating
 * therefore forfeits it, and the contract's `clientMessageId` is honoured
 * locally instead: a repeated `chat:send` with a key that is already in flight
 * returns the original admission rather than starting a second turn. That
 * covers the case the field exists for (a double-submit or a resend after a
 * dropped reply) and does not cover a crash between the POST and the reply,
 * which the server-side receipt would have.
 *
 * **2. `assistantMessageId` is ours, not the server's.**
 * The wire's `meta` frame carries `conversationId` and `userMessageId` and *no
 * assistant id* — the assistant row does not exist yet. The renderer needs one
 * immediately (it keys every frame on the value `chat:send` returned), so main
 * mints one and stamps it on every frame of the turn. The server's real id
 * arrives inside `done.message.id`, which is the frame the contract already
 * defines as authoritative: "REPLACES the locally accumulated one".
 *
 * **3. A turn always ends.** Exactly one terminal frame — `done` or `error` —
 * is emitted for every turn, from every exit path: a clean finish, a dropped
 * socket, an idle stream, a stop, an abandoned generation at sign-out, a
 * response that was not a stream at all. `#emitFrame` enforces the "exactly
 * one" half by refusing to emit after a terminal. A spinner that never stops is
 * the failure this is built to make impossible.
 *
 * **4. One turn per conversation, refused rather than queued.** A second
 * `chat:send` for a conversation that is generating is rejected with a sentence
 * the composer can show. Queueing would mean the second message is sent against
 * a transcript the user has not seen yet, and silently.
 *
 * ## What is never logged
 *
 * No message text, no title, no attachment name, no path, no token, no URL with
 * a query string. Log lines carry ids, counts, statuses and frame *types*. The
 * logger redacts at the sink as well; this is the first control, not the only
 * one.
 */

import { randomUUID } from 'node:crypto';
import {
  CHAT_EVENT_CHANNELS,
  CHAT_INVOKE_CHANNELS,
  type ChatEventChannel,
  type ChatEventPayload,
  type ChatInvokeChannel,
  type ChatInvokeRequest,
  type ChatInvokeResponse,
  type ConnectionState,
  type Conversation,
  type FinishReason,
  type Message,
  type StreamFrame,
  type TitleSource,
} from '../../shared/contracts/chat.js';
import type { AccessTokenSource, JunoTransport, RequestSpec } from '../auth/transport.js';
import { NetworkError, TimeoutError } from '../auth/transport.js';
import { createLogger, type ChannelLogger } from '../logger.js';
import { RawJunoClient } from './http.js';
import { AnonymousSseReader } from './sse.js';
import {
  ChatServiceError,
  SignedOutError,
  TurnInFlightError,
  describeFailure,
  logFields,
} from './errors.js';
import {
  CancelResponseSchema,
  ConversationListResponseSchema,
  ConversationResponseSchema,
  ConversationThreadResponseSchema,
  MessageEditResponseSchema,
  ModelManifestResponseSchema,
  OkResponseSchema,
  SettingsResponseSchema,
  isRetryableFinish,
  isSelectableChatModel,
  parseWireChunk,
  previewOf,
  toConversation,
  toMessage,
  toModelDescriptor,
  type WireChunk,
} from './wire.js';
import {
  MAX_ATTACHMENTS,
  allRefusedError,
  decodeDroppedFile,
  inlineImageUrl,
  nativeAttachmentPicker,
  newInlineBudget,
  readPickedFile,
  safeFileName,
  uploadAttachment,
  type AttachmentPicker,
  type PreparedFile,
  type RejectedFile,
} from './attachments.js';
import type { Attachment } from '../../shared/contracts/chat.js';

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How long a stream may produce nothing before it is treated as dead.
 *
 * `/api/chat` sends `{"type":"ping"}` every 15 seconds precisely so that a
 * silent model does not look like a dead socket. Six missed heartbeats is a
 * dead socket.
 */
const STREAM_IDLE_MS = 90_000;

/**
 * The ceiling on an unterminated SSE frame.
 *
 * A `done` frame carries a whole assistant message, so this cannot be small;
 * 8 MiB is far beyond any real one and still bounds a server (or a proxy) that
 * streams without ever emitting a frame boundary.
 */
const MAX_PENDING_FRAME_BYTES = 8 * 1024 * 1024;

/** Conversations kept for title patching and `chat:conversation-changed`. */
const CONVERSATION_CACHE_LIMIT = 400;

/** How long an admitted `clientMessageId` suppresses a duplicate submission. */
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const IDEMPOTENCY_LIMIT = 64;

/** Durable creation surface for turns this app starts. See `chat-origin.ts`. */
const CHAT_ORIGIN = 'main_macos';

/** Used only when the catalogue is empty and settings named nothing usable. */
const FALLBACK_MODEL = 'anthropic:claude-sonnet-5';

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

/** Pushes one event to the renderer. Implemented in `index.ts` over the bridge. */
export type ChatEventSink = <C extends ChatEventChannel>(
  channel: C,
  payload: ChatEventPayload<C>,
) => void;

export interface ChatServiceOptions {
  readonly transport: JunoTransport;
  readonly tokens: AccessTokenSource;
  readonly emit: ChatEventSink;
  readonly logger?: ChannelLogger;
  /** Injected so unit tests never load Electron. Defaults to the real dialog. */
  readonly picker?: AttachmentPicker;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/** One generation in flight. Exactly one per conversation. */
interface ActiveTurn {
  readonly conversationId: string;
  /** Minted here; stamped on every frame of this turn. */
  readonly assistantMessageId: string;
  /** Sent to `/api/chat` and used by `/api/chat/cancel`. */
  generationId: string;
  readonly controller: AbortController;
  /** The user asked to stop. Distinguishes a deliberate abort from a failure. */
  stopping: boolean;
  /** The stream went quiet for longer than `STREAM_IDLE_MS`. */
  idle: boolean;
  /** Any answer or reasoning text arrived — decides `preservePartial`. */
  sawContent: boolean;
  /** A terminal frame has been emitted. Guarantees there is never a second. */
  settled: boolean;
}

interface AdmittedTurn {
  readonly conversationId: string;
  readonly assistantMessageId: string;
  readonly expiresAt: number;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export class ChatService {
  readonly #transport: JunoTransport;
  readonly #tokens: AccessTokenSource;
  readonly #emit: ChatEventSink;
  readonly #log: ChannelLogger;
  readonly #raw: RawJunoClient;
  readonly #picker: AttachmentPicker;
  readonly #now: () => number;

  readonly #turns = new Map<string, ActiveTurn>();
  readonly #admitted = new Map<string, AdmittedTurn>();
  readonly #conversations = new Map<string, Conversation>();

  #connection: ConnectionState = { status: 'online', detail: null, retryInSeconds: null };
  #connectionKnown = false;
  #disposed = false;

  constructor(options: ChatServiceOptions) {
    this.#transport = options.transport;
    this.#tokens = options.tokens;
    this.#emit = options.emit;
    this.#log = options.logger ?? createLogger('provider');
    this.#picker = options.picker ?? nativeAttachmentPicker;
    this.#now = options.now ?? (() => Date.now());
    this.#raw = new RawJunoClient({
      origin: options.transport.origin,
      contractVersion: options.transport.contractVersion,
      tokens: options.tokens,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Conversations                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * `includeArchived` cannot be honoured, and is not faked.
   *
   * `GET /api/conversations` reads only `q` and `folderId` from the query
   * string; `listConversations` defaults to `archived: "exclude"` and the route
   * never passes anything else. There is no endpoint that returns archived
   * conversations, so asking for them returns the unarchived ones — the same
   * list, never a fabricated one. Archiving still works (`chat:update-conversation`
   * PATCHes `archived`), and an archived row simply leaves the list.
   */
  async listConversations(
    request: ChatInvokeRequest<'chat:list-conversations'>,
  ): Promise<ChatInvokeResponse<'chat:list-conversations'>> {
    const query = request.query.trim();
    const path = query.length === 0
      ? '/api/conversations'
      : `/api/conversations?${new URLSearchParams({ q: query }).toString()}`;

    const data = await this.#api(
      { path, method: 'GET', schema: ConversationListResponseSchema },
      'load your conversations',
    );

    if (request.includeArchived) {
      this.#log.debug('chat: archived conversations were requested but the backend has no such filter');
    }

    const conversations = data.conversations
      .slice(0, request.limit)
      .map((wire) => this.#remember(toConversation(wire)));

    return reply('chat:list-conversations', { conversations });
  }

  async getConversation(
    request: ChatInvokeRequest<'chat:get-conversation'>,
  ): Promise<ChatInvokeResponse<'chat:get-conversation'>> {
    const data = await this.#api(
      {
        path: `/api/conversations/${encodeURIComponent(request.conversationId)}`,
        method: 'GET',
        schema: ConversationThreadResponseSchema,
        timeoutMs: 30_000,
      },
      'open that conversation',
    );

    const messages = await this.#inlineImages(data.messages.map(toMessage));
    const conversation = this.#remember(
      toConversation(data.conversation, {
        preview: previewOf(messages),
        messageCount: messages.length,
      }),
    );

    return reply('chat:get-conversation', {
      conversation,
      messages,
      /* Honest and local: the only generation this process can observe is one
         it started. A turn running for this account in another window is not
         visible from here — there is no per-conversation "is generating"
         endpoint, only a receipt lookup keyed by a generation id we would not
         have. Reporting `true` on a guess would strand the transcript in a
         streaming state with nothing to stream. */
      generating: this.#turns.has(request.conversationId),
    });
  }

  /**
   * `POST /api/conversations` accepts no model, so a requested one is applied
   * with the PATCH that already exists for the composer's sticky model pick.
   */
  async createConversation(
    request: ChatInvokeRequest<'chat:create-conversation'>,
  ): Promise<ChatInvokeResponse<'chat:create-conversation'>> {
    const conversation = await this.#createConversation(request.model);
    return reply('chat:create-conversation', { conversation });
  }

  async updateConversation(
    request: ChatInvokeRequest<'chat:update-conversation'>,
  ): Promise<ChatInvokeResponse<'chat:update-conversation'>> {
    const body: Record<string, unknown> = {};
    if (request.title !== undefined) body['title'] = request.title;
    if (request.pinned !== undefined) body['pinned'] = request.pinned;
    if (request.archived !== undefined) body['archived'] = request.archived;

    const data = await this.#api(
      {
        path: `/api/conversations/${encodeURIComponent(request.conversationId)}`,
        method: 'PATCH',
        schema: ConversationResponseSchema,
        body,
      },
      'update that conversation',
    );

    const previous = this.#conversations.get(request.conversationId);
    const conversation = this.#remember(
      toConversation(data.conversation, {
        preview: previous?.preview ?? '',
        messageCount: previous?.messageCount ?? 0,
      }),
    );
    this.#publish('chat:conversation-changed', { kind: 'upsert', conversation });
    return reply('chat:update-conversation', { conversation });
  }

  async deleteConversation(
    request: ChatInvokeRequest<'chat:delete-conversation'>,
  ): Promise<ChatInvokeResponse<'chat:delete-conversation'>> {
    /* A delete while the conversation is generating would leave a stream
       writing into a thread that no longer exists. Stop first. */
    await this.stop({ conversationId: request.conversationId });

    await this.#api(
      {
        path: `/api/conversations/${encodeURIComponent(request.conversationId)}`,
        method: 'DELETE',
        schema: OkResponseSchema,
      },
      'delete that conversation',
    );

    this.#conversations.delete(request.conversationId);
    this.#publish('chat:conversation-changed', {
      kind: 'delete',
      conversationId: request.conversationId,
    });
    return reply('chat:delete-conversation', { ok: true });
  }

  async fork(request: ChatInvokeRequest<'chat:fork'>): Promise<ChatInvokeResponse<'chat:fork'>> {
    const data = await this.#api(
      {
        path: `/api/conversations/${encodeURIComponent(request.conversationId)}/fork`,
        method: 'POST',
        schema: ConversationResponseSchema,
        body: { atMessageId: request.messageId },
        timeoutMs: 30_000,
      },
      'branch that conversation',
    );

    const conversation = this.#remember(toConversation(data.conversation));
    this.#publish('chat:conversation-changed', { kind: 'upsert', conversation });
    return reply('chat:fork', { conversation });
  }

  /* ---------------------------------------------------------------------- */
  /* Turns                                                                   */
  /* ---------------------------------------------------------------------- */

  async send(request: ChatInvokeRequest<'chat:send'>): Promise<ChatInvokeResponse<'chat:send'>> {
    this.#assertUsable();

    const replayed = this.#replayAdmission(request.clientMessageId);
    if (replayed !== null) return reply('chat:send', replayed);

    if (request.text.trim().length === 0 && request.attachmentIds.length === 0) {
      throw new ChatServiceError('Write a message before sending.', false);
    }

    const conversationId =
      request.conversationId ?? (await this.#createConversation(request.model)).id;

    const turn = this.#beginTurn(conversationId);
    this.#recordAdmission(request.clientMessageId, turn);

    this.#start(turn, {
      conversationId,
      message: request.text,
      ...(request.attachmentIds.length === 0 ? {} : { attachmentIds: [...request.attachmentIds] }),
      model: request.model,
      /* `null` effort means Instant — thinking off — which the backend spells
         as an absent field. Sending `null` would fail its enum. */
      ...(request.reasoningEffort === null ? {} : { reasoningEffort: request.reasoningEffort }),
      generationId: turn.generationId,
      origin: CHAT_ORIGIN,
    });

    return reply('chat:send', {
      conversationId,
      assistantMessageId: turn.assistantMessageId,
    });
  }

  /**
   * Re-run the last assistant turn.
   *
   * `messageId` is carried by the contract but the backend's `regenerate` does
   * not take one: `POST /api/chat` with `regenerate: true` always re-runs the
   * trailing assistant message, preserving the previous answer as a
   * `MessageVersion`. Passing a `messageId` for an earlier turn would silently
   * regenerate a different message than the one the button was on, so this
   * refuses rather than mislead — the renderer only ever offers retry on the
   * last assistant bubble.
   */
  async retry(request: ChatInvokeRequest<'chat:retry'>): Promise<ChatInvokeResponse<'chat:retry'>> {
    this.#assertUsable();
    const turn = this.#beginTurn(request.conversationId);

    this.#start(turn, {
      conversationId: request.conversationId,
      regenerate: true,
      ...(request.model === null ? {} : { model: request.model }),
      ...(request.reasoningEffort === null ? {} : { reasoningEffort: request.reasoningEffort }),
      generationId: turn.generationId,
    });

    return reply('chat:retry', { assistantMessageId: turn.assistantMessageId });
  }

  /**
   * Rewrite a user message and re-run from there.
   *
   * Two calls, in this order and not the other: `PATCH /api/messages/{id}`
   * snapshots the previous wording as a `MessageVersion` **and deletes every
   * message after it**, then the regenerate runs against the truncated thread.
   * Starting the generation first would answer the old text.
   */
  async editMessage(
    request: ChatInvokeRequest<'chat:edit-message'>,
  ): Promise<ChatInvokeResponse<'chat:edit-message'>> {
    this.#assertUsable();
    if (request.text.trim().length === 0) {
      throw new ChatServiceError('An edited message cannot be empty.', false);
    }
    /* Claim the conversation before the edit lands: an edit that truncated the
       thread while another turn was streaming into it would leave the stream
       writing after the truncation point. */
    const turn = this.#beginTurn(request.conversationId);

    try {
      await this.#api(
        {
          path: `/api/messages/${encodeURIComponent(request.messageId)}`,
          method: 'PATCH',
          schema: MessageEditResponseSchema,
          body: { content: request.text },
        },
        'edit that message',
      );
    } catch (error) {
      this.#turns.delete(request.conversationId);
      throw error;
    }

    this.#start(turn, {
      conversationId: request.conversationId,
      regenerate: true,
      generationId: turn.generationId,
    });

    return reply('chat:edit-message', { assistantMessageId: turn.assistantMessageId });
  }

  /**
   * Stop the turn in this conversation. Idempotent, in every sense.
   *
   * Calling it with nothing running, twice in a row, or after the turn already
   * finished all return `{ok: true}` and change nothing. The server is told
   * first — `cancelGeneration` stops the provider call and saves the partial
   * answer — and the socket is aborted afterwards whether or not that call
   * succeeded, because a stop that depends on the network is not a stop.
   */
  async stop(request: ChatInvokeRequest<'chat:stop'>): Promise<ChatInvokeResponse<'chat:stop'>> {
    const turn = this.#turns.get(request.conversationId);
    if (turn === undefined || turn.stopping) return reply('chat:stop', { ok: true });

    turn.stopping = true;
    try {
      await this.#api(
        {
          path: '/api/chat/cancel',
          method: 'POST',
          schema: CancelResponseSchema,
          body: { generationId: turn.generationId },
          timeoutMs: 5_000,
        },
        'stop that response',
      );
    } catch (error) {
      /* Best effort. The local abort below is what the user actually asked
         for; the server-side cancel only saves it some work. */
      this.#log.warn('chat: server-side cancel did not complete', logFields(error));
    } finally {
      turn.controller.abort();
    }

    return reply('chat:stop', { ok: true });
  }

  /* ---------------------------------------------------------------------- */
  /* Catalogue                                                               */
  /* ---------------------------------------------------------------------- */

  async models(): Promise<ChatInvokeResponse<'chat:models'>> {
    const catalog = await this.#api(
      { path: '/api/v1/models', method: 'GET', schema: ModelManifestResponseSchema, timeoutMs: 20_000 },
      'load the model list',
    );

    /* The account's preferred default is a nicety, not a requirement: a
       failure here must not cost the user the whole picker. */
    let preferred: string | null = null;
    try {
      const settings = await this.#api(
        { path: '/api/settings', method: 'GET', schema: SettingsResponseSchema, timeoutMs: 10_000 },
        'load your settings',
      );
      preferred = settings.settings?.defaultModel ?? null;
    } catch (error) {
      this.#log.debug('chat: could not read the account default model', logFields(error));
    }

    const models = catalog.models.filter(isSelectableChatModel).map(toModelDescriptor);
    return reply('chat:models', { models, defaultModel: pickDefaultModel(models, preferred) });
  }

  /* ---------------------------------------------------------------------- */
  /* Attachments                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Open the native picker and upload what was chosen.
   *
   * Cancelling returns an empty list, not an error — a cancelled dialog is a
   * decision, not a failure. A file that cannot be used is dropped from the
   * result; if *every* chosen file was refused the call throws, because
   * returning an empty list there would look identical to cancelling.
   */
  async pickAttachments(
    request: ChatInvokeRequest<'chat:pick-attachments'>,
  ): Promise<ChatInvokeResponse<'chat:pick-attachments'>> {
    this.#assertUsable();

    const paths = await this.#picker.pick(request.accept);
    if (paths.length === 0) return reply('chat:pick-attachments', { attachments: [] });
    if (paths.length > MAX_ATTACHMENTS) {
      throw new ChatServiceError(`You can attach at most ${MAX_ATTACHMENTS} files at once.`, false);
    }

    const prepared: PreparedFile[] = [];
    const rejected: RejectedFile[] = [];
    for (const path of paths) {
      const result = await readPickedFile(path);
      if (result.ok) prepared.push(result.file);
      /* `safeFileName` and not the path: the directory never leaves main. */
      else rejected.push({ fileName: safeFileName(path), reason: result.reason });
    }

    const { attachments, failures } = await this.#uploadAll(prepared, request.conversationId);
    if (attachments.length === 0 && (rejected.length > 0 || failures.length > 0)) {
      throw allRefusedError([...rejected, ...failures]);
    }
    if (rejected.length > 0 || failures.length > 0) {
      this.#log.warn('chat: some chosen files were not attached', {
        refused: rejected.length,
        failed: failures.length,
      });
    }

    return reply('chat:pick-attachments', { attachments });
  }

  /** The drag-and-drop path. Every refusal is reported, per file, with a reason. */
  async receiveDroppedFiles(
    request: ChatInvokeRequest<'chat:receive-dropped-files'>,
  ): Promise<ChatInvokeResponse<'chat:receive-dropped-files'>> {
    this.#assertUsable();

    const rejected: RejectedFile[] = [];
    const prepared: PreparedFile[] = [];

    for (const [index, file] of request.files.entries()) {
      const fileName = safeFileName(file.fileName) || `file ${index + 1}`;
      if (index >= MAX_ATTACHMENTS) {
        rejected.push({ fileName, reason: `Only ${MAX_ATTACHMENTS} files can be attached at once.` });
        continue;
      }
      const decoded = decodeDroppedFile(file);
      if (decoded.ok) prepared.push(decoded.file);
      else rejected.push({ fileName, reason: decoded.reason });
    }

    const { attachments, failures } = await this.#uploadAll(prepared, request.conversationId);
    return reply('chat:receive-dropped-files', {
      attachments,
      rejected: [...rejected, ...failures],
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Abandon every running turn.
   *
   * Wired to `AuthSessionController.onTeardown` and to app shutdown. Each turn
   * gets a terminal `error` frame before its socket is dropped, so nothing is
   * left claiming to be streaming — which is exactly what the teardown contract
   * in `session.ts` requires of "every open SSE stream to the backend".
   */
  dispose(detail = 'The chat connection was closed.'): void {
    this.#disposed = true;
    for (const turn of [...this.#turns.values()]) {
      this.#emitFrame(turn, {
        type: 'error',
        message: detail,
        finishReason: 'error',
        preservePartial: turn.sawContent,
        retryable: true,
      });
      turn.controller.abort();
    }
    this.#turns.clear();
    this.#admitted.clear();
    this.#conversations.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Turn plumbing                                                           */
  /* ---------------------------------------------------------------------- */

  #assertUsable(): void {
    if (this.#disposed) throw new SignedOutError();
  }

  #beginTurn(conversationId: string): ActiveTurn {
    this.#assertUsable();
    if (this.#turns.has(conversationId)) throw new TurnInFlightError(conversationId);

    const turn: ActiveTurn = {
      conversationId,
      assistantMessageId: randomUUID(),
      generationId: randomUUID(),
      controller: new AbortController(),
      stopping: false,
      idle: false,
      sawContent: false,
      settled: false,
    };
    this.#turns.set(conversationId, turn);
    return turn;
  }

  /**
   * Start the generation *after* this call's reply has been handed back.
   *
   * The renderer keys incoming frames on the id returned by `chat:send`, and it
   * only learns that id when the invoke resolves. Deferring the request by one
   * turn of the event loop means the reply is on its way before the first byte
   * can possibly arrive — a frame emitted synchronously here would be measured
   * against the renderer's optimistic id and dropped.
   */
  #start(turn: ActiveTurn, body: Record<string, unknown>): void {
    setImmediate(() => {
      void this.#runTurn(turn, body);
    });
  }

  async #runTurn(turn: ActiveTurn, body: Record<string, unknown>): Promise<void> {
    try {
      const response = await this.#raw.openEventStream('/api/chat', body, turn.controller.signal);
      this.#setConnection({ status: 'online', detail: null, retryInSeconds: null });
      await this.#pump(turn, response);

      if (!turn.settled) {
        /* The socket closed without a terminal frame. The generation may well
           still be running server-side — `/api/chat` deliberately continues
           after a client disconnects — but this build has no re-attach path,
           so the honest report is that the connection dropped and the partial
           text is worth keeping. */
        this.#emitFrame(turn, {
          type: 'error',
          message:
            'The connection to Juno dropped before the response finished. The answer may still be saved — reopen the conversation to check.',
          finishReason: 'network_error',
          preservePartial: turn.sawContent,
          retryable: true,
        });
      }
    } catch (error) {
      this.#emitTerminalFailure(turn, error);
    } finally {
      if (this.#turns.get(turn.conversationId) === turn) {
        this.#turns.delete(turn.conversationId);
      }
    }
  }

  /**
   * Read the stream.
   *
   * The idle watchdog is a rearmed timer rather than a check after each read,
   * because `reader.read()` on a silent socket never returns and a check that
   * runs after it would never run at all.
   */
  async #pump(turn: ActiveTurn, response: Response): Promise<void> {
    const body = response.body;
    if (body === null) throw new ChatServiceError('Juno opened a response stream with no content.');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new AnonymousSseReader();

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const rearm = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        turn.idle = true;
        turn.controller.abort();
      }, STREAM_IDLE_MS);
      idleTimer.unref?.();
    };

    try {
      rearm();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rearm();

        const { values, malformed } = parser.push(decoder.decode(value, { stream: true }));
        if (malformed > 0) {
          this.#log.warn('chat: dropped malformed stream frames', { count: malformed });
        }
        if (parser.pending > MAX_PENDING_FRAME_BYTES) {
          throw new ChatServiceError('Juno sent a response frame larger than this app will read.');
        }

        for (const raw of values) {
          const finished = await this.#applyChunk(turn, parseWireChunk(raw));
          if (finished) return;
        }
      }
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      try {
        await reader.cancel();
      } catch {
        /* Already torn down. */
      }
    }
  }

  /** Apply one chunk. Returns true when the turn is over. */
  async #applyChunk(turn: ActiveTurn, chunk: WireChunk): Promise<boolean> {
    switch (chunk.kind) {
      case 'meta': {
        /* Prefer the id the server echoed: cancellation must name the
           generation the server knows about, not the one we asked for. */
        if (chunk.generationId !== null && chunk.generationId.length >= 8) {
          turn.generationId = chunk.generationId;
        }
        this.#patchTitle(chunk.conversationId, chunk.title, chunk.titleSource);
        this.#emitFrame(turn, {
          type: 'meta',
          conversationId: chunk.conversationId,
          userMessageId: chunk.userMessageId,
          /* Ours. The wire's `meta` has no assistant id — see the header. */
          assistantMessageId: turn.assistantMessageId,
          title: chunk.title,
          titleSource: chunk.titleSource,
        });
        return false;
      }

      case 'title': {
        this.#patchTitle(chunk.conversationId, chunk.title, chunk.titleSource);
        this.#emitFrame(turn, {
          type: 'title',
          conversationId: chunk.conversationId,
          title: chunk.title,
          titleSource: chunk.titleSource,
        });
        return false;
      }

      case 'reasoning': {
        turn.sawContent = true;
        this.#emitFrame(turn, { type: 'reasoning', text: chunk.text, part: chunk.part });
        return false;
      }

      case 'delta': {
        turn.sawContent = true;
        this.#emitFrame(turn, { type: 'delta', text: chunk.text });
        return false;
      }

      case 'sources': {
        this.#emitFrame(turn, { type: 'sources', sources: [...chunk.sources] });
        return false;
      }

      case 'done': {
        const [message] = await this.#inlineImages([chunk.message]);
        this.#emitFrame(turn, {
          type: 'done',
          message: message ?? chunk.message,
          finishReason: chunk.finishReason,
        });
        return true;
      }

      case 'error': {
        this.#emitFrame(turn, {
          type: 'error',
          message: chunk.message,
          finishReason: chunk.finishReason,
          /* The backend never sets `preservePartial` — the field exists in its
             own `StreamChunk` type and no code path writes it — so the decision
             is made here, where it is known whether any text arrived. Throwing
             away half an answer because the tail failed is the worse mistake. */
          preservePartial: turn.sawContent,
          retryable: isRetryableFinish(chunk.finishReason),
        });
        return true;
      }

      case 'approval': {
        /* The generation is genuinely blocked: the stream stays open until the
           person answers at `/api/approvals` or the receipt expires. This build
           has no approval surface, so it cannot be answered here. Ending the
           turn with an explanation is the only honest option — the alternative
           is a spinner that runs until the receipt times out with no way for
           the user to learn why. */
        turn.controller.abort();
        this.#emitFrame(turn, {
          type: 'error',
          message:
            'This response needs you to approve a connector action, which this version of Juno cannot show. Continue in the Juno web app.',
          finishReason: 'error',
          preservePartial: turn.sawContent,
          retryable: false,
        });
        return true;
      }

      case 'ignored':
        return false;

      case 'unreadable': {
        this.#log.warn('chat: unreadable stream frame', { type: chunk.type });
        return false;
      }

      default:
        return false;
    }
  }

  /** Turn a thrown failure into the turn's one terminal frame. */
  #emitTerminalFailure(turn: ActiveTurn, error: unknown): void {
    if (turn.stopping) {
      this.#emitFrame(turn, {
        type: 'error',
        message: 'You stopped this response.',
        finishReason: 'user_stopped',
        /* Never discard what already arrived because the user pressed Stop —
           keeping it is the entire reason they pressed it. */
        preservePartial: true,
        retryable: true,
      });
      return;
    }

    if (turn.idle) {
      this.#setConnection({
        status: 'offline',
        detail: 'Juno stopped sending data.',
        retryInSeconds: null,
      });
      this.#emitFrame(turn, {
        type: 'error',
        message: 'Juno stopped responding. The answer may still be saved — reopen the conversation to check.',
        finishReason: 'network_error',
        preservePartial: turn.sawContent,
        retryable: true,
      });
      return;
    }

    this.#noteTransportHealth(error);
    const failure = describeFailure(error, 'answer that message');
    this.#log.warn('chat: turn failed', logFields(error));
    this.#emitFrame(turn, {
      type: 'error',
      message: failure.message,
      finishReason: error instanceof NetworkError || error instanceof TimeoutError ? 'network_error' : 'error',
      preservePartial: turn.sawContent,
      retryable: failure.retryable,
    });
  }

  #emitFrame(turn: ActiveTurn, frame: StreamFrame): void {
    /* Exactly one terminal per turn, from every exit path. Without this a stop
       that races a server `done` would emit both, and the transcript would
       replace a finished answer with an error. */
    if (turn.settled) return;
    if (frame.type === 'done' || frame.type === 'error') turn.settled = true;

    this.#publish('chat:stream', {
      conversationId: turn.conversationId,
      assistantMessageId: turn.assistantMessageId,
      frame,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Idempotency                                                             */
  /* ---------------------------------------------------------------------- */

  #replayAdmission(clientMessageId: string): { conversationId: string; assistantMessageId: string } | null {
    const now = this.#now();
    for (const [key, entry] of this.#admitted) {
      if (entry.expiresAt <= now) this.#admitted.delete(key);
    }
    const existing = this.#admitted.get(clientMessageId);
    if (existing === undefined) return null;
    this.#log.info('chat: suppressed a duplicate submission', { conversationId: existing.conversationId });
    return {
      conversationId: existing.conversationId,
      assistantMessageId: existing.assistantMessageId,
    };
  }

  #recordAdmission(clientMessageId: string, turn: ActiveTurn): void {
    if (this.#admitted.size >= IDEMPOTENCY_LIMIT) {
      const oldest = this.#admitted.keys().next();
      if (!oldest.done) this.#admitted.delete(oldest.value);
    }
    this.#admitted.set(clientMessageId, {
      conversationId: turn.conversationId,
      assistantMessageId: turn.assistantMessageId,
      expiresAt: this.#now() + IDEMPOTENCY_TTL_MS,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Shared helpers                                                          */
  /* ---------------------------------------------------------------------- */

  async #createConversation(model: string | null): Promise<Conversation> {
    const created = await this.#api(
      {
        path: '/api/conversations',
        method: 'POST',
        schema: ConversationResponseSchema,
        body: { kind: 'chat' },
      },
      'start a new conversation',
    );

    let wire = created.conversation;
    if (model !== null && model.length > 0 && model !== wire.model) {
      try {
        const patched = await this.#api(
          {
            path: `/api/conversations/${encodeURIComponent(wire.id)}`,
            method: 'PATCH',
            schema: ConversationResponseSchema,
            body: { model },
          },
          'set the model for that conversation',
        );
        wire = patched.conversation;
      } catch (error) {
        /* The conversation exists and is usable; the model still travels on
           every `/api/chat` body. Losing the sticky preference is not worth
           failing a send over. */
        this.#log.warn('chat: could not store the conversation model', logFields(error));
      }
    }

    const conversation = this.#remember(toConversation(wire));
    this.#publish('chat:conversation-changed', { kind: 'upsert', conversation });
    return conversation;
  }

  async #uploadAll(
    files: readonly PreparedFile[],
    conversationId: string | null,
  ): Promise<{ attachments: Attachment[]; failures: RejectedFile[] }> {
    const attachments: Attachment[] = [];
    const failures: RejectedFile[] = [];

    /* Sequential on purpose: ten parallel multi-megabyte uploads would hold
       every file's bytes in memory at once, and the backend rate-limits
       uploads per user anyway. */
    for (const file of files) {
      try {
        attachments.push(await uploadAttachment(this.#raw, file, conversationId));
      } catch (error) {
        this.#noteTransportHealth(error);
        failures.push({
          fileName: file.fileName,
          reason: describeFailure(error, 'upload that file').message,
        });
      }
    }
    return { attachments, failures };
  }

  /** Rewrite stored image URLs into `data:` URIs the renderer can display. */
  async #inlineImages(messages: readonly Message[]): Promise<Message[]> {
    const budget = newInlineBudget();
    const output: Message[] = [];

    for (const message of messages) {
      const needsWork = message.attachments.some(
        (attachment) =>
          attachment.kind === 'IMAGE' && attachment.url.length > 0 && !attachment.url.startsWith('data:'),
      );
      if (!needsWork) {
        output.push(message);
        continue;
      }

      const attachments: Attachment[] = [];
      for (const attachment of message.attachments) {
        attachments.push(
          attachment.kind === 'IMAGE'
            ? { ...attachment, url: await inlineImageUrl(this.#raw, attachment.url, budget) }
            : attachment,
        );
      }
      output.push({ ...message, attachments });
    }
    return output;
  }

  /**
   * One authenticated JSON request.
   *
   * Everything that is JSON-in/JSON-out goes through `JunoTransport`: it owns
   * bearer attachment, the single-flight refresh, the `503 refresh_conflict`
   * retry and the contract-version check, and re-implementing any of that here
   * would be a second, worse copy. Only the three things it structurally cannot
   * do — a live stream, a multipart body, raw bytes — use `RawJunoClient`.
   */
  async #api<T>(spec: RequestSpec<T>, operation: string): Promise<T> {
    try {
      const response = await this.#transport.requestAuthenticated(spec, this.#tokens);
      this.#setConnection({ status: 'online', detail: null, retryInSeconds: null });
      return response.data;
    } catch (error) {
      this.#noteTransportHealth(error);
      throw describeFailure(error, operation);
    }
  }

  /**
   * Reachability, from what the last request actually did.
   *
   * `reconnecting` is never emitted, and that is deliberate: nothing in this
   * service retries a dropped turn or holds a socket open waiting to recover
   * one. Reporting a state the app is not in would put a countdown on screen
   * for a reconnection that is not going to happen.
   */
  #noteTransportHealth(error: unknown): void {
    if (error instanceof NetworkError) {
      this.#setConnection({
        status: 'offline',
        detail: 'Juno is unreachable. Check your connection.',
        retryInSeconds: null,
      });
      return;
    }
    if (error instanceof TimeoutError) {
      this.#setConnection({
        status: 'offline',
        detail: 'Juno is not responding.',
        retryInSeconds: null,
      });
    }
  }

  #setConnection(next: ConnectionState): void {
    if (this.#connectionKnown && next.status === this.#connection.status && next.detail === this.#connection.detail) {
      return;
    }
    this.#connectionKnown = true;
    this.#connection = next;
    this.#publish('chat:connection', next);
  }

  /**
   * Keep the cached row in step with a title the stream just changed.
   *
   * Patched from the cache rather than refetched: the only fields a `title` or
   * `meta` frame can have changed are the two being written, and a GET per
   * retitle would put a request on the wire in the middle of a generation to
   * learn something the frame already said.
   */
  #patchTitle(conversationId: string, title: string | null, titleSource: TitleSource | null): void {
    if (title === null || title.length === 0) return;
    const cached = this.#conversations.get(conversationId);
    if (cached === undefined || cached.title === title) return;

    const conversation: Conversation = {
      ...cached,
      title,
      titleSource: titleSource ?? cached.titleSource,
    };
    this.#remember(conversation);
    this.#publish('chat:conversation-changed', { kind: 'upsert', conversation });
  }

  #remember(conversation: Conversation): Conversation {
    if (this.#conversations.size >= CONVERSATION_CACHE_LIMIT && !this.#conversations.has(conversation.id)) {
      const oldest = this.#conversations.keys().next();
      if (!oldest.done) this.#conversations.delete(oldest.value);
    }
    this.#conversations.set(conversation.id, conversation);
    return conversation;
  }

  /**
   * Validate against the contract, then push.
   *
   * The renderer imports this contract with `import type` and does no runtime
   * checking of its own — it trusts what main sends because main validated it.
   * This is where that promise is kept, for every event, including the ~50
   * frames a second a streaming answer produces.
   */
  #publish<C extends ChatEventChannel>(channel: C, payload: ChatEventPayload<C>): void {
    let validated: ChatEventPayload<C>;
    try {
      validated = CHAT_EVENT_CHANNELS[channel].parse(payload) as ChatEventPayload<C>;
    } catch (error) {
      this.#log.error('chat: refused to emit an event that failed its own contract', {
        channel,
        ...logFields(error),
      });
      return;
    }

    try {
      this.#emit(channel, validated);
    } catch (error) {
      /* A destroyed webContents throws from `send`. Losing an event is
         survivable; letting it unwind into the stream pump is not. */
      this.#log.warn('chat: could not deliver an event to the renderer', { channel, ...logFields(error) });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Validate an outgoing reply against the channel's own response schema. */
function reply<C extends ChatInvokeChannel>(channel: C, value: unknown): ChatInvokeResponse<C> {
  return CHAT_INVOKE_CHANNELS[channel].response.parse(value) as ChatInvokeResponse<C>;
}

/**
 * The model the composer opens on.
 *
 * The account's stored default wins when it is in the catalogue and selectable;
 * a stored id for a model the plan lost would otherwise open the composer on a
 * selection every send would be rejected for.
 */
export function pickDefaultModel(
  models: readonly { id: string; lockedReason: string | null }[],
  preferred: string | null,
): string {
  const usable = models.filter((model) => model.lockedReason === null);
  if (preferred !== null && usable.some((model) => model.id === preferred)) return preferred;
  return usable[0]?.id ?? models[0]?.id ?? FALLBACK_MODEL;
}

export type { FinishReason };
