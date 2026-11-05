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
  return verifiedOn("2026-10-04", command, ...evidence);
}
function verifiedOn(checkedAt: string, command: string, ...evidence: string[]): SurfaceMaturity {
  return {
    state: "verified", evidence,
    verification: { command, checkedAt, scope: "Local automated domain and enforcement checks; deployment and UI acceptance excluded." },
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
  /**
   * The deployment switch this capability sits behind: the server environment
   * variables, by the names src/lib/env.ts reads, that must ALL be set before
   * any account can reach it. Absent means the code path has no switch.
   *
   * A gated entry is never `stable` (off is what ships) and never `disabled`
   * (built code behind a switch is not missing code). Per-account gates (a
   * rollout list, a plan) are not switches and live in `notes`.
   * tests/capabilities-registry.test.ts holds each list to the real predicate.
   */
  featureFlags?: string[];
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
    summary: "A sequence CRDT with deterministic multi-peer convergence. A library only: no editor, transport or route uses it, so no one can co-edit yet.",
    status: "experimental",
    platforms: [],
    notes: "src/lib/collaboration/crdt.ts is imported by its tests (tests/crdt-convergence.test.ts, tests/swarm-and-crdt.test.ts) and nothing else.",
  },
  agent_swarm_orchestration: {
    id: "agent_swarm_orchestration",
    maturity: surfaces(
      verified(
        "npx tsx --test tests/orbit-team.test.ts tests/multi-agent-orchestration.test.ts && ORBIT_TEST_DATABASE_URL=<loopback *_test db> NODE_OPTIONS=--conditions=react-server npx tsx --test tests/orbit-team.integration.test.ts",
        "src/lib/agents/team.ts", "src/lib/agents/team-store.ts", "src/lib/agent/swarm.ts", "scripts/work-runner.ts", "src/lib/chat/task-tool.ts",
      ),
      implemented("src/components/chat/team-activity.tsx", "src/components/chat/work-run-panel.tsx", "src/app/dev/orbit/gallery.tsx"),
      planned("Native clients draw the lead task through the Work contract but have no team member lines yet."),
      planned("Native clients draw the lead task through the Work contract but have no team member lines yet."),
      planned("Native clients draw the lead task through the Work contract but have no team member lines yet."),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: [
        "No provider-backed team run has been evaluated for answer quality, cost or latency against a single task.",
        "A member waiting on an approval is answered from its own task, which has no conversation; the lead's card says so but cannot answer it in place.",
        "Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded.",
      ],
    },
    name: "Temporary specialist teams",
    summary: "start_task can form a bounded team (two or three specialists, a critic, a lead synthesis); every member is a Work task coordinated from the Work runner with dependency order, contained failures, retries and budget shares.",
    status: "beta",
    platforms: ["web", "macos"],
    requiredPlan: "pro",
  },
  enterprise_sso_oidc: {
    id: "enterprise_sso_oidc",
    maturity: surfaces(
      implemented("src/lib/auth/enterprise-sso.ts"),
      planned("No sign-in route, callback or settings surface calls src/lib/auth/enterprise-sso.ts."),
      planned("No sign-in route, callback or settings surface calls src/lib/auth/enterprise-sso.ts."),
      planned("No sign-in route, callback or settings surface calls src/lib/auth/enterprise-sso.ts."),
      planned("No sign-in route, callback or settings surface calls src/lib/auth/enterprise-sso.ts."),
    ),
    production: { accepted: false, evidence: [], blockers: ["A sign-in route, identity-provider configuration and an enterprise tenant to accept it against do not exist yet."] },
    name: "Enterprise OIDC Single Sign-On",
    summary: "OpenID Connect assertion verification (JWKS signature validation, replay defence) as a library. Nothing signs anyone in with it yet: it is imported only by tests/enterprise-sso.test.ts.",
    status: "experimental",
    platforms: [],
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
      implemented("src/lib/security/dlp.ts", "src/lib/web/search.ts", "src/lib/web/url-guard.ts", "src/lib/agents/note-review.ts"),
      implemented("src/lib/share-transcript.ts"),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Authenticated end-to-end, enabled deployment, and native release acceptance remain unrecorded."] },
    name: "Data Loss Prevention & Secret Scanning",
    summary: "Deterministic secret detection and redaction (DLP_RULES, scanAndRedact) on outgoing web searches and fetched URLs, agent notes and shared transcripts. The allow/warn/block policy and its audit events (evaluateDlpPolicy) exist, but no destination calls them yet.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
  },
  cloud_connector_google_drive: {
    id: "cloud_connector_google_drive",
    maturity: surfaces(
      implemented("src/lib/first-party-connectors/providers.ts", "src/lib/first-party-connectors/tools.ts", "src/lib/first-party-connectors/sync.ts", "src/app/api/connectors/[id]/sync/route.ts"),
      implemented("src/app/(app)/connections/page.tsx", "src/app/api/connectors/route.ts"),
      planned("The apps list connectors and start the link in the browser (/api/connectors is native in the parity ledger); a signed-in native link has not been checked."),
      planned("The apps list connectors and start the link in the browser (/api/connectors is native in the parity ledger); a signed-in native link has not been checked."),
      planned("The apps list connectors and start the link in the browser (/api/connectors is native in the parity ledger); a signed-in native link has not been checked."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Needs the owner's Google OAuth app for connectors (separate from sign-in); no signed-in link against real Google has been recorded."] },
    name: "Google Drive Cloud Connector",
    summary: "Google Drive as a first-party connector: search and read files (two read-only tools) and a change feed with page tokens for connector triggers. Off until the owner registers a Google OAuth app.",
    status: "beta",
    platforms: ["web", "macos", "ios"],
    featureFlags: ["CONNECTOR_GOOGLE_CLIENT_ID", "CONNECTOR_GOOGLE_CLIENT_SECRET"],
    notes: "src/lib/connectors/google-drive.ts is an earlier sync client that nothing but tests/connectors-lifecycle.test.ts imports; the connector the app offers is the first-party one.",
  },
  cloud_connector_microsoft_365: {
    id: "cloud_connector_microsoft_365",
    maturity: surfaces(
      implemented("src/lib/first-party-connectors/providers.ts", "src/lib/first-party-connectors/tools.ts", "src/lib/first-party-connectors/sync.ts", "src/app/api/connectors/[id]/sync/route.ts"),
      implemented("src/app/(app)/connections/page.tsx", "src/app/api/connectors/route.ts"),
      planned("The apps list connectors and start the link in the browser (/api/connectors is native in the parity ledger); a signed-in native link has not been checked."),
      planned("The apps list connectors and start the link in the browser (/api/connectors is native in the parity ledger); a signed-in native link has not been checked."),
      planned("The apps list connectors and start the link in the browser (/api/connectors is native in the parity ledger); a signed-in native link has not been checked."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Needs the owner's Microsoft Entra app registration; no signed-in link against a real tenant has been recorded."] },
    name: "Microsoft 365 / OneDrive Connector",
    summary: "OneDrive and SharePoint as a first-party connector: search and read files, with a delta change feed for connector triggers. Off until the owner registers a Microsoft app.",
    status: "beta",
    platforms: ["web", "macos", "ios"],
    featureFlags: ["CONNECTOR_MICROSOFT_CLIENT_ID", "CONNECTOR_MICROSOFT_CLIENT_SECRET"],
    notes: "src/lib/connectors/microsoft-365.ts is an earlier sync client that nothing but tests/connectors-lifecycle.test.ts imports; the connector the app offers is the first-party one.",
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
    notes: "Internal runtime for Chat: src/lib/chat/work-intent.ts notices a multi-deliverable job in a chat message and tells the model to start it with start_task in the same conversation (tests/orbit-team.test.ts); the switcher has no Work destination. Not yet measured: how often the model follows the hint on real providers.",
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
    summary: "Existing identities, tasks, memory, configuration and conversation entry. Hiring needs a plan with agents (refused with an upgrade answer on Free and Lite); a cloud task can save a note for its agent with `remember`, always held for the person's review before any prompt reads it.",
    status: "beta",
    platforms: ["web", "macos"],
    maturity: surfaces(
      implemented("src/lib/agents/store.ts"),
      implemented("src/app/(app)/agents/page.tsx"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentsScreen.swift"),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: [
        "Real workflow, deployment and cross-platform acceptance are pending.",
        "`remember` has run only against a stand-in model API (tests/orbit-truth-runner.integration.test.ts drives the real cloud executor); a Mac run has no such tool.",
        "Native follow-ups: the Mac and iPhone apps do not show notes waiting for review (no Keep or Forget there), and still show the hire field to plans without agents (the server refuses with 402).",
      ],
    },
  },
  orbit_rooms: {
    id: "orbit_rooms",
    name: "Orbit rooms",
    summary: "Two to six agents in one chat: @Agent/@all addressing, routing, bounded handoffs, named speakers, follow-up turns dispatched by the client and refused when stale or duplicate.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      verified(
        "ORBIT_TEST_DATABASE_URL=<loopback *_test db> NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/agents-rooms.test.ts tests/orbit-rooms-route.integration.test.ts",
        "src/lib/agents/rooms.ts", "src/lib/agents/room-store.ts", "src/lib/chat/room-tools.ts", "src/app/api/chat/route.ts", "src/app/api/agents/rooms/route.ts",
      ),
      verified(
        "npx tsx --test tests/agents-room-client.test.ts (+ /dev/orbit?only=room screenshots, light/dark, 390/1280)",
        "src/lib/agents/room-client.ts", "src/components/chat/use-room.ts", "src/components/chat/message-list.tsx", "src/components/chat/chat-view.tsx",
      ),
      planned("Native clients do not read room detail, speakers or dispatch follow-up turns yet."),
      planned("Native clients do not read room detail, speakers or dispatch follow-up turns yet."),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: [
        "No signed-in browser session has run a room against a real provider; the route is proven with a scripted model.",
        "Real workflow, deployment and cross-platform acceptance are pending.",
      ],
    },
  },
  orbit_goals: {
    id: "orbit_goals",
    name: "Orbit goals",
    summary: "Durable goals (milestones, success criteria, blockers, progress, next action, budget, run bound) advanced one bounded step at a time through ordinary Work tasks; met only when the last step's cloud run checks the success criteria with the agent's model and the check passes, otherwise unverified for the person to check; the task board projects the ledger with dependencies, deadlines, leases and stale reclamation.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      verified(
        "npx tsx --test tests/orbit-goals.test.ts && ORBIT_TEST_DATABASE_URL=<loopback *_test db> NODE_OPTIONS=--conditions=react-server npx tsx --test tests/orbit-goals.integration.test.ts",
        "src/lib/agents/goals.ts", "src/lib/agents/goal-runner.ts", "src/lib/work/board.ts", "src/lib/work/store.ts",
        "prisma/migrations/20261004183000_orbit_goals_ledger_teams/migration.sql", "src/app/api/agents/[id]/goals/[goalId]/advance/route.ts", "src/app/api/agents/[id]/board/route.ts",
      ),
      implemented("src/components/agents/agent-goal-row.tsx", "src/components/agents/agent-panel.tsx", "src/app/dev/orbit/gallery.tsx"),
      planned("Native goal views decode the existing fields only; milestones, blockers and Continue are not drawn."),
      planned("Native goal views decode the existing fields only; milestones, blockers and Continue are not drawn."),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: [
        "The goal sweep runs in the agent reflector process; its deployed schedule and a real multi-day goal have not been observed.",
        "The success-criteria check has run only against a stand-in model API through the real cloud executor (tests/orbit-truth-runner.integration.test.ts); no real model has judged a goal.",
        "Real workflow, deployment and cross-platform acceptance are pending.",
      ],
    },
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
    platforms: ["web", "macos", "ios"],
    maturity: surfaces(
      blocked("src/lib/computer/store.ts", "Production security acceptance requires a real docker host: in-flight xdotool/shell cancellation and process freeze during takeover, Xvfb access control, egress proxy and DNS policy, VNC rotation on lapse, orphan reconciliation and volume quotas (docs/rework/program/SECURITY_PERMISSIONS.md §3)."),
      implemented("src/components/agents/computer-viewer.tsx"),
      implemented("native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentComputerView.swift"),
      planned("Native integration and acceptance have not been verified in this audit."),
    ),
    production: { accepted: false, evidence: [], blockers: ["Real host takeover race, process freeze, network isolation and cleanup acceptance are pending."] },
    featureFlags: ["COMPUTER_PROVIDER"],
    serverDependency: "agent_computer_host",
    requiredPlan: "pro",
    notes: "Off unless COMPUTER_PROVIDER (legacy alias AGENT_COMPUTER_PROVIDER) names docker or remote. Even then AGENT_COMPUTER_ROLLOUT decides who: allowlist (the default) admits only AGENT_COMPUTER_ALLOWLIST, plans admits every plan that includes one (src/lib/computer/access.ts). Runbook: docs/design/agents-v2/ENABLE_COMPUTERS.md.",
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
    summary:
      "Workbooks (formulas, recalculation, charts), documents (blocks, comments, tracked revisions) and decks (theme, layouts, charts, notes) stored as semantic models, edited incrementally by operations from chat or the canvas, versioned with undo and proposals, exported to XLSX/DOCX/PPTX.",
    status: "beta",
    platforms: ["web"],
    maturity: surfaces(
      verified(
        "npx tsx --test tests/semantic-workbook.test.ts tests/semantic-document.test.ts tests/semantic-deck.test.ts tests/artifact-ops.test.ts && SEMANTIC_TEST_DATABASE_URL=<throwaway> NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/semantic-artifact-chat.integration.test.ts",
        "src/lib/work/deliverables/semantic/index.ts",
        "src/lib/artifact-ops.ts",
        "src/app/api/artifacts/[id]/ops/route.ts",
        "tests/semantic-artifact-chat.integration.test.ts"
      ),
      implemented(
        "src/components/semantic/semantic-artifact-view.tsx",
        "src/components/canvas/canvas-panel.tsx",
        "src/app/dev/deliverables/gallery.tsx"
      ),
      planned("Installed Mac builds skip SPREADSHEET/DOCUMENT/PRESENTATION rows (lenient NativeArtifactKind decode); no native semantic view yet."),
      planned("Installed iOS builds skip SPREADSHEET/DOCUMENT/PRESENTATION rows (lenient NativeArtifactKind decode); no native semantic view yet."),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: [
        "Signed-in canvas acceptance with a real model, native clients and Office/Keynote/Numbers open checks are pending.",
      ],
    },
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
  agent_vault: {
    id: "agent_vault",
    name: "Saved logins for agents",
    summary: "A person saves a site login (and an optional two-step key) for one agent; on that site's exact https origin the agent's computer has it typed by the platform after a one-time approval, and the model only ever sees the login's label and site.",
    status: "experimental",
    platforms: ["web"],
    maturity: surfaces(
      verifiedOn(
        "2026-10-31",
        "npx tsx --test tests/agent-vault.test.ts",
        "src/lib/computer/vault-store.ts", "src/lib/computer/vault-fill.ts", "src/lib/computer/vault-policy.ts", "src/lib/computer/vault-run.ts",
        "src/app/api/agents/[id]/credentials/route.ts",
      ),
      implemented("src/components/agents/agent-logins.tsx"),
      planned("No native client surface for an agent's saved logins yet."),
      planned("No native client surface for an agent's saved logins yet."),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: [
        "Off by default: needs AGENT_VAULT_ENABLED=1 beside a docker or remote computer provider (docs/design/agents-v2/VAULT.md).",
        "No login has been filled into a real site from a real agent computer.",
      ],
    },
    featureFlags: ["AGENT_VAULT_ENABLED", "COMPUTER_PROVIDER"],
    serverDependency: "agent_computer_host",
    requiredPlan: "pro",
    notes: "Separate from credential_broker (Alevr Secrets for Work runs). Off, the routes answer { credentials: null } and refuse writes, and the runner never builds computer_fill_login.",
  },
  agent_payments: {
    id: "agent_payments",
    name: "Agent payment cards",
    summary: "An agent asks for one payment; after the person approves it (asked under every policy, never a standing grant) a single-use card for exactly that amount is issued, typed into the checkout on the agent's computer and cancelled after use or expiry, within a monthly per-agent limit. The model never holds a card number.",
    status: "experimental",
    platforms: ["web"],
    maturity: surfaces(
      verifiedOn(
        "2026-10-31",
        "npx tsx --test tests/payments.test.ts",
        "src/lib/payments/service.ts", "src/lib/payments/stripe-issuing.ts", "src/lib/payments/config.ts", "src/lib/payments/policy.ts",
        "src/lib/chat/payment-tools.ts", "src/app/api/payments/stripe-issuing/webhook/route.ts",
      ),
      implemented("src/components/chat/approval-card.tsx"),
      planned("Native approval cards do not offer Pay yet."),
      planned("Native approval cards do not offer Pay yet."),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: [
        "Off by default: needs a Stripe Issuing program and all three STRIPE_ISSUING_* values (docs/design/agents-v2/ENABLE_PAYMENTS.md).",
        "No card has been issued, authorised or cancelled against live Stripe Issuing.",
      ],
    },
    featureFlags: ["STRIPE_ISSUING_SECRET_KEY", "STRIPE_ISSUING_CARDHOLDER_ID", "STRIPE_ISSUING_WEBHOOK_SECRET"],
    serverDependency: "stripe_issuing",
    requiredPlan: "pro",
    notes: "Off, the payment tools are never offered, so the model is not told payments exist. AGENT_PAYMENTS_TEST_PROVIDER=1 turns on a test provider outside production only.",
  },
  teach_alevr: {
    id: "teach_alevr",
    name: "Teach by demonstration",
    summary: "The person shows an agent a task once on its computer (Show it how); the steps are recorded with values redacted, and the agent drafts a skill from the trace that the person reviews on the Teach page and saves off until they confirm what it may use.",
    status: "experimental",
    platforms: ["web"],
    maturity: surfaces(
      verifiedOn(
        "2026-10-31",
        "npx tsx --test tests/teach-demonstration.test.ts",
        "src/lib/teach/demonstration.ts", "src/lib/teach/recorder.ts", "src/lib/teach/service.ts", "src/lib/teach/server.ts",
        "src/app/api/agents/[id]/computer/demonstration/route.ts", "src/app/api/agents/[id]/computer/demonstration/draft/route.ts",
      ),
      implemented("src/components/agents/computer-teach.tsx", "src/components/skills/teach/teach-page.tsx", "src/app/(app)/skills/teach/page.tsx"),
      planned("The demonstration routes are planned in the parity ledger; the overlay is web only."),
      planned("The demonstration routes are planned in the parity ledger; the overlay is web only."),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: [
        "Off by default: needs AGENT_TEACH_ENABLED=1 beside working agent computers (docs/design/agents-v2/TEACH.md, Owner setup).",
        "No recording has been made on a real agent computer host, and no model-drafted skill from one has been reviewed.",
      ],
    },
    featureFlags: ["AGENT_TEACH_ENABLED", "COMPUTER_PROVIDER"],
    serverDependency: "agent_computer_host",
    requiredPlan: "pro",
    notes: "Off, every demonstration route answers teach_off (404) before reading anything. Only the main frame is captured. A skill taught in chat (draft_skill) is separate and needs no switch.",
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
    name: "Message agents from iMessage",
    summary: "A person verifies their number with a texted code and then texts their agents (@Name, or their first active agent) through a hosted Sendblue line; agents answer by text with no tools, both turns land in the agent's thread, and approvals are only ever pointed to by link, never answered by text.",
    status: "experimental",
    platforms: ["web"],
    maturity: surfaces(
      verifiedOn(
        "2026-10-31",
        "npx tsx --test tests/imessage-channel.test.ts tests/imessage-channel-store.test.ts",
        "src/lib/channels/inbound.ts", "src/lib/channels/sendblue.ts", "src/lib/channels/store.ts", "src/lib/channels/webhook.ts",
        "src/app/api/channels/sendblue/webhook/route.ts", "src/app/api/channels/imessage/route.ts",
      ),
      implemented("src/components/settings/sections/imessage.tsx"),
      planned("The Mac relay (src/lib/channels/mac-relay.ts) is a stub: nothing selects it and its send refuses, and the Mac app has no relay half."),
      planned("No native settings surface for linking a number."),
    ),
    production: {
      accepted: false,
      evidence: [],
      blockers: [
        "Off by default: needs a Sendblue account and line, and all four CHANNEL_SENDBLUE_* values (docs/design/agents-v2/ENABLE_IMESSAGE.md).",
        "No text has gone through a real Sendblue line to a real agent and back.",
      ],
    },
    featureFlags: ["CHANNEL_SENDBLUE_API_KEY_ID", "CHANNEL_SENDBLUE_API_SECRET_KEY", "CHANNEL_SENDBLUE_FROM_NUMBER", "CHANNEL_SENDBLUE_WEBHOOK_SECRET"],
    serverDependency: "sendblue",
    requiredPlan: "pro",
    notes: "All four values or nothing: with any one missing every channel route answers 404 and notifyUser never loads the channel code. iMessage is the only channel; Slack, WhatsApp and the Mac relay are not built.",
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
