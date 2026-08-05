import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HANDLE_TTL_MS,
  MAX_HANDLE_TTL_MS,
  TOMBSTONE_GRACE_MS,
  WorkTokenBroker,
  type CredentialResolver,
  type WorkCredentialRef,
} from "@/lib/work/broker";

/*
 * The broker's job is negative: after any sequence of calls, the run must not
 * be holding anything that outlives the run or works anywhere else. These tests
 * are therefore mostly about what is absent — no credential in the handle, no
 * credential in the audit rows, no second use of an exchange id — and about the
 * refusals being distinguishable, because "denied" that cannot tell forgery
 * from expiry is a log nobody can act on.
 */

const SECRET = "ghp_realtoken_do_not_leak";

const ref: WorkCredentialRef = { connectorId: "github", connectionId: "conn_7" };

function fixture(options: { ttlMs?: number; maxExchanges?: number } = {}) {
  const clock = { value: 1_700_000_000_000 };
  let issued = 0;
  const broker = new WorkTokenBroker({
    now: () => clock.value,
    newHandle: () => `wkh_test_${(issued += 1)}`,
    ...options,
  });
  const calls: { ref: WorkCredentialRef; scopes: readonly string[] }[] = [];
  const resolve: CredentialResolver = async (r, scopes) => {
    calls.push({ ref: r, scopes });
    return SECRET;
  };
  return { broker, clock, resolve, calls };
}

function request(handle: string, exchangeId: string) {
  return { handle, exchangeId, runId: "run_1", connectorId: "github", scopes: ["repo:read"] };
}

function mint(broker: WorkTokenBroker, overrides: Partial<Parameters<WorkTokenBroker["mint"]>[0]> = {}) {
  return broker.mint({
    runId: "run_1",
    connectorId: "github",
    credential: ref,
    scopes: ["repo:read", "issues:read"],
    ...overrides,
  });
}

test("the handle carries nothing that could be used without the broker", () => {
  const { broker } = fixture();
  const handle = mint(broker);
  const serialised = JSON.stringify(handle);

  assert.ok(!serialised.includes(SECRET));
  // Not even the reference: the run has no business knowing which row backs it.
  assert.ok(!serialised.includes("conn_7"));
  assert.deepEqual(handle.scopes, ["repo:read", "issues:read"]);
  assert.equal(handle.runId, "run_1");
});

test("the lifetime is short by default and cannot be argued past the ceiling", () => {
  const { broker, clock } = fixture();
  assert.equal(mint(broker).expiresAt, clock.value + DEFAULT_HANDLE_TTL_MS);
  // A caller asking for a day gets the ceiling, silently and deliberately: the
  // ceiling is the account's real exposure and is not a negotiation.
  assert.equal(mint(broker, { ttlMs: 86_400_000 }).expiresAt, clock.value + MAX_HANDLE_TTL_MS);
});

test("a redemption returns the credential once, with the handle's narrowed scopes", async () => {
  const { broker, resolve, calls } = fixture();
  const handle = mint(broker);

  const result = await broker.exchange(request(handle.handle, "x1"), resolve);
  assert.ok(result.ok);
  assert.equal(result.credential, SECRET);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ref, ref);
  // The resolver is told the narrowing, so an implementation that can mint a
  // downscoped token does rather than handing back the account-wide one.
  assert.deepEqual(calls[0].scopes, ["repo:read", "issues:read"]);
});

test("the same exchange id is never honoured twice", async () => {
  const { broker, resolve, calls } = fixture();
  const handle = mint(broker);

  assert.ok((await broker.exchange(request(handle.handle, "x1"), resolve)).ok);
  const replay = await broker.exchange(request(handle.handle, "x1"), resolve);

  assert.ok(!replay.ok);
  assert.equal(replay.reason, "replayed");
  assert.equal(replay.audit.severity, "violation");
  assert.equal(calls.length, 1, "the resolver must not run for a replay");

  // A genuine retry brings a new id and works.
  assert.ok((await broker.exchange(request(handle.handle, "x2"), resolve)).ok);
});

test("a failed resolve spends the ticket", async () => {
  // The alternative leaves the id reusable after any timeout, and a reused id
  // is indistinguishable from a captured one being replayed.
  const { broker } = fixture();
  const handle = mint(broker);
  const failing: CredentialResolver = async () => {
    throw new Error("decrypt failed: key rotated");
  };

  const first = await broker.exchange(request(handle.handle, "x1"), failing);
  assert.ok(!first.ok);
  assert.equal(first.reason, "credential_unavailable");
  assert.equal(first.audit.severity, "refusal");
  // The resolver's message is not carried anywhere: it is exactly the kind of
  // string that ends up quoting a fragment of what it failed on.
  assert.ok(!JSON.stringify(first.audit).includes("key rotated"));

  const retry = await broker.exchange(request(handle.handle, "x1"), failing);
  assert.ok(!retry.ok);
  assert.equal(retry.reason, "replayed");
});

