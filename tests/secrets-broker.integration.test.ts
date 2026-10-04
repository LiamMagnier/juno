import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * Alevr Secrets against Postgres, through the real routes and the real guarded
 * client (BRIEF §7, §52): sealing, account scoping, the spent-use race,
 * rotation, revocation and the access log — and that the plaintext appears in
 * no response, no row other than its own ciphertext, and no log event.
 *
 * Skipped unless SECRETS_TEST_DATABASE_URL names a throwaway local database:
 *
 *   DATABASE_URL=<url> DIRECT_URL=<url> npx prisma migrate deploy
 *   SECRETS_TEST_DATABASE_URL=<url> NODE_OPTIONS=--conditions=react-server \
 *     npx tsx --test --experimental-test-module-mocks tests/secrets-broker.integration.test.ts
 */

const DB_URL = process.env.SECRETS_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const local = DB_URL ? /^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])?(:\d+)?\//.test(DB_URL) : false;

if (!DB_URL || !canMockModules || !local) {
  test("secrets broker integration suite is skipped without a local SECRETS_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.AUTH_SECRET = "secrets-broker-integration-secret";
  process.env.TOKEN_ENCRYPTION_KEYS = `k1:${randomBytes(32).toString("hex")}`;
  process.env.TOKEN_ENCRYPTION_PRIMARY = "k1";

  const SECRET = `s3cret-${randomBytes(8).toString("hex")}`;
  const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const json = (url: string, method: string, body?: unknown) =>
    new Request(`http://alevr.test${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function person(label: string) {
    const tag = `${label}-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const user = await db.user.create({ data: { email: `${tag}@example.invalid`, name: label } });
    const session = await db.workSession.create({ data: { userId: user.id, title: "Log in", goal: "Log in to GitHub" } });
    return { user: { id: user.id, email: user.email!, name: user.name! }, sessionId: session.id };
  }

  test("stand in for the session", () => {
    mock.module("@/lib/session", {
      namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn },
    });
  });

  test("the broker end to end, adversarially", async () => {
    const routes = await import("@/app/api/secrets/route");
    const credentialRoute = await import("@/app/api/secrets/[id]/route");
    const grantRoute = await import("@/app/api/secrets/grants/route");
    const grantIdRoute = await import("@/app/api/secrets/grants/[id]/route");
    const store = await import("@/lib/secrets/store");
    const { workTaskKey } = await import("@/lib/secrets/policy");

    const alice = await person("alice");
    const bob = await person("bob");
    const aliceTask = workTaskKey(alice.sessionId);

    // ── Save: the value is sealed, never echoed, never stored in the clear.
    signedIn = alice.user;
    const created = await routes.POST(
      json("/api/secrets", "POST", { label: "GitHub", hosts: ["github.com"], username: "alice-gh", secret: SECRET }),
    );
    assert.equal(created.status, 201);
    const createdText = await created.text();
    assert.ok(!createdText.includes(SECRET) && !createdText.includes("alice-gh"), "no value or username in the response");
    const credentialId = (JSON.parse(createdText) as { credential: { id: string } }).credential.id;
    const row = await db.secretCredential.findUniqueOrThrow({ where: { id: credentialId } });
    assert.ok(row.sealed.startsWith("v1b.k1."));
    assert.ok(!row.sealed.includes(SECRET));

    const badHost = await routes.POST(json("/api/secrets", "POST", { label: "x", hosts: ["*"], secret: "abcdef" }));
    assert.equal(badHost.status, 400, "a credential for every site is refused");

    // ── Grant: only for the person's own task, never for another account's.
    const foreign = await grantRoute.POST(json("/api/secrets/grants", "POST", { credentialId, workSessionId: bob.sessionId }));
    assert.equal(foreign.status, 404);
    const widen = await grantRoute.POST(
      json("/api/secrets/grants", "POST", { credentialId, workSessionId: alice.sessionId, hosts: ["evil.example"] }),
    );
    assert.equal(widen.status, 400, "a grant cannot name a site the credential is not saved for");
    const granted = await grantRoute.POST(
      json("/api/secrets/grants", "POST", { credentialId, workSessionId: alice.sessionId, maxUses: 2 }),
    );
    assert.equal(granted.status, 201);
    const grantText = await granted.text();
    assert.ok(!grantText.includes("asec_"), "the route never hands a person the reference");
    const grantId = (JSON.parse(grantText) as { grant: { id: string } }).grant.id;

    // Bob cannot use Alice's credential id to mint his own grant either.
    signedIn = bob.user;
    const stolen = await grantRoute.POST(json("/api/secrets/grants", "POST", { credentialId, workSessionId: bob.sessionId }));
    assert.equal(stolen.status, 400);
    const bobRevoke = await grantIdRoute.DELETE(json(`/api/secrets/grants/${grantId}`, "DELETE"), params(grantId));
    assert.equal(bobRevoke.status, 404, "another account cannot revoke the grant");
    signedIn = alice.user;

    // ── What a run is told: a reference, a label and sites.
    const refs = await store.secretRefsForTask(alice.user.id, aliceTask);
    assert.equal(refs.length, 1);
    const ref = refs[0].ref;
    assert.ok(!JSON.stringify(refs).includes(SECRET) && !JSON.stringify(refs).includes("alice-gh"));
    assert.deepEqual(await store.secretRefsForTask(bob.user.id, workTaskKey(bob.sessionId)), []);

    const redeem = (over: Partial<Parameters<typeof store.redeemSecretGrant>[0]> = {}) =>
      store.redeemSecretGrant({
        ref,
        userId: alice.user.id,
        taskKey: aliceTask,
        targetUrl: "https://github.com/login",
        scope: "fill:secret",
        targetIsPasswordField: true,
        ...over,
      });

    // ── Refusals that must not spend a use.
    assert.deepEqual(await redeem({ userId: bob.user.id, taskKey: workTaskKey(bob.sessionId) }), { ok: false, reason: "unknown_grant" });
    assert.deepEqual(await redeem({ taskKey: workTaskKey(bob.sessionId) }), { ok: false, reason: "wrong_task" });
    assert.deepEqual(await redeem({ targetUrl: "https://github.com.evil.example/" }), { ok: false, reason: "host_not_allowed" });
    assert.deepEqual(await redeem({ targetIsPasswordField: false }), { ok: false, reason: "field_not_password" });
    assert.deepEqual(await redeem({ ref: `${ref.slice(0, -2)}xx` }), { ok: false, reason: "forged_reference" });
    assert.deepEqual(await redeem({ now: new Date(Date.now() + 2 * 86_400_000) }), { ok: false, reason: "grant_expired" });

    // ── Granted, then replayed past the budget concurrently: exactly one more wins.
    const first = await redeem();
    assert.equal(first.ok && first.value, SECRET);
    const user = await redeem({ scope: "fill:username", targetIsPasswordField: false });
    assert.equal(user.ok && user.value, "alice-gh");
    const race = await Promise.all([redeem(), redeem(), redeem()]);
    assert.equal(race.filter((r) => r.ok).length, 0, "the budget of two is spent");
    assert.ok(race.every((r) => !r.ok && r.reason === "uses_exhausted"));

    // ── Cross-account ciphertext swap: Alice's sealed value in Bob's row does not open.
    signedIn = bob.user;
    const bobCred = await routes.POST(json("/api/secrets", "POST", { label: "Mine", hosts: ["github.com"], secret: "bobs-own-value" }));
    const bobCredentialId = ((await bobCred.json()) as { credential: { id: string } }).credential.id;
    await db.secretCredential.update({ where: { id: bobCredentialId }, data: { sealed: row.sealed } });
    const bobGrant = await store.createSecretGrant({ userId: bob.user.id, credentialId: bobCredentialId, taskKey: workTaskKey(bob.sessionId) });
    await assert.rejects(
      store.redeemSecretGrant({
        ref: bobGrant.ref,
        userId: bob.user.id,
        taskKey: workTaskKey(bob.sessionId),
        targetUrl: "https://github.com/login",
        scope: "fill:secret",
        targetIsPasswordField: true,
      }),
      /unable to authenticate|auth/i,
      "AES-GCM refuses a ciphertext sealed for another owner",
    );
    signedIn = alice.user;

    // ── Rotation invalidates earlier grants; revocation is immediate.
    const second = await store.createSecretGrant({ userId: alice.user.id, credentialId, taskKey: aliceTask });
    const rotated = await credentialRoute.PATCH(json(`/api/secrets/${credentialId}`, "PATCH", { secret: `${SECRET}-new` }), params(credentialId));
    assert.equal(rotated.status, 200);
    assert.deepEqual(await redeem({ ref: second.ref }), { ok: false, reason: "credential_rotated" });
    const third = await store.createSecretGrant({ userId: alice.user.id, credentialId, taskKey: aliceTask });
    const fresh = await redeem({ ref: third.ref });
    assert.equal(fresh.ok && fresh.value, `${SECRET}-new`);
    const revokeGrant = await grantIdRoute.DELETE(json(`/api/secrets/grants/${third.grant.id}`, "DELETE"), params(third.grant.id));
    assert.equal(revokeGrant.status, 200);
    assert.deepEqual(await redeem({ ref: third.ref }), { ok: false, reason: "grant_revoked" });

    const fourth = await store.createSecretGrant({ userId: alice.user.id, credentialId, taskKey: aliceTask });
    const removed = await credentialRoute.DELETE(json(`/api/secrets/${credentialId}`, "DELETE"), params(credentialId));
    assert.equal(removed.status, 200);
    assert.deepEqual(await redeem({ ref: fourth.ref }), { ok: false, reason: "grant_revoked" });
    const gone = await db.secretCredential.findUniqueOrThrow({ where: { id: credentialId } });
    assert.equal(gone.sealed, "revoked", "the ciphertext is overwritten on removal");

    // ── The access log records every attempt, and no secret anywhere.
    const list = await routes.GET();
    const listed = await list.text();
    assert.ok(!listed.includes(SECRET), "the settings payload never carries the value");
    const body = JSON.parse(listed) as { events: Array<{ outcome: string; reason: string | null; host: string | null }> };
    assert.ok(body.events.some((e) => e.outcome === "granted" && e.host === "github.com"));
    for (const reason of ["wrong_task", "host_not_allowed", "uses_exhausted", "credential_rotated", "grant_revoked", "forged_reference"]) {
      assert.ok(body.events.some((e) => e.outcome === "refused" && e.reason === reason), reason);
    }
    const allEvents = await db.secretAccessEvent.findMany({ where: { userId: { in: [alice.user.id, bob.user.id] } } });
    const allGrants = await db.secretGrant.findMany({ where: { userId: { in: [alice.user.id, bob.user.id] } } });
    const dump = JSON.stringify([allEvents, allGrants]);
    assert.ok(!dump.includes(SECRET) && !dump.includes("alice-gh"), "no plaintext in grants or the log");
    assert.ok(!dump.includes("asec_"), "no reference stored either");

    await db.user.deleteMany({ where: { id: { in: [alice.user.id, bob.user.id] } } });
    await db.$disconnect();
  });
}
