/**
 * Remote control pairing (docs/code-v2/REMOTE-CONTROL.md).
 *
 * A Mac shows a pairing offer: a QR holding a signed, two-minute, single-use
 * token (a phone scans it), or a URL plus a short code (a browser types it).
 * The controller, signed in to the SAME account, sees "Allow this iPhone to
 * control Alevr on <Mac>?" and approves or denies. Approving consumes the
 * offer and writes a `DevicePair`; from then on every remote command from that
 * phone (its native sign-in) or browser (its `alevr_remote` cookie) to that Mac
 * needs the pair to be live. Revoking it, or signing the phone out, cuts access
 * on the next request.
 *
 * The rules live here, behind a small `PairingStore` so they are tested with
 * an in-memory store (tests/remote-control-pairing.test.ts) and run against
 * Prisma in the routes (`prismaPairingStore`). Nothing in this file trusts a
 * token for anything but naming its own offer: the offer row decides, and the
 * row is only ever read for the signed-in account.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PAIRING_TTL_MS = 2 * 60 * 1000;
export const PAIRING_KINDS = ["phone", "browser"] as const;
export type PairingKind = (typeof PAIRING_KINDS)[number];
export const isPairingKind = (v: unknown): v is PairingKind => v === "phone" || v === "browser";

/** The browser's pairing cookie: a random key, its sha256 stored on the pair. */
export const REMOTE_BROWSER_COOKIE = "alevr_remote";
export const REMOTE_BROWSER_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

const TOKEN_PREFIX = "rcp1";
/** No 0/O, 1/I/L, U: read aloud or typed from a screen without a second look. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 8;

// ── Pure helpers ────────────────────────────────────────────────────────────

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const b64url = (buf: Buffer): string => buf.toString("base64url");

function signingKey(secret: string): Buffer {
  // A derived key, so the pairing signature can never be confused with any
  // other HMAC the app makes with AUTH_SECRET.
  return createHmac("sha256", secret).update("alevr-remote-pairing-v1").digest();
}

export interface PairingClaims {
  /** PairingToken.id */
  tokenId: string;
  userId: string;
  deviceId: string;
  kind: PairingKind;
  /** Epoch ms. */
  expiresAt: number;
}

/** `rcp1.<payload>.<signature>`, both base64url. */
export function signPairingToken(claims: PairingClaims, secret: string): string {
  const payload = b64url(
    Buffer.from(
      JSON.stringify({ t: claims.tokenId, u: claims.userId, d: claims.deviceId, k: claims.kind, e: claims.expiresAt, n: b64url(randomBytes(9)) }),
    ),
  );
  const signature = b64url(createHmac("sha256", signingKey(secret)).update(`${TOKEN_PREFIX}.${payload}`).digest());
  return `${TOKEN_PREFIX}.${payload}.${signature}`;
}

export type TokenCheck = { ok: true; claims: PairingClaims } | { ok: false; reason: "malformed" | "signature" | "expired" };

/** Verifies the signature and the expiry. The offer row is still the authority. */
export function verifyPairingToken(token: string, secret: string, now = Date.now()): TokenCheck {
  if (typeof token !== "string" || token.length > 1024) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", signingKey(secret)).update(`${TOKEN_PREFIX}.${parts[1]}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts[2], "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "signature" };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const { t, u, d, k, e } = raw;
  if (typeof t !== "string" || typeof u !== "string" || typeof d !== "string" || !isPairingKind(k) || typeof e !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (e <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims: { tokenId: t, userId: u, deviceId: d, kind: k, expiresAt: e } };
}

/** An 8-character code from an unambiguous alphabet. */
export function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

/** "abcd-efgh", "ABCD EFGH" and "ABCDEFGH" are one code; null when it cannot be one. */
export function normalizePairingCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const c of code) if (!CODE_ALPHABET.includes(c)) return null;
  return code;
}

/** "ABCDEFGH" → "ABCD-EFGH", as the Mac shows it. */
export const formatPairingCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export const codeHashOf = (code: string): string => sha256(`code:${code}`);

