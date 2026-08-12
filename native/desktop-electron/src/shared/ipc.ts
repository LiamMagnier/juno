/**
 * The IPC capability contract.
 *
 * Every channel the renderer may use is declared here, once, with a Zod schema
 * for its request and its response. Main, preload and renderer all derive from
 * this table rather than each maintaining their own list of strings, because
 * three hand-maintained lists is how a channel ends up exposed in preload but
 * unvalidated in main.
 *
 * Two rules this file exists to enforce:
 *
 *   1. **Nothing is reachable that is not listed here.** The preload bridge is
 *      generated from `INVOKE_CHANNELS`/`EVENT_CHANNELS`, so adding a handler in
 *      main without adding it here leaves it unreachable from the renderer.
 *
 *   2. **Every payload is validated in main, on arrival.** `contextIsolation`
 *      protects the preload boundary, but a compromised renderer can still send
 *      any structurally-valid IPC message it likes. Main re-validates rather
 *      than trusting that preload was the sender.
 */

import { z } from 'zod';
import { PermissionModeSchema, ApprovalDecisionSchema, AgentEventSchema } from './agent-protocol.js';
import {
  EVENT_CHANNEL_NAMES,
  INVOKE_CHANNEL_NAMES,
  type EventChannel,
  type InvokeChannel,
} from './channels.js';
/* Per-surface contracts. Each was authored alongside its product and moved here
   so this module can compose them without importing upward from `products/` or
   from `main/`. They are spread into the tables below rather than restated. */
import { CHAT_EVENT_CHANNELS, CHAT_INVOKE_CHANNELS } from './contracts/chat.js';
import { WORK_EVENT_CHANNELS, WORK_INVOKE_CHANNELS } from './contracts/work.js';
import { TERMINAL_EVENT_CHANNELS, TERMINAL_INVOKE_CHANNELS } from './contracts/terminal.js';

export { EVENT_CHANNEL_NAMES, INVOKE_CHANNEL_NAMES };
export type { EventChannel, InvokeChannel };

/* -------------------------------------------------------------------------- */
/* Shared payload shapes                                                       */
/* -------------------------------------------------------------------------- */

export const AppInfoSchema = z.object({
  version: z.string(),
  electronVersion: z.string(),
  chromeVersion: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  isPackaged: z.boolean(),
  /** The `/api/v1` contract version this build was compiled against. */
  contractVersion: z.string(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

export const ThemeAppearanceSchema = z.enum(['light', 'dark', 'system']);
export type ThemeAppearance = z.infer<typeof ThemeAppearanceSchema>;

/**
 * Accessibility and appearance state read from macOS, not guessed.
 *
 * `reduceMotion` and `reduceTransparency` come from
 * `nativeTheme`/`systemPreferences` in main. The renderer cannot read these
 * reliably on its own — `prefers-reduced-motion` covers motion but there is no
 * media query for macOS "Reduce Transparency" — so main pushes them.
 */
export const SystemAppearanceSchema = z.object({
  shouldUseDarkColors: z.boolean(),
  reduceMotion: z.boolean(),
  reduceTransparency: z.boolean(),
  increaseContrast: z.boolean(),
  accentColor: z.string().nullable(),
});
export type SystemAppearance = z.infer<typeof SystemAppearanceSchema>;

/**
 * A workspace the user has explicitly trusted.
 *
 * `trusted` is deliberately not defaulted to true anywhere in this codebase. An
 * untrusted workspace can be browsed but never executed in — see
 * `THREAT_MODEL.md` on malicious repository content.
 */
export const WorkspaceSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  trusted: z.boolean(),
  isGitRepository: z.boolean(),
  branch: z.string().nullable(),
  lastOpenedAt: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const AuthStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('signed-out') }),
  z.object({ status: z.literal('signing-in') }),
  z.object({
    status: z.literal('signed-in'),
    accountId: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    deviceId: z.string(),
  }),
  z.object({ status: z.literal('unauthorized'), reason: z.string() }),
]);
export type AuthState = z.infer<typeof AuthStateSchema>;

/** Reachability and durability facts for the diagnostics surface. */
export const DiagnosticsSnapshotSchema = z.object({
  appVersion: z.string(),
  contractVersion: z.string(),
  backendReachable: z.boolean(),
  backendOrigin: z.string(),
  authStatus: z.string(),
  syncCursor: z.string().nullable(),
  outboxDepth: z.number(),
  agentHostStatus: z.enum(['stopped', 'starting', 'running', 'crashed']),
  agentHostRestarts: z.number(),
  databaseHealthy: z.boolean(),
});
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshotSchema>;

const OkSchema = z.object({ ok: z.literal(true) });

/* -------------------------------------------------------------------------- */
/* Invoke channels (renderer -> main, with a reply)                            */
/* -------------------------------------------------------------------------- */

/**
 * `request` is what the renderer may send; `response` is what main returns.
 * Both are validated. A channel with `request: z.void()` takes no argument.
 */
