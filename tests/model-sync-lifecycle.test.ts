import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CURATED_GEN_MODELS, GEN_MODELS, MODEL_LIST, type ModelInfo } from "../src/lib/models";
import type { OfficialRateEntry } from "../src/lib/model-rates.generated";
import { applyPlanChanges, applyPlanToModels, mergeRates } from "../scripts/model-sync/apply";
import { compare, type Catalogue, type Plan } from "../scripts/model-sync/compare";
import { pageFileName } from "../scripts/model-sync/fetch";
import { isOverdue, lifecycleProblems } from "../scripts/model-sync/lifecycle";
import { GOOGLE_PAGES, google } from "../scripts/model-sync/labs/google";
import type { ModelFact } from "../scripts/model-sync/types";

/*
 * Lifecycle metadata and the nightly sync's tolerance for one bad row.
 *
 * From 2026-10-19 the scheduled model sync failed every night on
 * "google:gemini-3.1-flash-image: replacedBy without retiresOn": Google had
 * deprecated Nano Banana 2 and named its successor, but announced no shutdown
 * date, and the row carried the successor as `replacedBy` with no date. These
 * tests pin the honest shape of that state, the checks validate:models and
 * models:sync now share (scripts/model-sync/lifecycle.ts), and that one bad
 * row or one unreadable lab never holds back the rest of a run.
 *
 * The catalogue below is built here, not read from models.ts, so a later
 * retirement in the real catalogue cannot break these tests.
 */

const DAY = "2026-10-25";
const row = (provider: "google" | "openai", id: string, patch: Partial<ModelInfo> = {}): ModelInfo => ({
  id: `${provider}:${id}`,
  provider,
  providerModel: id,
  name: id,
  description: "x",
  minPlan: "PRO",
  vision: false,
  reasoning: false,
  agenticTools: false,
  cost: 2,
  modality: "image",
  webSearch: false,
  status: "current",
  legacy: false,
  family: "image",
  ...patch,
});
const deprecated = (patch: Partial<ModelInfo>): Partial<ModelInfo> => ({ status: "deprecated", legacy: true, ...patch });

const NANO_BANANA_21 = row("google", "gemini-nano-banana-2.1", { family: "gemini-image-flash" });
// Today's shape: Google deprecated it and named 2.1, with "No shutdown date announced".
const NANO_BANANA_2 = row("google", "gemini-3.1-flash-image", { family: "gemini-image-flash", ...deprecated({ deprecationNote: "Deprecated by Google. Use Nano Banana 2.1" }) });
// The Oct 18 row that broke the nightly job.
const BROKEN_NANO_BANANA_2: ModelInfo = { ...NANO_BANANA_2, replacedBy: NANO_BANANA_21.id };
const SUNBURST = row("openai", "gpt-image-2.5-sunburst", { family: "gpt-image" });
const LEGACY_IMAGE = row("openai", "gpt-image-2", { family: "gpt-image", status: "legacy", legacy: true });
const CHAT = row("openai", "gpt-6.1-sol", { modality: "chat", family: "sol" });
const RETIRING_IMAGE = row("openai", "gpt-image-1.5", {
  family: "gpt-image",
  ...deprecated({ deprecationNote: "Retires Dec 1, 2026. Use GPT Image 2.5 Sunburst", retiresOn: "2026-12-01", replacedBy: SUNBURST.id }),
});
const OVERDUE_IMAGE = row("openai", "gpt-image-1", {
  family: "gpt-image",
  ...deprecated({ deprecationNote: "Retires Oct 23, 2026. Use GPT Image 2.5", retiresOn: "2026-10-23", replacedBy: SUNBURST.id }),
});
const SERVED = [NANO_BANANA_21, NANO_BANANA_2, SUNBURST, LEGACY_IMAGE, CHAT, RETIRING_IMAGE];
const catalogue = (gen: ModelInfo[]): Catalogue => ({ chat: [CHAT], gen, retired: {}, notCarried: {}, today: DAY });

