import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * Alevr Release Truth & Capability Registry
 *
 * The canonical machine-readable registry of feature status across platforms.
 * A feature disabled in production must never be presented as generally available.
 */

export type FeatureStatus = "stable" | "beta" | "experimental" | "disabled";
export type SupportedPlatform = "web" | "macos" | "ios" | "ipados";

export const CAPABILITY_MATURITY_STATES = [
  "planned", "scaffolded", "implemented", "verified", "enabled",
  "production_accepted", "blocked", "deprecated",
] as const;
export type CapabilityMaturity = (typeof CAPABILITY_MATURITY_STATES)[number];
export type CapabilitySurface = "backend" | SupportedPlatform;
export const CAPABILITY_SURFACES: readonly CapabilitySurface[] = ["backend", "web", "macos", "ios", "ipados"];

export interface SurfaceMaturity {
  state: CapabilityMaturity;
  /** Repository-relative evidence. Existence establishes implementation, never acceptance. */
  evidence: string[];
  blockers?: string[];
  verification?: { command: string; checkedAt: string; scope: string };
}

function implemented(...evidence: string[]): SurfaceMaturity {
  return { state: "implemented", evidence };
}
function verified(command: string, ...evidence: string[]): SurfaceMaturity {
  return {
    state: "verified", evidence,
    verification: { command, checkedAt: "2026-10-04", scope: "Local automated domain and enforcement checks; deployment and UI acceptance excluded." },
  };
}
function planned(blocker: string): SurfaceMaturity {
  return { state: "planned", evidence: [], blockers: [blocker] };
}
function blocked(evidence: string, blocker: string): SurfaceMaturity {
  return { state: "blocked", evidence: [evidence], blockers: [blocker] };
}
function surfaces(
  backend: SurfaceMaturity,
  web: SurfaceMaturity,
  macos: SurfaceMaturity,
  ios: SurfaceMaturity,
  ipados: SurfaceMaturity = ios,
): Record<CapabilitySurface, SurfaceMaturity> {
  return { backend, web, macos, ios, ipados };
}

export interface CapabilityEntry {
  id: string;
  name: string;
  summary: string;
  /** Legacy presentation channel; `stable` is not a release acceptance claim. */
  status: FeatureStatus;
  maturity: Record<CapabilitySurface, SurfaceMaturity>;
  production: { accepted: boolean; evidence: string[]; blockers: string[] };
  platforms: SupportedPlatform[];
  serverDependency?: string;
  featureFlag?: string;
  requiredPlan?: "free" | "plus" | "pro" | "team" | "enterprise";
  notes?: string;
}

