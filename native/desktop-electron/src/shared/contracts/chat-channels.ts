/**
 * Chat channel names only — no schemas, no Zod, no dependencies.
 *
 * This mirrors the split in `src/shared/channels.ts` for the same reason it
 * exists there: the names are needed at runtime (the bridge sends them), the
 * schemas are not (main validates). Keeping them apart is what lets every
 * component import the chat contract with `import type` and leave Zod out of
 * the renderer bundle entirely.
 *
 * WHEN THIS IS MERGED into `src/shared/`, these arrays are appended to
 * `INVOKE_CHANNEL_NAMES` / `EVENT_CHANNEL_NAMES` and this file is deleted; the
 * `satisfies` constraint in `../contract.ts` is what guarantees the two lists
 * cannot drift in the meantime.
 */

export const CHAT_INVOKE_CHANNEL_NAMES = [
  /* Conversations. */
  'chat:list-conversations',
  'chat:get-conversation',
  'chat:create-conversation',
  'chat:update-conversation',
  'chat:delete-conversation',

  /* Turns. */
  'chat:send',
  'chat:stop',
  'chat:retry',
  'chat:edit-message',
  'chat:fork',

  /* Capabilities and side doors into main. */
  'chat:models',
  'chat:pick-attachments',
  'chat:receive-dropped-files',
  'chat:open-external',
] as const;

export const CHAT_EVENT_CHANNEL_NAMES = [
  'chat:stream',
  'chat:conversation-changed',
  'chat:connection',
] as const;

export type ChatInvokeChannel = (typeof CHAT_INVOKE_CHANNEL_NAMES)[number];
export type ChatEventChannel = (typeof CHAT_EVENT_CHANNEL_NAMES)[number];
