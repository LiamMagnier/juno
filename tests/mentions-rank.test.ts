import test from "node:test";
import assert from "node:assert/strict";
import { MENTION_SCORE, normalizeMentionText, rankMentions, scoreMention, scoreText, type MentionCandidate } from "@/lib/mentions/rank";
import {
  MENTION_KIND_ORDER,
  fileIconKey,
  mentionToToken,
  parseMentionIds,
  parseMentionKinds,
  type MentionItem,
} from "@/lib/mentions/types";
import { appMentionCandidates, type AppRowsInput } from "@/lib/mentions/apps";
import { contextTokenSchema } from "@/lib/chat/context-tokens";

/*
 * The "@" palette's ranking and vocabulary (src/lib/mentions/*): pure, so the
 * rules are pinned without a database. The route test covers ownership.
 */

const candidate = (kind: MentionItem["kind"], label: string, extra: Partial<MentionCandidate> & { updatedAt?: string } = {}): MentionCandidate => ({
  item: { kind, id: `c${label.toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(20, "0")}`, label, icon: kind, ...(extra.updatedAt ? { updatedAt: extra.updatedAt } : {}) },
  alternates: extra.alternates,
  boost: extra.boost,
});

test("exact beats prefix beats word-start beats substring beats scattered words", () => {
  assert.equal(scoreText("Mira", "mira"), MENTION_SCORE.exact);
  assert.equal(scoreText("Miranda", "mira"), MENTION_SCORE.prefix);
  assert.equal(scoreText("Q3 Forecast.xlsx", "fore"), MENTION_SCORE.wordPrefix);
  assert.equal(scoreText("q3-forecast.xlsx", "xlsx"), MENTION_SCORE.wordPrefix, "punctuation starts a word");
  assert.equal(scoreText("Transforecasting", "fore"), MENTION_SCORE.substring);
  assert.equal(scoreText("Acme renewal plan", "plan acme"), MENTION_SCORE.allWords);
  assert.equal(scoreText("Acme", "zzz"), -1);
});

test("case, accents and spacing are ignored", () => {
  assert.equal(normalizeMentionText("  Café   Crème "), "cafe creme");
  assert.equal(scoreText("Café notes", "cafe"), MENTION_SCORE.prefix);
  assert.equal(scoreText("RENEWALS", "renew"), MENTION_SCORE.prefix);
});

test("a secondary name matches a little below the label", () => {
  assert.equal(scoreMention("GitHub", "github"), MENTION_SCORE.exact);
  assert.equal(scoreMention("Code review", "code-review", ["code-review"]), MENTION_SCORE.exact - 5);
  assert.equal(scoreMention("Mira", "analyst", ["Revenue analyst"]), MENTION_SCORE.wordPrefix - 5);
});

test("with a query: score first, then kind, then recency, and non-matches are gone", () => {
  const ranked = rankMentions(
    [
      candidate("chat", "Mira's onboarding", { updatedAt: "2026-09-29T00:00:00Z" }),
      candidate("file", "Mira.pdf", { updatedAt: "2026-09-01T00:00:00Z" }),
      candidate("crew", "Mira"),
      candidate("project", "Admiral", { updatedAt: "2026-09-30T00:00:00Z" }),
      candidate("project", "Unrelated"),
    ],
    "mira",
    6
  );
  assert.deepEqual(
    ranked.map((item) => item.label),
    ["Mira", "Mira.pdf", "Mira's onboarding", "Admiral"],
    "exact, then two prefixes (file before chat by kind), then a substring"
  );
});

test("without a query: kinds in palette order, each in the order it arrived", () => {
  const ranked = rankMentions(
    [candidate("chat", "Newest chat"), candidate("chat", "Older chat"), candidate("crew", "Mira"), candidate("app", "Figma", { boost: 0 }), candidate("app", "GitHub", { boost: 5 })],
    "",
    6
  );
  assert.deepEqual(ranked.map((item) => item.label), ["Mira", "GitHub", "Figma", "Newest chat", "Older chat"], "a connected app is nudged ahead");
  assert.deepEqual([...MENTION_KIND_ORDER], ["crew", "file", "project", "app", "skill", "chat", "artifact"]);
});

test("each kind is capped, and a row returned twice appears once", () => {
  const rows = Array.from({ length: 5 }, (_, i) => candidate("file", `Report ${i}.pdf`));
  const ranked = rankMentions([...rows, rows[0], candidate("crew", "Reporter")], "report", 3);
  assert.equal(ranked.filter((item) => item.kind === "file").length, 3);
  assert.equal(ranked.filter((item) => item.kind === "crew").length, 1);
  assert.equal(new Set(ranked.map((item) => item.id)).size, ranked.length);
});

test("kinds and ids parse leniently: unknown names dropped, none means all", () => {
  assert.deepEqual(parseMentionKinds("chat,crew,people"), ["crew", "chat"]);
  assert.deepEqual(parseMentionKinds(""), [...MENTION_KIND_ORDER]);
  assert.deepEqual(parseMentionKinds(null), [...MENTION_KIND_ORDER]);
  assert.deepEqual(
    parseMentionIds("app:github,file:cabcdefgh123,file:not-a-cuid,person:cabcdefgh123,app:github,nonsense"),
    [
      { kind: "app", id: "github" },
      { kind: "file", id: "cabcdefgh123" },
    ]
  );
  assert.deepEqual(parseMentionIds(Array.from({ length: 30 }, (_, i) => `app:app${i}`).join(",")).length, 20);
});

