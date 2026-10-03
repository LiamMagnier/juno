import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  decideReemit,
  describeStructureLoss,
  designStructureCounts,
  designStructureLoss,
  EDITED_SUMMARY,
  readProposalPayload,
} from "../src/lib/artifact-proposals";
import {
  describeHeldArtifactsForModel,
  holdArtifactBodies,
  parseArtifacts,
  splitMessageContent,
} from "../src/lib/message-content";
import { parseStoredDesignDocument, serializeDesignDocument } from "../src/lib/design/migrations";
import type { DesignDocument } from "../src/lib/design/types";
import { PAGE_ID, run, signInDocument, withTokens } from "./design-fixtures";

/*
 * A CHAT FOLLOW-UP NEVER WRITES OVER A PERSON'S WORK WITHOUT ASKING.
 *
 * (Taken from artifacts/r1-lifecycle, DECISIONS D-004, and adapted to
 * immutable versions: a design's unsealed draft counts as the person's edit,
 * and the design cases read the working copy the editor shows.)
 *
 * A re-emitted identifier used to become the current version whatever was
 * there, so a hand edit the model had never seen was replaced silently (X-05),
 * and a design lost every component, animation and comment the compact form
 * cannot carry (X-06). R1 holds such a re-emit as a suggestion
 * (`ArtifactProposal`) that the person applies or dismisses; the version list
 * only ever holds accepted work (04-MERGE-PLAN §2.7, §8.3).
 *
 * The first half is pure and always runs: the decision, the structure count,
 * and the tag grammar a held re-emit is saved in. The database half drives the
 * real routes (POST /api/chat, the proposal routes, POST /api/artifacts/[id],
 * the design transactions route, sharing) against Postgres, and includes the
 * plan's §8.10 exit checks: with a suggestion waiting, every other writer still
 * works and `currentVersion` still names the newest row. It is skipped unless
 * ARTIFACT_TEST_DATABASE_URL names a throwaway database, and never falls back
 * to DATABASE_URL:
 *
 *   ARTIFACT_TEST_DATABASE_URL=postgresql:///juno_artifact_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/artifact-reemit-guard.test.ts
 */

// ---------------------------------------------------------------------------
// Designs with and without the structure the compact form cannot carry
// ---------------------------------------------------------------------------

/** The sign-in screen with 1 component, 2 variables, 3 animations, 1 interaction, 1 comment and 2 effects. */
function richDesign(): DesignDocument {
  let doc = withTokens(signInDocument());
  doc = run(doc, [
    { op: "createComponent", nodeId: "button", componentId: "comp-button", name: "Button" },
    { op: "createAnimation", animation: { id: "a1", name: "Fade", durationMs: 300, loop: false, tracks: [] } },
    { op: "createAnimation", animation: { id: "a2", name: "Slide", durationMs: 300, loop: false, tracks: [] } },
    { op: "createAnimation", animation: { id: "a3", name: "Pop", durationMs: 300, loop: false, tracks: [] } },
    {
      op: "createInteraction",
      interaction: {
        id: "i1",
        sourceNodeId: "button",
        trigger: { type: "click" },
        action: { type: "back" },
        transition: { kind: "instant", durationMs: 0, delayMs: 0, easing: { type: "linear" }, matchStableIds: false },
      },
    },
    {
      op: "addEffect",
      nodeIds: ["card", "button"],
      effect: { type: "drop-shadow", color: { r: 0, g: 0, b: 0, a: 0.2 }, offsetX: 0, offsetY: 2, blur: 8, spread: 0 },
    },
  ]).document;
  return {
    ...doc,
    comments: [
      {
        id: "c1",
        nodeId: "title",
        pageId: PAGE_ID,
        x: 0,
        y: 0,
        body: "Tighter",
        authorId: "u1",
        createdAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: null,
        transactionId: null,
      },
    ],
  };
}

const RICH = serializeDesignDocument(richDesign());
const PLAIN = serializeDesignDocument(signInDocument());

// ---------------------------------------------------------------------------
// decideReemit
// ---------------------------------------------------------------------------

const base = { type: "MARKDOWN", currentContent: "# v1", nextContent: "# v2", enabled: true };

test("rule 1: a version a person wrote (edit or restore) holds the re-emit", () => {
  for (const origin of ["edit", "restore"]) {
    assert.deepEqual(decideReemit({ ...base, currentOrigin: origin }), {
      action: "suggest",
      reason: "edited",
      summary: "You edited this after Alevr's last version",
    });
  }
});

test("rule 3: Juno's own version, or a legacy row with no origin, appends", () => {
  assert.deepEqual(decideReemit({ ...base, currentOrigin: "generated" }), { action: "append" });
  assert.deepEqual(decideReemit({ ...base, currentOrigin: null }), { action: "append" });
});

