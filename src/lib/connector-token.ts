import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";

/*
 * Short-lived bearer tokens for credentials-kind connectors. The model is
 * handed one of these (never the underlying iCloud app password / MusicKit
 * user token) and presents it to our own MCP route (app/api/mcp/[connector]),
 * which verifies it and only then decrypts the real credential server-side.
 * Format mirrors signState/verifyState in lib/crypto.ts: base64url(payload).hmac.
 */

const TOKEN_TTL_MS = 15 * 60_000;

export interface ConnectorTokenPayload {
  userId: string;
  connectorId: string;
  /** Unix ms expiry. */
  exp: number;
}

function mac(body: string): string {
  return createHmac("sha256", `juno:connector-token:${env.authSecret}`).update(body).digest("base64url");
}

export function mintConnectorToken(userId: string, connectorId: string): string {
  const payload: ConnectorTokenPayload = { userId, connectorId, exp: Date.now() + TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body)}`;
}

/** Verify + decode a connector token; returns null if tampered, malformed, or expired. */
export function verifyConnectorToken(token: string): ConnectorTokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: ConnectorTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConnectorTokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.userId !== "string" || typeof payload.connectorId !== "string" || typeof payload.exp !== "number") return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}
