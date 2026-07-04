import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Relay auth: the Juno backend mints `base64url(payload).hmac` tokens with the
 * SHARED AUTH_SECRET (same algorithm as src/lib/crypto.ts signState). Payload
 * is JSON {"uid": string, "exp": epochSeconds}. The relay never talks to the
 * database — possession of a fresh valid token IS the authorization.
 */
export function verifyRelayToken(token: string | null): { userId: string } | null {
  if (!token) return null;
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured on the relay.");
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { uid?: string; exp?: number };
    if (typeof payload.uid !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return { userId: payload.uid };
  } catch {
    return null;
  }
}
