/**
 * `npm run models:sync` — keep the model catalogue true to the labs' own pages.
 *
 *   npm run models:sync                      dry run: print the report
 *   npm run models:sync -- --out FILE        also write the report to FILE
 *   npm run models:sync -- --apply           write the changes (rates table,
 *                                            models.ts rows, Mac fixture)
 *   npm run models:sync -- --only anthropic,openai
 *   npm run models:sync -- --save-pages DIR  keep every page read
 *   npm run models:sync -- --pages DIR       re-run from saved pages, offline
 *   npm run models:sync -- --today 2026-10-10
 *   npm run models:sync -- --no-api --no-discovery
 *
 * Sources, most trusted first: each lab's model-list API (with its key from
 * the environment), each lab's official pricing / models / deprecation pages,
 * and OpenRouter's keyless catalogue as a discovery signal only. See
 * docs/models/SYNC.md.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURATED_CHAT_MODELS, CURATED_GEN_MODELS, RETIRED_MODELS } from "../../src/lib/models";
import type { Provider } from "../../src/lib/providers";
import { applyPlanToModels, ratesFileHeader, renderRatesFile } from "./apply";
import { compare } from "./compare";
import { pageStore } from "./fetch";
import { readLabListings, type Listing } from "./lab-apis";
import { anthropic, anthropicModelPage } from "./labs/anthropic";
import { minimax, moonshot, qwen, zhipu } from "./labs/compat-labs";
import { deepseek } from "./labs/deepseek";
import { google } from "./labs/google";
import { mimo } from "./labs/mimo";
import { openai, openaiModelPage } from "./labs/openai";
import { xai } from "./labs/xai";
import { discover, OPENROUTER_URL, skeleton, type Discovery, type OrModel } from "./openrouter";
import { renderReport } from "./report";
import type { Finding, LabParser, ModelFact } from "./types";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

export const LABS: LabParser[] = [anthropic, openai, google, xai, deepseek, mimo, zhipu, moonshot, minimax, qwen];
/** Labs whose pages this run cannot parse (JS-rendered or unpublished); API listing only. */
const API_ONLY: Provider[] = ["mistral", "meta", "longcat", "seedance"];