test("the guard switched off appends, whatever the rules say", () => {
  assert.deepEqual(decideReemit({ ...base, currentOrigin: "edit", enabled: false }), { action: "append" });
  assert.deepEqual(
    decideReemit({ type: "DESIGN", currentOrigin: "generated", currentContent: RICH, nextContent: PLAIN, enabled: false }),
    { action: "append" }
  );
});

test("rule 2: a design re-emit that removes structure holds, even over Juno's own version", () => {
  const decision = decideReemit({ type: "DESIGN", currentOrigin: "generated", currentContent: RICH, nextContent: PLAIN, enabled: true });
  assert.equal(decision.action, "suggest");
  assert.equal(decision.action === "suggest" && decision.reason, "structure");
  assert.equal(
    decision.action === "suggest" && decision.summary,
    "Would remove 3 animations, 2 variables, 2 effects, 1 component, 1 interaction and 1 comment"
  );
  // A null origin does not excuse a loss: rule 2 comes before rule 3.
  assert.equal(decideReemit({ type: "DESIGN", currentOrigin: null, currentContent: RICH, nextContent: PLAIN, enabled: true }).action, "suggest");
});

test("both rules together are one summary, joined with a middle dot", () => {
  const decision = decideReemit({ type: "DESIGN", currentOrigin: "edit", currentContent: RICH, nextContent: PLAIN, enabled: true });
  assert.equal(decision.action === "suggest" && decision.reason, "both");
  assert.equal(
    decision.action === "suggest" && decision.summary,
    `${EDITED_SUMMARY} · Would remove 3 animations, 2 variables, 2 effects, 1 component, 1 interaction and 1 comment`
  );
});

test("a design re-emit that keeps or adds structure appends", () => {
  assert.deepEqual(
    decideReemit({ type: "DESIGN", currentOrigin: "generated", currentContent: RICH, nextContent: RICH, enabled: true }),
    { action: "append" }
  );
  assert.deepEqual(
    decideReemit({ type: "DESIGN", currentOrigin: "generated", currentContent: PLAIN, nextContent: RICH, enabled: true }),
    { action: "append" }
  );
});

test("only a DESIGN is compared for structure", () => {
  assert.deepEqual(
    decideReemit({ type: "HTML", currentOrigin: "generated", currentContent: RICH, nextContent: PLAIN, enabled: true }),
    { action: "append" }
  );
});

// ---------------------------------------------------------------------------
// designStructureLoss
// ---------------------------------------------------------------------------

test("designStructureCounts counts each category, effects summed across nodes", () => {
  assert.deepEqual(designStructureCounts(parseStoredDesignDocument(RICH)), {
    components: 1,
    variables: 2,
    animations: 3,
    interactions: 1,
    comments: 1,
    effects: 2,
  });
  assert.deepEqual(designStructureCounts(parseStoredDesignDocument(PLAIN)), {
    components: 0,
    variables: 0,
    animations: 0,
    interactions: 0,
    comments: 0,
    effects: 0,
  });
});

test("designStructureLoss reports each category that falls, by how much", () => {
  assert.deepEqual(designStructureLoss(RICH, PLAIN), {
    components: 1,
    variables: 2,
    animations: 3,
    interactions: 1,
    comments: 1,
    effects: 2,
  });
  // A partial drop counts: 3 animations down to 1 removes 2.
  const oneAnimation = richDesign();
  delete oneAnimation.animations.a2;
  delete oneAnimation.animations.a3;
  assert.deepEqual(designStructureLoss(RICH, serializeDesignDocument(oneAnimation)), { animations: 2 });
  assert.equal(designStructureLoss(RICH, RICH), null);
  assert.equal(designStructureLoss(PLAIN, RICH), null, "gaining structure is not a loss");
});

test("an unreadable current design is no loss, and so is an unreadable next one", () => {
  assert.equal(designStructureLoss("{not json", PLAIN), null);
  assert.equal(designStructureLoss(null, PLAIN), null);
  assert.equal(designStructureLoss(JSON.stringify({ nodes: [] }), PLAIN), null, "the compact form is not a stored document");
  assert.equal(designStructureLoss(RICH, "{not json"), null);
});

test("the loss reads largest first, in plain words", () => {
  assert.equal(describeStructureLoss({ animations: 3, components: 1 }), "3 animations and 1 component");
  assert.equal(describeStructureLoss({ comments: 1 }), "1 comment");
  assert.equal(describeStructureLoss({ effects: 2, variables: 2, interactions: 5 }), "5 interactions, 2 variables and 2 effects");
});

test("a proposal payload is read defensively", () => {
  assert.deepEqual(readProposalPayload({ content: "x", title: "T", language: "tsx" }), { content: "x", title: "T", language: "tsx" });
  assert.deepEqual(readProposalPayload({ content: "x" }), { content: "x", title: "", language: null });
  assert.equal(readProposalPayload({ title: "no content" }), null);
  assert.equal(readProposalPayload(["x"]), null);
  assert.equal(readProposalPayload(null), null);
});

