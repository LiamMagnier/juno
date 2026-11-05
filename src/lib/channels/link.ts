/**
 * Linking a phone number to an account, proved by a code sent over iMessage.
 *
 * The number becomes the account's only when somebody holding that phone
 * reads the code back. Until then the row is `pending` and stands for
 * nothing: the webhook ignores pending numbers, and a second person starting
 * a link for the same number simply replaces the pending row (the code goes
 * to the phone, so only its holder can finish). A `verified` row is never
 * replaced from another account; that account has to unlink it first.
 *
 * What is stored, and what is not:
 *   - `phoneHash`: an HMAC of the E.164 number, for the webhook's lookup;
 *   - `phone`: the number itself, encrypted (only ever decrypted to send);
 *   - `codeHash`: an HMAC of the code bound to the account and the number,
 *     never the code. It is cleared once the link is verified.
 *
 * Bounded: five codes an hour per account and three per number (a code is a
 * text somebody else's phone receives, so this is also what stops the form
 * being used to pester a stranger), five tries per code, ten minutes per code.
 *
 * Pure: every effect is a `LinkDeps` call, so tests/imessage-channel.test.ts
 * runs the whole flow with a fake provider and an in-memory table.
 */

import { normalizePhone } from "@/lib/channels/phone";
import type { ChannelProvider, ChannelProviderId } from "@/lib/channels/types";

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const LINK_CODE_MAX_ATTEMPTS = 5;
export const LINK_START_LIMIT_PER_ACCOUNT = 5;
export const LINK_START_LIMIT_PER_NUMBER = 3;
export const LINK_VERIFY_LIMIT = 10;

/** HMAC domains (`domainMac`). A value hashed in one never matches another. */
export const PHONE_HASH_DOMAIN = "juno.channel.phone.v1";
export const CODE_HASH_DOMAIN = "juno.channel.code.v1";
export const HANDLE_HASH_DOMAIN = "juno.channel.handle.v1";

export const LINK_TEXT_COPY = {
  code: (code: string, product: string) =>
    `${code} is your ${product} code to link this number. It expires in 10 minutes. If you did not ask for it, ignore this text.`,
  linked: (product: string) =>
    `This number is linked to ${product}. Text here to reach your agents, and start with @Name to pick one. Approvals are never given by text.`,
} as const;

export interface ChannelLinkRow {
  id: string;
  userId: string;
  provider: string;
  phoneHash: string;
  /** Encrypted. */
  phone: string;
  status: string;
  codeHash: string | null;
  codeExpiresAt: Date | null;
  codeAttempts: number;
  verifiedAt: Date | null;
  defaultAgentId: string | null;
}

export interface LinkDeps {
  provider: ChannelProvider;
  productName: string;
  now(): Date;
  /** Six random digits, from a CSPRNG. */
  newCode(): string;
  mac(domain: string, value: string): string;
  macEquals(a: string, b: string): boolean;
  encryptPhone(phone: string): string;
  /** The number back, or null when the row cannot be decrypted. */
  decryptPhone(stored: string): string | null;
  /** true while under the limit. */
  rateLimit(key: string, limit: number, windowSec: number): Promise<boolean>;
  /** The row for this number, whoever's it is (the one cross-account read). */
  findByPhoneHash(provider: ChannelProviderId, phoneHash: string): Promise<ChannelLinkRow | null>;
  /**
   * Writes a pending row for this account and number, replacing a pending row
   * for the number (anyone's) and this account's other pending rows. Never
   * replaces a verified row: false when one is there (a race with a verify).
   */
  writePending(input: {
    userId: string;
    provider: ChannelProviderId;
    phoneHash: string;
    phone: string;
    codeHash: string;
    codeExpiresAt: Date;
    defaultAgentId: string | null;
  }): Promise<ChannelLinkRow | null>;
  findPending(userId: string, provider: ChannelProviderId): Promise<ChannelLinkRow | null>;
  /** One more try, atomically, only while under `max`. false when the tries are spent. */
  spendAttempt(userId: string, linkId: string, max: number): Promise<boolean>;
  /** pending to verified, clearing the code; false when it was not pending any more. */
  markVerified(userId: string, linkId: string, at: Date): Promise<boolean>;
  /** Removes this account's other links on the provider (a new number replaces the old one). */
  removeOtherLinks(userId: string, provider: ChannelProviderId, keepId: string): Promise<void>;
  deleteLink(userId: string, linkId: string): Promise<void>;
}

export type LinkOutcome =
  | { status: 200; body: { status: "pending"; expiresAt: string } | { status: "verified" } }
  | { status: 400 | 404 | 410 | 429 | 502; body: { error: string; message: string } };

