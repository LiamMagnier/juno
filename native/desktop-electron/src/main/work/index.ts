/**
 * The Work surface's main-process entry point.
 *
 * `index.ts` constructs one `WorkService` and hands its methods to
 * `registerInvokeHandlers`. Everything else here is exported for tests and for
 * the wiring, and nothing in this directory imports `electron` at module scope —
 * see `native.ts` for why.
 */

export {
  WorkService,
  WorkServiceError,
  createWorkInvokeHandlers,
  describeFailure,
  answerRefusal,
  approvalRefusal,
  applySkillSlug,
} from './service.js';
export type { WorkEmit, WorkInvokeHandlers, WorkServiceOptions } from './service.js';
export {
  WorkPoller,
  WORK_POLL_TIMING,
  INITIAL_POLL_STATE,
  activityForStatus,
  backoffMs,
  baseIntervalMs,
  pollIntervalMs,
  reducePollState,
  snapshotChanged,
  tasksChanged,
} from './poller.js';
export type {
  PollActivity,
  PollContext,
  PollEvent,
  PollResult,
  PollTiming,
  ScheduleInput,
  WorkPollerPorts,
} from './poller.js';
export { GrantVault } from './grants.js';
export type { GrantRecord } from './grants.js';
export { createElectronNativePorts } from './native.js';
export type { ChosenPath, WorkNativePorts } from './native.js';
export { BearerFetcher } from './bearer.js';
export { WorkEventStream } from './event-stream.js';
export { ArtifactDownloader } from './artifacts.js';
