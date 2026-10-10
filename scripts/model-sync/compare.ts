import type { ModelInfo } from "../../src/lib/models";
import type { OfficialRateEntry } from "../../src/lib/model-rates.generated";
import { modelGeneration } from "../../src/lib/model-metrics";
import { fastModeMultiplier, longContextPricing, tokenRate, ultraFastMultiplier } from "../../src/lib/pricing";
import { PROVIDERS, type Provider } from "../../src/lib/providers";
import type { Listing } from "./lab-apis";
import type { Discovery } from "./openrouter";
import { addDays } from "./tables";
import type { Finding, ModelFact, Source } from "./types";

/**
 * Official facts against the catalogue: what differs, and what `--apply` may
 * write. The rules, in the order the owner asked for them:
 *
 *  1. Never invent. A field is written only when an official page states it;
 *     a page that does not say leaves the catalogue's value alone.
 *  2. Prices come only from the lab's own pricing page, with its URL. A free
 *     model, a scheduled promo, or a figure two pages disagree on is reported
 *     and never written.
 *  3. Retirements move EARLIER automatically (a model leaving sooner is the
 *     safe direction); a later official date, or a model missing from a lab's
 *     model-list API, is reported for a person to confirm.
 *  4. New models are added only with every required field verified, and only
 *     for labs whose pages give the family line; anything short of that is a
 *     "new model" line in the report with what is missing.
 */

export interface Catalogue {
  chat: readonly ModelInfo[];
  gen: readonly ModelInfo[];
  retired: Readonly<Record<string, string>>;
  /** Ids a lab lists that Juno deliberately does not carry, with the reason. */
  notCarried: Readonly<Record<string, string>>;
  today: string;
}

export interface LifecycleEdit {
  id: string;
  provider: Provider;
  set: Partial<Pick<ModelInfo, "status" | "retiresOn" | "replacedBy" | "deprecationNote" | "vision" | "contextWindow">>;
}

export interface Addition {
  provider: Provider;
  id: string;
  name: string;
  family: string;
  minPlan: "FREE" | "PRO";
  vision: boolean;
  reasoning: boolean;
  cost: 1 | 2 | 3;
  contextWindow: number;
  released?: string; // YYYY-MM
  description: string;
  /** Insert above this catalogue row (the family's previous current model). */
  before?: string;
  sources: Source[];
}

export interface Plan {
  findings: Finding[];
  rates: Record<string, OfficialRateEntry>;
  edits: LifecycleEdit[];
  additions: Addition[];
  /** Rows past their retiresOn: removed from the curated list into RETIRED_MODELS. */
  expiries: { id: string; provider: Provider; replacedBy: string; retiresOn: string }[];
}

/** The company, as a deprecation note names it. */
const LAB_NAME: Record<Provider, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", mimo: "Xiaomi", deepseek: "DeepSeek", qwen: "Alibaba",
  zhipu: "Z.ai", moonshot: "Moonshot", minimax: "MiniMax", xai: "xAI", mistral: "Mistral", meta: "Meta", longcat: "Meituan", seedance: "ByteDance",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function spellDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// Half a percent: a ratio-derived rate ($0.66 x 0.0333) against the page's
// rounded figure ($0.022) is the same price, not a correction worth a line.
const near = (a: number | undefined, b: number | undefined, tol = 0.005) =>
  a == null || b == null ? a == null && b == null : Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const money = (n: number | undefined) => (n == null ? "-" : `$${+n.toFixed(4)}`);
const pair = (i?: number, o?: number) => `${money(i)} / ${money(o)}`;

function costTier(input: number): 1 | 2 | 3 {
  if (input <= 1) return 1;
  if (input <= 3) return 2;
  return 3;
}

/** A model if it is current and not retiring, else its family's current heir. */
function currentHeir(m: ModelInfo, all: readonly ModelInfo[]): ModelInfo | null {
  if (m.status === "current" && !m.retiresOn) return m;
  return all.find((x) => x.provider === m.provider && x.family === m.family && x.modality === m.modality && x.status === "current" && !x.retiresOn) ?? null;
}

