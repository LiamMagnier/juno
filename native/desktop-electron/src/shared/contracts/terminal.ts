/**
 * The terminal IPC contract.
 *
 * This module is a **self-contained** mirror of the shape that `src/shared/ipc.ts`
 * uses. It exists as its own file for one reason: the shared contract does not
 * yet carry any terminal channels, and the terminal subsystem must not be
 * merged into it unilaterally. Every export here is written so that landing the
 * terminal in the shared contract is a mechanical paste of three objects —
 * `TERMINAL_INVOKE_CHANNEL_NAMES` and `TERMINAL_EVENT_CHANNEL_NAMES` into
 * `channels.ts`, `TERMINAL_INVOKE_CHANNELS` and `TERMINAL_EVENT_CHANNELS` into
 * `ipc.ts` — with no edits to the schemas themselves. See the note at the foot
 * of this file for the exact merge.
 *
 * Three invariants this file is responsible for:
 *
 *   1. **Terminal ids are server-generated, never renderer-supplied.** `create`
 *      takes no id and returns one. The id format is a random UUID behind a
 *      `term_` prefix, which makes the id itself a 122-bit unguessable
 *      capability: a compromised renderer cannot enumerate or address a
 *      terminal it was never handed. `TerminalIdSchema` pins that format, so a
 *      fabricated id fails validation at the router before any handler runs.
 *
 *   2. **No path crosses the IPC boundary unbounded.** `create` names a
 *      *workspace id*, not a directory — the same rule `workspace:choose`
 *      already follows, and the reason the trust prompt means anything. The
 *      optional `cwd` is a subdirectory request that main resolves and verifies
 *      against the workspace root; it is not a way to name `/`.
 *
 *   3. **`origin` is not on the IPC surface.** Attribution of agent-initiated
 *      input is a real requirement (see `TerminalInputSchema`), but a renderer
 *      that could *claim* `origin: 'agent'` would be able to launder its own
 *      writes through the activity log, and one that could claim
 *      `origin: 'user'` would be able to launder an agent command past a
 *      permission gate. So the renderer-facing write schema has no origin field
 *      at all and the router stamps `'user'`; agent input enters through the
 *      in-process manager API instead. That seam is documented on
 *      `TerminalInputSchema`.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Caps, all of them deliberate rather than defensive-by-default.
 *
 * These are exported because the manager enforces them at runtime and the
 * renderer wants to display some of them; a limit that lives in two files as
 * two literals is a limit that will disagree with itself.
 */
export const TERMINAL_LIMITS = {
  /** Concurrent live terminals per application. Bounds pty fds and RSS. */
  maxTerminals: 12,
  /** Largest single `write`. Sized for a generous paste, not for a file dump. */
  maxWriteChars: 1_048_576,
  /** Grid bounds. 2000 columns is far past any real window; 0 is a crash. */
  minCols: 1,
  maxCols: 2_000,
  minRows: 1,
  maxRows: 2_000,
  /** Longest tab title main will store. */
  maxTitleChars: 120,
  /** Longest `cwd` request, before resolution. */
  maxCwdChars: 4_096,
  /** Longest correlation id an agent may attach to an input. */
  maxCorrelationIdChars: 128,
} as const;

/* -------------------------------------------------------------------------- */
/* Leaf types                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `term_` + a v4 UUID, lowercase.
 *
 * Pinned as a regex rather than left as `z.string()` on purpose. The id is the
 * only thing standing between a renderer and a terminal belonging to another
 * workspace, so it is validated as a *format* at the boundary, not merely
 * looked up and missed in a map. A miss and a malformed id are different bugs
 * and should fail differently.
 */
export const TerminalIdSchema = z
  .string()
  .regex(
    /^term_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'not a terminal id',
  );
export type TerminalId = z.infer<typeof TerminalIdSchema>;

export const TerminalStatusSchema = z.enum(['running', 'exited']);
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

/**
 * Who caused a byte to be written to a pty.
 *
 * This exists for the activity system and the permission system, which are
 * owned elsewhere. See `TerminalInputSchema` for why it is absent from the
 * renderer-facing schemas.
 */
export const TerminalOriginSchema = z.enum(['user', 'agent']);
export type TerminalOrigin = z.infer<typeof TerminalOriginSchema>;

/**
 * Signals the renderer may ask for.
 *
 * An allowlist, not `z.string()`. `process.kill` accepts a signal name from its
 * caller and a renderer that could pass an arbitrary one gets to pick things
 * like `SIGSTOP`, which would wedge a shell with no visible cause.
 */
export const TerminalSignalSchema = z.enum(['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGKILL']);
export type TerminalSignal = z.infer<typeof TerminalSignalSchema>;

