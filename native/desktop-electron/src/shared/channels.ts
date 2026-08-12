/**
 * Channel names only — no schemas, no Zod, no dependencies.
 *
 * This module exists so the preload bundle stays tiny. Preload runs with
 * `sandbox: true` and is the most security-sensitive code in the app; pulling a
 * validation library into it to obtain two string arrays would be a poor trade.
 * (It currently builds to 1.4 kB. That is the payoff.)
 *
 * The names are written out literally rather than imported from the per-surface
 * contract modules, because those modules import Zod and this one must not.
 * That duplication is safe: `ipc.ts` declares its tables
 * `satisfies Record<InvokeChannel, …>`, so a name here without a schema — or a
 * schema without a name here — is a compile error, not a runtime surprise.
 */

export const INVOKE_CHANNEL_NAMES = [
  /* Shell ------------------------------------------------------------------ */
  'app:info',
  'app:appearance',
  'app:set-appearance',
  'window:minimize',
  'window:toggle-maximize',
  'window:toggle-fullscreen',
  'auth:state',
  'auth:begin-sign-in',
  'auth:sign-out',
  'workspace:list',
  'workspace:choose',
  'workspace:set-trust',
  'diagnostics:snapshot',

  /* Code -------------------------------------------------------------------- */
  'code:start-session',
  'code:prompt',
  'code:resolve-approval',
  'code:set-mode',
  'code:abort',

  /* Chat -------------------------------------------------------------------- */
  'chat:list-conversations',
  'chat:get-conversation',
  'chat:create-conversation',
  'chat:update-conversation',
  'chat:delete-conversation',
  'chat:send',
  'chat:stop',
  'chat:retry',
  'chat:edit-message',
  'chat:fork',
  'chat:models',
  'chat:pick-attachments',
  'chat:receive-dropped-files',
  'chat:open-external',

  /* Work -------------------------------------------------------------------- */
  'work:list-tasks',
  'work:task-snapshot',
  'work:watch-task',
  'work:poll-now',
  'work:create-task',
  'work:dispatch-run',
  'work:control-run',
  'work:answer',
  'work:resolve-approval',
  'work:audit-trail',
  'work:capabilities',
  'work:choose-grant',
  'work:open-artifact',
  'work:open-conversation',

  /* Terminal ---------------------------------------------------------------- */
  'terminal:create',
  'terminal:write',
  'terminal:resize',
  'terminal:kill',
  'terminal:restart',
  'terminal:list',
] as const;

export const EVENT_CHANNEL_NAMES = [
  'auth:changed',
  'app:appearance-changed',
  'app:command',
  'code:event',
  'code:host-status',
  'chat:stream',
  'chat:conversation-changed',
  'chat:connection',
  'work:snapshot',
  'work:tasks',
  'work:poll-state',
  'terminal:output',
  'terminal:exit',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNEL_NAMES)[number];
export type EventChannel = (typeof EVENT_CHANNEL_NAMES)[number];