/** Where the QR (phone) or the typed URL (browser) lands on the web. */
export function pairingUrl(appUrl: string, kind: PairingKind, token: string): string {
  const base = appUrl.replace(/\/+$/, "");
  return kind === "phone" ? `${base}/pair?t=${encodeURIComponent(token)}` : `${base}/pair`;
}

/** The name a browser introduces itself with on the Mac's list. */
export function browserNameFrom(userAgent: string | null | undefined): { name: string; platform: string } {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "A browser";
  const platform = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /Windows/.test(ua)
        ? "Windows"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return { name: platform ? `${browser} on ${platform}` : browser, platform: platform.toLowerCase() };
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface PairingTokenRow {
  id: string;
  userId: string;
  codeDeviceId: string;
  kind: PairingKind;
  tokenHash: string;
  codeHash: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  status: "pending" | "approved" | "denied";
  pairId: string | null;
  createdAt: Date;
}

export interface DevicePairRow {
  id: string;
  userId: string;
  codeDeviceId: string;
  kind: PairingKind;
  name: string;
  platform: string;
  deviceSessionId: string | null;
  browserKeyHash: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
}

export interface PairingDevice {
  id: string;
  name: string;
}

/** The I/O pairing needs. Every method is scoped by `userId`. */
export interface PairingStore {
  device(userId: string, deviceId: string): Promise<PairingDevice | null>;
  /** Whether this native sign-in is live (not revoked) for this account. */
  deviceSessionLive(userId: string, deviceSessionId: string): Promise<{ name: string; platform: string } | null>;
  createToken(row: Omit<PairingTokenRow, "createdAt">): Promise<void>;
  tokenById(userId: string, id: string): Promise<PairingTokenRow | null>;
  tokenByHash(userId: string, tokenHash: string): Promise<PairingTokenRow | null>;
  tokenByCode(userId: string, codeHash: string, now: Date): Promise<PairingTokenRow | null>;
  /**
   * Atomically moves a pending, unexpired, unconsumed offer to `status`.
   * Returns false when someone else got there first (single use).
   */
  consumeToken(userId: string, id: string, status: "approved" | "denied", now: Date): Promise<boolean>;
  setTokenPair(userId: string, id: string, pairId: string): Promise<void>;
  createPair(row: Omit<DevicePairRow, "id" | "createdAt" | "lastUsedAt" | "revokedAt">): Promise<DevicePairRow>;
  /** Revokes earlier live pairs of the same controller on the same Mac (re-pairing replaces). */
  revokeMatchingPairs(userId: string, deviceId: string, match: { deviceSessionId?: string; browserKeyHash?: string }, now: Date): Promise<void>;
  pairsForDevice(userId: string, deviceId: string): Promise<DevicePairRow[]>;
  pairsForController(userId: string, match: { deviceSessionId?: string; browserKeyHash?: string }): Promise<DevicePairRow[]>;
  pairById(userId: string, id: string): Promise<DevicePairRow | null>;
  revokePair(userId: string, id: string, now: Date): Promise<boolean>;
  activePair(userId: string, deviceId: string, match: { deviceSessionId?: string; browserKeyHash?: string }): Promise<DevicePairRow | null>;
  touchPair(userId: string, id: string, now: Date): Promise<void>;
}

// ── Rules ───────────────────────────────────────────────────────────────────

export type PairingError = { ok: false; status: number; code: string; message: string };
const fail = (status: number, code: string, message: string): PairingError => ({ ok: false, status, code, message });

/** Who is asking: a phone (its native sign-in) or a browser (its cookie key, if any). */
export type Controller =
  | { kind: "phone"; deviceSessionId: string }
  | { kind: "browser"; browserKey: string | null };

export interface CreatedOffer {
  ok: true;
  id: string;
  kind: PairingKind;
  token: string;
  url: string;
  /** Browsers: "ABCD-EFGH". */
  code?: string;
  expiresAt: string;
  deviceName: string;
}

export async function createPairingOffer(
  store: PairingStore,
  input: { userId: string; deviceId: string; kind: PairingKind; secret: string; appUrl: string; now?: Date; tokenId?: string },
): Promise<CreatedOffer | PairingError> {
  const now = input.now ?? new Date();
  const device = await store.device(input.userId, input.deviceId);
  if (!device) return fail(404, "not_found", "This Mac is not paired with your account.");
  const id = input.tokenId ?? `pt_${b64url(randomBytes(12))}`;
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  const token = signPairingToken({ tokenId: id, userId: input.userId, deviceId: device.id, kind: input.kind, expiresAt: expiresAt.getTime() }, input.secret);
  const code = input.kind === "browser" ? generatePairingCode() : null;
  await store.createToken({
    id,
    userId: input.userId,
    codeDeviceId: device.id,
    kind: input.kind,
    tokenHash: sha256(token),
    codeHash: code ? codeHashOf(code) : null,
    expiresAt,
    consumedAt: null,
    status: "pending",
    pairId: null,
  });
  return {
    ok: true,
    id,
    kind: input.kind,
    token,
    url: pairingUrl(input.appUrl, input.kind, token),
    ...(code ? { code: formatPairingCode(code) } : {}),
    expiresAt: expiresAt.toISOString(),
    deviceName: device.name,
  };
}

export type OfferRef = { token: string } | { code: string };

interface ResolvedOffer {
  row: PairingTokenRow;
  device: PairingDevice;
}

/**
 * Finds the live offer a controller names. A token from another account, a
 * forged or expired one, a used one, or one for the other kind of controller
 * are all refused here, before anything is shown.
 */
async function resolveOffer(
  store: PairingStore,
  userId: string,
  ref: OfferRef,
  controller: Controller,
  secret: string,
  now: Date,
): Promise<ResolvedOffer | PairingError> {
  let row: PairingTokenRow | null = null;
  if ("token" in ref) {
    const check = verifyPairingToken(ref.token, secret, now.getTime());
    if (!check.ok) {
      return check.reason === "expired"
        ? fail(410, "expired", "This code has expired. Show a new one on your Mac.")
        : fail(400, "invalid", "This is not an Alevr pairing code.");
    }
    // A token minted for another account is a miss, never a hint that it exists.
    if (check.claims.userId !== userId) return fail(404, "not_found", "Sign in to the same Alevr account as your Mac, then scan again.");
    row = await store.tokenByHash(userId, sha256(ref.token));
    if (row && row.id !== check.claims.tokenId) row = null;
  } else {
    const code = normalizePairingCode(ref.code);
    if (!code) return fail(400, "invalid", "Enter the 8-character code your Mac shows.");
    row = await store.tokenByCode(userId, codeHashOf(code), now);
  }
  if (!row || row.userId !== userId) return fail(404, "not_found", "Sign in to the same Alevr account as your Mac, then try again.");
  if (row.consumedAt || row.status !== "pending") return fail(409, "used", "This code was already used. Show a new one on your Mac.");
  if (row.expiresAt.getTime() <= now.getTime()) return fail(410, "expired", "This code has expired. Show a new one on your Mac.");
  if (row.kind !== controller.kind) {
    return row.kind === "phone"
      ? fail(400, "wrong_kind", "Scan this code with the Alevr app on your iPhone.")
      : fail(400, "wrong_kind", "This code is for a browser. Open the address your Mac shows on your computer.");
  }
  const device = await store.device(userId, row.codeDeviceId);
  if (!device) return fail(404, "not_found", "That Mac is no longer paired with your account.");
  return { row, device };
}

export interface OfferSummary {
  ok: true;
  id: string;
  kind: PairingKind;
  deviceId: string;
  deviceName: string;
  expiresAt: string;
}

/** What the approve screen shows, without consuming the offer. */
export async function inspectPairingOffer(
  store: PairingStore,
  input: { userId: string; ref: OfferRef; controller: Controller; secret: string; now?: Date },
): Promise<OfferSummary | PairingError> {
  const now = input.now ?? new Date();
  if (input.controller.kind === "phone" && !(await store.deviceSessionLive(input.userId, input.controller.deviceSessionId))) {
    return fail(401, "unauthenticated", "Sign in to Alevr on this iPhone first.");
  }
  const resolved = await resolveOffer(store, input.userId, input.ref, input.controller, input.secret, now);
  if (!("row" in resolved)) return resolved;
  return {
    ok: true,
    id: resolved.row.id,
    kind: resolved.row.kind,
    deviceId: resolved.device.id,
    deviceName: resolved.device.name,
    expiresAt: resolved.row.expiresAt.toISOString(),
  };
}

export interface ApprovedPair {
  ok: true;
  pair: PublicPair;
  /** Browsers: the cookie key to set (a fresh one when the browser had none). */
  browserKey?: string;
}

export interface PublicPair {
  id: string;
  kind: PairingKind;
  name: string;
  platform: string;
  deviceId: string;
  deviceName?: string;
  createdAt: string;
  lastUsedAt: string;
}

export const publicPair = (row: DevicePairRow, deviceName?: string): PublicPair => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  platform: row.platform,
  deviceId: row.codeDeviceId,
  ...(deviceName ? { deviceName } : {}),
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt.toISOString(),
});

