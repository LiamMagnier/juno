import test from "node:test";
import assert from "node:assert/strict";
import type { Share } from "@prisma/client";
import {
  addSharePeople,
  listSharePeople,
  normalizeShareEmail,
  openPeopleShare,
  parseShareEmails,
  peopleShareAccess,
  removeSharePerson,
  RECIPIENT_EMAIL_DOMAIN,
  SHARE_PEOPLE_LIMITS,
  UNREADABLE_EMAIL_LABEL,
  type PeopleShareDeps,
  type RecipientRow,
  type ShareInvite,
  type ShareTarget,
  type ShareViewer,
} from "@/lib/share-people-core";
import { shareInvitation } from "@/lib/email-templates";

/*
 * SHARE WITH SPECIFIC PEOPLE (src/lib/share-people-core.ts), the whole flow
 * against an in-memory table: who may read a people share (the owner, a
 * verified recipient — never a wrong account, an unverified address, a removed
 * person or anyone after a revoke), how adding people is bounded, and that
 * nothing the owner sees depends on whether an address has an account.
 *
 * The database half (which client each statement uses, that a PEOPLE token is
 * never served as a public link) is tests/share-people-store.test.ts; the
 * dialog is tests/share-people-dialog.test.ts.
 */

/** Every character a RegExp gives meaning to, escaped (backslash included). */
const escapeRegExp = (value: string) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

const OWNER = "owner-1";
const CHAT: ShareTarget = { kind: "CHAT", targetId: "conv-1" };

interface World {
  deps: PeopleShareDeps;
  shares: Share[];
  recipients: Array<RecipientRow & { shareId: string; userId: string }>;
  sent: ShareInvite[];
  limits: Map<string, number>;
  /** Accounts that exist — the core must never be able to tell. */
  accounts: Set<string>;
  viewer: ShareViewer | null;
  ensureCalls: number;
  mailOn: boolean;
  /** Targets the owner owns. */
  owned: Set<string>;
}

function makeShare(over: Partial<Share> = {}): Share {
  return {
    id: `share-${Math.random().toString(16).slice(2, 8)}`,
    token: `tok${Math.random().toString(16).slice(2)}abcdefghijklmnop`,
    userId: OWNER,
    kind: "CHAT",
    conversationId: "conv-1",
    artifactId: null,
    title: "Launch plan",
    snapshotAt: new Date("2026-10-31T10:00:00Z"),
    leafMessageId: null,
    views: 0,
    revokedAt: null,
    takenDownAt: null,
    takenDownBy: null,
    takedownReason: null,
    transcript: null,
    audience: "PEOPLE",
    createdAt: new Date("2026-10-31T10:00:00Z"),
    ...over,
  };
}

