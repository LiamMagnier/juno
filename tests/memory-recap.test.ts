import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildMemoryRecap,
  recapIsEmpty,
  recapThemes,
  type RecapRow,
} from "@/lib/memory-recap";

/*
 * The recap — what changed in what Juno knows over a period.
 *
 * Most of these tests are about WHEN, because that is where a recap is easy to
 * get quietly wrong: `updatedAt` moves every time a chat turn stamps
 * `lastUsedAt`, so "updated this month" means "useful this month". Every date
 * below comes from the data's own meaning instead — see src/lib/memory-recap.ts.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const NOW = new Date("2026-09-22T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function row(id: string, content: string, extra: Partial<RecapRow> = {}): RecapRow {
  return {
    id,
    content,
    kind: "FACT",
    category: "preferences",
    status: "active",
    reason: null,
    createdAt: daysAgo(100),
    expiresAt: null,
    lastUsedAt: null,
    supersededById: null,
    ...extra,
  };
}

const rows: RecapRow[] = [
  // Learned this week.
  row("tea", "The user likes tea.", { createdAt: daysAgo(2), category: "preferences" }),
  row("porto", "The user lives in Porto.", { createdAt: daysAgo(3), category: "identity" }),
  row("figma", "The user uses Figma.", { createdAt: daysAgo(5), category: "workflows" }),
  // Learned this month, not this week.
  row("jazz", "The user likes jazz.", { createdAt: daysAgo(20), category: "preferences" }),
  // Replaced this week: Lisbon → Porto. Lisbon itself is old.
  row("lisbon", "The user lives in Lisbon.", {
    createdAt: daysAgo(200),
    status: "superseded",
    supersededById: "porto",
    reason: "You mentioned moving.",
  }),
  // Replaced long ago — its REPLACEMENT is old, however recently it was used.
  row("npm", "The user uses npm.", { status: "superseded", supersededById: "pnpm", lastUsedAt: daysAgo(1) }),
  row("pnpm", "The user uses pnpm.", { createdAt: daysAgo(150), category: "workflows", lastUsedAt: daysAgo(1) }),
  // Replaced by a row that was later deleted — no date to place it at.
  row("orphan", "The user uses Yarn.", { status: "superseded", supersededById: "gone" }),
  // Born conflicting this week.
  row("clash", "The user prefers tabs.", { createdAt: daysAgo(4), status: "contradicted", reason: "You said spaces." }),
  // Forgotten this week (the suppression's own date).
  row("s1", "The user works at Acme.", { kind: "SUPPRESSION", category: "suppression", createdAt: daysAgo(1) }),
  // Expired this week.
  row("trip", "The user is in Berlin this week.", {
    createdAt: daysAgo(40),
    status: "expired",
    category: "temporary",
    expiresAt: daysAgo(6),
  }),
  // Leaned on — active, used recently.
  row("short", "The user prefers short answers.", { lastUsedAt: daysAgo(1) }),
  row("metric", "The user prefers metric units.", { lastUsedAt: daysAgo(3) }),
  // Used recently but retired: not "leaned on".
  row("oldpref", "The user prefers long answers.", { status: "superseded", lastUsedAt: daysAgo(1) }),
];

const week = buildMemoryRecap(rows, { days: 7, now: NOW });
const month = buildMemoryRecap(rows, { days: 30, now: NOW });

test("learned is what was first learned in the window, newest first", () => {
  assert.deepEqual(
    week.learned.map((r) => r.id),
    ["tea", "porto", "clash", "figma"]
  );
  assert.ok(month.learned.some((r) => r.id === "jazz"));
  assert.equal(week.learned.some((r) => r.id === "jazz"), false);
});

test("learned is counted by category, largest first", () => {
  assert.deepEqual(month.learnedByCategory[0], { category: "preferences", count: 3 });
});

test("a replacement dates the change — not the old row, and not its last use", () => {
  assert.deepEqual(
    week.replaced.map(({ before, after }) => [before.id, after?.id]),
    [["lisbon", "porto"]]
  );
  // npm → pnpm happened 150 days ago. Both rows were USED yesterday, which is
  // exactly what would put them in a recap keyed on updatedAt.
  assert.equal(month.replaced.some(({ before }) => before.id === "npm"), false);
});

test("a change whose replacement was deleted is left out rather than guessed at", () => {
  assert.equal(month.replaced.some(({ before }) => before.id === "orphan"), false);
});

test("a fact born conflicting is dated by its own creation", () => {
  assert.deepEqual(week.conflicting.map((r) => r.id), ["clash"]);
});

test("a forget is dated by the suppression written for it", () => {
  assert.deepEqual(week.forgotten.map((r) => r.id), ["s1"]);
});

test("an expiry is dated by when it expired, not when it was learned", () => {
  // Learned 40 days ago, expired 6 days ago: this week's recap, not last month's.
  assert.deepEqual(week.expired.map((r) => r.id), ["trip"]);
});

test("leaned on is active facts used in the window, most recent first", () => {
  assert.deepEqual(week.leanedOn.map((r) => r.id).slice(0, 3), ["pnpm", "short", "metric"]);
  assert.equal(week.leanedOn.some((r) => r.id === "oldpref"), false);
});

test("leaned on is capped", () => {
  const many = Array.from({ length: 20 }, (_, i) => row(`u${i}`, `Fact ${i}.`, { lastUsedAt: daysAgo(1) }));
  assert.equal(buildMemoryRecap(many, { days: 7, now: NOW }).leanedOn.length, 6);
});

test("an empty stretch is recognised as empty", () => {
  const quiet = buildMemoryRecap([row("old", "Old fact.", { createdAt: daysAgo(400) })], { days: 7, now: NOW });
  assert.equal(recapIsEmpty(quiet, []), true);
  assert.equal(recapIsEmpty(quiet, ["Planning a trip"]), false);
});

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

test("a merged digest contributes its first part — what the chat began as", () => {
  assert.deepEqual(recapThemes(["Planning the thesis · Fixing citations · Formatting"]), ["Planning the thesis"]);
});

test("a digest trimmed from the front loses its ellipsis", () => {
  assert.deepEqual(recapThemes(["…ing the API · Rate limits"]), ["ing the API"]);
});

test("duplicate themes collapse, case and punctuation aside", () => {
  assert.deepEqual(recapThemes(["Thesis planning", "thesis planning!", null, "", "Trip to Berlin"]), [
    "Thesis planning",
    "Trip to Berlin",
  ]);
});

test("themes are capped and long ones shortened", () => {
  const many = Array.from({ length: 20 }, (_, i) => `Theme number ${i}`);
  assert.equal(recapThemes(many).length, 8);
  assert.ok(recapThemes(["x".repeat(300)])[0].length <= 140);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the recap route accepts only the offered periods, and only reads", () => {
  const body = src("src/app/api/memory/recap/route.ts");
  assert.match(body, /RECAP_PERIODS as readonly number\[\]\)\.includes\(requested\) \? requested : 30/);
  assert.equal(/\.(create|update|upsert|delete)(Many)?\(/.test(body), false);
});

test("the recap is given every row in scope, suppressions included", () => {
  // "What Juno let go of" is dated by suppressions; a recap handed only facts
  // would silently report that nothing was ever forgotten. The page can be
  // narrowed to one project now, and a forget holds in every project, so the
  // scoped slice keeps the block-list (memoriesInScope, tested in
  // memory-project.test.ts).
  // The recap lives in the activity sheet; the manager hands the sheet the
  // scoped slice and the sheet hands it on untouched.
  const manager = src("src/components/memory/memory-manager.tsx");
  assert.match(manager, /<ActivitySheet[\s\S]{0,600}memories=\{scopedMemories\}/);
  assert.match(manager, /memoriesInScope\(memory\.memories \?\? \[\], activeScope\)/);
  assert.match(src("src/components/memory/activity-sheet.tsx"), /<RecapView[\s\S]{0,200}memories=\{memories\}/);
});
