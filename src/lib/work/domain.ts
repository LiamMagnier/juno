/**
 * The Juno Work vocabulary.
 *
 * Every status, target, event kind, risk level and capability name Work uses
 * is declared once here. The Prisma columns that hold them are TEXT; this file
 * is what makes them a type, and scripts/generate-work-contract.mjs is what
 * makes the Swift clients agree. A value that is not in this file is not a
 * value Work has.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports, exactly like
 * src/lib/event-envelope.ts. The cloud runner, the route handlers, the
 * scheduler and the tests all need this vocabulary, and three of those four
 * cannot import a Prisma client.
 */

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Every state a session or run can be in.
 *
 * Split into live and terminal below rather than left as one flat list,
 * because almost every caller wants one or the other, and "is this still
 * going" written out longhand at each call site is how a client ends up
 * showing a spinner for a run that failed forty minutes ago.
 */
export const WORK_LIVE_STATUSES = [
  /** Composed but never dispatched. Costs nothing and holds no executor. */
  "draft",
  /** Dispatched, waiting for an executor to claim it. */
  "queued",
  /** Claimed. Fetching inputs, resolving grants, starting the sandbox. */
  "preparing",
  "running",
  /** Blocked on an answer from the user. */
  "waiting_input",
  /** Blocked on an approval decision. */
  "waiting_approval",
  /** Stopped by the user, resumable. */
  "paused",
] as const;

export const WORK_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  /** The executor died without reporting. Distinct from `failed`, which the
   *  run itself decided; nobody decided this one. */
  "interrupted",
  /** A local run whose host went away and whose remaining work needs it. */
  "host_offline",
  "budget_exceeded",
  "timed_out",
] as const;

export const WORK_STATUSES = [...WORK_LIVE_STATUSES, ...WORK_TERMINAL_STATUSES] as const;

export type WorkLiveStatus = (typeof WORK_LIVE_STATUSES)[number];
export type WorkTerminalStatus = (typeof WORK_TERMINAL_STATUSES)[number];
export type WorkStatus = (typeof WORK_STATUSES)[number];

const LIVE = new Set<string>(WORK_LIVE_STATUSES);
const TERMINAL = new Set<string>(WORK_TERMINAL_STATUSES);

export function isWorkStatus(value: string): value is WorkStatus {
  return LIVE.has(value) || TERMINAL.has(value);
}

export function isLiveStatus(value: string): value is WorkLiveStatus {
  return LIVE.has(value);
}

export function isTerminalStatus(value: string): value is WorkTerminalStatus {
  return TERMINAL.has(value);
}

/**
 * Statuses that cannot progress without the user.
 *
 * `host_offline` is here even though it is terminal: the run is over, but the
 * user still has a decision to make (wake the Mac and retry, or move it to
 * cloud), and burying it under "failed" is how that decision never gets made.
 */
const ATTENTION = new Set<string>(["waiting_input", "waiting_approval", "host_offline"]);

export function statusNeedsAttention(value: string): boolean {
  return ATTENTION.has(value);
}

/**
 * The authoritative reason a run ended, recorded once when it ends.
 *
 * Not derived from the last event. The last event of a run killed by an OOM is
 * whatever it happened to be emitting mid-sentence, and a UI that infers from
 * it states a confident wrong cause.
 */
export const WORK_TERMINAL_REASONS = [
  "completed",
  "failed",
  "cancelled",
  "budget_exceeded",
  "timed_out",
  "host_offline",
  "interrupted",
  /** A newer run for the same session took over. */
  "superseded",
] as const;

export type WorkTerminalReason = (typeof WORK_TERMINAL_REASONS)[number];

/** The status a run lands in for a given terminal reason. */
export function statusForTerminalReason(reason: WorkTerminalReason): WorkTerminalStatus {
  switch (reason) {
    case "completed":
      return "completed";
    case "cancelled":
    case "superseded":
      return "cancelled";
    case "budget_exceeded":
      return "budget_exceeded";
    case "timed_out":
      return "timed_out";
    case "host_offline":
      return "host_offline";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
  }
}

