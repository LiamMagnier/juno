import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Relay auth: the Juno backend mints `base64url(payload).hmac` tokens with the
 * SHARED AUTH_SECRET (same algorithm as src/lib/crypto.ts signState). Payload
 * is JSON {"uid": string, "exp": epochSeconds}. The relay never talks to the
 * database — possession of a fresh valid token IS the authorization.
 */
/**
 * Mint a token for the relay's own calls BACK to Juno.
 *
 * Same construction as the inbound token and the same shared `AUTH_SECRET`, run
 * in the other direction: Juno proves to the relay that a user is real, and
 * this proves to Juno that a spend report came from the relay rather than from
 * anyone who can reach the endpoint. The relay still never touches the
 * database — it only asserts "this is me, reporting for this user".
 *
 * Deliberately short-lived. It is minted per request rather than held, so a
 * token captured off the wire is useless within a minute, and a relay process
 * that is killed leaves nothing reusable behind.
 */
/** What a callback is for. Each has its own audience, checked by its own route. */
export type RelayCallbackAudience = "juno.voice.spend" | "juno.voice.memory";

export function mintRelayCallbackToken(
  userId: string,
  ttlSeconds = 60,
  audience: RelayCallbackAudience = "juno.voice.spend",
  /** Signed alongside: the project a memory request is for. */
  claims: { pid?: string } = {}
): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured on the relay.");
  const payload = JSON.stringify({
    uid: userId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    // Names the direction AND the purpose, so a token minted for a callback can
    // never be replayed as a session token, and a spend report's token can
    // never read memory (or the reverse).
    aud: audience,
    ...(claims.pid ? { pid: claims.pid } : {}),
  });
  const body = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/**
 * What a session token grants. `memory` is set when the app minted the token
 * for a call that should know what Juno remembers — from a chat that is not
 * incognito — with the project it belongs to, if any. The app checked access
 * to that project before signing it; the relay only carries the claim back.
 */
export interface RelayGrant {
  userId: string;
  memory: { projectId: string | null } | null;
}

export function verifyRelayToken(token: string | null): RelayGrant | null {
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
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      uid?: string;
      exp?: number;
      aud?: unknown;
      mem?: unknown;
      pid?: unknown;
    };
    // Spend callback tokens use the same HMAC secret but are for the opposite
    // direction. Accepting their audience here would let a captured relay
    // callback token open a user-facing WebSocket session.
    if (payload.aud !== undefined) return null;
    if (typeof payload.uid !== "string" || payload.uid.length === 0 || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 <= Date.now()) return null;
    const memory =
      payload.mem === 1
        ? { projectId: typeof payload.pid === "string" && payload.pid.length > 0 ? payload.pid : null }
        : null;
    return { userId: payload.uid, memory };
  } catch {
    return null;
  }
}
