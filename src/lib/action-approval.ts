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
};

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
 * persisted, unencrypted, on `Message.activity`. A name this misses is a name
 * that is written down.
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

  if (allTokens.some((token) => REVERSIBLE_TOKENS.has(token))) {
    return { action, riskClass: "reversible_write", reasons: ["reversible_write_semantics"] };
  }

  if (allTokens.some((token) => EXTERNAL_TOKENS.has(token))) {
    return { action, riskClass: "external_write", reasons: ["external_write_semantics"] };
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
}): ActionPolicyOutcome {
  if (input.lockdown || input.connectorBlocked || input.policy === "block") return "block";
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
  if (typeof value === "string" && value.length > 4_000) return `${value.slice(0, 4_000)}…`;
  return value;
}

/** Exact user-visible arguments, with credentials removed and bounded. */
export function actionPreviewDetail(args: Record<string, unknown>): Record<string, unknown> {
  return redactPreviewValue(args, 0) as Record<string, unknown>;
}

export function actionPreview(input: {
  connectorLabel: string;
  toolName: string;
  riskClass: ActionRiskClass;
  args: Record<string, unknown>;
}): string {
  const verb = input.toolName.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const suffix =
    input.riskClass === "unknown"
      ? " Juno could not verify whether this only reads, so it is treated as a change."
      : "";
  return `${input.connectorLabel} wants to ${verb}.${suffix}`;
}