function world(): World {
  let clock = Date.parse("2026-10-31T12:00:00Z");
  let seq = 0;
  const w: World = {
    shares: [],
    recipients: [],
    sent: [],
    limits: new Map(),
    accounts: new Set(),
    viewer: null,
    ensureCalls: 0,
    mailOn: true,
    owned: new Set(["conv-1", "art-1"]),
    deps: undefined as unknown as PeopleShareDeps,
  };
  const live = (s: Share) => !s.revokedAt && !s.takenDownAt && s.audience === "PEOPLE";
  w.deps = {
    now: () => new Date(clock),
    mac: (domain, value) => `mac(${domain}|${value})`,
    encryptEmail: (email) => `enc:test:${Buffer.from(email).toString("base64")}`,
    decryptEmail: (stored) => (stored.startsWith("enc:test:") ? Buffer.from(stored.slice(9), "base64").toString() : null),
    async rateLimit(key, limit) {
      const next = (w.limits.get(key) ?? 0) + 1;
      w.limits.set(key, next);
      return next <= limit;
    },
    async findShare(ownerId, target) {
      return (
        w.shares.find(
          (s) => s.userId === ownerId && s.kind === target.kind && (s.conversationId ?? s.artifactId) === target.targetId && live(s),
        ) ?? null
      );
    },
    async ensureShare(ownerId, target) {
      w.ensureCalls += 1;
      if (ownerId !== OWNER || !w.owned.has(target.targetId)) return null;
      const existing = await w.deps.findShare(ownerId, target);
      if (existing) return existing;
      const share = makeShare({
        kind: target.kind,
        conversationId: target.kind === "CHAT" ? target.targetId : null,
        artifactId: target.kind === "ARTIFACT" ? target.targetId : null,
      });
      w.shares.push(share);
      return share;
    },
    async listRecipients(ownerId, shareId) {
      return w.recipients.filter((r) => r.userId === ownerId && r.shareId === shareId);
    },
    async insertRecipients(ownerId, shareId, rows) {
      const made: RecipientRow[] = [];
      for (const row of rows) {
        if (w.recipients.some((r) => r.shareId === shareId && r.emailHash === row.emailHash)) continue;
        clock += 1000;
        const rec = { id: `rec-${++seq}`, shareId, userId: ownerId, emailHash: row.emailHash, email: row.email, createdAt: new Date(clock), invitedAt: null };
        w.recipients.push(rec);
        made.push(rec);
      }
      return made;
    },
    async markInvited(ownerId, ids, at) {
      for (const r of w.recipients) if (r.userId === ownerId && ids.includes(r.id)) r.invitedAt = at;
    },
    async removeRecipient(ownerId, id) {
      const i = w.recipients.findIndex((r) => r.id === id && r.userId === ownerId);
      if (i < 0) return false;
      w.recipients.splice(i, 1);
      return true;
    },
    async owner() {
      return { name: "Ada Lovelace", email: "ada@owner.test" };
    },
    async sendInvite(invite) {
      if (!w.mailOn) return false;
      w.sent.push(invite);
      return true;
    },
    shareUrl: (token) => `https://alevr.test/share/${token}`,
    async findByToken(token) {
      return w.shares.find((s) => s.token === token && live(s)) ?? null;
    },
    async viewer() {
      return w.viewer;
    },
    async isRecipient(ownerId, shareId, emailHash) {
      return w.recipients.some((r) => r.userId === ownerId && r.shareId === shareId && r.emailHash === emailHash);
    },
  };
  return w;
}

const verified = (id: string, email: string): ShareViewer => ({ id, email, emailVerified: new Date("2026-01-01") });

// ─── Addresses ────────────────────────────────────────────────────────────────

test("addresses are normalized to one spelling; pasted forms are accepted, nonsense is named", () => {
  assert.equal(normalizeShareEmail("  Grace@Example.TEST "), "grace@example.test");
  assert.equal(normalizeShareEmail("mailto:grace@example.test"), "grace@example.test");
  assert.equal(normalizeShareEmail("Grace Hopper <Grace@Example.test>"), "grace@example.test");
  assert.equal(normalizeShareEmail("grace@xn--bcher-kva.example"), "grace@xn--bcher-kva.example");
  for (const bad of ["grace", "grace@", "@example.test", "grace@example", "gr ace@example.test", "grace@exa_mple.test", `${"a".repeat(65)}@example.test`]) {
    assert.equal(normalizeShareEmail(bad), null, bad);
  }
  const parsed = parseShareEmails(["a@x.test, B@x.test; a@x.test\nc@x.test d@x.test", "Grace Hopper <grace@x.test>", "nope"]);
  assert.deepEqual(parsed.emails, ["a@x.test", "b@x.test", "c@x.test", "d@x.test", "grace@x.test"]);
  assert.deepEqual(parsed.invalid, ["nope"]);
});

// ─── Access control ───────────────────────────────────────────────────────────

async function sharedWith(w: World, ...emails: string[]) {
  const added = await addSharePeople(w.deps, OWNER, CHAT, emails);
  assert.ok(added.ok);
  return added.share;
}

test("a recipient signed in with the verified address it was shared with can open it, in any letter case", async () => {
  const w = world();
  const share = await sharedWith(w, "grace@example.test");
  w.viewer = verified("user-grace", "Grace@Example.test");
  const opened = await openPeopleShare(w.deps, share.token);
  assert.deepEqual(opened?.access, { state: "granted", via: "recipient" });
});

test("the owner can always open their own people share", async () => {
  const w = world();
  const share = await sharedWith(w, "grace@example.test");
  w.viewer = { id: OWNER, email: "ada@owner.test", emailVerified: null };
  assert.deepEqual((await openPeopleShare(w.deps, share.token))?.access, { state: "granted", via: "owner" });
});

test("signed out, the token alone opens nothing: sign in first", async () => {
  const w = world();
  const share = await sharedWith(w, "grace@example.test");
  w.viewer = null;
  assert.deepEqual((await openPeopleShare(w.deps, share.token))?.access, { state: "sign-in" });
});

