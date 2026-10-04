/**
 * What a chat card, the canvas and `/a/{id}` decide about the R1 lifecycle
 * (Recently deleted, the re-emit guard's suggestions, placeholder notes), as
 * the pure functions in `src/lib/artifact-card-state.ts`.
 *
 * Pure only: the repo has no DOM test environment, so everything a component
 * would otherwise decide inline is decided there and pinned here. The last two
 * tests read the chat's source to hold the wiring the spec names (R1 §3B:
 * nothing opens a trashed artifact).
 *
 * Run: NODE_OPTIONS=--conditions=react-server npx tsx --test tests/artifact-card-state.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  artifactRestoreUrl,
  cardSuggestion,
  comparisonNotice,
  isTrashed,
  liveArtifacts,
  mergeArtifactUpdate,
  placeholderCount,
  placeholderNote,
  readSuggestionComparison,
  restoredArtifact,
  suggestionIsBehind,
  suggestionOutcome,
  suggestionToast,
  suggestionUrl,
  withSuggestionResolved,
} from "../src/lib/artifact-card-state";
import type { ClientActivityEvent, ClientArtifact, ClientArtifactSuggestion } from "../src/types/chat";

const suggestion = (overrides: Partial<ClientArtifactSuggestion> = {}): ClientArtifactSuggestion => ({
  id: "prop-1",
  baseVersion: 2,
  messageId: "assistant-2",
  summary: "You edited this after Juno's last version",
  createdAt: "2026-09-24T12:00:00.000Z",
  ...overrides,
});

const artifact = (overrides: Partial<ClientArtifact> = {}): ClientArtifact => ({
  id: "art-1",
  identifier: "pricing",
  type: "HTML",
  title: "Pricing page",
  currentVersion: 2,
  content: "<h1>Pricing</h1>",
  versions: [],
  messageId: "assistant-1",
  createdAt: "2026-09-24T10:00:00.000Z",
  updatedAt: "2026-09-24T11:00:00.000Z",
  ...overrides,
});

type Report = NonNullable<ClientActivityEvent["artifactVerification"]>;
const verification = (overrides: Partial<Report> = {}, id = "act-1"): ClientActivityEvent => ({
  id,
  kind: "artifact",
  title: "Checked 1 artifact",
  createdAt: "2026-09-24T12:00:00.000Z",
  artifactVerification: {
    version: 1,
    status: "verified",
    attempts: 0,
    checked: 1,
    accepted: ["screen"],
    refused: [],
    problems: [],
    repairs: [],
    ...overrides,
  },
});

const note = (identifier: string, detail = "Hero photo became a placeholder") => ({
  identifier,
  code: "image_placeholder" as const,
  detail,
});

test("Recently deleted is exactly `deletedAt` being set", () => {
  assert.equal(isTrashed(artifact()), false);
  assert.equal(isTrashed(artifact({ deletedAt: null })), false);
  assert.equal(isTrashed(artifact({ deletedAt: "2026-09-24T12:00:00.000Z" })), true);
  assert.equal(isTrashed(null), false);
  assert.equal(isTrashed(undefined), false);
});

test("what a chat can open leaves out Recently deleted, and is the same list when nothing is there", () => {
  const live = [artifact(), artifact({ id: "art-2", identifier: "faq" })];
  assert.equal(liveArtifacts(live), live, "no trashed rows: same array, so a memo on it holds");
  const trashed = artifact({ id: "art-3", identifier: "old", deletedAt: "2026-09-24T12:00:00.000Z" });
  assert.deepEqual(liveArtifacts([...live, trashed]).map((a) => a.id), ["art-1", "art-2"]);
});

test("a suggestion shows on the card of the reply that made it, and nowhere else", () => {
  const waiting = artifact({ pendingSuggestion: suggestion() });
  assert.equal(cardSuggestion(waiting, "assistant-2"), waiting.pendingSuggestion);
  assert.equal(cardSuggestion(waiting, "assistant-1"), null, "the reply that created the artifact");
  assert.equal(cardSuggestion(waiting, "assistant-3"), null, "a later reply that mentions it");
  assert.equal(cardSuggestion(artifact(), "assistant-2"), null, "nothing waiting");
  assert.equal(cardSuggestion(artifact({ pendingSuggestion: null }), "assistant-2"), null);
  assert.equal(cardSuggestion(undefined, "assistant-2"), null, "a tag with no row yet");
  assert.equal(
    cardSuggestion(artifact({ pendingSuggestion: suggestion({ messageId: null }) }), "assistant-2"),
    null,
    "a suggestion whose reply is gone has no card"
  );
});

test("a trashed artifact's card carries no suggestion: every proposal route 404s for it", () => {
  const trashed = artifact({ deletedAt: "2026-09-24T12:00:00.000Z", pendingSuggestion: suggestion() });
  assert.equal(cardSuggestion(trashed, "assistant-2"), null);
});

test("a suggestion is behind once the artifact moved past the version it was written against", () => {
  assert.equal(suggestionIsBehind(suggestion({ baseVersion: 2 }), 2), false);
  assert.equal(suggestionIsBehind(suggestion({ baseVersion: 2 }), 3), true, "the person saved after the reply");
});

test("one placeholder note is one picture, counted for its own identifier", () => {
  const activity = [verification({ notes: [note("screen"), note("screen", "Logo became a placeholder"), note("other")] })];
  assert.equal(placeholderCount(activity, "screen"), 2);
  assert.equal(placeholderCount(activity, "other"), 1);
  assert.equal(placeholderCount(activity, "missing"), 0);
});

test("the newest report that looked at the artifact wins, so repeated passes never multiply pictures", () => {
  const first = verification({ status: "repaired", notes: [note("screen")] }, "act-1");
  const second = verification({ notes: [note("screen")] }, "act-2");
  assert.equal(placeholderCount([first, second], "screen"), 1);
  const unrelated = verification({ accepted: ["faq"], notes: [] }, "act-3");
  assert.equal(placeholderCount([first, unrelated], "screen"), 1, "a later report about something else is skipped");
  const clean = verification({ notes: [] }, "act-4");
  assert.equal(placeholderCount([first, clean], "screen"), 0, "a later pass that looked and found none");
});

test("reports from before notes existed, and turns with no report, count none", () => {
  assert.equal(placeholderCount([verification()], "screen"), 0, "no `notes` key at all");
  assert.equal(placeholderCount(undefined, "screen"), 0);
  assert.equal(placeholderCount([], "screen"), 0);
  assert.equal(
    placeholderCount([{ id: "t", kind: "tool", title: "Search", createdAt: "2026-09-24T12:00:00.000Z" }], "screen"),
    0
  );
  assert.equal(placeholderCount([verification({ notes: [note("screen")] })], ""), 0, "a streaming tag has no identifier");
});

test("the placeholder footnote reads in the singular and the plural, and says nothing for none", () => {
  assert.equal(placeholderNote(1), "1 picture became a placeholder");
  assert.equal(placeholderNote(3), "3 pictures became placeholders");
  assert.equal(placeholderNote(0), null);
  assert.equal(placeholderNote(Number.NaN), null);
});

test("a save response that did not read suggestions keeps the one still waiting", () => {
  const waiting = artifact({ pendingSuggestion: suggestion() });
  const saved = artifact({ currentVersion: 3, content: "<h1>Pricing, edited</h1>" });
  const merged = mergeArtifactUpdate(waiting, saved);
  assert.equal(merged.currentVersion, 3, "the payload is the truth");
  assert.equal(merged.content, saved.content);
  assert.equal(merged.pendingSuggestion, waiting.pendingSuggestion, "absent means unknown: kept");
});

test("an explicit null clears a suggestion, and a newer one replaces it", () => {
  const waiting = artifact({ pendingSuggestion: suggestion() });
  assert.equal(mergeArtifactUpdate(waiting, artifact({ pendingSuggestion: null })).pendingSuggestion, null);
  const newer = suggestion({ id: "prop-2", messageId: "assistant-3" });
  assert.equal(mergeArtifactUpdate(waiting, artifact({ pendingSuggestion: newer })).pendingSuggestion, newer);
});

test("`deletedAt` follows the payload, so a restore brings the card back", () => {
  const trashed = artifact({ deletedAt: "2026-09-24T12:00:00.000Z" });
  assert.equal(isTrashed(mergeArtifactUpdate(trashed, artifact())), false);
  const next = artifact();
  assert.equal(mergeArtifactUpdate(null, next), next, "nothing held: the payload as is");
  assert.equal(
    mergeArtifactUpdate(artifact({ id: "other", pendingSuggestion: suggestion() }), next),
    next,
    "another artifact's suggestion never carries over"
  );
});

test("resolving a suggestion clears it unless the server already holds a newer one", () => {
  assert.equal(withSuggestionResolved(artifact(), "prop-1").pendingSuggestion, null, "absent becomes a known null");
  assert.equal(withSuggestionResolved(artifact({ pendingSuggestion: suggestion() }), "prop-1").pendingSuggestion, null);
  const newer = suggestion({ id: "prop-2" });
  assert.equal(withSuggestionResolved(artifact({ pendingSuggestion: newer }), "prop-1").pendingSuggestion, newer);
});

test("proposal answers read into outcomes the surfaces can act on (§3C)", () => {
  const applied = suggestionOutcome("apply", 200, { artifact: artifact({ currentVersion: 3 }) }, "prop-1");
  assert.equal(applied.kind, "applied");
  assert.equal(applied.kind === "applied" && applied.artifact.pendingSuggestion, null);

  const dismissed = suggestionOutcome("dismiss", 200, { artifact: artifact() }, "prop-1");
  assert.equal(dismissed.kind, "dismissed");
  assert.equal(dismissed.kind === "dismissed" && dismissed.artifact.pendingSuggestion, null);

  const moved = artifact({ currentVersion: 3 });
  const stale = suggestionOutcome("apply", 409, { error: "stale", artifact: moved }, "prop-1");
  assert.equal(stale.kind, "stale");
  assert.equal(stale.kind === "stale" && stale.artifact, moved, "left as sent: the suggestion still waits");
  assert.equal(stale.kind === "stale" && stale.artifact?.pendingSuggestion, undefined);

  const resolved = suggestionOutcome("apply", 409, { error: "resolved", artifact: artifact() }, "prop-1");
  assert.equal(resolved.kind, "resolved");
  assert.equal(resolved.kind === "resolved" && resolved.artifact?.pendingSuggestion, null);

  assert.deepEqual(suggestionOutcome("apply", 404, { error: "Not found" }, "prop-1"), { kind: "gone" });
  assert.deepEqual(suggestionOutcome("apply", 500, null, "prop-1"), { kind: "error" });
  assert.deepEqual(suggestionOutcome("apply", 200, { ok: true }, "prop-1"), { kind: "error" }, "200 with no artifact");
  assert.deepEqual(suggestionOutcome("apply", 409, { error: "other" }, "prop-1"), { kind: "error" });
});

test("the toasts say what the spec says, the same on every surface", () => {
  const applied = suggestionOutcome("apply", 200, { artifact: artifact({ currentVersion: 4 }) }, "prop-1");
  assert.deepEqual(suggestionToast("apply", applied), { tone: "success", message: "Applied as v4." });
  assert.deepEqual(suggestionToast("dismiss", suggestionOutcome("dismiss", 200, { artifact: artifact() }, "prop-1")), {
    tone: "success",
    message: "Suggestion dismissed.",
  });
  assert.deepEqual(suggestionToast("apply", { kind: "stale", artifact: null }), {
    tone: "error",
    message: "This changed since the suggestion was made. Compare again before applying.",
  });
  assert.equal(suggestionToast("apply", { kind: "error" })?.message, "Couldn’t apply the suggestion.");
  assert.equal(suggestionToast("dismiss", { kind: "error" })?.message, "Couldn’t dismiss the suggestion.");
  assert.equal(suggestionToast("apply", { kind: "gone" })?.tone, "error");
});

test("the comparison route's answer is read defensively, and says what to warn about", () => {
  const body = {
    proposal: {
      id: "prop-1",
      baseVersion: 2,
      summary: "Would remove 3 animations and 1 component",
      status: "PENDING",
      createdAt: "2026-09-24T12:00:00.000Z",
      type: "DESIGN",
      title: "Onboarding",
      content: null,
    },
    current: { version: 2, content: null },
  };
  const view = readSuggestionComparison(body);
  assert.ok(view);
  assert.equal(view.proposal.content, null, "a design sends no content");
  assert.equal(comparisonNotice(view), null, "pending, at the version it was written against");

  const behind = readSuggestionComparison({ ...body, current: { version: 3, content: null } });
  assert.ok(behind);
  assert.deepEqual(comparisonNotice(behind), {
    kind: "behind",
    message: "This changed after Alevr suggested it (v2 → v3). Applying replaces v3, which stays in history.",
  });

  const applied = readSuggestionComparison({ ...body, proposal: { ...body.proposal, status: "APPLIED" } });
  assert.ok(applied);
  assert.equal(comparisonNotice(applied)?.kind, "resolved");
  assert.equal(comparisonNotice(applied)?.message, "This suggestion was already applied.");

  assert.equal(readSuggestionComparison(null), null);
  assert.equal(readSuggestionComparison({ proposal: body.proposal }), null, "no current side");
  assert.equal(readSuggestionComparison({ ...body, proposal: { ...body.proposal, status: "WHATEVER" } }), null);
});

test("a restore answer is a live artifact or nothing", () => {
  const back = artifact();
  assert.equal(restoredArtifact(200, { artifact: back }), back);
  assert.equal(restoredArtifact(200, { artifact: artifact({ deletedAt: "2026-09-24T12:00:00.000Z" }) }), null);
  assert.equal(restoredArtifact(404, { error: "Not found" }), null);
  assert.equal(restoredArtifact(200, null), null);
});

test("the routes are built one way, with ids encoded", () => {
  assert.equal(artifactRestoreUrl("art 1"), "/api/artifacts/art%201/restore");
  assert.equal(suggestionUrl("art-1", "prop-1"), "/api/artifacts/art-1/proposals/prop-1");
  assert.equal(suggestionUrl("art-1", "prop-1", "apply"), "/api/artifacts/art-1/proposals/prop-1/apply");
  assert.equal(suggestionUrl("art-1", "prop/1", "poster"), "/api/artifacts/art-1/proposals/prop%2F1/poster");
});

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

test("nothing in the chat opens a trashed artifact (R1 §3B)", () => {
  const view = read("src/components/chat/chat-view.tsx");
  assert.match(view, /liveArtifacts\(chat\.artifacts\)/, "the chat derives what it can open");
  assert.match(view, /openableArtifacts\.find\(\(a\) => a\.id === openArtifactId\)/, "the canvas");
  assert.match(view, /openableArtifacts\.find\(\(x\) => x\.identifier === initialArtifactIdentifier\)/, "the deep link");
  assert.match(view, /openableArtifacts(?:Ref\.current)?\.find\(\(x\) => x\.identifier === identifier\)/, "opening by identifier");
  assert.match(view, /<SessionOutputs\s+artifacts=\{openableArtifacts\}/, "SessionOutputs");
  assert.match(view, /<MessageList[\s\S]*?artifacts=\{chat\.artifacts\}/, "the transcript keeps them for its cards");
  const item = read("src/components/chat/message-item.tsx");
  assert.match(item, /onOpen=\{part\.identifier && artifact && !trashed \?/, "a trashed card has no Open");
});

test("the card's bar comes from the reply's own suggestion, and never on an older page", () => {
  const item = read("src/components/chat/message-item.tsx");
  assert.match(item, /viewingOld \? null : cardSuggestion\(artifact, message\.id\)/);
  assert.match(item, /placeholderCount\(view\.activity, part\.identifier\)/);
});
