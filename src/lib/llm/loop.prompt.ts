/*
 * Model-facing text for the tool loop. English, and in a `*.prompt.ts` file so
 * the i18n extractor never harvests it (INV-29, SPEC §10.5).
 */

/**
 * Appended to the last tool result of the round before the final, tools-off
 * request — outside the untrusted envelope, never as a message of its own
 * (SPEC §4.6), so it is valid on every provider and never disturbs the cached
 * prefix.
 */
export const FINAL_ROUND_NOTE =
  "[Juno: this is the last step. Do not call tools. Answer the user now from what you have, and say briefly what you could not check.]";
