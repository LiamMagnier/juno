import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { createFakeChannelProvider } from "@/lib/channels/fake";

/*
 * The database half of the iMessage channel (src/lib/channels/store.ts), run
 * against an in-memory Prisma stand-in through the `Module._load` seam the
 * utility billing test uses. What it pins is what a unit test of link.ts
 * cannot see: which client each statement uses, and that the cross-account
 * statements can only ever touch a pending claim or an ownerless ledger row.
 */

type Row = Record<string, unknown> & { id: string; userId: string; provider: string; phoneHash: string; status: string };
const links: Row[] = [];
const ledger = new Set<string>();
const log: { client: "guarded" | "unguarded"; model: string; op: string; where: unknown }[] = [];
const limits = new Map<string, number>();
let limitOverride: boolean | null = null;
const provider = createFakeChannelProvider();
let configured = true;

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === "provider_phoneHash") {
      const pair = want as { provider: string; phoneHash: string };
      return row.provider === pair.provider && row.phoneHash === pair.phoneHash;
    }
    if (want && typeof want === "object" && "not" in (want as object)) return row[key] !== (want as { not: unknown }).not;
    if (want && typeof want === "object" && "lt" in (want as object)) return (row[key] as number) < ((want as { lt: number }).lt);
    return row[key] === want;
  });
}

