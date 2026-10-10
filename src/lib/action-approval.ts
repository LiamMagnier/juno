/**
 * Provider-independent approval policy for actions that can leave Juno.
 *
 * This module is deliberately pure. Chat, Work, Code, schedules, native
 * clients, and CI can all ask the same questions without importing Prisma or a
 * server runtime:
 *
 *   1. What can this tool do?
 *   2. Does the account policy allow it, block it, or require a person?
 *   3. What exact bytes did that person approve?
 *
 * Connector annotations remain evidence, never authority. A server claiming
 * `readOnlyHint: true` only receives a read-only verdict when an independent
 * Juno rule or a read-shaped tool name agrees. Contradictory or incomplete
 * evidence resolves to `unknown`, whose policy floor is an external write.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "@/lib/work/canonical";
import { toolNameTokens, type ToolAccessHints } from "@/lib/tool-access";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const ACTION_RISK_CLASSES = [
  "read_only",
  "reversible_write",
  "external_write",
  "destructive_or_sensitive",
  "unknown",
] as const;

export type ActionRiskClass = (typeof ACTION_RISK_CLASSES)[number];

export const ACTION_PERMISSION_POLICIES = [
  "always_ask",
  "ask_for_any_change",
  "ask_for_important_actions",
  "allow_selected_low_risk",
  "block",
] as const;

export type ActionPermissionPolicy = (typeof ACTION_PERMISSION_POLICIES)[number];

export const DEFAULT_ACTION_PERMISSION_POLICY: ActionPermissionPolicy = "ask_for_any_change";
export const ACTION_APPROVAL_TTL_MS = 15 * 60_000;

export const ACTION_RECEIPT_STATUSES = [
  "pending",
  "allowed",
  "denied",
  "executing",
  "executed",
  "failed",
  "expired",
  "superseded",
  "blocked",
] as const;

export type ActionReceiptStatus = (typeof ACTION_RECEIPT_STATUSES)[number];
export type ActionApprovalDecision = "allow_once" | "allow_scope" | "deny";

/** Stable browser/native projection. It deliberately carries redacted detail,
 * never the raw credential-bearing invocation stored only as a digest. */
