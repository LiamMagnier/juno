export * from './types.js';
export * from './providers/types.js';
export { AnthropicAdapter, resolveAnthropicKey } from './providers/anthropic.js';
export { OpenAICompatAdapter, COMPAT_PROVIDERS } from './providers/openai-compat.js';
export { OpenAIResponsesAdapter, toResponsesInput } from './providers/openai-responses.js';
export { createProvider, defaultProviderId, listProviders, type ProviderListing, type ModelListing } from './providers/registry.js';
export { readCredentials, resolveKey } from './providers/credentials.js';
export {
  BACKEND_PROVIDER_PREFIX,
  RUN_HEADER,
  createProxyProvider,
  proxyProviderListings,
  type BackendConfig,
  type BackendCatalogModel,
} from './providers/proxy.js';
export { BackendUsageReporter, type UsageReporter, type BackendUsageConfig } from './usage.js';
export * from './tools/types.js';
export { defaultTools } from './tools/registry.js';
export {
  PermissionEngine,
  classifyRisk,
  classifySensitiveCommand,
  loadProjectRules,
  ruleSubjectFor,
  unattendedApprovalAnswer,
  mayGrantAlways,
  ladderRuling,
  permissionRuling,
  actionRiskOf,
  type PermissionEngineOptions,
} from './permissions.js';
export {
  PermissionRule,
  PermissionRuleSet,
  ShellSegments,
  type PermissionRuleDecision,
  type PermissionRuleSubject,
} from './permission-rules.js';
export { CheckpointStore, type FileRollback } from './checkpoints.js';
export { SessionStore, junoHome, sessionsDir } from './session.js';
export { AgentSession, type AgentCallbacks, type AgentOptions } from './agent.js';
export {
  runAgentLoop,
  failureCodeOf,
  ProviderSilenceError,
  ToolExecutionError,
  type AgentFailureCode,
  type AgentLoopOptions,
  type AgentLoopResult,
} from './loop.js';
export { ProviderCallError, classifyProviderError, type ProviderFailureKind } from './providers/errors.js';
export {
  planCompaction,
  compactedMessages,
  estimateTokens,
  toolPairingIntact,
  type CompactionInfo,
  type CompactionOptions,
  type CompactionPlan,
} from './compaction.js';
export {
  SubagentManager,
  isOrchestrationTool,
  orchestrationToolSpecs,
  delegationPromptSection,
  stricterMode,
  SUBAGENT_TOOL_NAMES,
  type SubagentConfig,
  type SubagentHost,
  type SubagentSpec,
  type SubagentRole,
  type SubagentStatus,
  type SubagentIsolation,
  type SubagentPublicState,
} from './subagents.js';
export { startSidecarServer, type SidecarOptions } from './server.js';
// The canonical agent session protocol (contracts/agent), namespaced because
// its `AgentEvent` is the protocol's and this module's is the engine's.
export * as protocol from './protocol.generated.js';
export {
  AgentProtocolProjector,
  protocolMode,
  protocolRisk,
  protocolUsage,
  toolKind,
  toolTitle,
  type ProtocolApprovalAnswer,
  type ProtocolProjectorOptions,
  type ProtocolTurnMessage,
} from './protocol-projector.js';
export {
  LegacyTaskDowncast,
  DERIVED_FROM_PROTOCOL_KEY,
  type LegacyTaskDowncastOptions,
  type LegacyTaskRow,
} from './protocol-legacy.js';
// Alevr Code v2 shared contracts (byte copy of src/lib/code-v2/contracts.ts).
export * as codeV2 from './contracts/code-v2.js';