function channelLinkModel(client: "guarded" | "unguarded") {
  const note = (op: string, where: unknown) => log.push({ client, model: "ChannelLink", op, where });
  return {
    async findUnique({ where }: { where: Record<string, unknown> }) {
      note("findUnique", where);
      return links.find((r) => matches(r, where)) ?? null;
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      note("findFirst", where);
      return links.find((r) => matches(r, where)) ?? null;
    },
    async findMany({ where }: { where: Record<string, unknown> }) {
      note("findMany", where);
      return links.filter((r) => matches(r, where));
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      note("deleteMany", where);
      let count = 0;
      for (let i = links.length - 1; i >= 0; i -= 1) {
        if (matches(links[i]!, where)) {
          links.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      note("updateMany", where);
      const hit = links.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
    async create({ data }: { data: Row }) {
      note("create", null);
      if (links.some((r) => r.provider === data.provider && r.phoneHash === data.phoneHash)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
      }
      const row = { codeAttempts: 0, verifiedAt: null, ...data, id: `link-${links.length + 1}` } as Row;
      links.push(row);
      return row;
    },
  };
}

const prisma = {
  channelLink: channelLinkModel("guarded"),
  channelInbound: {
    async create({ data }: { data: { provider: string; handleHash: string } }) {
      log.push({ client: "guarded", model: "ChannelInbound", op: "create", where: null });
      const key = `${data.provider}:${data.handleHash}`;
      if (ledger.has(key)) throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
      ledger.add(key);
      return data;
    },
    async deleteMany() {
      return { count: 0 };
    },
  },
};
const prismaUnguarded = { channelLink: channelLinkModel("unguarded") };

const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": { prisma, prismaUnguarded },
  "@/lib/crypto": {
    domainMac: (domain: string, value: string) => `mac(${domain}|${value})`,
    macEquals: (a: string, b: string) => a === b,
  },
  "@/lib/field-crypto": {
    encryptField: (plain: string) => `enc:test:${Buffer.from(plain).toString("base64")}`,
    decryptField: (stored: string) => (stored.startsWith("enc:test:") ? Buffer.from(stored.slice(9), "base64").toString() : stored),
  },
  "@/lib/rate-limit": {
    rateLimit: async ({ key, limit }: { key: string; limit: number }) => {
      const next = (limits.get(key) ?? 0) + 1;
      limits.set(key, next);
      return { success: limitOverride ?? next <= limit };
    },
  },
  "@/lib/agents/store": { recordAgentEvent: async () => undefined },
  "@/lib/channels/reply": { agentTextReply: async () => null, mirrorTextIntoThread: async () => undefined },
  "@/lib/channels/config": { channelProvider: () => (configured ? provider : null) },
};
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
let store: typeof import("@/lib/channels/store");
let link: typeof import("@/lib/channels/link");
try {
  store = require("../src/lib/channels/store");
  link = require("../src/lib/channels/link");
} finally {
  moduleLoader._load = originalLoad;
}

function reset() {
  links.length = 0;
  ledger.clear();
  log.length = 0;
  limits.clear();
  limitOverride = null;
  provider.sent.length = 0;
  provider.failWith = null;
  configured = true;
}

const PHONE = "+14155550100";

test("a link start never writes another account's verified row, and the cross-account delete is pending-only", async () => {
  reset();
  const phoneHash = `mac(${link.PHONE_HASH_DOMAIN}|${PHONE})`;
  links.push({ id: "theirs", userId: "user-b", provider: "fake", phoneHash, status: "verified", phone: "enc:test:x" });
  const outcome = await link.startLink("user-a", { phone: PHONE }, store.linkDeps(provider));
  assert.equal(outcome.status, 200);
  assert.equal(provider.sent.length, 0);
  assert.deepEqual(links.map((r) => [r.id, r.userId, r.status]), [["theirs", "user-b", "verified"]]);
  const unguardedWrites = log.filter((e) => e.client === "unguarded" && e.op !== "findUnique");
  assert.equal(unguardedWrites.length, 0, "the verified number was only read across accounts");
});

test("another account's pending claim is cleared by the unguarded delete, which names status pending", async () => {
  reset();
  const phoneHash = `mac(${link.PHONE_HASH_DOMAIN}|${PHONE})`;
  links.push({ id: "claim", userId: "user-b", provider: "fake", phoneHash, status: "pending", phone: "enc:test:x", codeHash: "h" });
  const outcome = await link.startLink("user-a", { phone: PHONE }, store.linkDeps(provider));
  assert.equal(outcome.status, 200);
  assert.equal(provider.sent.length, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.userId, "user-a");
  assert.ok(String(links[0]!.phone).startsWith("enc:test:"), "the number is stored encrypted");
  const crossDeletes = log.filter((e) => e.client === "unguarded" && e.op === "deleteMany");
  assert.equal(crossDeletes.length, 1);
  assert.equal((crossDeletes[0]!.where as { status: string }).status, "pending");
  // Every guarded statement carries the owner.
  for (const entry of log.filter((e) => e.client === "guarded" && e.model === "ChannelLink" && e.where)) {
    assert.equal((entry.where as { userId?: string }).userId, "user-a", `${entry.op} is scoped to the account`);
  }
});

test("the replay ledger claims a handle once", async () => {
  reset();
  const deps = store.inboundDeps();
  assert.equal(await deps.claimHandle("sendblue", "h1"), true);
  assert.equal(await deps.claimHandle("sendblue", "h1"), false);
  assert.equal(await deps.claimHandle("sendblue", "h2"), true);
});

test("the webhook lookup sees verified links only", async () => {
  reset();
  links.push({ id: "p", userId: "user-a", provider: "sendblue", phoneHash: "hp", status: "pending", defaultAgentId: null });
  links.push({ id: "v", userId: "user-b", provider: "sendblue", phoneHash: "hv", status: "verified", defaultAgentId: "a1" });
  const deps = store.inboundDeps();
  assert.equal(await deps.findVerifiedLink("sendblue", "hp"), null);
  assert.deepEqual(await deps.findVerifiedLink("sendblue", "hv"), { id: "v", userId: "user-b", defaultAgentId: "a1" });
  assert.equal(await deps.findVerifiedLink("sendblue", "nobody"), null);
});

test("Settings sees the last four digits, never the number", async () => {
  reset();
  links.push({ id: "v", userId: "user-a", provider: "fake", phoneHash: "h", status: "verified", phone: `enc:test:${Buffer.from(PHONE).toString("base64")}`, verifiedAt: new Date("2026-10-30T00:00:00Z"), codeExpiresAt: null });
  const view = await store.channelLinkFor("user-a", "fake");
  assert.deepEqual(view, { status: "verified", lastFour: "0100", verifiedAt: "2026-10-30T00:00:00.000Z", codeExpiresAt: null });
  assert.ok(!JSON.stringify(view).includes("415555"));
  assert.equal(await store.channelLinkFor("user-b", "fake"), null);
});

test("approval texts go to the verified number with a link, are rate limited, and do nothing when off", async () => {
  reset();
  links.push({ id: "v", userId: "user-a", provider: "fake", phoneHash: "h", status: "verified", phone: `enc:test:${Buffer.from(PHONE).toString("base64")}` });
  assert.equal(await store.textApprovalNotice({ userId: "user-a", who: "Scout", path: "/agents/a1" }), true);
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0]!.to, PHONE);
  assert.match(provider.sent[0]!.text, /^Scout is waiting for you\. Open it here: http:\/\/localhost:3000\/agents\/a1\n/);

  assert.equal(await store.textApprovalNotice({ userId: "user-b", who: "Scout", path: "/agents/a1" }), false, "no link, no text");
  assert.equal(await store.textApprovalNotice({ userId: "user-a", who: "Scout", path: "//evil.example" }), false);

  limitOverride = false;
  assert.equal(await store.textApprovalNotice({ userId: "user-a", who: "Scout", path: "/agents/a1" }), false);
  limitOverride = null;

  configured = false;
  assert.equal(await store.textApprovalNotice({ userId: "user-a", who: "Scout", path: "/agents/a1" }), false);
  assert.equal(provider.sent.length, 1);
});

test("a damaged stored number is never sent to", async () => {
  reset();
  links.push({ id: "v", userId: "user-a", provider: "fake", phoneHash: "h", status: "verified", phone: "[could not be decrypted]" });
  assert.equal(await store.textApprovalNotice({ userId: "user-a", who: "Scout", path: "/agents/a1" }), false);
  assert.equal(provider.sent.length, 0);
});
