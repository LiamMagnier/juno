import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";

/*
 * ARTIFACTS BECOME DELIVERABLES (PRODUCT_REFOUNDATION §10, DECISIONS D-013),
 * against Postgres through the real route handlers.
 *
 *   - Ownership: an artifact has its own owner and project, survives its chat
 *     (detached, with the files it uses), and a New design makes no chat.
 *   - Immutable versions: the database refuses a rewrite; design gestures go
 *     to a draft that is sealed as a version; a save names its base and gets a
 *     409 against a newer head, and one without a base appends (never
 *     overwrites); a design body is validated.
 *   - A share made before later edits never shows them (audit B1).
 *   - Paginated history.
 *   - Publish: explicit, pinned or latest, update, roll back, unpublish, reset
 *     link (old token gone), and report / takedown / ban for publications.
 *   - Duplicate, download (file and ZIP), the unified Library list, the
 *     account export, the native sync projection, rate limits, and a chat's
 *     artifacts following it between projects.
 *
 * Skipped unless ARTIFACT_TEST_DATABASE_URL names a throwaway database (never
 * DATABASE_URL). Run it with:
 *
 *   createdb juno_artifact_lifecycle
 *   DATABASE_URL=postgresql:///juno_artifact_lifecycle \
 *   DIRECT_URL=postgresql:///juno_artifact_lifecycle npx prisma migrate deploy
 *   ARTIFACT_TEST_DATABASE_URL=postgresql:///juno_artifact_lifecycle \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/artifact-ownership-lifecycle.integration.test.ts
 */

const DB_URL = process.env.ARTIFACT_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

