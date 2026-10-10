import assert from "node:assert/strict";
import test from "node:test";
import {
  approvePairingOffer,
  browserKeyFromCookie,
  browserNameFrom,
  checkRemotePair,
  createPairingOffer,
  denyPairingOffer,
  inspectPairingOffer,
  listPairsForController,
  listPairsForDevice,
  normalizePairingCode,
  pairingOfferStatus,
  PAIRING_TTL_MS,
  revokePair,
  sha256,
  signPairingToken,
  verifyPairingToken,
  type DevicePairRow,
  type PairingStore,
  type PairingTokenRow,
} from "@/lib/code-v2/device-pairing";

/*
 * Remote control pairing (docs/code-v2/REMOTE-CONTROL.md): a two-minute,
 * single-use, signed offer; approve / deny / revoke only within the account;
 * and every remote command refused without a live pair.
 */

const SECRET = "test-secret-for-pairing-0123456789";
const APP = "https://alevr.example";

function memoryStore() {
  const devices = new Map<string, { id: string; userId: string; name: string }>([
    ["mac1", { id: "mac1", userId: "owner", name: "Studio Mac" }],
    ["mac2", { id: "mac2", userId: "owner", name: "Laptop" }],
    ["macX", { id: "macX", userId: "intruder", name: "Other Mac" }],
  ]);
  const sessions = new Map<string, { userId: string; name: string; platform: string; revoked: boolean }>([
    ["phone-session", { userId: "owner", name: "Liam's iPhone", platform: "ios", revoked: false }],
    ["other-phone", { userId: "owner", name: "Old iPhone", platform: "ios", revoked: false }],
    ["intruder-phone", { userId: "intruder", name: "Their iPhone", platform: "ios", revoked: false }],
  ]);
  const tokens = new Map<string, PairingTokenRow>();
  const pairs = new Map<string, DevicePairRow>();
  let nextPair = 1;
  const matches = (row: DevicePairRow, m: { deviceSessionId?: string; browserKeyHash?: string }) =>
    m.deviceSessionId ? row.deviceSessionId === m.deviceSessionId : m.browserKeyHash ? row.browserKeyHash === m.browserKeyHash : false;
  const store: PairingStore = {
    async device(userId, deviceId) {
      const d = devices.get(deviceId);
      return d && d.userId === userId ? { id: d.id, name: d.name } : null;
    },
    async deviceSessionLive(userId, id) {
      const s = sessions.get(id);
      return s && s.userId === userId && !s.revoked ? { name: s.name, platform: s.platform } : null;
    },
    async createToken(row) {
      tokens.set(row.id, { ...row, createdAt: new Date() });
    },
    async tokenById(userId, id) {
      const t = tokens.get(id);
      return t && t.userId === userId ? t : null;
    },
    async tokenByHash(userId, hash) {
      return [...tokens.values()].find((t) => t.tokenHash === hash && t.userId === userId) ?? null;
    },
    async tokenByCode(userId, codeHash, now) {
      return [...tokens.values()].find((t) => t.userId === userId && t.codeHash === codeHash && !t.consumedAt && t.expiresAt > now) ?? null;
    },
    async consumeToken(userId, id, status, now) {
      const t = tokens.get(id);
      if (!t || t.userId !== userId || t.consumedAt || t.status !== "pending" || t.expiresAt <= now) return false;
      tokens.set(id, { ...t, consumedAt: now, status });
      return true;
    },
    async setTokenPair(userId, id, pairId) {
      const t = tokens.get(id);
      if (t && t.userId === userId) tokens.set(id, { ...t, pairId });
    },
    async createPair(row) {
      const created: DevicePairRow = { ...row, id: `pair${nextPair++}`, createdAt: new Date(), lastUsedAt: new Date(), revokedAt: null };
      pairs.set(created.id, created);
      return created;
    },
    async revokeMatchingPairs(userId, deviceId, m, now) {
      for (const p of pairs.values()) if (p.userId === userId && p.codeDeviceId === deviceId && !p.revokedAt && matches(p, m)) p.revokedAt = now;
    },
    async pairsForDevice(userId, deviceId) {
      return [...pairs.values()].filter((p) => p.userId === userId && p.codeDeviceId === deviceId && !p.revokedAt);
    },
    async pairsForController(userId, m) {
      return [...pairs.values()].filter((p) => p.userId === userId && !p.revokedAt && matches(p, m));
    },
    async pairById(userId, id) {
      const p = pairs.get(id);
      return p && p.userId === userId ? p : null;
    },
    async revokePair(userId, id, now) {
      const p = pairs.get(id);
      if (!p || p.userId !== userId || p.revokedAt) return false;
      p.revokedAt = now;
      return true;
    },
    async activePair(userId, deviceId, m) {
      return [...pairs.values()].find((p) => p.userId === userId && p.codeDeviceId === deviceId && !p.revokedAt && matches(p, m)) ?? null;
    },
    async touchPair() {},
  };
  return { store, tokens, pairs, sessions };
}

