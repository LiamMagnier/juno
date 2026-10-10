import assert from "node:assert/strict";
import test from "node:test";

/*
 * The Prisma side of remote control (docs/code-v2/REMOTE-CONTROL.md) against a
 * real database: the pairing store under the ownership guard (one-time
 * consume, revoke, the pair check), and the thread-sync store's cursor and
 * JSON prefs. Runs with REMOTE_CONTROL_TEST_DATABASE_URL (a migrated,
 * disposable database, also passed as DATABASE_URL); skipped otherwise.
 */

const url = process.env.REMOTE_CONTROL_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;

dbTest("pairing against Postgres: single use, the pair check, revoke", async () => {
  const { prismaUnguarded } = await import("@/lib/db");
  const { prismaPairingStore } = await import("@/lib/code-v2/device-pairing-store");
  const { approvePairingOffer, checkRemotePair, createPairingOffer, revokePair } = await import("@/lib/code-v2/device-pairing");
  const suffix = `${process.pid}_${Date.now()}`;
  const user = await prismaUnguarded.user.create({ data: { email: `rc_${suffix}@example.com` } });
  const mac = await prismaUnguarded.codeDevice.create({ data: { userId: user.id, name: `Studio Mac ${suffix}` } });
  const phone = await prismaUnguarded.nativeDeviceSession.create({
    data: { userId: user.id, installationIdHash: `h_${suffix}`, name: "Liam's iPhone", platform: "ios", appVersion: "1.10.6" },
  });
  const secret = "integration-secret-0123456789abcdef";
  try {
    const offer = await createPairingOffer(prismaPairingStore, { userId: user.id, deviceId: mac.id, kind: "phone", secret, appUrl: "https://alevr.example" });
    assert.ok(offer.ok);
    const controller = { kind: "phone" as const, deviceSessionId: phone.id };
    const [a, b] = await Promise.all([
      approvePairingOffer(prismaPairingStore, { userId: user.id, ref: { token: offer.token }, controller, secret }),
      approvePairingOffer(prismaPairingStore, { userId: user.id, ref: { token: offer.token }, controller, secret }),
    ]);
    assert.equal([a, b].filter((r) => r.ok).length, 1, "the conditional update lets one approval through");
    const approved = (a.ok ? a : b) as Extract<typeof a, { ok: true }>;
    assert.ok((await checkRemotePair(prismaPairingStore, { userId: user.id, deviceId: mac.id, controller })).ok);
    await prismaUnguarded.nativeDeviceSession.update({ where: { id: phone.id }, data: { revokedAt: new Date() } });
    assert.equal((await checkRemotePair(prismaPairingStore, { userId: user.id, deviceId: mac.id, controller })).ok, false);
    await prismaUnguarded.nativeDeviceSession.update({ where: { id: phone.id }, data: { revokedAt: null } });
    assert.ok((await revokePair(prismaPairingStore, { userId: user.id, pairId: approved.pair.id })).ok);
    assert.equal((await checkRemotePair(prismaPairingStore, { userId: user.id, deviceId: mac.id, controller })).ok, false);
  } finally {
    await prismaUnguarded.user.delete({ where: { id: user.id } });
  }
});

dbTest("thread sync against Postgres: same-millisecond rows, prefs JSON, needs-you", async () => {
  const { prismaUnguarded } = await import("@/lib/db");
  const { prismaThreadSyncStore } = await import("@/lib/sync/thread-sync-store");
  const { readThreadSync, writeThreadSync, decodeSyncCursor } = await import("@/lib/sync/thread-sync");
  const user = await prismaUnguarded.user.create({ data: { email: `rcs_${process.pid}_${Date.now()}@example.com` } });
  try {
    const at = new Date("2026-10-10T12:00:00.000Z");
    await writeThreadSync(prismaThreadSyncStore, user.id, "chat:b", { draft: "b" }, at);
    await writeThreadSync(prismaThreadSyncStore, user.id, "chat:a", { draft: "a" }, at);
    await writeThreadSync(prismaThreadSyncStore, user.id, "code:mac1:s1", { prefs: { model: "opus", mode: "full", skills: ["tidy"] }, needsYou: true }, at);
    const first = await readThreadSync(prismaThreadSyncStore, user.id, { cursor: null });
    assert.deepEqual(first.threads.map((t) => t.key), ["chat:b", "chat:a", "code:mac1:s1"]);
    assert.deepEqual(first.threads[2].prefs, { model: "opus", mode: "full", skills: ["tidy"] });
    assert.equal(first.threads[2].needsYou, true);
    await writeThreadSync(prismaThreadSyncStore, user.id, "chat:0", { draft: "0" }, at);
    const next = await readThreadSync(prismaThreadSyncStore, user.id, { cursor: decodeSyncCursor(first.cursor) });
    assert.deepEqual(next.threads.map((t) => t.key), ["chat:0"], "a same-millisecond write under a smaller key is not skipped");
  } finally {
    await prismaUnguarded.user.delete({ where: { id: user.id } });
  }
});
