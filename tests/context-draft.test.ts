import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_CLIPBOARD_TYPE,
  appendToDraft,
  draftRuns,
  parseClipboardDraft,
  serializeClipboardDraft,
  shiftTokens,
  tokenFits,
  tokensForRemainder,
  tokensForText,
  type ContextDraft,
} from "@/lib/chat/context-draft";
import { contextRangeIssues, rangesForStoredText, type ContextToken } from "@/lib/chat/context-tokens";
import { readSkillInvocation } from "@/components/chat/use-chat-skills";
import type { ClientWorkSkill } from "@/lib/work/skills";

/*
 * The draft as data (src/lib/chat/context-draft.ts): every change to the
 * composer that does not come from typing goes through these, so a token stays
 * attached to its words through a send, a slash skill, dictation, a paste and
 * a remount. The one rule under every case: a token survives only where its
 * range still frames exactly its label, and none is re-attached by name.
 */

const FILE = "cm000000000000000000000002";
const token = (label: string, start: number, kind: ContextToken["kind"] = "file", id = FILE): ContextToken => ({
  kind,
  id,
  label,
  range: { start, end: start + label.length },
  meta: { icon: kind === "app" ? `app:${id}` : "file:sheet" },
});

test("a token fits only where its range frames its label", () => {
  const text = "Compare Q3 Forecast.xlsx with last year";
  assert.equal(tokenFits(text, token("Q3 Forecast.xlsx", 8)), true);
  assert.equal(tokenFits(text, token("Q3 Forecast.xlsx", 9)), false);
  assert.equal(tokenFits(text, { label: "Q3", range: { start: 30, end: 80 } }), false);
  assert.equal(tokenFits(text, { label: "Q3" }), false);
});

test("tokensForText keeps fitting tokens in order and drops overlaps and strays", () => {
  const text = "Ask Mira about GitHub";
  const mira = token("Mira", 4, "crew", "cm000000000000000000000003");
  const github = token("GitHub", 15, "app", "github");
  const stray = token("Mira", 0, "crew", "cm000000000000000000000004");
  const overlap = { ...token("Mira about", 4), id: "cm000000000000000000000005" };
  const kept = tokensForText(text, [github, stray, overlap, mira]);
  // The first token to claim the words keeps them; the one it overlaps goes,
  // and the stray whose range does not frame "Mira" never re-attaches by name.
  assert.deepEqual(kept.map((t) => t.label), ["Mira about", "GitHub"]);
  assert.ok(!kept.some((t) => t.id === stray.id));
  assert.deepEqual(contextRangeIssues(text, kept), []);
});

test("shiftTokens moves ranges and drops tokens pushed off the front", () => {
  const moved = shiftTokens([token("Q3", 10), token("Q4", 2)], -5);
  assert.deepEqual(moved.map((t) => t.range), [{ start: 5, end: 7 }]);
});

/*
 * HANDOFF gap: "slash-skill text rewriting needs range adjustment". The client
 * sends only what follows "/slug", so a token typed after the slug has to move
 * back by the head it lost, or the request schema refuses the turn
 * (label_mismatch) and the person's message never goes.
 */
test("a typed /skill keeps every token's range on the remainder it sends", () => {
  const skills = [{ slug: "brief", name: "Brief", description: "" }] as unknown as ClientWorkSkill[];
  const draft = "  /brief   Compare Q3 Forecast.xlsx with GitHub  ";
  const sheet = token("Q3 Forecast.xlsx", draft.indexOf("Q3"));
  const github = token("GitHub", draft.indexOf("GitHub"), "app", "github");
  const typed = readSkillInvocation(draft.trim(), skills);
  assert.ok(typed);
  const remainder = typed.remainder;
  assert.equal(remainder, "Compare Q3 Forecast.xlsx with GitHub");
  const moved = rangesForStoredText(remainder, tokensForRemainder(draft, remainder, [sheet, github]));
  assert.deepEqual(contextRangeIssues(remainder, moved), []);
  assert.deepEqual(
    moved.map((t) => remainder.slice(t.range!.start, t.range!.end)),
    ["Q3 Forecast.xlsx", "GitHub"],
  );
});

test("a token inside the slash head itself does not survive into the remainder", () => {
  const draft = "/brief GitHub";
  const inHead = token("brief", 1, "app", "github");
  assert.deepEqual(tokensForRemainder(draft, "GitHub", [inHead]), []);
  assert.deepEqual(tokensForRemainder(draft, "", [inHead]), []);
});

test("dictation appends after one space and keeps the draft's tokens", () => {
  const draft: ContextDraft = { text: "Ask Mira   ", tokens: [token("Mira", 4, "crew", "cm000000000000000000000003")] };
  const next = appendToDraft(draft, "  about the renewal ");
  assert.equal(next.text, "Ask Mira about the renewal");
  assert.deepEqual(next.tokens.map((t) => t.range), [{ start: 4, end: 8 }]);
  assert.deepEqual(appendToDraft({ text: "", tokens: [] }, " hello "), { text: "hello", tokens: [] });
  assert.deepEqual(appendToDraft(draft, "   ").text, "Ask Mira");
});

test("a copied selection round-trips its tokens through the clipboard", () => {
  assert.equal(CONTEXT_CLIPBOARD_TYPE, "application/x-juno-tokens+json");
  const draft: ContextDraft = { text: "see GitHub now", tokens: [token("GitHub", 4, "app", "github")] };
  const pasted = parseClipboardDraft(serializeClipboardDraft(draft));
  assert.deepEqual(pasted, { text: draft.text, tokens: draft.tokens });
});

test("a pasted clipboard is untrusted: bad JSON, bad ids and stale ranges fall back to text", () => {
  assert.equal(parseClipboardDraft(null), null);
  assert.equal(parseClipboardDraft("not json"), null);
  assert.equal(parseClipboardDraft(JSON.stringify({ text: 5, tokens: [] })), null);
  assert.equal(parseClipboardDraft("x".repeat(200_001)), null);
  const hostile = JSON.stringify({
    version: 1,
    text: "open GitHub",
    tokens: [
      { kind: "file", id: "../../etc/passwd", label: "GitHub", range: { start: 5, end: 11 } },
      { kind: "app", id: "github", label: "GitHub", range: { start: 0, end: 6 } },
      { kind: "app", id: "github", label: "Git\nHub", range: { start: 5, end: 11 } },
    ],
  });
  assert.deepEqual(parseClipboardDraft(hostile), { text: "open GitHub", tokens: [] });
});

test("draftRuns splits a draft into text and tokens that concatenate back to the text", () => {
  const draft: ContextDraft = {
    text: "Compare Q3 Forecast.xlsx with GitHub",
    tokens: [token("GitHub", 30, "app", "github"), token("Q3 Forecast.xlsx", 8)],
  };
  const runs = draftRuns(draft);
  assert.deepEqual(
    runs.map((run) => ("token" in run ? `[${run.token.label}]` : run.text)),
    ["Compare ", "[Q3 Forecast.xlsx]", " with ", "[GitHub]"],
  );
  assert.equal(runs.map((run) => ("token" in run ? run.token.label : run.text)).join(""), draft.text);
});
