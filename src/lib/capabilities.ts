/**
 * Juno Release Truth & Capability Registry
 *
 * The canonical machine-readable registry of feature status across platforms.
 * A feature disabled in production must never be presented as generally available.
 */

export type FeatureStatus = "stable" | "beta" | "experimental" | "disabled";
export type SupportedPlatform = "web" | "macos" | "ios" | "ipados";

export interface CapabilityEntry {
  id: string;
  name: string;
  summary: string;
  status: FeatureStatus;
  platforms: SupportedPlatform[];
  serverDependency?: string;
  featureFlag?: string;
  requiredPlan?: "free" | "plus" | "pro" | "team" | "enterprise";
  notes?: string;
}

export const CANONICAL_CAPABILITY_REGISTRY: Record<string, CapabilityEntry> = {
  chat_streaming: {
    id: "chat_streaming",
    name: "Conversational Chat & SSE Streaming",
    summary: "Real-time streaming conversation across multiple LLM providers with tool executions and reasoning.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
  },
  realtime_voice: {
    id: "realtime_voice",
    name: "Bidirectional Real-Time Voice",
    summary: "Native low-latency speech-to-speech audio streaming via WebSocket voice relay.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
    serverDependency: "voice_relay",
    requiredPlan: "pro",
  },
  live_multimodal: {
    id: "live_multimodal",
    name: "Live Multimodal Sessions",
    summary: "Simultaneous voice, camera, and screen sharing stream with real-time model comprehension.",
    status: "beta",
    platforms: ["web", "macos", "ios"],
    serverDependency: "voice_relay",
    requiredPlan: "pro",
  },
  canvas_crdt_sync: {
    id: "canvas_crdt_sync",
    name: "Canvas CRDT Collaboration",
    summary: "Multi-peer real-time collaborative editing with deterministic sequence CRDT convergence.",
    status: "stable",
    platforms: ["web", "macos", "ios"],
  },
  agent_swarm_orchestration: {
    id: "agent_swarm_orchestration",
    name: "Multi-Agent Team Orchestration",
    summary: "DAG-based specialist agent coordination across Planner, Researcher, Coder, and Reviewer roles.",
    status: "beta",
    platforms: ["web", "macos"],
    requiredPlan: "pro",
  },
  enterprise_sso_oidc: {
    id: "enterprise_sso_oidc",
    name: "Enterprise OIDC Single Sign-On",
    summary: "Cryptographic OpenID Connect assertion verification with JWKS signature validation and replay defense.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
    requiredPlan: "enterprise",
  },
  enterprise_sso_saml: {
    id: "enterprise_sso_saml",
    name: "Enterprise SAML 2.0 Single Sign-On (Experimental)",
    summary: "SAML 2.0 XML assertion integration (experimental; disabled in production pending audited XMLDSig integration. Enterprise customers must use OIDC SSO).",
    status: "experimental",
    platforms: ["web", "macos"],
    requiredPlan: "enterprise",
  },
  enterprise_dlp_policy: {
    id: "enterprise_dlp_policy",
    name: "Data Loss Prevention & Secret Scanning",
    summary: "Deterministic secret detection and policy enforcement (allow/warn/block) with audit event logging.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
  },
  cloud_connector_google_drive: {
    id: "cloud_connector_google_drive",
    name: "Google Drive Cloud Connector",
    summary: "Full-lifecycle Google Drive and Workspace synchronization with pagination and change tokens.",
    status: "stable",
    platforms: ["web", "macos", "ios"],
  },
  cloud_connector_microsoft_365: {
    id: "cloud_connector_microsoft_365",
    name: "Microsoft 365 / OneDrive Connector",
    summary: "Full-lifecycle OneDrive and SharePoint document synchronization with delta queries.",
    status: "stable",
    platforms: ["web", "macos", "ios"],
  },
  juno_code_local: {
    id: "juno_code_local",
    name: "Juno Code Local Workbench",
    summary: "Native macOS software engineering workspace with subagents, diffs, terminal execution, and approvals.",
    status: "stable",
    platforms: ["macos"],
  },
  juno_code_remote: {
    id: "juno_code_remote",
    name: "Juno Code Remote Supervision",
    summary: "Cross-device monitoring and supervision of running Code tasks.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
  },
  juno_work_agent: {
    id: "juno_work_agent",
    name: "Juno Work Agent Engine",
    summary: "Multi-step autonomous task execution with structured deliverables and action approval plane.",
    status: "stable",
    platforms: ["web", "macos", "ios", "ipados"],
  },
  offline_mutation_outbox: {
    id: "offline_mutation_outbox",
    name: "Native Offline Mutation Outbox",
    summary: "Transactional local queuing and deterministic replay of mutations during network disconnection.",
    status: "stable",
    platforms: ["macos", "ios", "ipados"],
  },
};

export function isFeatureAvailable(featureId: string, platform: SupportedPlatform): boolean {
  const cap = CANONICAL_CAPABILITY_REGISTRY[featureId];
  if (!cap) return false;
  if (cap.status === "disabled") return false;
  return cap.platforms.includes(platform);
}

export function getCapabilitiesForPlatform(platform: SupportedPlatform): CapabilityEntry[] {
  return Object.values(CANONICAL_CAPABILITY_REGISTRY).filter((c) => c.platforms.includes(platform));
}
