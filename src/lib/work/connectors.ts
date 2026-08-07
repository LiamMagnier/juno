/**
 * Connectors, as Juno Work needs them: an inventory with verdicts, a
 * connector-first candidate set, and the gate every connector result passes
 * through before a run may act on it.
 *
 * Chat's connector layer (src/lib/connectors.ts, src/lib/mcp.ts) answers one
 * question — which MCP endpoints can be handed to the model right now — and it
 * answers by returning the ones that worked. Work needs three things that layer
 * does not provide, and each exists because of a specific way a run fails.
 *
 *  1. Every candidate, with a verdict. `getActiveConnectors` silently skips
 *     anything it cannot use: unconfigured, unlinked, an undecryptable token, a
 *     refresh that failed, a Composio row whose scope is not exactly active.
 *     The connector is then absent from the tool list, the model never mentions
 *     it, and nobody is told. In chat that costs a retry. In a scheduled run
 *     that finishes at 03:00 it is the difference between "your invoices were
 *     filed" and a report that quietly omits the half that needed the connector
 *     that was not there. `summarizeConnectors` returns a row for every
 *     connector it was asked about, available or not, with a reason and a
 *     sentence for the user.
 *
 *  2. Cloud versus local, stated rather than implied. A cloud connector keeps
 *     working while every device is asleep; a local one dies with its Mac, and
 *     a user choosing between them is entitled to know that before the run,
 *     along with what the connector can read, what it can change, and where the
 *     data goes.
 *
 *  3. An admission gate. A connector result is text an attacker may have
 *     written — a GitHub issue body, a calendar invite, an inbox. It arrives in
 *     the same channel as everything the run believes, so it is scanned and
 *     enveloped on the way in, and a detection is recorded and surfaced rather
 *     than stripped. `AdmittedConnectorResult` is the only shape
 *     `planConnectorFirst` accepts as evidence, so a result that has not been
 *     through the gate cannot be the stated reason for a tool choice.
 *
 * COVERAGE — what this does and does not reach:
 *
 *  - It covers connector calls that Juno dispatches: the cloud Work executor
 *    and anything driven through `openMcpToolset`, which is the single
 *    chokepoint on the OpenAI-compatible providers.
 *  - It does NOT cover the Anthropic path. There, `anthropicMcpServers` hands
 *    Claude the MCP URL and the token and the provider executes the tools
 *    server-side (src/lib/anthropic.ts, beta mcp-client-2025-04-04).
 *    `openMcpToolset` is never opened for those calls, so no result reaches
 *    this gate, no `WorkRunIO` row is written, no tier refusal can fire, and no
 *    injection scan happens. Only the system-prompt rule applies. A Work run
 *    that depends on any of the enforcement here must run on a path where Juno
 *    itself makes the call, and a run that does not must not be described to
 *    the user as if it did.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports, like domain.ts
 * and tool-access.ts: the cloud runner, the route handlers, chat's own MCP
 * chokepoint and the tests all need these decisions, and the decisions are pure.
 * Rows are returned as intents for the caller to write, never written here.
 * `truncateConnectorResult` is the reason mcp.ts reaches in here despite sitting
 * a layer below Work — there is one cap on connector output and one sentence
 * that declares it, and a chat copy of them would be a second one to keep in
 * step, which in practice means one of the two stops being maintained.
 */

import { UNTRUSTED_OPEN, wrapUntrusted } from "@/lib/untrusted-content";
import type { ToolAccess } from "@/lib/tool-access";
import {
  maxSensitivity,
  permitsTier,
  toolTier,
  WORK_TOOL_TIERS,
  type WorkAuditKind,
  type WorkAuditSeverity,
  type WorkDegradation,
  type WorkHostState,
  type WorkSensitivity,
  type WorkToolTierId,
} from "@/lib/work/domain";

// ---------------------------------------------------------------------------
// Records this module produces
// ---------------------------------------------------------------------------

/**
 * An audit row this module has decided is warranted, not yet written.
 *
 * Returned rather than written so this file stays pure and testable without a
 * database, exactly like domain.ts. The shape is the one `recordWorkAudit` in
 * src/lib/work/audit.ts takes and the one the sandbox emits (`WorkAuditIntent`
 * in runner/agent-core/src/work/types.ts), so a refusal decided on the server
 * and a refusal decided inside a run land in the same table looking the same.
 */
