/**
 * The words Work is allowed to use, and how each one presents.
 *
 * Every list here is a transcription of `contracts/work/juno-work-v1.json`,
 * which is itself generated from `src/lib/work/domain.ts`. **A value that is not
 * in `domain.ts` is not a value Work has** — so nothing in this file invents a
 * state, and a state the product cannot name is a state the user is shown
 * nothing for, which is indistinguishable from nothing having happened.
 *
 * Two deliberate separations:
 *
 *   · **Values live here, schemas live in `../contract.ts`.** The schemas import
 *     these arrays to build their `z.enum`s, never the other way round. That is
 *     what keeps Zod out of the renderer bundle: components import *types* from
 *     the contract (erased under `verbatimModuleSyntax`) and *values* from here,
 *     so no component pulls a validator it will never run.
 *
 *   · **Classification is the server's, explanation is ours.** Risk levels,
 *     statuses and approval decisions arrive already decided. This module never
 *     re-derives one; it only says what each means in the user's terms. A second
 *     copy of a security classifier is a second copy that can drift.
 */

/* -------------------------------------------------------------------------- */
/* Vocabularies                                                                */
/* -------------------------------------------------------------------------- */

/** `WORK_STATUSES`. Every state a Work session or run can be in. */
export const WORK_STATUSES = [
  'draft',
  'queued',
  'preparing',
  'running',
  'waiting_input',
  'waiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'host_offline',
  'budget_exceeded',
  'timed_out',
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** `WORK_TERMINAL_REASONS`. Recorded once when a run ends, never inferred. */
export const WORK_TERMINAL_REASONS = [
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
  'host_offline',
  'interrupted',
  'superseded',
] as const;
export type WorkTerminalReason = (typeof WORK_TERMINAL_REASONS)[number];

/** `WORK_TARGETS`. Where a task is asked to run. */
export const WORK_TARGETS = ['cloud', 'local', 'automatic'] as const;
export type WorkTarget = (typeof WORK_TARGETS)[number];

/** `WORK_CAPABILITIES`. What a plan can require and a target can offer. */
export const WORK_CAPABILITIES = [
  'local_files',
  'local_apps',
  'local_browser',
  'local_computer_use',
  'local_shell',
  'web_research',
  'connectors',
  'cloud_files',
  'deliverables',
  'background_continuation',
] as const;
export type WorkCapability = (typeof WORK_CAPABILITIES)[number];

/** `WORK_PERMISSION_POLICIES`. Narrowest first; every layer may only narrow. */
export const WORK_PERMISSION_POLICIES = ['conservative', 'balanced', 'permissive'] as const;
export type WorkPermissionPolicy = (typeof WORK_PERMISSION_POLICIES)[number];

/** `WORK_RISK_LEVELS`. How much damage an action could do, lowest first. */
export const WORK_RISK_LEVELS = ['safe', 'edit', 'command', 'sensitive', 'irreversible'] as const;
export type WorkRiskLevel = (typeof WORK_RISK_LEVELS)[number];

/** `WORK_APPROVAL_DECISIONS`. The state of a request for permission to act. */
export const WORK_APPROVAL_DECISIONS = [
  'pending',
  'allowed',
  'allowed_always',
  'denied',
  'expired',
  'superseded',
] as const;
export type WorkApprovalDecision = (typeof WORK_APPROVAL_DECISIONS)[number];

/**
 * The subset a person may actually say.
 *
 * `pending` and `superseded` are states the row passes through, never things
 * anybody chooses; `expired` is what the clock does. Offering any of them as a
 * button would be offering a decision that is not a decision.
 */
export const WORK_APPROVAL_ANSWERS = ['allowed', 'allowed_always', 'denied'] as const;
export type WorkApprovalAnswer = (typeof WORK_APPROVAL_ANSWERS)[number];

/** `ALWAYS_CONFIRM_ACTIONS`. Enumerated, never pattern-matched. */
export const ALWAYS_CONFIRM_ACTIONS = [
  'work.file.permanent_delete',
  'work.file.empty_trash',
  'work.app.purchase',
  'work.browser.purchase',
  'work.connector.send_message',
  'work.connector.publish',
  'work.connector.delete',
  'work.connector.payment',
  'work.system.change_security_setting',
  'work.system.change_account_setting',
] as const;

/**
 * `WORK_TOOL_TIERS`. The order the agent must try things in, most precise first.
 * The ids are their own tuple so `z.enum` can take them without a cast.
 */
export const WORK_TOOL_TIER_IDS = [
  'connector',
  'structured_file',
  'browser_dom',
  'accessibility',
  'visual',
  'shell',
] as const;
export type WorkToolTierId = (typeof WORK_TOOL_TIER_IDS)[number];

export const WORK_TOOL_TIERS: ReadonlyArray<{
  readonly id: WorkToolTierId;
  readonly tier: number;
  readonly label: string;
}> = [
  { id: 'connector', tier: 1, label: 'Connected app' },
  { id: 'structured_file', tier: 2, label: 'File or document tool' },
  { id: 'browser_dom', tier: 3, label: 'Browser' },
  { id: 'accessibility', tier: 4, label: 'App accessibility' },
  { id: 'visual', tier: 5, label: 'Screen control' },
  { id: 'shell', tier: 6, label: 'Shell' },
];

/** `WORK_PLAN_STEP_STATUSES`. What the executor may claim about a step. */
export const WORK_PLAN_STEP_STATUSES = ['pending', 'active', 'done', 'skipped', 'failed'] as const;
export type WorkPlanStepStatus = (typeof WORK_PLAN_STEP_STATUSES)[number];

/** `WORK_ARTIFACT_KINDS`. What a run can produce and a client can download. */
export const WORK_ARTIFACT_KINDS = [
  'document',
  'spreadsheet',
  'presentation',
  'pdf',
  'report',
  'bundle',
  'image',
  'site',
  'archive',
] as const;
export type WorkArtifactKind = (typeof WORK_ARTIFACT_KINDS)[number];

/** `WORK_GRANT_KINDS`. What a user handed a run access to. */
export const WORK_GRANT_KINDS = [
  'local_folder',
  'local_file',
  'cloud_folder',
  'cloud_file',
  'connector_scope',
] as const;
export type WorkGrantKind = (typeof WORK_GRANT_KINDS)[number];

/** `WORK_ACCESS_MODES`. How far a grant goes, narrowest first. */
export const WORK_ACCESS_MODES = ['read', 'read_write_no_delete', 'read_write'] as const;
export type WorkAccessMode = (typeof WORK_ACCESS_MODES)[number];

/** `WORK_DEGRADATION_KINDS`. Why the run that executed differs from the one asked for. */
export const WORK_DEGRADATION_KINDS = [
  'target_substituted',
  'model_substituted',
  'capability_unavailable',
  'connector_unavailable',
  'host_offline',
  'local_portion_skipped',
  'budget_reduced',
  'skill_version_pinned',
] as const;
export type WorkDegradationKind = (typeof WORK_DEGRADATION_KINDS)[number];

/** `WORK_HOST_STATES`. How reachable a paired Mac is. */
export const WORK_HOST_STATES = ['online', 'idle', 'stale', 'offline'] as const;
export type WorkHostState = (typeof WORK_HOST_STATES)[number];

/** `WORK_AUDIT_KINDS`. Recorded whether or not anyone is watching. */
export const WORK_AUDIT_KINDS = [
  'grant_created',
  'grant_revoked',
  'host_enabled',
  'host_disabled',
  'host_revoked',
  'command_claimed',
  'command_refused',
  'approval_requested',
  'approval_decided',
  'approval_replay_refused',
  'policy_narrowed',
  'egress_blocked',
  'injection_detected',
  'path_escape_refused',
  'permanent_delete_requested',
  'screenshot_captured',
  'skill_applied',
  'skill_security_scanned',
  'skill_permission_consent',
  'tier_downgrade_refused',
] as const;
export type WorkAuditKind = (typeof WORK_AUDIT_KINDS)[number];

/** `WORK_AUDIT_SEVERITIES`. */
export const WORK_AUDIT_SEVERITIES = ['info', 'warning', 'refusal', 'violation'] as const;
export type WorkAuditSeverity = (typeof WORK_AUDIT_SEVERITIES)[number];

/** `WORK_ACTORS`. Which piece of Juno did the thing being recorded. */
export const WORK_ACTORS = ['web', 'macos', 'ios', 'cloud_runner', 'scheduler'] as const;
export type WorkActor = (typeof WORK_ACTORS)[number];

/** `WORK_SENSITIVITIES`. Only ever rises as a run reads more. */
export const WORK_SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'] as const;
export type WorkSensitivity = (typeof WORK_SENSITIVITIES)[number];

/** Where a piece of data came from. Mirrors `WorkProvenance.sourceKind`. */
export const WORK_SOURCE_KINDS = ['connector', 'web', 'file', 'local_app', 'model', 'user'] as const;
export type WorkSourceKind = (typeof WORK_SOURCE_KINDS)[number];

/** `WORK_EVENT_KINDS`. The append-only log's discriminator. */
export const WORK_EVENT_KINDS = [
  'run_started',
  'plan_created',
  'plan_updated',
  'step_started',
  'step_finished',
  'assistant_message',
  'tool_started',
  'tool_finished',
  'tool_denied',
  'question_asked',
  'question_answered',
  'user_message',
  'approval_requested',
  'approval_resolved',
  'artifact_created',
  'artifact_updated',
  'source_cited',
  'files_changed',
  'batch_preview',
  'batch_applied',
  'batch_undone',
  'subagent_update',
  'degraded',
  'budget_warning',
  'host_disconnected',
  'host_reconnected',
  'paused',
  'resumed',
  'validation_result',
  'run_finished',
  'error',
] as const;
export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* Status attributes                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The two attributes the contract attaches to every status, transcribed rather
 * than recomputed. `needsAttention` is true for `host_offline` even though it is
 * terminal, because the run being over does not mean the decision is made.
 */
interface StatusFacts {
  readonly isTerminal: boolean;
  readonly needsAttention: boolean;
  /** Sentence case, as it appears in a status line. */
  readonly label: string;
  /** What the user should understand from it, in one sentence. */
  readonly meaning: string;
  readonly tone: Tone;
}

/**
 * The presentation tones. Deliberately five, and deliberately not "colours":
 * a component asks for a meaning and this module decides the paint.
 */
export type Tone = 'neutral' | 'quiet' | 'positive' | 'notice' | 'danger';

/*
 * Labels and sentences are the web product's, verbatim where they exist
 * (`src/components/work/work-vocabulary.tsx`, `STATUS_META`). Two surfaces of
 * the same product that call `completed` "Done" in one window and "Completed" in
 * the other are two products. Where the desktop needs a sentence the web has no
 * counterpart for, it is written in the same voice and marked below.
 */
const STATUS_FACTS: Record<WorkStatus, StatusFacts> = {
  draft: {
    isTerminal: false,
    needsAttention: false,
    label: 'Draft',
    meaning:
      'This task has been written but never started, so nothing is running and nothing is queued.',
    tone: 'quiet',
  },
  queued: {
    isTerminal: false,
    needsAttention: false,
    label: 'Queued',
    meaning: 'Waiting to be picked up. Nothing is running yet.',
    tone: 'neutral',
  },
  preparing: {
    isTerminal: false,
    needsAttention: false,
    label: 'Preparing',
    meaning: 'Fetching inputs, resolving permissions and starting up.',
    tone: 'neutral',
  },
  running: {
    isTerminal: false,
    needsAttention: false,
    label: 'Running',
    meaning: 'Juno is working on this now.',
    tone: 'neutral',
  },
  waiting_input: {
    isTerminal: false,
    needsAttention: true,
    label: 'Needs an answer',
    meaning: 'Juno has asked you something and cannot continue until you answer.',
    tone: 'notice',
  },
  waiting_approval: {
    isTerminal: false,
    needsAttention: true,
    label: 'Needs approval',
    meaning: 'Juno is waiting for you to allow or refuse an action.',
    tone: 'notice',
  },
  paused: {
    isTerminal: false,
    needsAttention: false,
    label: 'Paused',
    meaning: 'You stopped this. It can be resumed.',
    tone: 'quiet',
  },
  completed: {
    isTerminal: true,
    needsAttention: false,
    label: 'Done',
    meaning: 'This finished.',
    tone: 'positive',
  },
  failed: {
    isTerminal: true,
    needsAttention: false,
    label: 'Failed',
    meaning: 'This stopped before it finished.',
    tone: 'danger',
  },
  cancelled: {
    isTerminal: true,
    needsAttention: false,
    label: 'Cancelled',
    meaning:
      'This was stopped rather than finished, and it will not be picked up where it left off.',
    tone: 'quiet',
  },
  interrupted: {
    isTerminal: true,
    needsAttention: false,
    label: 'Interrupted',
    meaning:
      'The executor stopped reporting and its lease expired. Juno does not restart an interrupted run on its own, because it may already have changed something.',
    tone: 'notice',
  },
  host_offline: {
    isTerminal: true,
    needsAttention: true,
    label: 'Mac unreachable',
    meaning:
      'This had to run on a Mac and none was reachable, so it did not start. Wake the Mac and run it again.',
    tone: 'notice',
  },
  budget_exceeded: {
    isTerminal: true,
    needsAttention: false,
    label: 'Hit its limit',
    meaning: 'This stopped because it reached the ceiling set for it.',
    tone: 'notice',
  },
  timed_out: {
    isTerminal: true,
    needsAttention: false,
    label: 'Timed out',
    meaning: 'This ran for longer than its time limit allowed and was stopped.',
    tone: 'notice',
  },
};

/**
 * How long a `preparing` or `running` task may record nothing before the UI
 * says so out loud.
 *
 * Mirrors `WORK_QUIET_AFTER_MS` on the web. It is stated as an **observation**,
 * never a diagnosis: nothing here knows whether a quiet run is stuck or is
 * reading a very large file. Saying "nothing new has been recorded" is true
 * either way, and it is the sentence a reader can act on.
 */
export const WORK_QUIET_AFTER_MS = 10 * 60 * 1000;

export function statusLabel(status: WorkStatus): string {
  return STATUS_FACTS[status].label;
}
export function statusMeaning(status: WorkStatus): string {
  return STATUS_FACTS[status].meaning;
}
export function statusTone(status: WorkStatus): Tone {
  return STATUS_FACTS[status].tone;
}
export function isTerminalStatus(status: WorkStatus): boolean {
  return STATUS_FACTS[status].isTerminal;
}
export function needsAttention(status: WorkStatus): boolean {
  return STATUS_FACTS[status].needsAttention;
}
/** True while an executor could still move: the only time "working" is honest. */
export function isLiveStatus(status: WorkStatus): boolean {
  return !STATUS_FACTS[status].isTerminal;
}

const TERMINAL_REASON_COPY: Record<WorkTerminalReason, string> = {
  completed: 'Finished and reported a result.',
  failed: 'The run decided it could not finish.',
  cancelled: 'You stopped it.',
  budget_exceeded: 'A cost, token or runtime ceiling was reached.',
  timed_out: 'The runtime ceiling was reached before it concluded.',
  host_offline: 'The Mac running it stopped answering.',
  interrupted: 'It stopped without deciding to.',
  superseded: 'A newer attempt took over from this one.',
};

export function terminalReasonCopy(reason: WorkTerminalReason): string {
  return TERMINAL_REASON_COPY[reason];
}

/* -------------------------------------------------------------------------- */
/* Risk                                                                        */
/* -------------------------------------------------------------------------- */

export interface RiskPresentation {
  readonly level: WorkRiskLevel;
  readonly label: string;
  /** Why Juno is being stopped here, in the user's terms. */
  readonly why: string;
  readonly tone: Tone;
  /**
   * Whether the affirmative button may carry the emphasis colour.
   *
   * False wherever the contract says `alwaysRequiresApproval`. The eye goes to
   * coral; putting coral on "allow" for something that cannot be undone leads
   * the reader to the irreversible answer. At those levels both buttons are
   * drawn with equal weight and the reader has to actually choose.
   *
   * Note what this is *not*: nothing on this surface ever moves focus. An
   * approval can arrive while somebody is typing an answer to a different
   * question, and a card that autofocuses would swallow their next keystroke.
   */
  readonly affirmativeMayLead: boolean;
  /** Whether "allow every time" is even offerable at this level. */
  readonly standingAllowable: boolean;
}

/**
 * `alwaysRequiresApproval` is true for `sensitive` and `irreversible` in the
 * contract, and `not_standing_allowable` is one of the five refusals the
 * decision route can return: an irreversible action may be allowed *this time*
 * and never made standing. Offering the button and having the server refuse it
 * is a dead button with extra steps, so the level decides here.
 */
const RISK_PRESENTATIONS: Record<WorkRiskLevel, RiskPresentation> = {
  safe: {
    level: 'safe',
    label: 'Safe',
    why: 'Nothing here changes anything outside this task.',
    tone: 'quiet',
    affirmativeMayLead: true,
    standingAllowable: true,
  },
  edit: {
    level: 'edit',
    label: 'Edits a file',
    why: 'This writes to a file. Juno can show you what changed afterwards.',
    tone: 'neutral',
    affirmativeMayLead: true,
    standingAllowable: true,
  },
  command: {
    level: 'command',
    label: 'Runs a command',
    why: 'This runs a command on the machine this task is on.',
    tone: 'notice',
    affirmativeMayLead: true,
    standingAllowable: true,
  },
  sensitive: {
    level: 'sensitive',
    label: 'Sensitive',
    why: 'This touches something private. Juno asks every time, whatever you have allowed before.',
    tone: 'danger',
    affirmativeMayLead: false,
    standingAllowable: false,
  },
  irreversible: {
    level: 'irreversible',
    label: 'Cannot be undone',
    why: 'This cannot be undone — not by Juno, and not from this window afterwards.',
    tone: 'danger',
    affirmativeMayLead: false,
    standingAllowable: false,
  },
};

export function riskPresentation(level: WorkRiskLevel): RiskPresentation {
  return RISK_PRESENTATIONS[level];
}

/** Ordering for "highest risk first" summaries. */
export const RISK_WEIGHT: Record<WorkRiskLevel, number> = {
  safe: 0,
  edit: 1,
  command: 2,
  sensitive: 3,
  irreversible: 4,
};

const ALWAYS_CONFIRM = new Set<string>(ALWAYS_CONFIRM_ACTIONS);

/**
 * The floor, transcribed from `requiresExplicitApproval`.
 *
 * Used only to *explain* a card that is already on screen ("this one asks under
 * every mode"), never to decide whether to show it. The executor decides that,
 * and a renderer that thought it knew better would be a renderer that can be
 * wrong in the permissive direction.
 */
export function isAlwaysConfirmed(action: string, risk: WorkRiskLevel): boolean {
  return ALWAYS_CONFIRM.has(action) || risk === 'sensitive' || risk === 'irreversible';
}

/* -------------------------------------------------------------------------- */
/* Permission policy                                                           */
/* -------------------------------------------------------------------------- */

export interface PolicyPresentation {
  readonly policy: WorkPermissionPolicy;
  readonly label: string;
  readonly summary: string;
  /** What still stops regardless. Every mode has one. */
  readonly floor: string;
}

/**
 * The wire values are `conservative | balanced | permissive` and are never
 * renamed — they are written on every session row and hashed into every granted
 * approval. What the user reads is Manual / Auto / Skip, the web's own labels.
 */
const POLICY_PRESENTATIONS: Record<WorkPermissionPolicy, PolicyPresentation> = {
  conservative: {
    policy: 'conservative',
    label: 'Manual',
    summary: 'Juno asks before it changes a file or runs anything. Reading and research go ahead.',
    floor: 'Sensitive and irreversible actions always ask.',
  },
  balanced: {
    policy: 'balanced',
    label: 'Auto',
    summary:
      'Juno makes changes it can undo, and asks before running anything or touching anything private.',
    floor: 'Sensitive and irreversible actions always ask.',
  },
  permissive: {
    policy: 'permissive',
    label: 'Skip',
    summary:
      'Juno gets on with the work without asking — except for the things it cannot take back.',
    floor: 'Sensitive and irreversible actions still ask. No mode turns that off.',
  },
};

export function policyPresentation(policy: WorkPermissionPolicy): PolicyPresentation {
  return POLICY_PRESENTATIONS[policy];
}

/* -------------------------------------------------------------------------- */
/* Targets, capabilities, hosts                                                */
/* -------------------------------------------------------------------------- */

const TARGET_LABELS: Record<WorkTarget, { label: string; summary: string }> = {
  cloud: { label: 'Juno cloud', summary: 'Runs on Juno’s machines. Keeps going while your Mac is asleep.' },
  local: { label: 'This Mac', summary: 'Runs here. Required for anything touching your files, apps or screen.' },
  automatic: {
    label: 'Let Juno choose',
    summary: 'Juno matches what the goal needs against what your Mac has advertised. It may legitimately pick the cloud.',
  },
};

export function targetLabel(target: WorkTarget): string {
  return TARGET_LABELS[target].label;
}
export function targetSummary(target: WorkTarget): string {
  return TARGET_LABELS[target].summary;
}
/** `automatic` is not an effective target — it resolves to one at dispatch. */
export function isEffectiveTarget(target: WorkTarget): boolean {
  return target !== 'automatic';
}

interface CapabilityFacts {
  readonly requiresLocalHost: boolean;
  /** The contract's own `userPhrase` — named for what the user asked for. */
  readonly userPhrase: string;
}

const CAPABILITY_FACTS: Record<WorkCapability, CapabilityFacts> = {
  local_files: { requiresLocalHost: true, userPhrase: 'access to a folder on your Mac' },
  local_apps: { requiresLocalHost: true, userPhrase: 'control of an app on your Mac' },
  local_browser: { requiresLocalHost: true, userPhrase: 'your signed-in browser' },
  local_computer_use: { requiresLocalHost: true, userPhrase: 'screen control on your Mac' },
  local_shell: { requiresLocalHost: true, userPhrase: 'a shell on your Mac' },
  web_research: { requiresLocalHost: false, userPhrase: 'web research' },
  connectors: { requiresLocalHost: false, userPhrase: 'your connected apps' },
  cloud_files: { requiresLocalHost: false, userPhrase: 'files stored with Juno' },
  deliverables: { requiresLocalHost: false, userPhrase: 'document and spreadsheet creation' },
  background_continuation: { requiresLocalHost: false, userPhrase: 'running while your devices are offline' },
};

export function capabilityPhrase(capability: WorkCapability): string {
  return CAPABILITY_FACTS[capability].userPhrase;
}
export function capabilityRequiresLocalHost(capability: WorkCapability): boolean {
  return CAPABILITY_FACTS[capability].requiresLocalHost;
}

/**
 * Host state is computed server-side (stale after 90s, offline after 5 min) and
 * is deliberately not re-derived here — a client clock that disagrees with the
 * server's is a client that shows a Mac as online while the server refuses to
 * route to it. `last seen {ago}` is printed beside the label so a reader can
 * check the server's arithmetic instead of trusting ours.
 */
const HOST_STATE_COPY: Record<WorkHostState, { label: string; tone: Tone }> = {
  online: { label: 'Working', tone: 'positive' },
  idle: { label: 'Ready', tone: 'neutral' },
  stale: { label: 'Not responding', tone: 'notice' },
  offline: { label: 'Offline', tone: 'danger' },
};

export function hostStateLabel(state: WorkHostState): string {
  return HOST_STATE_COPY[state].label;
}
export function hostStateTone(state: WorkHostState): Tone {
  return HOST_STATE_COPY[state].tone;
}

/* -------------------------------------------------------------------------- */
/* Tools, grants, artifacts, provenance                                        */
/* -------------------------------------------------------------------------- */

const TIER_BY_ID = new Map<string, string>(WORK_TOOL_TIERS.map((entry) => [entry.id, entry.label]));

export function tierLabel(id: WorkToolTierId): string {
  return TIER_BY_ID.get(id) ?? id;
}

const ACCESS_MODE_COPY: Record<WorkAccessMode, string> = {
  read: 'Read only',
  read_write_no_delete: 'Read and write, no delete',
  read_write: 'Read, write and delete',
};

export function accessModeLabel(mode: WorkAccessMode): string {
  return ACCESS_MODE_COPY[mode];
}

const GRANT_KIND_COPY: Record<WorkGrantKind, string> = {
  local_folder: 'Folder on this Mac',
  local_file: 'File on this Mac',
  cloud_folder: 'Folder in Juno',
  cloud_file: 'File in Juno',
  connector_scope: 'Connected app scope',
};

export function grantKindLabel(kind: WorkGrantKind): string {
  return GRANT_KIND_COPY[kind];
}

const ARTIFACT_KIND_COPY: Record<WorkArtifactKind, { label: string; extension: string }> = {
  document: { label: 'Document', extension: 'docx' },
  spreadsheet: { label: 'Spreadsheet', extension: 'xlsx' },
  presentation: { label: 'Presentation', extension: 'pptx' },
  pdf: { label: 'PDF', extension: 'pdf' },
  report: { label: 'Report', extension: 'md' },
  bundle: { label: 'Bundle', extension: 'zip' },
  image: { label: 'Image', extension: 'png' },
  site: { label: 'Site', extension: 'zip' },
  archive: { label: 'Archive', extension: 'zip' },
};

export function artifactKindLabel(kind: WorkArtifactKind): string {
  return ARTIFACT_KIND_COPY[kind].label;
}
export function artifactExtension(kind: WorkArtifactKind): string {
  return ARTIFACT_KIND_COPY[kind].extension;
}

const SOURCE_KIND_COPY: Record<WorkSourceKind, string> = {
  connector: 'Connected app',
  web: 'Web',
  file: 'File',
  local_app: 'App on this Mac',
  model: 'The model',
  user: 'You',
};

export function sourceKindLabel(kind: WorkSourceKind): string {
  return SOURCE_KIND_COPY[kind];
}

/* -------------------------------------------------------------------------- */
/* Degradation and audit                                                       */
/* -------------------------------------------------------------------------- */

const DEGRADATION_COPY: Record<WorkDegradationKind, string> = {
  target_substituted: 'Ran somewhere other than where you asked.',
  model_substituted: 'Ran on a different model than the one selected.',
  capability_unavailable: 'Something the goal needed was not available.',
  connector_unavailable: 'A connected app could not be reached.',
  host_offline: 'Your Mac was not reachable.',
  local_portion_skipped: 'The part that needed your Mac was skipped.',
  budget_reduced: 'A ceiling was lowered below what you asked for.',
  skill_version_pinned: 'An older version of the skill was used.',
};

export function degradationCopy(kind: WorkDegradationKind): string {
  return DEGRADATION_COPY[kind];
}

const AUDIT_KIND_COPY: Record<WorkAuditKind, string> = {
  grant_created: 'Access granted',
  grant_revoked: 'Access revoked',
  host_enabled: 'Mac enabled',
  host_disabled: 'Mac disabled',
  host_revoked: 'Mac unpaired',
  command_claimed: 'Command claimed by a Mac',
  command_refused: 'Command refused',
  approval_requested: 'Approval requested',
  approval_decided: 'Approval decided',
  approval_replay_refused: 'Replayed approval refused',
  policy_narrowed: 'Permission mode narrowed',
  egress_blocked: 'Outbound request blocked',
  injection_detected: 'Injection attempt detected',
  path_escape_refused: 'Path outside the grant refused',
  permanent_delete_requested: 'Permanent delete requested',
  screenshot_captured: 'Screenshot captured',
  skill_applied: 'Skill applied',
  skill_security_scanned: 'Skill security-scanned',
  skill_permission_consent: 'Skill permissions consented',
  tier_downgrade_refused: 'Lower-tier tool refused',
};

export function auditKindLabel(kind: WorkAuditKind): string {
  return AUDIT_KIND_COPY[kind];
}

const AUDIT_SEVERITY_TONE: Record<WorkAuditSeverity, Tone> = {
  info: 'quiet',
  warning: 'notice',
  refusal: 'notice',
  violation: 'danger',
};

export function auditSeverityTone(severity: WorkAuditSeverity): Tone {
  return AUDIT_SEVERITY_TONE[severity];
}

const ACTOR_COPY: Record<WorkActor, string> = {
  web: 'Juno on the web',
  macos: 'Juno for Mac',
  ios: 'Juno for iPhone',
  cloud_runner: 'Juno cloud runner',
  scheduler: 'The scheduler',
};

export function actorLabel(actor: WorkActor): string {
  return ACTOR_COPY[actor];
}

/* -------------------------------------------------------------------------- */
/* Approval refusals                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The five ways `POST /api/work/approvals/[id]/decision` refuses, each with its
 * own sentence. A refusal rendered as a generic error is a user pressing the
 * same button again.
 */
export const WORK_APPROVAL_REFUSALS = [
  'digest_mismatch',
  'policy_changed',
  'expired',
  'already_decided',
  'not_standing_allowable',
] as const;
export type WorkApprovalRefusal = (typeof WORK_APPROVAL_REFUSALS)[number];

const REFUSAL_COPY: Record<WorkApprovalRefusal, string> = {
  digest_mismatch:
    'What you were shown is not what Juno is asking to do any more. Nothing was allowed. Juno will ask again with the current action.',
  policy_changed:
    'The permission mode was narrowed after this was asked, so the old answer no longer applies. Juno will ask again under the new mode.',
  expired: 'This request timed out before it was answered. Nothing was done.',
  already_decided: 'This one was already answered — from another device, or in another window.',
  not_standing_allowable:
    'This action can be allowed this time, but never made standing. Answer it again with “Allow once”.',
};

export function approvalRefusalCopy(refusal: WorkApprovalRefusal): string {
  return REFUSAL_COPY[refusal];
}

const DECISION_COPY: Record<WorkApprovalDecision, { label: string; tone: Tone }> = {
  pending: { label: 'Awaiting your decision', tone: 'notice' },
  allowed: { label: 'Allowed once', tone: 'positive' },
  allowed_always: { label: 'Allowed, standing', tone: 'positive' },
  denied: { label: 'Denied', tone: 'danger' },
  expired: { label: 'Expired unanswered', tone: 'quiet' },
  superseded: { label: 'Superseded', tone: 'quiet' },
};

export function approvalDecisionLabel(decision: WorkApprovalDecision): string {
  return DECISION_COPY[decision].label;
}
export function approvalDecisionTone(decision: WorkApprovalDecision): Tone {
  return DECISION_COPY[decision].tone;
}

/* -------------------------------------------------------------------------- */
/* Step presentation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How a step reads to a person, which is not the same as what the executor
 * claimed about it.
 *
 * The contract gives five statuses. Two of the states a reader most needs are
 * not among them, because no executor is in a position to claim either:
 *
 *   · **blocked / awaiting** — a step is `active` while the *run* sits in
 *     `waiting_input`, `waiting_approval` or `paused`. The step did not change;
 *     the run did. Drawing that step as "running" is the single most common way
 *     a UI tells someone work is happening while nothing is.
 *   · **unreported** — a step still `active` when the run stopped. Only the
 *     reader can conclude this, and `docs/JUNO.md §9b.2` says so explicitly: it
 *     is a state no executor may claim.
 *
 * `stepPresentation` in `./derive.ts` is the only place this is computed.
 */
export const WORK_STEP_PRESENTATIONS = [
  'pending',
  'running',
  'blocked',
  'awaiting_input',
  'awaiting_approval',
  'done',
  'skipped',
  'failed',
  'unreported',
] as const;
export type WorkStepPresentation = (typeof WORK_STEP_PRESENTATIONS)[number];

interface StepPresentationCopy {
  readonly label: string;
  readonly tone: Tone;
  /** True only when an executor is actually moving this step right now. */
  readonly active: boolean;
}

const STEP_PRESENTATION_COPY: Record<WorkStepPresentation, StepPresentationCopy> = {
  pending: { label: 'Not started', tone: 'quiet', active: false },
  running: { label: 'Working', tone: 'neutral', active: true },
  blocked: { label: 'Paused mid-step', tone: 'quiet', active: false },
  awaiting_input: { label: 'Needs your answer', tone: 'notice', active: false },
  awaiting_approval: { label: 'Needs your approval', tone: 'notice', active: false },
  done: { label: 'Done', tone: 'positive', active: false },
  skipped: { label: 'Skipped', tone: 'quiet', active: false },
  failed: { label: 'Failed', tone: 'danger', active: false },
  unreported: { label: 'Never finished', tone: 'notice', active: false },
};

export function stepPresentationLabel(presentation: WorkStepPresentation): string {
  return STEP_PRESENTATION_COPY[presentation].label;
}
export function stepPresentationTone(presentation: WorkStepPresentation): Tone {
  return STEP_PRESENTATION_COPY[presentation].tone;
}
export function stepPresentationIsActive(presentation: WorkStepPresentation): boolean {
  return STEP_PRESENTATION_COPY[presentation].active;
}

/**
 * The sentence for a step that was never concluded.
 *
 * Kept next to the vocabulary rather than in the component because it is a
 * claim about the run, and claims are this module's job.
 */
export const UNREPORTED_STEP_EXPLANATION =
  'This step was still open when the run stopped. Nothing said it finished, and nothing said it failed.';

/** The same fact about a tool call rather than a step. */
export const UNREPORTED_CALL_EXPLANATION =
  'Started, and never reported back. Whether it finished is not recorded.';

/* -------------------------------------------------------------------------- */
/* Trust and injection                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What `WorkProvenance.trust` means, said plainly.
 *
 * Everything untrusted is scanned and enveloped before the model sees it. The
 * user is told which is which because the alternative — presenting a web page's
 * words and Juno's own words identically — is the presentation the envelope
 * exists to prevent.
 */
export function trustLabel(trust: 'trusted' | 'untrusted'): string {
  return trust === 'untrusted'
    ? 'Text Juno did not write — treated as data'
    : 'From Juno’s own work';
}

/**
 * The sentence for a detected injection attempt.
 *
 * Never echoes what was matched. Publishing attacker-authored text to every
 * client attached to the run is the delivery mechanism the scan interrupts —
 * which is exactly why `WorkInjectionSummary` carries a count and no spans.
 */
export function injectionWarning(severity: 'none' | 'suspicious' | 'hostile'): string | null {
  if (severity === 'hostile') {
    return 'This result contained instructions aimed at Juno. Juno read it as data, not as a request.';
  }
  if (severity === 'suspicious') {
    return 'This result contained something shaped like an instruction aimed at Juno. Juno read it as data.';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Tone → classes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The one place a tone becomes paint.
 *
 * Coral (`--primary`) is emphasis, and appears in exactly two places in this
 * product: the affirmative control on a decision the user must make, and the
 * marker on the step being worked on. It is not a status colour, so no tone maps
 * to it here.
 */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-foreground',
  quiet: 'text-muted-foreground',
  positive: 'text-success',
  notice: 'text-warning',
  danger: 'text-destructive',
};

/** Small filled marks (status dots). Fill tones, not ink tones. */
export const TONE_FILL: Record<Tone, string> = {
  neutral: 'bg-foreground/45',
  quiet: 'bg-muted-foreground/40',
  positive: 'bg-success',
  notice: 'bg-warning',
  danger: 'bg-destructive',
};

/** Left rules on a panel or note that carries a state. */
export const TONE_RULE: Record<Tone, string> = {
  neutral: 'border-l-border',
  quiet: 'border-l-border',
  positive: 'border-l-success',
  notice: 'border-l-warning',
  danger: 'border-l-destructive',
};
