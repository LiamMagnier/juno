/**
 * Shared plumbing for the remote control pairing routes
 * (src/app/api/code/pairing/**, docs/code-v2/REMOTE-CONTROL.md).
 */
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import type { OfferRef, PairingError } from "@/lib/code-v2/device-pairing";

export const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export const pairingSecret = (): string => env.authSecret;

export function pairingError(error: PairingError): NextResponse {
  return NextResponse.json({ error: error.message, message: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
}

/** `{token}` (a scanned QR) or `{code}` (typed on the web); anything else is null. */
export function offerRefFrom(body: unknown): OfferRef | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.token === "string" && b.token.length > 0 && b.token.length <= 1024) return { token: b.token };
  if (typeof b.code === "string" && b.code.length > 0 && b.code.length <= 32) return { code: b.code };
  return null;
}

/**
 * Twenty tries a minute per account: a code is 40 bits and lives two minutes,
 * and only the account's own offers can match, so this is belt and braces.
 */
export async function pairingAttemptAllowed(userId: string): Promise<boolean> {
  try {
    return (await rateLimit({ key: `remote-pair:${userId}`, limit: 20, windowSec: 60 })).success;
  } catch {
    return true;
  }
}