export interface WorkAuditIntent {
  kind: WorkAuditKind;
  severity: WorkAuditSeverity;
  /**
   * Identifiers and verdicts only. WorkAuditEvent outlives the session it
   * describes — that is the reason it is a separate table — so a search query
   * or a recipient list in here is a disclosure that survives the user
   * deleting the thing it came from.
   *
   * Every key used here is one of ALLOWED_AUDIT_KEYS in src/lib/work/audit.ts.
   * `sanitizeAuditDetail` drops anything else without comment, so a row built
   * with a well-meant key like `intent` or `signals` reaches the table empty,
   * which is worse than not writing it: the log then says a refusal happened
   * and nothing about what was refused.
   */
  detail: Record<string, string | number | boolean>;
}

/**
 * One connector read or write, in the shape `WorkRunIO` stores.
 *
 * WORK_AUDIT_KINDS has no kind meaning "a connector call happened", and adding
 * one is not mine to do: the kinds it has are grants, refusals, detections and
 * violations. `WorkRunIO` is the model that answers "what did this run read and
 * what did it write", which is exactly the question, so the per-action record
 * is a row there and only refusals and detections become WorkAuditEvent rows.
 */
export interface WorkConnectorIoRecord {
  /**
   * A read is an input to the run; a write is an output of it. An
   * unclassifiable call counts as an output, because the reviewer scanning
   * outputs for "what did this run change" must see the calls that might have
   * changed something.
   */
  direction: "input" | "output";
  refKind: "connector_record";
  /**
   * `<connectorId>:<tool>:<callId>`. WorkRunIO.refId is documented as a row id
   * or a URL and a connector call is neither, so it carries the identity of the
   * call instead — which is what ties this row to the run's event stream.
   */
  refId: string;
  /** Safe for any client: a connector label and a tool name, never a path. */
  label: string;
  detail: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Where a connector lives and what it can see
// ---------------------------------------------------------------------------

export const WORK_CONNECTOR_LOCALITIES = ["cloud", "local"] as const;
export type WorkConnectorLocality = (typeof WORK_CONNECTOR_LOCALITIES)[number];

/**
 * Where data read through the connector ends up.
 *
 * Kept separate from locality because they come apart: Apple Mail is served by
 * a Juno-hosted MCP route, so it is a cloud connector whose contents reach
 * Juno's servers, while a connector fronted by the Mac may never send a byte
 * anywhere. A user deciding whether to grant a connector is asking about this,
 * not about which process holds the socket.
 */
export const WORK_CONNECTOR_EGRESS = ["stays_on_host", "juno_cloud", "third_party"] as const;
export type WorkConnectorEgress = (typeof WORK_CONNECTOR_EGRESS)[number];

export interface WorkConnectorDataScope {
  /** What it can read, in the user's words: "calendar events", "repositories". */
  reads: readonly string[];
  /** What it can change. Empty means the connector is read-only. */
  writes: readonly string[];
  /** The highest classification data from this connector may carry. */
  sensitivity: WorkSensitivity;
  egress: WorkConnectorEgress;
}

export interface WorkConnectorDescriptor {
  id: string;
  label: string;
  locality: WorkConnectorLocality;
  /** The Mac serving a local connector. Meaningless for a cloud one. */
  hostId?: string | null;
  hostName?: string | null;
  /** Whether this deployment can offer it at all — client id present, and so on. */
  configured: boolean;
  /**
   * The intents it has declared it can serve, e.g. "email.archive". A connector
   * is tier 1 by construction, so this list is what makes it able to refuse a
   * browser or a screenshot for the same intent.
   */
  intents: readonly string[];
  scope: WorkConnectorDataScope;
}

/** A connector described in sentences a user can read, not in field names. */
export interface WorkConnectorSummary {
  connectorId: string;
  label: string;
  locality: WorkConnectorLocality;
  /** Where it runs and what that means for whether it will be there. */
  headline: string;
  reads: string;
  writes: string;
  dataFlow: string;
  sensitivity: WorkSensitivity;
}

function list(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function describeConnector(descriptor: WorkConnectorDescriptor): WorkConnectorSummary {
  const host = descriptor.hostName ?? "your Mac";
  const headline =
    descriptor.locality === "local"
      ? `${descriptor.label} runs on ${host}, so it works only while that Mac is awake and connected.`
      : `${descriptor.label} runs in Juno's cloud, so it keeps working while your devices are asleep.`;

  const dataFlow = ((): string => {
    switch (descriptor.scope.egress) {
      case "stays_on_host":
        return `What it reads stays on ${host}.`;
      case "juno_cloud":
        return "What it reads is sent to Juno's servers to be worked on.";
      case "third_party":
        return `What it reads is sent to ${descriptor.label}'s servers to be worked on.`;
    }
  })();

  return {
    connectorId: descriptor.id,
    label: descriptor.label,
    locality: descriptor.locality,
    headline,
    reads:
      descriptor.scope.reads.length > 0
        ? `Can read ${list(descriptor.scope.reads)}.`
        : "Cannot read anything on its own.",
    writes:
      descriptor.scope.writes.length > 0
        ? `Can change ${list(descriptor.scope.writes)}.`
        : "Cannot change anything; it is read-only.",
    dataFlow,
    sensitivity: descriptor.scope.sensitivity,
  };
}

/**
 * The classification a run inherits from the connectors it uses.
 *
 * Sensitivity only ever rises, which is why this is `maxSensitivity` and not a
 * per-connector decision made at each call site: a run that reads one
 * restricted mailbox is a restricted run for the rest of its life, including
 * for the screenshot check on the way back out.
 */
export function connectorSetSensitivity(
  descriptors: readonly WorkConnectorDescriptor[]
): WorkSensitivity {
  return maxSensitivity(...descriptors.map((d) => d.scope.sensitivity));
}

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

/**
 * Who is allowed to use what.
 *
 * Three independent layers, and a wider one is never opened by a narrower one.
 * An allowlist is null when that layer has not been configured, which is
 * different from an empty one: an empty admin allowlist means "no connector may
 * be used", and a deployment that confused the two would either open everything
 * or close everything, both silently.
 *
 * The task layer is the same distinction one level down, and the reason it is a
 * list rather than a boolean pair. `[]` is a reader who was shown their linked
 * apps and turned none of them on, which is a real answer and the default one —
 * the composer starts every switch off, so a task reaches nothing it was not
 * handed. `null` is a task created by something that has never heard of the
 * control: a native client, a schedule, or any session that predates it. Reading
 * those two the same way would either strip every existing task of its
 * connectors or quietly grant the whole account's to a reader who chose none.
 */
export interface WorkConnectorAllowlist {
  /** When non-null, the only connectors this account may use at all. */
  adminAllowed?: readonly string[] | null;
  adminBlocked?: readonly string[];
  /** The user's own narrowing, applied inside whatever the admin permits. */
  userAllowed?: readonly string[] | null;
  userBlocked?: readonly string[];
  /** What this one task was given, inside whatever the account permits. */
  taskAllowed?: readonly string[] | null;
}

export const WORK_CONNECTOR_UNAVAILABLE_REASONS = [
  "blocked_by_admin",
  "not_on_admin_allowlist",
  "blocked_by_user",
  "not_on_user_allowlist",
  "not_selected_for_task",
  "not_configured",
  "not_linked",
  "credential_unusable",
  "host_offline",
  "provider_unreachable",
] as const;

export type WorkConnectorUnavailableReason =
  (typeof WORK_CONNECTOR_UNAVAILABLE_REASONS)[number];

const POLICY_REASONS = new Set<WorkConnectorUnavailableReason>([
  "blocked_by_admin",
  "not_on_admin_allowlist",
  "blocked_by_user",
  "not_on_user_allowlist",
  "not_selected_for_task",
]);

/** What the connector's backing state is right now, as the caller resolved it. */
export interface WorkConnectorState {
  /** A Connection row exists, or a host advertises the connector. */
  linked: boolean;
  /**
   * The stored credential decrypted and has not expired. False also covers a
   * refresh that failed — from the run's point of view those are the same
   * situation and produce the same sentence.
   */
  credentialUsable: boolean;
  /** For a local connector: the Mac's state, from `hostStateFor`. */
  hostState?: WorkHostState | null;
  /** Set when the last probe failed. The message is shown to the user. */
  unreachable?: string | null;
}

export interface WorkConnectorAvailability {
  connectorId: string;
  label: string;
  locality: WorkConnectorLocality;
  summary: WorkConnectorSummary;
  available: boolean;
  reason: WorkConnectorUnavailableReason | null;
  /** Always populated, for both outcomes. A verdict with no sentence is a drop. */
  explanation: string;
  /** Present when unavailable, so the run can carry it and the user is told. */
  degradation: WorkDegradation | null;
  /** Present only for a policy refusal — the one case worth a security row. */
  audit: WorkAuditIntent | null;
}

function policyReason(
  id: string,
  allowlist: WorkConnectorAllowlist | undefined
): WorkConnectorUnavailableReason | null {
  if (!allowlist) return null;
  // Deny before allow, and admin before user: an admin block that a user
  // allowlist could override would not be a block.
  if (allowlist.adminBlocked?.includes(id)) return "blocked_by_admin";
  if (allowlist.adminAllowed && !allowlist.adminAllowed.includes(id)) return "not_on_admin_allowlist";
  if (allowlist.userBlocked?.includes(id)) return "blocked_by_user";
  if (allowlist.userAllowed && !allowlist.userAllowed.includes(id)) return "not_on_user_allowlist";
  // Last, because it is the narrowest and because the sentence it produces is
  // the least alarming of the four: a connector the reader simply did not switch
  // on for this task should not be reported as blocked by an administrator, and
  // an administrator's block should not be reported as something the reader can
  // fix by ticking a box.
  if (allowlist.taskAllowed && !allowlist.taskAllowed.includes(id)) return "not_selected_for_task";
  return null;
}

function explain(
  descriptor: WorkConnectorDescriptor,
  reason: WorkConnectorUnavailableReason,
  state: WorkConnectorState
): string {
  const host = descriptor.hostName ?? "the Mac it runs on";
  switch (reason) {
    case "blocked_by_admin":
      return `${descriptor.label} is blocked for this account by an administrator.`;
    case "not_on_admin_allowlist":
      return `${descriptor.label} is not on the list of connectors an administrator has allowed for this account.`;
    case "blocked_by_user":
      return `${descriptor.label} is turned off for Work in your settings.`;
    case "not_on_user_allowlist":
      return `${descriptor.label} is not one of the connectors you have allowed Work to use.`;
    case "not_selected_for_task":
      return `${descriptor.label} was not switched on for this task, so it is not available to it.`;
    case "not_configured":
      return `${descriptor.label} is not set up on this Juno deployment, so it cannot be connected.`;
    case "not_linked":
      return `${descriptor.label} has not been connected to your account yet.`;
    case "credential_unusable":
      return `${descriptor.label} needs to be reconnected: its saved authorisation no longer works.`;
    case "host_offline":
      return `${descriptor.label} runs on ${host}, which is ${state.hostState ?? "offline"}, so it cannot be reached.`;
    case "provider_unreachable":
      return `${descriptor.label} could not be reached: ${state.unreachable ?? "the last attempt failed"}.`;
  }
}

/**
 * Decide one connector, and say why either way.
 *
 * The order is deny-first and cheapest-first, so the sentence the user gets
 * names the thing they can actually act on. Telling someone their Mac is asleep
 * when the real answer is that their administrator blocked the connector sends
 * them to wake a Mac that will not help.
 */
export function evaluateConnector(
  descriptor: WorkConnectorDescriptor,
  state: WorkConnectorState,
  allowlist?: WorkConnectorAllowlist
): WorkConnectorAvailability {
  const summary = describeConnector(descriptor);

  const reason: WorkConnectorUnavailableReason | null = (() => {
    const policy = policyReason(descriptor.id, allowlist);
    if (policy) return policy;
    if (!descriptor.configured) return "not_configured";
    if (!state.linked) return "not_linked";
    if (!state.credentialUsable) return "credential_unusable";
    if (descriptor.locality === "local" && state.hostState !== "online" && state.hostState !== "idle") {
      return "host_offline";
    }
    if (state.unreachable) return "provider_unreachable";
    return null;
  })();

  if (!reason) {
    return {
      connectorId: descriptor.id,
      label: descriptor.label,
      locality: descriptor.locality,
      summary,
      available: true,
      reason: null,
      explanation: summary.headline,
      degradation: null,
      audit: null,
    };
  }

  const explanation = explain(descriptor, reason, state);
  return {
    connectorId: descriptor.id,
    label: descriptor.label,
    locality: descriptor.locality,
    summary,
    available: false,
    reason,
    explanation,
    degradation: { kind: "connector_unavailable", subject: descriptor.id, explanation },
    // A connector that is merely offline is an operational fact and belongs in
    // the run's degradation list, not in the security log. A connector refused
    // by policy is the log's whole purpose: it answers "was this account ever
    // told no, and by whom" months later.
    audit: POLICY_REASONS.has(reason)
      ? {
          kind: "policy_narrowed",
          severity: "refusal",
          // `target` rather than `locality`: the two values are the same pair
          // (cloud or local) and `target` is the name the audit log allows.
          detail: { connectorId: descriptor.id, reason, target: descriptor.locality },
        }
      : null,
  };
}

export interface WorkConnectorCandidate {
  descriptor: WorkConnectorDescriptor;
  state: WorkConnectorState;
}

/**
 * The inventory, with a verdict for every connector asked about.
 *
 * Nothing is dropped. That is the entire difference from `getActiveConnectors`,
 * and it is the difference between a run that says "Xero was not connected, so
 * the March invoices were not filed" and a run that reports success on the half
 * it happened to be able to do.
 */
export function summarizeConnectors(
  candidates: readonly WorkConnectorCandidate[],
  allowlist?: WorkConnectorAllowlist
): WorkConnectorAvailability[] {
  return candidates.map((c) => evaluateConnector(c.descriptor, c.state, allowlist));
}

/** The degradations a run should carry, given its connector inventory. */
export function connectorDegradations(
  availability: readonly WorkConnectorAvailability[]
): WorkDegradation[] {
  return availability.flatMap((entry) => (entry.degradation ? [entry.degradation] : []));
}

// ---------------------------------------------------------------------------
// Connector-first planning
// ---------------------------------------------------------------------------

/**
 * One tool that has declared it can serve an intent.
 *
 * `tool`, `tier`, `healthy` and `unhealthyReason` are named to match
 * `WorkToolCandidate` in runner/agent-core/src/work/types.ts, so a candidate
 * set built here — where the connector inventory, the allowlists and the host
 * states live — is the same object `evaluateTier` refuses calls against inside
 * the sandbox, with no translation layer in between to drift.
 */
export interface WorkToolCandidate {
  tool: string;
  tier: WorkToolTierId;
  /** Set when `tier` is "connector". */
  connectorId?: string;
  healthy: boolean;
  /** Why not. Shown to the user when a lower tier ended up running. */
  unhealthyReason?: string;
  /** Read or write; "unknown" when neither the server nor the name says. */
  access: ToolAccess;
}

export interface WorkToolRefusal {
  tool: string;
  tier: WorkToolTierId;
  /** The tool that outranks it and must be used instead. */
  preferred: string;
  reason: string;
}

export interface ConnectorFirstPlanInput {
  /** The tool-independent thing being attempted, e.g. "email.archive". */
  intent: string;
  candidates: readonly WorkToolCandidate[];
  /**
   * Connector results already admitted into this run that led to this intent.
   * Typed as `AdmittedConnectorResult` on purpose: a result that has not been
   * through `admitConnectorResult` cannot be cited here, so "the model decided
   * to send this because a web page told it to" is not a state this function
   * can be put in without the scan having run.
   */
  evidence?: readonly AdmittedConnectorResult[];
}

export interface ConnectorFirstPlan {
  intent: string;
  /**
   * Every candidate, most precise first. Unhealthy ones keep their place so the
   * plan can say what would have been used and why it was not.
   */
  ranked: readonly WorkToolCandidate[];
  chosen: WorkToolCandidate | null;
  /** Healthy candidates refused because something more precise is working. */
  refused: readonly WorkToolRefusal[];
  /** True when a result that tripped the injection scanner is among the inputs. */
  derivedFromUntrusted: boolean;
  /** True when the plan must not proceed without a human decision. */
  requiresApproval: boolean;
  explanation: string;
  degradation: WorkDegradation[];
}

function tierLabel(id: WorkToolTierId): string {
  return WORK_TOOL_TIERS.find((t) => t.id === id)?.label ?? id;
}

/**
 * Whether a candidate may be used given what else is working.
 *
 * Two lines over `permitsTier` rather than a second ordering: the ranking lives
 * in domain.ts and the per-call refusal lives in
 * runner/agent-core/src/work/tier.ts, and this is the same rule asked at
 * planning time, when the candidate set is being assembled on the server and
 * the sandbox cannot yet see it.
 *
 * The `healthy` filter is the whole subtlety. A connector whose token expired is
 * still tier 1 for its intent, and counting it would refuse the browser too and
 * leave the run unable to do the work at all — a worse outcome than the browser.
 */
export function permitsCandidate(
  chosen: WorkToolCandidate,
  candidates: readonly WorkToolCandidate[]
): boolean {
  return permitsTier(
    chosen.tier,
    candidates.filter((c) => c.healthy).map((c) => c.tier)
  );
}

/**
 * Rank the ways of serving an intent and pick the most precise one that works.
 *
 * Connector-first is not a preference here. Every healthy candidate below the
 * chosen rung comes back in `refused`, with the tool that outranks it named, so
 * the caller cannot quietly fall back: a screenshot-and-click for an intent a
 * scoped connector can serve is slower, less reliable, needs screen-recording
 * permission that was not otherwise needed, and puts the user's inbox in an
 * image.
 */
export function planConnectorFirst(input: ConnectorFirstPlanInput): ConnectorFirstPlan {
  const ranked = [...input.candidates].sort((a, b) => toolTier(a.tier) - toolTier(b.tier));
  const chosen = ranked.find((c) => c.healthy) ?? null;

  const refused: WorkToolRefusal[] = chosen
    ? ranked
        .filter((c) => c.healthy && c.tool !== chosen.tool && !permitsCandidate(c, ranked))
        .map((c) => ({
          tool: c.tool,
          tier: c.tier,
          preferred: chosen.tool,
          reason: `${c.tool} (${tierLabel(c.tier)}) is refused for ${input.intent} because ${chosen.tool} (${tierLabel(chosen.tier)}) can do the same thing and is working.`,
        }))
    : [];

  // Something more precise existed and could not run. The user is owed that
  // sentence: it is the difference between "Juno chose to click around your
  // browser" and "your Gmail connection expired, so Juno had to".
  const degradation: WorkDegradation[] = ranked
    .filter((c) => !c.healthy && (!chosen || toolTier(c.tier) < toolTier(chosen.tier)))
    .map((c) => ({
      kind: c.connectorId ? ("connector_unavailable" as const) : ("capability_unavailable" as const),
      subject: c.connectorId ?? c.tool,
      explanation: chosen
        ? `${c.tool} would have handled ${input.intent} more directly, but ${c.unhealthyReason ?? "it is unavailable"}. Using ${chosen.tool} instead.`
        : `${c.tool} cannot handle ${input.intent} right now: ${c.unhealthyReason ?? "it is unavailable"}.`,
    }));

  const derivedFromUntrusted = (input.evidence ?? []).some((e) => e.injection.detected);

  /*
   * A write chosen on the strength of text an attacker may have written is the
   * exact step the scan exists to interrupt, so it stops here and asks rather
   * than proceeding with a quarantined result as its justification.
   *
   * "unknown" counts as a write. tool-access.ts is explicit that an unannotated
   * server whose tool names carry no verb classifies as unknown, and a gate
   * keyed only on "write" would not fire for `notion_pages` — which is a real
   * tool that really updates pages.
   */
  const requiresApproval = derivedFromUntrusted && chosen !== null && chosen.access !== "read";

  const explanation = chosen
    ? refused.length === 0
      ? `${chosen.tool} (${tierLabel(chosen.tier)}) is the most precise tool available for ${input.intent}.`
      : `${chosen.tool} (${tierLabel(chosen.tier)}) will serve ${input.intent}; ${refused.length} lower-ranked ${refused.length === 1 ? "tool is" : "tools are"} refused while it is working.`
    : ranked.length === 0
      ? `Nothing has declared that it can serve ${input.intent}.`
      : `Nothing that can serve ${input.intent} is working right now.`;

  return {
    intent: input.intent,
    ranked,
    chosen,
    refused,
    derivedFromUntrusted,
    requiresApproval,
    explanation,
    degradation,
  };
}

/**
 * The audit row for a refusal the plan made.
 *
 * The same row `tier_downgrade_refused` carries inside the sandbox, built here
 * because a cloud connector call is planned on the server and the sandbox never
 * sees the alternative it was refused. Kept out of `planConnectorFirst` itself
 * so that ranking a set of candidates — which a UI may do to explain a choice —
 * does not write security rows nobody asked for.
 */
export function tierRefusalAudit(intent: string, refusal: WorkToolRefusal): WorkAuditIntent {
  return {
    kind: "tier_downgrade_refused",
    severity: "refusal",
    detail: {
      // The intent is the action the row is keyed on; the tool that was refused
      // and its rung are the two facts an investigation needs, and the tool that
      // outranked it rides in `reason` because the log has no key of its own for
      // "the better alternative" and an invented one would be dropped.
      action: intent,
      tool: refusal.tool,
      toolTier: toolTier(refusal.tier),
      decision: "refused",
      reason: `${refusal.preferred} can serve this intent and is working`,
    },
  };
}

// ---------------------------------------------------------------------------
// The admission gate
// ---------------------------------------------------------------------------

/**
 * How much of one connector result is put in front of the model.
 *
 * The cap is not new. `stringifyToolResult` in src/lib/mcp.ts has cut connector
 * output at 30,000 characters since it was written, and it should: a tool result
 * is the one input whose size nobody chose, and a single search against a busy
 * repository can return more text than the whole context window holds.
 *
 * What was missing is the other half. The cut left no mark, so a run read the
 * first third of an answer, had no way to know that was what it had, and
 * summarised it as the whole thing — confidently and wrongly. The only reason
 * anyone ever saw it happen is that one connector happened to say so itself, in
 * its own payload, and the run repeated it.
 *
 * So the rule the rest of this codebase already follows applies here too: the
 * text is cut and a line is left in its place saying so, in the result, where
 * the model reads it, never silently. The sentence is deliberately the one
 * `web_fetch` uses for a long page (runner/agent-core/src/work/tools.ts) and
 * attachments use for a long document (scripts/work-runner.ts). A model that has
 * learnt to respect it on one input should not have to recognise a second
 * phrasing on another.
 *
 * There is deliberately no per-caller override. A caller asking for more would
 * not reliably get more: `completeExternalAction` in
 * src/lib/action-approval-store.ts stores the result for replay and slices it at
 * 30,000 itself, so anything past this cap survives only until the call is
 * replayed — and what sits at the end, first to be cut, is the notice. The cap
 * belongs at the smallest limit that actually applies, and this is it. Raising
 * it means raising that one first.
 */
export const MAX_CONNECTOR_RESULT_CHARS = 30_000;

/**
 * Room set aside inside the cap for the notice itself.
 *
 * The notice is paid for out of the budget rather than appended past it, for the
 * same reason there is no override: something downstream cuts at 30,000, and a
 * notice that hangs over that edge is the first thing to go — leaving exactly
 * the silent prefix this exists to prevent. Fixed rather than measured because
 * the sentence varies only by the digits in two numbers, and a few characters of
 * slack cost nothing while an off-by-one here costs the whole guarantee.
 */
const TRUNCATION_NOTICE_CHARS = 200;

export interface TruncatedForModel {
  /** What the model is shown: the prefix, then the notice. Never over the cap. */
  text: string;
  /** True when `text` is a prefix rather than the whole result. */
  truncated: boolean;
  /** How long the result was before anything was cut. */
  totalChars: number;
  /** How much of that `text` actually carries. */
  includedChars: number;
}

/**
 * Cut a connector result to the cap and say so where the model will read it.
 *
 * Pure, and here rather than in mcp.ts, for two reasons. mcp.ts is `server-only`
 * and so cannot be reached from a test at all, and the same cut has to be
 * available to anything else that puts connector text in front of a model — one
 * cap and one sentence, not a second pair that drifts from this one.
 *
 * The caller applies this BEFORE `wrapUntrusted`. Truncating an enveloped result
 * would cut the closing marker off and leave the envelope unterminated, and the
 * notice would land outside it rather than inside the block it describes.
 */
export function truncateConnectorResult(content: string): TruncatedForModel {
  const totalChars = content.length;
  if (totalChars <= MAX_CONNECTOR_RESULT_CHARS) {
    return { text: content, truncated: false, totalChars, includedChars: totalChars };
  }
  const includedChars = Math.max(0, MAX_CONNECTOR_RESULT_CHARS - TRUNCATION_NOTICE_CHARS);
  return {
    text:
      `${content.slice(0, includedChars)}\n\n[Cut off here. This result is ${totalChars} characters long and ` +
      `only the first ${includedChars} are above. Do not describe the rest as though you have read it.]`,
    truncated: true,
    totalChars,
    includedChars,
  };
}

/**
 * Mirrored from runner/agent-core/src/work/types.ts, which cannot be imported:
 * the runner is vendored and built standalone, and tsconfig.json excludes
 * `runner` from this project entirely. Mirroring the three fields the caller
 * acts on — rather than restating the detector — is what lets `scanUntrusted`
 * from that module be passed straight in as the scanner with no adapter.
 */
export type WorkInjectionSeverity = "none" | "suspicious" | "hostile";

export interface InjectionVerdict {
  detected: boolean;
  severity: WorkInjectionSeverity;
  /** Stable pattern identifiers, never the matched text. */
  signals: readonly string[];
  matchCount: number;
  /** True when the content was longer than the scanner reads. */
  truncated: boolean;
}

/**
 * The detector, supplied by the caller.
 *
 * There is deliberately no default. The scanner is
 * runner/agent-core/src/work/injection.ts's `scanUntrusted`, one implementation
 * maintained in one place, and a copy of it here would be a second set of
 * patterns to keep in step — which in practice means one of them stops being
 * maintained and the other one is trusted. Requiring it as an argument also
 * fails in the right direction: a caller that has no scanner cannot admit a
 * connector result at all.
 */
export type InjectionScanner = (content: string) => InjectionVerdict;

export interface ConnectorResultInput {
  connectorId: string;
  /** The bare tool name, as the connector knows it. */
  tool: string;
  /** The id of the call this result answers, for tying rows to the transcript. */
  callId: string;
  /** The connector's display label, used as the envelope's source. */
  label: string;
  access: ToolAccess;
  locality: WorkConnectorLocality;
  /**
   * The exchange id the broker spent to authorise this call, when there was
   * one. Recording it is what closes the loop between "a credential was handed
   * out" and "this is what was done with it" — without it the two logs can only
   * be correlated by timestamp, which is the correlation that fails exactly
   * when two runs touch the same connector at once.
   */
  exchangeId?: string;
  /** The result exactly as the connector returned it, including error text. */
  content: string;
  /**
   * True when `content` is only the front of what the connector returned,
   * because the caller cut it to `MAX_CONNECTOR_RESULT_CHARS` and left the
   * notice in it.
   *
   * Recorded because "the run read this" and "the run read the first 30,000
   * characters of this" are different facts, and this row is the last place the
   * difference can still be established. It sits beside `scanTruncated` for the
   * same reason that one exists: a limit nobody wrote down is a limit that gets
   * read later as completeness.
   */
  truncated?: boolean;
}

export interface AdmittedConnectorResult {
  connectorId: string;
  tool: string;
  callId: string;
  access: ToolAccess;
  /**
   * The enveloped content. Nothing is removed: the original text is inside,
   * verbatim, apart from the envelope markers being defanged.
   */
  content: string;
  injection: InjectionVerdict;
  /**
   * True when the scan tripped. The result may still be reported to the user —
   * that is the point of not stripping it — but it must not be the reason a
   * tool is chosen. `planConnectorFirst` enforces that for writes.
   */
  quarantined: boolean;
  /** Non-null when quarantined: the sentence the user is shown. */
  notice: string | null;
  audit: WorkAuditIntent[];
  io: WorkConnectorIoRecord;
}

function envelope(label: string, content: string): string {
  // `openMcpToolset.execute()` already wraps every result it returns, including
  // its error strings. Wrapping a second time would defang the inner markers
  // and hand the model a nested envelope whose inner delimiters no longer match
  // the ones the system-prompt rule names, so an already-wrapped result passes
  // through unchanged.
  return content.startsWith(UNTRUSTED_OPEN) ? content : wrapUntrusted(label, content);
}

/**
 * The one way a connector result enters a Work run.
 *
 * Call it on every path, including failures: a connector's error message is
 * text the connector chose, so a hostile server's error is as good an injection
 * vector as its success, and an unrecorded failed write is precisely the row an
 * investigation goes looking for.
 *
 * A detection is never silently stripped. Removing the matched span would hand
 * the model text that still reads as coherent, hide from the user that anything
 * was in it, and leave an attack split across two spans intact in the half that
 * did not match. What happens instead is that the content is enveloped, the
 * detection is recorded as `injection_detected`, and `notice` carries a sentence
 * the caller must surface.
 */
export function admitConnectorResult(
  input: ConnectorResultInput,
  scan: InjectionScanner
): AdmittedConnectorResult {
  const verdict = scan(input.content);
  const label = `${input.label} · ${input.tool}`;

  const audit: WorkAuditIntent[] = [];
  if (verdict.detected) {
    audit.push({
      kind: "injection_detected",
      // The severities differ because the responses differ: a connector echoing
      // its own JSON back trips a pattern and is worth a note, while text
      // addressing the assistant directly is someone trying.
      severity: verdict.severity === "hostile" ? "violation" : "warning",
      detail: {
        connectorId: input.connectorId,
        tool: input.tool,
        // The signal names, never the text that matched them: a store of
        // attacker-authored strings is a liability rather than evidence, and
        // the run's own event stream already establishes which call it was.
        reason: verdict.signals.join(","),
        verdict: verdict.severity,
        matchCount: verdict.matchCount,
        // A scan that stopped at its character limit reported "clean" about a
        // tail it never read, and a row that does not say so cannot be told
        // apart later from one that read everything.
        outcome: verdict.truncated ? "partial_scan" : "full_scan",
      },
    });
  }

  const notice = verdict.detected
    ? `The result from ${label} contains text that tries to give Juno instructions (${verdict.signals.join(", ")}). Juno will report what it says and will not act on it.`
    : null;

  return {
    connectorId: input.connectorId,
    tool: input.tool,
    callId: input.callId,
    access: input.access,
    content: envelope(label, input.content),
    injection: verdict,
    quarantined: verdict.detected,
    notice,
    audit,
    io: {
      direction: input.access === "read" ? "input" : "output",
      refKind: "connector_record",
      refId: `${input.connectorId}:${input.tool}:${input.callId}`,
      label,
      detail: {
        connectorId: input.connectorId,
        tool: input.tool,
        access: input.access,
        locality: input.locality,
        // The bytes that were admitted, which is not the same as the bytes the
        // connector sent whenever `contentTruncated` is true.
        bytes: input.content.length,
        ...(input.exchangeId ? { exchangeId: input.exchangeId } : {}),
        contentTruncated: input.truncated === true,
        injectionDetected: verdict.detected,
        /*
         * WorkRunIO.detail is not the compliance log and is not passed through
         * sanitizeAuditDetail, so this row may carry the fuller picture: it is
         * cascade-deleted with the run, unlike WorkAuditEvent.
         */
        scanTruncated: verdict.truncated,
      },
    },
  };
}