const phone = { kind: "phone" as const, deviceSessionId: "phone-session" };

async function phoneOffer(store: PairingStore, now = new Date()) {
  const offer = await createPairingOffer(store, { userId: "owner", deviceId: "mac1", kind: "phone", secret: SECRET, appUrl: APP, now });
  assert.ok(offer.ok);
  return offer;
}

test("token: signed, expires after two minutes, refuses tampering and other secrets", () => {
  const now = Date.now();
  const token = signPairingToken({ tokenId: "t1", userId: "u", deviceId: "d", kind: "phone", expiresAt: now + PAIRING_TTL_MS }, SECRET);
  const ok = verifyPairingToken(token, SECRET, now);
  assert.ok(ok.ok && ok.claims.tokenId === "t1" && ok.claims.kind === "phone");
  assert.deepEqual(verifyPairingToken(token, SECRET, now + PAIRING_TTL_MS + 1), { ok: false, reason: "expired" });
  assert.deepEqual(verifyPairingToken(token, "another-secret", now), { ok: false, reason: "signature" });
  const [prefix, payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ t: "t1", u: "attacker", d: "d", k: "phone", e: now + 60_000 })).toString("base64url");
  assert.deepEqual(verifyPairingToken(`${prefix}.${forged}.${sig}`, SECRET, now), { ok: false, reason: "signature" });
  assert.deepEqual(verifyPairingToken(`${prefix}.${payload}`, SECRET, now), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyPairingToken("not a token", SECRET, now), { ok: false, reason: "malformed" });
});

test("offer: a phone QR carries a URL to /pair with the token; only the owner's Mac can offer", async () => {
  const { store, tokens } = memoryStore();
  const offer = await phoneOffer(store);
  assert.equal(offer.url, `${APP}/pair?t=${encodeURIComponent(offer.token)}`);
  assert.equal(offer.deviceName, "Studio Mac");
  assert.equal(offer.code, undefined);
  const row = tokens.get(offer.id)!;
  assert.equal(row.tokenHash, sha256(offer.token), "only the hash is stored");
  assert.equal(new Date(offer.expiresAt).getTime() - row.createdAt.getTime() <= PAIRING_TTL_MS + 50, true);
  const foreign = await createPairingOffer(store, { userId: "owner", deviceId: "macX", kind: "phone", secret: SECRET, appUrl: APP });
  assert.equal(foreign.ok, false);
  assert.equal(!foreign.ok && foreign.status, 404);
});

test("approve: binds the pair to this phone's sign-in, exactly once", async () => {
  const { store } = memoryStore();
  const offer = await phoneOffer(store);
  const seen = await inspectPairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: phone, secret: SECRET });
  assert.ok(seen.ok);
  assert.equal(seen.deviceName, "Studio Mac");

  const approved = await approvePairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: phone, secret: SECRET });
  assert.ok(approved.ok);
  assert.equal(approved.pair.name, "Liam's iPhone");
  assert.equal(approved.pair.kind, "phone");
  assert.equal(approved.browserKey, undefined);

  const again = await approvePairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: phone, secret: SECRET });
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.code, "used");
  const status = await pairingOfferStatus(store, { userId: "owner", tokenId: offer.id });
  assert.ok(status.ok && status.status === "approved" && status.pair?.id === approved.pair.id);
});