/**
 * Where a retiring model's stored ids should land: the lab's named
 * replacement, followed to its family's current model (validate:models wants
 * a current target), else the retiring model's own family heir.
 */
function heirOf(targetId: string | undefined, all: readonly ModelInfo[], from: ModelInfo): ModelInfo | null {
  const target = targetId ? all.find((m) => m.id === targetId) : undefined;
  const viaTarget = target ? currentHeir(target, all) : null;
  if (viaTarget && viaTarget.id !== from.id) return viaTarget;
  const viaFamily = currentHeir(from, all);
  return viaFamily && viaFamily.id !== from.id ? viaFamily : null;
}

function officialEntry(f: ModelFact): OfficialRateEntry | null {
  if (!f.rates || f.free || f.scheduledPrice) return null;
  const src = f.sources.rates;
  if (!src) return null;
  const e: OfficialRateEntry = { input: f.rates.input, output: f.rates.output, source: src.url, verified: src.fetched };
  for (const k of ["cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h"] as const) if (f.rates[k] != null) e[k] = f.rates[k];
  if (f.longContext !== undefined) e.longContext = f.longContext;
  if (f.fast !== undefined) e.fast = f.fast ? { input: f.fast.input, output: f.fast.output } : null;
  if (f.ultrafast !== undefined) e.ultrafast = f.ultrafast ? { input: f.ultrafast.input, output: f.ultrafast.output } : null;
  return e;
}

/** Family for a new model, only where the lab's naming states the line. */
function familyFor(f: ModelFact, chat: readonly ModelInfo[]): { family: string; predecessor?: ModelInfo } | null {
  const lab = chat.filter((m) => m.provider === f.provider);
  const currentOf = (family: string) => lab.find((m) => m.family === family && m.status === "current");
  if (f.provider === "anthropic") {
    const line = f.name?.match(/^Claude\s+(Fable|Mythos|Opus|Sonnet|Haiku)\b/i)?.[1]?.toLowerCase();
    if (!line) return null;
    return { family: line, predecessor: currentOf(line) };
  }
  if (f.provider === "openai") {
    // "GPT-6.1 Sol" continues the line of "GPT-6 Sol": the same tier word.
    const tier = f.name?.match(/^GPT-[\d.]+\s+(Astra|Sol|Terra|Luna|Mini|Nano|Pro)$/i)?.[1]?.toLowerCase();
    if (!tier) return null;
    const sibling = lab.find((m) => m.status === "current" && new RegExp(`\\b${tier}$`, "i").test(m.name));
    return sibling ? { family: sibling.family!, predecessor: sibling } : null;
  }
  return null;
}

