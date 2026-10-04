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
    summary: "Scoped facts with provenance, subject-aware corrections, transitions, merges, confirmation decay, explicit agent memory grants and reviewed procedural (skill) proposals, scored by the memory evaluation suite.",
    status: "beta",
    platforms: ["web", "macos", "ios", "ipados"],
    maturity: surfaces(
      verified(
        "npx tsx --test tests/memory-*.test.ts tests/procedural-memory.test.ts && npx tsx scripts/memory-bench.ts --suite && MEMORY_TEST_DATABASE_URL=<loopback db> NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/memory-scope-db.test.ts tests/procedural-memory-db.test.ts tests/memory-clear-project-db.test.ts",
        "src/lib/memory.ts", "src/lib/memory-lifecycle.ts", "src/lib/memory-scope.ts", "src/lib/memory-eval.ts",
        "src/lib/procedural-memory.ts", "tests/fixtures/memory-eval-record.json", "tests/memory-scope-db.test.ts",
      ),
      implemented(
        "src/components/memory/memory-manager.tsx", "src/components/memory/skill-candidates.tsx",
        "src/components/agents/agent-panel.tsx", "docs/rework/program/evidence/memory/rows-provenance.png",
      ),
      implemented("native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeMemoryManagerView.swift"),
      implemented("native/iOS/JunoMobile/App/JunoMobileMemoryView.swift"),
    ),
    production: { accepted: false, evidence: [], blockers: ["Live-model accuracy, authenticated UI workflow, deployment and native parity for the 2026-10-04 additions are unaccepted."] },
  },
  memory_session_search: {
    id: "memory_session_search",
    name: "Conversation recall",
    summary: "Full-history search of actual past messages over a per-account encrypted blind-token index; hybrid lexical/entity/time/project/recency ranking with no model call.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      verified(
        "npx tsx --test tests/recall-index-core.test.ts tests/unified-search.test.ts && MEMORY_TEST_DATABASE_URL=<loopback db> npx tsx --test tests/recall-index-db.test.ts && RECALL_BENCH_DATABASE_URL=<loopback db> npx tsx scripts/recall-bench.ts",
        "src/lib/recall/index-core.ts", "src/lib/recall/service.ts", "src/lib/search/sql.ts", "tests/recall-index-db.test.ts",
      ),
      implemented("src/lib/search/index.ts", "src/lib/tools/specs/search-chats.ts"),
      planned("Native clients do not call unified search for message recall yet."),
      planned("Native clients do not call unified search for message recall yet."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Production backfill (scripts/recall-index-backfill.ts), deployed latency on real accounts and native integration are pending."] },
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
    name: "Alevr Search",
    summary: "Provider-neutral search tools (web_search, search_news, web_fetch, find_in_page) on every tool-capable model: one discovery interface (paid APIs, operator SearXNG, Wikipedia API) chosen by quality floor and cost, a Postgres page/query cache with revalidation and FTS ranking, and Research's fan-out on the same backends.",
    status: "beta",
    platforms: ["web", "macos", "ios", "ipados"],
    maturity: surfaces(
      verified(
        "npx tsx --test tests/alevr-search-*.test.ts tests/web-search-profile.test.ts && ALEVR_SEARCH_TEST_DATABASE_URL=<loopback db> npx tsx --test tests/alevr-search-store-db.test.ts",
        "src/lib/search/alevr/service.ts", "src/lib/search/alevr/backends.ts", "src/lib/search/alevr/rank.ts",
        "src/lib/search/alevr/store.ts", "src/lib/search/alevr/retrieve.ts", "src/lib/search/alevr/policy.ts",
        "src/lib/search/alevr/turn.ts", "src/app/api/chat/route.ts", "src/lib/research/tools.ts",
        "prisma/migrations/20261004190400_alevr_search_cache/migration.sql",
      ),
      implemented("src/components/chat/composer.tsx", "src/lib/run/presentation.ts"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeRunPresentation.swift"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeRunTimeline.swift"),
    ),
    production: {
      accepted: false,
      evidence: ["docs/rework/program/SEARCH.md", "docs/rework/program/evidence/search-bench.json"],
      blockers: [
        "No live backend keys in this environment: quality, latency and cost are measured on SIMULATED backends only.",
        "Signed-in chat turn with Alevr Search not exercised against a real provider; private and voice chats keep provider search.",
        "Paid search APIs' result-storage terms need legal review before the query cache is enabled for them (ALEVR_SEARCH_NO_STORE_BACKENDS).",
        "Migration 20261004190400_alevr_search_cache not applied to any deployed database; SearXNG not deployed.",
      ],
    },
  },
  auto_routing: {
    id: "auto_routing",
    name: "Auto model routing",
    summary:
      "Task-success router: task classification, provider data-use policy, expected total cost (call + tool rounds + retries + failure × recovery + latency), availability/budget fallbacks, content-free outcome telemetry with shrinkage, and the Auto receipt.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      verified(
        "NODE_OPTIONS=--conditions=react-server npx tsx --test tests/router-decide.test.ts tests/auto-model.test.ts tests/plan-paywall.test.ts tests/eval-harness.test.ts; JUNO_ROUTER_TEST_DATABASE_URL=… npx tsx --test tests/router-telemetry.integration.test.ts",
        "src/lib/router/decide.ts",
        "src/lib/router/data-policy.ts",
        "src/lib/router/telemetry-store.ts",
        "prisma/migrations/20261004190500_auto_router_telemetry/migration.sql",
        "docs/rework/program/AUTO_ROUTER.md",
      ),
      implemented("src/components/chat/auto-receipt.tsx", "src/app/dev/routing/page.tsx", "src/components/settings/sections/models.tsx"),
      planned("Native clients do not render Message.routing yet (the receipt) nor the Auto settings."),
      planned("Native clients do not render Message.routing yet (the receipt) nor the Auto settings."),
    ),
    production: {
      accepted: false,
      evidence: ["docs/rework/program/evidence/eval-2026-10-04-mock.json"],
      blockers: [
        "No live provider evaluation has run: this checkout has no eligible provider key (scripts/eval-juno.ts with EVAL_LIVE=1).",
        "Owner: verify data-use terms for zhipu, moonshot, minimax, mimo, longcat, seedance (ineligible for Auto until then) and attest paid tiers via AUTO_ROUTER_PAID_TIER_PROVIDERS for google/mistral.",
        "Priors come from catalogue grades; no measured RoutingOutcome evidence exists until the migration is deployed and turns accumulate.",
        "Authenticated chat UI check of the receipt is pending (verified only in /dev/routing with the real MessageItem).",
      ],
    },
  },
  cost_budgets: {
    id: "cost_budgets",
    name: "Account, agent, routine and run budgets",
    summary:
      "One budget vocabulary (hard ceiling, current spend, held, window) over the existing account, agent, routine and run stores; enforcement unchanged.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      verified(
        "NODE_OPTIONS=--conditions=react-server npx tsx --test tests/budgets.test.ts tests/agents-budget.test.ts; JUNO_ROUTER_TEST_DATABASE_URL=… npx tsx --test tests/budgets-store.integration.test.ts",
        "src/lib/budgets.ts",
        "src/lib/budgets-store.ts",
      ),
      implemented("src/components/agents/agent-panel.tsx", "src/components/work/work-schedule-editor.tsx", "src/components/settings/sections/billing.tsx"),
      planned("Native budget surfaces have not been built for the shared vocabulary."),
      planned("Native budget surfaces have not been built for the shared vocabulary."),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: ["Deployment and signed-in acceptance of the agent and routine budget surfaces are pending."],
    },
  },
  evaluation_harness: {
    id: "evaluation_harness",
    name: "Evaluation harness",
    summary:
      "All §53 categories with labelled mock/live/not_run records (success, latency, cost, tools, model, errors, citation quality) and a router evaluation; pure-function checks renamed to domain checks.",
    status: "experimental",
    platforms: ["web"],
    maturity: surfaces(
      verified(
        "NODE_OPTIONS=--conditions=react-server npx tsx --test tests/eval-harness.test.ts && npm run eval:juno",
        "src/lib/eval/suite.ts",
        "src/lib/eval/runner.ts",
        "scripts/eval-juno.ts",
      ),
      planned("Not a user-facing surface."),
      planned("Not a user-facing surface."),
      planned("Not a user-facing surface."),
    ),
    production: {
      accepted: false,
      evidence: ["docs/rework/program/evidence/eval-2026-10-04-mock.json"],
      blockers: [
        "Mock mode proves graders and routing only; a live run needs provider keys.",
        "Deep Research, memory, agent persistence, browser and Computer Use categories are recorded not_run until replayable harnesses exist.",
      ],
    },
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
    summary: "Leases, exclusive takeover with an epoch fence and holder-only hand-back, secret-input redaction, agent-navigation site policy and teardown on account deletion; security acceptance still blocked on a real host.",
    status: "beta",
    platforms: ["web", "macos"],
    maturity: surfaces(
      blocked("src/lib/computer/store.ts", "Production security acceptance requires a real docker host: in-flight xdotool/shell cancellation and process freeze during takeover, Xvfb access control, egress proxy and DNS policy, VNC rotation on lapse, orphan reconciliation and volume quotas (docs/rework/program/SECURITY_PERMISSIONS.md §3)."),
      implemented("src/components/agents/computer-viewer.tsx"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentComputerView.swift"),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real host takeover race, process freeze, network isolation and cleanup acceptance are pending."] },
  },
  action_permissions: {
    id: "action_permissions",
    name: "Shared action approvals",
    summary: "One permission model: four risk tiers, six grants with ceilings and hard floors, projected from every runtime's native risk names and pinned by a shared contract read by TS, agent-core and Swift.",
    status: "beta",
    platforms: ["web", "macos"],
    maturity: surfaces(
      verified(
        "npx tsx --test tests/permission-conformance.test.ts tests/action-approval.test.ts tests/action-approval-enforcement.test.ts tests/tool-registry.test.ts && (cd runner/agent-core && node --test dist/test/permission-conformance.test.js)",
        "src/lib/permissions/taxonomy.ts",
        "src/lib/action-approval.ts",
        "contracts/permissions/permission-taxonomy.v1.json",
        "tests/permission-conformance.test.ts",
        "runner/agent-core/src/test/permission-conformance.test.ts",
      ),
      implemented("src/lib/action-approval.ts", "src/components/chat/approval-card.tsx", "src/components/work/approvals/approval-card.tsx"),
      verified(
        "cd native/Packages/JunoWork && swift test --filter PermissionConformanceTests",
        "native/Packages/JunoWork/Sources/JunoWorkCore/WorkRisk.swift",
        "native/Packages/JunoWork/Tests/JunoWorkCoreTests/PermissionConformanceTests.swift",
      ),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real workflow, deployment and cross-platform acceptance are pending.", "Mac app target (DesktopWorkExecutorAdapter) not rebuilt after the floor change."] },
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
    summary: "Alevr Secrets: owner-bound sealed logins, task-scoped grants with sites, scopes, expiry and use budgets, MAC'd opaque references, redemption only at the browser fill boundary, revocation, rotation and an access log.",
    status: "experimental",
    platforms: ["web"],
    maturity: surfaces(
      verified(
        "npx tsx --test tests/secrets-broker.test.ts tests/secrets-browser-fill.test.ts tests/secrets-crypto.test.ts && SECRETS_TEST_DATABASE_URL=<local throwaway db> NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/secrets-broker.integration.test.ts",
        "src/lib/secrets/policy.ts",
        "src/lib/secrets/store.ts",
        "src/lib/secrets/browser-fill.ts",
        "prisma/migrations/20261004190000_alevr_secrets/migration.sql",
        "tests/secrets-broker.integration.test.ts",
      ),
      implemented("src/components/permissions/saved-credentials.tsx", "src/app/dev/permissions/gallery.tsx"),
      planned("No native client surface for saved logins yet."),
      planned("No native client surface for saved logins yet."),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: [
        "No authenticated end-to-end fill against a real site in a real Work run.",
        "Production TOKEN_ENCRYPTION_KEYS/PRIMARY provisioning and the migration deploy are owner actions.",
      ],
    },
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