test("a wrong account is denied, even holding the link", async () => {
  const w = world();
  const share = await sharedWith(w, "grace@example.test");
  w.viewer = verified("user-mallory", "mallory@example.test");
  assert.deepEqual((await openPeopleShare(w.deps, share.token))?.access, { state: "denied", email: "mallory@example.test" });
});

test("an unverified address is told to confirm it, the same whether or not it is on the list", async () => {
  const w = world();
  const share = await sharedWith(w, "grace@example.test");
  // Someone registered Grace's address without proving it.
  w.viewer = { id: "user-claim", email: "grace@example.test", emailVerified: null };
  const listed = (await openPeopleShare(w.deps, share.token))?.access;
  assert.deepEqual(listed, { state: "verify", email: "grace@example.test" });
  w.viewer = { id: "user-other", email: "other@example.test", emailVerified: null };
  const unlisted = (await openPeopleShare(w.deps, share.token))?.access;
  assert.equal(unlisted?.state, listed?.state, "the answer must not depend on the list");
  // No email at all is the same wall.
  w.viewer = { id: "user-none", email: null, emailVerified: new Date() };
  assert.equal((await openPeopleShare(w.deps, share.token))?.access.state, "verify");
});

test("a removed person loses access on their next request; everyone else keeps it", async () => {
  const w = world();
  const share = await sharedWith(w, "grace@example.test", "alan@example.test");
  const grace = w.recipients.find((r) => w.deps.decryptEmail(r.email) === "grace@example.test")!;
  assert.equal(await removeSharePerson(w.deps, OWNER, grace.id), true);
  w.viewer = verified("user-grace", "grace@example.test");
  assert.deepEqual((await openPeopleShare(w.deps, share.token))?.access, { state: "denied", email: "grace@example.test" });
  w.viewer = verified("user-alan", "alan@example.test");
  assert.equal((await openPeopleShare(w.deps, share.token))?.access.state, "granted");
});

test("only the owner can remove a person: another account's remove is refused and changes nothing", async () => {
  const w = world();
  await sharedWith(w, "grace@example.test");
  const grace = w.recipients[0]!;
  assert.equal(await removeSharePerson(w.deps, "user-mallory", grace.id), false);
  assert.equal(w.recipients.length, 1);
});

test("a revoked people share opens for nobody, owner and recipients alike", async () => {
  const w = world();
  const share = await sharedWith(w, "grace@example.test");
  share.revokedAt = new Date();
  for (const viewer of [verified("user-grace", "grace@example.test"), verified(OWNER, "ada@owner.test"), null]) {
    w.viewer = viewer;
    assert.equal(await openPeopleShare(w.deps, share.token), null);
  }
  // And the dialog shows nothing shared: the next Invite starts a new share.
  assert.deepEqual(await listSharePeople(w.deps, OWNER, CHAT), { share: null, people: [] });
});

test("the access rule is checked against the share's own owner, so another owner's list is never consulted", async () => {
  const seen: Array<[string, string]> = [];
  const access = await peopleShareAccess(
    {
      mac: (d, v) => `${d}|${v}`,
      isRecipient: async (ownerId, shareId) => {
        seen.push([ownerId, shareId]);
        return false;
      },
    },
    { id: "share-9", userId: "owner-9" },
    verified("viewer", "v@example.test"),
  );
  assert.equal(access.state, "denied");
  assert.deepEqual(seen, [["owner-9", "share-9"]]);
});

// ─── Adding people ────────────────────────────────────────────────────────────

test("opening the list creates nothing; the first Invite makes the share, later ones join it", async () => {
  const w = world();
  assert.deepEqual(await listSharePeople(w.deps, OWNER, CHAT), { share: null, people: [] });
  assert.equal(w.ensureCalls, 0);
  const first = await addSharePeople(w.deps, OWNER, CHAT, ["grace@example.test"]);
  const second = await addSharePeople(w.deps, OWNER, CHAT, ["alan@example.test"]);
  assert.ok(first.ok && second.ok);
  assert.equal(first.share.id, second.share.id, "one share, one snapshot");
  assert.equal(w.shares.length, 1);
  assert.deepEqual(second.people.map((p) => p.email), ["grace@example.test", "alan@example.test"]);
  const listed = await listSharePeople(w.deps, OWNER, CHAT);
  assert.deepEqual(listed.people.map((p) => p.email), ["grace@example.test", "alan@example.test"]);
});

