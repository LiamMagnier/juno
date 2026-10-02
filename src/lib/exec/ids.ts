/**
 * Identifiers the execution host sees. None of them is a user, conversation or
 * generation id: the host stores opaque hashes only (design §6.3).
 */
import { createHash, createHmac } from "node:crypto";
import type { ExecLanguage, ExecSurface } from "@/lib/exec/types";

function hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function keyed(value: string): string {
  const secret = process.env.AUTH_SECRET || process.env.DATA_ENCRYPTION_KEY || "juno-exec-account";
  return createHmac("sha256", secret).update(value).digest("hex");
}

/**
 * One workspace per (account, surface, session): `s_` + 32 hex.
 *
 * The account is part of it because the session id is not always the
 * server's own: a chat turn's generation id can come from the client
 * (`request.ts`, 8–120 characters). Without the account, two accounts sending
 * the same id would share one /work — each reading the other's inputs, and
 * either planting files the other's next run reports as its own output. Keyed
 * with the server secret, so the host cannot test guesses either.
 */
export function hostSessionId(surface: ExecSurface, sessionId: string, userId: string): string {
  return `s_${keyed(`juno-exec/session/${userId}/${surface}/${sessionId}`).slice(0, 32)}`;
}

/** The account, keyed with a server secret so the host cannot reverse it: `a_` + 32 hex. */
export function hostAccountId(userId: string): string {
  return `a_${keyed(`juno-exec/account/${userId}`).slice(0, 32)}`;
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

/**
 * The host's Idempotency-Key: the same call never starts a second container.
 * Scoped by the host session (so by account), and a provider's call id goes in
 * as is only when it is short, header-safe ASCII; anything else (a newline, a
 * non-Latin character, 500 characters) is hashed rather than failing the
 * request or being cut.
 */
export function hostIdempotencyKey(remoteSession: string, callId: string, argsDigest: string): string {
  const call = /^[A-Za-z0-9_.:-]{1,120}$/.test(callId) ? callId : `h_${hex(callId).slice(0, 40)}`;
  return `${remoteSession}:${call}:${argsDigest.slice(0, 24)}`;
}

/**
 * A name the host accepts for inputs/ (juno-exec INPUT_NAME: no slash,
 * backslash or control character, not starting with a dot, at most 200
 * characters). An attachment called ".data.csv" made the host refuse the
 * upload, and with it every run in that conversation.
 */
export function hostInputName(fileName: string): string {
  let name = fileName.replace(/[\u0000-\u001f\u007f/\\]/g, "_").replace(/^\./, "_");
  // 190, not 200: a second file of the same name still fits with " (2)".
  if ([...name].length > 190) {
    const extension = /\.[A-Za-z0-9]{1,10}$/.exec(name)?.[0] ?? "";
    name = [...name].slice(0, 190 - extension.length).join("") + extension;
  }
  return name.trim() ? name : "file";
}