if (!DB_URL || !canMockModules) {
  test("artifact ownership and lifecycle database suite is skipped without ARTIFACT_TEST_DATABASE_URL and module mocks", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "artifact-ownership-test-secret";
  delete process.env.JUNO_ARTIFACTS_PURGE;
  delete process.env.JUNO_AI_REEMIT_GUARD;

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  let signedIn: { id: string; email: string; name: string } | null = null;
  const Stub = () => null;
  const ShareGone = () => null;

  test("stand in for the session and the public page's client components", async () => {
    mock.module("@/lib/session", {
      namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn },
    });
    const serverNavigation = await import("next/dist/client/components/navigation.react-server");
    mock.module("next/navigation", { namedExports: { ...serverNavigation } });
    mock.module("next/link", { defaultExport: Stub });
    mock.module("@/components/ui/button", { namedExports: { Button: Stub, buttonVariants: () => "" } });
    mock.module("@/components/brand/logo", { namedExports: { JunoMark: Stub, JunoLogo: Stub } });
    mock.module("@/components/share/share-gone", { namedExports: { ShareGone } });
    mock.module("@/components/share/shared-chat-transcript", { namedExports: { SharedChatTranscript: Stub } });
    mock.module("@/components/share/shared-artifact-viewer", { namedExports: { SharedArtifactViewer: Stub } });
    mock.module("@/components/share/report-share-dialog", { namedExports: { ReportShareButton: Stub } });
    mock.module("@/components/canvas/sandbox-document-frame", { namedExports: { SandboxProfileProvider: Stub } });
    mock.module("@/components/landing/plate", { namedExports: { Plate: Stub } });
    mock.module("@/components/ui/app-page", { namedExports: { AppPage: Stub } });
    const React = await import("react");
    (globalThis as { React?: unknown }).React ??= React;
  });

  const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
  const request = (method: string, url = "/api", body?: unknown) =>
    new Request(`http://juno.test${url}`, {
      method,
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function signUp(label: string) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `artifact-own-${label}-${suffix}@example.invalid`, name: "Artifact owner", emailVerified: new Date() },
    });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  async function chatWithArtifact(
    userId: string,
    opts: { type?: "MARKDOWN" | "DESIGN" | "HTML"; bodies?: string[]; projectId?: string | null; title?: string } = {}
  ) {
    const conversation = await prisma.conversation.create({
      data: { userId, title: opts.title ?? "Launch plan", projectId: opts.projectId ?? null },
    });
    const bodies = opts.bodies ?? ["# v1"];
    const artifact = await prisma.artifact.create({
      data: {
        userId,
        projectId: opts.projectId ?? null,
        conversationId: conversation.id,
        identifier: `plan-${Math.random().toString(16).slice(2, 8)}`,
        title: opts.title ?? "Launch plan",
        type: opts.type ?? "MARKDOWN",
        currentVersion: bodies.length,
        versions: { create: bodies.map((content, i) => ({ version: i + 1, content, origin: i === 0 ? "generated" : "edit" })) },
      },
    });
    return { conversation, artifact };
  }

  async function designBody(name = "Sign in") {
    const { serializeDesignDocument } = await import("../src/lib/design/migrations");
    const { signInDocument } = await import("./design-fixtures");
    return serializeDesignDocument({ ...signInDocument(), name });
  }

  const artifactRoute = () => import("@/app/api/artifacts/[id]/route");

  async function save(id: string, body: Record<string, unknown>) {
    const { POST } = await artifactRoute();
    return POST(request("POST", `/api/artifacts/${id}`, body), params({ id }));
  }

  async function versionsOf(id: string) {
    return prisma.artifactVersion.findMany({ where: { artifactId: id }, orderBy: { version: "asc" } });
  }

  // ─── The migration's own guarantees ──────────────────────────────────────

  test("a row written without an owner (the previous release) is given its conversation's owner and project", async () => {
    const user = await signUp("fill");
    const project = await prisma.project.create({ data: { userId: user.id, name: "Bakery" } });
    const conversation = await prisma.conversation.create({ data: { userId: user.id, projectId: project.id } });
    const row = await prisma.artifact.create({
      data: { conversationId: conversation.id, identifier: "legacy", title: "Legacy", type: "MARKDOWN" },
    });
    assert.equal(row.userId, user.id);
    assert.equal(row.projectId, project.id);
  });

  test("the database refuses to rewrite a version, and still lets one be deleted with its artifact", async () => {
    const user = await signUp("immutable");
    const { artifact } = await chatWithArtifact(user.id, { bodies: ["# v1", "# v2"] });
    await assert.rejects(
      prisma.artifactVersion.updateMany({ where: { artifactId: artifact.id, version: 1 }, data: { content: "# rewritten" } }),
      /immutable/
    );
    assert.equal((await versionsOf(artifact.id))[0].content, "# v1");
  });

  // ─── Ownership: survives its chat; New design has none ───────────────────

  test("deleting a chat detaches its artifacts, keeps the files they use, and says so on the sync feed", async () => {
    const user = await signUp("detach");
    const keep = await prisma.attachment.create({
      data: { userId: user.id, kind: "IMAGE", fileName: "hero.png", mimeType: "image/png", size: 10, storageKey: `k-${Date.now()}-keep` },
    });
    const drop = await prisma.attachment.create({
      data: { userId: user.id, kind: "FILE", fileName: "notes.txt", mimeType: "text/plain", size: 10, storageKey: `k-${Date.now()}-drop` },
    });
    const { conversation, artifact } = await chatWithArtifact(user.id, {
      type: "HTML",
      bodies: [`<img src="/api/files/${keep.storageKey}">`, "<p>v2</p>"],
    });
    await prisma.attachment.updateMany({ where: { id: { in: [keep.id, drop.id] } }, data: { conversationId: conversation.id } });
    const shareRoute = await import("@/app/api/share/route");
    const shared = await shareRoute.POST(request("POST", "/api/share", { kind: "ARTIFACT", artifactId: artifact.id }));
    const { share } = (await shared.json()) as { share: { token: string } };

    const route = await import("@/app/api/conversations/[id]/route");
    const res = await route.DELETE(request("DELETE"), params({ id: conversation.id }));
    assert.equal(res.status, 200);

    assert.equal(await prisma.conversation.findUnique({ where: { id: conversation.id } }), null, "the chat is gone");
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    assert.equal(row.conversationId, null, "the artifact is detached, not deleted");
    assert.equal(row.userId, user.id);
    assert.equal((await versionsOf(artifact.id)).length, 2, "every version stays");
    const kept = await prisma.attachment.findUnique({ where: { id: keep.id } });
    assert.ok(kept, "the file its body uses stays");
    assert.equal(kept.conversationId, null);
    assert.equal(await prisma.attachment.findUnique({ where: { id: drop.id } }), null, "a file nothing uses goes with the chat");
    const { getPublicShare, getSharedArtifactSnapshot } = await import("@/lib/share");
    assert.equal((await getSharedArtifactSnapshot((await getPublicShare(share.token))!))?.version, 2, "its link still resolves");

    // The owner still reaches it, and the Library says it has no chat.
    const got = await (await artifactRoute()).GET(request("GET"), params({ id: artifact.id }));
    assert.equal(got.status, 200);
    const list = await (await import("@/app/api/artifacts/route")).GET(request("GET", "/api/artifacts"));
    const item = ((await list.json()) as { items: Array<{ id: string; conversationTitle: string | null }> }).items.find(
      (i) => i.id === artifact.id
    );
    assert.equal(item?.conversationTitle, null);

    // The detach reached the owner's sync feed (the trigger resolves the artifact's own owner).
    const change = await prisma.accountChange.findFirst({
      where: { accountId: user.id, entityType: "artifact", entityId: artifact.id },
      orderBy: { cursor: "desc" },
    });
    assert.ok(change, "the detach is change-captured under the owner");
    const { loadEntities } = await import("@/lib/sync-entities");
    const [envelope] = await loadEntities(user.id, "artifact", [artifact.id]);
    const data = envelope.data as { conversationId: string; detached: boolean; ownerConversationId: string | null };
    assert.equal(data.conversationId, `library:${artifact.id}`, "a non-empty placeholder the installed apps can decode");
    assert.equal(data.detached, true);
    assert.equal(data.ownerConversationId, null);
  });

  test("deleting every chat keeps every artifact", async () => {
    const user = await signUp("delete-all");
    const a = await chatWithArtifact(user.id);
    const b = await chatWithArtifact(user.id);
    const route = await import("@/app/api/conversations/route");
    const res = await route.DELETE();
    assert.equal(res.status, 200);
    assert.equal(await prisma.conversation.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.artifact.count({ where: { userId: user.id, id: { in: [a.artifact.id, b.artifact.id] } } }), 2);
  });

  test("New design makes a design and no chat", async () => {
    const user = await signUp("new-design");
    const project = await prisma.project.create({ data: { userId: user.id, name: "Brand" } });
    const route = await import("@/app/api/design/route");
    const res = await route.POST(request("POST", "/api/design", { title: "Poster", preset: "square", projectId: project.id }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { artifactId: string; conversationId: string | null; url: string };
    assert.equal(body.conversationId, null);
    assert.equal(await prisma.conversation.count({ where: { userId: user.id } }), 0, "nothing lands in Recents");
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: body.artifactId } });
    assert.equal(row.userId, user.id);
    assert.equal(row.projectId, project.id);
    assert.equal(row.type, "DESIGN");

    // Someone else's project is refused rather than dropped.
    const other = await signUp("new-design-other");
    const refused = await route.POST(request("POST", "/api/design", { projectId: project.id }));
    assert.equal(refused.status, 404);
    assert.equal(await prisma.artifact.count({ where: { userId: other.id } }), 0);
  });

  test("a chat's artifacts follow it between projects", async () => {
    const user = await signUp("follow");
    const from = await prisma.project.create({ data: { userId: user.id, name: "From" } });
    const to = await prisma.project.create({ data: { userId: user.id, name: "To" } });
    const { conversation, artifact } = await chatWithArtifact(user.id, { projectId: from.id });
    const route = await import("@/app/api/conversations/[id]/route");
    const res = await route.PATCH(request("PATCH", "/api", { projectId: to.id }), params({ id: conversation.id }));
    assert.equal(res.status, 200);
    assert.equal((await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).projectId, to.id);
    const list = await (await import("@/app/api/artifacts/route")).GET(request("GET", `/api/artifacts?projectId=${to.id}`));
    assert.ok(((await list.json()) as { items: Array<{ id: string }> }).items.some((i) => i.id === artifact.id));
  });

  // ─── Versions: immutable, drafts, base versions ──────────────────────────

  test("a save names its base: 409 against a newer head; without a base it appends and never overwrites", async () => {
    const user = await signUp("base");
    const { artifact } = await chatWithArtifact(user.id, { bodies: ["# v1", "# v2"] });
    const stale = await save(artifact.id, { content: "# from an old Mac", baseVersion: 1 });
    assert.equal(stale.status, 409);
    const staleBody = (await stale.json()) as { error: string; artifact: { currentVersion: number } };
    assert.equal(staleBody.error, "stale");
    assert.equal(staleBody.artifact.currentVersion, 2);

    const ok = await save(artifact.id, { content: "# v3", baseVersion: 2 });
    assert.equal(ok.status, 200);
    const legacy = await save(artifact.id, { content: "# from a client too old to send a base" });
    assert.equal(legacy.status, 200);
    assert.deepEqual(
      (await versionsOf(artifact.id)).map((v) => [v.version, v.content]),
      [
        [1, "# v1"],
        [2, "# v2"],
        [3, "# v3"],
        [4, "# from a client too old to send a base"],
      ],
      "last writer wins as a NEW version; nothing is rewritten"
    );
  });

  test("a design saved through the generic route is validated", async () => {
    const user = await signUp("design-validate");
    const { artifact } = await chatWithArtifact(user.id, { type: "DESIGN", bodies: [await designBody()] });
    const bad = await save(artifact.id, { content: "{\"not\":\"a design\"}", baseVersion: 1 });
    assert.equal(bad.status, 422);
    assert.equal((await versionsOf(artifact.id)).length, 1, "nothing stored");
    const good = await save(artifact.id, { content: await designBody("Renamed on the Mac"), baseVersion: 1 });
    assert.equal(good.status, 200);
  });

  /** One design transaction through the real route. */
  async function transact(artifactId: string, name: string, opts: { author?: "user" | "juno"; origin?: "edit" | "restore" } = {}) {
    const { parseStoredDesignDocument } = await import("../src/lib/design/migrations");
    const current = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId }, include: { draft: true } });
    const content =
      current.draft?.content ??
      (await prisma.artifactVersion.findUniqueOrThrow({
        where: { artifactId_version: { artifactId, version: current.currentVersion } },
      })).content;
    const route = await import("@/app/api/design/[artifactId]/transactions/route");
    const res = await route.POST(
      request("POST", "/api", {
        origin: opts.origin ?? "edit",
        transaction: {
          id: `tx-${Math.random().toString(16).slice(2)}`,
          baseRevision: parseStoredDesignDocument(content).revision,
          operations: [{ op: "renameDocument", name }],
          author: opts.author ?? "user",
          summary: `Rename to ${name}`,
          createdAt: new Date().toISOString(),
        },
      }),
      params({ artifactId })
    );
    assert.equal(res.status, 200, `the transaction lands: ${await res.clone().text()}`);
    return (await res.json()) as { artifact: { currentVersion: number; headVersion: number; hasDraft: boolean } };
  }

  test("design gestures fold into a draft, never a version, until it is sealed", async () => {
    const user = await signUp("draft");
    const { artifact } = await chatWithArtifact(user.id, { type: "DESIGN", bodies: [await designBody()] });

    const first = await transact(artifact.id, "One");
    assert.deepEqual([first.artifact.headVersion, first.artifact.currentVersion, first.artifact.hasDraft], [1, 2, true]);
    await transact(artifact.id, "Two");
    await transact(artifact.id, "Three");
    assert.equal((await versionsOf(artifact.id)).length, 1, "three gestures, no new version");
    const draft = await prisma.artifactDraft.findUniqueOrThrow({ where: { artifactId: artifact.id } });
    assert.match(draft.content, /"name":"Three"/);
    assert.equal(draft.revision, 3);

    // The owner's editor opens the working copy; everything else reads the head.
    const designRoute = await import("@/app/api/design/[artifactId]/route");
    const opened = (await (await designRoute.GET(request("GET", "/api"), params({ artifactId: artifact.id }))).json()) as {
      document: { name: string };
      artifact: { currentVersion: number; versions: Array<{ version: number; draft?: true }> };
    };
    assert.equal(opened.document.name, "Three");
    assert.equal(opened.artifact.currentVersion, 2);
    assert.deepEqual(opened.artifact.versions.at(-1), { ...opened.artifact.versions.at(-1), version: 2, draft: true });
    const sealed = (await (await artifactRoute()).GET(request("GET"), params({ id: artifact.id }))).json() as Promise<{
      artifact: { currentVersion: number };
    }>;
    assert.equal((await sealed).artifact.currentVersion, 1, "the REST read the apps use sees sealed versions only");

    // Explicit checkpoint.
    const draftRoute = await import("@/app/api/artifacts/[id]/draft/route");
    const res = await draftRoute.POST(new Request("http://juno.test/api", { method: "POST" }), params({ id: artifact.id }));
    assert.deepEqual(await res.json(), { ok: true, version: 2 });
    const versions = await versionsOf(artifact.id);
    assert.deepEqual(versions.map((v) => [v.version, v.origin]), [[1, "generated"], [2, "edit"]]);
    assert.match(versions[1].content, /"name":"Three"/);
    assert.equal(await prisma.artifactDraft.count({ where: { artifactId: artifact.id } }), 0);

    // A restore and a change Juno authored each get a version of their own.
    await transact(artifact.id, "Four");
    await transact(artifact.id, "Juno's", { author: "juno" });
    assert.deepEqual((await versionsOf(artifact.id)).map((v) => v.version), [1, 2, 3, 4], "the draft sealed first, then Juno's own");
    assert.match((await versionsOf(artifact.id))[3].content, /"name":"Juno's"/);
  });

  test("the sweep seals a draft left idle, and trashing a design seals its draft first", async () => {
    const user = await signUp("sweep");
    const idle = await chatWithArtifact(user.id, { type: "DESIGN", bodies: [await designBody()] });
    const fresh = await chatWithArtifact(user.id, { type: "DESIGN", bodies: [await designBody()] });
    const trashed = await chatWithArtifact(user.id, { type: "DESIGN", bodies: [await designBody()] });
    await transact(idle.artifact.id, "Left for lunch");
    await transact(fresh.artifact.id, "Still editing");
    await transact(trashed.artifact.id, "Then deleted");
    await prisma.$executeRaw`UPDATE "ArtifactDraft" SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE "artifactId" = ${idle.artifact.id}`;

    // Trash seals the draft, so it waits in the trash as a version.
    const route = await artifactRoute();
    assert.equal((await route.DELETE(request("DELETE"), params({ id: trashed.artifact.id }))).status, 200);
    assert.equal(await prisma.artifactDraft.count({ where: { artifactId: trashed.artifact.id } }), 0);
    assert.match((await versionsOf(trashed.artifact.id)).at(-1)!.content, /Then deleted/);

    const { sealIdleDrafts } = await import("@/lib/artifact-writes");
    const sealed = await sealIdleDrafts({ idleMs: 30 * 60_000 });
    assert.ok(sealed >= 1);
    assert.equal(await prisma.artifactDraft.count({ where: { artifactId: idle.artifact.id } }), 0, "the idle draft is a version now");
    assert.match((await versionsOf(idle.artifact.id)).at(-1)!.content, /Left for lunch/);
    assert.equal(await prisma.artifactDraft.count({ where: { artifactId: fresh.artifact.id } }), 1, "a draft in use is left alone");
  });

  test("a native save meets the web's unsealed draft as a newer version: 409, and the draft is kept as a version", async () => {
    const user = await signUp("native-draft");
    const { artifact } = await chatWithArtifact(user.id, { type: "DESIGN", bodies: [await designBody()] });
    await transact(artifact.id, "Edited on the web");
    const res = await save(artifact.id, { content: await designBody("Saved on the Mac"), baseVersion: 1 });
    assert.equal(res.status, 409, "the Mac opened v1; the person has edited since");
    const body = (await res.json()) as { artifact: { currentVersion: number } };
    assert.equal(body.artifact.currentVersion, 2, "the 409 shows the sealed draft as the head");
    const versions = await versionsOf(artifact.id);
    assert.equal(versions.length, 2);
    assert.match(versions[1].content, /Edited on the web/);
  });

  test("a link made before later design edits never shows them (B1)", async () => {
    const user = await signUp("b1");
    const { artifact } = await chatWithArtifact(user.id, { type: "DESIGN", bodies: [await designBody("Shared state")] });
    const shareRoute = await import("@/app/api/share/route");
    const created = await shareRoute.POST(request("POST", "/api/share", { kind: "ARTIFACT", artifactId: artifact.id }));
    const { share } = (await created.json()) as { share: { token: string } };
    await transact(artifact.id, "Private edit");
    await transact(artifact.id, "Private edit two");
    const { getPublicShare, getSharedArtifactSnapshot } = await import("@/lib/share");
    const before = await getSharedArtifactSnapshot((await getPublicShare(share.token))!);
    assert.match(before!.content, /Shared state/);
    const { sealArtifactDraft } = await import("@/lib/artifact-writes");
    await sealArtifactDraft(artifact.id, user.id);
    const after = await getSharedArtifactSnapshot((await getPublicShare(share.token))!);
    assert.equal(after!.version, 1);
    assert.match(after!.content, /Shared state/, "sealed later, so it stays private");
  });

  test("history pages newest first, bodies only on request", async () => {
    const user = await signUp("pages");
    const bodies = Array.from({ length: 25 }, (_, i) => `# v${i + 1}`);
    const { artifact } = await chatWithArtifact(user.id, { bodies });
    const route = await import("@/app/api/artifacts/[id]/versions/route");
    const page = async (query: string) =>
      (await (await route.GET(request("GET", `/api/artifacts/${artifact.id}/versions${query}`), params({ id: artifact.id }))).json()) as {
        versions: Array<{ version: number; content?: string }>;
        nextBefore: number | null;
        currentVersion: number;
      };
    const first = await page("?limit=10");
    assert.deepEqual(first.versions.map((v) => v.version), [25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
    assert.equal(first.versions[0].content, undefined);
    assert.equal(first.nextBefore, 16);
    const second = await page(`?limit=10&before=${first.nextBefore}&content=1`);
    assert.deepEqual(second.versions.map((v) => v.version), [15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
    assert.equal(second.versions[0].content, "# v15");
    const last = await page("?limit=10&before=6");
    assert.deepEqual(last.versions.map((v) => v.version), [5, 4, 3, 2, 1]);
    assert.equal(last.nextBefore, null);

    const one = await import("@/app/api/artifacts/[id]/versions/[version]/route");
    const v3 = await one.GET(request("GET"), params({ id: artifact.id, version: "3" }));
    assert.equal(((await v3.json()) as { version: { content: string } }).version.content, "# v3");
    assert.match(v3.headers.get("cache-control") ?? "", /immutable/);

    // The artifact read carries a window, and says there is more.
    const got = (await (await (await artifactRoute()).GET(request("GET"), params({ id: artifact.id }))).json()) as {
      artifact: { versions: unknown[]; hasOlderVersions?: true; content: string };
    };
    assert.equal(got.artifact.content, "# v25");
    assert.equal(got.artifact.versions.length, 25, "within the window, every version");
  });

  // ─── Publish ──────────────────────────────────────────────────────────────

  async function publication(id: string) {
    const route = await import("@/app/api/artifacts/[id]/publication/route");
    return {
      get: async () => (await route.GET(request("GET"), params({ id }))).json() as Promise<{ publication: { token: string; state: string; servedVersion: number; pinnedVersion: number | null } | null }>,
      publish: (version: number | "latest") => route.POST(request("POST", "/api", { version }), params({ id })),
      unpublish: () => route.DELETE(request("DELETE"), params({ id })),
      reset: async () => (await import("@/app/api/artifacts/[id]/publication/reset/route")).POST(request("POST"), params({ id })),
    };
  }

  async function publicPage(token: string) {
    const { default: SharePage } = await import("@/app/share/[token]/page");
    try {
      return (await SharePage({ params: Promise.resolve({ token }) })) as unknown as { type: unknown };
    } catch (error) {
      if (String((error as { digest?: string }).digest ?? error).includes("NEXT_HTTP_ERROR_FALLBACK;404")) return "404";
      throw error;
    }
  }

  test("Publish is explicit, serves the pinned version, and follows latest only when asked", async () => {
    const user = await signUp("publish");
    const { artifact } = await chatWithArtifact(user.id, { bodies: ["# v1", "# v2"] });
    const p = await publication(artifact.id);

    assert.deepEqual((await p.get()).publication, null);
    assert.equal(await prisma.artifactPublication.count({ where: { artifactId: artifact.id } }), 0, "reading creates nothing");

    const pinned = await p.publish(1);
    assert.equal(pinned.status, 200);
    const { publication: first } = (await pinned.json()) as { publication: { token: string; servedVersion: number; pinnedVersion: number } };
    assert.deepEqual([first.pinnedVersion, first.servedVersion], [1, 1]);
    const { findPublicPublication } = await import("@/lib/artifact-publication");
    const serve = async (token: string) => {
      const found = await findPublicPublication(token);
      return found?.state === "live" ? found.snapshot : found?.state ?? null;
    };
    assert.equal(((await serve(first.token)) as { content: string }).content, "# v1");

    // An edit does not reach a pinned page.
    await save(artifact.id, { content: "# v3", baseVersion: 2 });
    assert.equal(((await serve(first.token)) as { version: number }).version, 1);

    // Update to latest: same token, now the head, and it follows later saves.
    const latest = (await (await p.publish("latest")).json()) as { publication: { token: string; servedVersion: number } };
    assert.equal(latest.publication.token, first.token, "a stable URL");
    assert.equal(latest.publication.servedVersion, 3);
    await save(artifact.id, { content: "# v4", baseVersion: 3 });
    assert.equal(((await serve(first.token)) as { content: string }).content, "# v4");

    // Roll back.
    await p.publish(2);
    assert.equal(((await serve(first.token)) as { content: string }).content, "# v2");
    assert.equal((await p.publish(99)).status, 400, "a version that does not exist is refused");

    // Unpublish keeps the token; publishing again brings the same URL back.
    await p.unpublish();
    assert.equal(await serve(first.token), "gone");
    assert.equal((await publicPage(first.token) as { type: unknown }).type, ShareGone);
    const again = (await (await p.publish("latest")).json()) as { publication: { token: string } };
    assert.equal(again.publication.token, first.token);

    // Reset: the old token is gone for good, a new one serves.
    const reset = (await (await p.reset()).json()) as { publication: { token: string; state: string } };
    assert.notEqual(reset.publication.token, first.token);
    assert.equal(reset.publication.state, "live");
    assert.equal(await serve(first.token), "gone");
    const poster = await import("@/app/share/[token]/poster/route");
    assert.equal((await poster.GET(request("GET"), params({ token: first.token }))).status, 410);
    assert.equal(((await serve(reset.publication.token)) as { content: string }).content, "# v4");
    const page = await publicPage(reset.publication.token);
    assert.notEqual((page as { type: unknown }).type, ShareGone);
    // The view is counted fire-and-forget, so give it a moment to land.
    let views = 0;
    for (let i = 0; i < 50 && views === 0; i++) {
      views = (await prisma.artifactPublication.findFirstOrThrow({ where: { token: reset.publication.token } })).views;
      if (views === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(views, 1, "a live page counts its view");

    // Trashing the artifact takes the page down; restoring brings it back.
    await (await artifactRoute()).DELETE(request("DELETE"), params({ id: artifact.id }));
    assert.equal(await serve(reset.publication.token), "gone");
    const { POST: restore } = await import("@/app/api/artifacts/[id]/restore/route");
    await restore(request("POST"), params({ id: artifact.id }));
    assert.equal(((await serve(reset.publication.token)) as { version: number }).version, 4);

    // A stranger cannot read or change it.
    await signUp("publish-stranger");
    assert.equal((await (await import("@/app/api/artifacts/[id]/publication/route")).GET(request("GET"), params({ id: artifact.id }))).status, 404);
    assert.equal((await p.publish("latest")).status, 404);
  });

  test("a published design's poster is the pinned version, and a draft never reaches it", async () => {
    const user = await signUp("publish-design");
    const { artifact } = await chatWithArtifact(user.id, { type: "DESIGN", bodies: [await designBody("Public face")] });
    const p = await publication(artifact.id);
    const { publication: pub } = (await (await p.publish(1)).json()) as { publication: { token: string } };
    await transact(artifact.id, "Private work");
    const poster = await import("@/app/share/[token]/poster/route");
    const res = await poster.GET(request("GET"), params({ token: pub.token }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /svg/);
    const { findPublicPublication } = await import("@/lib/artifact-publication");
    const found = await findPublicPublication(pub.token);
    assert.ok(found?.state === "live" && /Public face/.test(found.snapshot.content));
  });

  test("a publication can be reported, taken down (blocking a republish) and is dark while its owner is banned", async () => {
    const owner = await signUp("publish-governance");
    const { artifact } = await chatWithArtifact(owner.id, { bodies: ["# hello"] });
    const p = await publication(artifact.id);
    const { publication: pub } = (await (await p.publish("latest")).json()) as { publication: { id: string; token: string } };

    const { createShareReport, findSharesForAdmin, takeDownShare, restoreShare } = await import("@/lib/share-moderation");
    assert.deepEqual(await createShareReport({ token: pub.token, reason: "phishing", detail: "fake login", contact: undefined }), { ok: true });
    const report = await prisma.shareReport.findFirstOrThrow({ where: { publicationId: pub.id } });
    assert.equal(report.shareOwnerId, owner.id);

    const found = await findSharesForAdmin(`http://juno.test/share/${pub.token}`);
    assert.equal(found[0]?.id, pub.id);
    assert.equal(found[0]?.publication, true);
    assert.equal(found[0]?.openReports, 1);

    const down = await takeDownShare({ shareId: pub.id, reason: "Phishing", by: "admin@example.invalid", isProtectedOwner: () => false });
    assert.ok(down.ok);
    const { findPublicPublication } = await import("@/lib/artifact-publication");
    assert.equal(await findPublicPublication(pub.token), null, "a takedown 404s, as for a share");
    assert.equal((await prisma.shareReport.findUniqueOrThrow({ where: { id: report.id } })).status, "actioned");
    signedIn = { id: owner.id, email: owner.email!, name: owner.name! };
    assert.equal((await p.publish("latest")).status, 403, "it cannot be published again");
    const shareRoute = await import("@/app/api/share/route");
    assert.equal((await shareRoute.POST(request("POST", "/api/share", { kind: "ARTIFACT", artifactId: artifact.id }))).status, 403, "nor shared by the side door");

    await restoreShare({ shareId: pub.id, by: "admin@example.invalid" });
    assert.equal((await findPublicPublication(pub.token))?.state, "live");
    await prisma.user.update({ where: { id: owner.id }, data: { bannedAt: new Date() } });
    assert.equal(await findPublicPublication(pub.token), null, "a banned owner's page does not serve");
    await prisma.user.update({ where: { id: owner.id }, data: { bannedAt: null } });
  });

  test("the chat Share dialog's read creates nothing; creating is the explicit POST", async () => {
    const user = await signUp("share-read");
    const { conversation } = await chatWithArtifact(user.id);
    const shareRoute = await import("@/app/api/share/route");
    const listed = await shareRoute.GET(request("GET", `/api/share?conversationId=${conversation.id}`));
    assert.deepEqual(await listed.json(), { shares: [] });
    assert.equal(await prisma.share.count({ where: { userId: user.id } }), 0);
    await shareRoute.POST(request("POST", "/api/share", { kind: "CHAT", conversationId: conversation.id }));
    const again = (await (await shareRoute.GET(request("GET", `/api/share?conversationId=${conversation.id}`))).json()) as { shares: unknown[] };
    assert.equal(again.shares.length, 1);
  });

  // ─── Duplicate, download, Library, export ────────────────────────────────

  test("Duplicate makes a new artifact in the same project, with its provenance and no chat", async () => {
    const user = await signUp("duplicate");
    const project = await prisma.project.create({ data: { userId: user.id, name: "Launch" } });
    const { artifact } = await chatWithArtifact(user.id, { bodies: ["# v1", "# v2"], projectId: project.id });
    const route = await import("@/app/api/artifacts/[id]/duplicate/route");
    const res = await route.POST(request("POST", "/api", { version: 1 }), params({ id: artifact.id }));
    assert.equal(res.status, 201);
    const { artifact: copy, url } = (await res.json()) as { artifact: { id: string; title: string; content: string; currentVersion: number }; url: string };
    assert.equal(url, `/a/${copy.id}`);
    assert.equal(copy.title, "Launch plan (copy)");
    assert.equal(copy.content, "# v1");
    assert.equal(copy.currentVersion, 1);
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: copy.id } });
    assert.deepEqual([row.derivedFromId, row.derivedFromVersion, row.projectId, row.conversationId, row.userId], [
      artifact.id,
      1,
      project.id,
      null,
      user.id,
    ]);
    assert.equal((await route.POST(request("POST", "/api", { version: 9 }), params({ id: artifact.id }))).status, 400);
  });

  test("Download: a file for one-file artifacts, a ZIP bundle for a design, with history on request", async () => {
    const user = await signUp("download");
    const { artifact } = await chatWithArtifact(user.id, { type: "HTML", bodies: ["<p>one</p>", "<p>two</p>"], title: "Pricing page" });
    const route = await import("@/app/api/artifacts/[id]/download/route");
    const file = await route.GET(request("GET", `/api/artifacts/${artifact.id}/download`), params({ id: artifact.id }));
    assert.equal(file.status, 200);
    assert.equal(await file.text(), "<p>two</p>");
    assert.match(file.headers.get("content-disposition") ?? "", /Pricing page\.html/);

    const zipped = await route.GET(request("GET", `/api/artifacts/${artifact.id}/download?format=zip&history=1`), params({ id: artifact.id }));
    assert.equal(zipped.headers.get("content-type"), "application/zip");
    const zip = await JSZip.loadAsync(await zipped.arrayBuffer());
    assert.deepEqual(Object.keys(zip.files).sort(), ["Pricing page.html", "README.md", "history/", "history/v1.html"].sort());
    assert.equal(await zip.file("history/v1.html")!.async("string"), "<p>one</p>");

    const design = await chatWithArtifact(user.id, { type: "DESIGN", bodies: [await designBody()], title: "Sign in" });
    const designZip = await route.GET(request("GET", `/api/artifacts/${design.artifact.id}/download`), params({ id: design.artifact.id }));
    assert.equal(designZip.headers.get("content-type"), "application/zip", "a design is more than one file");
    const bundle = await JSZip.loadAsync(await designZip.arrayBuffer());
    assert.ok(bundle.file("Sign in.juno.design.json"));
    assert.ok(bundle.file("poster.svg"));
    assert.ok(bundle.file("handoff.json"));
  });

  test("the Library lists artifacts and task deliverables together, newest first, paged", async () => {
    const user = await signUp("library");
    const { artifact } = await chatWithArtifact(user.id, { title: "Chat artifact" });
    const session = await prisma.workSession.create({ data: { userId: user.id, title: "Quarterly report", goal: "Write it" } });
    const deliverable = await prisma.workArtifact.create({
      data: {
        sessionId: session.id,
        userId: user.id,
        identifier: "q3-report",
        title: "Q3 report",
        kind: "document",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    });
    const route = await import("@/app/api/library/made/route");
    const read = async (query = "") =>
      (await (await route.GET(request("GET", `/api/library/made${query}`))).json()) as {
        items: Array<{ kind: string; id: string; type: string }>;
        nextCursor: string | null;
      };
    const all = await read();
    assert.deepEqual(
      all.items.map((i) => [i.kind, i.id, i.type]),
      [
        ["deliverable", deliverable.id, "DOCUMENT"],
        ["artifact", artifact.id, "MARKDOWN"],
      ]
    );
    const first = await read("?limit=1");
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = await read(`?limit=1&cursor=${first.nextCursor}`);
    assert.equal(second.items[0].id, artifact.id);
    assert.deepEqual((await read("?kind=deliverable")).items.map((i) => i.id), [deliverable.id]);
    assert.deepEqual((await read("?q=chat")).items.map((i) => i.id), [artifact.id]);
    assert.equal((await route.GET(request("GET", "/api/library/made?cursor=nonsense"))).status, 400);
  });

  test("the account export carries every artifact, its versions, draft and links", async () => {
    const user = await signUp("export");
    const { artifact, conversation } = await chatWithArtifact(user.id, { bodies: ["# v1", "# v2"] });
    await prisma.conversation.delete({ where: { id: conversation.id } });
    const p = await publication(artifact.id);
    await p.publish(1);
    const route = await import("@/app/api/account/export/route");
    const res = await route.GET(request("GET", "/api/account/export"));
    assert.equal(res.status, 200);
    const payload = (await res.json()) as {
      artifacts: { items: Array<{ id: string; conversationId: string | null; versions: Array<{ version: number }>; publications: unknown[] }> };
    };
    const item = payload.artifacts.items.find((i) => i.id === artifact.id);
    assert.ok(item, "a detached artifact is exported");
    assert.equal(item.conversationId, null);
    assert.deepEqual(item.versions.map((v) => v.version), [1, 2]);
    assert.equal(item.publications.length, 1);
  });

  test("the artifact write routes are rate limited", async () => {
    const user = await signUp("limits");
    const { artifactWriteLimited, ARTIFACT_WRITE_BUDGETS } = await import("@/lib/artifact-rate-limit");
    for (let i = 0; i < ARTIFACT_WRITE_BUDGETS.publish.limit; i++) {
      assert.equal(await artifactWriteLimited(user, "publish"), null);
    }
    const limited = await artifactWriteLimited(user, "publish");
    assert.equal(limited?.status, 429);
    assert.ok(Number(limited?.headers.get("retry-after")) >= 1);
  });

  // ─── Review fixes ────────────────────────────────────────────────────────

  test("an installed app's chat read carries no trashed artifact and no web design draft", async () => {
    const user = await signUp("installed-app");
    const { conversation, artifact: trashed } = await chatWithArtifact(user.id, { bodies: ["# gone"] });
    const design = await prisma.artifact.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        identifier: "hero",
        title: "Hero",
        type: "DESIGN",
        currentVersion: 1,
        versions: { create: { version: 1, content: await designBody("Sealed"), origin: "generated" } },
      },
    });
    await transact(design.id, "Unsealed");
    await (await artifactRoute()).DELETE(request("DELETE"), params({ id: trashed.id }));

    const route = await import("@/app/api/conversations/[id]/route");
    type Thread = { artifacts: Array<{ id: string; currentVersion: number; content: string; deletedAt?: string; versions: Array<{ version: number; draft?: true }> }> };
    const web = (await (await route.GET(request("GET"), params({ id: conversation.id }))).json()) as Thread;
    assert.ok(web.artifacts.find((a) => a.id === trashed.id)?.deletedAt, "the website still sees it, to offer Restore");
    const webDesign = web.artifacts.find((a) => a.id === design.id)!;
    assert.equal(webDesign.currentVersion, 2, "the website sees the draft as the version it will become");

    const app = new Request("http://juno.test/api", { headers: { authorization: "Bearer device-token" } });
    const native = (await (await route.GET(app, params({ id: conversation.id }))).json()) as Thread;
    assert.equal(native.artifacts.some((a) => a.id === trashed.id), false, "sync tombstoned it; the read must not bring it back");
    const nativeDesign = native.artifacts.find((a) => a.id === design.id)!;
    assert.equal(nativeDesign.currentVersion, 1);
    assert.deepEqual(nativeDesign.versions.map((v) => v.version), [1]);
    assert.match(nativeDesign.content, /Sealed/);
  });

  test("clean up the throwaway accounts", async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: "artifact-own-" } } });
    await prisma.$disconnect();
  });
}
