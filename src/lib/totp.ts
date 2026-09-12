import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * RFC 6238 TOTP (and the RFC 4226 HOTP it is built on), implemented directly
 * over node:crypto rather than pulled in as a dependency.
 *
 * Two-step verification is the one place in this product where a subtle bug is
 * invisible until it locks a real person out of their account: a code that is
 * wrong one time in ten, or right only on even minutes, looks exactly like a
 * user mistyping. So the algorithm here is deliberately literal — the shift
 * widths, the big-endian counter, the modulo — and `scripts/test-totp.ts`
 * checks it against the published RFC 6238 and RFC 4226 vectors, including the
 * SHA-256 and SHA-512 ones, which is what proves the dynamic truncation and the
 * counter packing are right rather than accidentally right for SHA-1 alone.
 *
 * No secret is ever logged from this module, and no error message quotes one.
 */

/** RFC 4648 base32 alphabet. Authenticator apps accept nothing else. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";

export interface TotpOptions {
  /** Time step in seconds. RFC 6238 recommends, and every app assumes, 30. */
  stepSec?: number;
  /** Code length. 6 everywhere in production; the RFC vectors use 8. */
  digits?: number;
  /** HMAC hash. SHA-1 in production — it is what authenticator apps implement. */
  algorithm?: TotpAlgorithm;
  /** T0, the epoch the counter is measured from, in seconds. RFC 6238: 0. */
  t0Sec?: number;
}

const DEFAULTS: Required<TotpOptions> = {
  stepSec: 30,
  digits: 6,
  algorithm: "sha1",
  t0Sec: 0,
};

/** Encode bytes as RFC 4648 base32 with `=` padding. */
export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Left-align whatever is left over into a final 5-bit group.
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += "=";
  return out;
}

/**
 * Decode RFC 4648 base32.
 *
 * Lenient about what a human (or an authenticator app's export) actually
 * produces — lowercase, spaces between groups, missing padding are all
 * accepted — because a secret is routinely copied by hand. Anything outside
 * the alphabet is a hard error rather than a silently different key: a secret
 * that decodes to the wrong bytes generates plausible-looking codes that never
 * match, which is the worst possible failure to debug.
 */
export function base32Decode(encoded: string): Buffer {
  const normalized = encoded.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 character in secret.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * A new shared secret, base32-encoded.
 *
 * 20 bytes = 160 bits, the RFC 4226 recommendation and the size every
 * authenticator app is known to handle; 32 bytes trips older hardware tokens.
 */
export function generateSecret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength));
}

/** Pack a counter as the 8-byte big-endian value HMAC is taken over. */
function counterBuffer(counter: number): Buffer {
  const buf = Buffer.alloc(8);
  // Split rather than writeBigUInt64BE so the value stays an ordinary number:
  // counters are small (2^31 steps is the year 4000) but the high word must
  // still be written, because the RFC vectors include T = 20000000000.
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  return buf;
}

/** RFC 4226 HOTP over a raw key. Exported so the HOTP vectors can be tested. */
export function hotp(key: Buffer, counter: number, options: TotpOptions = {}): string {
  const { digits, algorithm } = { ...DEFAULTS, ...options };
  const mac = createHmac(algorithm, key).update(counterBuffer(counter)).digest();
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte picks
  // the offset, and the high bit of the first selected byte is masked off so
  // the result is a positive 31-bit integer on every platform.
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The counter (number of elapsed steps) a given instant falls in. */
export function totpCounter(atMs: number, options: TotpOptions = {}): number {
  const { stepSec, t0Sec } = { ...DEFAULTS, ...options };
  return Math.floor(Math.floor(atMs / 1000 - t0Sec) / stepSec);
}

/**
 * The code for `secret` at `atMs` (epoch **milliseconds**, defaulting to now).
 *
 * Milliseconds, not seconds, so that `totp(secret)` and `totp(secret, Date.now())`
 * mean the same thing — the RFC states its vectors in seconds, and the test
 * converts once rather than every caller converting forever.
 */
export function totp(secret: string, atMs: number = Date.now(), options: TotpOptions = {}): string {
  return hotp(base32Decode(secret), totpCounter(atMs, options), options);
}

export interface VerifyTotpOptions extends TotpOptions {
  /**
   * How many steps either side of now are accepted. 1 (±30s) absorbs clock
   * drift and the seconds a person spends typing; larger widens the window an
   * attacker gets for free, so this is not raised without a reason.
   */
  window?: number;
  /** Instant to verify against, epoch milliseconds. Defaults to now. */
  atMs?: number;
}

/** Constant-time compare of two same-length ASCII strings. */
function timingSafeStringEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify a submitted code against the secret.
 *
 * Every candidate in the window is compared, and the comparisons are ORed
 * rather than short-circuited, so the time this takes does not depend on which
 * step matched (or on whether any did). The submitted code's *shape* is checked
 * first and cheaply — that leaks nothing about the secret, only about what the
 * user typed.
 */
export function verifyTotp(secret: string, code: string, options: VerifyTotpOptions = {}): boolean {
  const { digits, window, atMs } = { ...DEFAULTS, window: 1, atMs: Date.now(), ...options };
  const submitted = code.replace(/\s/g, "");
  if (submitted.length !== digits || !/^\d+$/.test(submitted)) return false;

  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const centre = totpCounter(atMs, options);
  let matched = false;
  for (let drift = -window; drift <= window; drift += 1) {
    const counter = centre + drift;
    if (counter < 0) continue;
    // Bitwise-free OR into a boolean, but deliberately without `||`: every
    // candidate is always compared, so the loop's duration is independent of
    // where (or whether) the match is.
    matched = timingSafeStringEquals(hotp(key, counter, options), submitted) || matched;
  }
  return matched;
}

export interface OtpauthUrlInput {
  secret: string;
  /** The account label — the user's email address. */
  account: string;
  /** The issuer label shown above it in the authenticator app. */
  issuer: string;
  digits?: number;
  stepSec?: number;
  algorithm?: TotpAlgorithm;
}

/**
 * The `otpauth://` URL an authenticator app scans.
 *
 * The issuer appears twice — once as a label prefix, once as a parameter —
 * because apps split on which one they read, and an app that reads neither
 * shows the user an unlabelled six-digit code they cannot match to a service.
 */
export function otpauthUrl(input: OtpauthUrlInput): string {
  const { secret, account, issuer } = input;
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secret.replace(/=+$/, ""),
    issuer,
    algorithm: (input.algorithm ?? DEFAULTS.algorithm).toUpperCase(),
    digits: String(input.digits ?? DEFAULTS.digits),
    period: String(input.stepSec ?? DEFAULTS.stepSec),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
