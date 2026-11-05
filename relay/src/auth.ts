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
export type RelayCallbackAudience =
  | "juno.voice.spend"
  | "juno.voice.memory"
  | "juno.voice.persona"
  /** List the call's tools, or run one (`/api/voice/tools`). Never a decision:
   *  an approval is answered only by the person's signed-in client. */
  | "juno.voice.tools";

/** Signed alongside a callback. Each route reads the ones its audience needs. */
export interface RelayCallbackClaims {
  /** The project a memory request is for. */
  pid?: string;
  /** The agent a persona request is for. */
  aid?: string;
  /** The relay's id for this call: the approval broker keys the call's receipts by it. */
  sid?: string;
  /** The conversation a tools request is for, as the app signed it into the call's token. */
  cid?: string;
  /** Connectors the chat had switched on when the call started, as the app signed them. */
  cx?: string[];
  /** The caller's IANA time zone, for the clock tool and connectors that read dates. */
  tz?: string;
}

export function mintRelayCallbackToken(
  userId: string,
  ttlSeconds = 60,
  audience: RelayCallbackAudience = "juno.voice.spend",
  claims: RelayCallbackClaims = {}
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
    ...(claims.aid ? { aid: claims.aid } : {}),
    ...(claims.sid ? { sid: claims.sid } : {}),
    ...(claims.cid ? { cid: claims.cid } : {}),
    ...(claims.cx?.length ? { cx: claims.cx } : {}),
    ...(claims.tz ? { tz: claims.tz } : {}),
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
 *
 * `agentId` is set when the call is in one of the person's agents' threads:
 * the app resolved the conversation to its agent, owner-scoped, before signing
 * it, and the relay asks for that agent's persona with it. Absent rather than
 * null when there is none, so a grant from a token that predates the claim is
 * the same grant it always was.
 *
 * `tools` is set when the app minted the token for a call that may use the
 * chat's tools — from a chat that is not incognito (an incognito chat leaves
 * no receipts or audit rows, and a tool call writes both). It names the
 * conversation (checked to be this person's before it was signed), the
 * connectors the chat had switched on, and the caller's time zone. None of it
 * is a credential: the relay carries the claim back when it asks Juno for the
 * call's tools, and Juno resolves every connector against this person's own
 * rows when it runs one (relay/src/tools.ts).
 */
export interface VoiceToolGrant {
  conversationId: string | null;
  connectorIds: string[];
  timeZone: string | null;
}

export interface RelayGrant {
  userId: string;
  memory: { projectId: string | null } | null;
  agentId?: string;
  tools?: VoiceToolGrant;
}

/** At most this many connector ids ride in a token; more is a malformed claim, not a longer list. */
export const VOICE_TOOL_MAX_CONNECTORS = 12;
const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,119}$/;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const RECORD_ID = /^[a-z0-9]{20,40}$/i;

/** The tools claim of a session token, or null when the token grants none. */
function toolGrantOf(payload: { tl?: unknown; cid?: unknown; cx?: unknown; tz?: unknown }): VoiceToolGrant | null {
  if (payload.tl !== 1) return null;
  const connectorIds = Array.isArray(payload.cx)
    ? [...new Set(payload.cx.filter((id): id is string => typeof id === "string" && CONNECTOR_ID.test(id)))].slice(
        0,
        VOICE_TOOL_MAX_CONNECTORS
      )
    : [];
  return {
    conversationId: typeof payload.cid === "string" && RECORD_ID.test(payload.cid) ? payload.cid : null,
    connectorIds,
    timeZone: typeof payload.tz === "string" && payload.tz.length <= 64 && TIME_ZONE.test(payload.tz) ? payload.tz : null,
  };
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
      aid?: unknown;
      tl?: unknown;
      cid?: unknown;
      cx?: unknown;
      tz?: unknown;
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
    const agentId = typeof payload.aid === "string" && /^[a-z0-9]{20,40}$/i.test(payload.aid) ? payload.aid : null;
    const tools = toolGrantOf(payload);
    return { userId: payload.uid, memory, ...(agentId ? { agentId } : {}), ...(tools ? { tools } : {}) };
  } catch {
    return null;
  }
}
