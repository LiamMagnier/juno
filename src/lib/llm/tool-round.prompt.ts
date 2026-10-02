/*
 * Model-facing text the adapters' tool rounds may need to author themselves.
 * English, and in a `*.prompt.ts` file so the i18n extractor never harvests it
 * (INV-29, SPEC §10.5).
 */

/**
 * Sent in place of a result the runner did not return. Every provider rejects a
 * tool call left without its result, so the call gets this rather than taking
 * the whole turn down; the dispatcher returns one result per call, so it is a
 * guard, not a path.
 */
export const NO_RESULT_TEXT = "The call returned no result, so nothing is known about its outcome.";