test("approve: an expired offer is refused even if its row was never used", async () => {
  const { store } = memoryStore();
  const created = new Date(Date.now() - PAIRING_TTL_MS - 1000);
  const offer = await phoneOffer(store, created);
  const late = await approvePairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: phone, secret: SECRET });
  assert.equal(late.ok, false);
  assert.equal(!late.ok && late.code, "expired");
  const status = await pairingOfferStatus(store, { userId: "owner", tokenId: offer.id });
  assert.ok(status.ok && status.status === "expired");
});

test("approve: two simultaneous approvals produce one pair", async () => {
  const { store, pairs } = memoryStore();
  const offer = await phoneOffer(store);
  const both = await Promise.all([
    approvePairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: phone, secret: SECRET }),
    approvePairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: phone, secret: SECRET }),
  ]);
  assert.equal(both.filter((r) => r.ok).length, 1);
  assert.equal(pairs.size, 1);
});

test("authz: another account cannot inspect, approve or deny an offer, nor learn it exists", async () => {
  const { store, pairs } = memoryStore();
  const offer = await phoneOffer(store);
  const intruder = { kind: "phone" as const, deviceSessionId: "intruder-phone" };
  for (const act of [inspectPairingOffer, approvePairingOffer, denyPairingOffer] as const) {
    const result = await act(store, { userId: "intruder", ref: { token: offer.token }, controller: intruder, secret: SECRET });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 404);
  }
  assert.equal(pairs.size, 0);
  const status = await pairingOfferStatus(store, { userId: "intruder", tokenId: offer.id });
  assert.equal(status.ok, false);
});

test("authz: a revoked phone sign-in cannot approve", async () => {
  const { store, sessions } = memoryStore();
  const offer = await phoneOffer(store);
  sessions.get("phone-session")!.revoked = true;
  const result = await approvePairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: phone, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 401);
});

test("deny: consumes the offer, so it can no longer be approved, and the Mac sees denied", async () => {
  const { store, pairs } = memoryStore();
  const offer = await phoneOffer(store);
  const denied = await denyPairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: phone, secret: SECRET });
  assert.ok(denied.ok);
  const after = await approvePairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: phone, secret: SECRET });
  assert.equal(after.ok, false);
  assert.equal(pairs.size, 0);
  const status = await pairingOfferStatus(store, { userId: "owner", tokenId: offer.id });
  assert.ok(status.ok && status.status === "denied");
});

test("kinds: a phone QR cannot pair a browser, and a browser code cannot pair a phone", async () => {
  const { store } = memoryStore();
  const offer = await phoneOffer(store);
  const asBrowser = await approvePairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: { kind: "browser", browserKey: null }, secret: SECRET });
  assert.equal(!asBrowser.ok && asBrowser.code, "wrong_kind");
  const browserOffer = await createPairingOffer(store, { userId: "owner", deviceId: "mac1", kind: "browser", secret: SECRET, appUrl: APP });
  assert.ok(browserOffer.ok && browserOffer.code);
  const asPhone = await approvePairingOffer(store, { userId: "owner", ref: { code: browserOffer.code! }, controller: phone, secret: SECRET });
  assert.equal(!asPhone.ok && asPhone.code, "wrong_kind");
});