/** Approves: consumes the offer exactly once and binds the pair to this controller. */
export async function approvePairingOffer(
  store: PairingStore,
  input: {
    userId: string;
    ref: OfferRef;
    controller: Controller;
    secret: string;
    /** Browsers: what the user agent says it is. Phones: ignored (the sign-in names it). */
    browser?: { name: string; platform: string };
    now?: Date;
  },
): Promise<ApprovedPair | PairingError> {
  const now = input.now ?? new Date();
  let phone: { name: string; platform: string } | null = null;
  if (input.controller.kind === "phone") {
    phone = await store.deviceSessionLive(input.userId, input.controller.deviceSessionId);
    if (!phone) return fail(401, "unauthenticated", "Sign in to Alevr on this iPhone first.");
  }
  const resolved = await resolveOffer(store, input.userId, input.ref, input.controller, input.secret, now);
  if (!("row" in resolved)) return resolved;
  if (!(await store.consumeToken(input.userId, resolved.row.id, "approved", now))) {
    return fail(409, "used", "This code was already used. Show a new one on your Mac.");
  }
  let browserKey: string | undefined;
  let match: { deviceSessionId?: string; browserKeyHash?: string };
  if (input.controller.kind === "phone") {
    match = { deviceSessionId: input.controller.deviceSessionId };
  } else {
    browserKey = input.controller.browserKey && input.controller.browserKey.length >= 32 ? input.controller.browserKey : b64url(randomBytes(32));
    match = { browserKeyHash: sha256(browserKey) };
  }
  await store.revokeMatchingPairs(input.userId, resolved.device.id, match, now);
  const identity = phone ?? input.browser ?? { name: "A browser", platform: "" };
  const pair = await store.createPair({
    userId: input.userId,
    codeDeviceId: resolved.device.id,
    kind: input.controller.kind,
    name: identity.name.slice(0, 120),
    platform: identity.platform.slice(0, 40),
    deviceSessionId: match.deviceSessionId ?? null,
    browserKeyHash: match.browserKeyHash ?? null,
  });
  await store.setTokenPair(input.userId, resolved.row.id, pair.id);
  return { ok: true, pair: publicPair(pair, resolved.device.name), ...(browserKey ? { browserKey } : {}) };
}

