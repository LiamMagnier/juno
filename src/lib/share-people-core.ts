/**
 * Sharing a chat or an artifact with specific people, by email.
 *
 * A link share (src/lib/share.ts) is a bearer capability: whoever holds the
 * token reads the snapshot. A PEOPLE share is the same snapshot pointer — same
 * `Share` row, same frozen `snapshotAt`, same revocation tombstone — with
 * `audience: PEOPLE`, and its token opens nothing by itself. The share page
 * shows it to two kinds of reader only:
 *
 *   - its owner, who can always preview what they shared;
 *   - a signed-in account whose VERIFIED email is on the share's recipients.
 *
 * Verified, because credentials sign-up leaves `emailVerified` null: without
 * it anyone could register the address the owner typed and read the share
 * (the same rule as the computer allowlist, src/lib/computer/access.ts).
 *
 * WHAT THE OWNER LEARNS ABOUT A RECIPIENT: NOTHING. Adding an address never
 * looks up an account. The answer is the same list either way, the
 * invitation is the same sentence either way ("sign in, or create an account,
 * with this address"), and an address the per-address limit held back is
 * still added. Nothing records whether, or when, a recipient opened it.
 *
 * WHAT A STRANGER LEARNS FROM THE TOKEN: that it names a share with specific
 * people, and nothing else — not the title, not the owner, not who is on it.
 * An unverified account is told to confirm its address whether or not that
 * address is listed, so claiming an address is not a way to test the list.
 *
 * Bounded, because every address added is an email to somebody who did not ask
 * for one: twenty per request, fifty per share, forty new addresses an hour and
 * one hundred and fifty a day per owner across all their shares, and five
 * invitations a day to any one address from everyone together.
 *
 * Pure: every effect is a `PeopleShareDeps` call, so tests/share-people.test.ts
 * runs the whole flow — access control included — against an in-memory table.
 * The Prisma-backed deps are src/lib/share-people.ts.
 */

import type { Share, ShareKind } from "@prisma/client";

export const SHARE_PEOPLE_LIMITS = {
  /** Addresses one request may add. */
  perRequest: 20,
  /** People one share may have. */
  perShare: 50,
  /** New addresses one owner may add, across every share of theirs. */
  ownerPerHour: 40,
  ownerPerDay: 150,
  /** Invitations one address may be sent in a day, by every owner together. */
  invitesPerAddressPerDay: 5,
} as const;

/** HMAC domain (`domainMac`) of a recipient's normalized address. */
export const RECIPIENT_EMAIL_DOMAIN = "juno.share.recipient-email.v1";

/** What the owner sees for an address its row can no longer decrypt. */
export const UNREADABLE_EMAIL_LABEL = "Address unavailable";

const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
// Deliberately plain: a local part of anything but spaces, quotes, angle
// brackets and the separators people paste between addresses, and a domain of
// dot-separated labels ending in a letter TLD (or an IDN `xn--` one).
const EMAIL_PATTERN = /^[^\s@<>"(),:;[\]\\]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** The one spelling an address is compared and hashed in: trimmed, lower case. */
export function canonicalEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * An address the owner typed, as the canonical spelling, or null when it is
 * not one. Accepts `mailto:` and the `Name <address>` form a contact card pastes.
 */
export function normalizeShareEmail(raw: string): string | null {
  const trimmed = raw.trim().replace(/^mailto:/i, "");
  const angled = /<([^<>]+)>\s*$/.exec(trimmed);
  const address = canonicalEmail(angled ? angled[1]! : trimmed);
  if (!address || address.length > MAX_EMAIL_LENGTH) return null;
  const at = address.lastIndexOf("@");
  if (at < 1 || at > MAX_LOCAL_LENGTH) return null;
  return EMAIL_PATTERN.test(address) ? address : null;
}

/**
 * Split what the owner typed or pasted into addresses. Commas, semicolons and
 * new lines separate entries; inside an entry without `<…>`, so does white
 * space. Duplicates collapse to the first, in order.
 */
export function parseShareEmails(input: string | readonly string[]): { emails: string[]; invalid: string[] } {
  const entries = (typeof input === "string" ? [input] : input).flatMap((part) => part.split(/[,;\n\r]+/));
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const pieces = entry.includes("<") ? [entry] : entry.split(/\s+/);
    for (const piece of pieces) {
      if (!piece.trim()) continue;
      const email = normalizeShareEmail(piece);
      if (!email) {
        invalid.push(piece.trim().slice(0, 80));
        continue;
      }
      if (seen.has(email)) continue;
      seen.add(email);
      emails.push(email);
    }
  }
  return { emails, invalid };
}

