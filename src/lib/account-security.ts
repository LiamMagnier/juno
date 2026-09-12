import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { decryptMessageText, encryptMessageText } from "@/lib/message-crypto";
import { generateSecret, otpauthUrl, verifyTotp } from "@/lib/totp";

/*
 * The server side of account security: two-step verification, single-use
 * recovery codes, and the tokens that prove someone owns an email address.
 *
 * Kept out of the route handlers because all three are used from more than one
 * place — enrolment from Settings, the second factor from the Credentials
 * provider AND from the pre-flight challenge, verification tokens from
 * registration, resend, and the change-email flow — and because the rules
 * about what is stored (never a raw secret, never a raw code, never a raw
 * token) are easier to hold to in one file than in eight.
 */

// ----------------------------------------------------------------------------
// TOTP secrets
// ----------------------------------------------------------------------------

/** The label an authenticator app shows above the code. */
const TOTP_ISSUER = "Juno";

/**
 * Secrets are sealed with the message keyring rather than stored in the clear.
 *
 * A second factor whose secret sits in plaintext next to the password hash is
 * not a second factor against anyone who has the database — they can mint
 * valid codes indefinitely, and unlike a password the user has no way to know
 * or to change it quickly. The keyring is already the product's answer to
 * "readable database", is versioned, and is rotatable, so it is the right one
 * here too.
 */
function sealSecret(secret: string): string {
  return encryptMessageText(secret);
}

function openSecret(sealed: string): string {
  return decryptMessageText(sealed);
}

// ----------------------------------------------------------------------------
// Recovery codes
// ----------------------------------------------------------------------------

/** No I, O, 0 or 1: these are read off a screen and typed back by hand. */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_LENGTH = 10;
export const RECOVERY_CODE_COUNT = 10;

/** One code, formatted as the user sees it. 50 bits of entropy. */
function generateRecoveryCode(): string {
  // 256 is an exact multiple of 32, so `byte % 32` is uniform over the
  // alphabet — no rejection sampling and no modulo bias.
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Strip the formatting a person might or might not type back. */
function normalizeRecoveryCode(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Recovery codes are digested with plain SHA-256, not bcrypt.
 *
 * They are 50 bits of machine-generated randomness, so there is no dictionary
 * to slow an attacker down to — the entropy does the work a KDF would
 * otherwise have to. A fast digest also keeps the sign-in path fast when ten
 * candidate rows have to be checked.
 */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code), "utf8").digest("hex");
}

// ----------------------------------------------------------------------------
// Status
// ----------------------------------------------------------------------------

export interface MfaStatus {
  /** Two-step verification is on and enforced. */
  enabled: boolean;
  /** An enrolment has been started (QR shown) but no code proved yet. */
  pending: boolean;
  enabledAt: Date | null;
  /** Unused recovery codes left. Zero while enabled is worth telling someone. */
  recoveryCodesRemaining: number;
}

export async function getMfaStatus(userId: string): Promise<MfaStatus> {
  const [user, remaining] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { totpSecret: true, totpEnabledAt: true },
    }),
    prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
  ]);
  return {
    enabled: Boolean(user?.totpEnabledAt),
    pending: Boolean(user?.totpSecret) && !user?.totpEnabledAt,
    enabledAt: user?.totpEnabledAt ?? null,
    recoveryCodesRemaining: remaining,
  };
}

/** Whether the account must present a second factor to sign in. */
export async function isTotpEnabled(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } });
  return Boolean(user?.totpEnabledAt);
}

// ----------------------------------------------------------------------------
// Enrolment
// ----------------------------------------------------------------------------

export interface TotpEnrolment {
  /** Shown so a device without a camera can be set up by typing. */
  secret: string;
  otpauthUrl: string;
}

/**
 * Begin enrolment: mint a secret, store it sealed, and hand back what the
 * authenticator app needs.
 *
 * Nothing is enforced yet — `totpEnabledAt` stays null until a code proves the
 * user actually scanned it. Starting again replaces the pending secret, so an
 * abandoned QR code can never be completed later by whoever saw it.
 */
export async function startTotpEnrolment(userId: string, email: string): Promise<TotpEnrolment> {
  const secret = generateSecret();
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: sealSecret(secret), totpEnabledAt: null },
  });
  return {
    secret,
    otpauthUrl: otpauthUrl({ secret, account: email, issuer: TOTP_ISSUER }),
  };
}

export type ConfirmTotpResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: "no_pending_enrolment" | "already_enabled" | "invalid_code" };

/**
 * Finish enrolment with a first valid code, and issue the recovery codes.
 *
 * The codes are returned exactly once, here, and only their digests are kept —
 * so "show them again" is not a feature that can exist, which is the point.
 */
