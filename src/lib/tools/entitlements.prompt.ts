/*
 * What the tool plan tells the model (SPEC §3.6 "Notices"). English, in a
 * `*.prompt.ts` file so the i18n extractor never harvests it (INV-29). Each
 * line goes in the turn's `dynamicContext`, not the cached system prompt.
 */

/** Lockdown with the web toggle on (`notice:web_off_lockdown`). */
export const WEB_OFF_LOCKDOWN_LINE = "Web access is off (Lockdown).";