test("replacedBy without retiresOn is invalid; deprecated with a note and no date is the honest shape", () => {
  assert.deepEqual(lifecycleProblems(NANO_BANANA_2, SERVED), []);
  assert.match(lifecycleProblems(BROKEN_NANO_BANANA_2, SERVED).join("\n"), /^replacedBy without retiresOn/m);
  // The real row, for as long as it is curated without a date.
  const real = CURATED_GEN_MODELS.find((m) => m.id === NANO_BANANA_2.id);
  if (real && !real.retiresOn) {
    assert.equal(real.status, "deprecated");
    assert.equal(real.replacedBy, undefined, "no replacedBy until Google gives a date");
    assert.match(real.deprecationNote ?? "", /Use Nano Banana 2\.1/);
  }
});

test("invalid lifecycle metadata is named field by field", () => {
  const problems = (patch: Partial<ModelInfo>) => lifecycleProblems({ ...RETIRING_IMAGE, ...patch }, SERVED).join("\n");
  assert.deepEqual(lifecycleProblems(RETIRING_IMAGE, SERVED), []);
  assert.match(problems({ retiresOn: "2026-12-1", deprecationNote: "Retires soon" }), /is not YYYY-MM-DD/);
  assert.match(problems({ replacedBy: undefined }), /retiresOn without replacedBy/);
  assert.match(problems({ replacedBy: "openai:gpt-image-9" }), /is not a registered model/);
  assert.match(problems({ replacedBy: LEGACY_IMAGE.id }), /is legacy, not current/);
  assert.match(problems({ replacedBy: CHAT.id }), /is a chat model, not image/);
  assert.match(problems({ replacedBy: RETIRING_IMAGE.id }), /is deprecated, not current/);
  assert.match(problems({ retiresOn: "2026-12-02" }), /deprecationNote says 2026-12-01 but retiresOn is 2026-12-02/);
  assert.match(problems({ deprecationNote: undefined }), /deprecated without a deprecationNote/);
  assert.match(problems({ retiresOn: undefined, replacedBy: undefined }), /promises a retirement .* but there is no retiresOn/);
});

test("every row the real catalogue serves passes the shared lifecycle checks", () => {
  const served = [...MODEL_LIST, ...GEN_MODELS];
  for (const m of served) assert.deepEqual(lifecycleProblems(m, served), [], m.id);
});

test("an overdue retirement is planned as a move into RETIRED_MODELS", () => {
  assert.equal(isOverdue(OVERDUE_IMAGE, DAY), true);
  assert.equal(isOverdue(OVERDUE_IMAGE, "2026-10-23"), false, "retiresOn is the last day it still answers");
  assert.equal(isOverdue({ retiresOn: "2026-1-5" }, DAY), false, "a malformed date never counts as passed");
  const plan = compare([], catalogue([...SERVED.filter((m) => m.modality === "image"), OVERDUE_IMAGE]), [], [], new Set());
  assert.deepEqual(plan.expiries, [{ id: OVERDUE_IMAGE.id, provider: "openai", replacedBy: SUNBURST.id, retiresOn: "2026-10-23" }]);
  assert.ok(plan.findings.some((f) => f.kind === "expired" && f.model === OVERDUE_IMAGE.id && f.applied));
});

test("one row with invalid lifecycle metadata is set aside; the rest of the run is still planned", () => {
  const unregisteredHeir = row("openai", "gpt-image-0", { ...OVERDUE_IMAGE, id: "openai:gpt-image-0", providerModel: "gpt-image-0", replacedBy: "openai:gpt-image-9" });
  const gen = [NANO_BANANA_21, BROKEN_NANO_BANANA_2, SUNBURST, LEGACY_IMAGE, RETIRING_IMAGE, OVERDUE_IMAGE, unregisteredHeir];
  const plan = compare([], catalogue(gen), [], [], new Set());
  const review = plan.findings.filter((f) => f.kind === "needs-review");
  assert.deepEqual(review.map((f) => f.model).sort(), [BROKEN_NANO_BANANA_2.id, unregisteredHeir.id]);
  assert.ok(review.every((f) => f.severity === "warn" && !f.applied));
  assert.deepEqual(plan.expiries.map((e) => e.id), [OVERDUE_IMAGE.id], "the valid overdue row still retires; the bad one is not redirected into a model that does not exist");
});