async function main(): Promise<number> {
  const today = opt("today") ?? new Date().toISOString().slice(0, 10);
  const only = opt("only")?.split(",").map((s) => s.trim()) as Provider[] | undefined;
  const store = pageStore({ readDir: opt("pages"), saveDir: opt("save-pages") });
  const notCarried = JSON.parse(readFileSync(join(ROOT, "scripts/model-sync/not-carried.json"), "utf8")) as Record<string, string>;
  const catalogueIds = new Set([...CURATED_CHAT_MODELS, ...CURATED_GEN_MODELS].map((m) => m.id));
  const labs = LABS.filter((l) => !only || only.includes(l.provider));

  const facts: ModelFact[] = [];
  const errors: Finding[] = [];
  const labsRead: string[] = [];
  const labsFailed: string[] = [];
  for (const lab of labs) {
    try {
      const pages: Record<string, string> = {};
      for (const p of lab.pages) pages[p.key] = await store.get(p.url);
      let parsed = lab.parse(pages, today);
      // Second pass: per-model pages for the ids that need them.
      const extra =
        lab.provider === "openai"
          ? parsed
              .filter((f) => {
                const id = `openai:${f.id}`;
                const carried = catalogueIds.has(id) && CURATED_CHAT_MODELS.some((m) => m.id === id);
                const candidate = !catalogueIds.has(id) && !RETIRED_MODELS[id] && !notCarried[id] && f.sources.listed;
                return carried || candidate;
              })
              .map((f) => openaiModelPage(f.id))
          : lab.provider === "anthropic"
            ? parsed.filter((f) => f.lifecycle === "active" && !catalogueIds.has(`anthropic:${f.id}`)).map((f) => anthropicModelPage(f.id))
            : [];
      if (extra.length) {
        for (const p of extra) {
          try {
            pages[p.key] = await store.get(p.url);
          } catch (err) {
            errors.push({ severity: "warn", kind: "source-error", model: `${lab.provider}:${p.key.slice(6)}`, message: `model page unavailable: ${(err as Error).message}` });
          }
        }
        parsed = lab.parse(pages, today);
      }
      facts.push(...parsed);
      labsRead.push(lab.provider);
    } catch (err) {
      labsFailed.push(lab.provider);
      errors.push({ severity: "warn", kind: "source-error", model: lab.provider, message: `official pages could not be read or parsed: ${(err as Error).message}` });
    }
  }

  let listings: Listing[] = [];
  let apiSkipped: { provider: Provider; reason: string }[] = [];
  if (!flag("no-api") && !opt("pages")) {
    const providers = [...labs.map((l) => l.provider), ...API_ONLY.filter((p) => !only || only.includes(p))];
    ({ listings, skipped: apiSkipped } = await readLabListings(providers));
  }

  let discoveries: Discovery[] = [];
  let discovery: "on" | "off" | "failed" = "off";
  if (!flag("no-discovery")) {
    try {
      const body = JSON.parse(await store.get(OPENROUTER_URL)) as { data?: OrModel[] };
      const known = new Set<string>();
      const add = (provider: string, id: string) => known.add(`${provider}:${skeleton(id)}`);
      for (const m of [...CURATED_CHAT_MODELS, ...CURATED_GEN_MODELS]) {
        add(m.provider, m.providerModel);
        add(m.provider, m.name.replace(/^Claude |^Gemini /, ""));
      }
      for (const id of [...Object.keys(RETIRED_MODELS), ...Object.keys(notCarried)]) add(id.split(":")[0], id.slice(id.indexOf(":") + 1));
      for (const f of facts) add(f.provider, f.id);
      discoveries = discover(body.data ?? [], known, today).filter((d) => !only || only.includes(d.provider));
      discovery = "on";
    } catch {
      discovery = "failed";
    }
  }

  const plan = compare(
    facts,
    { chat: CURATED_CHAT_MODELS, gen: CURATED_GEN_MODELS, retired: RETIRED_MODELS, notCarried, today },
    listings,
    discoveries,
    new Set(labsRead as Provider[])
  );
  plan.findings.push(...errors);

  const applying = flag("apply");
  if (applying) {
    const ratesPath = join(ROOT, "src/lib/model-rates.generated.ts");
    const existing = readFileSync(ratesPath, "utf8");
    // A lab whose pages failed this run keeps its previous verified rates.
    const kept = only || labsFailed.length ? (await import("../../src/lib/model-rates.generated")).OFFICIAL_RATES : {};
    const merged: typeof plan.rates = {};
    for (const [id, r] of Object.entries(kept)) {
      const provider = id.split(":")[0] as Provider;
      if (labsFailed.includes(provider) || (only && !only.includes(provider))) merged[id] = r;
    }
    Object.assign(merged, plan.rates);
    writeFileSync(ratesPath, renderRatesFile(merged, ratesFileHeader(existing)));
    const modelsPath = join(ROOT, "src/lib/models.ts");
    writeFileSync(modelsPath, applyPlanToModels(readFileSync(modelsPath, "utf8"), plan, today));
    // The Mac picker's fixture is generated from the catalogue just written,
    // in a fresh process so it reads the new files, not this one's imports.
    // Its pinned day moves to today, so the drift test regenerates the same file.
    const exporter = join(ROOT, "scripts/export-model-picker-fixture.mts");
    writeFileSync(exporter, readFileSync(exporter, "utf8").replace(/DEFAULT_FIXTURE_DAY = "\d{4}-\d{2}-\d{2}"/, `DEFAULT_FIXTURE_DAY = "${today}"`));
    const env = { ...process.env };
    delete env.FIXTURE_DAY;
    const fixture = execFileSync("npx", ["tsx", "scripts/export-model-picker-fixture.mts"], { cwd: ROOT, encoding: "utf8", env });
    writeFileSync(join(ROOT, "native/macOS/JunoDesktop/Tests/Snapshots/ModelPickerWebFixtures.swift"), fixture);
  }

  const report = renderReport(plan, {
    today,
    applied: applying,
    labsRead,
    labsFailed,
    apiChecked: listings.map((l) => l.provider),
    apiSkipped,
    discovery,
  });
  console.log(report);
  const out = opt("out");
  if (out) writeFileSync(out, report + "\n");
  if (applying) console.error("\nApplied. Next: npm run validate:models && npm run models:capabilities:audit && the model tests (docs/models/SYNC.md).");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("models:sync failed:", err);
    process.exit(1);
  });
