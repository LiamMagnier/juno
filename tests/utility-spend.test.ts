import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_ESTIMATE_MICRO_USD, type SpendKind } from "@/lib/spend-ceiling";

/*
 * Background utility spend reaches the ledger.
 *
 * `runUtilityPrompt` is the provider walk behind chat titles, AI moderation,
 * memory extraction and consolidation, follow-up pills, the memory editor, the
 * UI translator and the research citation judge. It streamed real tokens from
 * real providers and called `recordSpend` for none of it: that money was
 * invisible to the monthly ceiling (`effectiveBudget`/`checkBudget`), absent
 * from the usage page, and — since the citation judge alone can make up to 24
 * calls per research report — not a rounding error.
 *
 * No database here. The walk needs a provider and Prisma to do anything at all,
 * so what is checkable without both is the shape of the decision: that the
 * ledger row comes from the SAME figure the walk reports (one charge, not two
 * calculations that can disagree), that every kind written can be read back by
 * the usage breakdown, and that the one caller with no account behind it is
 * still the only one. The source reading follows tests/memory-suppression.test.ts,
 * which checks the wiring of these same functions the same way.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * `USAGE_SURFACES`, read rather than imported.
 *
 * usage-breakdown.ts is `server-only` and the suite runs without the
 * react-server condition, so importing it throws before a single assertion
 * runs. The list is a literal of string literals; reading it is exact.
 */