test("a change that cannot land is skipped whole and reported; the others land", () => {
  const src = [
    "const GENERATIVE: ModelInfo[] = [",
    '  def({ provider: "openai", id: "gpt-image-1", name: "GPT Image 1", family: "gpt-image", status: "deprecated", modality: "image", minPlan: "PRO", cost: 2, description: "x", deprecationNote: "Retires Oct 23, 2026. Use GPT Image 2.5", retiresOn: "2026-10-23", replacedBy: "openai:gpt-image-2.5-sunburst" }),',
    // Hand-wrapped over two lines: the one-line row pattern cannot find it.
    "  def({",
    '    provider: "openai", id: "gpt-image-2", name: "GPT Image 2", family: "gpt-image", status: "current", modality: "image", minPlan: "PRO", cost: 3, description: "y" }),',
    "];",
    "export const RETIRED_MODELS: Record<string, ModelId> = {",
    '  "openai:dall-e-3": "openai:gpt-image-2",',
    "};",
    "",
  ].join("\n");
  const plan: Plan = {
    findings: [
      { severity: "change", kind: "expired", model: "openai:gpt-image-1", message: "retired", applied: true },
      { severity: "change", kind: "expired", model: "openai:gone-already", message: "retired", applied: true },
      { severity: "change", kind: "new-model", model: "openai:gpt-image-3", message: "added", applied: true },
    ],
    rates: { "openai:gpt-image-3": { input: 1, output: 2, source: "https://example.test", verified: DAY } },
    edits: [{ id: "openai:gpt-image-2", provider: "openai", set: { status: "legacy", contextWindow: 1 } }],
    additions: [
      { provider: "openai", id: "gpt-image-3", name: "GPT Image 3", family: "gpt-image", minPlan: "PRO", vision: true, reasoning: false, cost: 2, contextWindow: 1, description: "z.", before: "openai:gpt-image-2", sources: [] },
    ],
    expiries: [
      { id: "openai:gpt-image-1", provider: "openai", replacedBy: "openai:gpt-image-2.5-sunburst", retiresOn: "2026-10-23" },
      { id: "openai:gone-already", provider: "openai", replacedBy: "openai:gpt-image-2.5-sunburst", retiresOn: "2026-10-23" },
    ],
    redirects: [{ from: "openai:dall-e-3", was: "openai:gpt-image-2", to: "openai:gpt-image-3" }],
  };
  const { src: out, skipped, notAdded } = applyPlanChanges(src, plan, DAY);
  assert.doesNotMatch(out, /id: "gpt-image-1",/, "the valid expiry landed");
  assert.match(out, /"openai:gpt-image-1": "openai:gpt-image-2.5-sunburst", \/\/ retired 2026-10-23 \(models:sync\)/);
  assert.deepEqual([...notAdded], ["openai:gpt-image-3"]);
  assert.match(out, /"openai:dall-e-3": "openai:gpt-image-2",/, "no redirect points at the row that was not added");
  assert.match(out, /id: "gpt-image-2", .*status: "current", modality/, "its predecessor does not step down for a model that is not there");
  assert.doesNotMatch(out, /contextWindow: 1/, "and that edit is skipped whole");
  assert.deepEqual(skipped.map((f) => f.model).sort(), ["openai:dall-e-3", "openai:gone-already", "openai:gpt-image-2", "openai:gpt-image-3"]);
  assert.ok(skipped.every((f) => f.kind === "needs-review" && f.severity === "warn"));

  // Recorded on the plan: skipped findings stop claiming "applied", and an unadded model's rate is not written.
  applyPlanToModels(src, plan, DAY);
  const applied = (model: string, kind: string) => plan.findings.find((f) => f.model === model && f.kind === kind)?.applied;
  assert.equal(applied("openai:gpt-image-1", "expired"), true);
  assert.equal(applied("openai:gone-already", "expired"), false);
  assert.equal(applied("openai:gpt-image-3", "new-model"), false);
  assert.equal(plan.rates["openai:gpt-image-3"], undefined);
});

