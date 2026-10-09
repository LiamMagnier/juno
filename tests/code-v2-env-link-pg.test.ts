/**
 * The device-link hub on Postgres (src/lib/code-v2/env-link-store-pg.ts),
 * held to the same rules as the in-memory hub: every scenario below runs
 * against both. The Postgres half is opt-in, like the other DB tests:
 *
 *   CODE_LINK_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55433/linktest \
 *     npx tsx --test tests/code-v2-env-link-pg.test.ts
 *
 * The database needs migration 20261009120000_code_v2_link_hub applied.
 * Two hub objects over the same database stand in for two backend processes.
 */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { PrismaClient } from "@prisma/client";

import { DeviceLink, EnvLinkHub, LINK_LIMITS, type LinkEndpoint, type LinkHub } from "@/lib/code-v2/env-link-hub";
import { PgLinkHub, type LinkSql } from "@/lib/code-v2/env-link-store-pg";
import { linkHub, linkStoreKind } from "@/lib/code-v2/env-link-select";
import type { ServerEventEnvelope } from "@/lib/code-v2/contracts";

const url = process.env.CODE_LINK_TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasourceUrl: url }) : undefined;
after(async () => {
  await prisma?.$disconnect();
});

const ev = (sessionId: string, sequence: number, type = "queue.updated"): ServerEventEnvelope =>
  ({
    type: "event",
    stream: "session",
    sessionId,
    sequence,
    at: new Date().toISOString(),
    event: type === "session.snapshot" ? { type, snapshotSequence: sequence, session: {} } : { type: "queue.updated", queue: [] },
  }) as unknown as ServerEventEnvelope;
const global = (sequence: number): ServerEventEnvelope =>
  ({ type: "event", stream: "global", sequence, at: new Date().toISOString(), event: { type: "provider.updated", instance: { id: "codex:default", kind: "codex", label: "Codex", status: "ready" } } }) as unknown as ServerEventEnvelope;

let n = 0;
interface Backend {
  name: string;
  /** Two "processes" sharing one store. */
  hubs: () => [LinkHub, LinkHub];
}

const backends: Backend[] = [
  {
    name: "memory",
    hubs: () => {
      const hub = new EnvLinkHub();
      return [hub, hub];
    },
  },
];
if (prisma) {
  backends.push({
    name: "postgres",
    hubs: () => [new PgLinkHub(prisma as unknown as LinkSql, { pollMs: 25 }), new PgLinkHub(prisma as unknown as LinkSql, { pollMs: 25 })],
  });
}

