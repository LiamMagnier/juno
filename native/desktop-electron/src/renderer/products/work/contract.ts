/**
 * Re-export. The Work wire contract now lives in `src/shared/contracts`.
 *
 * It moved there because `src/shared/ipc.ts` composes the app-wide channel
 * table and cannot import upward from a product or from main without inverting
 * the layering. This file stays so the surface's own modules keep importing
 * their contract from beside them, which is where it reads naturally.
 */
export * from '../../../shared/contracts/work.js';
