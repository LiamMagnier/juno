/**
 * Identifiers the execution host sees. None of them is a user, conversation or
 * generation id: the host stores opaque hashes only (design §6.3).
 */
import { createHash, createHmac } from "node:crypto";
import type { ExecLanguage, ExecSurface } from "@/lib/exec/types";

function hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** One workspace per (surface, session): `s_` + 32 hex. */
export function hostSessionId(surface: ExecSurface, sessionId: string): string {
  return `s_${hex(`juno-exec/session/${surface}/${sessionId}`).slice(0, 32)}`;
}

/** The account, keyed with a server secret so the host cannot reverse it: `a_` + 32 hex. */
export function hostAccountId(userId: string): string {
  const secret = process.env.AUTH_SECRET || process.env.DATA_ENCRYPTION_KEY || "juno-exec-account";
  return `a_${createHmac("sha256", secret).update(`juno-exec/account/${userId}`).digest("hex").slice(0, 32)}`;
}

/** The normalised arguments of a run_code call; part of the ToolRun key. */
export function runArgsDigest(input: { language: ExecLanguage; code: string; files: readonly string[] | null; timeoutMs: number }): string {
  return hex(
    JSON.stringify({
      language: input.language,
      code: input.code,
      files: input.files ? [...input.files].sort() : null,
      timeoutMs: input.timeoutMs,
    }),
  );
}

export function codeDigest(code: string): string {
  return hex(code);
}

/** The host's Idempotency-Key: the same call never starts a second container. */
export function hostIdempotencyKey(surface: ExecSurface, sessionId: string, callId: string, argsDigest: string): string {
  const call = callId.length > 120 ? hex(callId).slice(0, 40) : callId;
  return `${surface}:${hex(sessionId).slice(0, 24)}:${call}:${argsDigest.slice(0, 24)}`;
}