const ColsSchema = z.number().int().min(TERMINAL_LIMITS.minCols).max(TERMINAL_LIMITS.maxCols);
const RowsSchema = z.number().int().min(TERMINAL_LIMITS.minRows).max(TERMINAL_LIMITS.maxRows);

/**
 * Everything the renderer is told about a terminal.
 *
 * Deliberately *not* the manager's internal record: there is no pty handle, no
 * environment, and no history here. `cwd` and `shell` are absolute paths and do
 * leak the user's home directory name to the renderer — which is acceptable
 * because the renderer has to print the prompt's working directory anyway, and
 * unacceptable to omit because a terminal whose cwd you cannot see is a
 * terminal you cannot reason about.
 */
export const TerminalSummarySchema = z.object({
  id: TerminalIdSchema,
  workspaceId: z.string().min(1),
  title: z.string(),
  /** Absolute, already resolved through realpath and verified inside the root. */
  cwd: z.string(),
  /** Absolute path of the login shell that was spawned. */
  shell: z.string(),
  /** `null` once the process has exited. */
  pid: z.number().int().nullable(),
  cols: ColsSchema,
  rows: RowsSchema,
  status: TerminalStatusSchema,
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  createdAt: z.string(),
  /** How much output history main is currently holding, in UTF-16 code units. */
  historyChars: z.number().int().nonnegative(),
  /**
   * Present only when `terminal:list` was called with `includeHistory`. This is
   * the bounded replay buffer — see `RingBuffer` in `pty-manager.ts` for what
   * "bounded" costs you at the seams.
   */
  history: z.string().optional(),
});
export type TerminalSummary = z.infer<typeof TerminalSummarySchema>;

/* -------------------------------------------------------------------------- */
/* Invoke channels (renderer -> main, with a reply)                            */
/* -------------------------------------------------------------------------- */

export const TerminalCreateRequestSchema = z.object({
  /** A workspace id, resolved in main. Never a path — see invariant 2 above. */
  workspaceId: z.string().min(1),
  cols: ColsSchema,
  rows: RowsSchema,
  /**
   * A subdirectory of the workspace root, absolute or relative to it. Resolved
   * through `realpath` and rejected unless it lands inside the root.
   */
  cwd: z.string().min(1).max(TERMINAL_LIMITS.maxCwdChars).optional(),
  title: z.string().max(TERMINAL_LIMITS.maxTitleChars).optional(),
});
export type TerminalCreateRequest = z.infer<typeof TerminalCreateRequestSchema>;

export const TerminalCreateResponseSchema = z.object({ terminal: TerminalSummarySchema });
export type TerminalCreateResponse = z.infer<typeof TerminalCreateResponseSchema>;

/**
 * The renderer-facing write.
 *
 * No `origin`, no `correlationId`. Invariant 3. The router calls
 * `manager.write({ ...request, origin: 'user' })`.
 */
export const TerminalWriteRequestSchema = z.object({
  terminalId: TerminalIdSchema,
  data: z.string().max(TERMINAL_LIMITS.maxWriteChars),
});
export type TerminalWriteRequest = z.infer<typeof TerminalWriteRequestSchema>;

export const TerminalResizeRequestSchema = z.object({
  terminalId: TerminalIdSchema,
  cols: ColsSchema,
  rows: RowsSchema,
});
export type TerminalResizeRequest = z.infer<typeof TerminalResizeRequestSchema>;

/**
 * Terminate a terminal **and release it**.
 *
 * `kill` and `restart` are the two things a user actually wants and they differ
 * in what happens to the tab, so they differ in what happens to the record:
 * `kill` is "this tab is going away" and drops the record once the process is
 * gone, `restart` is "this tab stays, the shell is replaced" and keeps the id.
 * A shell that exits on its own — the user typed `exit` — is neither: its
 * record survives in `status: 'exited'` so the renderer can offer to restart
 * it, and a later `kill` is what finally releases it.
 */
export const TerminalKillRequestSchema = z.object({
  terminalId: TerminalIdSchema,
  /** Defaults to SIGHUP, which is what a closing terminal window sends. */
  signal: TerminalSignalSchema.default('SIGHUP'),
});
export type TerminalKillRequest = z.infer<typeof TerminalKillRequestSchema>;

export const TerminalRestartRequestSchema = z.object({ terminalId: TerminalIdSchema });
export type TerminalRestartRequest = z.infer<typeof TerminalRestartRequestSchema>;

export const TerminalRestartResponseSchema = z.object({ terminal: TerminalSummarySchema });
export type TerminalRestartResponse = z.infer<typeof TerminalRestartResponseSchema>;

/**
 * `includeHistory` exists so a renderer that has just reloaded can re-attach to
 * running terminals with their scrollback, rather than showing the user an
 * empty pane in front of a live shell. It is opt-in because the default call
 * happens on every workspace switch and shipping a quarter of a megabyte per
 * terminal through IPC for a tab strip would be absurd.
 */
