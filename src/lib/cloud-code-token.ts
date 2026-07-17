import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/*
 * Signed capability for the Cloud Juno Code runner (GitHub Actions).
 *
 * A cloud task is dispatched to an untrusted CI VM that runs arbitrary agent
 * bash. The runner authenticates its FIRST call (GET runner-context) with a
 * GitHub-signed OIDC JWT — NOT a Juno-minted credential — so no secret ever
 * rides the public workflow_dispatch inputs (see src/lib/github-oidc.ts).
 * runner-context then hands back the ONE Juno-minted credential the runner uses
 * for the rest of the run:
 *
 *  - TASK token ("cct_", ~30 min): minted server-side and returned ONLY inside
 *    the runner-context response body (never a dispatch input). It authenticates
 *    the runner's subsequent callbacks (claim/events/respond/cancel + the
 *    /api/agent provider proxy) for the single task it was minted for.
 *
 * It is HMAC-SHA256 over a compact { taskId, exp, kind } payload keyed by
 * CLOUD_CODE_SECRET (never shipped to the runner). The `kind` is part of the
 * SIGNED payload and cross-checked on read, leaving room to add future signed
 * capabilities under the same secret without them being interchangeable.
 *
 * Format:  <prefix><base64url(payload)>.<base64url(hmac)>
 *   payload = JSON { taskId, exp, kind }   exp = unix SECONDS
 *
 * The audience is the EXACT taskId: a token minted for task A never
 * authenticates task B. Expiry is enforced and the signature check is
 * constant-time.
 */

/** Task token: runner → Juno callbacks (claim/events/respond/cancel + proxy). */
export const CLOUD_CODE_TOKEN_PREFIX = "cct_";

/** ~30 min: long enough for a cold-start clone + install + agent run, short
 *  enough that a leaked token is a narrow, self-expiring window. Aligned with
 *  docs/cloud-code.md. */
export const CLOUD_CODE_TOKEN_TTL_MS = 30 * 60_000;

type TokenKind = "task";

function sign(payload: string): Buffer {
  return createHmac("sha256", env.cloudCodeSecret).update(payload).digest();
}

/** Mint a credential of `kind`/`prefix` scoped to exactly `taskId`. */
function mint(prefix: string, kind: TokenKind, taskId: string, ttlMs: number): string {
  const exp = Math.floor((Date.now() + ttlMs) / 1000);
  const payload = Buffer.from(JSON.stringify({ taskId, exp, kind })).toString("base64url");
  const sig = sign(payload).toString("base64url");
  return `${prefix}${payload}.${sig}`;
}

/**
 * Verify prefix + signature + expiry + kind and return the audience taskId, or
 * null if the credential is malformed, forged, expired, or of the WRONG KIND.
 * Does not bind to a caller-supplied taskId — used where the taskId is unknown
 * up front (the provider proxy). For an audience-bound check use verifyTaskToken.
 */
function read(prefix: string, expectedKind: TokenKind, token: string): string | null {
  if (typeof token !== "string" || !token.startsWith(prefix)) return null;
  const rest = token.slice(prefix.length);
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

  let decoded: { taskId?: unknown; exp?: unknown; kind?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof decoded.taskId !== "string" || typeof decoded.exp !== "number") return null;
  // Kind is signed AND cross-checked, so a future credential kind minted under
  // the same secret can never be replayed as a task token.
  if (decoded.kind !== expectedKind) return null;
  if (!Number.isFinite(decoded.exp) || decoded.exp * 1000 <= Date.now()) return null;
  return decoded.taskId;
}

/** Constant-time audience match against a caller-supplied taskId. */
function audienceMatches(audience: string | null, taskId: string): boolean {
  if (audience === null) return false;
  const a = Buffer.from(audience);
  const b = Buffer.from(taskId);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Task token (cct_) ───────────────────────────────────────────────────────

/** Mint a task bearer scoped to exactly `taskId`, valid for `ttlMs`. */
export function mintTaskToken(taskId: string, ttlMs: number = CLOUD_CODE_TOKEN_TTL_MS): string {
  return mint(CLOUD_CODE_TOKEN_PREFIX, "task", taskId, ttlMs);
}

/** Audience taskId of a valid, unexpired task token, else null. */
export function readTaskToken(token: string): string | null {
  return read(CLOUD_CODE_TOKEN_PREFIX, "task", token);
}

/** True iff `token` is a valid task token whose audience is EXACTLY `taskId`. */
export function verifyTaskToken(token: string, taskId: string): boolean {
  return audienceMatches(readTaskToken(token), taskId);
}
