import test from "node:test";
import assert from "node:assert/strict";
import {
  blindTokensFor,
  minimumCoverage,
  parseRecallQuery,
  parseTimeHint,
  rankRecallCandidates,
  recallEntities,
  recallTokens,
  verifyRecallMatch,
} from "@/lib/recall/index-core";
import { inMemoryRecall, syntheticRecallCorpus } from "@/lib/memory-eval";

test("tokens fold tense and drop the words a frequency attack would start from", () => {
  assert.deepEqual(recallTokens("What did we decide about Orbit permissions?"), ["decid", "orbit", "permission"]);
  assert.ok(recallTokens("We decided the Orbit permissions.").includes("decid"));
  assert.ok(!recallTokens("the and of what did we").length);
});

test("entities: capitalised mid-sentence words and alphanumerics, not sentence starts", () => {
  assert.deepEqual(recallEntities("Yesterday we moved Orbit to GPT5 in iOS."), ["orbit", "gpt5", "ios"]);
  assert.ok(!recallEntities("Apples are good.").includes("appl"));
});

test("blind tokens are the hasher's output only, namespaced and deduplicated", () => {
  const seen: string[] = [];
  const tokens = blindTokensFor("Orbit, orbit and Orbit again.", (t) => {
    seen.push(t);
    return `H(${t})`;
  });
  assert.deepEqual(tokens, ["H(w:orbit)", "H(e:orbit)"]);
  assert.ok(seen.every((t) => t.startsWith("w:") || t.startsWith("e:")));
});

test("time hints read relative phrases and leave the rest of the query", () => {
  const now = new Date("2026-10-01T00:00:00Z");
  const hint = parseTimeHint("what did we decide two weeks ago", now)!;
  assert.equal(Math.round((now.getTime() - hint.at.getTime()) / 86_400_000), 14);
  assert.deepEqual(parseRecallQuery("Orbit permissions two weeks ago", now).words, ["orbit", "permission"]);
  assert.equal(parseTimeHint("orbit permissions", now), null);
});

test("ranking needs most of the query, prefers rare words, the stated time and the asking project", () => {
  assert.equal(minimumCoverage(2), 2);
  assert.equal(minimumCoverage(5), 3);
  const now = new Date("2026-10-01T00:00:00Z");
  const query = parseRecallQuery("orbit permissions two weeks ago", now);
  const base = { conversationId: "c", projectId: null, tokenCount: 20, matchedEntities: [] as string[] };
  const ranked = rankRecallCandidates(
    [
      { ...base, messageId: "old", createdAt: new Date("2026-03-01T00:00:00Z"), matchedWords: ["orbit", "permission"] },
      { ...base, messageId: "right", createdAt: new Date("2026-09-17T00:00:00Z"), matchedWords: ["orbit", "permission"] },
      { ...base, messageId: "half", createdAt: new Date("2026-09-17T00:00:00Z"), matchedWords: ["orbit"] },
    ],
    { query, corpusSize: 1000, documentFrequency: new Map([["orbit", 30], ["permission", 40]]), meanTokenCount: 20, projectId: null, now }
  );
  assert.deepEqual(ranked.map((r) => r.messageId), ["right", "old"]);
});

test("verification drops a candidate whose body no longer contains the words", () => {
  assert.deepEqual(verifyRecallMatch("We decided on Orbit permissions.", ["decid", "orbit", "permission"]), ["decid", "orbit", "permission"]);
  assert.deepEqual(verifyRecallMatch("Something else entirely.", ["orbit"]), []);
});

test("on a 20,000-message synthetic account, every planted decision is the first chat found", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const { corpus, probes } = syntheticRecallCorpus(20_000, now);
  const index = inMemoryRecall(corpus);
  for (const probe of probes) {
    const first = index.search(probe.query, { now, projectId: probe.projectId })[0];
    assert.equal(first?.conversationId, probe.conversationId, probe.query);
  }
});