export const LINK_ERROR_MESSAGE = {
  invalid_phone: "Enter the number with its country code, like +1 415 555 0100.",
  rate_limited: "That is a lot of codes at once. Try again in an hour.",
  send_failed: "The code could not be sent. Check the number can receive iMessage, then try again.",
  invalid_code: "Enter the six digits from the text.",
  no_pending: "There is no code waiting. Send a new one.",
  code_expired: "That code has expired. Send a new one.",
  too_many_attempts: "Too many wrong codes. Send a new one.",
  wrong_code: "That code is not right. Check the text and try again.",
  verify_rate_limited: "Too many tries. Wait a few minutes, then try again.",
} as const;

function refuse(status: 400 | 404 | 410 | 429 | 502, error: keyof typeof LINK_ERROR_MESSAGE): LinkOutcome {
  return { status, body: { error, message: LINK_ERROR_MESSAGE[error] } };
}

export function phoneHashOf(deps: Pick<LinkDeps, "mac">, phone: string): string {
  return deps.mac(PHONE_HASH_DOMAIN, phone);
}

/** The code's HMAC, bound to the account and the number, so a code is good for exactly one pair. */
export function codeHashOf(deps: Pick<LinkDeps, "mac">, userId: string, phoneHash: string, code: string): string {
  return deps.mac(CODE_HASH_DOMAIN, `${userId}\n${phoneHash}\n${code}`);
}

/**
 * Starts a link: checks the number, writes the pending row and texts the code.
 *
 * A number already verified on another account answers exactly as a fresh
 * start does, and sends nothing: the form must not tell anyone which numbers
 * have an account here.
 */
export async function startLink(
  userId: string,
  input: { phone: unknown; defaultAgentId?: string | null },
  deps: LinkDeps
): Promise<LinkOutcome> {
  const phone = normalizePhone(input.phone);
  if (!phone) return refuse(400, "invalid_phone");
  const phoneHash = phoneHashOf(deps, phone);
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);
  const pendingBody = { status: "pending" as const, expiresAt: expiresAt.toISOString() };

  if (!(await deps.rateLimit(`channel:link:${userId}`, LINK_START_LIMIT_PER_ACCOUNT, 3600))) return refuse(429, "rate_limited");
  if (!(await deps.rateLimit(`channel:link-number:${phoneHash}`, LINK_START_LIMIT_PER_NUMBER, 3600))) return refuse(429, "rate_limited");

  const existing = await deps.findByPhoneHash(deps.provider.id, phoneHash);
  if (existing?.status === "verified") {
    if (existing.userId === userId) return { status: 200, body: { status: "verified" } };
    return { status: 200, body: pendingBody };
  }

  const code = deps.newCode();
  const row = await deps.writePending({
    userId,
    provider: deps.provider.id,
    phoneHash,
    phone: deps.encryptPhone(phone),
    codeHash: codeHashOf(deps, userId, phoneHash, code),
    codeExpiresAt: expiresAt,
    defaultAgentId: input.defaultAgentId ?? null,
  });
  // Lost a race with a verify on another account: the same neutral answer.
  if (!row) return { status: 200, body: pendingBody };

  const sent = await deps.provider.send(phone, LINK_TEXT_COPY.code(code, deps.productName));
  if (!sent.ok) {
    await deps.deleteLink(userId, row.id);
    return refuse(502, "send_failed");
  }
  return { status: 200, body: pendingBody };
}

/** Finishes a link: the code read back from the phone, checked in constant time. */
export async function verifyLink(userId: string, input: { code: unknown }, deps: LinkDeps): Promise<LinkOutcome> {
  const code = typeof input.code === "string" ? input.code.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(code)) return refuse(400, "invalid_code");
  if (!(await deps.rateLimit(`channel:verify:${userId}`, LINK_VERIFY_LIMIT, 600))) return refuse(429, "verify_rate_limited");

  const pending = await deps.findPending(userId, deps.provider.id);
  if (!pending || !pending.codeHash) return refuse(404, "no_pending");
  const now = deps.now();
  if (!pending.codeExpiresAt || pending.codeExpiresAt.getTime() <= now.getTime()) {
    await deps.deleteLink(userId, pending.id);
    return refuse(410, "code_expired");
  }
  // The try is spent before the comparison, so parallel guesses cannot each
  // see the same count.
  if (!(await deps.spendAttempt(userId, pending.id, LINK_CODE_MAX_ATTEMPTS))) {
    await deps.deleteLink(userId, pending.id);
    return refuse(429, "too_many_attempts");
  }
  if (!deps.macEquals(codeHashOf(deps, userId, pending.phoneHash, code), pending.codeHash)) {
    return refuse(400, "wrong_code");
  }
  if (!(await deps.markVerified(userId, pending.id, now))) return refuse(404, "no_pending");
  await deps.removeOtherLinks(userId, deps.provider.id, pending.id);

  const phone = deps.decryptPhone(pending.phone);
  // The confirmation is a courtesy; the link is made whether or not it lands.
  if (phone) await deps.provider.send(phone, LINK_TEXT_COPY.linked(deps.productName));
  return { status: 200, body: { status: "verified" } };
}