export const TerminalListRequestSchema = z.object({
  includeHistory: z.boolean().default(false),
});
export type TerminalListRequest = z.infer<typeof TerminalListRequestSchema>;

export const TerminalListResponseSchema = z.array(TerminalSummarySchema);
export type TerminalListResponse = z.infer<typeof TerminalListResponseSchema>;

const TerminalOkSchema = z.object({ ok: z.literal(true) });

/* -------------------------------------------------------------------------- */
/* Event channels (main -> renderer, push)                                     */
/* -------------------------------------------------------------------------- */

/**
 * A coalesced batch of pty output.
 *
 * Not "a chunk from the pty". The manager batches on a ~16ms interval, so one
 * event carries everything a terminal produced in one frame. `seq` is
 * per-terminal and monotonic; `truncatedChars` is non-zero when the batch
 * exceeded the per-event cap and the manager kept the tail. Both fields exist
 * so the renderer can tell "nothing happened" from "we dropped the middle of a
 * flood", which is the difference between a correct display and a lie.
 */
export const TerminalOutputEventSchema = z.object({
  terminalId: TerminalIdSchema,
  seq: z.number().int().nonnegative(),
  chunk: z.string(),
  /** Characters discarded from the *front* of this batch to honour the cap. */
  truncatedChars: z.number().int().nonnegative(),
});
export type TerminalOutputEvent = z.infer<typeof TerminalOutputEventSchema>;

export const TerminalExitEventSchema = z.object({
  terminalId: TerminalIdSchema,
  exitCode: z.number().int(),
  /** The POSIX signal number, when the process was signalled rather than exited. */
  signal: z.number().int().nullable(),
  /**
   * Whether the record is gone from main. `true` after `kill` (and after
   * shutdown); `false` when the shell exited on its own and the tab may still
   * offer a restart.
   */
  released: z.boolean(),
  at: z.string(),
});
export type TerminalExitEvent = z.infer<typeof TerminalExitEventSchema>;

/* -------------------------------------------------------------------------- */
/* The channel tables                                                          */
/* -------------------------------------------------------------------------- */

export const TERMINAL_INVOKE_CHANNEL_NAMES = [
  'terminal:create',
  'terminal:write',
  'terminal:resize',
  'terminal:kill',
  'terminal:restart',
  'terminal:list',
] as const;

export const TERMINAL_EVENT_CHANNEL_NAMES = ['terminal:output', 'terminal:exit'] as const;

export type TerminalInvokeChannel = (typeof TERMINAL_INVOKE_CHANNEL_NAMES)[number];
export type TerminalEventChannel = (typeof TERMINAL_EVENT_CHANNEL_NAMES)[number];

/**
 * Paste-ready for `INVOKE_CHANNELS` in `src/shared/ipc.ts`.
 *
 * The `satisfies` clause mirrors the one on the shared table, so the same
 * "declared name without a schema is a type error" property holds here in the
 * meantime.
 */
export const TERMINAL_INVOKE_CHANNELS = {
  'terminal:create': {
    request: TerminalCreateRequestSchema,
    response: TerminalCreateResponseSchema,
  },
  'terminal:write': { request: TerminalWriteRequestSchema, response: TerminalOkSchema },
  'terminal:resize': { request: TerminalResizeRequestSchema, response: TerminalOkSchema },
  'terminal:kill': { request: TerminalKillRequestSchema, response: TerminalOkSchema },
  'terminal:restart': {
    request: TerminalRestartRequestSchema,
    response: TerminalRestartResponseSchema,
  },
  'terminal:list': { request: TerminalListRequestSchema, response: TerminalListResponseSchema },
} as const satisfies Record<TerminalInvokeChannel, { request: z.ZodType; response: z.ZodType }>;

/** Paste-ready for `EVENT_CHANNELS` in `src/shared/ipc.ts`. */
export const TERMINAL_EVENT_CHANNELS = {
  'terminal:output': TerminalOutputEventSchema,
  'terminal:exit': TerminalExitEventSchema,
} as const satisfies Record<TerminalEventChannel, z.ZodType>;

export type TerminalInvokeRequest<C extends TerminalInvokeChannel> = z.infer<
  (typeof TERMINAL_INVOKE_CHANNELS)[C]['request']
>;
export type TerminalInvokeResponse<C extends TerminalInvokeChannel> = z.infer<
  (typeof TERMINAL_INVOKE_CHANNELS)[C]['response']
>;
export type TerminalEventPayload<C extends TerminalEventChannel> = z.infer<
  (typeof TERMINAL_EVENT_CHANNELS)[C]
>;

