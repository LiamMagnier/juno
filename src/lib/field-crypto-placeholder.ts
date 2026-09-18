/*
 * The sentinel a failed column decrypt yields, alone in a module that imports
 * nothing.
 *
 * It belongs beside `decryptField` by subject, and for a long time it lived
 * there. It cannot stay there, because the code that has to RECOGNISE it now
 * includes `src/lib/work/schedule.ts`, and the automations editor imports that
 * module into the browser bundle. `field-crypto.ts` reaches `node:crypto` and
 * the server's env schema through `message-crypto.ts`, so importing it to read
 * one string constant would drag the whole cipher — and a `process.env` read a
 * browser cannot answer — into a client bundle.
 *
 * So the constant is defined here and `field-crypto.ts` re-exports it: one
 * definition, every existing importer unchanged, and both sides of the
 * server/client wall able to name the value.
 *
 * Deliberately a sentinel rather than an empty string: callers that feed a
 * column to a model (a migrated task's prompt) can recognise it and refuse to
 * run rather than silently spending money on a meaningless request.
 */
export const FIELD_DECRYPT_PLACEHOLDER = "[encrypted field could not be decrypted]";