/** Denies: consumes the offer so it cannot be approved afterwards. */
export async function denyPairingOffer(
  store: PairingStore,
  input: { userId: string; ref: OfferRef; controller: Controller; secret: string; now?: Date },
): Promise<{ ok: true } | PairingError> {
  const now = input.now ?? new Date();
  const resolved = await resolveOffer(store, input.userId, input.ref, input.controller, input.secret, now);
  if (!("row" in resolved)) return resolved;
  if (!(await store.consumeToken(input.userId, resolved.row.id, "denied", now))) {
    return fail(409, "used", "This code was already used.");
  }
  return { ok: true };
}

export type OfferStatus = "pending" | "approved" | "denied" | "expired";

/** The Mac polls this to close its sheet once the phone answered. */
export async function pairingOfferStatus(
  store: PairingStore,
  input: { userId: string; tokenId: string; now?: Date },
): Promise<{ ok: true; status: OfferStatus; pair?: PublicPair } | PairingError> {
  const now = input.now ?? new Date();
  const row = await store.tokenById(input.userId, input.tokenId);
  if (!row) return fail(404, "not_found", "No such pairing.");
  if (row.status === "approved") {
    const pair = row.pairId ? await store.pairById(input.userId, row.pairId) : null;
    return { ok: true, status: "approved", ...(pair ? { pair: publicPair(pair) } : {}) };
  }
  if (row.status === "denied") return { ok: true, status: "denied" };
  return { ok: true, status: row.expiresAt.getTime() <= now.getTime() ? "expired" : "pending" };
}