// ---------------------------------------------------------------------------
// The saved tag grammar (04-MERGE-PLAN §3.7 E)
// ---------------------------------------------------------------------------

const REPLY =
  'Tightened the plan.\n\n<juno:artifact identifier="launch-plan" type="markdown" title="Launch plan">' +
  "# Plan v3</juno:artifact>\n\nAnd the checklist:\n\n" +
  '<juno:artifact identifier="checklist" type="markdown" title="Checklist">- [ ] ship</juno:artifact>';

test("holdArtifactBodies empties only the held tag and names its suggestion", () => {
  const held = holdArtifactBodies(REPLY, new Map([["launch-plan", "prop-123"]]));
  assert.equal(
    held,
    'Tightened the plan.\n\n<juno:artifact identifier="launch-plan" type="markdown" title="Launch plan" suggestion="prop-123"></juno:artifact>' +
      "\n\nAnd the checklist:\n\n" +
      '<juno:artifact identifier="checklist" type="markdown" title="Checklist">- [ ] ship</juno:artifact>',
    "the other tag and every word around them are untouched"
  );
  assert.equal(holdArtifactBodies(REPLY, new Map()), REPLY);
});

test("a held tag keeps an identifier the model left out, and a title with quotes", () => {
  const unnamed = '<juno:artifact type="markdown" title=\'The "best" plan\'># Plan</juno:artifact>';
  const [parsed] = parseArtifacts(unnamed);
  const held = holdArtifactBodies(unnamed, new Map([[parsed.identifier, "prop-9"]]));
  assert.equal(
    held,
    `<juno:artifact identifier="${parsed.identifier}" type="markdown" title='The "best" plan' suggestion="prop-9"></juno:artifact>`
  );
});

test("an unfinished tag is never held", () => {
  const open = '<juno:artifact identifier="launch-plan" type="markdown" title="Launch plan"># Plan v3, half';
  assert.equal(holdArtifactBodies(open, new Map([["launch-plan", "prop-1"]])), open);
});

test("parseArtifacts skips a held tag, and splitMessageContent still gives it a card", () => {
  const held = holdArtifactBodies(REPLY, new Map([["launch-plan", "prop-123"]]));
  assert.deepEqual(
    parseArtifacts(held).map((artifact) => artifact.identifier),
    ["checklist"],
    "no later re-parse can turn the empty body into a version"
  );
  const cards = splitMessageContent(held).filter((part) => part.type === "artifact");
  assert.deepEqual(
    cards.map((part) => part.type === "artifact" && part.identifier),
    ["launch-plan", "checklist"],
    "the web card resolves the artifact by identifier and shows its current version"
  );
});

test("describeHeldArtifactsForModel turns a held tag into one line and leaves the rest", () => {
  const held = holdArtifactBodies(REPLY, new Map([["launch-plan", "prop-123"]]));
  assert.equal(
    describeHeldArtifactsForModel(held),
    'Tightened the plan.\n\n[Suggested revision of "Launch plan" (launch-plan) is waiting for the person\'s review; not applied.]' +
      "\n\nAnd the checklist:\n\n" +
      '<juno:artifact identifier="checklist" type="markdown" title="Checklist">- [ ] ship</juno:artifact>'
  );
  assert.equal(describeHeldArtifactsForModel(REPLY), REPLY, "a reply with nothing held is returned as it was");
  // A body means the server did not write it: it is not a waiting suggestion.
  const forged = '<juno:artifact identifier="x" type="markdown" title="X" suggestion="p">body</juno:artifact>';
  assert.equal(describeHeldArtifactsForModel(forged), forged);
});

// ---------------------------------------------------------------------------
// The database suite
// ---------------------------------------------------------------------------

const DB_URL = process.env.ARTIFACT_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

