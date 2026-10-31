import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * window.alevr against Postgres, through the real routes and their production
 * wiring (src/lib/artifact-ai/server.ts): the ownership guard, the share and
 * publication lookups, the encryption, the advisory lock and the caps.
 *
 *   - by id, only the owner's artifact; by a share token, the visitor's own
 *     store, which the owner never reads;
 *   - values are ciphertext in the table and JSON again on the way out;
 *   - concurrent writes from one viewer cannot overshoot a cap;
 *   - a trashed artifact, a revoked share, a document and a static share
 *     (scripts off) all refuse;
 *   - a completion refused for budget reaches no provider.
 *
 * Skipped unless ARTIFACT_TEST_DATABASE_URL names a throwaway database (never
 * DATABASE_URL). Run it with:
 *
 *   DATABASE_URL=postgresql:///juno_artifact_ai \
 *   DIRECT_URL=postgresql:///juno_artifact_ai npx prisma migrate deploy
 *   ARTIFACT_TEST_DATABASE_URL=postgresql:///juno_artifact_ai \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/artifact-runtime.integration.test.ts
 */

const DB_URL = process.env.ARTIFACT_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

if (!DB_URL || !canMockModules) {
  test("artifact runtime database suite is skipped without ARTIFACT_TEST_DATABASE_URL and module mocks", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "artifact-runtime-test-secret";
  process.env.JUNO_PREVIEW_ORIGIN_PUBLIC = "1";
  process.env.ARTIFACT_AI_ENABLED = "1";
  delete process.env.OWNER_EMAILS;

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string | null } | null = null;

  test("stand in for the session", async () => {
    mock.module("@/lib/session", {
      namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn },
    });
  });

  const post = (body: unknown) =>
    new Request("http://juno.test/api/artifact-runtime", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
      body: JSON.stringify(body),
    });

  async function signUp(label: string) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return prisma.user.create({
      data: { email: `${label}-${suffix}@example.test`, name: label },
      select: { id: true, email: true, name: true },
    });
  }

  async function makeArtifact(userId: string, type: "REACT" | "MARKDOWN" = "REACT") {
    const artifact = await prisma.artifact.create({
      data: {
        userId,
        identifier: `app-${randomBytes(4).toString("hex")}`,
        type,
        title: "Score keeper",
        language: type === "REACT" ? "tsx" : null,
        currentVersion: 1,
        versions: { create: { version: 1, content: "export default function App(){return null}" } },
      },
      select: { id: true },
    });
    return artifact.id;
  }

  async function shareArtifact(userId: string, artifactId: string) {
    const token = randomBytes(24).toString("base64url");
    await prisma.share.create({
      data: { userId, kind: "ARTIFACT", artifactId, token, title: "Score keeper", snapshotAt: new Date() },
    });
    return token;
  }

  test("storage: by id the owner's, by link the visitor's own, sealed at rest", async () => {
    const { POST } = await import("@/app/api/artifact-runtime/storage/route");
    const owner = await signUp("owner");
    const visitor = await signUp("visitor");
    const artifactId = await makeArtifact(owner.id);
    const token = await shareArtifact(owner.id, artifactId);

    signedIn = owner;
    let res = await POST(post({ target: { artifactId }, op: "set", key: "best", value: { score: 10, name: "secret-owner-note" } }));
    assert.equal(res.status, 200, await res.clone().text());

    signedIn = visitor;
    // The visitor cannot reach the owner's store by id.
    res = await POST(post({ target: { artifactId }, op: "get", key: "best" }));
    assert.equal(res.status, 404);
    // Through the link, their own store: empty, then theirs.
    res = await POST(post({ target: { shareToken: token }, op: "get", key: "best" }));
    assert.deepEqual(await res.json(), { found: false, value: null });
    res = await POST(post({ target: { shareToken: token }, op: "set", key: "best", value: { score: 3 } }));
    assert.equal(res.status, 200);
    res = await POST(post({ target: { shareToken: token }, op: "list", prefix: "b" }));
    assert.deepEqual(await res.json(), { keys: ["best"] });

    signedIn = owner;
    res = await POST(post({ target: { artifactId }, op: "get", key: "best" }));
    assert.deepEqual(await res.json(), { found: true, value: { score: 10, name: "secret-owner-note" } });

    const rows = await prisma.artifactStorageEntry.findMany({ where: { artifactId }, orderBy: { userId: "asc" } });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row.value, /^enc:v\d:/);
      assert.doesNotMatch(row.value, /secret-owner-note|score/);
    }
    assert.deepEqual(new Set(rows.map((r) => r.userId)), new Set([owner.id, visitor.id]));
  });

  test("storage: concurrent writes from one viewer cannot overshoot a cap", async () => {
    // The production store and cipher with small caps, so the race is cheap to run.
    const { prismaArtifactStorageStore } = await import("@/lib/artifact-ai/storage-store");
    const { createArtifactStorage } = await import("@/lib/artifact-ai/storage");
    const { encryptField, decryptField } = await import("@/lib/field-crypto");
    const storage = createArtifactStorage({
      store: prismaArtifactStorageStore,
      seal: encryptField,
      open: decryptField,
      limits: { valueBytes: 1000, artifactBytes: 1000, artifactKeys: 1000, accountBytes: 2000 },
    });
    const owner = await signUp("filler");
    const artifactIds = await Promise.all(Array.from({ length: 6 }, () => makeArtifact(owner.id)));
    // 300 bytes an entry (key "kN" + a 298-byte JSON string): three fit in an
    // artifact, six in the account, and twenty-four are attempted at once.
    const valueJson = JSON.stringify("x".repeat(296));
    const results = await Promise.all(
      artifactIds.flatMap((artifactId) =>
        Array.from({ length: 4 }, (_, i) => storage.set({ artifactId, userId: owner.id }, `k${i}`, valueJson))
      )
    );
    assert.equal(results.filter((r) => r.ok).length, 6);
    assert.ok(results.every((r) => r.ok || r.code === "storage_full"));
    const total = await prisma.artifactStorageEntry.aggregate({ where: { userId: owner.id }, _sum: { bytes: true } });
    assert.equal(total._sum.bytes, 1800);
  });

  test("the account export hands a person their app storage back in clear, theirs only", async () => {
    const { POST } = await import("@/app/api/artifact-runtime/storage/route");
    const { GET } = await import("@/app/api/account/export/route");
    const owner = await signUp("exporter");
    const other = await signUp("other");
    const artifactId = await makeArtifact(owner.id);
    const token = await shareArtifact(owner.id, artifactId);
    signedIn = owner;
    for (const key of ["a", "b", "c"]) {
      assert.equal((await POST(post({ target: { artifactId }, op: "set", key, value: { key } }))).status, 200);
    }
    signedIn = other;
    assert.equal((await POST(post({ target: { shareToken: token }, op: "set", key: "theirs", value: 1 }))).status, 200);
    signedIn = owner;
    const res = await GET(new Request("http://juno.test/api/account/export"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { appStorage: { truncated: boolean; items: { artifactId: string; key: string; value: string }[] } };
    assert.equal(body.appStorage.truncated, false);
    assert.deepEqual(
      body.appStorage.items.map((item) => [item.artifactId, item.key, item.value]),
      [[artifactId, "a", '{"key":"a"}'], [artifactId, "b", '{"key":"b"}'], [artifactId, "c", '{"key":"c"}']]
    );
  });

  test("refusals: trashed artifact, revoked share, a document, scripts off", async () => {
    const { POST } = await import("@/app/api/artifact-runtime/storage/route");
    const owner = await signUp("refuser");
    const visitor = await signUp("refused-visitor");
    const trashed = await makeArtifact(owner.id);
    await prisma.artifact.updateMany({ where: { id: trashed, userId: owner.id }, data: { deletedAt: new Date() } });
    const doc = await makeArtifact(owner.id, "MARKDOWN");
    const live = await makeArtifact(owner.id);
    const token = await shareArtifact(owner.id, live);

    signedIn = owner;
    assert.equal((await POST(post({ target: { artifactId: trashed }, op: "get", key: "k" }))).status, 404);
    assert.equal((await POST(post({ target: { artifactId: doc }, op: "get", key: "k" }))).status, 409);

    signedIn = visitor;
    assert.equal((await POST(post({ target: { shareToken: token }, op: "get", key: "k" }))).status, 200);
    await prisma.share.updateMany({ where: { token, userId: owner.id }, data: { revokedAt: new Date() } });
    // `findActiveShare` is cached per request; each route call here is its own request.
    assert.equal((await POST(post({ target: { shareToken: token }, op: "get", key: "k" }))).status, 404);
    assert.equal((await POST(post({ target: { shareToken: "Z".repeat(32) }, op: "get", key: "k" }))).status, 404);

    process.env.JUNO_PREVIEW_ORIGIN_PUBLIC = "0";
    try {
      const fresh = await shareArtifact(owner.id, live);
      assert.equal((await POST(post({ target: { shareToken: fresh }, op: "get", key: "k" }))).status, 409);
    } finally {
      process.env.JUNO_PREVIEW_ORIGIN_PUBLIC = "1";
    }
  });

  test("a completion on a spent account is refused before any provider", async () => {
    const { POST } = await import("@/app/api/artifact-runtime/complete/route");
    const visitor = await signUp("spent");
    const owner = await signUp("author");
    const live = await makeArtifact(owner.id);
    const token = await shareArtifact(owner.id, live);
    // A cap of zero: nothing is left to admit against.
    await prisma.settings.upsert({
      where: { userId: visitor.id },
      create: { userId: visitor.id, monthlySpendCapEur: 0 },
      update: { monthlySpendCapEur: 0 },
    });
    signedIn = visitor;
    const res = await POST(post({ target: { shareToken: token }, prompt: "Hello" }));
    // 402 when a background model is configured; 409 when this machine has none.
    assert.ok(res.status === 402 || res.status === 409, String(res.status));
    const body = await res.json();
    assert.ok(body.code === "budget_exceeded" || body.code === "model_unavailable", body.code);
    assert.equal(await prisma.apiSpend.count({ where: { userId: visitor.id } }), 0);
    assert.equal(await prisma.apiSpend.count({ where: { userId: owner.id } }), 0);
  });

  test("disconnect", async () => {
    await prisma.$disconnect();
  });
}