export interface ShareTarget {
  kind: ShareKind;
  /** The conversation id for CHAT, the artifact id for ARTIFACT. */
  targetId: string;
}

export interface RecipientRow {
  id: string;
  /** Encrypted. */
  email: string;
  emailHash: string;
  createdAt: Date;
  invitedAt: Date | null;
}

/** One person, as the owner's dialog lists them. */
export interface SharePersonView {
  id: string;
  email: string;
  addedAt: string;
}

/** Whoever is signed in, with verification read from the account row, never the session. */
export interface ShareViewer {
  id: string;
  email: string | null;
  emailVerified: Date | null;
}

export interface ShareInvite {
  to: string;
  ownerName: string | null;
  ownerEmail: string | null;
  kind: ShareKind;
  title: string;
  url: string;
}

export interface PeopleShareDeps {
  now(): Date;
  mac(domain: string, value: string): string;
  encryptEmail(email: string): string;
  /** The address back, or null when the row cannot be decrypted. */
  decryptEmail(stored: string): string | null;
  /** true while under the limit; every call counts one. */
  rateLimit(key: string, limit: number, windowSec: number): Promise<boolean>;
  /** The target's live PEOPLE share, scoped to its owner; null when there is none. */
  findShare(ownerId: string, target: ShareTarget): Promise<Share | null>;
  /**
   * The target's live PEOPLE share, made now if there is none. Null when the
   * target is missing or not the owner's. Throws the share module's refusals
   * (a takedown, a Code session with nothing on the server to show).
   */
  ensureShare(ownerId: string, target: ShareTarget): Promise<Share | null>;
  listRecipients(ownerId: string, shareId: string): Promise<RecipientRow[]>;
  /** Inserts, skipping any address already on the share; returns the rows this call made. */
  insertRecipients(ownerId: string, shareId: string, rows: Array<{ emailHash: string; email: string }>): Promise<RecipientRow[]>;
  markInvited(ownerId: string, recipientIds: string[], at: Date): Promise<void>;
  /** Deletes one of the owner's recipient rows; false when it is not theirs or not there. */
  removeRecipient(ownerId: string, recipientId: string): Promise<boolean>;
  owner(ownerId: string): Promise<{ name: string | null; email: string | null }>;
  /** Sends one invitation; true when it went out. Never throws. */
  sendInvite(invite: ShareInvite): Promise<boolean>;
  shareUrl(token: string): string;
  /** The live PEOPLE share behind a token, or null (missing, a link, revoked, taken down, owner banned). */
  findByToken(token: string): Promise<Share | null>;
  viewer(): Promise<ShareViewer | null>;
  /** Whether the address hash is on the share. Scoped to the owner id the token resolved to. */
  isRecipient(ownerId: string, shareId: string, emailHash: string): Promise<boolean>;
}

/** The owner's view of who has access, oldest first. */
export function peopleViews(deps: Pick<PeopleShareDeps, "decryptEmail">, rows: RecipientRow[]): SharePersonView[] {
  return [...rows]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => ({
      id: row.id,
      email: deps.decryptEmail(row.email) ?? UNREADABLE_EMAIL_LABEL,
      addedAt: row.createdAt.toISOString(),
    }));
}