test("browser: URL plus code pairs this browser by a fresh cookie key; the code works once", async () => {
  const { store, pairs } = memoryStore();
  const offer = await createPairingOffer(store, { userId: "owner", deviceId: "mac1", kind: "browser", secret: SECRET, appUrl: APP });
  assert.ok(offer.ok);
  assert.equal(offer.url, `${APP}/pair`);
  assert.match(offer.code!, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  const typed = offer.code!.toLowerCase().replace("-", " ");
  const approved = await approvePairingOffer(store, {
    userId: "owner",
    ref: { code: typed },
    controller: { kind: "browser", browserKey: null },
    secret: SECRET,
    browser: browserNameFrom("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"),
  });
  assert.ok(approved.ok);
  assert.equal(approved.pair.name, "Safari on macOS");
  assert.ok(approved.browserKey && approved.browserKey.length >= 32);
  assert.equal([...pairs.values()][0].browserKeyHash, sha256(approved.browserKey!));
  const reuse = await approvePairingOffer(store, { userId: "owner", ref: { code: typed }, controller: { kind: "browser", browserKey: null }, secret: SECRET });
  assert.equal(reuse.ok, false);

  const allowed = await checkRemotePair(store, { userId: "owner", deviceId: "mac1", controller: { kind: "browser", browserKey: approved.browserKey! } });
  assert.ok(allowed.ok);
  const otherBrowser = await checkRemotePair(store, { userId: "owner", deviceId: "mac1", controller: { kind: "browser", browserKey: "x".repeat(43) } });
  assert.equal(!otherBrowser.ok && otherBrowser.status, 403);
});

test("remote commands: refused without a pair, for another Mac, after revoke, and after the phone signs out", async () => {
  const { store, sessions } = memoryStore();
  const none = await checkRemotePair(store, { userId: "owner", deviceId: "mac1", controller: phone });
  assert.equal(!none.ok && none.code, "not_paired");
  const noCookie = await checkRemotePair(store, { userId: "owner", deviceId: "mac1", controller: { kind: "browser", browserKey: null } });
  assert.equal(!noCookie.ok && noCookie.status, 403);

  const offer = await phoneOffer(store);
  const approved = await approvePairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: phone, secret: SECRET });
  assert.ok(approved.ok);
  assert.ok((await checkRemotePair(store, { userId: "owner", deviceId: "mac1", controller: phone })).ok);
  const otherMac = await checkRemotePair(store, { userId: "owner", deviceId: "mac2", controller: phone });
  assert.equal(otherMac.ok, false, "a pair is for one Mac only");
  const otherPhone = await checkRemotePair(store, { userId: "owner", deviceId: "mac1", controller: { kind: "phone", deviceSessionId: "other-phone" } });
  assert.equal(otherPhone.ok, false, "a pair is for one phone only");

  sessions.get("phone-session")!.revoked = true;
  assert.equal((await checkRemotePair(store, { userId: "owner", deviceId: "mac1", controller: phone })).ok, false, "signing the phone out ends the pair");
  sessions.get("phone-session")!.revoked = false;
  assert.ok((await checkRemotePair(store, { userId: "owner", deviceId: "mac1", controller: phone })).ok);

  const intruderRevoke = await revokePair(store, { userId: "intruder", pairId: approved.pair.id });
  assert.equal(intruderRevoke.ok, false, "only the account revokes its pairs");
  assert.ok((await revokePair(store, { userId: "owner", pairId: approved.pair.id })).ok);
  assert.equal((await checkRemotePair(store, { userId: "owner", deviceId: "mac1", controller: phone })).ok, false, "revoking cuts access at once");
});

test("lists: the Mac's Remove list and the phone's Macs; re-pairing replaces the old pair", async () => {
  const { store } = memoryStore();
  for (let i = 0; i < 2; i++) {
    const offer = await phoneOffer(store);
    assert.ok((await approvePairingOffer(store, { userId: "owner", ref: { token: offer.token }, controller: phone, secret: SECRET })).ok);
  }
  const forMac = await listPairsForDevice(store, "owner", "mac1");
  assert.ok(Array.isArray(forMac));
  assert.equal(forMac.length, 1, "the second pairing revoked the first");
  assert.equal(forMac[0].deviceName, "Studio Mac");
  const forPhone = await listPairsForController(store, "owner", phone);
  assert.deepEqual(forPhone.map((p) => p.deviceId), ["mac1"]);
  const foreign = await listPairsForDevice(store, "intruder", "mac1");
  assert.equal(Array.isArray(foreign), false);
});

test("codes and cookies: normalisation and parsing", () => {
  assert.equal(normalizePairingCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizePairingCode("ABCD-EFGU"), null, "U is not in the alphabet");
  assert.equal(normalizePairingCode("ABCD-EFG0"), null, "nor is 0");
  assert.equal(normalizePairingCode("K7QM-4MZP"), "K7QM4MZP");
  assert.equal(normalizePairingCode(" k7qm 4mzp "), "K7QM4MZP");
  assert.equal(normalizePairingCode("K7QM4MZ"), null);
  assert.equal(normalizePairingCode(42), null);
  const key = "a".repeat(43);
  assert.equal(browserKeyFromCookie(`theme=dark; alevr_remote=${key}; other=1`), key);
  assert.equal(browserKeyFromCookie("alevr_remote=short"), null);
  assert.equal(browserKeyFromCookie(null), null);
});
