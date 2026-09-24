import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

/*
 * RECENTLY DELETED (Artifacts R1 §3B): deleting an artifact hides it for 30
 * days instead of destroying it, and its public link goes dark until it is
 * restored.
 *
 * Three layers:
 *  - Source: every hard delete of an artifact or a version lives in
 *    src/lib/artifact-trash.ts. That single module stands in for the deletion
 *    ledger until it lands (04-MERGE-PLAN §3.4), so "one place to audit" has
 *    to stay true. The job's wiring (npm script, PM2 app) is read here too.
 *  - Pure: the purge date and the retention floor.
 *  - Database: the real routes and share helpers against Postgres, because
 *    the promises here live in foreign keys and change-capture triggers as
 *    much as in the code — versions are tombstoned under the owner's account
 *    only if they go before their artifact, and a link survives a trash only
 *    because nothing touches its Share row.
 *
 * The list route's trash filter is tested against stand-ins in
 * tests/artifacts-list-route.test.ts; a stubbed `@/lib/prisma` cannot share a
 * process with the database suite below.
 *
 * The source and pure tests always run (the pure ones need the react-server
 * condition, as every server module does, and skip without it). The database
 * suite is skipped unless ARTIFACT_TEST_DATABASE_URL names a throwaway
 * database; it never falls back to DATABASE_URL. Run it with:
 *
 *   createdb juno_artifact_trash_test
 *   DATABASE_URL=postgresql:///juno_artifact_trash_test \
 *   DIRECT_URL=postgresql:///juno_artifact_trash_test npx prisma migrate deploy
 *   ARTIFACT_TEST_DATABASE_URL=postgresql:///juno_artifact_trash_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/artifact-trash.test.ts
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(rel);
  }
  return out;
}

const TRASH_MODULE = path.join("src", "lib", "artifact-trash.ts");

test("every hard delete of an artifact or a version is in artifact-trash.ts", () => {
  const offenders: string[] = [];
  for (const file of [...sourceFiles("src"), ...sourceFiles("scripts")]) {
    if (file === TRASH_MODULE) continue;
    const source = read(file);
    const calls = /\b(artifact|artifactVersion)\s*\.\s*(delete|deleteMany)\s*\(/g;
    for (const match of source.matchAll(calls)) {
      offenders.push(`${file}:${source.slice(0, match.index).split("\n").length}: ${match[0]}`);
    }
    // Nor by the side door of raw SQL.
    for (const match of source.matchAll(/DELETE\s+FROM\s+"(Artifact|ArtifactVersion)"/g)) {
      offenders.push(`${file}:${source.slice(0, match.index).split("\n").length}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "a hard delete outside the trash module skips the purge's rules and its audit point");

  const trash = read(TRASH_MODULE);
  const purge = trash.slice(trash.indexOf("export async function purgeArtifacts"));
  const versions = purge.indexOf("tx.artifactVersion.deleteMany(");
  const artifacts = purge.indexOf("tx.artifact.deleteMany(");
  assert.ok(versions > 0 && artifacts > versions, "versions go first, while their artifact still resolves the owner");
  assert.ok(purge.indexOf("FOR UPDATE") < versions, "the rows are locked, and re-checked, before anything goes");
});

test("the routes trash, and only Delete now or the rollback flag hard-deletes", () => {
  const route = read("src/app/api/artifacts/[id]/route.ts");
  assert.match(route, /where: \{ id, conversation: \{ userId \}, deletedAt: null \}/, "GET, POST and PATCH see live rows only");
  assert.match(route, /trashArtifact\(user\.id, artifact\.id\)/);
  assert.match(route, /purgeArtifacts\(tx, \[artifact\.id\], \{ requireTrashed: true \}\)/, "Delete now requires a trashed row");
  assert.match(route, /if \(!artifactTrashEnabled\(\)\) \{\s*await prisma\.\$transaction\(\(tx\) => purgeArtifacts\(tx, \[artifact\.id\], \{ requireTrashed: false \}\)\)/);
  assert.match(route, /\{ error: "not_in_trash" \}, \{ status: 409 \}/);

  assert.match(read("src/lib/design/store.ts"), /type: "DESIGN", conversation: \{ userId \}, deletedAt: null/);
  assert.match(read("src/app/api/artifacts/[id]/restore/route.ts"), /restoreArtifact\(user\.id, id\)/);
});

test("a trashed artifact's link goes dark, and the page asks before it counts a view", () => {
  const share = read("src/lib/share.ts");
  assert.match(share, /where: visibleConversationWhere\(\{ id: targetId, userId \}\)/, "no CHAT link to the anchor");
  assert.match(share, /where: \{ id: targetId, conversation: \{ userId \}, deletedAt: null \}/, "no new link to a trashed artifact");
  assert.match(share, /OR: \[\{ artifactId: null \}, \{ artifact: \{ deletedAt: null \} \}\]/, "listShares hides a trashed artifact's link");

  const page = read("src/app/share/[token]/page.tsx");
  const body = page.slice(page.indexOf("export default async function SharePage"));
  const gone = body.indexOf("if (await sharedArtifactIsTrashed(peeked)) return <ShareGone />;");
  assert.ok(gone > 0, "the page renders ShareGone for a trashed artifact");
  assert.ok(gone < body.indexOf("await getPublicShare(token)"), "the gone check runs before the view-counting lookup");

  const poster = read("src/app/share/[token]/poster/route.ts");
  assert.match(poster, /if \(await sharedArtifactIsTrashed\(share\)\) return gone\(\);/);
  assert.match(poster, /status: 410, headers: \{ "Cache-Control": "no-store" \}/);
});

test("the purge job is wired up, and dry unless armed", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["artifacts:purge"] ?? "", /tsx scripts\/purge-artifact-trash\.ts$/);

  const ecosystem = read("deploy/ecosystem.config.js");
  const app = ecosystem.slice(ecosystem.indexOf('name: "juno-artifact-purge"'));
  assert.ok(app.length < ecosystem.length, "PM2 runs the purge");
  assert.match(app.slice(0, 400), /args: "run artifacts:purge -- --daemon"/);

  const script = read("scripts/purge-artifact-trash.ts");
  assert.match(script, /purgeExpiredArtifacts\(\{ days, dryRun: DRY \}\)/);
  assert.match(script, /\[artifact-purge\] eligible=\$\{report\.eligible\} purged=\$\{report\.purged\}/);
  assert.match(script, /6 \* 60 \* 60 \* 1000/, "every six hours");

  // The gate is in the module, so it holds for any caller, not only the script.
  const trash = read(TRASH_MODULE);
  assert.match(trash, /const dry = dryRun \|\| !artifactPurgeArmed\(\);/);
  assert.match(read("deploy/VM_SETUP_GUIDE.md"), /## Maintenance: artifact trash purge/);
});

/** The trash module needs the react-server condition (it is `server-only`), which `npm test` does not set. */
async function loadTrash(t: TestContext) {
  try {
    return await import("@/lib/artifact-trash");
  } catch (err) {
    if (/Client Component/.test(String(err))) {
      t.skip("needs NODE_OPTIONS=--conditions=react-server");
      return null;
    }
    throw err;
  }
}

