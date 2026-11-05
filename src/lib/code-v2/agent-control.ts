/**
 * A person's controls over the agents of a Code run (REA backlog 10, the web
 * Agents tree): Steer, Stop, Pause, Resume and a bounded budget Top-up.
 *
 *   POST /api/code/v2/link/[deviceId]/agents
 *     { sessionId, agentId?, action, text?, tokens?, usd?, idempotencyKey }
 *
 * The one door these commands have into the user's Mac from the hosted web
 * (the generic link route refuses them, device-link.ts). In order:
 *
 *   1. the account is signed in and under its control-rate ceiling;
 *   2. the request is well formed and its amounts are inside the bounds;
 *   3. the account owns the Mac, and this phone or browser holds a live pair
 *      with it (docs/code-v2/REMOTE-CONTROL.md);
 *   4. an idempotency key already answered is answered again from the audit
 *      log, without reaching the Mac (a different request under the same key
 *      is refused);
 *   5. the command is relayed with the key as its `requestId`, so a retry that
 *      raced the first one is still applied once by the env server;
 *   6. one row goes to the compliance log (`recordWorkAudit`), whatever the
 *      outcome: identifiers, verdicts and counts only, never the steer text.
 *
 * Nothing here can answer an approval or widen an agent's access: Steer is a
 * message the agent reads at its next step, Pause and Resume hold or release
 * it between steps, and a Top-up only raises a token or dollar cap within
 * the engine's own bounds (agent-core SUBAGENT_TOP_UP_LIMITS).
 *
 * Pure apart from the injected `AgentControlDeps`, so the route stays thin and
 * this is unit-tested.
 */
import { createHash } from "node:crypto";
import type { AgentControlResult, ClientCommand } from "./contracts";
import type { LinkReply, LinkRpcOptions } from "./env-link-hub";

export const AGENT_CONTROL_ACTIONS = ["steer", "stop", "pause", "resume", "top_up"] as const;
export type AgentControlAction = (typeof AGENT_CONTROL_ACTIONS)[number];

/**
 * The same bounds the engine enforces (agent-core SUBAGENT_TOP_UP_LIMITS),
 * checked here first so an out-of-range amount is a 400 that never wakes the
 * Mac. The engine stays the authority: it also caps the lifetime total.
 */
export const AGENT_TOP_UP_BOUNDS = {
  agentTokens: { min: 10_000, max: 400_000 },
  runTokens: { min: 10_000, max: 2_000_000 },
  runUsd: { min: 0.5, max: 20 },
} as const;

/** Per-account ceilings: every control, and top-ups on their own. */
export const AGENT_CONTROL_RATE_LIMIT = { limit: 60, windowSec: 60 } as const;
export const AGENT_TOP_UP_RATE_LIMIT = { limit: 20, windowSec: 60 * 60 } as const;
/** How long an idempotency key is answered from the log. */
export const AGENT_CONTROL_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AGENT_STEER_MAX_CHARS = 8_000;

export interface AgentControlRequest {
  sessionId: string;
  /** Absent: the whole run (Stop the run, Pause or Resume every agent, raise the run budget). */
  agentId?: string;
  action: AgentControlAction;
  text?: string;
  tokens?: number;
  usd?: number;
  idempotencyKey: string;
}

export type AgentControlParse = { ok: true; request: AgentControlRequest } | { ok: false; error: string };

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const KEY = /^[A-Za-z0-9_.:-]{8,200}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseAgentControl(body: unknown): AgentControlParse {
  if (!isRecord(body)) return { ok: false, error: "Invalid input" };
  const { sessionId, agentId, action, text, tokens, usd, idempotencyKey } = body;
  if (typeof idempotencyKey !== "string" || !KEY.test(idempotencyKey)) return { ok: false, error: "A request key is required." };
  if (typeof sessionId !== "string" || !ID.test(sessionId)) return { ok: false, error: "A session is required." };
  if (agentId !== undefined && (typeof agentId !== "string" || !ID.test(agentId))) return { ok: false, error: "That agent id is not valid." };
  if (typeof action !== "string" || !(AGENT_CONTROL_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: "Unknown action." };
  const request: AgentControlRequest = { sessionId, action: action as AgentControlAction, idempotencyKey, ...(agentId ? { agentId } : {}) };
  switch (request.action) {
    case "steer": {
      if (!request.agentId) return { ok: false, error: "Choose an agent to steer." };
      if (typeof text !== "string" || !text.trim()) return { ok: false, error: "Write a message for the agent." };
      if (text.length > AGENT_STEER_MAX_CHARS) return { ok: false, error: "That message is too long." };
      request.text = text.trim();
      break;
    }
    case "top_up": {
      const bounds = AGENT_TOP_UP_BOUNDS;
      const hasTokens = tokens !== undefined;
      const hasUsd = usd !== undefined;
      if (!hasTokens && !hasUsd) return { ok: false, error: "Say how much to add." };
      if (hasTokens) {
        const range = request.agentId ? bounds.agentTokens : bounds.runTokens;
        if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < range.min || tokens > range.max) {
          return { ok: false, error: `Add between ${range.min.toLocaleString("en-US")} and ${range.max.toLocaleString("en-US")} tokens.` };
        }
        request.tokens = tokens;
      }
      if (hasUsd) {
        if (request.agentId) return { ok: false, error: "An agent is topped up in tokens." };
        if (typeof usd !== "number" || !Number.isFinite(usd) || usd < bounds.runUsd.min || usd > bounds.runUsd.max) {
          return { ok: false, error: `Add between $${bounds.runUsd.min.toFixed(2)} and $${bounds.runUsd.max.toFixed(2)}.` };
        }
        request.usd = Math.round(usd * 100) / 100;
      }
      break;
    }
    default:
      break;
  }
  return { ok: true, request };
}