export function compare(
  facts: ModelFact[],
  cat: Catalogue,
  listings: Listing[],
  discoveries: Discovery[],
  checkedProviders: ReadonlySet<Provider>
): Plan {
  const findings: Finding[] = [];
  const rates: Record<string, OfficialRateEntry> = {};
  const edits: LifecycleEdit[] = [];
  const additions: Addition[] = [];
  const expiries: Plan["expiries"] = [];
  const all = [...cat.chat, ...cat.gen];
  const byId = new Map(all.map((m) => [m.id, m]));
  const factById = new Map(facts.map((f) => [`${f.provider}:${f.id}`, f]));
  const editFor = (m: ModelInfo) => {
    let e = edits.find((x) => x.id === m.id);
    if (!e) {
      e = { id: m.id, provider: m.provider, set: {} };
      edits.push(e);
    }
    return e;
  };
  const src = (f: ModelFact, ...fields: (keyof ModelFact["sources"])[]) =>
    fields.map((k) => f.sources[k]).filter((s): s is Source => !!s).filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i);

  // —— Catalogue rows the lab's pages describe ——
  for (const m of all) {
    const f = factById.get(m.id);
    if (!f) {
      if (checkedProviders.has(m.provider) && !m.retiresOn) {
        findings.push({ severity: "info", kind: "unverified", model: m.id, message: "not on the official pages this run reads; Juno keeps its hand-coded facts" });
      }
      continue;
    }

    // Prices.
    if (m.modality === "chat") {
      if (f.free) {
        findings.push({ severity: "info", kind: "rate", model: m.id, message: "the lab lists it as free; billing keeps its nominal metering floor", sources: src(f, "free") });
      } else if (f.scheduledPrice) {
        const now = tokenRate(m);
        findings.push({ severity: "info", kind: "rate", model: m.id, message: `scheduled price on the lab's page (kept in scheduled-prices.ts): ${f.scheduledPrice}`, current: pair(now.input, now.output), sources: src(f, "scheduledPrice") });
      } else if (f.rates) {
        const entry = officialEntry(f);
        const now = tokenRate(m);
        if (entry) {
          rates[m.id] = entry;
          const diffs: string[] = [];
          if (!near(now.input, entry.input) || !near(now.output, entry.output)) diffs.push(`input/output ${pair(now.input, now.output)} -> ${pair(entry.input, entry.output)}`);
          if (entry.cacheRead != null && !near(now.cacheRead, entry.cacheRead)) diffs.push(`cache read ${money(now.cacheRead)} -> ${money(entry.cacheRead)}`);
          if (entry.cacheWrite1h != null && !near(now.cacheWrite1h, entry.cacheWrite1h)) diffs.push(`1h cache write ${money(now.cacheWrite1h)} -> ${money(entry.cacheWrite1h)}`);
          if (entry.cacheWrite != null && m.provider !== "anthropic" && !near(now.cacheWrite, entry.cacheWrite)) diffs.push(`cache write ${money(now.cacheWrite)} -> ${money(entry.cacheWrite)}`);
          if (diffs.length) {
            const ratio = Math.max(entry.input / now.input, now.input / entry.input, entry.output / now.output, now.output / entry.output);
            findings.push({
              severity: ratio > 3 ? "warn" : "change",
              kind: "rate",
              model: m.id,
              message: `${diffs.join("; ")}${ratio > 3 ? ` (a ${ratio.toFixed(1)}x move: check the page)` : ""}${f.notes?.length ? ` [${f.notes.join("; ")}]` : ""}`,
              sources: src(f, "rates"),
              applied: true,
            });
          } else if (f.notes?.length) {
            findings.push({ severity: "info", kind: "rate", model: m.id, message: `matches the page [${f.notes.join("; ")}]`, sources: src(f, "rates") });
          }
          const lcNow = longContextPricing(m);
          if (entry.longContext !== undefined && JSON.stringify(lcNow) !== JSON.stringify(entry.longContext)) {
            const show = (lc: typeof lcNow | undefined) => (lc ? `${lc.inclusive ? ">=" : ">"}${lc.threshold / 1000}K: ${lc.inputMultiplier}x in / ${lc.outputMultiplier}x out` : "none");
            findings.push({ severity: "change", kind: "long-context", model: m.id, message: `long-context surcharge ${show(lcNow)} -> ${show(entry.longContext)}`, sources: src(f, "longContext"), applied: true });
          }
          const fastNow = fastModeMultiplier(m);
          const fastNew = entry.fast === undefined ? fastNow : entry.fast ? Math.round((entry.fast.input / entry.input) * 100) / 100 : null;
          if (fastNow !== fastNew) {
            findings.push({ severity: "change", kind: "fast-tier", model: m.id, message: `fast tier ${fastNow == null ? "none" : `${fastNow}x`} -> ${fastNew == null ? "none" : `${fastNew}x`}`, sources: src(f, "fast"), applied: true });
          }
          const ultraNow = ultraFastMultiplier(m);
          const ultraNew = entry.ultrafast ? Math.round((entry.ultrafast.input / entry.input) * 100) / 100 : null;
          if (ultraNow !== ultraNew) {
            findings.push({ severity: "change", kind: "fast-tier", model: m.id, message: `ultrafast tier ${ultraNow == null ? "none" : `${ultraNow}x`} -> ${ultraNew == null ? "none" : `${ultraNew}x`}`, sources: src(f, "ultrafast"), applied: true });
          }
        }
      } else if (!m.retiresOn) {
        findings.push({ severity: "info", kind: "unverified", model: m.id, message: "listed by the lab, but no price could be read for it; Juno keeps its hand-coded rate", sources: src(f, "listed") });
      }
    }

    // Context window: written only when clearly wrong (more than 5% off), so a
    // page's "1M" never churns an exact 1,048,576.
    if (f.contextWindow && m.contextWindow && Math.abs(f.contextWindow - m.contextWindow) / f.contextWindow > 0.05) {
      editFor(m).set.contextWindow = f.contextWindow;
      findings.push({ severity: "change", kind: "context-window", model: m.id, message: `context window ${m.contextWindow.toLocaleString("en-US")} -> ${f.contextWindow.toLocaleString("en-US")}`, sources: src(f, "contextWindow"), applied: true });
    }

    // Capabilities: only a page's explicit "text only" removes vision; adding
    // one waits for the capability probe.
    if (f.vision === false && m.vision) {
      editFor(m).set.vision = false;
      findings.push({ severity: "change", kind: "capability", model: m.id, message: "vision on -> off (the lab's page says text input only)", sources: src(f, "vision"), applied: true });
    } else if (f.vision === true && !m.vision && m.modality === "chat") {
      findings.push({ severity: "warn", kind: "capability", model: m.id, message: "the lab's page lists image input; Juno has vision off (confirm with npm run models:probe)", sources: src(f, "vision") });
    }

    // Retirement.
    const officialLast =
      f.retiresOn ?? (f.autoRoutedFrom ? addDays(f.autoRoutedFrom, -1) : f.lifecycle === "retired" || f.autoRouted ? addDays(cat.today, -1) : undefined);
    if (officialLast && (f.lifecycle === "deprecated" || f.lifecycle === "retired" || f.autoRoutedFrom || f.autoRouted)) {
      if (!m.retiresOn || officialLast < m.retiresOn) {
        const heir = heirOf(f.replacement ? `${m.provider}:${f.replacement}` : m.replacedBy, all, m);
        if (!heir || heir.id === m.id) {
          findings.push({ severity: "warn", kind: "retirement", model: m.id, message: `the lab retires it ${officialLast}, but no current replacement could be resolved from "${f.replacement ?? "-"}"; not applied`, sources: src(f, "retiresOn", "lifecycle", "autoRoutedFrom") });
        } else {
          const lab = LAB_NAME[m.provider];
          const servedBy = f.replacement ? byId.get(`${m.provider}:${f.replacement}`)?.name ?? f.replacement : null;
          const routed = servedBy
            ? f.autoRoutedFrom
              ? ` (${lab} answers it with ${servedBy} from ${spellDate(f.autoRoutedFrom).replace(/, \d{4}$/, "")})`
              : f.autoRouted
                ? ` (${lab} already answers it with ${servedBy})`
                : ""
            : "";
          const note = `Retires ${spellDate(officialLast)}${routed}. Use ${heir.name}`;
          Object.assign(editFor(m).set, { status: "deprecated", retiresOn: officialLast, replacedBy: heir.id, deprecationNote: note });
          findings.push({
            severity: "change",
            kind: (f.autoRoutedFrom || f.autoRouted) && !f.retiresOn ? "auto-routed" : "retirement",
            model: m.id,
            message: `retires ${m.retiresOn ?? "(no date)"} -> ${officialLast}, replaced by ${heir.id}`,
            current: m.deprecationNote,
            official: note,
            sources: src(f, "retiresOn", "lifecycle", "autoRoutedFrom", "replacement"),
            applied: true,
          });
        }
      } else if (officialLast > m.retiresOn) {
        findings.push({ severity: "warn", kind: "retirement", model: m.id, message: `the lab now says ${officialLast}, later than the catalogue's ${m.retiresOn}; extending a retirement is left to a person`, sources: src(f, "retiresOn") });
      }
    }

    // Superseded within its line, per the lab's own legacy list.
    if (f.lifecycle === "legacy" && m.status === "current" && !m.retiresOn) {
      const others = all.filter((x) => x.provider === m.provider && x.family === m.family && x.modality === m.modality && x.status === "current" && x.id !== m.id);
      const incoming = facts.some((x) => x.provider === m.provider && x.lifecycle === "active" && !byId.has(`${x.provider}:${x.id}`) && familyFor(x, cat.chat)?.family === m.family);
      if (others.length || incoming) {
        editFor(m).set.status = "legacy";
        findings.push({ severity: "change", kind: "lifecycle", model: m.id, message: "current -> legacy (the lab lists it among its legacy models)", sources: src(f, "lifecycle"), applied: true });
      }
    }

    // Earliest-retirement promises that are close.
    for (const note of f.notes ?? []) {
      const d = note.match(/earliest retirement (\d{4}-\d{2}-\d{2})/)?.[1];
      if (d && d <= addDays(cat.today, 45)) findings.push({ severity: "info", kind: "lifecycle", model: m.id, message: `the lab promises it until at least ${d}; expect a deprecation notice soon`, sources: src(f, "listed") });
    }
  }

  // —— Expired rows: move to RETIRED_MODELS ——
  for (const m of all) {
    const retiresOn = edits.find((e) => e.id === m.id)?.set.retiresOn ?? m.retiresOn;
    const replacedBy = edits.find((e) => e.id === m.id)?.set.replacedBy ?? m.replacedBy;
    if (retiresOn && retiresOn < cat.today && replacedBy) {
      expiries.push({ id: m.id, provider: m.provider, replacedBy, retiresOn });
      findings.push({ severity: "change", kind: "expired", model: m.id, message: `retired ${retiresOn}: removed from the catalogue, stored ids redirect to ${replacedBy}`, applied: true });
    }
  }
  // An expiring row cannot be anybody's replacement.
  for (const e of edits) {
    if (e.set.replacedBy && expiries.some((x) => x.id === e.set.replacedBy)) {
      findings.push({ severity: "warn", kind: "retirement", model: e.id, message: `its replacement ${e.set.replacedBy} is itself retiring; not applied` });
      delete e.set.replacedBy;
      delete e.set.retiresOn;
      delete e.set.deprecationNote;
      delete e.set.status;
    }
  }

  // —— New models on the labs' own pages ——
  for (const f of facts) {
    const id = `${f.provider}:${f.id}`;
    if (byId.has(id) || cat.retired[id] || cat.notCarried[id]) continue;
    if (f.lifecycle === "deprecated" || f.lifecycle === "retired" || f.lifecycle === "legacy") continue;
    // Dated snapshots and moving aliases are spellings of a line, not new lines.
    if (/-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$|-latest$/.test(f.id)) continue;
    if (!f.sources.listed && !f.sources.name) continue;
    if (f.notes?.includes("limited availability")) continue;
    if (f.modality && f.modality !== "chat") {
      findings.push({ severity: "info", kind: "new-model", model: id, message: `${f.name ?? f.id}: a ${f.modality} model on the lab's pages (media models are wired by hand)`, sources: src(f, "listed", "name") });
      continue;
    }
    const missing: string[] = [];
    if (!f.name) missing.push("name");
    if (!f.contextWindow) missing.push("context window");
    if (!officialEntry(f)) missing.push(f.free ? "a non-free price" : f.scheduledPrice ? "a flat price" : "price");
    if (f.vision == null) missing.push("input modalities");
    if (f.modality !== "chat") missing.push("chat modality");
    const fam = familyFor(f, cat.chat);
    if (!fam) missing.push("a product line the catalogue knows");
    // Only a NEWER generation takes a line over ("GPT-4.1 Mini" is not the
    // next "GPT-5.4 Mini"); an older one is a model Juno chose not to carry.
    const genNew = f.name ? modelGeneration(f.name) : null;
    const genOld = fam?.predecessor ? modelGeneration(fam.predecessor.name) : null;
    if (fam?.predecessor && (genNew == null || genOld == null || genNew <= genOld)) missing.push(`a generation newer than ${fam.predecessor.name}`);
    if (missing.length) {
      // A priced model from a lab whose lines the catalogue maps is worth a
      // person's look; the rest (audio, OCR, regional variants) is a note.
      const worthACheck = !!f.rates && (f.provider === "anthropic" || f.provider === "openai") && !missing.some((x) => x.startsWith("a generation"));
      findings.push({ severity: worthACheck ? "warn" : "info", kind: "new-model", model: id, message: `${f.name ?? f.id}: not added, missing ${missing.join(", ")}`, sources: src(f, "listed", "name", "rates") });
      continue;
    }
    const entry = officialEntry(f)!;
    rates[id] = entry;
    const add: Addition = {
      provider: f.provider,
      id: f.id,
      name: f.name!,
      family: fam!.family,
      minPlan: fam!.predecessor?.minPlan === "FREE" ? "FREE" : "PRO",
      vision: !!f.vision,
      reasoning: f.reasoning ?? false,
      cost: costTier(entry.input),
      contextWindow: f.contextWindow!,
      released: (f.released ?? cat.today).slice(0, 7),
      description: (f.description ?? f.name!).replace(/\s*[—–]\s*/g, ", ").replace(/\.$/, "") + ".",
      before: fam!.predecessor?.id,
      sources: src(f, "name", "contextWindow", "rates", "released", "vision"),
    };
    additions.push(add);
    findings.push({
      severity: "change",
      kind: "new-model",
      model: id,
      message: `${add.name} added: ${pair(entry.input, entry.output)} per MTok${entry.longContext ? ` (${entry.longContext.inputMultiplier}x above ${entry.longContext.threshold / 1000}K)` : ""}, ${add.contextWindow.toLocaleString("en-US")} context, family ${add.family}${add.before ? `, ahead of ${add.before}` : ""}`,
      sources: add.sources,
      applied: true,
    });
    if (fam!.predecessor && fam!.predecessor.status === "current" && !edits.find((e) => e.id === fam!.predecessor!.id)?.set.status) {
      editFor(fam!.predecessor).set.status = "legacy";
      findings.push({ severity: "change", kind: "lifecycle", model: fam!.predecessor.id, message: `current -> legacy (superseded by ${add.name})`, applied: true });
    }
  }

  // —— Lab model-list APIs (keys) ——
  for (const l of listings) {
    for (const m of all.filter((x) => x.provider === l.provider && !x.retiresOn && !x.comingSoon)) {
      if (!l.ids.has(m.providerModel)) {
        findings.push({ severity: "warn", kind: "api-missing", model: m.id, message: `not in ${PROVIDERS[l.provider].label}'s model list for this key: confirm on the lab's deprecation page before retiring it` });
      }
    }
    for (const id of l.ids) {
      const key = `${l.provider}:${id}`;
      if (byId.has(key) || cat.retired[key] || cat.notCarried[key] || factById.has(key)) continue;
      findings.push({ severity: "info", kind: "api-new", model: key, message: "listed by the lab's model API, not in the catalogue or on the pages read" });
    }
  }

  // —— OpenRouter discovery ——
  for (const d of discoveries) {
    findings.push({ severity: "info", kind: "discovery", model: `${d.provider}:${d.slug}`, message: `${d.name} (released ${d.released ?? "?"} on OpenRouter): check ${PROVIDERS[d.provider].label}'s own pages; not added from OpenRouter` });
  }

  return { findings, rates, edits: edits.filter((e) => Object.keys(e.set).length), additions, expiries };
}
