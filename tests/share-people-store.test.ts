import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { whereHasOwner } from "@/lib/db";

/*
 * The database half of sharing with specific people (src/lib/share-people.ts,
 * src/lib/share.ts) and its routes, run against an in-memory Prisma stand-in
 * through the `Module._load` seam tests/utility-rejection-billing.test.ts
 * uses. What it pins is what the pure test (tests/share-people.test.ts)
 * cannot see:
 *
 *   - a PEOPLE token is never served, peeked, counted or listed as a public
 *     link — the public lookup every public surface goes through skips it;
 *   - making one kind of share never hands back the other kind's token;
 *   - every ShareRecipient statement uses the GUARDED client and carries the
 *     share owner's id, including the share page's recipient check;
 *   - the page reads email verification from the account row, not the session;
 *   - the routes answer in the shapes the dialog reads, and refuse the wrong
 *     account, a removed person and a revoked share.
 */

type Row = Record<string, unknown> & { id: string };
type Client = "guarded" | "unguarded";

const db = {
  shares: [] as Row[],
  recipients: [] as Row[],
  users: [] as Row[],
  conversations: [] as Row[],
};
const log: Array<{ client: Client; model: string; op: string; where: unknown; data?: unknown }> = [];
const mail: Array<{ to: string; subject: string }> = [];
const limits = new Map<string, number>();
let limitOverride: boolean | null = null;
let sessionUser: { id: string; email: string; name?: string } | null = null;
let seq = 0;

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, want]) => {
    if (key === "OR") return (want as Record<string, unknown>[]).some((part) => matches(row, part));
    // Relation filters (`artifact: { deletedAt: null }`): the fixtures have no trashed artifacts.
    if (key === "artifact") return true;
    if (want && typeof want === "object" && !(want instanceof Date)) {
      const filter = want as { not?: unknown; in?: unknown[] };
      if ("in" in filter) return (filter.in ?? []).includes(row[key]);
      if ("not" in filter) return row[key] !== filter.not && !(filter.not === null && row[key] == null);
    }
    return (row[key] ?? null) === want;
  });
}

function pick(row: Row, select?: Record<string, unknown>): Row {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) as Row;
}