/** What the dialog reads on open: the target's people share, if any, and who is on it. Never creates. */
export async function listSharePeople(
  deps: PeopleShareDeps,
  ownerId: string,
  target: ShareTarget,
): Promise<{ share: Share | null; people: SharePersonView[] }> {
  const share = await deps.findShare(ownerId, target);
  if (!share) return { share: null, people: [] };
  return { share, people: peopleViews(deps, await deps.listRecipients(ownerId, share.id)) };
}

export type AddSharePeopleResult =
  | { ok: true; share: Share; people: SharePersonView[]; added: number }
  | { ok: false; error: "no_email" }
  | { ok: false; error: "invalid_email"; invalid: string[] }
  | { ok: false; error: "too_many_at_once"; limit: number }
  | { ok: false; error: "too_many_people"; limit: number }
  | { ok: false; error: "rate_limited" }
  | { ok: false; error: "not_found" };

/** Invitations go out a few at a time: twenty at once is a burst the mail provider may refuse. */
const SEND_CONCURRENCY = 4;

/**
 * Add addresses to a target's people share, making the share if it has none,
 * and invite each address that is new to it. An address already on the share
 * is neither counted nor emailed again.
 *
 * Every check that can refuse runs before anything is written: a refused
 * request leaves no empty share and no half-added list behind.
 */
export async function addSharePeople(
  deps: PeopleShareDeps,
  ownerId: string,
  target: ShareTarget,
  input: string | readonly string[],
): Promise<AddSharePeopleResult> {
  const { emails, invalid } = parseShareEmails(input);
  if (invalid.length) return { ok: false, error: "invalid_email", invalid: invalid.slice(0, 5) };
  if (!emails.length) return { ok: false, error: "no_email" };
  if (emails.length > SHARE_PEOPLE_LIMITS.perRequest) {
    return { ok: false, error: "too_many_at_once", limit: SHARE_PEOPLE_LIMITS.perRequest };
  }

  const existingShare = await deps.findShare(ownerId, target);
  const existing = existingShare ? await deps.listRecipients(ownerId, existingShare.id) : [];
  const listed = new Set(existing.map((row) => row.emailHash));
  const fresh = emails
    .map((email) => ({ email, emailHash: deps.mac(RECIPIENT_EMAIL_DOMAIN, email) }))
    .filter((row) => !listed.has(row.emailHash));
  if (existing.length + fresh.length > SHARE_PEOPLE_LIMITS.perShare) {
    return { ok: false, error: "too_many_people", limit: SHARE_PEOPLE_LIMITS.perShare };
  }

  // Every NEW address counts against the owner's hour and day, across all of
  // their shares. Re-adding someone who is already on the list is free.
  const budget = await Promise.all(
    fresh.flatMap(() => [
      deps.rateLimit(`share-people:hour:${ownerId}`, SHARE_PEOPLE_LIMITS.ownerPerHour, 60 * 60),
      deps.rateLimit(`share-people:day:${ownerId}`, SHARE_PEOPLE_LIMITS.ownerPerDay, 24 * 60 * 60),
    ]),
  );
  if (budget.some((allowed) => !allowed)) return { ok: false, error: "rate_limited" };

  const share = existingShare ?? (await deps.ensureShare(ownerId, target));
  if (!share) return { ok: false, error: "not_found" };

  const created = fresh.length
    ? await deps.insertRecipients(
        ownerId,
        share.id,
        fresh.map((row) => ({ emailHash: row.emailHash, email: deps.encryptEmail(row.email) })),
      )
    : [];

  if (created.length) await invite(deps, ownerId, share, created, new Map(fresh.map((row) => [row.emailHash, row.email])));

  const people = await deps.listRecipients(ownerId, share.id);
  return { ok: true, share, people: peopleViews(deps, people), added: created.length };
}

