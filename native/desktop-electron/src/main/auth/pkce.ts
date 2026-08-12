/**
 * PKCE primitives for the Juno native authorization flow.
 *
 * Pure by construction: this module performs no I/O, touches no Electron API,
 * reads no configuration and keeps no state. Everything it exports is a
 * function of its arguments (plus a CSPRNG that can be injected), which is what
 * makes the security-critical parts — challenge derivation and the `state`
 * comparison — testable without a browser, a server or a keychain.
 *
 * ## What the Juno backend actually requires
 *
 * This is *not* generic RFC 7636. The server's validator
 * (`src/lib/native-auth-core.ts`) is stricter than the RFC in two ways that
 * matter, and a generically-correct client fails against it:
 *
 *   1. `code_verifier`, `state`, `nonce` and `code_challenge` must all match
 *      `^[A-Za-z0-9_-]{43,256}$` — **base64url only**. RFC 7636 also permits
 *      `.` and `~` in a verifier; the Juno backend rejects both. Everything
 *      generated here is base64url, which satisfies the RFC *and* the server.
 *   2. `code_challenge_method` must be exactly `S256`. `plain` is rejected, so
 *      there is no downgrade path to guard against — but also no fallback.
 *
 * Thirty-two random bytes base64url-encode to exactly 43 characters, which is
 * simultaneously the RFC 7636 minimum verifier length and the server's minimum.
 * That is why the byte count below is 32 and not something rounder.
 */

import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The one method the backend accepts. Exported so callers build the authorize
 * URL from the same constant the challenge is derived with, rather than from a
 * string literal that could drift.
 */
export const CODE_CHALLENGE_METHOD = 'S256' as const;

/**
 * 32 bytes → 43 base64url characters. Both the RFC minimum and the server's.
 * Larger would also validate; there is no security argument for it, and a
 * longer verifier only makes the authorize URL longer.
 */
export const SECRET_BYTES = 32;

/**
 * The server's shared shape for `state`, `nonce`, `code_challenge` and
 * `code_verifier`. Kept as one regex because it *is* one regex on the server —
 * duplicating it as four subtly different local rules is how a client ends up
 * generating something the server silently refuses.
 */
const BASE64URL_43_256 = /^[A-Za-z0-9_-]{43,256}$/;

/** `^[A-Za-z0-9._:-]{16,200}$` on the server. Note `_` and `:` are permitted. */
const INSTALLATION_ID = /^[A-Za-z0-9._:-]{16,200}$/;

/** The authorization code is server-generated base64url; bound before we send it back. */
const AUTHORIZATION_CODE = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * Injectable entropy source. The default is `node:crypto`'s CSPRNG.
 *
 * The seam exists for tests only. There is no configuration path that reaches
 * it, deliberately: a "random source" that can be set from a config file is a
 * backdoor with a polite name.
 */
export type RandomByteSource = (size: number) => Buffer;

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/**
 * A fresh PKCE `code_verifier`.
 *
 * @throws if the injected source returns the wrong number of bytes — a short
 * read from a CSPRNG is not something to paper over with a retry loop.
 */
export function createCodeVerifier(random: RandomByteSource = nodeRandomBytes): string {
  const verifier = base64url(requireBytes(random, SECRET_BYTES));
  /* Belt and braces: the encoding above cannot produce a non-conforming value,
     so this only ever fires for an injected source that lied about its length.
     It is cheap and it turns a subtle server-side rejection into a local one. */
  if (!isValidCodeVerifier(verifier)) {
    throw new PkceError('The generated code verifier does not satisfy the Juno contract.');
  }
  return verifier;
}

/**
 * S256: `base64url(SHA-256(ASCII(verifier)))`.
 *
 * Deterministic and verifier-sensitive — the two properties
 * `tests/native-auth-core.test.ts` pins on the server side, which is what makes
 * this the client half of the same pair.
 */
export function deriveCodeChallenge(verifier: string): string {
  if (!isValidCodeVerifier(verifier)) {
    throw new PkceError('Refusing to derive a challenge from a malformed code verifier.');
  }
  return base64url(createHash('sha256').update(verifier, 'utf8').digest());
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: typeof CODE_CHALLENGE_METHOD;
}

/** A verifier and its challenge, generated together so they cannot be mismatched. */
export function createPkcePair(random: RandomByteSource = nodeRandomBytes): PkcePair {
  const verifier = createCodeVerifier(random);
  return { verifier, challenge: deriveCodeChallenge(verifier), method: CODE_CHALLENGE_METHOD };
}

/**
 * `state` / `nonce` material.
 *
 * The server checks these for *entropy shape*, not just presence — a `state` of
 * `"predictable"` is rejected outright — so they are generated the same way the
 * verifier is rather than from a counter or a UUID.
 */
export function createCorrelationValue(random: RandomByteSource = nodeRandomBytes): string {
  const value = base64url(requireBytes(random, SECRET_BYTES));
  if (!isValidCorrelationValue(value)) {
    throw new PkceError('The generated correlation value does not satisfy the Juno contract.');
  }
  return value;
}

/**
 * A stable per-installation identifier.
 *
 * The server hashes this and binds the authorization code to it, so a code
 * issued for one installation cannot be redeemed by another. It is *not* a
 * secret — it identifies the install, not the user — but it is generated with
 * the same CSPRNG because a guessable value would weaken that binding to
 * nothing.
 */
export function createInstallationId(random: RandomByteSource = nodeRandomBytes): string {
  const value = base64url(requireBytes(random, SECRET_BYTES));
  if (!isValidInstallationId(value)) {
    throw new PkceError('The generated installation id does not satisfy the Juno contract.');
  }
  return value;
}

export function isValidCodeVerifier(value: string): boolean {
  return BASE64URL_43_256.test(value);
}

export function isValidCodeChallenge(value: string): boolean {
  return BASE64URL_43_256.test(value);
}

export function isValidCorrelationValue(value: string): boolean {
  return BASE64URL_43_256.test(value);
}

export function isValidInstallationId(value: string): boolean {
  return INSTALLATION_ID.test(value);
}

export function isValidAuthorizationCode(value: string): boolean {
  return AUTHORIZATION_CODE.test(value);
}

/**
 * Constant-time string equality, used for the `state` and `nonce` checks.
 *
 * Compares SHA-256 digests rather than the strings themselves. That is not
 * ceremony: `timingSafeEqual` throws on a length mismatch, so a direct
 * comparison needs a length check first, and *that* check is an early exit
 * which leaks the length of the expected value. Digests are always 32 bytes, so
 * the comparison is uniform in time for any pair of inputs, including inputs of
 * different lengths.
 *
 * The digests also mean an attacker who can time this learns nothing about the
 * expected value's prefix — a digest of a near-miss shares no structure with
 * the digest of a hit.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Thrown for malformed PKCE material. Never carries the material itself. */
export class PkceError extends Error {
  override readonly name = 'PkceError';
}

function requireBytes(random: RandomByteSource, size: number): Buffer {
  const bytes = random(size);
  if (!Buffer.isBuffer(bytes) || bytes.length !== size) {
    throw new PkceError(`The random source returned ${String(bytes?.length)} bytes, expected ${size}.`);
  }
  return bytes;
}