test("expiry is refused, and stays distinguishable from a forgery for a while", async () => {
  const { broker, clock, resolve, calls } = fixture();
  const handle = mint(broker);

  clock.value += DEFAULT_HANDLE_TTL_MS;
  const expired = await broker.exchange(request(handle.handle, "x1"), resolve);
  assert.ok(!expired.ok);
  assert.equal(expired.reason, "expired");
  assert.equal(expired.audit.severity, "refusal");
  assert.equal(calls.length, 0);

  // Once the tombstone is swept the honest answer becomes "unknown", and the
  // severity rises with it: nothing left in the process ever issued this.
  clock.value += TOMBSTONE_GRACE_MS + 1;
  assert.equal(broker.sweep(), 1);
  const forgotten = await broker.exchange(request(handle.handle, "x2"), resolve);
  assert.ok(!forgotten.ok);
  assert.equal(forgotten.reason, "unknown_handle");
  assert.equal(forgotten.audit.severity, "violation");
});

test("a live handle survives the sweep", () => {
  const { broker, clock } = fixture();
  mint(broker);
  clock.value += DEFAULT_HANDLE_TTL_MS - 1;
  assert.equal(broker.sweep(), 0);
  assert.equal(broker.size, 1);
});

test("a handle is bound to one run and one connector", async () => {
  const { broker, resolve, calls } = fixture();
  const handle = mint(broker);

  const wrongConnector = await broker.exchange(
    { ...request(handle.handle, "x1"), connectorId: "figma" },
    resolve
  );
  assert.ok(!wrongConnector.ok);
  assert.equal(wrongConnector.reason, "connector_mismatch");

  const wrongRun = await broker.exchange(
    { ...request(handle.handle, "x2"), runId: "run_2" },
    resolve
  );
  assert.ok(!wrongRun.ok);
  assert.equal(wrongRun.reason, "run_mismatch");

  // The mismatch is named even when the handle is also expired, so nobody is
  // sent to look at clocks over what is really a stolen handle.
  assert.equal(calls.length, 0);
  for (const refusal of [wrongConnector, wrongRun]) {
    assert.equal(refusal.ok, false);
    if (!refusal.ok) assert.equal(refusal.audit.severity, "violation");
  }
});

test("a call cannot ask for more than the handle was given", async () => {
  const { broker, resolve, calls } = fixture();
  const handle = mint(broker, { scopes: ["repo:read"] });

  const result = await broker.exchange(
    { ...request(handle.handle, "x1"), scopes: ["repo:read", "repo:write"] },
    resolve
  );
  assert.ok(!result.ok);
  assert.equal(result.reason, "scope_exceeded");
  assert.match(result.explanation, /repo:write/);
  assert.equal(result.audit.severity, "violation");
  assert.equal(calls.length, 0);
});

test("the count bounds a handle as well as the clock", async () => {
  const { broker, resolve } = fixture();
  const handle = mint(broker, { maxExchanges: 2 });

  assert.ok((await broker.exchange(request(handle.handle, "x1"), resolve)).ok);
  assert.ok((await broker.exchange(request(handle.handle, "x2"), resolve)).ok);
  const third = await broker.exchange(request(handle.handle, "x3"), resolve);
  assert.ok(!third.ok);
  assert.equal(third.reason, "exchange_limit");
  assert.equal(third.audit.severity, "refusal");
});

test("revoking a run kills its handles and nothing else", async () => {
  const { broker, resolve } = fixture();
  const mine = mint(broker);
  const other = mint(broker, { runId: "run_2" });

  assert.equal(broker.revokeRun("run_1"), 1);
  const refused = await broker.exchange(request(mine.handle, "x1"), resolve);
  assert.ok(!refused.ok);
  // Revoked rather than unknown: a run still presenting a handle after it was
  // pulled is a different finding from a handle nobody issued.
  assert.equal(refused.reason, "revoked");

  const survivor = await broker.exchange(
    { ...request(other.handle, "x2"), runId: "run_2" },
    resolve
  );
  assert.ok(survivor.ok);
});