/**
 * Email each newly added person. The per-address limit holds an invitation
 * back silently — the person stays on the list and can still be sent the link
 * by hand — because saying so would tell the owner something about somebody
 * else's inbox.
 */
async function invite(
  deps: PeopleShareDeps,
  ownerId: string,
  share: Share,
  rows: RecipientRow[],
  plain: Map<string, string>,
): Promise<void> {
  const owner = await deps.owner(ownerId);
  const url = deps.shareUrl(share.token);
  const sent: string[] = [];
  for (let i = 0; i < rows.length; i += SEND_CONCURRENCY) {
    await Promise.all(
      rows.slice(i, i + SEND_CONCURRENCY).map(async (row) => {
        const to = plain.get(row.emailHash);
        if (!to) return;
        // Per sender and address, so one account adding an address five
        // times cannot use up that address's day for everyone else; a looser
        // shared ceiling still stops many accounts mailing one person.
        const fromThisOwner = await deps.rateLimit(
          `share-people:to:${ownerId}:${row.emailHash}`,
          SHARE_PEOPLE_LIMITS.invitesPerAddressPerDay,
          24 * 60 * 60,
        );
        if (!fromThisOwner) return;
        const fromAnyone = await deps.rateLimit(
          `share-people:to:${row.emailHash}`,
          SHARE_PEOPLE_LIMITS.invitesPerAddressPerDay * 4,
          24 * 60 * 60,
        );
        if (!fromAnyone) return;
        const ok = await deps.sendInvite({ to, ownerName: owner.name, ownerEmail: owner.email, kind: share.kind, title: share.title, url });
        if (ok) sent.push(row.id);
      }),
    );
  }
  if (sent.length) await deps.markInvited(ownerId, sent, deps.now());
}

/** Take one person off a share. Their next request to its page is refused. */
export async function removeSharePerson(deps: PeopleShareDeps, ownerId: string, recipientId: string): Promise<boolean> {
  return deps.removeRecipient(ownerId, recipientId);
}

export type PeopleShareAccess =
  | { state: "granted"; via: "owner" | "recipient" }
  | { state: "sign-in" }
  | { state: "verify"; email: string | null }
  | { state: "denied"; email: string | null };

/**
 * Whether this viewer may read this people share. The order is the rule:
 *
 *   1. signed out: sign in (nothing about the share is said);
 *   2. its owner: granted;
 *   3. no verified email: confirm it first — the SAME answer whether or not
 *      the address is listed, so an unproved claim on an address cannot be
 *      used to test the list;
 *   4. the verified address is on the share: granted; otherwise denied, which
 *      is also what a removed person gets.
 */
export async function peopleShareAccess(
  deps: Pick<PeopleShareDeps, "mac" | "isRecipient">,
  share: Pick<Share, "id" | "userId">,
  viewer: ShareViewer | null,
): Promise<PeopleShareAccess> {
  if (!viewer) return { state: "sign-in" };
  if (viewer.id === share.userId) return { state: "granted", via: "owner" };
  const email = viewer.email ? canonicalEmail(viewer.email) : "";
  if (!email || !viewer.emailVerified) return { state: "verify", email: viewer.email };
  const listed = await deps.isRecipient(share.userId, share.id, deps.mac(RECIPIENT_EMAIL_DOMAIN, email));
  return listed ? { state: "granted", via: "recipient" } : { state: "denied", email: viewer.email };
}

/**
 * The share page's question for a token that is not a public link: is it a
 * live people share, and may whoever is signed in read it? Null when the token
 * names no live people share — the page's 404, exactly as for a revoked link.
 */
export async function openPeopleShare(
  deps: PeopleShareDeps,
  token: string,
): Promise<{ share: Share; access: PeopleShareAccess } | null> {
  const share = await deps.findByToken(token);
  if (!share) return null;
  return { share, access: await peopleShareAccess(deps, share, await deps.viewer()) };
}