function usageSurfaces(): string[] {
  const source = src("src/lib/usage-breakdown.ts");
  const block = source.match(/export const USAGE_SURFACES = \[([\s\S]*?)\] as const;/);
  assert.notEqual(block, null, "USAGE_SURFACES is no longer a literal array — this test is stale");
  return [...block![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

/**
 * The code of one top-level `export async function <name>`, comments removed.
 *
 * Stripping comments matters: the assertions below are about what the function
 * does, and the comments in memory.ts name the very calls being checked for.
 * The `[<(]` is for `runUtilityPrompt<T>(`, which is generic.
 */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`export async function ${name}[<(]`));
  assert.notEqual(start, -1, `${name} not found — this test is reading the wrong thing`);
  const next = source.indexOf("\nexport ", start + 1);
  return source
    .slice(start, next === -1 ? source.length : next)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// The kind
// ---------------------------------------------------------------------------

test("every spend kind is a surface the usage breakdown can name", () => {
  // The ledger's `kind` column is free text, so a kind the read side does not
  // know is not an error anywhere — it just appears as a raw slug in a UI that
  // was supposed to explain where the month went. Both lists are hand-written;
  // this is what keeps them one list.
  const kinds: SpendKind[] = Object.keys(DEFAULT_ESTIMATE_MICRO_USD) as SpendKind[];
  const surfaces = new Set<string>(usageSurfaces());
  for (const kind of kinds) {
    assert.equal(surfaces.has(kind), true, `SpendKind "${kind}" is missing from USAGE_SURFACES`);
  }
  assert.equal(surfaces.size, kinds.length, "USAGE_SURFACES names a surface that is not a SpendKind");
});

test("utility is its own kind, not filed under chat", () => {
  // The whole point of naming it: an account should be able to see what it
  // spent on work it never asked for. Folded into "chat" the money would be
  // visible and unreadable — every request count and cost-per-turn for real
  // conversations would carry a title generation the user never sent.
  assert.equal(usageSurfaces().includes("utility"), true);
  assert.equal(typeof DEFAULT_ESTIMATE_MICRO_USD.utility, "number");
  assert.equal(DEFAULT_ESTIMATE_MICRO_USD.utility > 0, true);
  // One small prompt on a free-tier model — nowhere near a chat turn's hold.
  assert.equal(DEFAULT_ESTIMATE_MICRO_USD.utility < DEFAULT_ESTIMATE_MICRO_USD.chat, true);
});

// ---------------------------------------------------------------------------
// One charge, two ledgers
// ---------------------------------------------------------------------------

test("the walk bills the account from the same figure it reports to its caller", () => {
  const body = functionBody(src("src/lib/memory.ts"), "runUtilityPrompt");

  // Priced ONCE. Two calls to estimateGenerationCostUsd would be two versions
  // of one charge: the research engine reserves against the returned number and
  // the monthly ceiling enforces the row, and those must be the same money.
  const priced = body.match(/estimateGenerationCostUsd\(/g) ?? [];
  assert.equal(priced.length, 1, "the walk prices a call more than once");
  assert.match(body, /const billed = estimateGenerationCostUsd\(/);
  assert.match(body, /spentMicroUsd \+= Math\.round\(billed\.costUsd \* 1_000_000\)/);

  // …and the row is written from that same `billed`.
  assert.match(body, /recordSpend\(\{/);
  assert.match(body, /kind: "utility"/);
  assert.match(body, /promptTokens: billed\.promptTokens/);
  assert.match(body, /completionTokens: billed\.completionTokens/);
  assert.match(body, /costUsd: billed\.costUsd/);
});

test("a walk with no account behind it writes no row", () => {
  // ApiSpend.userId is a foreign key; there is no row to write for the public
  // translation route, and inventing one would attribute a shared cache fill to
  // whichever visitor happened to miss the cache.
  const body = functionBody(src("src/lib/memory.ts"), "runUtilityPrompt");
  assert.match(body, /if \(opts\.userId\) \{\s*await recordSpend\(/);
});

test("the ledger write is awaited, not fired and forgotten", () => {
  // These walks run inside route handlers and `after()` hooks that end the
  // moment the caller has its answer. A floating insert there is a charge that
  // lands only if the process happens to outlive the response.
  const body = functionBody(src("src/lib/memory.ts"), "runUtilityPrompt");
  assert.match(body, /await recordSpend\(\{/);
  assert.equal(/\bvoid recordSpend\(/.test(body), false, "the ledger write became fire-and-forget");
});

test("an injected model layer is not billed by the walk", () => {
  // `llm` is the test seam and the escape hatch for a caller with its own
  // model: the walk neither chose nor priced that call, so it has no honest
  // number for it — the early return happens before any billing.
  const body = functionBody(src("src/lib/memory.ts"), "runUtilityPrompt");
  const earlyReturn = body.slice(0, body.indexOf("const decision ="));
  assert.match(earlyReturn, /if \(opts\.llm\)/);
  assert.equal(/recordSpend/.test(earlyReturn), false, "the injected-model path bills the account");
});

// ---------------------------------------------------------------------------
// The callers
// ---------------------------------------------------------------------------

/** Every file that starts a utility walk, and whether it can name an account. */
const CALLERS = [
  "src/lib/titles.ts",
  "src/lib/moderation-ai.ts",
  "src/lib/memory.ts",
  "src/lib/research/claims.ts",
  "src/app/api/chat/follow-ups/route.ts",
  "src/app/api/memory/edit/route.ts",
  "src/app/api/i18n/translations/route.ts",
] as const;

/** The route with no auth check at all — a platform cost, nobody's account. */
const UNATTRIBUTED = "src/app/api/i18n/translations/route.ts";

test("every utility call site names the account it bills, except the public one", () => {
  // `userId: string | null` is required rather than optional so this is a
  // compile error and not a silent un-billing. What the compiler cannot catch
  // is a future caller reaching for `null` because it is the shorter path, so
  // the exemption is enumerated here instead of being available to anyone.
  for (const file of CALLERS) {
    const source = src(file);
    assert.match(source, /runUtilityPrompt(<[^>]*>)?\(\{/, `${file} no longer starts a utility walk`);
    if (file === UNATTRIBUTED) {
      assert.match(source, /userId: null/);
      continue;
    }
    assert.equal(
      /userId: null/.test(source),
      false,
      `${file} bills a utility walk to nobody — only ${UNATTRIBUTED} may`
    );
  }
});

test("the naming and moderation entry points take the account from their caller", () => {
  // These two had no userId in scope at all: titles.ts and moderation-ai.ts are
  // libraries called from a route that knows the user, so the account had to be
  // threaded in before either could be billed.
  const titles = src("src/lib/titles.ts");
  assert.match(titles, /opts: \{ userId: string \| null; llm\?: UtilityLlm \}/);
  assert.match(titles, /userId: string \| null;\s*firstUser\?: string/);

  const titleRoute = src("src/app/api/conversations/[id]/title/route.ts");
  assert.match(titleRoute, /generateChatTitleFromMessages\(contextMessages, \{ userId: user\.id \}\)/);
  assert.match(titleRoute, /generateProjectName\(\{\s*userId: user\.id/);

  const moderation = src("src/lib/moderation-ai.ts");
  assert.match(moderation, /moderateText\(text, userId\)/);
});

test("the citation judge bills the account as well as the run", () => {
  // Two ledgers, one charge: `onSpend` feeds the run odometer the per-run
  // ceiling reads, `userId` feeds the monthly ledger `checkBudget` reads. A run
  // that stayed inside its own $1 ceiling still spent the month's money.
  const claims = src("src/lib/research/claims.ts");
  assert.match(claims, /userId: string;/);
  assert.match(claims, /userId: opts\.userId,\s*policy: opts\.policy/);
  assert.match(claims, /createCitationJudge\(\{\s*userId: opts\.userId,/);
});

// ---------------------------------------------------------------------------
// What the new rows must not distort
// ---------------------------------------------------------------------------

test("the profile's reply counts exclude the background walk", () => {
  // Several utility calls can fire around ONE message the user sent — a title,
  // a moderation pass, a memory extraction, three follow-up pills. The profile
  // renders these counts under the word "Replies", so counting those rows would
  // multiply a year of activity by a factor that has nothing to do with how
  // much the user wrote. Their cost still shows: the lifetime totals read every
  // row, and the by-kind breakdown gives utility its own line.
  const stats = src("src/app/api/profile/stats/route.ts");
  assert.match(stats, /kind: \{ not: "utility" \}/);
  assert.match(stats, /lifetimeSpends\.filter\(\(s\) => \(s\.kind \|\| "chat"\) !== "utility"\)\.length/);
});