function model(name: string, table: () => Row[], client: Client) {
  const note = (op: string, where: unknown, data?: unknown) => log.push({ client, model: name, op, where, data });
  return {
    async findUnique({ where, select, include }: { where: Record<string, unknown>; select?: Record<string, unknown>; include?: Record<string, unknown> }) {
      note("findUnique", where);
      const row = table().find((r) => matches(r, where));
      if (!row) return null;
      if (include?.user) {
        const owner = db.users.find((u) => u.id === row.userId);
        return { ...row, user: { bannedAt: owner?.bannedAt ?? null } };
      }
      return pick(row, select);
    },
    async findFirst({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) {
      note("findFirst", where);
      const rows = table().filter((r) => matches(r, where));
      const row = rows[rows.length - 1];
      return row ? pick(row, select) : null;
    },
    async findMany({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) {
      note("findMany", where);
      return table().filter((r) => matches(r, where)).map((r) => pick(r, select));
    },
    async create({ data }: { data: Record<string, unknown> }) {
      note("create", null, data);
      const defaults = { views: 0, revokedAt: null, takenDownAt: null, createdAt: new Date(), snapshotAt: new Date(), audience: "LINK", transcript: null, leafMessageId: null };
      const row: Row = { ...defaults, ...data, id: `${name.toLowerCase()}-${++seq}` };
      table().push(row);
      return row;
    },
    async createManyAndReturn({ data, skipDuplicates, select }: { data: Row[]; skipDuplicates: boolean; select?: Record<string, unknown> }) {
      note("createManyAndReturn", null, data);
      assert.equal(skipDuplicates, true);
      const made: Row[] = [];
      for (const item of data) {
        if (table().some((r) => r.shareId === item.shareId && r.emailHash === item.emailHash)) continue;
        const row = { ...item, id: `rec-${++seq}`, createdAt: new Date(Date.now() + seq), invitedAt: null } as Row;
        table().push(row);
        made.push(pick(row, select));
      }
      return made;
    },
    async update({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      note("update", where, data);
      const row = table().find((r) => matches(r, where));
      if (row && !("views" in data)) Object.assign(row, data);
      return row;
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      note("updateMany", where, data);
      const hit = table().filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      note("deleteMany", where);
      const before = table().length;
      const keep = table().filter((r) => !matches(r, where));
      table().splice(0, table().length, ...keep);
      return { count: before - keep.length };
    },
    async count({ where }: { where: Record<string, unknown> }) {
      note("count", where);
      return table().filter((r) => matches(r, where)).length;
    },
  };
}

function client(kind: Client) {
  return {
    share: model("Share", () => db.shares, kind),
    shareRecipient: model("ShareRecipient", () => db.recipients, kind),
    user: model("User", () => db.users, kind),
    conversation: model("Conversation", () => db.conversations, kind),
    artifact: model("Artifact", () => [], kind),
    message: model("Message", () => [], kind),
  };
}

const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": { prisma: client("guarded"), prismaUnguarded: client("unguarded") },
  "@/lib/crypto": { domainMac: (domain: string, value: string) => `mac(${domain}|${value})` },
  "@/lib/field-crypto": {
    FIELD_DECRYPT_PLACEHOLDER: "[unreadable]",
    encryptField: (plain: string) => `enc:test:${Buffer.from(plain).toString("base64")}`,
    decryptField: (stored: string) => (stored.startsWith("enc:test:") ? Buffer.from(stored.slice(9), "base64").toString() : "[unreadable]"),
    encryptJsonField: () => null,
    decryptJsonField: () => null,
  },
  "@/lib/message-crypto": { decryptMessageTextSafe: (text: string) => text },
  "@/lib/rate-limit": {
    rateLimit: async ({ key, limit }: { key: string; limit: number }) => {
      const next = (limits.get(key) ?? 0) + 1;
      limits.set(key, next);
      return { success: limitOverride ?? next <= limit, remaining: 0, resetAt: new Date() };
    },
  },
  "@/lib/session": { getCurrentUser: async () => sessionUser },
  "@/lib/email": {
    sendEmail: async (input: { to: string; subject: string }) => {
      mail.push({ to: input.to, subject: input.subject });
      return { ok: true, id: "mail" };
    },
  },
  "@/lib/email-templates": {
    shareInvitation: (input: { recipient: string }) => ({ subject: `invite ${input.recipient}`, html: "", text: "" }),
  },
  "@/lib/share-url": { shareUrl: (token: string) => `https://alevr.test/share/${token}` },
  "@/lib/artifact-takedown": { artifactLineageTakenDown: async () => false },
  "@/lib/chat/branches": { ON_ACTIVE_PATH: {}, pathIdsTo: async () => null, shownLeafId: async () => null },
  "@/lib/artifact-rate-limit": { artifactWriteLimited: async () => null },
};

const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
let share: typeof import("@/lib/share");
let people: typeof import("@/lib/share-people");
let peopleRoute: typeof import("@/app/api/share/people/route");
let personRoute: typeof import("@/app/api/share/people/[id]/route");
let revokeRoute: typeof import("@/app/api/share/[id]/route");
let linkRoute: typeof import("@/app/api/share/route");
try {
  share = require("../src/lib/share");
  people = require("../src/lib/share-people");
  peopleRoute = require("../src/app/api/share/people/route");
  personRoute = require("../src/app/api/share/people/[id]/route");
  revokeRoute = require("../src/app/api/share/[id]/route");
  linkRoute = require("../src/app/api/share/route");
} finally {
  moduleLoader._load = originalLoad;
}

const OWNER = "owner-1";
// Real cuids: the routes validate ids before anything else.
const CONV = "cm9r1qz0a0000abcdefghijkl";

function reset() {
  db.shares.length = 0;
  db.recipients.length = 0;
  db.users.length = 0;
  db.conversations.length = 0;
  log.length = 0;
  mail.length = 0;
  limits.clear();
  limitOverride = null;
  sessionUser = { id: OWNER, email: "ada@owner.test", name: "Ada" };
  db.users.push(
    { id: OWNER, email: "ada@owner.test", name: "Ada", emailVerified: new Date(), bannedAt: null },
    { id: "user-grace", email: "grace@example.test", name: "Grace", emailVerified: new Date(), bannedAt: null },
    { id: "user-mallory", email: "mallory@example.test", name: "M", emailVerified: new Date(), bannedAt: null },
  );
  db.conversations.push({ id: CONV, userId: OWNER, title: "Launch plan", kind: "chat" });
}

function shareRow(over: Partial<Row> = {}): Row {
  const row: Row = {
    id: `share-${++seq}`,
    token: `token${seq}abcdefghijklmnopqrstuvwx`,
    userId: OWNER,
    kind: "CHAT",
    conversationId: CONV,
    artifactId: null,
    title: "Launch plan",
    snapshotAt: new Date(),
    leafMessageId: null,
    views: 0,
    revokedAt: null,
    takenDownAt: null,
    transcript: null,
    audience: "LINK",
    createdAt: new Date(),
    ...over,
  };
  db.shares.push(row);
  return row;
}

const post = (body: unknown) =>
  new Request("http://alevr.test/api/share/people", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

test("a PEOPLE token is never a public link: not peeked, not served, not counted", async () => {
  reset();
  const link = shareRow({ audience: "LINK" });
  const restricted = shareRow({ audience: "PEOPLE" });
  assert.equal((await share.peekPublicShare(link.token as string))?.id, link.id);
  assert.equal(await share.peekPublicShare(restricted.token as string), null);
  assert.equal(await share.getPublicShare(restricted.token as string), null);
  assert.equal(log.filter((e) => e.model === "Share" && e.op === "update").length, 0, "no view counted for a refused token");
  assert.equal((await share.peekPeopleShare(restricted.token as string))?.id, restricted.id);
  assert.equal(await share.peekPeopleShare(link.token as string), null);
  // Revoked, taken down, or its owner banned: gone for the people lookup too.
  restricted.revokedAt = new Date();
  assert.equal(await share.peekPeopleShare(restricted.token as string), null);
  restricted.revokedAt = null;
  restricted.takenDownAt = new Date();
  assert.equal(await share.peekPeopleShare(restricted.token as string), null);
  restricted.takenDownAt = null;
  db.users[0]!.bannedAt = new Date();
  assert.equal(await share.peekPeopleShare(restricted.token as string), null);
});

test("the owner's list of links, which the apps read as public links, leaves people shares out", async () => {
  reset();
  shareRow({ audience: "LINK" });
  shareRow({ audience: "PEOPLE" });
  const links = await share.listShares(OWNER, { conversationId: CONV });
  assert.deepEqual(links.map((s) => s.audience), ["LINK"]);
  const res = await linkRoute.GET(new Request(`http://alevr.test/api/share?conversationId=${CONV}`));
  const body = (await res.json()) as { shares: Array<{ audience: string }> };
  assert.deepEqual(body.shares.map((s) => s.audience), ["LINK"]);
});

test("making one kind of share never hands back the other kind's token", async () => {
  reset();
  const link = shareRow({ audience: "LINK" });
  const made = await share.createShare(OWNER, "CHAT", CONV, { audience: "PEOPLE" });
  assert.ok(made);
  assert.notEqual(made.token, link.token);
  assert.equal(made.audience, "PEOPLE");
  // And a link reuses the link, not the people share made after it.
  assert.equal((await share.createShare(OWNER, "CHAT", CONV))?.id, link.id);
  await assert.rejects(share.createShare(OWNER, "CHAT", CONV, { audience: "PEOPLE", transcript: [{ role: "user", content: "x" }] }), share.ShareTranscriptRefusedError);
});

test("every ShareRecipient statement is on the guarded client and scoped to the share's owner", async () => {
  reset();
  await people.addPeopleToShare(OWNER, { kind: "CHAT", targetId: CONV }, ["grace@example.test", "alan@example.test"]);
  await people.sharePeopleFor(OWNER, { kind: "CHAT", targetId: CONV });
  const restricted = db.shares.find((s) => s.audience === "PEOPLE")!;
  sessionUser = { id: "user-grace", email: "grace@example.test" };
  assert.equal((await people.resolvePeopleShare(restricted.token as string))?.access.state, "granted");
  const alan = db.recipients.find((r) => String(r.emailHash).endsWith("|alan@example.test)"))!;
  await people.removePersonFromShare(OWNER, alan.id);

  const statements = log.filter((e) => e.model === "ShareRecipient");
  assert.ok(statements.length >= 5);
  for (const entry of statements) {
    assert.equal(entry.client, "guarded", `${entry.op} must not use the unguarded client`);
    if (entry.where) assert.ok(whereHasOwner(entry.where, "userId"), `${entry.op} carries the owner`);
    // A create carries the owner in each row it writes.
    if (Array.isArray(entry.data)) for (const row of entry.data as Row[]) assert.equal(row.userId, OWNER);
  }
  const check = statements.find((e) => e.op === "findFirst")!;
  assert.equal((check.where as { userId: string }).userId, OWNER, "the recipient check is scoped to the owner the token resolved");
  // Stored sealed and hashed; mail went to exactly the two new addresses.
  assert.ok(db.recipients.every((r) => String(r.email).startsWith("enc:test:")));
  assert.deepEqual(mail.map((m) => m.to).sort(), ["alan@example.test", "grace@example.test"]);
});

test("the page reads verification and the address from the account row, never from the session", async () => {
  reset();
  await people.addPeopleToShare(OWNER, { kind: "CHAT", targetId: CONV }, ["grace@example.test"]);
  const token = db.shares.find((s) => s.audience === "PEOPLE")!.token as string;
  const grace = db.users.find((u) => u.id === "user-grace")!;
  sessionUser = { id: "user-grace", email: "grace@example.test" };
  grace.emailVerified = null;
  assert.equal((await people.resolvePeopleShare(token))?.access.state, "verify");
  grace.emailVerified = new Date();
  assert.equal((await people.resolvePeopleShare(token))?.access.state, "granted");
  // The session still names the old address, but the account moved on.
  grace.email = "grace@elsewhere.test";
  assert.equal((await people.resolvePeopleShare(token))?.access.state, "denied");
  // The session names Grace's address on another account: that account's own row decides.
  sessionUser = { id: "user-mallory", email: "grace@example.test" };
  assert.equal((await people.resolvePeopleShare(token))?.access.state, "denied");
});

test("POST /api/share/people: signed out, bad addresses, too many today, and the shape the dialog reads", async () => {
  reset();
  sessionUser = null;
  assert.equal((await peopleRoute.POST(post({ kind: "CHAT", conversationId: CONV, emails: ["grace@example.test"] }))).status, 401);
  sessionUser = { id: OWNER, email: "ada@owner.test" };

  const bad = await peopleRoute.POST(post({ kind: "CHAT", conversationId: CONV, emails: ["grace@example.test, nope"] }));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "“nope” isn’t an email address.", code: "invalid_email", invalid: ["nope"] });
  assert.equal(db.shares.length, 0, "a refused request makes no share");

  assert.equal((await peopleRoute.POST(post({ kind: "CHAT", emails: ["grace@example.test"] }))).status, 400, "no target");

  const ok = await peopleRoute.POST(post({ kind: "CHAT", conversationId: CONV, emails: ["Grace@Example.test"] }));
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { share: { audience: string; url: string }; people: Array<{ email: string }>; added: number };
  assert.equal(body.share.audience, "PEOPLE");
  assert.match(body.share.url, /^https:\/\/alevr\.test\/share\//);
  assert.deepEqual(body.people.map((p) => p.email), ["grace@example.test"]);
  assert.equal(body.added, 1);

  limitOverride = false;
  const limited = await peopleRoute.POST(post({ kind: "CHAT", conversationId: CONV, emails: ["alan@example.test"] }));
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { code: string }).code, "rate_limited");
  limitOverride = null;

  const listed = await peopleRoute.GET(new Request(`http://alevr.test/api/share/people?conversationId=${CONV}`));
  const read = (await listed.json()) as { share: { id: string }; people: Array<{ email: string }> };
  assert.deepEqual(read.people.map((p) => p.email), ["grace@example.test"]);
  assert.equal((await peopleRoute.GET(new Request("http://alevr.test/api/share/people"))).status, 400);
  // Someone else's target reads as nothing shared.
  sessionUser = { id: "user-mallory", email: "mallory@example.test" };
  const foreign = (await (await peopleRoute.GET(new Request(`http://alevr.test/api/share/people?conversationId=${CONV}`))).json()) as { share: unknown; people: unknown[] };
  assert.deepEqual(foreign, { share: null, people: [] });
  assert.equal((await peopleRoute.POST(post({ kind: "CHAT", conversationId: CONV, emails: ["x@example.test"] }))).status, 404);
});