// ---------------------------------------------------------------------------
// Execution target
// ---------------------------------------------------------------------------

export const WORK_TARGETS = ["cloud", "local", "automatic"] as const;
export type WorkTarget = (typeof WORK_TARGETS)[number];

/** What actually ran it. `automatic` is a request, never an outcome. */
export const WORK_EFFECTIVE_TARGETS = ["cloud", "local"] as const;
export type WorkEffectiveTarget = (typeof WORK_EFFECTIVE_TARGETS)[number];

/**
 * The capabilities a plan can require and a target can offer.
 *
 * Named for what the user asked for, not for the tool that happens to
 * implement it: "local_files" stays true when the file tool is rewritten, and
 * a capability list is the thing shown to a user explaining why their task
 * cannot run on the cloud.
 */
export const WORK_CAPABILITIES = [
  /** Read/write files under a granted local folder on a specific Mac. */
  "local_files",
  /** Drive an application on the Mac through its accessibility tree. */
  "local_apps",
  /** Drive a browser profile that is signed in on the Mac. */
  "local_browser",
  /** Screenshot / click / type on the Mac. */
  "local_computer_use",
  /** Run shell commands on the Mac. Developer workflows only. */
  "local_shell",
  /** Fetch and cite public web pages. */
  "web_research",
  /** Call a linked connector or remote MCP server. */
  "connectors",
  /** Read/write files held by Juno or a cloud drive, not a local disk. */
  "cloud_files",
  /** Produce documents, workbooks, decks, PDFs, sites. */
  "deliverables",
  /** Continue with every user device offline. */
  "background_continuation",
] as const;

export type WorkCapability = (typeof WORK_CAPABILITIES)[number];

/** Capabilities that only ever exist on an opted-in Mac. */
export const LOCAL_ONLY_CAPABILITIES: readonly WorkCapability[] = [
  "local_files",
  "local_apps",
  "local_browser",
  "local_computer_use",
  "local_shell",
];

/** Capabilities the cloud can serve. */
export const CLOUD_CAPABILITIES: readonly WorkCapability[] = [
  "web_research",
  "connectors",
  "cloud_files",
  "deliverables",
  "background_continuation",
];

const LOCAL_ONLY = new Set<string>(LOCAL_ONLY_CAPABILITIES);

export function requiresLocalHost(capabilities: readonly string[]): boolean {
  return capabilities.some((c) => LOCAL_ONLY.has(c));
}

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

/**
 * Why the run that executed differs from the run that was asked for.
 *
 * Mirrors the shape of contracts/capabilities/juno-capabilities-v1.json's
 * degradation kinds, for the same reason it exists there: a client that cannot
 * name a degradation shows the user nothing, and showing nothing is
 * indistinguishable from nothing having gone wrong.
 */
export const WORK_DEGRADATION_KINDS = [
  "target_substituted",
  "model_substituted",
  "capability_unavailable",
  "connector_unavailable",
  "host_offline",
  "local_portion_skipped",
  "budget_reduced",
  "skill_version_pinned",
] as const;

export type WorkDegradationKind = (typeof WORK_DEGRADATION_KINDS)[number];