test("a palette row becomes a valid token, carrying its mark as a hint", () => {
  const token = mentionToToken(
    { kind: "file", id: "cabcdefgh123", label: "Q3 Forecast.xlsx", subtitle: "Spreadsheet", icon: "file:sheet", score: 80 },
    { start: 8, end: 24 }
  );
  assert.deepEqual(token, {
    kind: "file",
    id: "cabcdefgh123",
    label: "Q3 Forecast.xlsx",
    range: { start: 8, end: 24 },
    meta: { icon: "file:sheet", subtitle: "Spreadsheet" },
  });
  assert.equal(contextTokenSchema.safeParse(token).success, true);
});

test("file icons come from the type first and the extension second", () => {
  assert.equal(fileIconKey("image/png", "x.bin"), "file:image");
  assert.equal(fileIconKey("application/pdf", "x"), "file:pdf");
  assert.equal(fileIconKey("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x"), "file:sheet");
  assert.equal(fileIconKey("application/octet-stream", "Deck.pptx"), "file:slides");
  assert.equal(fileIconKey("text/plain", "script.py"), "file:code");
  assert.equal(fileIconKey("text/plain", "notes"), "file:text");
  assert.equal(fileIconKey(null, "mystery"), "file:generic");
});

// ---------------------------------------------------------------------------
// App rows
// ---------------------------------------------------------------------------

const appInput = (overrides: Partial<AppRowsInput> = {}): AppRowsInput => ({
  registry: [
    { id: "github", label: "GitHub", description: "Repositories", configured: true, connectHref: "/api/connectors/github/connect" },
    { id: "figma", label: "Figma", description: "Design files", configured: true, connectHref: "/api/connectors/figma/connect" },
    { id: "notion", label: "Notion", description: "Docs", configured: false, connectHref: "/api/connectors/notion/connect" },
  ],
  connections: [
    { provider: "github", accountLabel: "octocat", scope: null, createdAt: new Date("2026-09-01T00:00:00Z") },
    { provider: "composio:slack", accountLabel: "Slack", scope: "composio:active", createdAt: new Date("2026-09-02T00:00:00Z") },
    { provider: "composio:gmail", accountLabel: null, scope: "composio:pending", createdAt: new Date("2026-09-03T00:00:00Z") },
    { provider: "__composio_directory", accountLabel: null, scope: null, createdAt: new Date("2026-09-03T00:00:00Z") },
  ],
  servers: [
    { id: "cserver000000001", name: "Build server", enabled: false, url: "https://mcp.example.com", createdAt: new Date("2026-09-04T00:00:00Z") },
  ],
  composio: { configured: true, prefix: "composio:", activeScope: "composio:active" },
  approvals: { policy: "ask_for_any_change", lockdown: false, blockedConnectors: [] },
  ...overrides,
});

test("apps: connected ones, ones this server can connect, the account's own servers — never unconfigured ones", () => {
  const rows = appMentionCandidates(appInput()).map((row) => row.item);
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.deepEqual([...byId.keys()].sort(), ["composio:gmail", "composio:slack", "figma", "github", "user_mcp:cserver000000001"]);
  assert.equal(byId.get("github")?.connected, true);
  assert.equal(byId.get("github")?.subtitle, "octocat");
  assert.equal(byId.get("figma")?.needsConnection, true);
  assert.equal(byId.get("figma")?.connectHref, "/api/connectors/figma/connect");
  assert.equal(byId.get("composio:gmail")?.needsConnection, true, "a connection still in progress is not usable yet");
  assert.equal(byId.get("composio:gmail")?.label, "Gmail");
  assert.equal(byId.get("composio:gmail")?.connectHref, "/api/connectors/composio/gmail/connect");
  assert.equal(byId.get("user_mcp:cserver000000001")?.needsConnection, true, "switched off");
  assert.equal(byId.get("composio:slack")?.icon, "app:composio:slack");
});

test("every app row says what using it will ask first, blocked apps included", () => {
  const rows = appMentionCandidates(appInput({ approvals: { policy: "ask_for_important_actions", lockdown: false, blockedConnectors: ["composio:slack"] } }));
  const byId = new Map(rows.map((row) => [row.item.id, row.item]));
  assert.equal(byId.get("github")?.approval?.summary, "Sending, posting or deleting in GitHub will ask you first. Changes you can undo won't.");
  assert.equal(byId.get("github")?.approval?.sends, "ask");
  assert.equal(byId.get("composio:slack")?.approval?.sends, "block");
  assert.equal(byId.get("composio:slack")?.approval?.summary, "Slack is turned off in Settings, so Juno won't use it.");
});

test("apps: Composio rows vanish when Composio is not configured, and `only` narrows to exact ids", () => {
  const off = appMentionCandidates(appInput({ composio: { configured: false, prefix: "composio:", activeScope: "composio:active" } }));
  assert.ok(!off.some((row) => row.item.id.startsWith("composio:")));
  const only = appMentionCandidates(appInput({ only: new Set(["figma"]) }));
  assert.deepEqual(only.map((row) => row.item.id), ["figma"]);
});