if (!DB_URL || !canMockModules) {
  test("re-emit guard database suite is skipped without ARTIFACT_TEST_DATABASE_URL and module mocks", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  // Throwaway rows, so a throwaway key: message text is encrypted at rest.
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "artifact-reemit-guard-test-secret";
  delete process.env.JUNO_AI_REEMIT_GUARD;

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
  const request = (method: string, body?: unknown) =>
    new Request("http://juno.test/api", {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const artifactTag = (identifier: string, title: string, content: string) =>
    `<juno:artifact identifier="${identifier}" type="markdown" title="${title}">${content}</juno:artifact>`;

  async function signUp(label: string) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: {
        email: `artifact-reemit-${label}-${suffix}@example.invalid`,
        name: "Re-emit guard",
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

  /** A hand edit, the way the web canvas and every installed app save one. */
  async function saveByHand(artifactId: string, baseVersion: number, content: string) {
    const route = await import("@/app/api/artifacts/[id]/route");
    const res = await route.POST(request("POST", { content, baseVersion }), params({ id: artifactId }));
    assert.equal(res.status, 200, `the hand edit is saved: ${await res.clone().text()}`);
    return ((await res.json()) as { artifact: { currentVersion: number } }).artifact;
  }

  /** `currentVersion` names the newest row: the invariant every writer keeps (§3.9). */
  async function assertCurrentIsNewest(artifactId: string) {
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
    const newest = await prisma.artifactVersion.aggregate({ where: { artifactId }, _max: { version: true } });
    assert.equal(row.currentVersion, newest._max.version, "currentVersion = max(version)");
  }

  async function proposalsOf(artifactId: string) {
    return prisma.artifactProposal.findMany({ where: { artifactId }, orderBy: { createdAt: "asc" } });
  }

  /** A markdown plan: v1 by Juno, v2 by hand, and Juno's re-emit waiting as a suggestion. */
  async function heldPlan(label: string, reemit = "# Plan v3", title = "Launch plan") {
    const user = await signUp(label);
    const { persistArtifacts } = await import("@/lib/artifacts-store");
    const { conversation, messages } = await conversationWith(user.id, [
      { role: "USER", text: "Draft a launch plan." },
      { role: "ASSISTANT", text: artifactTag("launch-plan", "Launch plan", "# Plan v1") },
      { role: "USER", text: "Tighten it." },
      { role: "ASSISTANT", text: artifactTag("launch-plan", title, reemit) },
    ]);
    const [plan] = await persistArtifacts(conversation.id, messages[1].id, [
      { identifier: "launch-plan", type: "MARKDOWN", title: "Launch plan", content: "# Plan v1" },
    ]);
    await saveByHand(plan.id, 1, "# Plan, edited by hand");
    const [held] = await persistArtifacts(conversation.id, messages[3].id, [
      { identifier: "launch-plan", type: "MARKDOWN", title, content: reemit },
    ]);
    assert.ok(held.pendingSuggestion, "the re-emit waits as a suggestion");
    return { user, conversation, messages, plan, suggestion: held.pendingSuggestion };
  }

  const proposalRoutes = async () => ({
    get: (await import("@/app/api/artifacts/[id]/proposals/[proposalId]/route")).GET,
    apply: (await import("@/app/api/artifacts/[id]/proposals/[proposalId]/apply/route")).POST,
    dismiss: (await import("@/app/api/artifacts/[id]/proposals/[proposalId]/dismiss/route")).POST,
    poster: (await import("@/app/api/artifacts/[id]/proposals/[proposalId]/poster/route")).GET,
  });

  /**
   * Stand-in for the model: the next answer POST /api/chat streams, and a
   * record of the history each turn was given. Every provider reads as
   * configured without a key, so nothing here can reach a real one; `after()`
   * work is dropped (there is no request scope, and it never touches artifacts).
   */
  let nextAnswer = "";
  const histories: string[] = [];
  const outbound: string[] = [];
  test("stand in for the session and the model", async () => {
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
        streamChat: async function* (opts: { history: unknown }) {
          histories.push(JSON.stringify(opts.history));
          yield { type: "text", text: nextAnswer };
          yield { type: "usage", input: 12, output: nextAnswer.length };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
  });

  type DoneFrame = {
    message: { id: string };
    artifacts: Array<{
      id: string;
      identifier: string;
      currentVersion: number;
      pendingSuggestion?: { id: string; messageId: string | null; baseVersion: number; summary: string };
    }>;
  };

  /** Drive POST /api/chat to completion and return its `done` frame. */
  async function chat(body: Record<string, unknown>, answer: string): Promise<DoneFrame> {
    nextAnswer = answer;
    const chatRoute = await import("@/app/api/chat/route");
    const res = await chatRoute.POST(request("POST", body));
    const text = await res.text();
    assert.equal(res.status, 200, `the turn is accepted: ${text}`);
    const frames = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; [key: string]: unknown });
    const done = frames.find((frame) => frame.type === "done");
    assert.ok(done, `the stream settles with a done frame; got ${frames.map((f) => f.type).join(", ")}`);
    return done as unknown as DoneFrame;
  }

  async function savedText(messageId: string) {
    const { decryptMessageText } = await import("@/lib/message-crypto");
    const row = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    return decryptMessageText(row.content);
  }

  test("a re-emit over a hand edit appends no version: the suggestion waits, and the message holds an empty tag", async () => {
    const user = await signUp("held");
    const { persistArtifacts } = await import("@/lib/artifacts-store");
    const { conversation, messages } = await conversationWith(user.id, [
      { role: "USER", text: "Draft a launch plan." },
      { role: "ASSISTANT", text: artifactTag("launch-plan", "Launch plan", "# Plan v1") },
    ]);
    const [plan] = await persistArtifacts(conversation.id, messages[1].id, [
      { identifier: "launch-plan", type: "MARKDOWN", title: "Launch plan", content: "# Plan v1" },
    ]);
    await saveByHand(plan.id, 1, "# Plan, edited by hand");
    const before = await prisma.artifact.findUniqueOrThrow({ where: { id: plan.id } });

    const done = await chat(
      { conversationId: conversation.id, message: "Tighten it." },
      `Tightened.\n\n${artifactTag("launch-plan", "Launch plan", "# Plan v3")}`
    );

    // The client is told: same artifact, same version, a suggestion waiting on this turn.
    const reemitted = done.artifacts.find((a) => a.identifier === "launch-plan");
    assert.equal(reemitted?.id, plan.id);
    assert.equal(reemitted?.currentVersion, 2, "the hand edit is still current");
    assert.equal(reemitted?.pendingSuggestion?.messageId, done.message.id);
    assert.equal(reemitted?.pendingSuggestion?.baseVersion, 2);
    assert.equal(reemitted?.pendingSuggestion?.summary, EDITED_SUMMARY);

    // The row was not touched at all: no version, no bump, no sync churn.
    const after = await prisma.artifact.findUniqueOrThrow({ where: { id: plan.id }, include: { versions: { orderBy: { version: "asc" } } } });
    assert.deepEqual(after.versions.map((v) => [v.version, v.origin, v.content]), [
      [1, "generated", "# Plan v1"],
      [2, "edit", "# Plan, edited by hand"],
    ]);
    assert.equal(after.currentVersion, 2);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), "the Artifact row is never written for a suggestion");

    const [proposal, ...others] = await proposalsOf(plan.id);
    assert.equal(others.length, 0);
    assert.equal(proposal.status, "PENDING");
    assert.equal(proposal.role, "suggestion");
    assert.equal(proposal.kind, "REWRITE");
    assert.equal(proposal.messageId, done.message.id);
    assert.equal(proposal.baseVersion, 2);
    assert.equal(proposal.id, reemitted?.pendingSuggestion?.id);
    assert.deepEqual(proposal.payload, { content: "# Plan v3", title: "Launch plan", language: null });
    assert.equal(proposal.taint, null, "nothing untrusted was read in this turn");

    // The saved message: the empty legacy tag naming the proposal (§3.7 E).
    const saved = await savedText(done.message.id);
    assert.equal(
      saved,
      `Tightened.\n\n<juno:artifact identifier="launch-plan" type="markdown" title="Launch plan" suggestion="${proposal.id}"></juno:artifact>`
    );
    assert.deepEqual(parseArtifacts(saved), []);
    assert.ok(splitMessageContent(saved).some((part) => part.type === "artifact" && part.identifier === "launch-plan"));

    // The next turn's model reads that a suggestion is waiting, not an empty tag.
    histories.length = 0;
    await chat({ conversationId: conversation.id, message: "Thanks." }, "You're welcome.");
    const history = histories.at(-1) ?? "";
    assert.match(history, /\[Suggested revision of \\"Launch plan\\" \(launch-plan\) is waiting for the person's review; not applied\.\]/);
    assert.doesNotMatch(history, /suggestion=/);
    await assertCurrentIsNewest(plan.id);
  });

  test("Apply at the version compared appends Juno's version; at an older one it is stale", async () => {
    const { plan, conversation, messages, suggestion } = await heldPlan("apply", "# Plan v3", "Launch plan, tightened");
    const routes = await proposalRoutes();
    const ids = { id: plan.id, proposalId: suggestion!.id };

    const stale = await routes.apply(request("POST", { baseVersion: 1 }), params(ids));
    assert.equal(stale.status, 409);
    const staleBody = (await stale.json()) as { error: string; artifact: { currentVersion: number } };
    assert.equal(staleBody.error, "stale");
    assert.equal(staleBody.artifact.currentVersion, 2);
    await assertCurrentIsNewest(plan.id);

    const applied = await routes.apply(request("POST", { baseVersion: 2 }), params(ids));
    assert.equal(applied.status, 200);
    const { artifact } = (await applied.json()) as {
      artifact: { currentVersion: number; title: string; pendingSuggestion?: unknown; versions: Array<{ version: number; origin: string; content: string }> };
    };
    assert.equal(artifact.currentVersion, 3);
    assert.equal(artifact.title, "Launch plan", "Apply is about the body; the title stays the person's");
    assert.equal(artifact.pendingSuggestion, undefined, "nothing is waiting any more");
    assert.deepEqual(artifact.versions.at(-1) && [artifact.versions.at(-1)!.version, artifact.versions.at(-1)!.origin, artifact.versions.at(-1)!.content], [
      3,
      "generated",
      "# Plan v3",
    ]);
    const [proposal] = await proposalsOf(plan.id);
    assert.equal(proposal.status, "APPLIED");
    assert.ok(proposal.resolvedAt);
    await assertCurrentIsNewest(plan.id);

    const again = await routes.apply(request("POST", { baseVersion: 3 }), params(ids));
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, "resolved");
    await assertCurrentIsNewest(plan.id);

    // Juno's version is now current, so the next re-emit appends again.
    const { persistArtifacts } = await import("@/lib/artifacts-store");
    const [next] = await persistArtifacts(conversation.id, messages[3].id, [
      { identifier: "launch-plan", type: "MARKDOWN", title: "Launch plan", content: "# Plan v4" },
    ]);
    assert.equal(next.currentVersion, 4);
    assert.equal(next.pendingSuggestion, undefined);
  });

  test("Compare, Dismiss, and a newer suggestion making the older one STALE", async () => {
    const { plan, conversation, messages, suggestion: first } = await heldPlan("dismiss");
    const { persistArtifacts } = await import("@/lib/artifacts-store");
    const [held] = await persistArtifacts(conversation.id, messages[3].id, [
      { identifier: "launch-plan", type: "MARKDOWN", title: "Launch plan", content: "# Plan v3, again" },
    ]);
    const second = held.pendingSuggestion!;
    assert.notEqual(second.id, first!.id);
    const [older, newer] = await proposalsOf(plan.id);
    assert.equal(older.status, "STALE", "only the newest suggestion can be applied");
    assert.ok(older.resolvedAt);
    assert.equal(newer.status, "PENDING");

    const routes = await proposalRoutes();
    const compared = await routes.get(request("GET"), params({ id: plan.id, proposalId: second.id }));
    assert.equal(compared.status, 200);
    const compare = (await compared.json()) as {
      proposal: { id: string; baseVersion: number; status: string; type: string; title: string; content: string | null; summary: string };
      current: { version: number; content: string | null };
    };
    assert.deepEqual(compare.proposal.content, "# Plan v3, again");
    assert.equal(compare.proposal.type, "MARKDOWN");
    assert.equal(compare.proposal.baseVersion, 2);
    assert.equal(compare.proposal.summary, EDITED_SUMMARY);
    assert.deepEqual(compare.current, { version: 2, content: "# Plan, edited by hand" });

    const dismissed = await routes.dismiss(request("POST"), params({ id: plan.id, proposalId: second.id }));
    assert.equal(dismissed.status, 200);
    const body = (await dismissed.json()) as { artifact: { currentVersion: number; pendingSuggestion?: unknown } };
    assert.equal(body.artifact.currentVersion, 2, "dismissing changes nothing but the suggestion");
    assert.equal(body.artifact.pendingSuggestion, undefined);
    assert.equal((await prisma.artifactProposal.findUniqueOrThrow({ where: { id: second.id } })).status, "DISCARDED");

    const repeated = await routes.dismiss(request("POST"), params({ id: plan.id, proposalId: second.id }));
    assert.equal(repeated.status, 200, "a retried dismiss is not an error");
    const superseded = await routes.dismiss(request("POST"), params({ id: plan.id, proposalId: first!.id }));
    assert.equal(superseded.status, 409);
    assert.equal(((await superseded.json()) as { error: string }).error, "resolved");
    const applyDismissed = await routes.apply(request("POST", { baseVersion: 2 }), params({ id: plan.id, proposalId: second.id }));
    assert.equal(applyDismissed.status, 409);
    await assertCurrentIsNewest(plan.id);

    // Someone else's suggestion does not exist, as far as this account can tell.
    await signUp("dismiss-stranger");
    const foreign = await routes.get(request("GET"), params({ id: plan.id, proposalId: second.id }));
    assert.equal(foreign.status, 404);
  });

  test("a trashed artifact's suggestions 404, and re-emitting its identifier makes a new artifact", async () => {
    const { user, plan, conversation, messages, suggestion } = await heldPlan("trash");
    await prisma.artifact.update({ where: { id: plan.id }, data: { deletedAt: new Date() } });
    signedIn = { id: user.id, email: user.email!, name: user.name! };

    const routes = await proposalRoutes();
    const ids = params({ id: plan.id, proposalId: suggestion!.id });
    assert.equal((await routes.get(request("GET"), ids)).status, 404);
    assert.equal((await routes.apply(request("POST", { baseVersion: 2 }), params({ id: plan.id, proposalId: suggestion!.id }))).status, 404);
    assert.equal((await routes.dismiss(request("POST"), params({ id: plan.id, proposalId: suggestion!.id }))).status, 404);

    const { persistArtifacts } = await import("@/lib/artifacts-store");
    const out = await persistArtifacts(conversation.id, messages[3].id, [
      { identifier: "launch-plan", type: "MARKDOWN", title: "Launch plan", content: "# A fresh plan" },
    ]);
    assert.equal(out.length, 2, "the retired row and the new one both go back to the client");
    const [retired, created] = out;
    assert.equal(retired.id, plan.id);
    assert.equal(retired.identifier, `launch-plan~${plan.id.slice(-6)}`);
    assert.ok(retired.deletedAt, "it is still in Recently deleted");
    assert.notEqual(created.id, plan.id);
    assert.equal(created.identifier, "launch-plan");
    assert.equal(created.currentVersion, 1);
    const trashed = await prisma.artifact.findUniqueOrThrow({ where: { id: plan.id }, include: { versions: true } });
    assert.equal(trashed.versions.length, 2, "the trashed artifact gains nothing");
    assert.ok(trashed.deletedAt);
  });

  test("§8.10: with a suggestion waiting, a native-style save, sharing and Apply all behave", async () => {
    const { plan, suggestion } = await heldPlan("exit-markdown");

    // An installed app saves at the version it has; the suggestion does not block it.
    const saved = await saveByHand(plan.id, 2, "# Plan, saved on the Mac");
    assert.equal(saved.currentVersion, 3);
    await assertCurrentIsNewest(plan.id);
    assert.equal((await prisma.artifactProposal.findUniqueOrThrow({ where: { id: suggestion!.id } })).status, "PENDING");

    // A public link shows the current version, never the suggestion.
    const shareRoute = await import("@/app/api/share/route");
    const shared = await shareRoute.POST(request("POST", { kind: "ARTIFACT", artifactId: plan.id }));
    assert.equal(shared.status, 200);
    const { share } = (await shared.json()) as { share: { token: string } };
    const { getPublicShare, getSharedArtifactSnapshot } = await import("@/lib/share");
    const snapshot = await getSharedArtifactSnapshot((await getPublicShare(share.token))!);
    assert.equal(snapshot?.content, "# Plan, saved on the Mac");
    assert.equal(snapshot?.version, 3);

    // Apply against the version the suggestion was made on is stale now…
    const routes = await proposalRoutes();
    const ids = { id: plan.id, proposalId: suggestion!.id };
    assert.equal((await routes.apply(request("POST", { baseVersion: 2 }), params(ids))).status, 409);
    // …and against the version the person compared again, it lands.
    const applied = await routes.apply(request("POST", { baseVersion: 3 }), params(ids));
    assert.equal(applied.status, 200);
    await assertCurrentIsNewest(plan.id);
    assert.equal((await prisma.artifact.findUniqueOrThrow({ where: { id: plan.id } })).currentVersion, 4);
  });

  test("§8.10: a design with a suggestion waiting still takes transactions, and loses no structure", async () => {
    const user = await signUp("exit-design");
    const { persistArtifacts } = await import("@/lib/artifacts-store");
    const { conversation, messages } = await conversationWith(user.id, [
      { role: "USER", text: "Design a sign-in screen." },
      { role: "ASSISTANT", text: "Here it is." },
      { role: "USER", text: "Make the title bigger." },
      { role: "ASSISTANT", text: "Done." },
    ]);
    const [design] = await persistArtifacts(conversation.id, messages[1].id, [
      { identifier: "sign-in", type: "DESIGN", title: "Sign in", content: RICH },
    ]);
    await assertCurrentIsNewest(design.id);

    // Rule 2 alone: Juno's own version, and a re-emit that would drop structure.
    const [held] = await persistArtifacts(conversation.id, messages[3].id, [
      { identifier: "sign-in", type: "DESIGN", title: "Sign in", content: PLAIN },
    ]);
    assert.equal(held.currentVersion, 1);
    assert.match(held.pendingSuggestion?.summary ?? "", /^Would remove 3 animations/);
    await assertCurrentIsNewest(design.id);

    // A design transaction while it waits.
    const transactions = await import("@/app/api/design/[artifactId]/transactions/route");
    // The editor's working copy: the draft once a gesture has landed, the head
    // before that (src/lib/artifact-writes.ts).
    const workingContent = async () => {
      const current = await prisma.artifact.findUniqueOrThrow({ where: { id: design.id }, include: { draft: true } });
      if (current.draft) return { content: current.draft.content, version: current.currentVersion + 1 };
      const row = await prisma.artifactVersion.findUniqueOrThrow({
        where: { artifactId_version: { artifactId: design.id, version: current.currentVersion } },
      });
      return { content: row.content, version: current.currentVersion };
    };
    const commit = async (name: string) => {
      const revision = parseStoredDesignDocument((await workingContent()).content).revision;
      const res = await transactions.POST(
        request("POST", {
          transaction: {
            id: `tx-${name}-${Math.random().toString(16).slice(2)}`,
            baseRevision: revision,
            operations: [{ op: "renameDocument", name }],
            author: "user",
            summary: `Rename to ${name}`,
            createdAt: new Date().toISOString(),
          },
        }),
        params({ artifactId: design.id })
      );
      assert.equal(res.status, 200, `the transaction lands: ${await res.clone().text()}`);
    };
    await commit("Sign in, renamed");
    await assertCurrentIsNewest(design.id);
    await commit("Sign in, renamed again");
    await assertCurrentIsNewest(design.id);

    const routes = await proposalRoutes();
    const ids = { id: design.id, proposalId: held.pendingSuggestion!.id };
    const compared = (await (await routes.get(request("GET"), params(ids))).json()) as {
      proposal: { content: string | null; type: string };
      current: { content: string | null };
    };
    assert.equal(compared.proposal.type, "DESIGN");
    assert.equal(compared.proposal.content, null, "a design is compared as two pictures");
    assert.equal(compared.current.content, null);
    const poster = await routes.poster(new Request("http://juno.test/api/poster"), params(ids));
    assert.equal(poster.status, 200);
    assert.match(poster.headers.get("content-type") ?? "", /svg/);

    // Now a person has edited too: a further re-emit is held for both reasons,
    // and supersedes the first.
    const [again] = await persistArtifacts(conversation.id, messages[3].id, [
      { identifier: "sign-in", type: "DESIGN", title: "Sign in", content: PLAIN },
    ]);
    assert.match(again.pendingSuggestion?.summary ?? "", new RegExp(`^${EDITED_SUMMARY} · Would remove`));
    // Apply names the version on the person's screen: the working copy, which
    // presents the unsealed draft as the version it becomes when sealed.
    const onScreen = await workingContent();
    const applied = await routes.apply(
      request("POST", { baseVersion: onScreen.version }),
      params({ id: design.id, proposalId: again.pendingSuggestion!.id })
    );
    assert.equal(applied.status, 200);
    await assertCurrentIsNewest(design.id);

    // And the design route still opens it after Apply.
    const reread = await transactions.GET(request("GET"), params({ artifactId: design.id }));
    assert.equal(reread.status, 200);
  });

  test("regenerating an answer retires its waiting suggestion and holds the new re-emit under the same message", async () => {
    const user = await signUp("regenerate");
    const { persistArtifacts } = await import("@/lib/artifacts-store");
    const { conversation, messages } = await conversationWith(user.id, [
      { role: "USER", text: "Draft a launch plan." },
      { role: "ASSISTANT", text: artifactTag("launch-plan", "Launch plan", "# Plan v1") },
    ]);
    const [plan] = await persistArtifacts(conversation.id, messages[1].id, [
      { identifier: "launch-plan", type: "MARKDOWN", title: "Launch plan", content: "# Plan v1" },
    ]);
    await saveByHand(plan.id, 1, "# Plan, edited by hand");
    const first = await chat({ conversationId: conversation.id, message: "Tighten it." }, artifactTag("launch-plan", "Launch plan", "# Take one"));
    const second = await chat({ conversationId: conversation.id, regenerate: true }, artifactTag("launch-plan", "Launch plan", "# Take two"));
    assert.equal(second.message.id, first.message.id, "the answer is overwritten in place");

    const [old, fresh] = await proposalsOf(plan.id);
    assert.equal(old.status, "STALE");
    assert.equal(old.messageId, first.message.id);
    assert.equal(fresh.status, "PENDING");
    assert.equal(fresh.messageId, first.message.id);
    assert.deepEqual(fresh.payload, { content: "# Take two", title: "Launch plan", language: null });
    assert.match(await savedText(first.message.id), new RegExp(`suggestion="${fresh.id}"></juno:artifact>$`));
    await assertCurrentIsNewest(plan.id);
  });

  test("with the guard switched off, a re-emit over an edit appends as before R1", async () => {
    const user = await signUp("guard-off");
    const { persistArtifacts } = await import("@/lib/artifacts-store");
    const { conversation, messages } = await conversationWith(user.id, [
      { role: "USER", text: "Draft a launch plan." },
      { role: "ASSISTANT", text: artifactTag("launch-plan", "Launch plan", "# Plan v1") },
    ]);
    const [plan] = await persistArtifacts(conversation.id, messages[1].id, [
      { identifier: "launch-plan", type: "MARKDOWN", title: "Launch plan", content: "# Plan v1" },
    ]);
    await saveByHand(plan.id, 1, "# Plan, edited by hand");
    process.env.JUNO_AI_REEMIT_GUARD = "0";
    try {
      const done = await chat(
        { conversationId: conversation.id, message: "Tighten it." },
        artifactTag("launch-plan", "Launch plan", "# Plan v3")
      );
      assert.equal(done.artifacts[0]?.currentVersion, 3);
      assert.match(await savedText(done.message.id), /# Plan v3<\/juno:artifact>$/, "the message keeps its body");
    } finally {
      delete process.env.JUNO_AI_REEMIT_GUARD;
    }
    assert.deepEqual(await proposalsOf(plan.id), []);
    await assertCurrentIsNewest(plan.id);
  });

  test("nothing left the process", () => {
    assert.deepEqual(outbound, []);
  });

  test("clean up the throwaway accounts", async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: "artifact-reemit-" } } });
    await prisma.$disconnect();
  });
}