export interface ClientActionApproval {
  id: string;
  surface: string;
  sessionId: string;
  conversationId: string | null;
  connectorId: string;
  connectorLabel: string;
  toolName: string;
  action: string;
  riskClass: ActionRiskClass;
  preview: string;
  detail: Record<string, unknown>;
  receiptDigest: string;
  status: ActionReceiptStatus;
  decision: string | null;
  canAllowScope: boolean;
  derivedFromUntrusted: boolean;
  expiresAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ActionClassificationInput {
  connectorId: string;
  toolName: string;
  annotations?: ToolAccessHints;
  args?: Record<string, unknown>;
}

export interface ActionClassification {
  action: string;
  riskClass: ActionRiskClass;
  /** Stable, non-secret evidence identifiers for diagnostics and tests. */
  reasons: string[];
}

const JunoRules: Readonly<Record<string, ActionRiskClass>> = {
  "apple-calendar:list_calendars": "read_only",
  "apple-calendar:list_events": "read_only",
  "apple-calendar:create_event": "external_write",
  "apple-calendar:delete_event": "destructive_or_sensitive",
  "apple-mail:list_mailboxes": "read_only",
  "apple-mail:search_messages": "read_only",
  "apple-mail:read_message": "read_only",
  "apple-mail:unread_count": "read_only",
  "apple-music:search_catalog": "read_only",
  "apple-music:list_playlists": "read_only",
  "apple-music:recently_played": "read_only",
  "apple-music:add_to_playlist": "reversible_write",
  // The chat model starting a background task (src/lib/chat/task-tool.ts). It
  // only reaches the broker when a person must be asked (an estimate above the
  // preflight bar, or outside content in the turn), and an external write is
  // the class that asks under every policy short of `block` and is never
  // offered as a standing approval.
  "juno_work:start_task": "external_write",
  // One agent handing work to another (src/lib/chat/handoff-tool.ts). It
  // always reaches the broker, because a person approves every handoff, and it
  // takes the same class as a task for the same reasons: it asks under every
  // policy short of `block`, and it is never a standing approval.
  "juno_work:hand_off_to_teammate": "external_write",
  // One of the person's conversations messaging another of theirs
  // (src/lib/chat/cross-conversation-tools.ts). It writes into the person's
  // own conversation, so it is a reversible write: it asks under "ask for any
  // change" (the chat's Ask), and a person may allow it standing (the chat's
  // Full access).
  "juno_conversations:send_to_conversation": "reversible_write",
  // Juno's own readers of files the person attached to this conversation
  // (src/lib/agent/document.ts, image.ts). They reach nothing outside the
  // turn, so they never ask. Without an exact rule they classified as
  // "unknown", which asks under every policy, and the turn hung.
  "juno_runtime:read_document": "read_only",
  "juno_runtime:inspect_image": "read_only",
  // Juno's own chat tools (src/lib/tools/specs). Each entry equals
  // `toActionRiskClass(spec.risk)` for its registry spec, and no other
  // `juno_runtime:*` key exists (tests/tool-registry.test.ts pins both).
  // `browser_agent` deliberately has none: it left chat before the broker
  // trusted declared risk (DECISIONS §4b), and without a rule it stays
  // `unknown`, which asks.
  "juno_runtime:web_fetch": "read_only",
  "juno_runtime:web_search": "read_only",
  // Alevr Search (BRIEF §15): a news search and a search inside one page the
  // provenance ledger already allows are reads, like the two above.
  "juno_runtime:search_news": "read_only",
  "juno_runtime:find_in_page": "read_only",
  "juno_runtime:search_chats": "read_only",
  // A remote sandbox with no network, on the user's own files (DECISIONS §4b).
  // That rests on the isolation being confirmed, which is a precondition of
  // ATTACHING the tool (`sandboxEgressIsolated`), never an assumption here.
  "juno_runtime:run_code": "read_only",
  // Agent configuration changes that add recurring cost, a persistent computer,
  // higher autonomy or new connected apps (src/lib/chat/agent-config-tools.ts).
  "juno_agents:create_routine": "external_write",
  "juno_agents:enable_computer": "external_write",
  "juno_agents:reset_computer": "external_write",
  "juno_agents:disable_computer": "external_write",
  "juno_agents:raise_autonomy": "external_write",
  "juno_agents:add_connectors": "external_write",
  "juno_agents:change_model": "external_write",
  "juno_agents:create_agent": "external_write",
  "juno_agents:update_agent": "external_write",
  "juno_agents:agent_goal": "external_write",
  "juno_agents:agent_routine": "external_write",
  "juno_agents:agent_memory": "external_write",
  // A setup change that widens what a crew member can do
  // (src/lib/chat/setup-change-tool.ts): an app added, a looser approval mode,
  // a higher budget, a routine that acts without asking, a model. Asks under
  // every policy short of `block`, and is never a standing approval.
  "juno_agents:widen_setup": "external_write",
};

/** The exact-rule keys, for the registry test that pins them to the specs. */
export function junoRuleKeys(): string[] {
  return Object.keys(JunoRules);
}

const READ_VERBS = new Set([
  "browse", "check", "count", "describe", "diff", "download", "export", "fetch", "find", "get",
  "inspect", "list", "load", "lookup", "query", "read", "resolve", "retrieve", "search", "show",
  "stat", "summarize", "summarise", "view",
]);

const REVERSIBLE_TOKENS = new Set([
  "archive", "branch", "draft", "label", "mark", "move", "mute", "pin", "rename", "restore",
  "star", "tag", "unarchive", "unlabel", "unmute", "unpin", "unstar",
]);

const EXTERNAL_TOKENS = new Set([
  "add", "append", "assign", "comment", "complete", "create", "deploy", "edit", "invite", "merge",
  "post", "publish", "push", "reply", "schedule", "send", "share", "submit", "sync", "transfer",
  "update", "upload", "upsert", "write",
]);

const DESTRUCTIVE_TOKENS = new Set([
  "account", "approve", "credential", "decline", "delete", "destroy", "disable", "drop", "empty",
  "erase", "key", "lock", "merge", "password", "pay", "payment", "permission", "purchase", "refund",
  "reject", "remove", "reset", "revoke", "role", "security", "token", "trash", "unlock",
]);

/*
 * Argument KEYS whose value is masked before it can be shown to anyone.
 *
 * This list is now load-bearing in two places, not one. It has always redacted
 * the approval card's `detail`; since tool detail shipped it also redacts the
 * arguments of EVERY connector call into the thought-process panel, including
 * the read-only calls that never raise a card — and that projection is
 * persisted on `Message.activity`. That column is now encrypted at rest
 * (src/lib/field-crypto.ts), which protects a database dump and nothing else:
 * this list is still what stands between a credential and every reader who
 * legitimately holds the key — the panel itself, the account export, the
 * native sync payload. A name this misses is a name that is written down.
 *
 * The additions are the credential spellings the original list did not reach:
 * `apiKey` / `api_key` / `x-api-key`, `accessKey`, a bare `auth` field, `bearer`
 * and `passphrase`. `accessToken`, `refresh_token` and `client_secret` were
 * already caught by `token` / `secret`.
 *
 * BOUNDED ON PURPOSE where the word is a prefix of an innocent one: `\bauth\b`
 * so a GitHub `author` is not blanked out of an issue the user asked to read
 * back, and `\bbearer\b` for symmetry. Names that are ambiguous rather than
 * credential-shaped are deliberately NOT here — `key` (Linear project keys),
 * `signature` (an email signature), `session`, `pin` — because a redactor that
 * blanks the content the panel exists to show teaches people to distrust it.
 */
const SECRET_KEY =
  /(?:api.?key|access.?key|authorization|\bauth\b|\bbearer\b|cookie|credential|pass(?:word|phrase)|private.?key|secret|token)/i;

/** Whether an argument key names a credential, whose value is never shown to anyone. */
export function isSecretArgKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

function safeIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function actionName(connectorId: string, toolName: string): string {
  return `connector.${safeIdentifier(connectorId)}.${safeIdentifier(toolName)}`;
}

function argumentTokens(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  return Object.keys(args).flatMap(toolNameTokens);
}

/**
 * Classify with deny-first evidence. A Juno-maintained exact rule wins because
 * it describes code Juno owns. For remote tools, destructive evidence wins,
 * then a read needs both the server hint and an independently read-shaped name.
 * Everything ambiguous remains unknown.
 */
export function classifyExternalAction(input: ActionClassificationInput): ActionClassification {
  const action = actionName(input.connectorId, input.toolName);
  const exact = JunoRules[`${input.connectorId}:${input.toolName}`];
  if (exact) return { action, riskClass: exact, reasons: ["juno_exact_rule"] };

  if (
    input.connectorId === "juno_runtime" &&
    (input.toolName === "check_run" || input.toolName === "code_interpreter")
  ) {
    return { action, riskClass: "read_only", reasons: ["juno_exact_rule"] };
  }

  const nameTokens = toolNameTokens(input.toolName);
  const argTokens = argumentTokens(input.args);
  const allTokens = [...nameTokens, ...argTokens];
  const first = nameTokens[0];

  if (input.annotations?.destructiveHint === true || allTokens.some((token) => DESTRUCTIVE_TOKENS.has(token))) {
    return {
      action,
      riskClass: "destructive_or_sensitive",
      reasons: [
        ...(input.annotations?.destructiveHint === true ? ["connector_destructive_hint"] : []),
        ...(allTokens.some((token) => DESTRUCTIVE_TOKENS.has(token)) ? ["destructive_semantics"] : []),
      ],
    };
  }

  const nameSaysRead = !!first && READ_VERBS.has(first);
  const hintSaysRead = input.annotations?.readOnlyHint === true;
  const hintSaysWrite = input.annotations?.readOnlyHint === false;
  const hasWriteSemantics = allTokens.some(
    (token) => EXTERNAL_TOKENS.has(token) || REVERSIBLE_TOKENS.has(token)
  );

  if (nameSaysRead && hintSaysRead && !hasWriteSemantics) {
    return { action, riskClass: "read_only", reasons: ["read_name_and_hint_agree"] };
  }

  if (nameSaysRead && (hintSaysWrite || hasWriteSemantics)) {
    return { action, riskClass: "unknown", reasons: ["contradictory_read_evidence"] };
  }

  // A low-risk object name (draft, branch, label) cannot downgrade the verb
  // acting on it: sending a draft and publishing a branch leave the account.
  // Remote metadata is untrusted; conflicting write evidence takes the higher
  // floor, including argument keys such as `send` on an otherwise draft tool.
  if (allTokens.some((token) => EXTERNAL_TOKENS.has(token))) {
    return { action, riskClass: "external_write", reasons: ["external_write_semantics"] };
  }

  if (allTokens.some((token) => REVERSIBLE_TOKENS.has(token))) {
    return { action, riskClass: "reversible_write", reasons: ["reversible_write_semantics"] };
  }

  if (hintSaysWrite) {
    // A connector admits this is a write but gives Juno no independently safe
    // way to narrow it. External write is the minimum promised by the prompt.
    return { action, riskClass: "external_write", reasons: ["connector_write_hint"] };
  }

  return {
    action,
    riskClass: "unknown",
    reasons: hintSaysRead ? ["unconfirmed_read_hint"] : ["insufficient_metadata"],
  };
}

export type ActionPolicyOutcome = "allow" | "ask" | "block";

/** Unknown carries the same policy floor as an external write. */
export function effectiveActionRisk(riskClass: ActionRiskClass): Exclude<ActionRiskClass, "unknown"> {
  return riskClass === "unknown" ? "external_write" : riskClass;
}

export function mayCreateStandingApproval(riskClass: ActionRiskClass): boolean {
  return riskClass === "reversible_write";
}

export function decideActionPolicy(input: {
  policy: ActionPermissionPolicy;
  riskClass: ActionRiskClass;
  hasStandingApproval?: boolean;
  lockdown?: boolean;
  connectorBlocked?: boolean;
  /**
   * The call is one of Juno's own tools (`connectorId: "juno_runtime"`), not a
   * connected app's. A first-party READ is allowed under every policy short of
   * `block` and lockdown, `always_ask` included (INV-31): that setting's copy
   * speaks of "a connected app", which Juno's own readers are not, and a read
   * that waits on a card is the hang RC-1 fixed.
   */
  firstParty?: boolean;
}): ActionPolicyOutcome {
  if (input.lockdown || input.connectorBlocked || input.policy === "block") return "block";
  if (input.firstParty && effectiveActionRisk(input.riskClass) === "read_only") return "allow";
  if (input.policy === "always_ask") return "ask";

  const effective = effectiveActionRisk(input.riskClass);
  if (effective === "read_only") return "allow";

  if (
    input.policy === "allow_selected_low_risk" &&
    input.hasStandingApproval &&
    mayCreateStandingApproval(input.riskClass)
  ) {
    return "allow";
  }

  if (input.policy === "ask_for_important_actions" && effective === "reversible_write") {
    return "allow";
  }

  return "ask";
}

// The unified permission model (BRIEF §6) lives in a dependency-free module so
// Work's domain, client components and the native generators can import it
// without node:crypto; this broker re-exports it as the one authority.
export * from "@/lib/permissions/taxonomy";

/** The connector id Juno's own chat tools reach the broker under. */
export const JUNO_RUNTIME_CONNECTOR_ID = "juno_runtime";

/** What the decision needs from a resolved policy (the store's `ResolvedActionPolicy`). */
export interface ActionPolicySnapshot {
  policy: ActionPermissionPolicy;
  lockdown: boolean;
  connectorBlocked: boolean;
  /** The connector the snapshot was resolved for. A snapshot for another is never reused. */
  connectorId?: string;
}

/**
 * The decision half of `authorizeExternalAction`, with its two database reads
 * injected (SPEC §3.3 items 2–3).
 *
 * `resolvedPolicy` is the route's once-per-turn resolution: when it is given
 * and was resolved for the same connector, the policy query is skipped, so a
 * Juno read costs no query at all (a read never has a standing grant, so that
 * lookup is skipped too). `receiptless` is the one short-circuit that writes
 * nothing: an allowed read.
 */
export async function decideAuthorization<P extends ActionPolicySnapshot>(
  request: {
    connectorId: string;
    toolName: string;
    annotations?: ToolAccessHints;
    args?: Record<string, unknown>;
    resolvedPolicy?: P | null;
  },
  deps: {
    resolvePolicy: () => Promise<P>;
    findStandingGrant: (riskClass: ActionRiskClass, policy: P) => Promise<boolean>;
  },
): Promise<{
  classification: ActionClassification;
  policy: P;
  outcome: ActionPolicyOutcome;
  firstParty: boolean;
  receiptless: boolean;
}> {
  const classification = classifyExternalAction({
    connectorId: request.connectorId,
    toolName: request.toolName,
    annotations: request.annotations,
    args: request.args,
  });
  const reusable =
    request.resolvedPolicy &&
    (request.resolvedPolicy.connectorId === undefined || request.resolvedPolicy.connectorId === request.connectorId);
  const policy = reusable ? (request.resolvedPolicy as P) : await deps.resolvePolicy();
  const hasStandingApproval = mayCreateStandingApproval(classification.riskClass)
    ? await deps.findStandingGrant(classification.riskClass, policy)
    : false;
  const firstParty = request.connectorId === JUNO_RUNTIME_CONNECTOR_ID;
  const outcome = decideActionPolicy({
    policy: policy.policy,
    riskClass: classification.riskClass,
    hasStandingApproval,
    lockdown: policy.lockdown,
    connectorBlocked: policy.connectorBlocked,
    firstParty,
  });
  return {
    classification,
    policy,
    outcome,
    firstParty,
    receiptless: classification.riskClass === "read_only" && outcome === "allow",
  };
}

export interface ActionProvenance {
  source: string;
  sourceKind: string;
  derivedFromUntrusted: boolean;
}

export interface ActionReceiptBinding {
  userId: string;
  surface: string;
  sessionId: string;
  conversationId: string | null;
  projectId: string | null;
  connectorId: string;
  connectorVersion: string;
  toolName: string;
  functionName: string;
  action: string;
  args: Record<string, unknown>;
  riskClass: ActionRiskClass;
  preview: string;
  detail: Record<string, unknown>;
  provenance: ActionProvenance;
  policy: ActionPermissionPolicy;
  policyDigest: string;
  scope: "one_time";
  issuedAt: string;
  expiresAt: string;
}

const RECEIPT_DOMAIN = "juno.action-approval.receipt.v1";
const POLICY_DOMAIN = "juno.action-approval.policy.v1";

export interface ActionPolicyBinding {
  policy: ActionPermissionPolicy;
  lockdown: boolean;
  blockedConnectors: readonly string[];
  connectorId: string;
  projectId: string | null;
}

export function actionPolicyDigest(binding: ActionPolicyBinding): string {
  return createHash("sha256")
    .update(`${POLICY_DOMAIN}\n`, "utf8")
    .update(
      canonicalize({
        ...binding,
        // A set in storage: array order must not invalidate an otherwise
        // identical policy snapshot.
        blockedConnectors: [...binding.blockedConnectors].sort(),
      }),
      "utf8"
    )
    .digest("hex");
}

export function normalizedActionArgs(args: Record<string, unknown>): string {
  return canonicalize(args);
}

export function actionArgsHash(args: Record<string, unknown>): string {
  return createHash("sha256")
    .update("juno.action-approval.args.v1\n", "utf8")
    .update(normalizedActionArgs(args), "utf8")
    .digest("hex");
}

export function actionReceiptDigest(binding: ActionReceiptBinding): string {
  return createHash("sha256")
    .update(`${RECEIPT_DOMAIN}\n`, "utf8")
    .update(canonicalize(binding), "utf8")
    .digest("hex");
}

/**
 * The longest string an approval shows whole. Anything longer is cut, so a
 * caller that needs a person to see every character it will act on (the chat
 * task's goal, src/lib/chat/task-tool.ts) has to fit inside this.
 */
export const ACTION_PREVIEW_STRING_CHARS = 4_000;

function redactPreviewValue(value: unknown, depth: number): unknown {
  if (depth > 5) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactPreviewValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, child]) => [key, SECRET_KEY.test(key) ? "[redacted]" : redactPreviewValue(child, depth + 1)])
    );
  }
  if (typeof value === "string" && value.length > ACTION_PREVIEW_STRING_CHARS) {
    return `${value.slice(0, ACTION_PREVIEW_STRING_CHARS)}…`;
  }
  return value;
}

