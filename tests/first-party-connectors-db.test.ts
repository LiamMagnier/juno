/** Opt in with FIRST_PARTY_TEST_DATABASE_URL on a migrated disposable database. */
import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const url = process.env.FIRST_PARTY_TEST_DATABASE_URL;
test("first-party sync: atomic cursors, dedupe, ownership, encryption, rollback, refresh and disconnect", { skip: !url }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost"].includes(target.hostname));
  assert.match(target.pathname, /^\/juno_codex_.*_test$/);
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET = "first-party-connector-disposable-test-key";
  process.env.CONNECTOR_GOOGLE_CLIENT_ID = "test-google-app";
  process.env.CONNECTOR_GOOGLE_CLIENT_SECRET = "test-google-secret";
  const modules = Module as unknown as { _load: (name: string, parent: unknown, main: boolean) => unknown };
  const original = modules._load;
  modules._load = function (name, parent, main) { return name === "server-only" ? {} : original.call(this, name, parent, main); };
  const req = createRequire(import.meta.url);
  const { prisma } = req("../src/lib/prisma") as typeof import("@/lib/prisma");
  const { encryptSecret, decryptSecret } = req("../src/lib/crypto") as typeof import("@/lib/crypto");
  const { syncFirstParty, readConnectorTriggerEvents } = req("../src/lib/first-party-connectors/sync-store") as typeof import("@/lib/first-party-connectors/sync-store");
  const { firstPartyAccessToken } = req("../src/lib/first-party-connectors/tokens") as typeof import("@/lib/first-party-connectors/tokens");
  const { buildAuthorizeUrl, exchangeCodeForTokens, getConnector, refreshTokens } = req("../src/lib/connectors") as typeof import("@/lib/connectors");
  modules._load = original;
  const owner = `connector_test_${randomUUID()}`, other = `connector_test_${randomUUID()}`;
  await prisma.user.createMany({ data: [{ id: owner, email: `${owner}@example.invalid` }, { id: other, email: `${other}@example.invalid` }] });
  const connection = await prisma.connection.create({ data: { userId: owner, provider: "gmail", accessToken: encryptSecret("private-access"), refreshToken: encryptSecret("private-refresh") } });
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } }); await prisma.$disconnect(); });

  const response = (data: unknown) => async () => Response.json(data);
  await t.test("baseline is quiet and encrypted", async () => {
    assert.deepEqual(await syncFirstParty(owner, "gmail", "primary", response({ historyId: "100" })), { inserted: 0, more: false, reset: false });
    const [state] = await prisma.$queryRaw<Array<{ state: string }>>`SELECT "state" FROM "ConnectorSyncState" WHERE "connectionId"=${connection.id}`;
    assert.ok(state.state.startsWith("v1."));
    assert.equal(JSON.parse(decryptSecret(state.state)).position, "100");
  });
  const delta = { historyId: "200", history: [{ id: "101", messagesAdded: [{ message: { id: "m1", snippet: "private mail content" } }] }] };
  await t.test("racing syncs publish one event and persist its cursor atomically", async () => {
    const results = await Promise.all([syncFirstParty(owner, "gmail", "primary", response(delta)), syncFirstParty(owner, "gmail", "primary", response(delta))]);
    assert.equal(results.reduce((sum, r) => sum + r.inserted, 0), 1);
    const events = await prisma.$queryRaw<Array<{ payload: string }>>`SELECT "payload" FROM "ConnectorSyncEvent" WHERE "connectionId"=${connection.id}`;
    assert.equal(events.length, 1);
    assert.doesNotMatch(events[0].payload, /private mail content/);
    assert.equal(JSON.parse(decryptSecret(events[0].payload)).snippet, "private mail content");
  });
  await t.test("failed pages leave cursor and outbox untouched", async () => {
    await assert.rejects(syncFirstParty(owner, "gmail", "primary", async () => new Response(null, { status: 503 })));
    const [state] = await prisma.$queryRaw<Array<{ state: string }>>`SELECT "state" FROM "ConnectorSyncState" WHERE "connectionId"=${connection.id}`;
    assert.equal(JSON.parse(decryptSecret(state.state)).position, "200");
  });
  await t.test("a database failure after event insertion rolls back both the event and cursor", async () => {
    await syncFirstParty(owner, "gmail", "rollback", response({ historyId: "100" }));
    await prisma.$executeRawUnsafe(`CREATE FUNCTION codex_fail_sync_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."stream"='rollback' THEN RAISE EXCEPTION 'injected cursor failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER codex_fail_sync_state BEFORE UPDATE ON "ConnectorSyncState" FOR EACH ROW EXECUTE FUNCTION codex_fail_sync_state()`);
    try {
      await assert.rejects(syncFirstParty(owner, "gmail", "rollback", response(delta)), /injected cursor failure/);
      const events = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "ConnectorSyncEvent" WHERE "connectionId"=${connection.id} AND "stream"='rollback'`;
      assert.equal(events[0].count, 0n);
      const [state] = await prisma.$queryRaw<Array<{ state: string }>>`SELECT "state" FROM "ConnectorSyncState" WHERE "connectionId"=${connection.id} AND "stream"='rollback'`;
      assert.equal(JSON.parse(decryptSecret(state.state)).position, "100");
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER codex_fail_sync_state ON "ConnectorSyncState"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION codex_fail_sync_state()`);
    }
  });
  await t.test("another account cannot sync or read this connection", async () => {
    await assert.rejects(syncFirstParty(other, "gmail", "primary", response(delta)), /Reconnect/);
    await assert.rejects(readConnectorTriggerEvents(other, "gmail", "0"), /Reconnect/);
  });
  await t.test("event producer establishes quietly and returns only persisted owner events", async () => {
    globalThis.fetch = async () => Response.json({ historyId: "201", history: [] });
    try {
      const baseline = await readConnectorTriggerEvents(owner, "gmail", undefined);
      assert.equal(baseline.establishing, true);
      assert.equal(baseline.events.length, 0);
      const batch = await readConnectorTriggerEvents(owner, "gmail", "0");
      assert.equal(batch.events.length, 1);
      assert.equal(batch.events[0].connector, "gmail");
      assert.equal(batch.events[0].event, "message_received");
      assert.equal(batch.events[0].attributes.resourceId, "m1");
      assert.match(batch.events[0].eventKey, /^connector:gmail:primary:\d+$/);
      assert.doesNotMatch(JSON.stringify(batch), /private mail content/);
      const next = await readConnectorTriggerEvents(owner, "gmail", batch.cursorPosition);
      assert.equal(next.events.length, 0, "no hourly event is fabricated");
    } finally { globalThis.fetch = originalFetch; }
  });
  await t.test("blocked apps and Always ask prevent unattended sync before provider access", async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return Response.json(delta); };
    await prisma.settings.upsert({ where: { userId: owner }, create: { userId: owner, blockedConnectors: ["gmail"] }, update: { blockedConnectors: ["gmail"] } });
    await assert.rejects(syncFirstParty(owner, "gmail", "primary", fetcher), /not permitted/);
    await prisma.settings.update({ where: { userId: owner }, data: { blockedConnectors: [], actionApprovalPolicy: "always_ask" } });
    await assert.rejects(syncFirstParty(owner, "gmail", "primary", fetcher), /not permitted/);
    assert.equal(calls, 0);
    await prisma.settings.update({ where: { userId: owner }, data: { actionApprovalPolicy: "ask_for_any_change" } });
  });
  await t.test("two workers consume a rotating refresh token only once", async () => {
    await prisma.connection.update({ where: { userId: owner, id: connection.id }, data: { expiresAt: new Date(0) } });
    let refreshes = 0;
    globalThis.fetch = async (_url, init) => {
      refreshes++;
      const body = init?.body as URLSearchParams;
      assert.equal(body.get("refresh_token"), "private-refresh");
      await new Promise((resolve) => setTimeout(resolve, 25));
      return Response.json({ access_token: "new-private-access", refresh_token: "rotated-private-refresh", expires_in: 3600 });
    };
    assert.deepEqual(await Promise.all([firstPartyAccessToken(owner, "gmail"), firstPartyAccessToken(owner, "gmail")]), ["new-private-access", "new-private-access"]);
    assert.equal(refreshes, 1);
    const row = await prisma.connection.findFirstOrThrow({ where: { userId: owner, id: connection.id } });
    assert.notEqual(row.refreshToken, "rotated-private-refresh");
    assert.equal(decryptSecret(row.refreshToken!), "rotated-private-refresh");
  });
  await t.test("Google OAuth requests offline access and binds code exchange to PKCE", async () => {
    const def = getConnector("gmail")!;
    const flow = await buildAuthorizeUrl(def, "signed-state");
    const authorize = new URL(flow.url);
    assert.equal(authorize.searchParams.get("access_type"), "offline");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    await assert.rejects(exchangeCodeForTokens(def, "code"), /PKCE/);
    globalThis.fetch = async (_url, init) => {
      const body = init?.body as URLSearchParams;
      assert.equal(body.get("code_verifier"), flow.session!.codeVerifier);
      return Response.json({ access_token: "fixture-token" });
    };
    assert.equal((await exchangeCodeForTokens(def, "code", flow.session)).accessToken, "fixture-token");
  });
  await t.test("Slack uses user tokens and rejects 200 OAuth errors without exposing their body", async () => {
    const def = { ...getConnector("slack")!, cfg: { clientId: "fixture", clientSecret: "fixture" } };
    globalThis.fetch = async () => Response.json({ ok: true, access_token: "bot-token", authed_user: { access_token: "user-token", refresh_token: "user-refresh", expires_in: 3600 } });
    assert.equal((await exchangeCodeForTokens(def, "code")).accessToken, "user-token");
    globalThis.fetch = async () => Response.json({ ok: false, error: "contains-sensitive-value" });
    await assert.rejects(refreshTokens(def, "fixture"), (error: Error) => !error.message.includes("sensitive-value"));
  });
  await t.test("disconnect deletes all synced private data and blocks old connector tokens", async () => {
    await prisma.connection.deleteMany({ where: { userId: owner, id: connection.id } });
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "ConnectorSyncState" WHERE "connectionId"=${connection.id}`;
    const events = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "ConnectorSyncEvent" WHERE "connectionId"=${connection.id}`;
    assert.equal(rows[0].count, 0n); assert.equal(events[0].count, 0n);
    assert.equal(await firstPartyAccessToken(owner, "gmail"), null);
  });
});