export interface WorkDegradation {
  kind: WorkDegradationKind;
  /** One sentence, addressed to the user, in plain language. */
  explanation: string;
  /** The capability or connector this is about, when it is about one. */
  subject?: string;
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

/** What a candidate host can currently do, as the host itself advertised it. */
export interface HostCapabilityView {
  hostId: string;
  displayName: string;
  /** online | idle | stale | offline. */
  state: string;
  enabled: boolean;
  revoked: boolean;
  capabilities: readonly string[];
}

export interface TargetSelectionInput {
  requested: WorkTarget;
  required: readonly WorkCapability[];
  /** Hosts the user has, in preference order (preferred host first). */
  hosts: readonly HostCapabilityView[];
  /** Whether the cloud executor is accepting work at all. */
  cloudAvailable: boolean;
}

export interface TargetSelection {
  /** Null when nothing can run this. The caller must NOT queue in that case. */
  target: WorkEffectiveTarget | null;
  hostId: string | null;
  /** Capabilities the chosen target advertised. */
  available: WorkCapability[];
  /** Required capabilities the chosen target cannot serve. */
  missing: WorkCapability[];
  degradation: WorkDegradation[];
  /** One sentence the UI shows before the run starts. Always populated. */
  explanation: string;
}

function hostIsUsable(host: HostCapabilityView): boolean {
  return host.enabled && !host.revoked && (host.state === "online" || host.state === "idle");
}

/**
 * Picks cloud or local, deterministically, and says why.
 *
 * Deterministic and pure so it can be unit-tested against the awkward cases
 * rather than observed in production: the Mac that is enabled but asleep, the
 * task that needs one local capability out of six, the account with two Macs
 * where only the second one has been granted a folder.
 *
 * Returns `target: null` rather than defaulting to cloud when local work is
 * genuinely required and no host can do it. A queued task with no possible
 * executor is the specific failure the work order calls out: it renders as a
 * spinner that never resolves, and the user is never told that nothing is
 * going to happen.
 */
export function selectTarget(input: TargetSelectionInput): TargetSelection {
  const required = [...new Set(input.required)];
  const localNeeded = required.filter((c) => LOCAL_ONLY.has(c));
  const usable = input.hosts.filter(hostIsUsable);

  const scoreHost = (host: HostCapabilityView) =>
    localNeeded.filter((c) => host.capabilities.includes(c)).length;

  // A host that serves every local capability, preferring the first listed
  // (the caller puts the session's preferred host first).
  const fullyCapable = usable.find((h) => scoreHost(h) === localNeeded.length);

  const cloudCovers = (c: WorkCapability) => CLOUD_CAPABILITIES.includes(c);

  if (input.requested === "local" || (input.requested === "automatic" && localNeeded.length > 0)) {
    if (fullyCapable) {
      const available = required.filter(
        (c) => fullyCapable.capabilities.includes(c) || cloudCovers(c)
      );
      const missing = required.filter((c) => !available.includes(c));
      const degradation: WorkDegradation[] = missing.map((c) => ({
        kind: "capability_unavailable",
        subject: c,
        explanation: `${fullyCapable.displayName} has not been granted ${describeCapability(c)}.`,
      }));
      return {
        target: "local",
        hostId: fullyCapable.hostId,
        available,
        missing,
        degradation,
        explanation:
          missing.length === 0
            ? `Runs on ${fullyCapable.displayName}, which has every capability this task needs.`
            : `Runs on ${fullyCapable.displayName}. ${missing.length} capability it needs has not been granted there.`,
      };
    }

    // No usable host. The honest outcomes are: run the cloud-only part and say
    // the local part did not happen, or refuse. Never "queued".
    const cloudOnly = required.filter(cloudCovers);
    const offlineHost = input.hosts.find((h) => h.enabled && !h.revoked);
    const why = offlineHost
      ? `${offlineHost.displayName} is ${offlineHost.state}.`
      : input.hosts.length === 0
        ? "No Mac has been switched on for Juno Work."
        : "No Mac is both switched on for Juno Work and reachable.";

    if (input.requested === "local" || cloudOnly.length === 0 || !input.cloudAvailable) {
      return {
        target: null,
        hostId: null,
        available: [],
        missing: required,
        degradation: [{ kind: "host_offline", explanation: why }],
        // `localNeeded` is empty only when a caller asked for `local` outright
        // and named no local capability — the automatic branch cannot reach
        // here with an empty list. The general sentence rendered that as "This
        // task needs , which only a Mac can do." and handed it to the user
        // verbatim. There is nothing to name in that case, because the Mac was
        // the request rather than the requirement, so the second sentence says
        // that instead and says what did not happen.
        explanation:
          localNeeded.length === 0
            ? `${why} This task was set to run on a Mac, so nothing has been started.`
            : `${why} This task needs ${localNeeded.map(describeCapability).join(", ")}, which only a Mac can do.`,
      };
    }

    return {
      target: "cloud",
      hostId: null,
      available: cloudOnly,
      missing: localNeeded,
      degradation: [
        { kind: "host_offline", explanation: why },
        {
          kind: "local_portion_skipped",
          explanation: `The parts that need ${localNeeded.map(describeCapability).join(", ")} will not run.`,
        },
      ],
      explanation: `${why} Juno will do the cloud part only and leave the rest undone.`,
    };
  }

  if (!input.cloudAvailable) {
    return {
      target: null,
      hostId: null,
      available: [],
      missing: required,
      degradation: [
        { kind: "capability_unavailable", explanation: "Cloud Work is not accepting tasks right now." },
      ],
      explanation: "Cloud Work is not accepting tasks right now.",
    };
  }

  const available = required.filter(cloudCovers);
  const missing = required.filter((c) => !cloudCovers(c));
  return {
    target: "cloud",
    hostId: null,
    available,
    missing,
    degradation: missing.map((c) => ({
      kind: "capability_unavailable" as const,
      subject: c,
      explanation: `${describeCapability(c)} needs a Mac; this run is in the cloud.`,
    })),
    explanation:
      missing.length === 0
        ? "Runs in the cloud and keeps going when your devices are offline."
        : "Runs in the cloud. Some steps need a Mac and will not run.",
  };
}

export function describeCapability(capability: string): string {
  switch (capability) {
    case "local_files":
      return "access to a folder on your Mac";
    case "local_apps":
      return "control of an app on your Mac";
    case "local_browser":
      return "your signed-in browser";
    case "local_computer_use":
      return "screen control on your Mac";
    case "local_shell":
      return "a shell on your Mac";
    case "web_research":
      return "web research";
    case "connectors":
      return "your connected apps";
    case "cloud_files":
      return "files stored with Juno";
    case "deliverables":
      return "document and spreadsheet creation";
    case "background_continuation":
      return "running while your devices are offline";
    default:
      return capability;
  }
}

// ---------------------------------------------------------------------------
// Permissions, risk and approvals
// ---------------------------------------------------------------------------

export const WORK_PERMISSION_POLICIES = ["conservative", "balanced", "permissive"] as const;
export type WorkPermissionPolicy = (typeof WORK_PERMISSION_POLICIES)[number];

/**
 * Policy strength, for narrowing.
 *
 * Every layer (host, project, session, schedule, skill) may only ever narrow.
 * Expressing that as a number makes `min` the whole implementation, which is
 * the point: an intersection written as a chain of ifs eventually grows a
 * branch that widens.
 */
const POLICY_RANK: Record<WorkPermissionPolicy, number> = {
  conservative: 0,
  balanced: 1,
  permissive: 2,
};

export function narrowestPolicy(
  ...policies: readonly (WorkPermissionPolicy | undefined | null)[]
): WorkPermissionPolicy {
  let rank = POLICY_RANK.permissive;
  for (const policy of policies) {
    if (!policy) continue;
    rank = Math.min(rank, POLICY_RANK[policy]);
  }
  return (["conservative", "balanced", "permissive"] as const)[rank];
}

export const WORK_RISK_LEVELS = [
  "safe",
  "edit",
  "command",
  "sensitive",
  /** Cannot be undone by Juno: permanent delete, send, publish, purchase,
   *  account or security settings. Always asks, under every policy. */
  "irreversible",
] as const;

export type WorkRiskLevel = (typeof WORK_RISK_LEVELS)[number];

export const WORK_APPROVAL_DECISIONS = [
  "pending",
  "allowed",
  "allowed_always",
  "denied",
  "expired",
  "superseded",
] as const;

export type WorkApprovalDecision = (typeof WORK_APPROVAL_DECISIONS)[number];

/** How long an approval request stays answerable. */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

/**
 * Actions that require an explicit decision no matter what the policy says.
 *
 * Enumerated rather than pattern-matched. A regex over tool names decides that
 * `delete_draft` is a permanent delete and that `send_to_trash` is a send, and
 * both mistakes are discovered by a user.
 */
export const ALWAYS_CONFIRM_ACTIONS: readonly string[] = [
  "work.file.permanent_delete",
  "work.file.empty_trash",
  "work.app.purchase",
  "work.browser.purchase",
  "work.connector.send_message",
  "work.connector.publish",
  "work.connector.delete",
  "work.connector.payment",
  "work.system.change_security_setting",
  "work.system.change_account_setting",
];

const ALWAYS_CONFIRM = new Set(ALWAYS_CONFIRM_ACTIONS);

export function requiresExplicitApproval(action: string, risk: WorkRiskLevel): boolean {
  return ALWAYS_CONFIRM.has(action) || risk === "sensitive" || risk === "irreversible";
}

/**
 * What an unattended (scheduled) run may do when nobody is there to ask.
 *
 * There is no "auto_approve". A scheduled task must not acquire permissions
 * because no user is present; the three options are all ways of NOT acting.
 */
export const WORK_UNATTENDED_POLICIES = [
  /** Stop and wait. The run sits in waiting_approval until someone answers. */
  "pause_for_approval",
  /** Do everything else and report what was skipped. */
  "skip_irreversible",
  /** Treat the attempt as an error. */
  "disallow_irreversible",
] as const;

export type WorkUnattendedPolicy = (typeof WORK_UNATTENDED_POLICIES)[number];

/** What a local schedule does when its host is not there. */
export const WORK_HOST_OFFLINE_POLICIES = ["wait", "skip", "cloud_subset"] as const;
export type WorkHostOfflinePolicy = (typeof WORK_HOST_OFFLINE_POLICIES)[number];

// ---------------------------------------------------------------------------
// Tool selection hierarchy
// ---------------------------------------------------------------------------

/**
 * The order the agent must try things in, most precise first.
 *
 * Clicking through Gmail when a scoped Gmail connector can do the exact
 * operation is slower, less reliable, needs far more permission, and puts the
 * user's inbox on a screenshot. The numbers are the enforcement: the planner
 * sorts candidate tools by tier and the executor refuses a lower tier when a
 * higher one declared it can serve the same intent.
 */
export const WORK_TOOL_TIERS = [
  { tier: 1, id: "connector", label: "Connected app" },
  { tier: 2, id: "structured_file", label: "File or document tool" },
  { tier: 3, id: "browser_dom", label: "Browser" },
  { tier: 4, id: "accessibility", label: "App accessibility" },
  { tier: 5, id: "visual", label: "Screen control" },
  { tier: 6, id: "shell", label: "Shell" },
] as const;

export type WorkToolTierId = (typeof WORK_TOOL_TIERS)[number]["id"];

const TIER_BY_ID = new Map<string, number>(WORK_TOOL_TIERS.map((t) => [t.id, t.tier]));

export function toolTier(id: string): number {
  return TIER_BY_ID.get(id) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Whether a tool may be used given what else could serve the same intent.
 *
 * `candidates` is every tool that declared it can perform this intent. The
 * rule is not "prefer" but "refuse": a visual click is denied outright while a
 * connector for the same intent is available and working.
 */
export function permitsTier(chosen: string, candidates: readonly string[]): boolean {
  const best = Math.min(...candidates.map(toolTier), Number.MAX_SAFE_INTEGER);
  return toolTier(chosen) <= best;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * The event kinds a Work run emits.
 *
 * Discriminated and versioned per payload rather than one untyped blob. A
 * plan step and a token delta are not the same shape and pretending otherwise
 * means every consumer re-guesses which fields are present.
 */
export const WORK_EVENT_KINDS = [
  "run_started",
  "plan_created",
  "plan_updated",
  "step_started",
  "step_finished",
  "assistant_message",
  "tool_started",
  "tool_finished",
  "tool_denied",
  "question_asked",
  "question_answered",
  "approval_requested",
  "approval_resolved",
  "artifact_created",
  "artifact_updated",
  "source_cited",
  "files_changed",
  "batch_preview",
  "batch_applied",
  "batch_undone",
  "subagent_update",
  "degraded",
  "budget_warning",
  "host_disconnected",
  "host_reconnected",
  "paused",
  "resumed",
  "validation_result",
  "run_finished",
  "error",
] as const;

export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number];

const EVENT_KINDS = new Set<string>(WORK_EVENT_KINDS);

export function isWorkEventKind(value: string): value is WorkEventKind {
  return EVENT_KINDS.has(value);
}

/**
 * Default visibility per event kind.
 *
 * A table rather than a per-emit argument: the emitter is the wrong place to
 * decide, because it is written once per kind and read by every surface, and
 * one forgotten argument publishes a raw tool payload to an operator log.
 */
const EVENT_VISIBILITY: Partial<Record<WorkEventKind, "user" | "operator" | "internal">> = {
  run_started: "user",
  plan_created: "user",
  plan_updated: "user",
  step_started: "user",
  step_finished: "user",
  assistant_message: "user",
  tool_started: "user",
  tool_finished: "user",
  tool_denied: "user",
  question_asked: "user",
  question_answered: "user",
  approval_requested: "user",
  approval_resolved: "user",
  artifact_created: "user",
  artifact_updated: "user",
  source_cited: "user",
  files_changed: "user",
  batch_preview: "user",
  batch_applied: "user",
  batch_undone: "user",
  subagent_update: "user",
  degraded: "user",
  budget_warning: "user",
  host_disconnected: "user",
  host_reconnected: "user",
  paused: "user",
  resumed: "user",
  validation_result: "user",
  run_finished: "user",
  error: "user",
};

export function defaultVisibilityFor(kind: string): "user" | "operator" | "internal" {
  return EVENT_VISIBILITY[kind as WorkEventKind] ?? "internal";
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export const WORK_ARTIFACT_KINDS = [
  "document",
  "spreadsheet",
  "presentation",
  "pdf",
  "report",
  "bundle",
  "image",
  "site",
  "archive",
] as const;

export type WorkArtifactKind = (typeof WORK_ARTIFACT_KINDS)[number];

/** Canonical MIME per kind, used for download headers and export validation. */
export const ARTIFACT_MIME: Record<WorkArtifactKind, string> = {
  document: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  spreadsheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  report: "text/markdown",
  bundle: "application/zip",
  image: "image/png",
  site: "application/zip",
  archive: "application/zip",
};

export const ARTIFACT_EXTENSION: Record<WorkArtifactKind, string> = {
  document: "docx",
  spreadsheet: "xlsx",
  presentation: "pptx",
  pdf: "pdf",
  report: "md",
  bundle: "zip",
  image: "png",
  site: "zip",
  archive: "zip",
};

/**
 * Per-kind byte ceiling.
 *
 * A limit per kind rather than one global number, because the honest limits
 * differ by an order of magnitude and a single value is either uselessly
 * small for a deck or recklessly large for a note.
 */
export const ARTIFACT_MAX_BYTES: Record<WorkArtifactKind, number> = {
  document: 25 * 1024 * 1024,
  spreadsheet: 50 * 1024 * 1024,
  presentation: 100 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
  report: 5 * 1024 * 1024,
  bundle: 200 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  site: 50 * 1024 * 1024,
  archive: 200 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export const WORK_GRANT_KINDS = [
  "local_folder",
  "local_file",
  "cloud_folder",
  "cloud_file",
  "connector_scope",
] as const;

export type WorkGrantKind = (typeof WORK_GRANT_KINDS)[number];

export const WORK_ACCESS_MODES = ["read", "read_write_no_delete", "read_write"] as const;
export type WorkAccessMode = (typeof WORK_ACCESS_MODES)[number];

const ACCESS_RANK: Record<WorkAccessMode, number> = {
  read: 0,
  read_write_no_delete: 1,
  read_write: 2,
};

export function allowsWrite(mode: WorkAccessMode): boolean {
  return ACCESS_RANK[mode] >= 1;
}

/**
 * Whether a mode permits moving a file to the Trash.
 *
 * `read_write_no_delete` deliberately does NOT: "no delete" that still allows
 * a Trash move is not a mode a user would recognise as no-delete, because the
 * file is gone from where they left it either way.
 */
export function allowsTrash(mode: WorkAccessMode): boolean {
  return mode === "read_write";
}

/** No access mode ever permits permanent delete. It is always an approval. */
export function allowsPermanentDelete(): false {
  return false;
}

// ---------------------------------------------------------------------------
// Relay commands
// ---------------------------------------------------------------------------

export const WORK_COMMAND_KINDS = [
  "start",
  "pause",
  "resume",
  "stop",
  "answer",
  "approve",
  "deny",
  "undo",
  "grant_folder",
  "revoke_grant",
  "refresh_capabilities",
  "ping",
] as const;

export type WorkCommandKind = (typeof WORK_COMMAND_KINDS)[number];

export const WORK_COMMAND_STATUSES = [
  "pending",
  "claimed",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
] as const;

export type WorkCommandStatus = (typeof WORK_COMMAND_STATUSES)[number];

/** How long an unclaimed command stays valid. */
export const COMMAND_TTL_MS = 5 * 60 * 1000;
/** How long a host holds a claimed command before it can be reclaimed. */
export const COMMAND_LEASE_MS = 60 * 1000;
/** How long a run's executor lease lasts before another executor may take it. */
export const RUN_LEASE_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export const WORK_HOST_STATES = ["online", "idle", "stale", "offline"] as const;
export type WorkHostState = (typeof WORK_HOST_STATES)[number];

/** Heartbeat older than this and the host is stale, not online. */
export const HOST_STALE_AFTER_MS = 90 * 1000;
/** Heartbeat older than this and the host is simply gone. */
export const HOST_OFFLINE_AFTER_MS = 5 * 60 * 1000;

export function hostStateFor(lastSeenAt: Date, now: Date, activeRuns: number): WorkHostState {
  const age = now.getTime() - lastSeenAt.getTime();
  if (age > HOST_OFFLINE_AFTER_MS) return "offline";
  if (age > HOST_STALE_AFTER_MS) return "stale";
  return activeRuns > 0 ? "online" : "idle";
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const WORK_TRIGGER_KINDS = [
  "once",
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "yearly",
  "cron",
  "email_filter",
  "calendar_window",
  "topic_monitor",
  "connector_event",
  "folder_change",
  "manual",
] as const;

export type WorkTriggerKind = (typeof WORK_TRIGGER_KINDS)[number];

/** Triggers that cannot fire without an online, opted-in Mac. */
export const LOCAL_ONLY_TRIGGER_KINDS: readonly WorkTriggerKind[] = ["folder_change"];

export const WORK_MISSED_RUN_POLICIES = ["skip", "run_once", "run_all"] as const;
export type WorkMissedRunPolicy = (typeof WORK_MISSED_RUN_POLICIES)[number];

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const WORK_AUDIT_KINDS = [
  "grant_created",
  "grant_revoked",
  "host_enabled",
  "host_disabled",
  "host_revoked",
  "command_claimed",
  "command_refused",
  "approval_requested",
  "approval_decided",
  "approval_replay_refused",
  "policy_narrowed",
  "egress_blocked",
  "injection_detected",
  "path_escape_refused",
  "permanent_delete_requested",
  "screenshot_captured",
  "skill_applied",
  "tier_downgrade_refused",
] as const;

export type WorkAuditKind = (typeof WORK_AUDIT_KINDS)[number];

export const WORK_AUDIT_SEVERITIES = ["info", "warning", "refusal", "violation"] as const;
export type WorkAuditSeverity = (typeof WORK_AUDIT_SEVERITIES)[number];

export const WORK_ACTORS = ["web", "macos", "ios", "cloud_runner", "scheduler"] as const;
export type WorkActor = (typeof WORK_ACTORS)[number];

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

export const WORK_SENSITIVITIES = ["public", "internal", "confidential", "restricted"] as const;
export type WorkSensitivity = (typeof WORK_SENSITIVITIES)[number];

const SENSITIVITY_RANK: Record<WorkSensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** The highest of several classifications — sensitivity only ever rises. */
export function maxSensitivity(
  ...values: readonly (WorkSensitivity | undefined | null)[]
): WorkSensitivity {
  let rank = 0;
  for (const value of values) {
    if (!value) continue;
    rank = Math.max(rank, SENSITIVITY_RANK[value]);
  }
  return (["public", "internal", "confidential", "restricted"] as const)[rank];
}

/**
 * Whether content at this classification may appear in a screenshot that
 * leaves the Mac.
 *
 * `restricted` never does. This is checked before a screenshot is stored or
 * relayed, not after — a redaction pass that runs on an image already sent to
 * the phone has redacted nothing.
 */
export function allowsScreenshotRelay(sensitivity: WorkSensitivity): boolean {
  return SENSITIVITY_RANK[sensitivity] < SENSITIVITY_RANK.restricted;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface WorkBudget {
  maxCostMicroUsd: number;
  maxTokens: number;
  maxRuntimeMs: number;
}

/** Zero means "no explicit ceiling"; the plan default applies instead. */
export const NO_BUDGET: WorkBudget = { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 };

export interface BudgetUsage {
  costMicroUsd: number;
  tokens: number;
  runtimeMs: number;
}

/**
 * Which ceiling a run has hit, if any.
 *
 * Returns the reason rather than a boolean so the terminal reason recorded on
 * the run says which limit stopped it. "budget_exceeded" with no detail sends
 * whoever reads it to check all three.
 */
export function budgetExceeded(
  budget: WorkBudget,
  usage: BudgetUsage
): { exceeded: false } | { exceeded: true; limit: "cost" | "tokens" | "runtime"; detail: string } {
  if (budget.maxCostMicroUsd > 0 && usage.costMicroUsd >= budget.maxCostMicroUsd) {
    return {
      exceeded: true,
      limit: "cost",
      detail: `Spent ${(usage.costMicroUsd / 1_000_000).toFixed(2)} of a ${(budget.maxCostMicroUsd / 1_000_000).toFixed(2)} USD ceiling.`,
    };
  }
  if (budget.maxTokens > 0 && usage.tokens >= budget.maxTokens) {
    return {
      exceeded: true,
      limit: "tokens",
      detail: `Used ${usage.tokens} of ${budget.maxTokens} tokens.`,
    };
  }
  if (budget.maxRuntimeMs > 0 && usage.runtimeMs >= budget.maxRuntimeMs) {
    return {
      exceeded: true,
      limit: "runtime",
      detail: `Ran for ${Math.round(usage.runtimeMs / 1000)}s of a ${Math.round(budget.maxRuntimeMs / 1000)}s ceiling.`,
    };
  }
  return { exceeded: false };
}

/**
 * Intersects budgets from several layers.
 *
 * Zero means unlimited at that layer, which makes a naive `Math.min` wrong —
 * it would let an unset session budget clamp a schedule's real one to zero and
 * stop every run instantly.
 */
export function narrowestBudget(...budgets: readonly (WorkBudget | undefined | null)[]): WorkBudget {
  const pick = (get: (b: WorkBudget) => number) => {
    let best = 0;
    for (const budget of budgets) {
      if (!budget) continue;
      const value = get(budget);
      if (value <= 0) continue;
      best = best === 0 ? value : Math.min(best, value);
    }
    return best;
  };
  return {
    maxCostMicroUsd: pick((b) => b.maxCostMicroUsd),
    maxTokens: pick((b) => b.maxTokens),
    maxRuntimeMs: pick((b) => b.maxRuntimeMs),
  };
}
