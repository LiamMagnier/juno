import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { chatTurnSource } from "./chat-turn-source";

/*
 * EDITING A MESSAGE OR REGENERATING AN ANSWER NEVER DELETES AN ARTIFACT.
 *
 * Both used to. The edit route ran `artifact.deleteMany` over every artifact a
 * later message had created, and the regenerate transaction did the same for
 * the answer being replaced (X-03 and X-04 in
 * docs/design/artifacts-design/00-AUDIT-OVERVIEW.md). The row cascades to its
 * versions and its share links, so fixing a typo in an early message erased
 * hand edits and turned public links into 404s, and a re-emitted identifier
 * came back under a new id.
 *
 * These drive the real route handlers — PATCH /api/messages/[id] and
 * POST /api/chat with `regenerate: true` — against Postgres, because the rule
 * lives in foreign keys (`messageId` is SetNull, versions and shares cascade)
 * as much as in the code. Only the session and the model are stand-ins. Each
 * artifact carries what the old code destroyed: a hand edit made through
 * POST /api/artifacts/[id] and a public link made through POST /api/share.
 *
 * The first two tests read the sources and always run. The database suite is
 * skipped unless ARTIFACT_TEST_DATABASE_URL names a throwaway database; it
 * never falls back to DATABASE_URL. Run it with:
 *
 *   createdb juno_artifact_test
 *   DATABASE_URL=postgresql:///juno_artifact_test \
 *   DIRECT_URL=postgresql:///juno_artifact_test npx prisma migrate deploy
 *   ARTIFACT_TEST_DATABASE_URL=postgresql:///juno_artifact_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/artifact-lifecycle.test.ts
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("no route deletes an artifact because a message went away", () => {
  const edit = read("src/app/api/messages/[id]/route.ts");
  assert.doesNotMatch(edit, /artifact\.delete/, "an edit leaves artifacts to the SetNull foreign key");
  const chat = chatTurnSource();
  assert.doesNotMatch(chat, /artifact\.delete/);
  // The regenerate overwrites the answer in place, so no foreign key fires:
  // it lets go of the answer's artifacts explicitly, in the same transaction.
  const start = chat.indexOf('if (mode === "supersede" && stale)');
  assert.ok(start > 0, "the supersede branch is where this test expects it");
  const supersede = chat.slice(start, chat.indexOf("prisma.message.update", start));
  assert.match(supersede, /prisma\.\$transaction\(\[[\s\S]*detachArtifactsFromMessage\(stale\.id, user\.id\)/);
});

test("a detached artifact is let go of, never deleted, and claimed by the next emission", () => {
  const store = read("src/lib/artifacts-store.ts");
  const detach = store.slice(store.indexOf("export function detachArtifactsFromMessage"));
  assert.match(detach.slice(0, 220), /artifact\.updateMany\(\{ where: \{ messageId, userId \}, data: \{ messageId: null \} \}\)/);
  assert.match(store, /\.\.\.\(existing\.messageId \? \{\} : \{ message: \{ connect: \{ id: messageId \} \} \}\)/);
});

const DB_URL = process.env.ARTIFACT_TEST_DATABASE_URL;

if (!DB_URL) {
  test("artifact lifecycle database suite is skipped without ARTIFACT_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  // The rows are throwaway, so a throwaway key: message text is encrypted at
  // rest, and nothing here should read the developer's real keyring.
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "artifact-lifecycle-test-secret";
  // These cases are about what an edit or a regenerate must never DELETE, and
  // they re-emit over a hand edit to prove the row survives and is claimed.
  // With the re-emit guard on (the default), such a re-emit waits as a
  // suggestion instead of appending; that behaviour has its own suite
  // (tests/artifact-ownership-lifecycle.integration.test.ts). Off here, so
  // these keep testing the append path they were written for.
  process.env.JUNO_AI_REEMIT_GUARD = "0";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const request = (method: string, body: unknown) =>
    new Request("http://juno.test/api", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const artifactTag = (identifier: string, title: string, content: string) =>
    `<juno:artifact identifier="${identifier}" type="markdown" title="${title}">${content}</juno:artifact>`;

  async function signUp(label: string) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: {
        email: `artifact-lifecycle-${label}-${suffix}@example.invalid`,
        name: "Artifact lifecycle",
        emailVerified: new Date(),
      },
    });
    // Every model needs a paid plan: a FREE account is refused at the paywall.
    await prisma.subscription.create({ data: { userId: user.id, plan: "PRO", status: "ACTIVE" } });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  /** A conversation whose messages sit one second apart, oldest first. */
  async function conversationWith(userId: string, turns: Array<{ role: "USER" | "ASSISTANT"; text: string }>) {
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const conversation = await prisma.conversation.create({ data: { userId, title: "Launch plan" } });
    const start = Date.now() - 60_000;
    const messages = [];
    for (const [i, turn] of turns.entries()) {
      messages.push(
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: turn.role,
            content: encryptMessageText(turn.text),
            createdAt: new Date(start + i * 1_000),
          },
        })
      );
    }
    return { conversation, messages };
  }

  /** What the old code destroyed: a hand edit and a public link, both through their routes. */
  async function handEditAndShare(artifactId: string, baseVersion: number, content: string) {
    const artifactRoute = await import("@/app/api/artifacts/[id]/route");
    const saved = await artifactRoute.POST(request("POST", { content, baseVersion }), params(artifactId));
    assert.equal(saved.status, 200, "the hand edit is saved");

    const shareRoute = await import("@/app/api/share/route");
    const shared = await shareRoute.POST(request("POST", { kind: "ARTIFACT", artifactId }));
    assert.equal(shared.status, 200, "the public link is made");
    const { share } = (await shared.json()) as { share: { token: string } };
    return share.token;
  }

  async function artifactRow(id: string) {
    return prisma.artifact.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: "asc" } }, shares: true },
    });
  }

  async function publicSnapshot(token: string) {
    const { getPublicShare, getSharedArtifactSnapshot } = await import("@/lib/share");
    const share = await getPublicShare(token);
    return share ? getSharedArtifactSnapshot(share) : null;
  }

  /**
   * Stand-in for the model: the next answer POST /api/chat streams. Every
   * provider reads as configured without a key being set, so nothing here can
   * reach a real provider; `after()` work (memory, moderation) is dropped,
   * since there is no request scope to run it in and it never touches
   * artifacts.
   */
  let nextAnswer = "";
  const outbound: string[] = [];
  test("stand in for the session and the model", async () => {
    // A tripwire, checked at the end: the stand-ins mean no request should
    // leave the process, and one that is swallowed by a catch would not fail
    // a test on its own.
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      outbound.push(url);
      throw new Error(`unexpected network call to ${url}`);
    };
    const server = await import("next/server");
    mock.module("next/server", { namedExports: { ...server, after: () => {} } });
    const providers = await import("@/lib/providers");
    mock.module("@/lib/providers", {
      namedExports: {
        ...providers,
        isProviderConfigured: () => true,
        configuredProviders: () => [...providers.PROVIDER_LIST],
      },
    });
    const llm = await import("@/lib/llm");
    mock.module("@/lib/llm", {
      namedExports: {
        ...llm,
        streamChat: async function* () {
          yield { type: "text", text: nextAnswer };
          yield { type: "usage", input: 12, output: nextAnswer.length };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
  });

  /** Drive POST /api/chat to completion and return its `done` frame. */
  async function regenerate(conversationId: string, answer: string) {
    nextAnswer = answer;
    const chatRoute = await import("@/app/api/chat/route");
    const res = await chatRoute.POST(request("POST", { conversationId, regenerate: true }));
    const body = await res.text();
    assert.equal(res.status, 200, `the regenerate is accepted: ${body}`);
    const frames = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; [key: string]: unknown });
    const done = frames.find((frame) => frame.type === "done");
    assert.ok(done, `the stream settles with a done frame; got ${frames.map((f) => f.type).join(", ")}`);
    return done as unknown as {
      message: { id: string };
      artifacts: Array<{ id: string; identifier: string; currentVersion: number; messageId: string | null }>;
    };
  }

  test("editing an earlier message keeps later artifacts, their hand edits and their public links", async () => {
    const user = await signUp("edit");
    const { persistArtifacts } = await import("@/lib/artifacts-store");
    const { conversation, messages } = await conversationWith(user.id, [
      { role: "USER", text: "Draft a launch plan." },
      { role: "ASSISTANT", text: artifactTag("launch-plan", "Launch plan", "# Plan v1") },
      { role: "USER", text: "Tighten it and add a checklist." },
      { role: "ASSISTANT", text: "Tightened." },
    ]);
    const [firstAsk, firstAnswer, , secondAnswer] = messages;

    const [plan] = await persistArtifacts(conversation.id, firstAnswer.id, [
      { identifier: "launch-plan", type: "MARKDOWN", title: "Launch plan", content: "# Plan v1" },
    ]);
    const token = await handEditAndShare(plan.id, 1, "# Plan, edited by hand");
    const [, checklist] = await persistArtifacts(conversation.id, secondAnswer.id, [
      { identifier: "launch-plan", type: "MARKDOWN", title: "Launch plan", content: "# Plan v3" },
      { identifier: "checklist", type: "MARKDOWN", title: "Checklist", content: "- [ ] ship" },
    ]);

    const messageRoute = await import("@/app/api/messages/[id]/route");
    const edited = await messageRoute.PATCH(
      request("PATCH", { content: "Draft a launch plan for the bakery." }),
      params(firstAsk.id)
    );
    assert.equal(edited.status, 200);

    // The truncation still happens: only the edited message is left.
    const left = await prisma.message.findMany({ where: { conversationId: conversation.id } });
    assert.deepEqual(left.map((m) => m.id), [firstAsk.id]);

    // Nothing the answers made is gone, and nothing changed identity.
    const planAfter = await artifactRow(plan.id);
    assert.ok(planAfter, "the plan survives the edit under its own id");
    assert.deepEqual(
      planAfter.versions.map((v) => [v.version, v.origin, v.content]),
      [
        [1, "generated", "# Plan v1"],
        [2, "edit", "# Plan, edited by hand"],
        [3, "generated", "# Plan v3"],
      ],
      "every version survives, the hand edit included"
    );
    assert.equal(planAfter.currentVersion, 3);
    assert.equal(planAfter.messageId, null, "detached from the answer that was edited away");
    assert.equal(planAfter.shares.length, 1);

    const checklistAfter = await artifactRow(checklist.id);
    assert.ok(checklistAfter, "an artifact made by a later answer survives too");
    assert.equal(checklistAfter.messageId, null);

    // The public link still resolves, to what was shared.
    const snapshot = await publicSnapshot(token);
    assert.ok(snapshot, "the public link does not 404");
    assert.equal(snapshot.content, "# Plan, edited by hand");

    // A reload shows both, and the open canvas can still save.
    const thread = await (await import("@/lib/queries")).getConversationThread(user.id, conversation.id);
    assert.deepEqual(thread?.artifacts.map((a) => [a.id, a.messageId]), [
      [plan.id, null],
      [checklist.id, null],
    ]);
    const artifactRoute = await import("@/app/api/artifacts/[id]/route");
    const saved = await artifactRoute.POST(request("POST", { content: "# Plan v4", baseVersion: 3 }), params(plan.id));
    assert.equal(saved.status, 200, "saving the open artifact after the edit is not a 404");

    // The answer to the edited message re-emits the identifier: it appends to
    // the same row and claims it, rather than starting over at v1.
    const done = await regenerate(conversation.id, artifactTag("launch-plan", "Launch plan", "# Bakery plan"));
    const reemitted = done.artifacts.find((a) => a.identifier === "launch-plan");
    assert.equal(reemitted?.id, plan.id, "the same artifact, not a new one");
    assert.equal(reemitted?.currentVersion, 5);
    assert.equal(reemitted?.messageId, done.message.id, "claimed by the answer that emitted it");

    const planFinal = await artifactRow(plan.id);
    assert.deepEqual(planFinal?.versions.map((v) => v.origin), ["generated", "edit", "generated", "edit", "generated"]);
    assert.equal((await publicSnapshot(token))?.content, "# Plan, edited by hand", "the link still shows what was shared");
  });

  test("regenerating an answer keeps its artifacts under their ids, with hand edits and public links", async () => {
    const user = await signUp("regenerate");
    const { persistArtifacts } = await import("@/lib/artifacts-store");
    const { conversation, messages } = await conversationWith(user.id, [
      { role: "USER", text: "Draft a launch plan and a checklist." },
      {
        role: "ASSISTANT",
        text:
          artifactTag("launch-plan", "Launch plan", "# Plan v1") + artifactTag("checklist", "Checklist", "- [ ] ship"),
      },
    ]);
    const [, answer] = messages;

    const [plan, checklist] = await persistArtifacts(conversation.id, answer.id, [
      { identifier: "launch-plan", type: "MARKDOWN", title: "Launch plan", content: "# Plan v1" },
      { identifier: "checklist", type: "MARKDOWN", title: "Checklist", content: "- [ ] ship" },
    ]);
    const planToken = await handEditAndShare(plan.id, 1, "# Plan, edited by hand");
    const checklistToken = await handEditAndShare(checklist.id, 1, "- [x] ship");

    // Try again: the new answer re-emits the plan and drops the checklist.
    const done = await regenerate(conversation.id, artifactTag("launch-plan", "Launch plan", "# Plan, take two"));

    assert.equal(done.message.id, answer.id, "the answer is overwritten in place");
    assert.equal(await prisma.messageVersion.count({ where: { messageId: answer.id } }), 1, "the old answer is kept");

    // The re-emitted identifier appends to the same row: same id, next version.
    assert.deepEqual(
      done.artifacts.map((a) => [a.identifier, a.id, a.currentVersion, a.messageId]),
      [["launch-plan", plan.id, 3, answer.id]]
    );
    const planAfter = await artifactRow(plan.id);
    assert.deepEqual(
      planAfter?.versions.map((v) => [v.version, v.origin, v.content]),
      [
        [1, "generated", "# Plan v1"],
        [2, "edit", "# Plan, edited by hand"],
        [3, "generated", "# Plan, take two"],
      ]
    );
    assert.equal(planAfter?.shares.length, 1);
    assert.equal((await publicSnapshot(planToken))?.content, "# Plan, edited by hand");

    // The artifact the new answer no longer emits stays, detached.
    const checklistAfter = await artifactRow(checklist.id);
    assert.ok(checklistAfter, "the dropped artifact is not deleted");
    assert.equal(checklistAfter.messageId, null, "detached from the regenerated answer");
    assert.deepEqual(checklistAfter.versions.map((v) => v.content), ["- [ ] ship", "- [x] ship"]);
    assert.equal((await publicSnapshot(checklistToken))?.content, "- [x] ship", "its public link still resolves");

    // Regenerating again finds the same rows again.
    const again = await regenerate(
      conversation.id,
      artifactTag("launch-plan", "Launch plan", "# Plan, take three") + artifactTag("checklist", "Checklist", "- [ ] ship it")
    );
    assert.deepEqual(
      again.artifacts.map((a) => [a.identifier, a.id, a.currentVersion, a.messageId]),
      [
        ["launch-plan", plan.id, 4, answer.id],
        ["checklist", checklist.id, 3, answer.id],
      ]
    );
  });

  test("nothing left the process", () => {
    assert.deepEqual(outbound, []);
  });

  test("clean up the throwaway accounts", async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: "artifact-lifecycle-" } } });
    await prisma.$disconnect();
  });
}