/** The wire command for a request. The idempotency key rides as `requestId` (the env server's dedupe). */
export function agentControlCommand(request: AgentControlRequest, commandId: string): ClientCommand {
  const { sessionId, agentId, idempotencyKey: requestId } = request;
  const target = agentId ? { agentId } : {};
  switch (request.action) {
    case "steer":
      return { id: commandId, type: "agent.message", params: { sessionId, agentId: agentId!, text: request.text!, requestId } };
    case "stop":
      // One agent keeps its work and stays continuable; the run's Stop is the composer's Stop.
      return agentId
        ? { id: commandId, type: "agent.interrupt", params: { sessionId, agentId, requestId } }
        : { id: commandId, type: "turn.interrupt", params: { sessionId } };
    case "pause":
      return { id: commandId, type: "agent.pause", params: { sessionId, ...target, requestId } };
    case "resume":
      return { id: commandId, type: "agent.resume", params: { sessionId, ...target, requestId } };
    case "top_up":
      return {
        id: commandId,
        type: "agent.topUp",
        params: {
          sessionId,
          ...target,
          ...(request.tokens === undefined ? {} : { tokens: request.tokens }),
          ...(request.usd === undefined ? {} : { usd: request.usd }),
          requestId,
        },
      };
  }
}

/** A digest of what was asked, so a key reused for a different request is caught without storing the request. */
export function agentControlDigest(request: AgentControlRequest): string {
  const canonical = JSON.stringify([request.action, request.sessionId, request.agentId ?? null, request.text ?? null, request.tokens ?? null, request.usd ?? null]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export type AgentControlOutcome = "accepted" | "refused" | "failed" | "offline";

/** What the compliance log keeps for one control (keys from src/lib/work/audit.ts's allowlist). */
export interface AgentControlAuditDetail {
  action: AgentControlAction;
  outcome: AgentControlOutcome;
  sessionId: string;
  deviceId: string;
  /** The agent id, or "run". */
  target: string;
  idempotencyKey: string;
  contentHash: string;
  /** The engine's answer in a sentence (amounts and ids, never the steer text). */
  reason?: string;
  /** Tokens added, or agents paused / resumed. */
  count?: number;
  allowed: boolean;
}

export interface StoredAgentControl {
  outcome: AgentControlOutcome;
  contentHash?: string;
  reason?: string;
  count?: number;
}

export interface AgentControlDeps {
  rateLimit(key: string, limit: number, windowSec: number): Promise<boolean>;
  /** The Mac, when this account owns it. */
  findDevice(userId: string, deviceId: string): Promise<{ id: string; name: string } | null>;
  /** The remote-control pair check: null when this phone or browser may control the Mac. */
  checkPair(userId: string, deviceId: string): Promise<{ status: number; error: string; code?: string } | null>;
  /** The decisive earlier answer under this key, within the replay window. */
  findPrior(userId: string, idempotencyKey: string, since: Date): Promise<StoredAgentControl | null>;
  relay(userId: string, deviceId: string, command: ClientCommand, options: LinkRpcOptions): Promise<LinkReply>;
  audit(userId: string, detail: AgentControlAuditDetail): Promise<void>;
  newCommandId(): string;
  now(): number;
}

export interface AgentControlReply {
  status: number;
  body: Record<string, unknown>;
}

export interface AgentControlResponseBody extends AgentControlResult {
  /** True when this key was already answered and the Mac was not asked again. */
  replayed?: boolean;
  offline?: boolean;
}

function wordsOf(result: unknown): AgentControlResult {
  if (!isRecord(result)) return { accepted: true };
  const accepted = typeof result.accepted === "boolean" ? result.accepted : true;
  return {
    accepted,
    ...(typeof result.message === "string" && result.message ? { message: result.message.slice(0, 500) } : {}),
    ...(typeof result.count === "number" ? { count: result.count } : {}),
    ...(typeof result.tokenBudget === "number" ? { tokenBudget: result.tokenBudget } : {}),
    ...(isRecord(result.budget) && typeof result.budget.tokens === "number" && typeof result.budget.costUsd === "number"
      ? {
          budget: {
            tokens: result.budget.tokens,
            costUsd: result.budget.costUsd,
            ...(typeof result.budget.maxTokens === "number" ? { maxTokens: result.budget.maxTokens } : {}),
            ...(typeof result.budget.maxUsd === "number" ? { maxUsd: result.budget.maxUsd } : {}),
          },
        }
      : {}),
  };
}

export async function handleAgentControl(
  deps: AgentControlDeps,
  input: { userId: string; deviceId: string; body: unknown },
): Promise<AgentControlReply> {
  const { userId, deviceId } = input;
  if (!(await deps.rateLimit(`code-agent-control:${userId}`, AGENT_CONTROL_RATE_LIMIT.limit, AGENT_CONTROL_RATE_LIMIT.windowSec))) {
    return { status: 429, body: { error: "rate_limited", message: "Too many agent controls at once. Try again in a minute." } };
  }
  const parsed = parseAgentControl(input.body);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const request = parsed.request;

  const device = await deps.findDevice(userId, deviceId);
  if (!device) return { status: 404, body: { error: "This computer is not paired with your account." } };
  const unpaired = await deps.checkPair(userId, device.id);
  if (unpaired) return { status: unpaired.status, body: { error: unpaired.error, message: unpaired.error, ...(unpaired.code ? { code: unpaired.code } : {}) } };

  const contentHash = agentControlDigest(request);
  const prior = await deps.findPrior(userId, request.idempotencyKey, new Date(deps.now() - AGENT_CONTROL_REPLAY_WINDOW_MS));
  if (prior && (prior.outcome === "accepted" || prior.outcome === "refused")) {
    if (prior.contentHash && prior.contentHash !== contentHash) {
      return { status: 422, body: { error: "idempotency_key_reused", message: "That request key was already used for a different action." } };
    }
    const body: AgentControlResponseBody = {
      accepted: prior.outcome === "accepted",
      ...(prior.reason ? { message: prior.reason } : {}),
      replayed: true,
    };
    return { status: 200, body: { ...body } };
  }

  // Top-ups spend money: their own, tighter ceiling, counted only once a request is real.
  if (request.action === "top_up" && !(await deps.rateLimit(`code-agent-topup:${userId}`, AGENT_TOP_UP_RATE_LIMIT.limit, AGENT_TOP_UP_RATE_LIMIT.windowSec))) {
    return { status: 429, body: { error: "rate_limited", message: "Too many top-ups this hour." } };
  }

  const command = agentControlCommand(request, deps.newCommandId());
  const audit = (outcome: AgentControlOutcome, reason?: string, count?: number) =>
    deps.audit(userId, {
      action: request.action,
      outcome,
      sessionId: request.sessionId,
      deviceId: device.id,
      target: request.agentId ?? "run",
      idempotencyKey: request.idempotencyKey,
      contentHash,
      allowed: outcome === "accepted",
      ...(reason ? { reason: reason.slice(0, 200) } : {}),
      ...(count === undefined ? {} : { count }),
    });

  let reply: LinkReply;
  try {
    reply = await deps.relay(userId, device.id, command, { agentControl: true });
  } catch {
    await audit("failed", "relay error");
    return { status: 502, body: { error: "relay_failed", message: "Could not reach your Mac. Try again." } };
  }
  if (reply.offline) {
    const message = reply.message ?? `${device.name} did not answer.`;
    await audit("offline");
    return { status: 503, body: { error: "offline", offline: true, message } };
  }
  const response = reply.responses?.find((r) => r.id === command.id) ?? reply.responses?.[0];
  if (!response) {
    await audit("failed", "no answer");
    return { status: 504, body: { error: "no_answer", message: "Your Mac did not answer in time. Try again." } };
  }
  if (!response.ok) {
    const message = response.error?.message ?? "Your Mac refused that.";
    const retryable = response.error?.code === "not_ready";
    await audit(retryable ? "failed" : "refused", message);
    return { status: retryable ? 503 : 409, body: { error: response.error?.code ?? "refused", message } };
  }
  const words = command.type === "turn.interrupt" ? { accepted: true, message: "Stopping the run." } : wordsOf(response.result);
  const counted = request.action === "top_up" ? (request.tokens ?? undefined) : words.count;
  await audit(words.accepted ? "accepted" : "refused", words.message, counted);
  const body: AgentControlResponseBody = words;
  return { status: 200, body: { ...body } };
}