export async function confirmTotpEnrolment(userId: string, code: string): Promise<ConfirmTotpResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecret: true, totpEnabledAt: true },
  });
  if (user?.totpEnabledAt) return { ok: false, reason: "already_enabled" };
  if (!user?.totpSecret) return { ok: false, reason: "no_pending_enrolment" };
  if (!verifyTotp(openSecret(user.totpSecret), code, { window: 1 })) {
    return { ok: false, reason: "invalid_code" };
  }

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await prisma.$transaction([
    // Any codes from a previous enrolment are dead the moment a new one
    // completes — otherwise turning two-step off and on again would leave the
    // old sheet of paper working.
    prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date() } }),
    prisma.mfaRecoveryCode.createMany({
      data: recoveryCodes.map((value) => ({ userId, codeHash: hashRecoveryCode(value) })),
    }),
  ]);
  return { ok: true, recoveryCodes };
}

export type DisableTotpResult = { ok: true } | { ok: false; reason: "not_enabled" | "invalid_code" };

/**
 * Turn two-step verification off, but only for someone holding a current code
 * or an unused recovery code.
 *
 * Session possession alone is not enough: an attacker who has stolen a session
 * cookie could otherwise remove the very control that would have stopped them
 * signing in again later.
 */
export async function disableTotp(userId: string, code: string): Promise<DisableTotpResult> {
  const enabled = await isTotpEnabled(userId);
  if (!enabled) return { ok: false, reason: "not_enabled" };
  const factor = await verifySecondFactor(userId, code);
  if (!factor) return { ok: false, reason: "invalid_code" };
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { totpSecret: null, totpEnabledAt: null } }),
    prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
  ]);
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Second-factor verification (sign-in and re-authentication)
// ----------------------------------------------------------------------------

export type SecondFactorKind = "totp" | "recovery";

/**
 * Verify a submitted second factor, consuming a recovery code if that is what
 * it was. Returns which kind matched, or null.
 *
 * Recovery codes are single-use: the consuming update is a conditional
 * `updateMany` on `usedAt: null`, so two simultaneous submissions of the same
 * code cannot both succeed.
 */
export async function verifySecondFactor(
  userId: string,
  code: string
): Promise<SecondFactorKind | null> {
  const submitted = code.trim();
  if (!submitted) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecret: true, totpEnabledAt: true },
  });
  if (!user?.totpEnabledAt || !user.totpSecret) return null;

  if (/^\d{6}$/.test(submitted.replace(/\s/g, ""))) {
    let secret: string;
    try {
      secret = openSecret(user.totpSecret);
    } catch {
      // An unreadable secret (key rotated away) must fail closed rather than
      // throw out of the sign-in path. The recovery codes still work.
      return null;
    }
    if (verifyTotp(secret, submitted, { window: 1 })) return "totp";
    // Fall through: a six-digit string is a plausible recovery code shape in
    // some other product, but never in ours, so there is nothing more to try.
    return null;
  }

  const codeHash = hashRecoveryCode(submitted);
  const match = await prisma.mfaRecoveryCode.findFirst({
    where: { userId, codeHash, usedAt: null },
    select: { id: true },
  });
  if (!match) return null;
  const consumed = await prisma.mfaRecoveryCode.updateMany({
    where: { id: match.id, userId, usedAt: null },
    data: { usedAt: new Date() },
  });
  return consumed.count === 1 ? "recovery" : null;
}

// ----------------------------------------------------------------------------
// Email verification tokens
// ----------------------------------------------------------------------------

/** 24 hours, as the product promises in the mail. */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const VERIFY_PREFIX = "email-verify:";
const CHANGE_PREFIX = "email-change:";

export type EmailTokenPurpose = "verify" | "change";

/**
 * The `VerificationToken.identifier` encodes purpose, user and target address.
 *
 * The address is part of the identifier, not looked up later, because a
 * change-email link must verify the address it was *sent to*. Without that, a
 * user who requested a change to one address and then to another could consume
 * the first link and land on the second address.
 */
function identifierFor(purpose: EmailTokenPurpose, userId: string, email: string): string {
  return `${purpose === "verify" ? VERIFY_PREFIX : CHANGE_PREFIX}${userId}:${email.toLowerCase()}`;
}

function parseIdentifier(
  identifier: string
): { purpose: EmailTokenPurpose; userId: string; email: string } | null {
  const purpose: EmailTokenPurpose | null = identifier.startsWith(VERIFY_PREFIX)
    ? "verify"
    : identifier.startsWith(CHANGE_PREFIX)
      ? "change"
      : null;
  if (!purpose) return null;
  const rest = identifier.slice((purpose === "verify" ? VERIFY_PREFIX : CHANGE_PREFIX).length);
  const split = rest.indexOf(":");
  if (split <= 0) return null;
  const userId = rest.slice(0, split);
  const email = rest.slice(split + 1);
  if (!userId || !email) return null;
  return { purpose, userId, email };
}

/** The secret that goes in the link. Only its digest is persisted. */
export function createEmailToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashEmailToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Issue a verification link token, invalidating any earlier one for the same
 * purpose and user so only the newest mail works.
 */
