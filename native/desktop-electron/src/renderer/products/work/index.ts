/**
 * The Work product surface.
 *
 * Exported by name rather than with a star: the surface's public API is the
 * root view plus the two things a shell legitimately needs (the task list shape
 * for its sidebar, and the vocabulary for rendering a status outside this tree).
 * A star export would make the surface whatever happened to be exported from the
 * modules on the day.
 *
 * `./contract.ts` is deliberately NOT re-exported here. It is staged for merge
 * into `src/shared/ipc.ts` and is the only file in this tree that imports Zod;
 * routing components through this barrel to reach it would be the one path by
 * which a validator ends up in the renderer bundle.
 */

export { WorkSurface } from './views/work-surface.js';
export { TaskComposer } from './views/composer.js';

export type {
  WorkSession,
  WorkSessionSummary,
  WorkRun,
  WorkSnapshot,
  WorkPollState,
} from './contract.js';

export {
  statusLabel,
  statusMeaning,
  statusTone,
  needsAttention,
  isTerminalStatus,
  isLiveStatus,
  type WorkStatus,
} from './lib/vocabulary.js';

export { assessFreshness, FRESHNESS_EXPLANATION_SHORT, type Freshness } from './lib/freshness.js';
