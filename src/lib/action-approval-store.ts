import "server-only";

import { createHash } from "node:crypto";
import { Prisma, type ActionApprovalReceipt } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  ACTION_APPROVAL_TTL_MS,
  ACTION_PERMISSION_POLICIES,
  ACTION_RECEIPT_STATUSES,
  DEFAULT_ACTION_PERMISSION_POLICY,
  actionArgsHash,
  actionPolicyDigest,
  actionPreview,
  actionPreviewDetail,
  actionReceiptDigest,
  classifyExternalAction,
  decideActionPolicy,
  mayCreateStandingApproval,
  normalizedActionArgs,
  type ActionApprovalDecision,
  type ActionPermissionPolicy,
  type ActionProvenance,
  type ActionReceiptStatus,
  type ActionRiskClass,
  type ClientActionApproval,
} from "@/lib/action-approval";
import type { ToolAccessHints } from "@/lib/tool-access";

const POLL_MS = 400;
const RESULT_LIMIT = 30_000;

export type { ActionApprovalDecision, ActionReceiptStatus, ClientActionApproval } from "@/lib/action-approval";

type ReceiptRow = {
  id: string;
  surface: string;
  sessionId: string;
  conversationId: string | null;
  connectorId: string;
  toolName: string;
  action: string;
  riskClass: string;
  preview: string;
  detail: Prisma.JsonValue;
  receiptDigest: string;
  status: string;
  decision: string | null;
  derivedFromUntrusted: boolean;
  expiresAt: Date;
  decidedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

function objectValue(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function riskValue(value: string): ActionRiskClass {
  return (["read_only", "reversible_write", "external_write", "destructive_or_sensitive", "unknown"] as const)
    .includes(value as ActionRiskClass)
    ? (value as ActionRiskClass)
    : "unknown";
}

function statusValue(value: string): ActionReceiptStatus {
  return (ACTION_RECEIPT_STATUSES as readonly string[]).includes(value)
    ? (value as ActionReceiptStatus)
    : "blocked";
}

export function serializeActionApproval(row: ReceiptRow, connectorLabel = row.connectorId): ClientActionApproval {
  const riskClass = riskValue(row.riskClass);
  return {
    id: row.id,
    surface: row.surface,
    sessionId: row.sessionId,
    conversationId: row.conversationId,
    connectorId: row.connectorId,
    connectorLabel,
    toolName: row.toolName,
    action: row.action,
    riskClass,
    preview: row.preview,
    detail: objectValue(row.detail),
    receiptDigest: row.receiptDigest,
    status: statusValue(row.status),
    decision: row.decision,
    canAllowScope: mayCreateStandingApproval(riskClass),
    derivedFromUntrusted: row.derivedFromUntrusted,
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ResolvedActionPolicy {
  policy: ActionPermissionPolicy;
  lockdown: boolean;
  blockedConnectors: string[];
  connectorBlocked: boolean;
  policyDigest: string;
  scopeKey: string;
}

function validPolicy(value: string | undefined | null): ActionPermissionPolicy {
  return value && (ACTION_PERMISSION_POLICIES as readonly string[]).includes(value)
    ? (value as ActionPermissionPolicy)
    : DEFAULT_ACTION_PERMISSION_POLICY;
}

export async function resolveActionPolicy(input: {
  userId: string;
  connectorId: string;
  projectId?: string | null;
}): Promise<ResolvedActionPolicy> {
  const settings = await prisma.settings.findFirst({
    where: { userId: input.userId },
    select: { actionApprovalPolicy: true, lockdownMode: true, blockedConnectors: true },
  });
  const policy = validPolicy(settings?.actionApprovalPolicy);
  const lockdown = settings?.lockdownMode ?? false;
  const blockedConnectors = [...new Set(settings?.blockedConnectors ?? [])].sort();
  const connectorBlocked = blockedConnectors.includes(input.connectorId);
  const projectId = input.projectId ?? null;
  return {
    policy,
    lockdown,
    blockedConnectors,
    connectorBlocked,
    policyDigest: actionPolicyDigest({ policy, lockdown, blockedConnectors, connectorId: input.connectorId, projectId }),
    scopeKey: projectId ? `project:${projectId}` : "account",
  };
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function normalizedJson(args: Record<string, unknown>): Prisma.InputJsonValue {
  // Credential-bearing values participate in the in-memory digest and args
  // hash, but never become a second plaintext secret store in Postgres.
  return asJson(actionPreviewDetail(JSON.parse(normalizedActionArgs(args)) as Record<string, unknown>));
}

export function actionIdempotencyKey(sessionId: string, callId: string): string {
  return createHash("sha256")
    .update("juno.action-approval.idempotency.v1\n", "utf8")
    .update(sessionId, "utf8")
    .update("\n", "utf8")
    .update(callId, "utf8")
    .digest("hex");
}

export interface AuthorizeActionInput {
  userId: string;
  surface: string;
  sessionId: string;
  conversationId?: string | null;
  projectId?: string | null;
  connectorId: string;
  connectorLabel: string;
  connectorVersion?: string;
  toolName: string;
  functionName: string;
  annotations?: ToolAccessHints;
  args: Record<string, unknown>;
  callId: string;
  provenance: ActionProvenance;
  signal?: AbortSignal;
  onApprovalRequest?: (approval: ClientActionApproval) => void;
  /**
   * No person is attached to this execution — a trigger poll, a scheduled sweep,
   * a background job.
   *
   * Such a caller must never enter the decision wait: there is nobody to answer,
   * so it would stall for the full receipt TTL and then fail anyway, having held
   * a worker the whole time. It refuses immediately instead, and the refusal is
   * still written as a receipt so the account can see the action was attempted
   * and why it did not happen.
   */
  unattended?: boolean;
}

export type ActionAuthorization =
  | { kind: "authorized"; receiptId: string | null; riskClass: ActionRiskClass }
  | { kind: "replay"; receiptId: string; result: string; failed: boolean }
  | { kind: "refused"; receiptId: string | null; reason: string };

async function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function findStandingGrant(input: {
  userId: string;
  connectorId: string;
  scopeKey: string;
  toolName: string;
  riskClass: ActionRiskClass;
}): Promise<boolean> {
  if (!mayCreateStandingApproval(input.riskClass)) return false;
  return !!(await prisma.actionApprovalGrant.findFirst({
    where: {
      userId: input.userId,
      connectorId: input.connectorId,
      scopeKey: input.scopeKey,
      toolName: input.toolName,
      maxRiskClass: "reversible_write",
      revokedAt: null,
    },
    select: { id: true },
  }));
}

async function recoverOrCreateReceipt(input: {
  request: AuthorizeActionInput;
  riskClass: ActionRiskClass;
  action: string;
  reasons: readonly string[];
  policy: ResolvedActionPolicy;
  status: "pending" | "allowed" | "blocked";
  blockedReason?: string;
}): Promise<{ row: ActionApprovalReceipt; conflict: boolean }> {
  const { request } = input;
  const connectorVersion = request.connectorVersion ?? "unknown";
  const preview = actionPreview({
    connectorLabel: request.connectorLabel,
    toolName: request.toolName,
    riskClass: input.riskClass,
    args: request.args,
  });
  const detail = actionPreviewDetail(request.args);
  const bindingFor = (issuedAt: Date, expiresAt: Date) => ({
    userId: request.userId,
    surface: request.surface,
    sessionId: request.sessionId,
    conversationId: request.conversationId ?? null,
    projectId: request.projectId ?? null,
    connectorId: request.connectorId,
    connectorVersion,
    toolName: request.toolName,
    functionName: request.functionName,
    action: input.action,
    args: request.args,
    riskClass: input.riskClass,
    preview,
    detail,
    provenance: request.provenance,
    policy: input.policy.policy,
    policyDigest: input.policy.policyDigest,
    scope: "one_time",
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  } as const);
  const idempotencyKey = actionIdempotencyKey(request.sessionId, request.callId);

  const existing = await prisma.actionApprovalReceipt.findFirst({
    where: { userId: request.userId, idempotencyKey },
  });
  if (existing) {
    return {
      row: existing,
      conflict: existing.receiptDigest !== actionReceiptDigest(bindingFor(existing.createdAt, existing.expiresAt)),
    };
  }

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ACTION_APPROVAL_TTL_MS);
  const receiptDigest = actionReceiptDigest(bindingFor(issuedAt, expiresAt));

  try {
    const row = await prisma.actionApprovalReceipt.create({
      data: {
        userId: request.userId,
        surface: request.surface,
        sessionId: request.sessionId,
        conversationId: request.conversationId ?? null,
        projectId: request.projectId ?? null,
        connectorId: request.connectorId,
        connectorVersion,
        toolName: request.toolName,
        functionName: request.functionName,
        action: input.action,
        riskClass: input.riskClass,
        classificationReasons: asJson(input.reasons),
        normalizedArgs: normalizedJson(request.args),
        argsHash: actionArgsHash(request.args),
        receiptDigest,
        preview,
        detail: asJson(detail),
        provenance: asJson(request.provenance),
        derivedFromUntrusted: request.provenance.derivedFromUntrusted,
        policy: input.policy.policy,
        policyDigest: input.policy.policyDigest,
        status: input.status,
        ...(input.status === "allowed" ? { decision: "policy_allow", decidedAt: new Date(), decidedVia: "policy" } : {}),
        ...(input.status === "blocked"
          ? {
              decision: "policy_block",
              completedAt: new Date(),
              decidedVia: "policy",
              ...(input.blockedReason ? { executionResult: input.blockedReason } : {}),
            }
          : {}),
        expiresAt,
        idempotencyKey,
        createdAt: issuedAt,
      },
    });

    if (input.status === "pending") {
      void import("@/lib/apns")
        .then(({ sendCodeApprovalPushNotification }) =>
          sendCodeApprovalPushNotification({
            userId: request.userId,
            sessionId: request.sessionId,
            approvalId: row.id,
            toolName: request.toolName,
            prompt: preview,
            workspace: request.projectId ?? undefined,
          })
        )
        .catch(() => {});
    }

    return { row, conflict: false };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const winner = await prisma.actionApprovalReceipt.findFirstOrThrow({
      where: { userId: request.userId, idempotencyKey },
    });
    return {
      row: winner,
      conflict: winner.receiptDigest !== actionReceiptDigest(bindingFor(winner.createdAt, winner.expiresAt)),
    };
  }
}

async function waitForDecision(input: {
  userId: string;
  receiptId: string;
  signal?: AbortSignal;
}): Promise<ActionApprovalReceipt> {
  for (;;) {
    const row = await prisma.actionApprovalReceipt.findFirstOrThrow({
      where: { id: input.receiptId, userId: input.userId },
    });
    if (row.status !== "pending") return row;
    if (row.expiresAt.getTime() <= Date.now()) {
      await prisma.actionApprovalReceipt.updateMany({
        where: { id: row.id, userId: input.userId, status: "pending" },
        data: { status: "expired", completedAt: new Date() },
      });
      continue;
    }
    if (!(await wait(POLL_MS, input.signal))) {
      await prisma.actionApprovalReceipt.updateMany({
        where: { id: row.id, userId: input.userId, status: "pending" },
        data: { status: "superseded", completedAt: new Date(), executionResult: "Generation stopped before approval." },
      });
      return prisma.actionApprovalReceipt.findFirstOrThrow({ where: { id: row.id, userId: input.userId } });
    }
  }
}

export async function authorizeExternalAction(request: AuthorizeActionInput): Promise<ActionAuthorization> {
  const classification = classifyExternalAction({
    connectorId: request.connectorId,
    toolName: request.toolName,
    annotations: request.annotations,
    args: request.args,
  });
  const policy = await resolveActionPolicy(request);
  const hasStandingApproval = await findStandingGrant({
    userId: request.userId,
    connectorId: request.connectorId,
    scopeKey: policy.scopeKey,
    toolName: request.toolName,
    riskClass: classification.riskClass,
  });
  const outcome = decideActionPolicy({
    policy: policy.policy,
    riskClass: classification.riskClass,
    hasStandingApproval,
    lockdown: policy.lockdown,
    connectorBlocked: policy.connectorBlocked,
  });

  // Reads need no receipt unless the user deliberately chose Always ask. Every
  // write or unknown call receives one even when an explicit policy auto-allows
  // it, so the audit can still name the policy that admitted it.
  if (classification.riskClass === "read_only" && outcome === "allow") {
    return { kind: "authorized", receiptId: null, riskClass: classification.riskClass };
  }

  // An unattended caller cannot be asked, so "ask" becomes "no". Collapsing it
  // here rather than at the wait keeps the receipt honest: the row records that
  // the policy wanted a person, and that none was available.
  const unattendedRefusal = outcome === "ask" && !!request.unattended;
  const initialStatus =
    outcome === "block" || unattendedRefusal ? "blocked" : outcome === "allow" ? "allowed" : "pending";
  const { row: initial, conflict } = await recoverOrCreateReceipt({
    request,
    riskClass: classification.riskClass,
    action: classification.action,
    reasons: classification.reasons,
    policy,
    status: initialStatus,
    ...(unattendedRefusal
      ? { blockedReason: "This ran without anyone attached, and it needs your approval. Start it from Juno to approve it." }
      : {}),
  });

  if (conflict) {
    return { kind: "refused", receiptId: initial.id, reason: "The tool arguments changed after this approval was created." };
  }
  if (initial.status === "executed" || initial.status === "failed") {
    return {
      kind: "replay",
      receiptId: initial.id,
      result: initial.executionResult ?? (initial.status === "executed" ? "Action already completed." : "Action already failed."),
      failed: initial.status === "failed",
    };
  }
  if (["denied", "expired", "superseded", "blocked"].includes(initial.status)) {
    return { kind: "refused", receiptId: initial.id, reason: initial.executionResult ?? `Action ${initial.status}.` };
  }

  let decided = initial;
  if (initial.status === "pending") {
    request.onApprovalRequest?.(serializeActionApproval(initial, request.connectorLabel));
    decided = await waitForDecision({ userId: request.userId, receiptId: initial.id, signal: request.signal });
  }
  if (decided.status !== "allowed") {
    return { kind: "refused", receiptId: decided.id, reason: decided.executionResult ?? `Action ${decided.status}.` };
  }

  // Re-resolve current policy immediately before consumption. Any policy
  // change invalidates the answer, even if it widened rather than narrowed.
  const currentPolicy = await resolveActionPolicy(request);
  const currentArgsHash = actionArgsHash(request.args);
  if (currentPolicy.policyDigest !== decided.policyDigest || currentArgsHash !== decided.argsHash) {
    await prisma.actionApprovalReceipt.updateMany({
      where: { id: decided.id, userId: request.userId, status: "allowed" },
      data: { status: "superseded", completedAt: new Date(), executionResult: "Arguments or permissions changed after approval." },
    });
    return { kind: "refused", receiptId: decided.id, reason: "Arguments or permissions changed after approval." };
  }

  // Atomic one-time spend. A second process presenting the same approval loses.
  const consumed = await prisma.actionApprovalReceipt.updateMany({
    where: {
      id: decided.id,
      userId: request.userId,
      status: "allowed",
      argsHash: currentArgsHash,
      receiptDigest: decided.receiptDigest,
      expiresAt: { gt: new Date() },
    },
    data: { status: "executing", consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    return { kind: "refused", receiptId: decided.id, reason: "This one-time approval was already used or expired." };
  }

  return { kind: "authorized", receiptId: decided.id, riskClass: classification.riskClass };
}

export async function completeExternalAction(input: {
  userId: string;
  receiptId: string | null;
  ok: boolean;
  result: string;
  undoInfo?: Record<string, unknown> | null;
}): Promise<void> {
  if (!input.receiptId) return;
  await prisma.actionApprovalReceipt.updateMany({
    where: { id: input.receiptId, userId: input.userId, status: "executing" },
    data: {
      status: input.ok ? "executed" : "failed",
      executionResult: input.result.slice(0, RESULT_LIMIT),
      ...(input.undoInfo ? { undoInfo: asJson(input.undoInfo) } : {}),
      completedAt: new Date(),
    },
  });
}

export type ActionDecisionResult =
  | { ok: true; approval: ClientActionApproval; replay: boolean }
  | {
      ok: false;
      code:
        | "not_found"
        | "digest_mismatch"
        | "policy_changed"
        | "expired"
        | "already_decided"
        | "not_scope_allowable"
        | "blocked";
      message: string;
    };

const ACTION_DECISION_MESSAGES: Record<Exclude<ActionDecisionResult, { ok: true }>["code"], string> = {
  not_found: "Approval not found.",
  digest_mismatch: "This answer is for a different action than the one you reviewed.",
  policy_changed: "Your permissions changed after this request was created. Juno will ask again.",
  expired: "This request expired before it was answered.",
  already_decided: "This request has already been answered.",
  not_scope_allowable: "Juno only remembers approval for narrowly reversible actions.",
  blocked: "This connector is blocked by your current permissions.",
};

function refusal(code: Exclude<ActionDecisionResult, { ok: true }>["code"]): ActionDecisionResult {
  return { ok: false, code, message: ACTION_DECISION_MESSAGES[code] };
}

/** Record a human answer without spending it. The executor performs a second
 * policy/argument check and atomically consumes Allow immediately before the
 * network sink. */
export async function decideActionApproval(input: {
  userId: string;
  id: string;
  decision: ActionApprovalDecision;
  receiptDigest: string;
  decidedVia?: string;
}): Promise<ActionDecisionResult> {
  const receipt = await prisma.actionApprovalReceipt.findFirst({
    where: { id: input.id, userId: input.userId },
  });
  if (!receipt) return refusal("not_found");
  if (receipt.receiptDigest !== input.receiptDigest) return refusal("digest_mismatch");

  if (receipt.status !== "pending") {
    const sameDecision = receipt.decision === input.decision;
    if (sameDecision && ["allowed", "denied", "executing", "executed", "failed"].includes(receipt.status)) {
      return { ok: true, approval: serializeActionApproval(receipt), replay: true };
    }
    return refusal(receipt.status === "expired" ? "expired" : "already_decided");
  }

  const now = new Date();
  if (receipt.expiresAt.getTime() <= now.getTime()) {
    await prisma.actionApprovalReceipt.updateMany({
      where: { id: receipt.id, userId: input.userId, status: "pending" },
      data: { status: "expired", completedAt: now, executionResult: ACTION_DECISION_MESSAGES.expired },
    });
    return refusal("expired");
  }

  const current = await resolveActionPolicy({
    userId: input.userId,
    connectorId: receipt.connectorId,
    projectId: receipt.projectId,
  });
  if (current.policyDigest !== receipt.policyDigest) {
    await prisma.actionApprovalReceipt.updateMany({
      where: { id: receipt.id, userId: input.userId, status: "pending" },
      data: { status: "superseded", completedAt: now, executionResult: ACTION_DECISION_MESSAGES.policy_changed },
    });
    return refusal("policy_changed");
  }
  if (current.lockdown || current.connectorBlocked || current.policy === "block") {
    await prisma.actionApprovalReceipt.updateMany({
      where: { id: receipt.id, userId: input.userId, status: "pending" },
      data: { status: "blocked", decision: "policy_block", completedAt: now, executionResult: ACTION_DECISION_MESSAGES.blocked },
    });
    return refusal("blocked");
  }

  const riskClass = riskValue(receipt.riskClass);
  if (input.decision === "allow_scope" && !mayCreateStandingApproval(riskClass)) {
    return refusal("not_scope_allowable");
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const recorded = await tx.actionApprovalReceipt.updateMany({
        where: {
          id: receipt.id,
          userId: input.userId,
          status: "pending",
          receiptDigest: input.receiptDigest,
          expiresAt: { gt: now },
        },
        data:
          input.decision === "deny"
            ? {
                status: "denied",
                decision: input.decision,
                decidedAt: now,
                decidedVia: input.decidedVia ?? "web",
                completedAt: now,
                executionResult: "Denied by user.",
              }
            : {
                status: "allowed",
                decision: input.decision,
                scope: input.decision === "allow_scope" ? `standing:${current.scopeKey}` : "one_time",
                decidedAt: now,
                decidedVia: input.decidedVia ?? "web",
              },
      });
      if (recorded.count !== 1) throw new Error("ACTION_APPROVAL_DECISION_RACE");

      if (input.decision === "allow_scope") {
        await tx.actionApprovalGrant.upsert({
          where: {
            userId_connectorId_scopeKey_toolName: {
              userId: input.userId,
              connectorId: receipt.connectorId,
              scopeKey: current.scopeKey,
              toolName: receipt.toolName,
            },
          },
          create: {
            userId: input.userId,
            connectorId: receipt.connectorId,
            projectId: receipt.projectId,
            scopeKey: current.scopeKey,
            toolName: receipt.toolName,
            action: receipt.action,
            maxRiskClass: "reversible_write",
            sourceReceiptId: receipt.id,
          },
          update: {
            action: receipt.action,
            sourceReceiptId: receipt.id,
            projectId: receipt.projectId,
            maxRiskClass: "reversible_write",
            revokedAt: null,
          },
        });
      }
      return tx.actionApprovalReceipt.findFirstOrThrow({
        where: { id: receipt.id, userId: input.userId },
      });
    });
    return { ok: true, approval: serializeActionApproval(updated), replay: false };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "ACTION_APPROVAL_DECISION_RACE") throw error;
    const winner = await prisma.actionApprovalReceipt.findFirst({
      where: { id: receipt.id, userId: input.userId },
    });
    if (winner?.decision === input.decision) {
      return { ok: true, approval: serializeActionApproval(winner), replay: true };
    }
    return refusal(winner?.status === "expired" ? "expired" : "already_decided");
  }
}

export async function listActionApprovals(input: {
  userId: string;
  conversationId?: string | null;
  includeRecent?: boolean;
}): Promise<ClientActionApproval[]> {
  const now = new Date();
  await prisma.actionApprovalReceipt.updateMany({
    where: {
      userId: input.userId,
      status: "pending",
      expiresAt: { lte: now },
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
    data: { status: "expired", completedAt: now, executionResult: ACTION_DECISION_MESSAGES.expired },
  });
  const rows = await prisma.actionApprovalReceipt.findMany({
    where: {
      userId: input.userId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.includeRecent
        ? { createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } }
        : { status: "pending" }),
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  return rows.map((row) => serializeActionApproval(row));
}