/** The pairs a Mac lists (live only). */
export async function listPairsForDevice(store: PairingStore, userId: string, deviceId: string): Promise<PublicPair[] | PairingError> {
  const device = await store.device(userId, deviceId);
  if (!device) return fail(404, "not_found", "This Mac is not paired with your account.");
  const rows = await store.pairsForDevice(userId, deviceId);
  return rows.filter((r) => !r.revokedAt).map((r) => publicPair(r, device.name));
}

/** The Macs this phone or browser may control (live only). */
export async function listPairsForController(store: PairingStore, userId: string, controller: Controller): Promise<PublicPair[]> {
  const match = controllerMatch(controller);
  if (!match) return [];
  const rows = await store.pairsForController(userId, match);
  const out: PublicPair[] = [];
  for (const row of rows) {
    if (row.revokedAt) continue;
    const device = await store.device(userId, row.codeDeviceId);
    if (device) out.push(publicPair(row, device.name));
  }
  return out;
}

/** Revokes one pair. The Mac's owner or the controller itself may; both are the same account. */
export async function revokePair(store: PairingStore, input: { userId: string; pairId: string; now?: Date }): Promise<{ ok: true } | PairingError> {
  const row = await store.pairById(input.userId, input.pairId);
  if (!row || row.userId !== input.userId) return fail(404, "not_found", "No such paired device.");
  await store.revokePair(input.userId, row.id, input.now ?? new Date());
  return { ok: true };
}

export function controllerMatch(controller: Controller): { deviceSessionId?: string; browserKeyHash?: string } | null {
  if (controller.kind === "phone") return controller.deviceSessionId ? { deviceSessionId: controller.deviceSessionId } : null;
  return controller.browserKey ? { browserKeyHash: sha256(controller.browserKey) } : null;
}

export const NOT_PAIRED_MESSAGE =
  "This device is not allowed to control that Mac. On the Mac, open Alevr › Settings › Connections › Control this Mac remotely, and pair it.";

/**
 * The check every remote command passes (on top of owning the Mac): a live
 * pair between this controller and this Mac. A phone's pair also dies with
 * its native sign-in.
 */
export async function checkRemotePair(
  store: PairingStore,
  input: { userId: string; deviceId: string; controller: Controller; now?: Date },
): Promise<{ ok: true; pair: DevicePairRow } | PairingError> {
  const match = controllerMatch(input.controller);
  if (!match) return fail(403, "not_paired", NOT_PAIRED_MESSAGE);
  if (input.controller.kind === "phone" && !(await store.deviceSessionLive(input.userId, input.controller.deviceSessionId))) {
    return fail(403, "not_paired", NOT_PAIRED_MESSAGE);
  }
  const pair = await store.activePair(input.userId, input.deviceId, match);
  if (!pair || pair.revokedAt || pair.userId !== input.userId || pair.codeDeviceId !== input.deviceId) {
    return fail(403, "not_paired", NOT_PAIRED_MESSAGE);
  }
  // Recorded lazily: a minute's precision is plenty for "last used", and the
  // relay should not write a row on every long-poll.
  if (Date.now() - pair.lastUsedAt.getTime() > 60_000) void store.touchPair(input.userId, pair.id, input.now ?? new Date()).catch(() => undefined);
  return { ok: true, pair };
}

/** Reads the browser's pairing key out of a Cookie header. */
export function browserKeyFromCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === REMOTE_BROWSER_COOKIE) {
      const value = rest.join("=");
      return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
    }
  }
  return null;
}
