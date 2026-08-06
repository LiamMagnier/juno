/**
 * The Juno Work orchestration runtime.
 *
 * Kept as its own entry point rather than folded into the package root: the
 * root surface is what a Code shell consumes, and a macOS app that only ever
 * runs coding sessions has no business resolving the plan, tier and injection
 * modules. Consumers import `@juno/agent-core/work` — or, as the cloud runner
 * does today for container-sandbox, deep-import `dist/work/index.js`.
 *
 * Everything is re-exported by name. A star export would make the surface
 * whatever happened to be exported from the modules on the day, which is how
 * an internal helper becomes a public API nobody meant to promise.
 */

export {
  // Vocabulary mirrored from src/lib/work/domain.ts.
  WORK_EVENT_KINDS,
  WORK_RISK_LEVELS,
  WORK_TERMINAL_REASONS,
  WORK_APPROVAL_DECISIONS,
  WORK_TOOL_TIERS,
  WORK_ARTIFACT_KINDS,
  WORK_AUDIT_KINDS,
  WORK_AUDIT_SEVERITIES,
  WORK_PLAN_STEP_STATUSES,
  ALWAYS_CONFIRM_ACTIONS,
  APPROVAL_TTL_MS,
  NO_BUDGET,
  budgetExceeded,
  narrowestBudget,
  permitsTier,
  requiresExplicitApproval,
  toolTier,
  canonicalJson,
  type BudgetUsage,
  type WorkActionRecord,
  type WorkApprovalAnswer,
  type WorkApprovalDecision,
  type WorkApprovalRequest,
  type WorkArtifactKind,
  type WorkArtifactRef,
  type WorkAuditIntent,
  type WorkAuditKind,
  type WorkAuditSeverity,
  type WorkBudget,
  type WorkCitation,
  type WorkDecision,
  type WorkEmittedEvent,
  type WorkEvent,
  type WorkEventKind,
  type WorkInjectionSeverity,
  type WorkInjectionSignal,
  type WorkInjectionSummary,
  type WorkPlanDiff,
  type WorkPlanSnapshot,
  type WorkPlanStep,
  type WorkPlanStepStatus,
  type WorkProgressVerdict,
  type WorkProvenance,
  type WorkQuestion,
  type WorkReport,
  type WorkRiskLevel,
  type WorkStepUsage,
  type WorkTerminalReason,
  type WorkToolCandidate,
  type WorkToolDefinition,
  type WorkToolTierId,
  type WorkValidationCheck,
  type WorkValidationResult,
} from './types.js';

export {
  WorkPlan,
  DEFAULT_REPETITION_THRESHOLD,
  DEFAULT_STALL_THRESHOLD,
  isTerminalStepStatus,
  planDiffIsEmpty,
  type WorkPlanOptions,
  type WorkPlanState,
  type WorkPlanStepInit,
} from './plan.js';

export {
  bestCandidate,
  candidatesForIntent,
  describeTier,
  evaluateTier,
  tierPromptSection,
  type TierDecision,
  type TierRefusalTarget,
  type TierRequest,
} from './tier.js';

export {
  BUDGET_WARNING_FRACTION,
  WorkBudgetGuard,
  systemClock,
  withBudget,
  type Clock,
  type WorkBudgetGuardOptions,
  type WorkBudgetOutcome,
  type WorkBudgetState,
  type WorkBudgetWarning,
  type WorkModelPricing,
} from './budget.js';

export {
  MAX_EXCERPT_CHARS,
  MAX_REPORTED_MATCHES,
  MAX_SCAN_CHARS,
  UNTRUSTED_CLOSE,
  UNTRUSTED_CONTENT_RULE,
  UNTRUSTED_OPEN,
  injectionAuditIntent,
  scanUntrusted,
  summariseVerdict,
  wrapUntrusted,
  type InjectionMatch,
  type InjectionVerdict,
  type ScanOptions,
} from './injection.js';

export {
  MAX_STEPS_PER_RUN,
  WORK_ASK_TOOL_NAME,
  WorkAgentSession,
  askUserToolSpec,
  structuralValidation,
  type WorkCheckpoint,
  type WorkRunResult,
  type WorkSessionCallbacks,
  type WorkSessionOptions,
  type WorkValidator,
} from './session.js';

export {
  asWorkTool,
  blockedFetchTarget,
  cloudFilesTool,
  connectorActionFor,
  connectorTool,
  deliverableTool,
  displayPath,
  htmlToText,
  htmlTitle,
  narrowToPermittedTools,
  stripUntrustedEnvelope,
  toolNames,
  webFetchTool,
  webSearchTool,
  workspaceTools,
  type CloudFileOperation,
  type CloudFileToolDeps,
  type ConnectorAccess,
  type ConnectorToolDeps,
  type ConnectorToolDescriptor,
  type DeliverableOutcome,
  type DeliverableToolDeps,
  type WebFetchDeps,
  type WebSearchDeps,
  type WebSearchHit,
  type WorkToolShape,
} from './tools.js';