test("each new address gets one invitation; someone already on the list is not emailed again", async () => {
  const w = world();
  await addSharePeople(w.deps, OWNER, CHAT, ["grace@example.test"]);
  const again = await addSharePeople(w.deps, OWNER, CHAT, ["Grace@example.test", "alan@example.test"]);
  assert.ok(again.ok);
  assert.equal(again.added, 1);
  assert.deepEqual(w.sent.map((s) => s.to), ["grace@example.test", "alan@example.test"]);
  assert.equal(w.sent[0]!.url, `https://alevr.test/share/${again.share.token}`);
  assert.equal(w.sent[0]!.ownerName, "Ada Lovelace");
  assert.ok(w.recipients.every((r) => r.invitedAt), "both rows record the invitation");
  // Stored sealed, looked up by the HMAC of the canonical spelling.
  for (const r of w.recipients) {
    assert.match(r.email, /^enc:test:/);
    assert.match(r.emailHash, new RegExp(`^mac\\(${escapeRegExp(RECIPIENT_EMAIL_DOMAIN)}\\|`));
  }
});

test("nothing the owner sees depends on whether an address has an account", async () => {
  const w = world();
  w.accounts.add("member@example.test");
  const a = await addSharePeople(w.deps, OWNER, CHAT, ["member@example.test"]);
  const b = await addSharePeople(w.deps, OWNER, { kind: "ARTIFACT", targetId: "art-1" }, ["stranger@example.test"]);
  assert.ok(a.ok && b.ok);
  const shape = (r: typeof a) => (r.ok ? { added: r.added, people: r.people.map((p) => Object.keys(p).sort()) } : r);
  assert.deepEqual(shape(a), shape(b));
  assert.deepEqual(Object.keys(a.people[0]!).sort(), ["addedAt", "email", "id"], "no account, opened or seen field");
  // The invitation is one sentence for both.
  const strip = (invite: ShareInvite) => shareInvitation({ ...invite, kind: "CHAT", title: "T", recipient: "X", url: "U" }).text;
  assert.equal(strip(w.sent[0]!), strip(w.sent[1]!));
});

test("with mail off, people are still added and simply not marked invited", async () => {
  const w = world();
  w.mailOn = false;
  const added = await addSharePeople(w.deps, OWNER, CHAT, ["grace@example.test"]);
  assert.ok(added.ok);
  assert.equal(added.added, 1);
  assert.equal(w.recipients[0]!.invitedAt, null);
});

test("the per-address limit holds an invitation back silently: the person is still added", async () => {
  const w = world();
  w.owned.add("conv-2");
  w.limits.set(`share-people:to:mac(${RECIPIENT_EMAIL_DOMAIN}|grace@example.test)`, SHARE_PEOPLE_LIMITS.invitesPerAddressPerDay);
  const added = await addSharePeople(w.deps, OWNER, CHAT, ["grace@example.test"]);
  assert.ok(added.ok);
  assert.deepEqual(added.people.map((p) => p.email), ["grace@example.test"]);
  assert.equal(w.sent.length, 0);
  assert.equal(w.recipients[0]!.invitedAt, null);
});

test("an owner over their invitation budget is refused before anything is written", async () => {
  const w = world();
  w.limits.set(`share-people:hour:${OWNER}`, SHARE_PEOPLE_LIMITS.ownerPerHour);
  const refused = await addSharePeople(w.deps, OWNER, CHAT, ["grace@example.test"]);
  assert.deepEqual(refused, { ok: false, error: "rate_limited" });
  assert.equal(w.shares.length, 0, "no empty share left behind");
  assert.equal(w.recipients.length, 0);
  assert.equal(w.sent.length, 0);
  // The day budget is the same wall.
  const w2 = world();
  w2.limits.set(`share-people:day:${OWNER}`, SHARE_PEOPLE_LIMITS.ownerPerDay);
  assert.deepEqual(await addSharePeople(w2.deps, OWNER, CHAT, ["grace@example.test"]), { ok: false, error: "rate_limited" });
});

test("every NEW address costs one from the owner's budget; re-adding listed people is free", async () => {
  const w = world();
  await addSharePeople(w.deps, OWNER, CHAT, ["a@example.test", "b@example.test"]);
  assert.equal(w.limits.get(`share-people:hour:${OWNER}`), 2);
  await addSharePeople(w.deps, OWNER, CHAT, ["a@example.test", "b@example.test"]);
  assert.equal(w.limits.get(`share-people:hour:${OWNER}`), 2);
  assert.equal(w.limits.get(`share-people:day:${OWNER}`), 2);
});