/**
 * What the manager hands to its event sink.
 *
 * A discriminated union of `{ channel, payload }` rather than two callbacks, so
 * the integration in main is one line — `emitTo(window, event.channel,
 * event.payload)` — and stays exhaustive if a third event channel is ever
 * added.
 */
export type TerminalOutboundEvent =
  | { channel: 'terminal:output'; payload: TerminalOutputEvent }
  | { channel: 'terminal:exit'; payload: TerminalExitEvent };

/* -------------------------------------------------------------------------- */
/* Manager-level schemas (not reachable from the renderer)                     */
/* -------------------------------------------------------------------------- */

/**
 * The in-process write API, which *does* carry attribution.
 *
 * ## The agent seam
 *
 * A command the agent runs must appear in the activity system and must respect
 * permissions. Neither of those belongs to this subsystem, so the design here
 * is only about making them possible without a rewrite:
 *
 *   - `origin: 'agent'` and a `correlationId` (the agent's tool-call id) can be
 *     attached to any write, and are carried through to `PtyManager.onInput`
 *     observers. The activity system subscribes there; it does not need to
 *     patch this module.
 *   - This field is reachable **only from main**, never over IPC. The renderer
 *     cannot claim to be the agent and the agent cannot claim to be the user.
 *   - The manager enforces no policy. A permission gate belongs *before* the
 *     call to `write`, in the tool implementation, where the command text is
 *     still a structured thing and not a stream of keystrokes. By the time
 *     bytes reach a pty there is no such thing as denying them.
 *
 * The corresponding seam on creation is `TerminalCreateOptions.origin` in
 * `pty-manager.ts`, so an agent-owned terminal can be labelled as such in the
 * tab strip rather than looking like one the user opened.
 */
export const TerminalInputSchema = z.object({
  terminalId: TerminalIdSchema,
  data: z.string().max(TERMINAL_LIMITS.maxWriteChars),
  origin: TerminalOriginSchema.default('user'),
  correlationId: z.string().min(1).max(TERMINAL_LIMITS.maxCorrelationIdChars).optional(),
});
export type TerminalInput = z.infer<typeof TerminalInputSchema>;
/**
 * The *input* side of `TerminalInputSchema` — `origin` optional, defaulted on
 * parse. This is what callers pass to `PtyManager.write`, so a plain
 * `{ terminalId, data }` from the IPC handler and a fully attributed write from
 * an agent tool are the same call.
 */
export type TerminalInputInit = z.input<typeof TerminalInputSchema>;

/** What `PtyManager.onInput` observers receive. */
export interface TerminalInputRecord {
  terminalId: TerminalId;
  /** The raw bytes written. Consumers are responsible for their own redaction. */
  data: string;
  origin: TerminalOrigin;
  correlationId?: string | undefined;
  at: string;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const TERMINAL_ERROR_CODES = [
  'unknown-terminal',
  'workspace-not-found',
  'workspace-untrusted',
  'cwd-outside-workspace',
  'too-many-terminals',
  'terminal-exited',
  'invalid-shell',
  'spawn-failed',
  'shutting-down',
] as const;
export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];

/**
 * A failure with a message that is safe to show the user.
 *
 * Deliberately *not* `PublicError` from `ipc-router.ts`: that module imports
 * `electron`, and importing it here would drag `ipcMain` into every unit test
 * of the pure functions in `pty-manager.ts`. The router should map this to
 * `PublicError` at the boundary — one line, see the merge note below.
 *
 * `message` is written for a human and contains no absolute paths. The path
 * that caused a `cwd-outside-workspace` goes to the log, not to the renderer;
 * paths contain usernames.
 */
export class TerminalError extends Error {
  override readonly name = 'TerminalError';
  readonly code: TerminalErrorCode;

  constructor(code: TerminalErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function isTerminalError(error: unknown): error is TerminalError {
  return error instanceof TerminalError;
}

/* -------------------------------------------------------------------------- *

   MERGE NOTE — what to add to the shared contract.

   src/shared/channels.ts
     …append to INVOKE_CHANNEL_NAMES:
       'terminal:create', 'terminal:write', 'terminal:resize',
       'terminal:kill', 'terminal:restart', 'terminal:list',
     …append to EVENT_CHANNEL_NAMES:
       'terminal:output', 'terminal:exit',

   src/shared/ipc.ts
     …spread `TERMINAL_INVOKE_CHANNELS` into `INVOKE_CHANNELS`
     …spread `TERMINAL_EVENT_CHANNELS` into `EVENT_CHANNELS`
     …or move the schemas above verbatim; they have no imports beyond `zod`.

   src/main/ipc-router.ts — no change required, but the terminal handlers should
   translate at the boundary:

       catch (error) {
         if (isTerminalError(error)) throw new PublicError(error.message);
         throw error;
       }

 * -------------------------------------------------------------------------- */
