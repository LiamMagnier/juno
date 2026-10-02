import test from "node:test";
import assert from "node:assert/strict";
import { homeSuggestions } from "@/lib/chat/home-suggestions";
import type { MentionItem } from "@/lib/mentions/types";

/*
 * The home's suggestions come from the person's own state, at most three,
 * and none when nothing real exists (PRODUCT_REFOUNDATION §5; critique 1:
 * never a question the sidebar already asks, never generic starters).
 */

const NOW = new Date("2026-10-02T15:00:00").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const app = (id: string, label: string, updatedAt?: string, extra: Partial<MentionItem> = {}): MentionItem => ({
  kind: "app",
  id,
  label,
  icon: `app:${id}`,
  connectorId: id,
  connected: true,
  updatedAt,
  score: 1,
  ...extra,
});
const project = (id: string, label: string, updatedAt?: string): MentionItem => ({
  kind: "project",
  id,
  label,
  icon: "project",
  updatedAt,
  score: 1,
});

test("nothing real to suggest means no suggestions", () => {
  assert.deepEqual(homeSuggestions([], NOW), []);
  assert.deepEqual(
    homeSuggestions([app("slack", "Slack", hoursAgo(24 * 5)), project("cm00000000p1", "Old", hoursAgo(30))], NOW),
    [],
  );
});

test("an app connected in the last three days and a project touched today, newest first", () => {
  const out = homeSuggestions(
    [
      app("github", "GitHub", hoursAgo(20)),
      project("cm00000000p1", "Atlas launch", hoursAgo(2)),
      app("slack", "Slack", hoursAgo(24 * 4)),
    ],
    NOW,
  );
  assert.deepEqual(
    out.map((s) => s.label),
    ["Continue in Atlas launch", "Use GitHub"],
  );
});

test("an app that still needs connecting is never offered", () => {
  const out = homeSuggestions([app("linear", "Linear", hoursAgo(1), { connected: false, needsConnection: true })], NOW);
  assert.deepEqual(out, []);
});

test("agents, files and chats are not home suggestions; at most three are shown", () => {
  const items: MentionItem[] = [
    { kind: "crew", id: "cm00000000a1", label: "Mira", icon: "crew", updatedAt: hoursAgo(1), score: 1 },
    { kind: "file", id: "cm00000000f1", label: "Q3.xlsx", icon: "file:sheet", updatedAt: hoursAgo(1), score: 1 },
    app("github", "GitHub", hoursAgo(1)),
    app("slack", "Slack", hoursAgo(2)),
    app("notion", "Notion", hoursAgo(3)),
    project("cm00000000p1", "Atlas", hoursAgo(4)),
  ];
  const out = homeSuggestions(items, NOW);
  assert.equal(out.length, 3);
  assert.ok(out.every((s) => s.kind === "app" || s.kind === "project"));
});