/** Exact user-visible arguments, with credentials removed and bounded. */
export function actionPreviewDetail(args: Record<string, unknown>): Record<string, unknown> {
  return redactPreviewValue(args, 0) as Record<string, unknown>;
}

export function actionPreview(input: {
  /**
   * Which connector is asking. Optional because the generic sentence needs
   * only the label; given, it lets an action Juno itself owns be described in
   * its own words rather than as a tool name.
   */
  connectorId?: string;
  connectorLabel: string;
  toolName: string;
  riskClass: ActionRiskClass;
  args: Record<string, unknown>;
}): string {
  // Keyed on the connector id, never the label: a linked account can carry any
  // label, and a third-party tool must not be able to borrow this sentence.
  if (input.connectorId === "juno_work" && input.toolName === "start_task") {
    const title = typeof input.args.title === "string" ? input.args.title.trim().replace(/[.!?]+$/, "") : "";
    const estimate = typeof input.args.estimate === "string" ? input.args.estimate.trim() : "";
    const task = title ? `Start a background task: ${title}.` : "Start a background task.";
    return singleLine(estimate ? `${task} Estimated cost ${estimate}.` : task);
  }
  if (input.connectorId === "juno_work" && input.toolName === "hand_off_to_teammate") {
    const teammate = typeof input.args.teammate === "string" ? input.args.teammate.trim() : "";
    const title = typeof input.args.title === "string" ? input.args.title.trim().replace(/[.!?]+$/, "") : "";
    const estimate = typeof input.args.estimate === "string" ? input.args.estimate.trim() : "";
    const to = `Hand off to ${teammate || "another agent"}`;
    const handoff = title ? `${to}: ${title}.` : `${to}.`;
    return singleLine(estimate ? `${handoff} Estimated cost ${estimate}.` : handoff);
  }
  if (input.connectorId === "juno_agents") {
    const previewObj =
      input.args.preview && typeof input.args.preview === "object" && !Array.isArray(input.args.preview)
        ? (input.args.preview as Record<string, unknown>)
        : null;
    const rawHeadline =
      previewObj && typeof previewObj.headline === "string" ? previewObj.headline.trim() : "";
    const headline = rawHeadline.replace(/[.!?]+$/, "");
    // Agent changes are asked as questions ("Give Mira its own computer?"); keep the mark.
    if (headline) return singleLine(`${headline}${rawHeadline.endsWith("?") ? "?" : "."}`);
    if (input.toolName === "create_routine" || input.toolName === "agent_routine") {
      const name = typeof input.args.name === "string" ? input.args.name.trim() : "a recurring routine";
      return singleLine(`Schedule ${name}.`);
    }
    if (input.toolName === "enable_computer") {
      return singleLine("Enable a persistent cloud computer for this agent.");
    }
    if (input.toolName === "raise_autonomy") {
      return singleLine("Raise this agent's autonomy setting.");
    }
    if (input.toolName === "add_connectors") {
      return singleLine("Grant this agent access to additional connected apps.");
    }
    return singleLine("Update this agent's setup.");
  }
  const verb = input.toolName.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const suffix =
    input.riskClass === "unknown"
      ? ` ${PRODUCT_NAME} could not verify whether this only reads, so it is treated as a change.`
      : "";
  return singleLine(`${input.connectorLabel} wants to ${verb}.${suffix}`);
}

/** The longest preview the approval wire carries (INV-5). */
export const ACTION_PREVIEW_MAX_CHARS = 8 * 1024;

/**
 * One line, as every approval text field must be (INV-5, gap-native D8): a
 * connector label or tool name can carry newlines and control characters, and
 * the native card renders them raw. Runs of whitespace and control characters
 * collapse to one space; the result is cut at `max`.
 */
export function singleLine(value: string, max = ACTION_PREVIEW_MAX_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
