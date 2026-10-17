import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient, type ArtifactType } from "@prisma/client";

/*
 * G12 and G37 and the artifact lifecycle, against Postgres through the real
 * route handlers:
 *
 *   - the canvas draft (GET/PUT/DELETE /api/artifacts/[id]/draft): owner only,
 *     never a version, last write wins, a design refused, a base from the
 *     future refused, expired drafts dropped, the account export carries it;
 *   - Make a copy from a public link (POST /api/share/copy): the visitor's own
 *     artifact in a new chat of theirs, the version on the page only, no
 *     pointer into the owner's library, nothing for a design or a dark link;
 *   - the research reader's Word export (POST /api/research/[id]/export) and
 *     the run view's `reportArtifactId`.
 *
 * Skipped unless ARTIFACT_TEST_DATABASE_URL names a throwaway database (never
 * DATABASE_URL). Run it with:
 *
 *   DATABASE_URL=postgresql:///juno_canvas_draft \
 *   DIRECT_URL=postgresql:///juno_canvas_draft npx prisma migrate deploy
 *   ARTIFACT_TEST_DATABASE_URL=postgresql:///juno_canvas_draft \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/artifact-canvas-draft.integration.test.ts
 */

const DB_URL = process.env.ARTIFACT_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

if (!DB_URL || !canMockModules) {
  test("canvas draft and share copy database suite is skipped without ARTIFACT_TEST_DATABASE_URL and module mocks", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "canvas-draft-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;

  test("stand in for the session", async () => {
    mock.module("@/lib/session", {
      namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn },
    });
  });

  const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
  const request = (method: string, url = "/api", body?: unknown) =>
    new Request(`http://juno.test${url}`, {
      method,
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function signUp(label: string) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `canvas-draft-${label}-${suffix}@example.invalid`, name: "Canvas tester", emailVerified: new Date() },
    });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  async function artifactFor(userId: string, opts: { type?: ArtifactType; bodies?: string[]; title?: string } = {}) {
    const conversation = await prisma.conversation.create({ data: { userId, title: opts.title ?? "Pricing" } });
    const bodies = opts.bodies ?? ["<p>v1</p>"];
    return prisma.artifact.create({
      data: {
        userId,
        conversationId: conversation.id,
        identifier: `page-${Math.random().toString(16).slice(2, 8)}`,
        title: opts.title ?? "Pricing page",
        type: opts.type ?? "HTML",
        currentVersion: bodies.length,
        versions: { create: bodies.map((content, i) => ({ version: i + 1, content, origin: i === 0 ? "generated" : "edit" })) },
      },
    });
  }

  const draftRoute = () => import("@/app/api/artifacts/[id]/draft/route");

  // ─── G12: the canvas draft ──────────────────────────────────────────────

  test("an unsaved edit is kept, read back and replaced, and never becomes a version", async () => {
    const user = await signUp("draft");
    const artifact = await artifactFor(user.id, { bodies: ["<p>v1</p>", "<p>v2</p>"] });
    const { GET, PUT, DELETE } = await draftRoute();

    const empty = await GET(request("GET"), params({ id: artifact.id }));
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { draft: null });

    const first = await PUT(request("PUT", "/api", { content: "<p>half an edit</p>", baseVersion: 2 }), params({ id: artifact.id }));
    assert.equal(first.status, 200);
    const second = await PUT(request("PUT", "/api", { content: "<p>the whole edit</p>", baseVersion: 2 }), params({ id: artifact.id }));
    assert.equal(second.status, 200);

    const read = (await (await GET(request("GET"), params({ id: artifact.id }))).json()) as { draft: { content: string; baseVersion: number; updatedAt: string } };
    assert.equal(read.draft.content, "<p>the whole edit</p>", "last write wins");
    assert.equal(read.draft.baseVersion, 2);

    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    assert.equal(row.currentVersion, 2, "the head never moved");
    assert.equal(await prisma.artifactVersion.count({ where: { artifactId: artifact.id } }), 2);
    assert.equal(await prisma.artifactDraft.count({ where: { artifactId: artifact.id } }), 0, "not the design editor's working copy");

    // The sweeper that seals design drafts leaves it alone.
    const { sealIdleDrafts } = await import("@/lib/artifact-writes");
    await sealIdleDrafts({ now: new Date(Date.now() + 60 * 60_000), idleMs: 0 });
    assert.equal((await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).currentVersion, 2);

    const dropped = await DELETE(request("DELETE"), params({ id: artifact.id }));
    assert.deepEqual(await dropped.json(), { ok: true, discarded: true });
    const again = await DELETE(request("DELETE"), params({ id: artifact.id }));
    assert.deepEqual(await again.json(), { ok: true, discarded: false }, "idempotent");
    assert.deepEqual(await (await GET(request("GET"), params({ id: artifact.id }))).json(), { draft: null });
  });

  test("a save over a draft still meets the base check, and the draft survives the refusal", async () => {
    const user = await signUp("stale");
    const artifact = await artifactFor(user.id, { bodies: ["<p>v1</p>"] });
    const { PUT, GET } = await draftRoute();
    await PUT(request("PUT", "/api", { content: "<p>mine</p>", baseVersion: 1 }), params({ id: artifact.id }));
    // Someone else's write lands first.
    const { POST: save } = await import("@/app/api/artifacts/[id]/route");
    assert.equal((await save(request("POST", "/api", { content: "<p>theirs</p>", baseVersion: 1 }), params({ id: artifact.id }))).status, 200);
    const refused = await save(request("POST", "/api", { content: "<p>mine</p>", baseVersion: 1 }), params({ id: artifact.id }));
    assert.equal(refused.status, 409);
    const kept = (await (await GET(request("GET"), params({ id: artifact.id }))).json()) as { draft: { content: string } };
    assert.equal(kept.draft.content, "<p>mine</p>", "a refused save loses nothing");
  });

  test("only the owner reaches a draft; a design, a future base and an oversized body are refused", async () => {
    const owner = await signUp("owner");
    const artifact = await artifactFor(owner.id);
    const design = await artifactFor(owner.id, { type: "DESIGN", bodies: ["{}"] });
    const { PUT, GET, DELETE } = await draftRoute();
    await PUT(request("PUT", "/api", { content: "<p>secret edit</p>", baseVersion: 1 }), params({ id: artifact.id }));

    assert.equal((await PUT(request("PUT", "/api", { content: "{}", baseVersion: 1 }), params({ id: design.id }))).status, 409);
    const future = await PUT(request("PUT", "/api", { content: "x", baseVersion: 9 }), params({ id: artifact.id }));
    assert.equal(future.status, 409);
    assert.equal(((await future.json()) as { code: string }).code, "future_base");
    const huge = await PUT(request("PUT", "/api", { content: "x".repeat(200_001), baseVersion: 1 }), params({ id: artifact.id }));
    assert.equal(huge.status, 400);

    await signUp("stranger");
    assert.equal((await GET(request("GET"), params({ id: artifact.id }))).status, 404);
    assert.equal((await PUT(request("PUT", "/api", { content: "x", baseVersion: 1 }), params({ id: artifact.id }))).status, 404);
    assert.equal((await DELETE(request("DELETE"), params({ id: artifact.id }))).status, 404);
    assert.equal(
      (await prisma.artifactCanvasDraft.findFirstOrThrow({ where: { artifactId: artifact.id } })).content,
      "<p>secret edit</p>",
      "the stranger changed nothing"
    );

    signedIn = null;
    assert.equal((await GET(request("GET"), params({ id: artifact.id }))).status, 401);
  });

  test("a trashed artifact's draft is out of reach, and deleting the artifact takes it", async () => {
    const user = await signUp("trash");
    const artifact = await artifactFor(user.id);
    const { PUT, GET } = await draftRoute();
    await PUT(request("PUT", "/api", { content: "<p>edit</p>", baseVersion: 1 }), params({ id: artifact.id }));
    await prisma.artifact.update({ where: { id: artifact.id }, data: { deletedAt: new Date() } });
    assert.equal((await GET(request("GET"), params({ id: artifact.id }))).status, 404);
    await prisma.artifact.delete({ where: { id: artifact.id } });
    assert.equal(await prisma.artifactCanvasDraft.count({ where: { artifactId: artifact.id } }), 0, "cascade");
  });

  test("a draft past retention is dropped when it is next read", async () => {
    const user = await signUp("retention");
    const artifact = await artifactFor(user.id);
    const { readCanvasDraft, CANVAS_DRAFT_RETENTION_DAYS } = await import("@/lib/artifact-canvas-draft");
    await prisma.artifactCanvasDraft.create({ data: { artifactId: artifact.id, userId: user.id, baseVersion: 1, content: "old" } });
    const later = new Date(Date.now() + (CANVAS_DRAFT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    assert.equal(await readCanvasDraft(user.id, artifact.id, later), null);
    assert.equal(await prisma.artifactCanvasDraft.count({ where: { artifactId: artifact.id } }), 0);
  });

  test("the account export carries the unsaved edit", async () => {
    const user = await signUp("export");
    const artifact = await artifactFor(user.id);
    const { PUT } = await draftRoute();
    await PUT(request("PUT", "/api", { content: "<p>kept</p>", baseVersion: 1 }), params({ id: artifact.id }));
    const { GET } = await import("@/app/api/account/export/route");
    const res = await GET(request("GET", "/api/account/export"));
    assert.equal(res.status, 200);
    const body = JSON.parse(await res.text()) as { artifacts: { items: Array<{ id: string; unsavedEdit: { content: string; baseVersion: number } | null }> } };
    const item = body.artifacts.items.find((row) => row.id === artifact.id);
    assert.equal(item?.unsavedEdit?.content, "<p>kept</p>");
    assert.equal(item?.unsavedEdit?.baseVersion, 1);
  });

  // ─── Make a copy from a public link ─────────────────────────────────────

  async function publish(id: string, version: number | "latest") {
    const route = await import("@/app/api/artifacts/[id]/publication/route");
    const res = await route.POST(request("POST", "/api", { version }), params({ id }));
    return ((await res.json()) as { publication: { token: string } }).publication.token;
  }

  const copyRoute = () => import("@/app/api/share/copy/route");

  test("a visitor's copy of a publication is theirs: the shown version, in a new chat, with no pointer back", async () => {
    const owner = await signUp("pub-owner");
    const artifact = await artifactFor(owner.id, { bodies: ["<p>v1</p>", "<p>v2 private</p>"], title: "Landing page" });
    const token = await publish(artifact.id, 1);

    const visitor = await signUp("visitor");
    const { POST } = await copyRoute();
    const res = await POST(request("POST", "/api/share/copy", { token }));
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; conversationId: string; url: string; artifactUrl: string };
    const copy = await prisma.artifact.findUniqueOrThrow({ where: { id: body.id }, include: { versions: true } });
    assert.equal(copy.userId, visitor.id);
    assert.equal(copy.title, "Landing page (copy)");
    assert.equal(copy.derivedFromId, null, "no id into somebody else's library");
    assert.deepEqual(copy.versions.map((v) => v.content), ["<p>v1</p>"], "the published version only");
    const chat = await prisma.conversation.findUniqueOrThrow({ where: { id: body.conversationId } });
    assert.equal(chat.userId, visitor.id);
    assert.equal(copy.conversationId, chat.id);
    assert.equal(body.url, `/chat/${chat.id}?artifact=${encodeURIComponent(copy.identifier)}`);
    assert.equal(body.artifactUrl, `/a/${copy.id}`);
    // The owner's artifact is untouched.
    assert.equal((await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).currentVersion, 2);
  });

  test("the owner's own copy records where it came from; a legacy share copies its snapshot", async () => {
    const owner = await signUp("self");
    const artifact = await artifactFor(owner.id, { bodies: ["<p>one</p>"], title: "Notes" });
    const token = await publish(artifact.id, "latest");
    const { POST } = await copyRoute();
    const own = (await (await POST(request("POST", "/api/share/copy", { token }))).json()) as { id: string };
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: own.id } });
    assert.equal(row.derivedFromId, artifact.id);
    assert.equal(row.derivedFromVersion, 1);

    const shareRoute = await import("@/app/api/share/route");
    const shared = (await (await shareRoute.POST(request("POST", "/api/share", { kind: "ARTIFACT", artifactId: artifact.id }))).json()) as { share: { token: string } };
    await signUp("legacy-visitor");
    const res = await POST(request("POST", "/api/share/copy", { token: shared.share.token }));
    assert.equal(res.status, 201);
    const copy = await prisma.artifact.findUniqueOrThrow({ where: { id: ((await res.json()) as { id: string }).id }, include: { versions: true } });
    assert.deepEqual(copy.versions.map((v) => v.content), ["<p>one</p>"]);
  });

  test("a design, a dark link, a junk token and a signed-out visitor copy nothing", async () => {
    const owner = await signUp("refuse-owner");
    const design = await artifactFor(owner.id, { type: "DESIGN", bodies: ['{"pages":[]}'] });
    const designToken = await publish(design.id, 1);
    const page = await artifactFor(owner.id);
    const pageToken = await publish(page.id, 1);
    const pub = await import("@/app/api/artifacts/[id]/publication/route");
    await pub.DELETE(request("DELETE"), params({ id: page.id }));

    const visitor = await signUp("refuse-visitor");
    const before = await prisma.artifact.count({ where: { userId: visitor.id } });
    const { POST } = await copyRoute();
    assert.equal((await POST(request("POST", "/api/share/copy", { token: designToken }))).status, 409);
    assert.equal((await POST(request("POST", "/api/share/copy", { token: pageToken }))).status, 410);
    assert.equal((await POST(request("POST", "/api/share/copy", { token: "x".repeat(32) }))).status, 404);
    assert.equal((await POST(request("POST", "/api/share/copy", { token: "short" }))).status, 400);
    signedIn = null;
    assert.equal((await POST(request("POST", "/api/share/copy", { token: designToken }))).status, 401);
    assert.equal(await prisma.artifact.count({ where: { userId: visitor.id } }), before);
  });

  // ─── G37: the research report ───────────────────────────────────────────

  test("a finished report converts to a Word file that opens; an unfinished one does not", async () => {
    const user = await signUp("research");
    const finished = await prisma.researchRun.create({
      data: { userId: user.id, goal: "Heat pumps in cold climates", state: "completed", report: "# Heat pumps\n\nThey work [1].", finishedAt: new Date("2026-09-24T15:00:00Z") },
    });
    const live = await prisma.researchRun.create({ data: { userId: user.id, goal: "Still going", state: "searching" } });
    const { POST } = await import("@/app/api/research/[id]/export/route");
    const markdown = "# Heat pumps\n\nThey work [1].\n\n## Sources\n\n[1] Trial — https://example.no/trial (accessed 2026-09-24)\n";
    const res = await POST(request("POST", "/api", { format: "docx", markdown, title: "Heat pumps in cold climates" }), params({ id: finished.id }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /officedocument\.wordprocessingml/);
    assert.match(res.headers.get("Content-Disposition") ?? "", /filename="heat-pumps-in-cold-climates\.docx"/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), "PK", "a zip package");

    assert.equal((await POST(request("POST", "/api", { format: "docx", markdown }), params({ id: live.id }))).status, 409);
    assert.equal((await POST(request("POST", "/api", { format: "pdf", markdown }), params({ id: finished.id }))).status, 400);
    await signUp("research-stranger");
    assert.equal((await POST(request("POST", "/api", { format: "docx", markdown }), params({ id: finished.id }))).status, 404);
  });

  test("the run view names the saved report artifact once the run has finished", async () => {
    const user = await signUp("research-view");
    const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Research" } });
    const message = await prisma.message.create({ data: { conversationId: conversation.id, role: "ASSISTANT", content: "Summary" } });
    const run = await prisma.researchRun.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        goal: "Heat pumps",
        state: "completed",
        report: "# Heat pumps\n\nDone.",
        assistantMessageId: message.id,
        finishedAt: new Date(),
      },
    });
    const artifact = await prisma.artifact.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        messageId: message.id,
        identifier: `research-report-${run.id}`,
        title: "Heat pumps",
        type: "MARKDOWN",
        currentVersion: 1,
        versions: { create: { version: 1, content: "# Heat pumps", origin: "generated" } },
      },
    });
    const { readResearchRun } = await import("@/lib/research/run");
    const view = await readResearchRun({ runId: run.id, userId: user.id });
    assert.equal(view?.run.reportArtifactId, artifact.id);
    await prisma.artifact.update({ where: { id: artifact.id }, data: { deletedAt: new Date() } });
    assert.equal((await readResearchRun({ runId: run.id, userId: user.id }))?.run.reportArtifactId, null, "absent once trashed");
  });

  test("clean up the throwaway accounts", async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: "canvas-draft-" } } });
    await prisma.$disconnect();
  });
}