test("revoking is idempotent and never invents a handle", () => {
  const { broker } = fixture();
  const handle = mint(broker);
  assert.equal(broker.revokeHandle(handle.handle), true);
  assert.equal(broker.revokeHandle(handle.handle), false);
  assert.equal(broker.revokeHandle("wkh_never_issued"), false);
  assert.equal(broker.revokeRun("run_never"), 0);
});

test("inspection shows what a handle is for and nothing that would let it be used", async () => {
  const { broker, resolve } = fixture();
  const handle = mint(broker);
  await broker.exchange(request(handle.handle, "x1"), resolve);

  const view = broker.inspect(handle.handle);
  assert.ok(view);
  assert.equal(view.connectorId, "github");
  assert.equal(view.exchangesUsed, 1);
  assert.equal(view.revoked, false);
  assert.ok(!JSON.stringify(view).includes("conn_7"));
  assert.ok(!JSON.stringify(view).includes(SECRET));

  assert.equal(broker.inspect("wkh_never_issued"), null);
});

test("no refusal record ever carries the credential", async () => {
  const { broker, clock, resolve } = fixture();
  const handle = mint(broker, { scopes: ["repo:read"] });
  const refusals = [
    await broker.exchange({ ...request(handle.handle, "x1"), scopes: ["admin"] }, resolve),
    await broker.exchange({ ...request(handle.handle, "x2"), runId: "run_9" }, resolve),
    await broker.exchange(request("wkh_forged", "x3"), resolve),
  ];
  clock.value += MAX_HANDLE_TTL_MS;
  refusals.push(await broker.exchange(request(handle.handle, "x4"), resolve));

  for (const refusal of refusals) {
    assert.equal(refusal.ok, false);
    if (refusal.ok) continue;
    const serialised = JSON.stringify(refusal.audit);
    assert.ok(!serialised.includes(SECRET));
    assert.ok(!serialised.includes("conn_7"));
    assert.equal(refusal.audit.kind, "command_refused");
    assert.equal(refusal.audit.detail.action, "connector_token_exchange");
    assert.equal(refusal.audit.detail.decision, "refused");
    assert.ok(refusal.explanation.length > 0);
    /*
     * Every key has to be on ALLOWED_AUDIT_KEYS in src/lib/work/audit.ts, which
     * cannot be imported here — it is server-only and pulls in Prisma, and
     * these tests run without a database. sanitizeAuditDetail drops the rest
     * silently, so a key added here and not there produces a refusal row that
     * says nothing about what was refused.
     */
    for (const key of Object.keys(refusal.audit.detail)) {
      assert.ok(
        ["action", "reason", "decision", "runId", "connectorId", "requestId", "attempts"].includes(key),
        `${key} is not an allowlisted audit key`
      );
    }
  }
});

test("a forged handle's audit row records the claim and nothing it did not verify", async () => {
  const { broker, resolve } = fixture();
  const forged = await broker.exchange(request("wkh_forged", "x1"), resolve);
  assert.ok(!forged.ok);
  // runId is what the caller claimed. `attempts` is the one field that could
  // only come from a handle the broker actually holds, so its absence is what
  // says "nothing here was verified".
  assert.equal(forged.audit.detail.runId, "run_1");
  assert.equal(forged.audit.detail.requestId, "x1");
  assert.equal(forged.audit.detail.attempts, undefined);

  const known = mint(broker);
  const expiredClaim = await broker.exchange({ ...request(known.handle, "x2"), runId: "run_9" }, resolve);
  assert.ok(!expiredClaim.ok);
  assert.equal(expiredClaim.audit.detail.attempts, 0);
});

test("two handles for the same run and connector are independent", async () => {
  const { broker, resolve } = fixture();
  const first = mint(broker);
  const second = mint(broker);
  assert.notEqual(first.handle, second.handle);

  broker.revokeHandle(first.handle);
  const refused = await broker.exchange(request(first.handle, "x1"), resolve);
  assert.ok(!refused.ok);
  assert.ok((await broker.exchange(request(second.handle, "x2"), resolve)).ok);
});

test("the default generator produces handles that are not guessable", () => {
  // Not a statistical test: it pins that the real generator is wired in and
  // that its output is long, opaque and labelled as a secret for anyone who
  // finds one in a log.
  const broker = new WorkTokenBroker();
  const a = broker.mint({ runId: "run_1", connectorId: "github", credential: ref, scopes: [] });
  const b = broker.mint({ runId: "run_1", connectorId: "github", credential: ref, scopes: [] });
  assert.notEqual(a.handle, b.handle);
  assert.ok(a.handle.startsWith("wkh_"));
  assert.ok(a.handle.length >= 40);
  assert.match(a.handle, /^wkh_[A-Za-z0-9_-]+$/);
});