test("a request, and a share, have a ceiling on people", async () => {
  const w = world();
  const many = Array.from({ length: SHARE_PEOPLE_LIMITS.perRequest + 1 }, (_, i) => `p${i}@example.test`);
  assert.deepEqual(await addSharePeople(w.deps, OWNER, CHAT, many), { ok: false, error: "too_many_at_once", limit: SHARE_PEOPLE_LIMITS.perRequest });
  // Fill a share to its cap in batches (an hour apart, so the owner's own
  // budget is not what stops them), then one more is refused.
  for (let i = 0; i < SHARE_PEOPLE_LIMITS.perShare; i += SHARE_PEOPLE_LIMITS.perRequest) {
    w.limits.clear();
    const batch = Array.from({ length: Math.min(SHARE_PEOPLE_LIMITS.perRequest, SHARE_PEOPLE_LIMITS.perShare - i) }, (_, j) => `m${i + j}@example.test`);
    assert.ok((await addSharePeople(w.deps, OWNER, CHAT, batch)).ok);
  }
  w.limits.clear();
  assert.deepEqual(await addSharePeople(w.deps, OWNER, CHAT, ["one-more@example.test"]), { ok: false, error: "too_many_people", limit: SHARE_PEOPLE_LIMITS.perShare });
});

test("an address that is not one refuses the whole request, naming it, and writes nothing", async () => {
  const w = world();
  const refused = await addSharePeople(w.deps, OWNER, CHAT, ["grace@example.test, not-an-address"]);
  assert.deepEqual(refused, { ok: false, error: "invalid_email", invalid: ["not-an-address"] });
  assert.deepEqual(await addSharePeople(w.deps, OWNER, CHAT, ["  ,  "]), { ok: false, error: "no_email" });
  assert.equal(w.shares.length + w.recipients.length + w.sent.length, 0);
});

test("a target that is not the owner's is a not-found, with no share and no mail", async () => {
  const w = world();
  const refused = await addSharePeople(w.deps, OWNER, { kind: "CHAT", targetId: "someone-elses" }, ["grace@example.test"]);
  assert.deepEqual(refused, { ok: false, error: "not_found" });
  assert.equal(w.shares.length + w.recipients.length + w.sent.length, 0);
});

test("a row that can no longer be decrypted is listed as unavailable rather than breaking the list", async () => {
  const w = world();
  await addSharePeople(w.deps, OWNER, CHAT, ["grace@example.test"]);
  w.recipients[0]!.email = "enc:v2:garbled";
  const listed = await listSharePeople(w.deps, OWNER, CHAT);
  assert.equal(listed.people[0]!.email, UNREADABLE_EMAIL_LABEL);
});

// ─── The invitation ───────────────────────────────────────────────────────────

test("the invitation names the sender and their address, escapes what they typed, and says how to open it", () => {
  const mail = shareInvitation({
    ownerName: "Ada <b>Lovelace</b>\nCEO",
    ownerEmail: "ada@owner.test",
    kind: "ARTIFACT",
    title: "Q4 <script>plan</script>",
    recipient: "grace@example.test",
    url: "https://alevr.test/share/abc?x=1&y=2",
  });
  assert.doesNotMatch(mail.subject, /\n|—/);
  assert.match(mail.subject, /^Ada <b>Lovelace<\/b> CEO shared an artifact with you$/);
  assert.doesNotMatch(mail.html, /<script|<b>Lovelace/i);
  assert.match(mail.html, /Q4 &lt;script&gt;plan&lt;\/script&gt;/);
  assert.match(mail.html, /href="https:\/\/alevr.test\/share\/abc\?x=1&amp;y=2"/);
  assert.match(mail.text, /sign in to .+ as grace@example\.test, or create an account with that address/);
  assert.match(mail.text, /Sent by .+ \(ada@owner\.test\)/);
  assert.match(mail.text, /Open the artifact: https:\/\/alevr\.test\/share\/abc\?x=1&y=2/);
  assert.doesNotMatch(mail.html, /Manage notifications/, "a recipient may have no settings to manage");
  // A sender with no name is shown by address.
  assert.match(shareInvitation({ ownerName: null, ownerEmail: "ada@owner.test", kind: "CHAT", title: "", recipient: "g@x.test", url: "u" }).subject, /^ada@owner\.test shared a chat with you$/);
});
