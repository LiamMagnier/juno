import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/*
 * Task-scoped bearer tokens for the Cloud Juno Code runner (GitHub Actions).
 *
 * A cloud task is dispatched to an untrusted CI VM that runs arbitrary agent
 * bash. It must be able to call back into Juno (claim/events/respond/cancel,
 * runner-context, the provider proxy) — but ONLY for the single task it was
 * dispatched for, and WITHOUT ever seeing .env, the DB URL, AUTH_SECRET, or any
 * provider key. This token is that capability: an HMAC-SHA256 over a compact
 * { taskId, exp } payload, keyed by CLOUD_CODE_SECRET (never shipped to the
 * runner — only the derived per-task token is).
 *
 * Format:  cct_<base64url(payload)>.<base64url(hmac)>
 *   payload = JSON { taskId, exp }   exp = unix SECONDS
 *
 * The audience is the EXACT taskId: a token minted for task A never
 * authenticates task B (see verifyTaskToken). Tokens expire after TTL and the
 * signature check is constant-time.
 */

export const CLOUD_CODE_TOKEN_PREFIX = "cct_";

/** ~40 min: long enough for a cold-start clone + install + agent run, short
 *  enough that a leaked token is a narrow, self-expiring window. */
export const CLOUD_CODE_TOKEN_TTL_MS = 40 * 60_000;

function sign(payload: string): Buffer {
  return createHmac("sha256", env.cloudCodeSecret).update(payload).digest();
}

/** Mint a bearer scoped to exactly `taskId`, valid for `ttlMs`. */
export function mintTaskToken(taskId: string, ttlMs: number = CLOUD_CODE_TOKEN_TTL_MS): string {
  const exp = Math.floor((Date.now() + ttlMs) / 1000);
  const payload = Buffer.from(JSON.stringify({ taskId, exp })).toString("base64url");
  const sig = sign(payload).toString("base64url");
  return `${CLOUD_CODE_TOKEN_PREFIX}${payload}.${sig}`;
}

/**
 * Verify signature + expiry and return the token's audience taskId, or null if
 * the token is malformed, forged, or expired. Does NOT bind to a caller-supplied
 * taskId — used where the taskId is unknown up front (the provider proxy, which
 * has no taskId in its path). For an audience-bound check use verifyTaskToken.
 */
export function readTaskToken(token: string): string | null {
  if (typeof token !== "string" || !token.startsWith(CLOUD_CODE_TOKEN_PREFIX)) return null;
  const rest = token.slice(CLOUD_CODE_TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  const payload = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);

  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = sign(payload);
  // Constant-time signature comparison; unequal lengths can't be timing-safe so
  // reject before the compare.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  let decoded: { taskId?: unknown; exp?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof decoded.taskId !== "string" || typeof decoded.exp !== "number") return null;
  if (!Number.isFinite(decoded.exp) || decoded.exp * 1000 <= Date.now()) return null;
  return decoded.taskId;
}

/**
 * True iff `token` is a valid, unexpired task bearer whose audience is EXACTLY
 * `taskId`. The taskId comparison is constant-time; a token for another task
 * (or a forged/expired one) returns false.
 */
export function verifyTaskToken(token: string, taskId: string): boolean {
  const audience = readTaskToken(token);
  if (audience === null) return false;
  const a = Buffer.from(audience);
  const b = Buffer.from(taskId);
  return a.length === b.length && timingSafeEqual(a, b);
}
