/**
 * Messaging an agent from iMessage (src/lib/channels).
 *
 * Every test runs with a fake provider and in-memory tables: no Sendblue, no
 * Postgres, no env. The security properties each have a test of their own:
 *
 *   - the webhook secret is checked in constant time, and nothing runs
 *     before it matches;
 *   - replay protection: a handle is admitted once, and a `date_sent`
 *     outside the window is dropped before the ledger is touched;
 *   - a rate limit per number, counted for unknown numbers too;
 *   - unknown and pending numbers are ignored with no reply at all;
 *   - a link code is texted, stored only as an HMAC bound to the account
 *     and number, good for five tries and ten minutes;
 *   - a verified number is never taken over from another account, and the
 *     answer does not say whether it is linked;
 *   - no text approves anything: the inbound path has no approval or tool
 *     dependency, and the approval notice carries a link, not a way to answer;
 *   - the feature is off without all four env vars.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isIMessageConfigured } from "@/lib/env";
import { createFakeChannelProvider } from "@/lib/channels/fake";
import { createMacRelayProvider } from "@/lib/channels/mac-relay";
import { isE164, normalizePhone, phoneLastFour } from "@/lib/channels/phone";
import {
  createSendblueProvider,
  parseSendblueWebhook,
  sendblueSecretMatches,
  SENDBLUE_SEND_URL,
} from "@/lib/channels/sendblue";
import {
  CODE_HASH_DOMAIN,
  LINK_CODE_MAX_ATTEMPTS,
  LINK_CODE_TTL_MS,
  PHONE_HASH_DOMAIN,
  startLink,
  verifyLink,
  type ChannelLinkRow,
  type LinkDeps,
} from "@/lib/channels/link";
import {
  answerInbound,
  INBOUND_LIMIT,
  INBOUND_WINDOW_MS,
  pickAgent,
  type AnswerDeps,
  type ChannelAgent,
  type InboundDeps,
} from "@/lib/channels/inbound";
import { handleSendblueWebhook } from "@/lib/channels/webhook";
import { absoluteAppUrl, APPROVAL_NOTICE_COPY, isApprovalNotice } from "@/lib/channels/notice";
import { cleanTextReply, textReplySystem, textReplyUserMessage } from "@/lib/channels/reply-prompt";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const KEY = "test-key";
const mac = (domain: string, value: string) => createHmac("sha256", KEY).update(`${domain}\n${value}`).digest("base64url");
const macEquals = (a: string, b: string) => a === b;
const NOW = new Date("2026-10-30T12:00:00.000Z");
const PHONE = "+14155550100";
const SECRET = "whsec-test-secret";

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

test("phone numbers normalise to E.164 and a number without a country is refused", () => {
  assert.equal(normalizePhone("+1 (415) 555-0100"), PHONE);
  assert.equal(normalizePhone("+1.415.555.0100"), PHONE);
  assert.equal(normalizePhone("0014155550100"), PHONE);
  assert.equal(normalizePhone("4155550100"), null, "no country is ever guessed");
  assert.equal(normalizePhone("+0123456789"), null);
  assert.equal(normalizePhone("+1415abc0100"), null);
  assert.equal(normalizePhone(42), null);
  assert.equal(isE164("[could not be decrypted]"), false);
  assert.equal(phoneLastFour(PHONE), "0100");
  assert.equal(phoneLastFour("garbage"), "");
});

// ---------------------------------------------------------------------------
// Sendblue: the secret, the webhook body, the send
// ---------------------------------------------------------------------------

test("the webhook secret matches only exactly, and never when none is configured", () => {
  assert.equal(sendblueSecretMatches(SECRET, SECRET), true);
  assert.equal(sendblueSecretMatches(`${SECRET}x`, SECRET), false);
  assert.equal(sendblueSecretMatches(SECRET.slice(0, -1), SECRET), false);
  assert.equal(sendblueSecretMatches("", SECRET), false);
  assert.equal(sendblueSecretMatches(null, SECRET), false);
  assert.equal(sendblueSecretMatches("", ""), false, "no secret must not mean any secret");
  assert.equal(sendblueSecretMatches("anything", ""), false);
});

test("the secret comparison is constant time (hashed, then timingSafeEqual)", () => {
  const text = source("src/lib/channels/sendblue.ts");
  assert.match(text, /timingSafeEqual\(a, b\)/);
  assert.match(text, /createHash\("sha256"\)\.update\(received/);
  assert.doesNotMatch(text, /received\s*===\s*expected/);
});

test("the receive webhook body parses, and outbound echoes, tapbacks and non-numbers are dropped", () => {
  const body = {
    from_number: "+1 415 555 0100",
    to_number: "+14155550199",
    content: "  @Scout what is on today?  ",
    message_handle: "msg-1",
    date_sent: NOW.toISOString(),
    is_outbound: false,
  };
  assert.deepEqual(parseSendblueWebhook(body), {
    from: PHONE,
    to: "+14155550199",
    text: "@Scout what is on today?",
    handle: "msg-1",
    sentAt: NOW,
  });
  assert.equal(parseSendblueWebhook({ ...body, is_outbound: true }), null);
  assert.equal(parseSendblueWebhook({ ...body, content: "   " }), null);
  assert.equal(parseSendblueWebhook({ ...body, from_number: "someone@example.com" }), null);
  assert.equal(parseSendblueWebhook({ ...body, message_handle: undefined }), null);
  assert.equal(parseSendblueWebhook(null), null);
  assert.equal(parseSendblueWebhook({ ...body, date_sent: "not a date" })?.sentAt, null);
});

test("the Sendblue send posts the documented request, and a failure is a result, not a throw", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 200;
  const provider = createSendblueProvider(
    { apiKeyId: "kid", apiSecretKey: "ksecret", fromNumber: "+14155550199" },
    async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ message_handle: "out-1" }), { status });
    }
  );
  assert.deepEqual(await provider.send(PHONE, "hello"), { ok: true, providerMessageId: "out-1" });
  assert.equal(calls[0]!.url, SENDBLUE_SEND_URL);
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["sb-api-key-id"], "kid");
  assert.equal(headers["sb-api-secret-key"], "ksecret");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { number: PHONE, from_number: "+14155550199", content: "hello" });

  status = 503;
  assert.deepEqual(await provider.send(PHONE, "hello"), { ok: false, reason: "http_503", retryable: true });
  status = 401;
  assert.deepEqual(await provider.send(PHONE, "hello"), { ok: false, reason: "http_401", retryable: false });
  const offline = createSendblueProvider({ apiKeyId: "k", apiSecretKey: "s", fromNumber: "+1" }, async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.deepEqual(await offline.send(PHONE, "x"), { ok: false, reason: "network", retryable: true });
});

test("the Mac relay is a stub that refuses to send", async () => {
  const relay = createMacRelayProvider();
  assert.equal(relay.id, "mac_relay");
  assert.deepEqual(await relay.send(PHONE, "hi"), { ok: false, reason: "mac_relay_not_available", retryable: false });
  assert.match(source("src/lib/channels/mac-relay.ts"), /The protocol, for whoever builds the Mac half/);
  // Only Sendblue can be selected by configuration; the relay and the fake never.
  const config = source("src/lib/channels/config.ts");
  assert.doesNotMatch(config, /from "@\/lib\/channels\/(mac-relay|fake)"/);
  assert.match(config, /if \(!isIMessageConfigured\(\)\) return null;/);
});

// ---------------------------------------------------------------------------
// The webhook gate
// ---------------------------------------------------------------------------

function gateFixture(links: Record<string, { id: string; userId: string; status: string }> = {}) {
  const ledger = new Set<string>();
  const counts = new Map<string, number>();
  const calls = { rate: 0, claim: 0, lookup: 0 };
  let now = NOW;
  const deps: InboundDeps = {
    now: () => now,
    mac,
    ownNumber: "+14155550199",
    async rateLimit(key, limit) {
      calls.rate += 1;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next <= limit;
    },
    async claimHandle(provider, handleHash) {
      calls.claim += 1;
      const key = `${provider}:${handleHash}`;
      if (ledger.has(key)) return false;
      ledger.add(key);
      return true;
    },
    async findVerifiedLink(_provider, phoneHash) {
      calls.lookup += 1;
      const link = links[phoneHash];
      return link && link.status === "verified" ? { id: link.id, userId: link.userId, defaultAgentId: null } : null;
    },
  };
  return { deps, ledger, calls, setNow: (d: Date) => (now = d) };
}

function webhookBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    from_number: PHONE,
    to_number: "+14155550199",
    content: "hi",
    message_handle: "handle-1",
    date_sent: NOW.toISOString(),
    is_outbound: false,
    ...over,
  });
}

const CONFIG = { webhookSecret: SECRET };

test("off: the webhook answers 404 and runs nothing", async () => {
  const { deps, calls } = gateFixture();
  const outcome = await handleSendblueWebhook({ secret: SECRET, rawBody: webhookBody() }, null, deps);
  assert.equal(outcome.status, 404);
  assert.deepEqual(calls, { rate: 0, claim: 0, lookup: 0 });
});

test("a wrong or missing secret is 401 before the ledger, the rate limit or a lookup", async () => {
  const { deps, calls } = gateFixture();
  for (const secret of [null, "", "wrong", `${SECRET} `]) {
    const outcome = await handleSendblueWebhook({ secret, rawBody: webhookBody() }, CONFIG, deps);
    assert.equal(outcome.status, 401);
  }
  assert.deepEqual(calls, { rate: 0, claim: 0, lookup: 0 });
});

test("an oversized body is refused", async () => {
  const { deps } = gateFixture();
  const outcome = await handleSendblueWebhook({ secret: SECRET, rawBody: "x".repeat(70_000) }, CONFIG, deps);
  assert.equal(outcome.status, 413);
});

test("replay: the same handle is admitted once", async () => {
  const phoneHash = mac(PHONE_HASH_DOMAIN, PHONE);
  const { deps } = gateFixture({ [phoneHash]: { id: "link-1", userId: "user-a", status: "verified" } });
  const first = await handleSendblueWebhook({ secret: SECRET, rawBody: webhookBody() }, CONFIG, deps);
  assert.equal(first.status, 200);
  assert.ok(first.status === 200 && first.admitted, "the first delivery is admitted");
  const again = await handleSendblueWebhook({ secret: SECRET, rawBody: webhookBody() }, CONFIG, deps);
  assert.ok(again.status === 200 && again.admitted === null && again.ignored === "replayed");
  assert.deepEqual(again.body, first.body, "the answer does not say it was a replay");
});

test("replay: a date_sent outside the window, either way, or missing, is dropped before the ledger", async () => {
  const phoneHash = mac(PHONE_HASH_DOMAIN, PHONE);
  const { deps, calls } = gateFixture({ [phoneHash]: { id: "link-1", userId: "user-a", status: "verified" } });
  const old = new Date(NOW.getTime() - INBOUND_WINDOW_MS - 1000).toISOString();
  const future = new Date(NOW.getTime() + INBOUND_WINDOW_MS + 1000).toISOString();
  for (const [date_sent, reason] of [[old, "stale"], [future, "stale"], [null, "no_date"], ["garbage", "no_date"]] as const) {
    const outcome = await handleSendblueWebhook({ secret: SECRET, rawBody: webhookBody({ date_sent, message_handle: `h-${reason}-${date_sent}` }) }, CONFIG, deps);
    assert.ok(outcome.status === 200 && outcome.ignored === reason, `${date_sent} -> ${reason}`);
  }
  assert.equal(calls.claim, 0, "a stale capture never reaches the ledger");
  const inside = new Date(NOW.getTime() - INBOUND_WINDOW_MS + 5000).toISOString();
  const ok = await handleSendblueWebhook({ secret: SECRET, rawBody: webhookBody({ date_sent: inside }) }, CONFIG, deps);
  assert.ok(ok.status === 200 && ok.admitted);
});

test("a text to some other line is dropped", async () => {
  const { deps } = gateFixture();
  const outcome = await handleSendblueWebhook({ secret: SECRET, rawBody: webhookBody({ to_number: "+14155550000" }) }, CONFIG, deps);
  assert.ok(outcome.status === 200 && outcome.ignored === "wrong_line");
});

test("rate limit per number, counted for unknown numbers too", async () => {
  const { deps, calls } = gateFixture();
  let limited = 0;
  for (let i = 0; i < INBOUND_LIMIT + 3; i += 1) {
    const outcome = await handleSendblueWebhook({ secret: SECRET, rawBody: webhookBody({ message_handle: `flood-${i}` }) }, CONFIG, deps);
    if (outcome.status === 200 && outcome.ignored === "rate_limited") limited += 1;
  }
  assert.equal(limited, 3);
  assert.equal(calls.lookup, INBOUND_LIMIT, "a limited text never reaches the lookup");
  // Another number has its own window.
  const other = await handleSendblueWebhook({ secret: SECRET, rawBody: webhookBody({ from_number: "+14155550111", message_handle: "o-1" }) }, CONFIG, deps);
  assert.ok(other.status === 200 && other.ignored === "unknown_number");
});

test("unknown and pending numbers are ignored, with the same answer as any other text", async () => {
  const phoneHash = mac(PHONE_HASH_DOMAIN, PHONE);
  const { deps } = gateFixture({ [phoneHash]: { id: "link-1", userId: "user-a", status: "pending" } });
  const pending = await handleSendblueWebhook({ secret: SECRET, rawBody: webhookBody() }, CONFIG, deps);
  assert.ok(pending.status === 200 && pending.ignored === "unknown_number" && pending.admitted === null);
  assert.deepEqual(pending.body, { ok: true });
  // The route answers only an admitted text; nothing here is ever handed to a provider.
  const route = source("src/app/api/channels/sendblue/webhook/route.ts");
  assert.match(route, /outcome\.admitted && provider/);
});

// ---------------------------------------------------------------------------
// Linking a number
// ---------------------------------------------------------------------------

function linkFixture() {
  const rows: ChannelLinkRow[] = [];
  const provider = createFakeChannelProvider();
  let now = NOW;
  let nextCode = "123456";
  let ids = 0;
  const limits = new Map<string, number>();
  const deps: LinkDeps = {
    provider,
    productName: "Alevr",
    now: () => now,
    newCode: () => nextCode,
    mac,
    macEquals,
    encryptPhone: (phone) => `sealed:${Buffer.from(phone).toString("base64")}`,
    decryptPhone: (stored) => (stored.startsWith("sealed:") ? Buffer.from(stored.slice(7), "base64").toString() : null),
    async rateLimit(key, limit) {
      const next = (limits.get(key) ?? 0) + 1;
      limits.set(key, next);
      return next <= limit;
    },
    async findByPhoneHash(providerId, phoneHash) {
      return rows.find((r) => r.provider === providerId && r.phoneHash === phoneHash) ?? null;
    },
    async writePending(input) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i]!;
        const otherPendingForNumber = r.provider === input.provider && r.phoneHash === input.phoneHash && r.status === "pending" && r.userId !== input.userId;
        const ownOtherPending = r.userId === input.userId && r.provider === input.provider && r.status === "pending" && r.phoneHash !== input.phoneHash;
        if (otherPendingForNumber || ownOtherPending) rows.splice(i, 1);
      }
      if (rows.some((r) => r.provider === input.provider && r.phoneHash === input.phoneHash && r.status === "verified")) return null;
      let row = rows.find((r) => r.userId === input.userId && r.provider === input.provider && r.phoneHash === input.phoneHash);
      if (!row) {
        row = { id: `link-${++ids}`, userId: input.userId, provider: input.provider, phoneHash: input.phoneHash, phone: "", status: "pending", codeHash: null, codeExpiresAt: null, codeAttempts: 0, verifiedAt: null, defaultAgentId: null };
        rows.push(row);
      }
      Object.assign(row, { phone: input.phone, codeHash: input.codeHash, codeExpiresAt: input.codeExpiresAt, codeAttempts: 0, defaultAgentId: input.defaultAgentId });
      return row;
    },
    async findPending(userId, providerId) {
      return rows.find((r) => r.userId === userId && r.provider === providerId && r.status === "pending") ?? null;
    },
    async spendAttempt(userId, linkId, max) {
      const row = rows.find((r) => r.id === linkId && r.userId === userId && r.status === "pending");
      if (!row || row.codeAttempts >= max) return false;
      row.codeAttempts += 1;
      return true;
    },
    async markVerified(userId, linkId, at) {
      const row = rows.find((r) => r.id === linkId && r.userId === userId && r.status === "pending");
      if (!row) return false;
      Object.assign(row, { status: "verified", verifiedAt: at, codeHash: null, codeExpiresAt: null, codeAttempts: 0 });
      return true;
    },
    async removeOtherLinks(userId, providerId, keepId) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i]!;
        if (r.userId === userId && r.provider === providerId && r.id !== keepId) rows.splice(i, 1);
      }
    },
    async deleteLink(userId, linkId) {
      const i = rows.findIndex((r) => r.id === linkId && r.userId === userId);
      if (i >= 0) rows.splice(i, 1);
    },
  };
  return { deps, rows, provider, setNow: (d: Date) => (now = d), setCode: (c: string) => (nextCode = c) };
}

test("linking texts a code and stores only an HMAC of it, bound to the account and number", async () => {
  const { deps, rows, provider } = linkFixture();
  const started = await startLink("user-a", { phone: "+1 415 555 0100" }, deps);
  assert.equal(started.status, 200);
  assert.deepEqual(started.body, { status: "pending", expiresAt: new Date(NOW.getTime() + LINK_CODE_TTL_MS).toISOString() });
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0]!.to, PHONE);
  assert.match(provider.sent[0]!.text, /^123456 is your Alevr code/);

  const row = rows[0]!;
  assert.equal(row.status, "pending");
  assert.equal(row.phoneHash, mac(PHONE_HASH_DOMAIN, PHONE));
  const stored = JSON.stringify(row);
  assert.ok(!stored.includes("123456"), "the code is never stored");
  assert.ok(!stored.includes(PHONE) && !stored.includes("4155550100"), "the number is never stored in the clear");
  assert.equal(row.codeHash, mac(CODE_HASH_DOMAIN, `user-a\n${row.phoneHash}\n123456`));
});

test("verifying with the right code links the number and clears the code", async () => {
  const { deps, rows, provider } = linkFixture();
  await startLink("user-a", { phone: PHONE }, deps);
  const wrong = await verifyLink("user-a", { code: "000000" }, deps);
  assert.equal(wrong.status, 400);
  assert.ok("error" in wrong.body && wrong.body.error === "wrong_code");
  const done = await verifyLink("user-a", { code: "123 456" }, deps);
  assert.deepEqual(done, { status: 200, body: { status: "verified" } });
  assert.equal(rows[0]!.status, "verified");
  assert.equal(rows[0]!.codeHash, null);
  assert.equal(rows[0]!.codeExpiresAt, null);
  assert.match(provider.sent.at(-1)!.text, /Approvals are never given by text/);
});

test("a code from another account does not verify this one (codes are bound)", async () => {
  const { deps, rows, setCode } = linkFixture();
  setCode("111111");
  await startLink("user-a", { phone: PHONE }, deps);
  setCode("222222");
  await startLink("user-b", { phone: "+14155550111" }, deps);
  const crossed = await verifyLink("user-b", { code: "111111" }, deps);
  assert.equal(crossed.status, 400);
  assert.ok(rows.every((r) => r.status === "pending"));
});

test("five wrong tries spend the code; a sixth with the right code is refused", async () => {
  const { deps, rows } = linkFixture();
  await startLink("user-a", { phone: PHONE }, deps);
  for (let i = 0; i < LINK_CODE_MAX_ATTEMPTS; i += 1) {
    const outcome = await verifyLink("user-a", { code: "999999" }, deps);
    assert.equal(outcome.status, 400);
  }
  const sixth = await verifyLink("user-a", { code: "123456" }, deps);
  assert.equal(sixth.status, 429);
  assert.equal(rows.length, 0, "the spent code's row is removed");
});

test("an expired code is refused and removed", async () => {
  const { deps, rows, setNow } = linkFixture();
  await startLink("user-a", { phone: PHONE }, deps);
  setNow(new Date(NOW.getTime() + LINK_CODE_TTL_MS + 1));
  const outcome = await verifyLink("user-a", { code: "123456" }, deps);
  assert.equal(outcome.status, 410);
  assert.equal(rows.length, 0);
});

test("a number verified on another account is not taken over, nothing is texted, and the answer is the same", async () => {
  const { deps, rows, provider } = linkFixture();
  await startLink("user-a", { phone: PHONE }, deps);
  await verifyLink("user-a", { code: "123456" }, deps);
  const sentBefore = provider.sent.length;
  const attempt = await startLink("user-b", { phone: PHONE }, deps);
  assert.equal(attempt.status, 200);
  assert.ok("status" in attempt.body && attempt.body.status === "pending", "indistinguishable from a fresh start");
  assert.equal(provider.sent.length, sentBefore, "no code is sent to a number that is someone else's");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.userId, "user-a");
  assert.equal(rows[0]!.status, "verified");
  const verify = await verifyLink("user-b", { code: "123456" }, deps);
  assert.equal(verify.status, 404);
});

test("another account's pending claim on a number gives way to a new start", async () => {
  const { deps, rows, setCode } = linkFixture();
  setCode("111111");
  await startLink("user-b", { phone: PHONE }, deps);
  setCode("222222");
  await startLink("user-a", { phone: PHONE }, deps);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.userId, "user-a");
  assert.equal((await verifyLink("user-b", { code: "111111" }, deps)).status, 404);
  assert.equal((await verifyLink("user-a", { code: "222222" }, deps)).status, 200);
});

test("a failed code send removes the pending row", async () => {
  const { deps, rows, provider } = linkFixture();
  provider.failWith = { ok: false, reason: "http_500", retryable: true };
  const outcome = await startLink("user-a", { phone: PHONE }, deps);
  assert.equal(outcome.status, 502);
  assert.equal(rows.length, 0);
});

test("link starts are rate limited per account and per number", async () => {
  const { deps } = linkFixture();
  const statuses: number[] = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await startLink(`user-${i}`, { phone: PHONE }, deps)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429], "three codes an hour to one number, whoever asks");
  const { deps: own } = linkFixture();
  const mine: number[] = [];
  for (let i = 0; i < 6; i += 1) mine.push((await startLink("user-a", { phone: `+1415555020${i}` }, own)).status);
  assert.deepEqual(mine, [200, 200, 200, 200, 200, 429]);
});

test("bad input is refused before anything is written or sent", async () => {
  const { deps, rows, provider } = linkFixture();
  assert.equal((await startLink("user-a", { phone: "4155550100" }, deps)).status, 400);
  assert.equal((await verifyLink("user-a", { code: "12345" }, deps)).status, 400);
  assert.equal((await verifyLink("user-a", { code: "abcdef" }, deps)).status, 400);
  assert.equal(rows.length, 0);
  assert.equal(provider.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

const AGENTS: ChannelAgent[] = [
  { id: "a1", name: "Mira", role: "Research", status: "active" },
  { id: "a2", name: "Scout", role: "Scheduling", status: "active" },
  { id: "a3", name: "Quill", role: "Writing", status: "paused" },
];

test("@Name picks the agent; otherwise the link's default, otherwise the first active agent", () => {
  assert.equal(pickAgent("@Scout what is on today?", AGENTS, null).agent?.id, "a2");
  assert.equal(pickAgent("hey @scout", AGENTS, "a1").agent?.id, "a2", "case-insensitive");
  assert.equal(pickAgent("@Scouting party", AGENTS, null).agent?.id, "a1", "whole names only");
  assert.equal(pickAgent("no name here", AGENTS, "a2").agent?.id, "a2");
  assert.equal(pickAgent("no name here", AGENTS, "a3").agent?.id, "a1", "a paused default is passed over");
  assert.equal(pickAgent("@Quill draft this", AGENTS, null).agent?.id, "a3", "a named paused agent is named, not swapped");
  assert.equal(pickAgent("anything", [], null).agent, null);
});

function answerFixture(reply: string | null = "Two meetings, both after lunch.") {
  const provider = createFakeChannelProvider();
  const mirrored: { agentId: string; text: string; reply: string | null }[] = [];
  const recorded: { agentId: string; answered: boolean }[] = [];
  const replies: { agentId: string; text: string }[] = [];
  const deps: AnswerDeps = {
    provider,
    productName: "Alevr",
    appUrl: (p) => `https://app.example${p}`,
    listAgents: async () => AGENTS,
    reply: async (input) => {
      replies.push({ agentId: input.agentId, text: input.text });
      return reply;
    },
    mirror: async (input) => {
      mirrored.push({ agentId: input.agentId, text: input.text, reply: input.reply });
    },
    record: async (input) => {
      recorded.push({ agentId: input.agentId, answered: input.answered });
    },
  };
  return { deps, provider, mirrored, recorded, replies };
}

const ADMITTED = { linkId: "link-1", userId: "user-a", defaultAgentId: null, phone: PHONE, text: "@Scout what is on today?", handleHash: "hh" };

test("a text is answered by the agent it names, mirrored into its thread, and texted back", async () => {
  const { deps, provider, mirrored, recorded, replies } = answerFixture();
  const outcome = await answerInbound(ADMITTED, deps);
  assert.deepEqual(outcome, { kind: "answered", agentId: "a2" });
  assert.deepEqual(replies, [{ agentId: "a2", text: ADMITTED.text }]);
  assert.deepEqual(mirrored, [{ agentId: "a2", text: ADMITTED.text, reply: "Two meetings, both after lunch." }]);
  assert.deepEqual(recorded, [{ agentId: "a2", answered: true }]);
  assert.deepEqual(provider.sent, [{ to: PHONE, text: "Two meetings, both after lunch." }]);
});

test("a paused agent says so and does not answer; no agents says where to hire one", async () => {
  const paused = answerFixture();
  const outcome = await answerInbound({ ...ADMITTED, text: "@Quill draft this" }, paused.deps);
  assert.equal(outcome.kind, "declined");
  assert.equal(paused.replies.length, 0);
  assert.match(paused.provider.sent[0]!.text, /^Quill is paused/);

  const empty = answerFixture();
  empty.deps.listAgents = async () => [];
  await answerInbound(ADMITTED, empty.deps);
  assert.match(empty.provider.sent[0]!.text, /https:\/\/app\.example\/agents$/);
});

test("no answer (budget, provider) still keeps the text in the thread and says so", async () => {
  const { deps, provider, mirrored } = answerFixture(null);
  const outcome = await answerInbound(ADMITTED, deps);
  assert.deepEqual(outcome, { kind: "declined", reason: "no_answer", agentId: "a2" });
  assert.equal(mirrored[0]!.reply, null);
  assert.match(provider.sent[0]!.text, /could not answer just now/);
});

test("no text approves anything: 'yes' to an approval is just a message to the agent", async () => {
  const { deps, replies, provider } = answerFixture("Approvals are only given on the card in the app.");
  for (const text of ["yes", "approve", "Approve it", "1", "ok go"]) {
    await answerInbound({ ...ADMITTED, text }, deps);
  }
  assert.equal(replies.length, 5, "each one reached the agent as a message, and nothing else");
  assert.ok(provider.sent.every((s) => s.to === PHONE));
  // Structural: the inbound path cannot reach an approval or a tool.
  for (const file of [
    "src/lib/channels/inbound.ts",
    "src/lib/channels/webhook.ts",
    "src/lib/channels/reply.ts",
    "src/lib/channels/reply-prompt.ts",
    "src/app/api/channels/sendblue/webhook/route.ts",
  ]) {
    const text = source(file);
    assert.doesNotMatch(text, /from "@\/lib\/(action-approval|action-approval-store|work\/approvals?|approvals?)[^"]*"/, `${file} imports nothing about approvals`);
    assert.doesNotMatch(text, /decideApproval|approveAction|resolveApproval/, `${file} decides nothing`);
  }
  // The headless answer is a utility walk, which takes no tools.
  const reply = source("src/lib/channels/reply.ts");
  assert.match(reply, /runUtilityPrompt<string>\(/);
  assert.doesNotMatch(reply, /\btools\s*:/);
  assert.doesNotMatch(reply, /nativeTools|streamChat/);
});

test("the answer's prompt says it has no tools and that a text approves nothing", () => {
  const system = textReplySystem("You are Scout.");
  assert.match(system, /^You are Scout\./);
  assert.match(system, /You have no tools/);
  assert.match(system, /A text never approves anything/);
  const user = textReplyUserMessage([{ role: "USER", content: "earlier" }, { role: "ASSISTANT", content: "reply" }, { role: "SYSTEM", content: "x" }], "now");
  assert.equal(user, "Your thread so far (oldest first):\nPerson: earlier\nYou: reply\n\nThe person just texted:\nnow");
  assert.equal(cleanTextReply("## Plan\n**Two** meetings, `9am`"), "Plan\nTwo meetings, 9am");
  assert.equal(cleanTextReply("```\ncode\n```"), null);
  assert.ok((cleanTextReply("word ".repeat(1000)) ?? "").length <= 1_600);
});

// ---------------------------------------------------------------------------
// Approval notices
// ---------------------------------------------------------------------------

test("only actionable approvals with somewhere to open are texted", () => {
  const base = { type: "work_approval" as const, channel: "needs_you", actionable: true, path: "/agents/a1" };
  assert.equal(isApprovalNotice(base), true);
  assert.equal(isApprovalNotice({ ...base, type: "code_approval" }), true);
  assert.equal(isApprovalNotice({ ...base, type: "work_completed" }), false);
  assert.equal(isApprovalNotice({ ...base, channel: "updates" }), false);
  assert.equal(isApprovalNotice({ ...base, actionable: false }), false);
  assert.equal(isApprovalNotice({ ...base, path: null }), false);
});

test("the notice is a link to the card on the app's own origin, and says a reply approves nothing", () => {
  assert.equal(absoluteAppUrl("https://app.example", "/agents/a1"), "https://app.example/agents/a1");
  assert.equal(absoluteAppUrl("https://app.example", "//evil.example/x"), null);
  assert.equal(absoluteAppUrl("not a url", "/x"), null);
  const text = APPROVAL_NOTICE_COPY.text("Scout", "https://app.example/agents/a1");
  assert.match(text, /https:\/\/app\.example\/agents\/a1/);
  assert.match(text, /Replying to this text does not approve or answer anything\./);
});

test("notifyUser texts approvals lazily, only when the feature is on, and never awaits it", () => {
  const text = source("src/lib/notifications.ts");
  assert.match(text, /textApprovalIfLinked\(input\);/);
  assert.match(text, /if \(!isIMessageConfigured\(\)\) return;/);
  assert.match(text, /void import\("@\/lib\/channels\/store"\)/);
  assert.doesNotMatch(text, /^import .*@\/lib\/channels\/store/m, "the store is never loaded statically");
  // The text carries who and a link, never the run's detail.
  const store = source("src/lib/channels/store.ts");
  assert.match(store, /APPROVAL_NOTICE_COPY\.text\(input\.who, url\)/);
});

// ---------------------------------------------------------------------------
// Off by default
// ---------------------------------------------------------------------------

test("the feature is off unless all four Sendblue variables are set", () => {
  const names = [
    "CHANNEL_SENDBLUE_API_KEY_ID",
    "CHANNEL_SENDBLUE_API_SECRET_KEY",
    "CHANNEL_SENDBLUE_FROM_NUMBER",
    "CHANNEL_SENDBLUE_WEBHOOK_SECRET",
  ] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) delete process.env[n];
    assert.equal(isIMessageConfigured(), false);
    for (const n of names) process.env[n] = "x";
    assert.equal(isIMessageConfigured(), true);
    for (const missing of names) {
      process.env[missing] = "  ";
      assert.equal(isIMessageConfigured(), false, `${missing} blank keeps it off`);
      process.env[missing] = "x";
    }
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
});

test("ChannelLink.phone is sealed on write, and the key rotation re-seals it", () => {
  const store = source("src/lib/channels/store.ts");
  assert.match(store, /from "@\/lib\/field-crypto"/);
  assert.match(store, /encryptPhone: \(phone\) => encryptField\(phone\)/);
  // Every phone link.ts writes goes through deps.encryptPhone.
  assert.match(source("src/lib/channels/link.ts"), /phone: deps\.encryptPhone\(phone\)/);
  assert.match(source("scripts/rotate-message-keys.ts"), /rotateTextColumn\("ChannelLink\.phone"/);
  assert.match(source("SECURITY.md"), /\| `ChannelLink\.phone` \|/);
});

test("every channel route checks the provider first, and the settings routes require a session", () => {
  for (const file of ["src/app/api/channels/imessage/route.ts", "src/app/api/channels/imessage/link/route.ts", "src/app/api/channels/imessage/verify/route.ts"]) {
    const text = source(file);
    assert.match(text, /export const runtime = "nodejs"/);
    assert.match(text, /requireUser\(\)/);
    assert.match(text, /channelProvider\(\)/);
  }
  const webhook = source("src/app/api/channels/sendblue/webhook/route.ts");
  assert.ok(
    webhook.indexOf("authenticateSendblueWebhook(secret, config)") < webhook.indexOf("req.text()"),
    "the secret is checked before the body is read"
  );
});