test("DELETE a person: another account's is a 404; the owner's takes access away at once", async () => {
  reset();
  await people.addPeopleToShare(OWNER, { kind: "CHAT", targetId: CONV }, ["grace@example.test"]);
  const token = db.shares.find((s) => s.audience === "PEOPLE")!.token as string;
  const grace = db.recipients[0]!;

  sessionUser = { id: "user-mallory", email: "mallory@example.test" };
  assert.equal((await personRoute.DELETE(new Request("http://alevr.test"), params(grace.id))).status, 404);
  assert.equal(db.recipients.length, 1);

  sessionUser = { id: OWNER, email: "ada@owner.test" };
  assert.equal((await personRoute.DELETE(new Request("http://alevr.test"), params(grace.id))).status, 200);
  sessionUser = { id: "user-grace", email: "grace@example.test" };
  assert.equal((await people.resolvePeopleShare(token))?.access.state, "denied");
});

test("revoking a people share (the same DELETE as a link) closes it to everyone on it", async () => {
  reset();
  await people.addPeopleToShare(OWNER, { kind: "CHAT", targetId: CONV }, ["grace@example.test"]);
  const restricted = db.shares.find((s) => s.audience === "PEOPLE")!;
  sessionUser = { id: "user-mallory", email: "mallory@example.test" };
  assert.equal((await revokeRoute.DELETE(new Request("http://alevr.test"), params(restricted.id))).status, 404, "only the owner revokes");
  sessionUser = { id: OWNER, email: "ada@owner.test" };
  assert.equal((await revokeRoute.DELETE(new Request("http://alevr.test"), params(restricted.id))).status, 200);
  sessionUser = { id: "user-grace", email: "grace@example.test" };
  assert.equal(await people.resolvePeopleShare(restricted.token as string), null);
  sessionUser = { id: OWNER, email: "ada@owner.test" };
  assert.equal(await people.resolvePeopleShare(restricted.token as string), null);
});

test("ShareRecipient is owner-guarded, closed to PostgREST, sealed on write and rotated with the keyring", async () => {
  const { OWNER_COLUMN } = await import("@/lib/db");
  const { readFileSync } = await import("node:fs");
  const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  assert.equal(OWNER_COLUMN.get("ShareRecipient"), "userId");
  const sql = source("prisma/migrations/20261101040000_share_people/migration.sql");
  assert.match(sql, /ALTER TABLE "ShareRecipient" ENABLE ROW LEVEL SECURITY;/);
  assert.doesNotMatch(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /ADD COLUMN "audience" "ShareAudience" NOT NULL DEFAULT 'LINK'/, "every existing share stays a link");
  assert.match(source("src/lib/share-people.ts"), /encryptEmail: \(email\) => encryptField\(email\)/);
  assert.match(source("src/lib/share-people-core.ts"), /email: deps\.encryptEmail\(row\.email\)/, "every address written goes through encryptEmail");
  assert.match(source("scripts/rotate-message-keys.ts"), /rotateTextColumn\("ShareRecipient\.email"/);
  assert.match(source("SECURITY.md"), /\| `ShareRecipient\.email` \|/);
});