export async function issueEmailToken(
  purpose: EmailTokenPurpose,
  userId: string,
  email: string
): Promise<string> {
  const token = createEmailToken();
  const identifier = identifierFor(purpose, userId, email);
  const prefix = purpose === "verify" ? VERIFY_PREFIX : CHANGE_PREFIX;
  await prisma.$transaction([
    // Every pending link of this purpose for this user, not just this address:
    // requesting a change to a new address must kill the link to the old one.
    prisma.verificationToken.deleteMany({
      where: { identifier: { startsWith: `${prefix}${userId}:` } },
    }),
    prisma.verificationToken.create({
      data: { identifier, token: hashEmailToken(token), expires: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS) },
    }),
  ]);
  return token;
}

export type ConsumeEmailTokenResult =
  | { ok: true; purpose: EmailTokenPurpose; userId: string; email: string }
  | { ok: false; reason: "invalid" | "expired" };

/**
 * Consume a verification token exactly once and apply it.
 *
 * The delete is inside the transaction and conditional on the token still
 * existing and still being live, so two clicks on the same link (a mail client
 * prefetching it, then the human) cannot both apply — the second gets
 * `invalid`, which the route renders as "already verified" rather than an
 * error, because from the user's point of view it worked.
 */
export async function consumeEmailToken(token: string): Promise<ConsumeEmailTokenResult> {
  const tokenHash = hashEmailToken(token);
  const row = await prisma.verificationToken.findUnique({ where: { token: tokenHash } });
  const parsed = row ? parseIdentifier(row.identifier) : null;
  if (!row || !parsed) return { ok: false, reason: "invalid" };
  if (row.expires <= new Date()) {
    await prisma.verificationToken.deleteMany({ where: { token: tokenHash } });
    return { ok: false, reason: "expired" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const consumed = await tx.verificationToken.deleteMany({
        where: { token: tokenHash, identifier: row.identifier, expires: { gt: new Date() } },
      });
      if (consumed.count !== 1) throw new Error("EMAIL_TOKEN_ALREADY_CONSUMED");

      if (parsed.purpose === "change") {
        // The address is only written here, at the moment it is proved. A
        // change request that is never confirmed leaves the account untouched.
        await tx.user.update({
          where: { id: parsed.userId },
          data: { email: parsed.email, emailVerified: new Date() },
        });
      } else {
        await tx.user.update({
          where: { id: parsed.userId },
          data: { emailVerified: new Date() },
        });
      }
    });
  } catch {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, ...parsed };
}

/**
 * Mark an address verified without a round trip.
 *
 * Used for OAuth and magic-link sign-ups, where the provider has already
 * proved the address, and for deployments with no mail configured at all —
 * see `src/app/api/auth/register/route.ts` for why that case must not leave a
 * fresh checkout unable to spend.
 */
export async function markEmailVerified(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { emailVerified: new Date() } });
}

// ----------------------------------------------------------------------------
// Session invalidation
// ----------------------------------------------------------------------------

/**
 * Invalidate every session for the account, including this one.
 *
 * `sessionVersion` rides in the JWT and is re-checked on every session read
 * (src/lib/auth.ts), so bumping it is what "sign out everywhere" actually
 * means for a stateless session. The `Session` rows are swept too so a later
 * switch to database sessions cannot resurrect anything.
 *
 * Native clients do not carry that JWT — they hold their own bearer
 * credentials — so they are revoked by the same act rather than left as the
 * one place the word "everywhere" was not true. A revoked device session fails
 * closed on the next bearer authentication with no grace period, and its
 * refresh tokens are killed in the same transaction so the app cannot rotate
 * its way back in.
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const devices = await prisma.nativeDeviceSession.findMany({
    where: { userId, revokedAt: null },
    select: { id: true },
  });
  const deviceIds = devices.map((device) => device.id);
  const revokedAt = new Date();

  const [user] = await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    }),
    prisma.session.deleteMany({ where: { userId } }),
    prisma.nativeDeviceSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt, revocationReason: "user_revoked_all" },
    }),
    prisma.nativeRefreshToken.updateMany({
      where: { deviceSessionId: { in: deviceIds }, revokedAt: null },
      data: { revokedAt },
    }),
  ]);
  return user.sessionVersion;
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

/** Constant-time compare for two strings of any length. */
export function constantTimeEquals(a: string, b: string): boolean {
  // Digest first so the comparison is always over 32 bytes: timingSafeEqual
  // throws on a length mismatch, and branching on length would itself leak.
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * Spend a little time doing nothing, so an early return is not visible.
 *
 * The MFA pre-flight answers before any password work on some paths; without
 * this, "no such account" is measurably faster than "wrong password", which is
 * exactly the oracle the sign-in path already goes to lengths to avoid.
 */
export async function equalizeResponseTime(startedAt: number, minimumMs: number): Promise<void> {
  const remaining = minimumMs - (Date.now() - startedAt) + randomInt(0, 25);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}