test("partial source failure: a lab that was not read is never treated as verified", () => {
  const entry = (verified: string): OfficialRateEntry => ({ input: 1, output: 2, source: "https://example.test", verified });
  const previous = { "openai:a": entry("2026-10-18"), "google:b": entry("2026-10-18"), "google:dropped": entry("2026-10-18") };
  const merged = mergeRates(previous, { "google:b": entry(DAY) }, (provider) => provider === "openai");
  assert.deepEqual(merged["openai:a"], entry("2026-10-18"), "the failed lab keeps the day its rate was really read");
  assert.equal(merged["google:b"].verified, DAY);
  assert.equal(merged["google:dropped"], undefined, "a lab that was read keeps nothing its page no longer prices");

  // Google's saved pages read, OpenAI's failed: Google's facts are reported,
  // OpenAI's rows only follow their own dates.
  const dir = path.join(process.cwd(), "tests/fixtures/model-sync");
  const facts: ModelFact[] = google.parse(
    { pricing: readFileSync(path.join(dir, pageFileName(GOOGLE_PAGES.pricing)), "utf8"), deprecations: readFileSync(path.join(dir, pageFileName(GOOGLE_PAGES.deprecations)), "utf8") },
    "2026-10-10"
  );
  const plan = compare(facts, catalogue([NANO_BANANA_21, NANO_BANANA_2, SUNBURST, OVERDUE_IMAGE]), [], [], new Set(["google"]));
  assert.ok(!plan.findings.some((f) => f.model?.startsWith("openai:") && f.kind !== "expired"), "nothing is said about a lab that was not read");
  assert.ok(Object.keys(plan.rates).every((id) => id.startsWith("google:")));
  assert.deepEqual(plan.expiries.map((e) => e.id), [OVERDUE_IMAGE.id]);
  // Google names Nano Banana 2.1 with "No shutdown date announced": reported, nothing written.
  const nb2 = plan.findings.find((f) => f.model === NANO_BANANA_2.id);
  assert.match(nb2?.message ?? "", /names gemini-nano-banana-2\.1 as its replacement but announces no shutdown date/);
  assert.equal(nb2?.applied, undefined);
  assert.equal(plan.edits.find((e) => e.id === NANO_BANANA_2.id), undefined);
});

test("partial source failure end to end: the run finishes, names the labs it could not read, and keeps the rest", { timeout: 120_000 }, () => {
  const pages = mkdtempSync(path.join(tmpdir(), "model-sync-pages-"));
  try {
    for (const url of Object.values(GOOGLE_PAGES)) {
      copyFileSync(path.join(process.cwd(), "tests/fixtures/model-sync", pageFileName(url)), path.join(pages, pageFileName(url)));
    }
    const out = path.join(pages, "report.md");
    const r = spawnSync("npx", ["tsx", "scripts/model-sync/index.ts", "--pages", pages, "--no-discovery", "--today", DAY, "--out", out], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const report = readFileSync(out, "utf8");
    assert.match(report, /^Dry run: /m);
    assert.match(report, /^- Official pages read: google; failed: anthropic, openai, /m);
    assert.match(report, /^## Sources that failed$/m);
    assert.match(report, /`openai` official pages could not be read or parsed: no saved page/);
  } finally {
    rmSync(pages, { recursive: true, force: true });
  }
});