export const CANONICAL_CAPABILITY_REGISTRY: Record<string, CapabilityEntry> = {
  chat_streaming: {
    id: "chat_streaming",
    maturity: surfaces(
      verified(
        "CHAT_TURN_TEST_DATABASE_URL=<loopback db> NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/chat-turn-pipeline.integration.test.ts && npx tsx --test tests/chat-turn-trace.test.ts tests/chat-turn-reliability.test.ts",
        "src/app/api/chat/route.ts", "src/lib/chat/turn/run-turn.ts", "src/lib/chat/turn/trace.ts", "docs/rework/program/ORCHESTRATION.md",
      ),
      implemented("src/components/chat/chat-view.tsx"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoChatKit/ChatStreamReducer.swift"),
      implemented("native/iOS/JunoMobile/App/JunoMobileConversationsView.swift"),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Conversational Chat & SSE Streaming",
    summary: "Real-time streaming conversation across multiple LLM providers with tool executions and reasoning.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
  },
  realtime_voice: {
    id: "realtime_voice",
    maturity: surfaces(
      implemented("src/lib/voice-relay-protocol.ts"),
      implemented("src/hooks/use-realtime-voice.ts"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoVoiceKit/JunoRealtimeVoiceController.swift"),
      implemented("native/iOS/JunoMobile/App/JunoMobileVoiceView.swift"),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Bidirectional Real-Time Voice",
    summary: "Native low-latency speech-to-speech audio streaming via WebSocket voice relay.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
    serverDependency: "voice_relay",
    requiredPlan: "pro",
  },
  live_multimodal: {
    id: "live_multimodal",
    maturity: surfaces(
      implemented("src/lib/voice-relay-protocol.ts"),
      implemented("src/hooks/use-realtime-voice.ts"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoVoiceKit/JunoRealtimeVoiceController.swift"),
      implemented("native/iOS/JunoMobile/App/JunoMobileVoiceCamera.swift"),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Live Multimodal Sessions",
    summary: "Simultaneous voice, camera, and screen sharing stream with real-time model comprehension.",
    status: "beta",
    platforms: ["web", "macos", "ios"],
    serverDependency: "voice_relay",
    requiredPlan: "pro",
  },
  canvas_crdt_sync: {
    id: "canvas_crdt_sync",
    maturity: surfaces(
      implemented("src/lib/collaboration/crdt.ts"),
      planned("CRDT transport/editor integration has not been established."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Canvas CRDT Collaboration",
    summary: "Multi-peer real-time collaborative editing with deterministic sequence CRDT convergence.",
    status: "stable",
    platforms: ["web", "macos", "ios"],
  },
  agent_swarm_orchestration: {
    id: "agent_swarm_orchestration",
    maturity: surfaces(
      implemented("src/lib/agent/swarm.ts"),
      planned("Specialist coordination UI and durable integration require acceptance."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Multi-Agent Team Orchestration",
    summary: "DAG-based specialist agent coordination across Planner, Researcher, Coder, and Reviewer roles.",
    status: "beta",
    platforms: ["web", "macos"],
    requiredPlan: "pro",
  },
  enterprise_sso_oidc: {
    id: "enterprise_sso_oidc",
    maturity: surfaces(
      implemented("src/lib/auth/enterprise-sso.ts"),
      implemented("src/lib/auth/enterprise-sso.ts"),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Enterprise OIDC Single Sign-On",
    summary: "Cryptographic OpenID Connect assertion verification with JWKS signature validation and replay defense.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
    requiredPlan: "enterprise",
  },
  enterprise_sso_saml: {
    id: "enterprise_sso_saml",
    maturity: surfaces(
      blocked("src/lib/auth/enterprise-sso.ts", "Audited XMLDSig implementation is required; validation currently throws."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Enterprise SAML 2.0 Single Sign-On (Experimental)",
    summary: "SAML 2.0 XML assertion integration (experimental; disabled in production pending audited XMLDSig integration. Enterprise customers must use OIDC SSO).",
    status: "experimental",
    platforms: ["web", "macos"],
    requiredPlan: "enterprise",
  },
  enterprise_dlp_policy: {
    id: "enterprise_dlp_policy",
    maturity: surfaces(
      implemented("src/lib/security/dlp.ts"),
      implemented("src/lib/security/dlp.ts"),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Data Loss Prevention & Secret Scanning",
    summary: "Deterministic secret detection and policy enforcement (allow/warn/block) with audit event logging.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
  },
  cloud_connector_google_drive: {
    id: "cloud_connector_google_drive",
    maturity: surfaces(
      implemented("src/lib/connectors/google-drive.ts"),
      implemented("src/components/connections/credentials-dialog.tsx"),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Google Drive Cloud Connector",
    summary: "Full-lifecycle Google Drive and Workspace synchronization with pagination and change tokens.",
    status: "stable",
    platforms: ["web", "macos", "ios"],
  },
  cloud_connector_microsoft_365: {
    id: "cloud_connector_microsoft_365",
    maturity: surfaces(
      implemented("src/lib/connectors/microsoft-365.ts"),
      implemented("src/components/connections/credentials-dialog.tsx"),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Microsoft 365 / OneDrive Connector",
    summary: "Full-lifecycle OneDrive and SharePoint document synchronization with delta queries.",
    status: "stable",
    platforms: ["web", "macos", "ios"],
  },
  juno_code_local: {
    id: "juno_code_local",
    maturity: surfaces(
      implemented("runner/agent-core/src/loop.ts"),
      planned("Local workbench is macOS-specific."),
      implemented("native/Packages/JunoNativeKit/Sources/JunoCodeKit/NativeCodeModel.swift"),
      planned("Mobile focuses on remote supervision."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: `${PRODUCT_NAME} Code Local Workbench`,
    summary: "Native macOS software engineering workspace with subagents, diffs, terminal execution, and approvals.",
    status: "stable",
    platforms: ["macos"],
  },
  juno_code_remote: {
    id: "juno_code_remote",
    maturity: surfaces(
      implemented("src/app/api/code/tasks/route.ts"),
      implemented("src/app/(app)/code/page.tsx"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoCodeKit/NativeCodeModel.swift"),
      implemented("native/iOS/JunoMobile/App/JunoMobileCodeView.swift"),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: `${PRODUCT_NAME} Code Remote Supervision`,
    summary: "Cross-device monitoring and supervision of running Code tasks.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
  },
  juno_work_agent: {
    id: "juno_work_agent",
    maturity: surfaces(
      implemented("src/lib/work/broker.ts"),
      implemented("src/lib/work/store.ts"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoWorkKit/NativeWorkClient.swift"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoWorkKit/NativeWorkClient.swift"),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: `${PRODUCT_NAME} Work Agent Engine`,
    summary: "Multi-step autonomous task execution with structured deliverables and action approval plane.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
  },
  offline_mutation_outbox: {
    id: "offline_mutation_outbox",
    maturity: surfaces(
      planned("Outbox is a client-side subsystem."),
      planned("Web offline replay has not been established."),
      implemented("native/Packages/JunoNativeKit/Sources/JunoSync/PersistentMutationOutbox.swift"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoSync/PersistentMutationOutbox.swift"),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Native Offline Mutation Outbox",
    summary: "Transactional local queuing and deterministic replay of mutations during network disconnection.",
    status: "stable",
    platforms: ["macos", "ios", "ipados"],
  },
  memory_durable: {
    id: "memory_durable",
    name: "Durable memory",
    summary: "Scoped facts, corrections, provenance and asynchronous consolidation.",
    status: "beta",
    platforms: ["web", "macos", "ios", "ipados"],
    maturity: surfaces(
      verified("npx tsx --test tests/memory-summary-changes.test.ts tests/memory-bench.test.ts tests/memory-lifecycle.test.ts tests/memory-project.test.ts tests/memory-rejudge.test.ts tests/memory-forget.test.ts tests/memory-sensitive.test.ts tests/memory-suppression.test.ts tests/memory-dreaming.test.ts", "src/lib/memory.ts", "src/lib/memory-summary-changes.ts", "tests/memory-summary-changes.test.ts", "tests/memory-bench.test.ts"),
      implemented("src/components/memory/memory-manager.tsx"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeMemoryManagerView.swift"),
      implemented("native/iOS/JunoMobile/App/JunoMobileMemoryView.swift"),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending."] },
  },
  memory_session_search: {
    id: "memory_session_search",
    name: "Conversation recall",
    summary: "Search actual historical messages through the existing hybrid recall system.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      implemented("src/lib/search/index.ts", "src/lib/search/engine.ts"),
      implemented("src/lib/tools/specs/search-chats.ts"),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending."] },
  },
  deep_research: {
    id: "deep_research",
    name: "Deep Research",
    summary: "Persisted research planning, evidence collection and report generation inside conversation.",
    status: "beta",
    platforms: ["web", "macos", "ios", "ipados"],
    maturity: surfaces(
      verified(
        "npx tsx --test tests/research*.test.ts && RESEARCH_TEST_DATABASE_URL=<loopback db> npx tsx --test tests/research-completion-db.test.ts",
        "src/lib/research/engine.ts", "src/lib/research/completion.ts",
      ),
      verified(
        "npx tsx --test tests/research-deep-field.test.ts tests/research-workspace.test.ts",
        "src/components/chat/research-run-panel.tsx", "src/components/research/research-console.tsx",
        "src/components/research/deep-field.tsx", "src/components/research/research-recap.tsx", "src/components/research/report-fullscreen.tsx",
      ),
      implemented("native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeResearchRun.swift"),
      implemented("native/iOS/JunoMobile/App/JunoMobileResearchProgress.swift"),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: [
        "No provider-backed research run (plan → parallel evidence → audit → report) has been evaluated for quality, cost or recovery.",
        "Real workflow, deployment and cross-platform acceptance are pending.",
      ],
    },
  },
  alevr_search: {
    id: "alevr_search",
    name: "Provider-neutral search",
    summary: "Existing search providers and safe owned page retrieval.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      implemented("src/lib/web-search.ts"),
      implemented("src/lib/tools/specs/web-search.ts"),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending."] },
  },
  auto_routing: {
    id: "auto_routing",
    name: "Auto model routing",
    summary: "Existing model/provider routing; success/cost/privacy acceptance remains required.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      implemented("src/lib/provider-routing.ts"),
      implemented("src/lib/provider-routing.ts"),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending."] },
  },
  orbit_agents: {
    id: "orbit_agents",
    name: "Persistent Orbit agents",
    summary: "Existing identities, tasks, memory, configuration and conversation entry.",
    status: "beta",
    platforms: ["web", "macos"],
    maturity: surfaces(
      implemented("src/lib/agents/store.ts"),
      implemented("src/app/(app)/agents/page.tsx"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentsScreen.swift"),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending."] },
  },
  orbit_rooms: {
    id: "orbit_rooms",
    name: "Orbit rooms",
    summary: "Existing room storage, delegation and conversation tools.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      implemented("src/lib/agents/room-store.ts"),
      implemented("src/lib/chat/room-tools.ts"),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending."] },
  },
  orbit_goals: {
    id: "orbit_goals",
    name: "Orbit goals",
    summary: "Persisted goals associated with agents.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      implemented("src/app/api/agents/[id]/goals/route.ts"),
      implemented("src/lib/agents/store.ts"),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending."] },
  },
  routines: {
    id: "routines",
    name: "Routines",
    summary: "Existing timezone-aware scheduling and durable execution.",
    status: "beta",
    platforms: ["web", "macos"],
    maturity: surfaces(
      implemented("src/lib/work/schedule.ts"),
      implemented("src/lib/work/triggers.ts"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoWorkKit/NativeWorkAutomationModel.swift"),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending."] },
  },
  computer_cloud: {
    id: "computer_cloud",
    name: "Agent computers",
    summary: "Leases, exclusive takeover and single-use native view grants; security acceptance still blocked.",
    status: "beta",
    platforms: ["web", "macos"],
    maturity: surfaces(
      blocked("src/lib/computer/store.ts", "Production security acceptance requires real host, takeover race, retained credential and network isolation evidence."),
      implemented("src/components/agents/computer-viewer.tsx"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentComputerView.swift"),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending."] },
  },
  action_permissions: {
    id: "action_permissions",
    name: "Shared action approvals",
    summary: "Trusted classification, exact-action receipts and standing grants restricted to reversible writes.",
    status: "beta",
    platforms: ["web", "macos"],
    maturity: surfaces(
      verified("npx tsx --test tests/action-approval.test.ts tests/action-approval-enforcement.test.ts tests/tool-registry.test.ts", "src/lib/action-approval.ts", "tests/action-approval.test.ts", "tests/action-approval-enforcement.test.ts"),
      implemented("src/lib/action-approval.ts"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoWorkKit/JunoWorkApprovalRules.swift"),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending."] },
  },
  semantic_artifacts: {
    id: "semantic_artifacts",
    name: "Editable deliverables",
    summary: "Existing documents, spreadsheets, decks and sites with typed validation.",
    status: "beta",
    platforms: ["web", "macos"],
    maturity: surfaces(
      implemented("src/lib/work/deliverables/index.ts"),
      implemented("src/components/artifacts/artifact-preview.tsx"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoChatKit/ArtifactCanvasView.swift"),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending."] },
  },
  credential_broker: {
    id: "credential_broker",
    name: "Scoped credential broker",
    summary: "Existing encrypted credentials are not a task/domain/scope-restricted broker.",
    status: "disabled",
    platforms: [],
    maturity: surfaces(
      planned("Existing encrypted credentials are not a task/domain/scope-restricted broker."),
      planned("Existing encrypted credentials are not a task/domain/scope-restricted broker."),
      planned("Existing encrypted credentials are not a task/domain/scope-restricted broker."),
      planned("Existing encrypted credentials are not a task/domain/scope-restricted broker."),
      planned("Existing encrypted credentials are not a task/domain/scope-restricted broker."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Existing encrypted credentials are not a task/domain/scope-restricted broker."] },
  },
  teach_alevr: {
    id: "teach_alevr",
    name: "Teach Alevr",
    summary: "Recording, redaction, generated Skill and dry-run acceptance remain required.",
    status: "disabled",
    platforms: [],
    maturity: surfaces(
      planned("Recording, redaction, generated Skill and dry-run acceptance remain required."),
      planned("Recording, redaction, generated Skill and dry-run acceptance remain required."),
      planned("Recording, redaction, generated Skill and dry-run acceptance remain required."),
      planned("Recording, redaction, generated Skill and dry-run acceptance remain required."),
      planned("Recording, redaction, generated Skill and dry-run acceptance remain required."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Recording, redaction, generated Skill and dry-run acceptance remain required."] },
  },
  extensions: {
    id: "extensions",
    name: "Trusted extensions",
    summary: "Package permissions, provenance and update acceptance remain required.",
    status: "disabled",
    platforms: [],
    maturity: surfaces(
      planned("Package permissions, provenance and update acceptance remain required."),
      planned("Package permissions, provenance and update acceptance remain required."),
      planned("Package permissions, provenance and update acceptance remain required."),
      planned("Package permissions, provenance and update acceptance remain required."),
      planned("Package permissions, provenance and update acceptance remain required."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Package permissions, provenance and update acceptance remain required."] },
  },
  external_channels: {
    id: "external_channels",
    name: "External Orbit channels",
    summary: "Identity, replay and approval-boundary acceptance remain required.",
    status: "disabled",
    platforms: [],
    maturity: surfaces(
      planned("Identity, replay and approval-boundary acceptance remain required."),
      planned("Identity, replay and approval-boundary acceptance remain required."),
      planned("Identity, replay and approval-boundary acceptance remain required."),
      planned("Identity, replay and approval-boundary acceptance remain required."),
      planned("Identity, replay and approval-boundary acceptance remain required."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Identity, replay and approval-boundary acceptance remain required."] },
  },
  organization_orbit: {
    id: "organization_orbit",
    name: "Organization Orbit",
    summary: "Shared ownership and personal memory isolation acceptance remain required.",
    status: "disabled",
    platforms: [],
    maturity: surfaces(
      planned("Shared ownership and personal memory isolation acceptance remain required."),
      planned("Shared ownership and personal memory isolation acceptance remain required."),
      planned("Shared ownership and personal memory isolation acceptance remain required."),
      planned("Shared ownership and personal memory isolation acceptance remain required."),
      planned("Shared ownership and personal memory isolation acceptance remain required."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Shared ownership and personal memory isolation acceptance remain required."] },
  },
  web_navigation_performance: {
    id: "web_navigation_performance",
    name: "Immediate web navigation",
    summary: "Mounted app shell, intent prefetch, shared stale-while-revalidate reads and no remount on cross-section navigation, measured on a production build.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      implemented("src/lib/client-cache.ts"),
      {
        state: "verified",
        evidence: [
          "src/components/app/page-transition.tsx", "src/lib/client-cache.ts", "src/lib/intent-prefetch.ts",
          "scripts/perf/measure-navigation.mjs", "docs/rework/program/PERFORMANCE.md", "docs/rework/program/perf/navigation-after-local.json",
        ],
        verification: {
          command: "node scripts/perf/measure-navigation.mjs --runs 3 [--profile remote] && npx tsx --test tests/client-cache.test.ts",
          checkedAt: "2026-10-04",
          scope: "Production build on loopback with a seeded local account, Chrome headless 1440×900, unthrottled and 60 ms/20 Mbit/CPU×2. Not a hosted deployment; no real-user timing.",
        },
      },
      planned("Native shells navigate natively; this web benchmark does not measure them."),
      planned("Native shells navigate natively; this web benchmark does not measure them."),
      planned("Native shells navigate natively; this web benchmark does not measure them."),
    ),
    production: { accepted: false, evidence: [], blockers: ["No measurement against the hosted deployment (real database latency, real accounts) has been recorded."] },
  },
  chat_transcript_virtualization: {
    id: "chat_transcript_virtualization",
    name: "Long-conversation transcript windowing",
    summary: "Dynamic-height windowing with reader anchoring, find and deep-link jumps to unmounted rows, and a streamed reply that re-renders only its own row.",
    status: "beta",
    platforms: ["web", "macos"],
    maturity: surfaces(
      planned("Client rendering concern; the server still sends every message of a conversation in the route payload."),
      {
        state: "verified",
        evidence: [
          "src/lib/chat/transcript-window.ts", "src/hooks/use-transcript-window.ts", "src/hooks/use-latest-handler.ts",
          "src/components/chat/message-list.tsx", "tests/transcript-window.test.ts", "e2e/transcript-window.spec.ts", "e2e/transcript-route.spec.ts",
        ],
        verification: {
          command: "npx tsx --test tests/transcript-window.test.ts && PERF_LONG_CONVERSATION_ID=<seeded> npx playwright test --config scripts/perf/playwright.perf.config.ts e2e/transcript-window.spec.ts e2e/transcript-route.spec.ts",
          checkedAt: "2026-10-04",
          scope: "Development server for render counts and anchoring; production build for frame times and long tasks. Screen-reader behaviour checked structurally (full-transcript mode, log role), not with an assistive-technology user.",
        },
      },
      implemented("native/macOS/JunoDesktop/App/ChatTranscript.swift"),
      planned("iOS transcript windowing has not been measured against a 1,000-message conversation."),
      planned("iPadOS transcript windowing has not been measured against a 1,000-message conversation."),
    ),
    production: { accepted: false, evidence: [], blockers: ["No hosted, real-account acceptance; the 1,000-message route payload is still sent whole."] },
  },
};

/** Implementation availability; never an assertion of deployment or acceptance. */
export function isFeatureAvailable(featureId: string, platform: SupportedPlatform): boolean {
  const cap = CANONICAL_CAPABILITY_REGISTRY[featureId];
  if (!cap || cap.status === "disabled" || !cap.platforms.includes(platform)) return false;
  return ["implemented", "verified", "enabled", "production_accepted"].includes(cap.maturity[platform].state);
}

export function getCapabilitiesForPlatform(platform: SupportedPlatform): CapabilityEntry[] {
  return Object.values(CANONICAL_CAPABILITY_REGISTRY).filter((c) => c.platforms.includes(platform));
}

/** Release claims require recorded acceptance on the backend and requested client. */
export function capabilityReleaseBlockers(featureId: string, platform: SupportedPlatform): string[] {
  const cap = CANONICAL_CAPABILITY_REGISTRY[featureId];
  if (!cap) return ["Unknown capability."];
  const blockers = [...cap.production.blockers];
  if (cap.status === "disabled") blockers.push("Capability is disabled.");
  if (!cap.platforms.includes(platform)) blockers.push(`Capability does not support ${platform}.`);
  for (const surface of ["backend", platform] as const) {
    const maturity = cap.maturity[surface];
    blockers.push(...(maturity.blockers ?? []));
    if (maturity.state !== "production_accepted") blockers.push(`${surface} has no recorded production acceptance.`);
    if (!maturity.evidence.length) blockers.push(`${surface} has no source or acceptance evidence.`);
  }
  if (!cap.production.accepted || !cap.production.evidence.length) blockers.push("Production acceptance evidence is missing.");
  return [...new Set(blockers)];
}

export function isCapabilityProductionAccepted(featureId: string, platform: SupportedPlatform): boolean {
  return capabilityReleaseBlockers(featureId, platform).length === 0;
}