for (const backend of backends) {
  const ids = () => ({ user: `u_${backend.name}_${process.pid}_${++n}`, device: `d_${n}` });
  const pair = () => {
    const { user, device } = ids();
    const [a, b] = backend.hubs();
    return { browser: a.link(user, device) as LinkEndpoint, mac: b.link(user, device) as LinkEndpoint, hub: a, user, device };
  };

  test(`${backend.name}: an rpc goes to the Mac under a relay id and returns under the caller's id, across processes`, async () => {
    const { browser, mac, hub, user, device } = pair();
    assert.equal(await hub.isOnline(user, device), false);
    await mac.pull(0);
    assert.equal(await hub.isOnline(user, device), true);
    const reply = browser.rpc({ id: "7", type: "provider.list", params: {} });
    const { commands } = await mac.pull(2000);
    assert.equal(commands.length, 1);
    assert.notEqual(commands[0].id, "7");
    await mac.push({ responses: [{ type: "response", id: commands[0].id, ok: true, result: { instances: [] } }] });
    const out = await reply;
    assert.deepEqual(out.responses, [{ type: "response", id: "7", ok: true, result: { instances: [] } }]);
    // A second pull finds nothing: a command is handed out once.
    assert.deepEqual((await mac.pull(0)).commands, []);
  });

  test(`${backend.name}: terminals and secrets are refused; an offline Mac says so`, async () => {
    const { browser, mac } = pair();
    const offline = await browser.rpc({ id: "1", type: "provider.list", params: {} });
    assert.equal(offline.offline, true);
    await mac.pull(0);
    const terminal = await browser.rpc({ id: "2", type: "terminal.open", params: { cwd: "/", cols: 80, rows: 24 } });
    assert.equal(terminal.responses?.[0].ok, false);
    const secrets = await browser.rpc({ id: "3", type: "env.configure", params: {} });
    assert.equal(secrets.responses?.[0].ok, false);
  });

  test(`${backend.name}: polls return events after the cursor, wait for new ones, and dedupe replays`, async () => {
    const { browser, mac } = pair();
    await mac.pull(0);
    await mac.push({ events: [ev("s1", 0, "session.snapshot"), ev("s1", 1), ev("s1", 2)] });
    const first = await browser.poll({ s1: 0 }, -1, 0);
    assert.deepEqual(first.events?.map((e) => e.sequence), [1, 2]);
    const waiting = browser.poll({ s1: 2 }, -1, 3000);
    await new Promise((r) => setTimeout(r, 60));
    await mac.push({ events: [ev("s1", 3), ev("s1", 3)] });
    const later = await waiting;
    assert.deepEqual(later.events?.map((e) => e.sequence), [3]);
    // A replayed duplicate is ignored.
    await mac.push({ events: [ev("s1", 2)] });
    assert.deepEqual((await browser.poll({ s1: 0 }, -1, 0)).events?.map((e) => e.sequence), [1, 2, 3]);
  });

  test(`${backend.name}: a cursor the ring cannot serve asks the Mac to replay with afterSequence`, async () => {
    const { browser, mac } = pair();
    await mac.pull(0);
    await mac.push({ events: [ev("s9", 40), ev("s9", 41)] });
    const empty = await browser.poll({ s9: 10 }, -1, 0);
    assert.deepEqual(empty.events?.map((e) => e.sequence), [40, 41], "what the ring holds; the client sees the gap");
    const { commands } = await mac.pull(0);
    const replay = commands.find((c) => c.type === "session.open");
    assert.ok(replay, "a synthetic open was queued");
    assert.deepEqual(replay.params, { sessionId: "s9", cwd: "/", afterSequence: 10 });
    // The env server replays, then answers the open: the ring now covers the cursor.
    await mac.push({ events: Array.from({ length: 29 }, (_, i) => ev("s9", 11 + i)) });
    await mac.push({ responses: [{ type: "response", id: replay.id, ok: true, result: { sessionId: "s9" } }] });
    const served = await browser.poll({ s9: 10 }, -1, 0);
    assert.deepEqual(served.events?.map((e) => e.sequence), Array.from({ length: 31 }, (_, i) => 11 + i));
    // Covered now: no second replay.
    await browser.poll({ s9: 10 }, -1, 0);
    assert.equal((await mac.pull(0)).commands.length, 0);
  });

  test(`${backend.name}: the newest snapshot after the cursor supersedes older events; the global stream is renumbered`, async () => {
    const { browser, mac } = pair();
    await mac.pull(0);
    await mac.push({ events: [ev("s2", 1), ev("s2", 2), ev("s2", 5, "session.snapshot"), ev("s2", 6), global(900), global(901)] });
    const out = await browser.poll({ s2: 0 }, -1, 0);
    const session = out.events?.filter((e) => e.stream === "session").map((e) => e.sequence);
    const globals = out.events?.filter((e) => e.stream === "global").map((e) => e.sequence);
    assert.deepEqual(session, [5, 6]);
    assert.deepEqual(globals, [1, 2]);
    // A global cursor from before a hub reset gets everything kept.
    const stale = await browser.poll({}, 99, 0);
    assert.deepEqual(stale.events?.map((e) => e.sequence), [1, 2]);
  });

  test(`${backend.name}: an unanswered rpc times out with a plain sentence`, { timeout: LINK_LIMITS.rpcTimeoutMs + 10_000 }, async (t) => {
    if (backend.name === "memory") {
      // The in-memory hub's timeout is covered in code-v2-env-link.test.ts.
      t.skip();
      return;
    }
    const { browser, mac } = pair();
    await mac.pull(0);
    // Keep the Mac "online" while nobody answers.
    const beat = setInterval(() => void mac.pull(0), 5000);
    try {
      const out = await browser.rpc({ id: "slow", type: "provider.list", params: {} });
      assert.equal(out.responses?.[0].ok, false);
      assert.match(JSON.stringify(out.responses?.[0]), /did not answer in time/);
    } finally {
      clearInterval(beat);
    }
  });
}

test("the routes use memory unless ALEVR_LINK_STORE=postgres", () => {
  const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
  assert.equal(linkStoreKind(env({})), "memory");
  assert.equal(linkStoreKind(env({ ALEVR_LINK_STORE: "postgres" })), "postgres");
  assert.ok(linkHub(env({})) instanceof EnvLinkHub);
  assert.ok(linkHub(env({ ALEVR_LINK_STORE: "postgres" })) instanceof PgLinkHub);
  assert.ok(new DeviceLink());
});
