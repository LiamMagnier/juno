/*
 * "MEMORY OFF FOR THIS CHAT" — one conversation kept out of memory, in both
 * directions, while it stays an ordinary saved chat.
 *
 * Incognito is the other way to keep a chat out of memory, and it costs the
 * chat: nothing is saved, it leaves no history, it cannot be shared or picked
 * up on another device. This costs memory only. With it on (the column is
 * `Conversation.memoryOff`):
 *
 *   - a turn reads no memory: no summary, no notes, no memory instructions
 *     (`turnMayUseMemory` in src/lib/memory-scope.ts, folded into the
 *     `memoryEnabled` flag of src/lib/chat/turn/memory.ts, which every save,
 *     forget and extraction step downstream is already gated on);
 *   - the `<juno:memory>` and `<juno:forget>` tags a reply might still carry
 *     are ignored, for the same reason;
 *   - the background reader never reads it: the backfill, the dreamer's
 *     account sweep and its re-reads all pass it by (src/lib/memory.ts,
 *     src/lib/memory-dreamer.ts), and so does the reader a voice call or a
 *     spoken transcript would run;
 *   - a voice call in it starts without memory, and a deep-research run or a
 *     task started from it does not read memory either.
 *
 * It only ever NARROWS. Memory paused for the account, a project that turned
 * recall off or an agent granted no memory each keep a chat out on their own;
 * this cannot let one back in.
 *
 * Turning it back on is not "read what was said meanwhile": what was said
 * while it was off stays unread (memory-off-store.ts covers it as read at the
 * moment memory comes back), so a chat someone kept out of memory for an hour
 * is not quietly learned from the next night.
 *
 * Pure on purpose — the words are read by the composer, the chat's menu and
 * the header, and by the tests that hold them to the catalog.
 */

/** Every user-facing sentence about it, named so the i18n extractor picks them up. */
export const MEMORY_OFF_COPY = {
  /** The chat's own menu: a checkbox row. */
  menuLabel: "Memory off for this chat",
  /** The composer's + menu: the switch keeps its name, and says what it is about. */
  composerLabel: "Memory for this chat",
  /** The header's quiet mark while it is on. */
  indicatorLabel: "Memory off",
  indicatorTooltip: "This chat doesn’t use memory or add to it.",
  /** The + row's word while the account's memory is paused: the switch there is the account's. */
  accountPausedDescription: "Paused",
  saveFailedMessage: "Couldn’t change memory for this chat. Try again.",
} as const;

/**
 * Whether this chat's turns use memory, as the composer's switch shows it:
 * the account's memory on, and this chat not set to keep out of it. The
 * server folds the project's and the agent's limits in as well
 * (src/lib/chat/turn/memory.ts); the switch is about the two a person flips.
 */
export function chatUsesMemory(input: { accountMemory: boolean; chatMemoryOff: boolean }): boolean {
  return input.accountMemory && !input.chatMemoryOff;
}
