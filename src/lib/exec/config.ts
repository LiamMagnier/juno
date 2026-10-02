/**
 * Whether hosted execution exists here, and its per-surface limits.
 *
 * THE SAFETY RULE IS UNCHANGED FROM THE TOOL THIS REPLACES: model-written code
 * runs only on the remote execution host (deploy/exec-host), never in a
 * process on this machine. No sandbox configured means the tool is not
 * offered, and a configured sandbox that is down is a `capability_unavailable`
 * result the model must report. It never costs a boundary.
 *
 * Three settings, all on the web VM only: `CODE_INTERPRETER_URL`,
 * `CODE_INTERPRETER_TOKEN` (the bearer token juno-exec checks) and the feature
 * switch `TOOL_RUNTIME=1` the owner sets once the host is healthy. The old
 * `E2B_API_KEY` fallback is gone: a hosted sandbox that allows egress by
 * default would make `run_code` something other than the read it is
 * classified as.
 */
import type { ExecSurface } from "@/lib/exec/types";

export interface ExecEndpoint {
  url: string;
  token: string;
}

export interface SurfaceLimits {
  /** How long a call waits for its run before answering `running` with a run id. */
  inlineWaitMs: number;
  /** Default and maximum wall clock for one run. */
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}

const CHAT_LIMITS: SurfaceLimits = { inlineWaitMs: 90_000, defaultTimeoutMs: 120_000, maxTimeoutMs: 10 * 60_000 };
const WORK_LIMITS: SurfaceLimits = { inlineWaitMs: 30 * 60_000, defaultTimeoutMs: 5 * 60_000, maxTimeoutMs: 30 * 60_000 };

export function surfaceLimits(surface: ExecSurface): SurfaceLimits {
  const base = surface === "work" ? WORK_LIMITS : CHAT_LIMITS;
  // Tests shorten the inline wait to exercise the `running` → check_run path.
  // Never honoured in production, where a stray value would change behaviour.
  if (process.env.NODE_ENV === "production") return base;
  const override = Number(process.env.EXEC_INLINE_WAIT_MS);
  return Number.isFinite(override) && override > 0 ? { ...base, inlineWaitMs: override } : base;
}

/** Per-turn and per-run bounds (design §6.3, §6.9). */
export const EXEC_LIMITS = {
  runsPerTurn: 20,
  maxCodeBytes: 256 * 1024,
  maxInputFiles: 20,
  maxInputBytes: 32 * 1024 * 1024,
  /** Head and tail of each stream the model sees. */
  tailBytes: 8 * 1024,
  /** Full logs kept in object storage, per stream. */
  maxLogBytes: 16 * 1024 * 1024,
  /** Images returned to a vision model in the tool round. */
  maxImages: 4,
  maxImageBytes: 4 * 1024 * 1024,
  /** One check_run page. */
  pageChars: 40_000,
  /** How long a lease lasts without renewal before the sweep may take the row. */
  leaseMs: 60_000,
} as const;

function isLocalHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/**
 * The endpoint, or null when hosted execution is off. Plain HTTP is accepted
 * only for a loopback address (the local Docker Desktop profile).
 */
export function execEndpoint(): ExecEndpoint | null {
  if (process.env.TOOL_RUNTIME?.trim() !== "1") return null;
  const raw = process.env.CODE_INTERPRETER_URL?.trim();
  const token = process.env.CODE_INTERPRETER_TOKEN?.trim();
  if (!raw || !token || token.length < 32) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) return null;
  return { url: url.toString().replace(/\/+$/, ""), token };
}

/**
 * Whether the runtime may be attached at all. Read from the environment, not
 * probed: this decides tool attachment on every turn, and a health check per
 * message would put a network round trip in front of every reply. A
 * configured host that is down answers the call with capability_unavailable.
 */
export function isExecConfigured(): boolean {
  return execEndpoint() !== null;
}

/** The inputs to the attach decision that this lane owns (L1 adds plan and model evidence). */
export interface ExecEntitlementInput {
  privateMode: boolean;
  lockdown: boolean;
  /** Paid plan (chat-rework DECISIONS §4c, owner confirms). */
  paidPlan: boolean;
  /** Workspaces that restrict tools keep code off unless they allow it. */
  workspaceAllowsCode?: boolean;
  /** The model's tool round trip is verified (§6.11, L1's probe). */
  modelToolsVerified: boolean;
}

export type ExecEntitlement =
  | { attach: true }
  | { attach: false; reason: "not_configured" | "private" | "lockdown" | "plan" | "workspace" | "model_unverified" };

/**
 * Whether run_code / check_run ride this turn. L1's entitlement table calls this;
 * the order of the checks is the order of the reasons a person is told.
 */
export function execEntitlement(input: ExecEntitlementInput): ExecEntitlement {
  if (input.privateMode) return { attach: false, reason: "private" };
  if (input.lockdown) return { attach: false, reason: "lockdown" };
  if (!isExecConfigured()) return { attach: false, reason: "not_configured" };
  if (!input.paidPlan) return { attach: false, reason: "plan" };
  if (input.workspaceAllowsCode === false) return { attach: false, reason: "workspace" };
  if (!input.modelToolsVerified) return { attach: false, reason: "model_unverified" };
  return { attach: true };
}

/** Metering price per sandbox-second, in micro-USD (design §6.9; owner sets the real figure). */
export function runCodeMicroUsdPerSecond(): number {
  const value = Number(process.env.RUN_CODE_MICRO_USD_PER_SECOND);
  return Number.isFinite(value) && value >= 0 ? value : 46;
}
