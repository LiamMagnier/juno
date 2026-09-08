import { hkdfSync } from "node:crypto";
import { jwtDecrypt } from "jose";

/**
 * Who a browser session cookie belongs to, whether or not it has expired.
 *
 * The production smoke may be configured with `JUNO_SMOKE_COOKIE`, a full
 * `Cookie` header captured from a signed-in browser. Auth.js sessions here
 * are JWTs (see `session.strategy` in src/lib/auth.ts), encrypted with a key
 * derived from `AUTH_SECRET`, and they expire after thirty days — after which
 * every deploy rolled back with "unauthenticated". The subject of the token
 * is still the account the operator chose, so the deploy reads it here and
 * mints a fresh native access token for that account instead.
 *
 * The derivation below is Auth.js's own (`@auth/core/jwt`: HKDF-SHA256 over
 * the secret with the cookie name as salt, A256CBC-HS512 for `dir`), copied
 * rather than imported because the library's `decode` refuses an expired
 * token and that is the one case this exists for. The signature and
 * encryption are still verified in full; only the expiry claim is ignored.
 *
 * Never used on a request path.
 */

const SESSION_COOKIE_NAMES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
] as const;

/** The session JWT out of a `Cookie` header, reassembled if Auth.js chunked it. */
export function sessionTokenFromCookieHeader(header: string): { name: string; token: string } | null {
  const jar = new Map<string, string>();
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    jar.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
  }
  for (const name of SESSION_COOKIE_NAMES) {
    const whole = jar.get(name);
    if (whole) return { name, token: whole };
    // A session too large for one cookie is split as `name.0`, `name.1`, …
    const chunks: string[] = [];
    for (let i = 0; jar.has(`${name}.${i}`); i += 1) chunks.push(jar.get(`${name}.${i}`)!);
    if (chunks.length) return { name, token: chunks.join("") };
  }
  return null;
}

async function derivedKey(secret: string, salt: string, enc: string): Promise<Uint8Array> {
  const length = enc === "A256CBC-HS512" ? 64 : enc === "A256GCM" ? 32 : null;
  if (!length) throw new Error(`Unsupported session encryption ${enc}`);
  return new Uint8Array(hkdfSync("sha256", secret, salt, `Auth.js Generated Encryption Key (${salt})`, length));
}

export interface SessionCookieClaims {
  userId: string | null;
  email: string | null;
  expired: boolean;
}

/**
 * Decrypts the session and returns its subject. Throws when the token was
 * not encrypted with `secret` for this cookie name — a foreign or tampered
 * cookie is not an account, expired or otherwise.
 */
export async function readSessionCookieClaims(input: {
  cookieHeader: string;
  secret: string;
}): Promise<SessionCookieClaims | null> {
  const found = sessionTokenFromCookieHeader(input.cookieHeader);
  if (!found) return null;
  const { payload } = await jwtDecrypt(
    found.token,
    async ({ enc }) => derivedKey(input.secret, found.name, enc ?? "A256CBC-HS512"),
    {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256CBC-HS512", "A256GCM"],
      // Expiry is the one claim deliberately not enforced: an expired session
      // still names the account, and naming it is all this is for.
      currentDate: new Date(0),
    }
  );
  const userId = typeof payload.sub === "string" ? payload.sub : typeof payload.id === "string" ? payload.id : null;
  const email = typeof payload.email === "string" ? payload.email : null;
  const expired = typeof payload.exp === "number" ? payload.exp * 1000 <= Date.now() : false;
  return { userId, email, expired };
}