test("an artifact may be purged 30 days after it was trashed", async (t) => {
  const trash = await loadTrash(t);
  if (!trash) return;
  assert.equal(trash.TRASH_RETENTION_DAYS, 30);
  assert.equal(trash.purgeAtFor(new Date("2026-09-24T10:00:00Z")).toISOString(), "2026-10-24T10:00:00.000Z");
  assert.equal(trash.purgeAtFor(new Date("2026-09-24T10:00:00Z"), 45).toISOString(), "2026-11-08T10:00:00.000Z");
});

test("the purge refuses a window under a week before it reads anything", async (t) => {
  const trash = await loadTrash(t);
  if (!trash) return;
  for (const days of [0, 6, 6.5, -30, Number.NaN]) {
    await assert.rejects(trash.purgeExpiredArtifacts({ days, dryRun: true }), /at least 7/, String(days));
  }
  await assert.rejects(trash.purgeExpiredArtifacts({ days: 30, batchSize: 0, dryRun: true }), /Batch size/);
});

const DB_URL = process.env.ARTIFACT_TEST_DATABASE_URL;

if (!DB_URL) {
  test("artifact trash database suite is skipped without ARTIFACT_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  // Throwaway rows, throwaway key: nothing here should read a real keyring.
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "artifact-trash-test-secret";
  // Every flag at its shipped default unless a test says otherwise.
  delete process.env.JUNO_ARTIFACTS_TRASH;
  delete process.env.JUNO_ARTIFACTS_PURGE;

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  let signedIn: { id: string; email: string; name: string } | null = null;

  /** Stand-in for a client component the share page imports; never rendered here. */
  const Stub = () => null;
  const ShareGone = () => null;

  test("stand in for the session, the limiter and the share page's client components", async () => {
    mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });
    mock.module("@/lib/rate-limit", {
      namedExports: {
        rateLimit: async () => ({ success: true, remaining: 1, resetAt: new Date() }),
        ipFromHeaders: () => "203.0.113.9",
      },
    });
    // Next swaps in its react-server navigation for a server component; plain
    // Node would load the client build (tests/artifact-routes.test.ts).
    const serverNavigation = await import("next/dist/client/components/navigation.react-server");
    mock.module("next/navigation", { namedExports: { ...serverNavigation } });
    // Client modules need React's client API, which the react-server build of
    // React does not have; the test reads the element the page returns, and
    // never renders it, so each is a stand-in.
    mock.module("next/link", { defaultExport: Stub });
    mock.module("@/components/ui/button", { namedExports: { Button: Stub, buttonVariants: () => "" } });
    mock.module("@/components/brand/logo", { namedExports: { JunoMark: Stub, JunoLogo: Stub } });
    mock.module("@/components/share/share-gone", { namedExports: { ShareGone } });
    mock.module("@/components/share/shared-chat-transcript", { namedExports: { SharedChatTranscript: Stub } });
    mock.module("@/components/share/shared-artifact-viewer", { namedExports: { SharedArtifactViewer: Stub } });
    mock.module("@/components/share/report-share-dialog", { namedExports: { ReportShareButton: Stub } });
    mock.module("@/components/canvas/sandbox-document-frame", { namedExports: { SandboxProfileProvider: Stub } });
    // The page is compiled the classic JSX way here and looks for React globally.
    const React = await import("react");
    (globalThis as { React?: unknown }).React ??= React;
  });

  const params = <K extends string>(key: K, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<K, string>) });
  const request = (method: string, url: string, body?: unknown) =>
    new Request(`http://juno.test${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function signUp(label: string) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `artifact-trash-${label}-${suffix}@example.invalid`, name: "Artifact trash", emailVerified: new Date() },
    });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  /** A chat holding one artifact with `bodies.length` versions, v1 generated and the rest hand edits. */
  async function artifactWith(userId: string, type: "DESIGN" | "MARKDOWN", bodies: string[]) {
    const conversation = await prisma.conversation.create({ data: { userId, title: "Launch plan" } });
    return prisma.artifact.create({
      data: {
        conversationId: conversation.id,
        identifier: `launch-${Math.random().toString(16).slice(2, 8)}`,
        title: "Launch plan",
        type,
        currentVersion: bodies.length,
        versions: {
          create: bodies.map((content, i) => ({ version: i + 1, origin: i === 0 ? "generated" : "edit", content })),
        },
      },
      include: { versions: { orderBy: { version: "asc" } } },
    });
  }

  async function designBody() {
    const { serializeDesignDocument } = await import("../src/lib/design/migrations");
    const { signInDocument } = await import("./design-fixtures");
    return serializeDesignDocument(signInDocument());
  }

  async function shareArtifact(artifactId: string) {
    const route = await import("@/app/api/share/route");
    const res = await route.POST(request("POST", "/api/share", { kind: "ARTIFACT", artifactId }));
    assert.equal(res.status, 200, "the public link is made");
    return ((await res.json()) as { share: { id: string; token: string } }).share;
  }

  const artifactRoute = () => import("@/app/api/artifacts/[id]/route");
  const listRoute = () => import("@/app/api/artifacts/route");

  async function poster(token: string) {
    const { GET } = await import("@/app/share/[token]/poster/route");
    return GET(request("GET", `/share/${token}/poster`), params("token", token));
  }

  async function sharePage(token: string) {
    const { default: SharePage } = await import("@/app/share/[token]/page");
    return (await SharePage(params("token", token))) as { type: unknown };
  }

  async function listed(query = "") {
    const { GET } = await listRoute();
    const res = await GET(request("GET", `/api/artifacts${query}`));
    assert.equal(res.status, 200);
    return ((await res.json()) as { items: Array<{ id: string; deletedAt?: string; purgeAt?: string }> }).items;
  }

  test("trash hides an artifact everywhere; restore brings it back with the same link", async () => {
    const user = await signUp("trash");
    const art = await artifactWith(user.id, "DESIGN", [await designBody(), await designBody()]);
    const share = await shareArtifact(art.id);
    const ARTIFACT = art.id;
    const route = await artifactRoute();
    assert.equal((await poster(share.token)).status, 200, "the link draws before the trash");

    // Trash.
    const res = await route.DELETE(request("DELETE", `/api/artifacts/${ARTIFACT}`), params("id", ARTIFACT));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; trashed: boolean; purgeAt: string };
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: ARTIFACT } });
    assert.ok(row.deletedAt, "stamped, not deleted");
    assert.equal(row.deletedReason, "user");
    assert.deepEqual(body, { ok: true, trashed: true, purgeAt: new Date(row.deletedAt.getTime() + 30 * 86_400_000).toISOString() });
    assert.equal(row.updatedAt.getTime(), art.updatedAt.getTime(), "a trash is not an edit");
    assert.equal(await prisma.artifactVersion.count({ where: { artifactId: ARTIFACT } }), 2, "every version stays");

    // A retried delete answers the same, with the purge date it already had.
    const again = await route.DELETE(request("DELETE", `/api/artifacts/${ARTIFACT}`), params("id", ARTIFACT));
    assert.deepEqual(await again.json(), body);

    // The owner's routes no longer find it.
    assert.equal((await route.GET(request("GET", `/api/artifacts/${ARTIFACT}`), params("id", ARTIFACT))).status, 404);
    const saved = await route.POST(request("POST", `/api/artifacts/${ARTIFACT}`, { content: "{}", baseVersion: 2 }), params("id", ARTIFACT));
    assert.equal(saved.status, 404);
    const renamed = await route.PATCH(request("PATCH", `/api/artifacts/${ARTIFACT}`, { title: "Renamed" }), params("id", ARTIFACT));
    assert.equal(renamed.status, 404);
    const design = await import("@/app/api/design/[artifactId]/route");
    assert.equal((await design.GET(request("GET", `/api/design/${ARTIFACT}`), params("artifactId", ARTIFACT))).status, 404);
    assert.equal((await prisma.artifact.findUniqueOrThrow({ where: { id: ARTIFACT } })).title, "Launch plan");

    // Out of the library, into Recently deleted.
    assert.ok(!(await listed()).some((item) => item.id === ARTIFACT));
    const trashList = await listed("?deleted=1");
    assert.deepEqual(
      trashList.map((item) => [item.id, item.deletedAt, item.purgeAt]),
      [[ARTIFACT, row.deletedAt.toISOString(), body.purgeAt]]
    );

    // The public side: gone, not counted, not re-shareable, not listed.
    const { createShare, listShares, sharedArtifactIsTrashed, peekPublicShare } = await import("@/lib/share");
    const dark = await poster(share.token);
    assert.equal(dark.status, 410);
    assert.equal(dark.headers.get("cache-control"), "no-store");
    assert.equal((await sharePage(share.token)).type, ShareGone, "the page is the gone page");
    assert.equal((await prisma.share.findUniqueOrThrow({ where: { id: share.id } })).views, 0, "a dark link counts no view");
    const peeked = await peekPublicShare(share.token);
    assert.ok(peeked && (await sharedArtifactIsTrashed(peeked)));
    assert.equal(await createShare(user.id, "ARTIFACT", ARTIFACT), null, "no new link to a trashed artifact");
    assert.ok(!(await listShares(user.id)).some((s) => s.id === share.id), "its link leaves the owner's list");
    const shareRow = await prisma.share.findUniqueOrThrow({ where: { id: share.id } });
    assert.equal(shareRow.revokedAt, null, "the Share row itself is untouched");

    // Restore.
    const { POST: restore } = await import("@/app/api/artifacts/[id]/restore/route");
    const restored = await restore(request("POST", `/api/artifacts/${ARTIFACT}/restore`), params("id", ARTIFACT));
    assert.equal(restored.status, 200);
    const { artifact } = (await restored.json()) as { artifact: { id: string; currentVersion: number; deletedAt?: string } };
    assert.equal(artifact.id, ARTIFACT);
    assert.equal(artifact.currentVersion, 2);
    assert.equal("deletedAt" in artifact, false, "a live artifact serializes as it always did");
    const back = await prisma.artifact.findUniqueOrThrow({ where: { id: ARTIFACT } });
    assert.equal(back.deletedAt, null);
    assert.equal(back.deletedReason, null);
    assert.equal(back.updatedAt.getTime(), art.updatedAt.getTime(), "it returns to its own place in the library");

    // Idempotent.
    assert.equal((await restore(request("POST", `/api/artifacts/${ARTIFACT}/restore`), params("id", ARTIFACT))).status, 200);

    // The same token serves again, and everything reads it as live.
    assert.equal((await poster(share.token)).status, 200);
    assert.notEqual((await sharePage(share.token)).type, ShareGone);
    assert.ok((await listShares(user.id)).some((s) => s.id === share.id));
    assert.equal((await createShare(user.id, "ARTIFACT", ARTIFACT))?.id, share.id, "re-sharing reuses the same link");
    assert.equal((await route.GET(request("GET", `/api/artifacts/${ARTIFACT}`), params("id", ARTIFACT))).status, 200);
    assert.ok((await listed()).some((item) => item.id === ARTIFACT));
    assert.ok(!(await listed("?deleted=1")).some((item) => item.id === ARTIFACT));

    // Someone else's artifact is not theirs to trash, restore or list.
    await signUp("stranger");
    assert.equal((await route.DELETE(request("DELETE", `/api/artifacts/${ARTIFACT}`), params("id", ARTIFACT))).status, 404);
    assert.equal((await restore(request("POST", `/api/artifacts/${ARTIFACT}/restore`), params("id", ARTIFACT))).status, 404);
    assert.equal((await prisma.artifact.findUniqueOrThrow({ where: { id: ARTIFACT } })).deletedAt, null);
  });

  test("Delete now only empties the trash, versions first, each tombstoned under the owner", async () => {
    const user = await signUp("delete-now");
    const art = await artifactWith(user.id, "MARKDOWN", ["# v1", "# v2", "# v3"]);
    const share = await shareArtifact(art.id);
    const route = await artifactRoute();
    const now = (id: string) => route.DELETE(request("DELETE", `/api/artifacts/${id}?now=1`), params("id", id));

    const refused = await now(art.id);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "not_in_trash" });
    assert.equal(await prisma.artifactVersion.count({ where: { artifactId: art.id } }), 3, "a live row loses nothing");

    assert.equal((await route.DELETE(request("DELETE", `/api/artifacts/${art.id}`), params("id", art.id))).status, 200);
    const done = await now(art.id);
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { ok: true, deleted: true });

    assert.equal(await prisma.artifact.findUnique({ where: { id: art.id } }), null);
    assert.equal(await prisma.artifactVersion.count({ where: { artifactId: art.id } }), 0);
    assert.equal(await prisma.share.findUnique({ where: { id: share.id } }), null, "its link goes with it");

    // Every version tombstoned under the owner's account, before the artifact's own.
    const changes = await prisma.accountChange.findMany({
      where: { accountId: user.id, operation: "delete", entityId: { in: [art.id, ...art.versions.map((v) => v.id)] } },
      orderBy: { cursor: "asc" },
    });
    assert.deepEqual(
      new Set(changes.filter((c) => c.entityType === "artifact_version").map((c) => c.entityId)),
      new Set(art.versions.map((v) => v.id)),
      "one tombstone per version, all on the owner's feed"
    );
    const artifactTombstone = changes.find((c) => c.entityType === "artifact");
    assert.ok(artifactTombstone, "the artifact is tombstoned too");
    assert.ok(
      changes.filter((c) => c.entityType === "artifact_version").every((c) => c.cursor < artifactTombstone.cursor),
      "versions went first"
    );

    // A twin request after it is gone finds nothing to delete.
    assert.equal((await now(art.id)).status, 404);
  });

  test("with the trash off, a plain delete is the hard delete it was before", async () => {
    const user = await signUp("trash-off");
    const art = await artifactWith(user.id, "MARKDOWN", ["# v1", "# v2"]);
    const route = await artifactRoute();
    process.env.JUNO_ARTIFACTS_TRASH = "0";
    try {
      const res = await route.DELETE(request("DELETE", `/api/artifacts/${art.id}`), params("id", art.id));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, trashed: false });
    } finally {
      delete process.env.JUNO_ARTIFACTS_TRASH;
    }
    assert.equal(await prisma.artifact.findUnique({ where: { id: art.id } }), null);
    assert.equal(await prisma.artifactVersion.count({ where: { artifactId: art.id } }), 0);
  });

  test("the purge job takes only rows past the cutoff, and a dry run writes nothing", async () => {
    const { purgeExpiredArtifacts } = await import("@/lib/artifact-trash");
    const owner = await signUp("purge");
    const other = await signUp("purge-other");

    // A `now` in the past, so no row another test left in the trash (all
    // trashed "today") can fall inside the window: the counts are exact.
    const now = new Date("2020-03-01T00:00:00Z");
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const expired = await artifactWith(owner.id, "MARKDOWN", ["# old", "# older edit"]);
    const expiredElsewhere = await artifactWith(other.id, "MARKDOWN", ["# someone else's"]);
    const recent = await artifactWith(owner.id, "MARKDOWN", ["# recent"]);
    const live = await artifactWith(owner.id, "MARKDOWN", ["# live"]);
    await prisma.artifact.update({ where: { id: expired.id }, data: { deletedAt: daysAgo(31), deletedReason: "user" } });
    await prisma.artifact.update({ where: { id: expiredElsewhere.id }, data: { deletedAt: daysAgo(45), deletedReason: "user" } });
    await prisma.artifact.update({ where: { id: recent.id }, data: { deletedAt: daysAgo(29), deletedReason: "user" } });

    const snapshot = async () => ({
      artifacts: await prisma.artifact.count({ where: { id: { in: [expired.id, expiredElsewhere.id, recent.id, live.id] } } }),
      changes: await prisma.accountChange.count({ where: { accountId: { in: [owner.id, other.id] } } }),
    });
    const before = await snapshot();

    // Unarmed: dry whatever the caller asks.
    const unarmed = await purgeExpiredArtifacts({ now });
    assert.deepEqual([unarmed.eligible, unarmed.purged, unarmed.dryRun], [2, 0, true]);
    // Armed but asked for a dry run: still dry.
    process.env.JUNO_ARTIFACTS_PURGE = "1";
    try {
      const dry = await purgeExpiredArtifacts({ now, dryRun: true });
      assert.deepEqual([dry.eligible, dry.purged, dry.dryRun], [2, 0, true]);
      assert.deepEqual(await snapshot(), before, "a dry run writes nothing, not even a change row");

      const run = await purgeExpiredArtifacts({ now, batchSize: 1 });
      assert.deepEqual([run.eligible, run.purged, run.dryRun], [2, 2, false]);
      assert.equal(run.cutoff.toISOString(), daysAgo(30).toISOString());
    } finally {
      delete process.env.JUNO_ARTIFACTS_PURGE;
    }

    for (const gone of [expired, expiredElsewhere]) {
      assert.equal(await prisma.artifact.findUnique({ where: { id: gone.id } }), null);
      assert.equal(await prisma.artifactVersion.count({ where: { artifactId: gone.id } }), 0);
    }
    const kept = await prisma.artifact.findUniqueOrThrow({ where: { id: recent.id }, include: { versions: true } });
    assert.ok(kept.deletedAt, "29 days in, it is still in the trash");
    assert.equal(kept.versions.length, 1);
    assert.equal((await prisma.artifact.findUniqueOrThrow({ where: { id: live.id } })).deletedAt, null);

    const tombstoned = await prisma.accountChange.findMany({
      where: { operation: "delete", entityType: "artifact_version", entityId: { in: expired.versions.map((v) => v.id) } },
    });
    assert.deepEqual(new Set(tombstoned.map((c) => c.accountId)), new Set([owner.id]), "each version under its own account");
    assert.equal(tombstoned.length, 2);
  });

  test("a restored row survives a purge that listed it", async () => {
    const { purgeArtifacts } = await import("@/lib/artifact-trash");
    const user = await signUp("purge-race");
    const art = await artifactWith(user.id, "MARKDOWN", ["# v1", "# v2"]);
    // Listed while trashed, restored before the purge's transaction ran.
    await prisma.artifact.update({ where: { id: art.id }, data: { deletedAt: new Date(), deletedReason: "user" } });
    await prisma.artifact.update({ where: { id: art.id }, data: { deletedAt: null, deletedReason: null } });
    const purged = await prisma.$transaction((tx) => purgeArtifacts(tx, [art.id], { requireTrashed: true }));
    assert.equal(purged, 0);
    assert.equal(await prisma.artifactVersion.count({ where: { artifactId: art.id } }), 2, "not one version lost");
  });

  test("the anchor cannot be shared as a chat", async () => {
    const user = await signUp("anchor-share");
    // The row ensureArtifactHome writes (artifact-home.ts), made directly so
    // this suite does not depend on the delete path.
    await prisma.conversation.create({
      data: { id: `anchor_${user.id}`, userId: user.id, title: "Your artifacts", titleSource: "system", kind: "anchor" },
    });
    const { createShare } = await import("@/lib/share");
    assert.equal(await createShare(user.id, "CHAT", `anchor_${user.id}`), null);
    const chat = await prisma.conversation.create({ data: { userId: user.id, title: "A real chat" } });
    assert.ok(await createShare(user.id, "CHAT", chat.id), "an ordinary chat still shares");
  });

  test("clean up the throwaway accounts", async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: "artifact-trash-" } } });
    await prisma.$disconnect();
  });
}
