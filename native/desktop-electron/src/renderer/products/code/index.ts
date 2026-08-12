/**
 * Public entry for the Code product surface.
 *
 * The app shell mounts `CodeProduct`. Everything else is exported for tests and
 * for the shell to compose pieces (e.g. hosting the subagent rail elsewhere) —
 * nothing outside this directory is required for the surface to work.
 */

export { CodeProduct, type CodeProductProps } from './CodeProduct.js';

export { ActivityTimeline, type ActivityTimelineProps } from './components/ActivityTimeline.js';
export { ApprovalDock, type ApprovalDockProps } from './components/ApprovalDock.js';
export { DiffReview, type DiffReviewProps, type DiffView } from './components/DiffReview.js';
export { ModeSelector, type ModeSelectorProps } from './components/ModeSelector.js';
export { SessionComposer, type SessionComposerProps } from './components/SessionComposer.js';
export { SessionHeader, type SessionHeaderProps } from './components/SessionHeader.js';
export { SubagentPanel, type SubagentPanelProps } from './components/SubagentPanel.js';
export {
  WorkspaceTrustGate,
  type WorkspaceTrustGateProps,
} from './components/WorkspaceTrustGate.js';

export { CodeSessionStore } from './state/timeline-store.js';
export type {
  ApprovalEntry,
  ChangeEntry,
  MessageEntry,
  NoticeEntry,
  PromptEntry,
  RunStatus,
  SubagentEntry,
  TimelineEntry,
  ToolCall,
  ToolGroupEntry,
  TurnEntry,
} from './state/timeline-store.js';
export { useCodeSession, useStoreVersion, type CodeSessionApi } from './state/useCodeSession.js';
export { useVirtualRows } from './state/useVirtualRows.js';

export {
  MODES,
  MODE_ORDER,
  CODE_FULL_ACCESS,
  descriptorFor,
  fromPermissionMode,
  outcomeFor,
  permissionModeFor,
  type CodeMode,
  type ModeDescriptor,
} from './lib/modes.js';
export {
  parseUnifiedDiff,
  reconstructEditFile,
  foldContext,
  tokenize,
  totalsFor,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
} from './lib/diff.js';
export { categorize, summarizeCall, targetOf, impactOf, type ToolCategory } from './lib/tools.js';
export { riskPresentation, type RiskPresentation } from './lib/risk.js';