export const INVOKE_CHANNELS = {
  'app:info': { request: z.void(), response: AppInfoSchema },
  'app:appearance': { request: z.void(), response: SystemAppearanceSchema },
  'app:set-appearance': {
    request: z.object({ appearance: ThemeAppearanceSchema }),
    response: OkSchema,
  },

  /* Window chrome. The renderer draws a custom title bar, so it needs these —
     but it gets exactly these, not a general window handle. */
  'window:minimize': { request: z.void(), response: OkSchema },
  'window:toggle-maximize': { request: z.void(), response: OkSchema },
  'window:toggle-fullscreen': { request: z.void(), response: OkSchema },

  /* Auth. The renderer never sees a token: it asks main to begin the PKCE
     flow and observes state changes. Credentials live in the Keychain and are
     attached to requests in main. */
  'auth:state': { request: z.void(), response: AuthStateSchema },
  'auth:begin-sign-in': { request: z.void(), response: OkSchema },
  'auth:sign-out': { request: z.void(), response: OkSchema },

  /* Workspaces. `choose` opens a native picker in main — the renderer cannot
     name an arbitrary path and have it opened, which is what makes the trust
     prompt meaningful. */
  'workspace:list': { request: z.void(), response: z.array(WorkspaceSchema) },
  'workspace:choose': { request: z.void(), response: WorkspaceSchema.nullable() },
  'workspace:set-trust': {
    request: z.object({ workspaceId: z.string(), trusted: z.boolean() }),
    response: WorkspaceSchema,
  },

  /* Code sessions. These are thin: the heavy lifting is in the agent host, and
     the renderer drives it through main so that main stays the only process
     holding provider credentials. */
  'code:start-session': {
    request: z.object({
      workspaceId: z.string(),
      model: z.string().optional(),
      mode: PermissionModeSchema.optional(),
    }),
    response: z.object({ sessionId: z.string() }),
  },
  'code:prompt': {
    request: z.object({ sessionId: z.string(), text: z.string() }),
    response: OkSchema,
  },
  'code:resolve-approval': {
    request: z.object({
      sessionId: z.string(),
      callId: z.string(),
      decision: ApprovalDecisionSchema,
    }),
    response: OkSchema,
  },
  'code:set-mode': {
    request: z.object({ sessionId: z.string(), mode: PermissionModeSchema }),
    response: OkSchema,
  },
  'code:abort': { request: z.object({ sessionId: z.string() }), response: OkSchema },

  'diagnostics:snapshot': { request: z.void(), response: DiagnosticsSnapshotSchema },

  ...CHAT_INVOKE_CHANNELS,
  ...WORK_INVOKE_CHANNELS,
  ...TERMINAL_INVOKE_CHANNELS,
  /* `satisfies Record<InvokeChannel, …>` is what makes the split from
     channels.ts safe: every declared name must appear here, and a key that is
     not a declared name is rejected. With three spread tables that is no longer
     a nicety — it is the only thing keeping four files in agreement. */
} as const satisfies Record<InvokeChannel, { request: z.ZodType; response: z.ZodType }>;

export type InvokeRequest<C extends InvokeChannel> = z.infer<
  (typeof INVOKE_CHANNELS)[C]['request']
>;
export type InvokeResponse<C extends InvokeChannel> = z.infer<
  (typeof INVOKE_CHANNELS)[C]['response']
>;

/* -------------------------------------------------------------------------- */
/* Event channels (main -> renderer, push)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Push channels. The renderer subscribes; it can never emit on these.
 *
 * Agent events arrive here rather than as invoke replies because a turn
 * produces an unbounded stream and the renderer must be able to render the
 * first token without waiting for the last.
 */
export const EVENT_CHANNELS = {
  'auth:changed': AuthStateSchema,
  'app:appearance-changed': SystemAppearanceSchema,
  'code:event': z.object({ sessionId: z.string(), event: AgentEventSchema }),
  'code:host-status': z.object({
    status: z.enum(['stopped', 'starting', 'running', 'crashed']),
    detail: z.string().nullable(),
  }),
  /** Fired when the user triggers a menu/shortcut action that the renderer owns. */
  'app:command': z.object({ command: z.string() }),

  ...CHAT_EVENT_CHANNELS,
  ...WORK_EVENT_CHANNELS,
  ...TERMINAL_EVENT_CHANNELS,
} as const satisfies Record<EventChannel, z.ZodType>;

export type EventPayload<C extends EventChannel> = z.infer<(typeof EVENT_CHANNELS)[C]>;

/**
 * The API surface preload exposes as `window.juno`.
 *
 * Declared as a type here so the renderer can be type-checked against it
 * without importing preload (which would drag Node types into the web graph and
 * defeat the split in tsconfig.web.json).
 */
export interface JunoBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeRequest<C> extends void ? [] : [InvokeRequest<C>]
  ): Promise<InvokeResponse<C>>;
  /** Returns an unsubscribe function. */
  on<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void;
}
