/**
 * Live UI spec: JSON (possibly still streaming) → a typed, bounded component
 * tree. docs/design/LIVE_UI.md §2, §4, §5.
 *
 * Normalisation is where every limit is enforced and every model slip is
 * forgiven or dropped — a slider without a max gets a max, a select with no
 * options is not drawn, an unknown type is skipped — so the renderers on both
 * platforms only ever see components that can actually be drawn. The Swift
 * twin is `JunoLiveUISpec.swift`; contracts/live-ui/fixtures/spec.json pins
 * that the two produce the same tree.
 */

import { readLiveJSON, type LiveJSON, type LiveJSONResult } from "@/lib/live-ui/json";
import type { LiveValue } from "@/lib/live-ui/expr";
import { isLiveFormat, parseISODate, type LiveFormat } from "@/lib/live-ui/format";

export { LIVE_UI_FENCES, isLiveUIFence } from "@/lib/live-ui/fence";

export const SPEC_LIMITS = {
  components: 80,
  nesting: 4,
  lets: 40,
  dataRows: 200,
  chartSeries: 4,
  tableColumns: 8,
  parts: 24,
  facts: 8,
  links: 40,
  stops: 25,
  checklist: 40,
  hints: 5,
  options: 12,
  steps: 12,
  questions: 10,
  quizOptions: 6,
  timeline: 20,
  ingredients: 40,
  recipeSteps: 24,
  choices: 8,
  compare: 4,
  pros: 6,
  cards: 12,
  tags: 4,
  tabs: 6,
  flashcards: 30,
  text: 2000,
  label: 120,
} as const;

interface Base {
  /** Stable React/SwiftUI identity: the path of indices ("0.2.1"). */
  key: string;
}

export interface LiveSelectOption {
  label: string;
  value: string | number;
}

export type LiveInput =
  | (Base & { type: "slider"; id: string; label: string; min: number; max: number; step: number; value: number; format?: LiveFormat; unit?: string })
  | (Base & { type: "number"; id: string; label: string; min?: number; max?: number; step?: number; value: number; format?: LiveFormat; unit?: string })
  | (Base & { type: "stepper"; id: string; label: string; min: number; max: number; step: number; value: number; unit?: string })
  | (Base & { type: "select"; id: string; label: string; options: LiveSelectOption[]; value: string | number; style: "segmented" | "menu" })
  | (Base & { type: "toggle"; id: string; label: string; value: boolean })
  | (Base & { type: "date"; id: string; label: string; value: string })
  | (Base & { type: "input"; id: string; label: string; value: string; placeholder?: string });

export interface LiveChartSeries {
  label: string;
  y: string;
}

export interface LiveExplorerPart {
  id: string;
  label: string;
  summary?: string;
  detail: string;
  facts: { label: string; value: string }[];
  at?: [number, number];
}

export interface LiveStep {
  title: string;
  summary?: string;
  detail?: string;
  /** One sentence on what to look at in this step. */
  notice?: string;
  /** The step's visual area: ordinary Live UI components. */
  ui: LiveComponent[];
}

export interface LiveQuizQuestion {
  question: string;
  options: { label: string; explanation?: string }[];
  /** Index of the right option. */
  answer: number;
  explanation?: string;
  hint?: string;
}

export type LiveCalloutTone = "insight" | "tip" | "warning" | "note";

/** One ingredient: a quantity the view scales with the servings, or none ("salt to taste"). */
export interface LiveIngredient {
  name: string;
  qty?: number;
  unit?: string;
  note?: string;
}

/** One option in a compare view: a product, a plan, a route, an approach. */
export interface LiveCompareOption {
  name: string;
  tagline?: string;
  price?: string;
  badge?: string;
  pros: string[];
  cons: string[];
  facts: { label: string; value: string }[];
  /** Sent as the user's next message when they pick this option. */
  prompt?: string;
}

export interface LiveCard {
  title: string;
  subtitle?: string;
  meta?: string;
  detail?: string;
  tags: string[];
  /** 0 to 5. */
  rating?: number;
  prompt?: string;
}

export type LiveComponent =
  | (Base & { type: "row"; children: LiveComponent[]; pending: boolean })
  | (Base & { type: "grid"; columns: number; children: LiveComponent[]; pending: boolean })
  | (Base & { type: "section"; title?: string; children: LiveComponent[]; pending: boolean })
  | LiveInput
  | (Base & { type: "metric"; label: string; value: string; format?: LiveFormat; unit?: string; hint?: string; emphasis: boolean })
  | (Base & { type: "text"; text: string; tone: "body" | "muted" | "heading" })
  | (Base & { type: "progress"; label: string; value: string; max: string; format?: LiveFormat })
  | (Base & {
      type: "chart";
      kind: "line" | "area" | "bar";
      title?: string;
      x?: { from: string; to: string; step: string; variable: string; label?: string };
      rows?: string;
      xKey?: string;
      series: LiveChartSeries[];
      format?: LiveFormat;
      xFormat?: LiveFormat;
      /** An x to mark with a rule (a cutoff, "today"); the readout rests there. */
      mark?: string;
    })
  | (Base & {
      type: "table";
      rows: string;
      columns: { label: string; value: string; format?: LiveFormat; unit?: string }[];
      /** The first column names each row (a comparison's aspect column). */
      rowHeader?: boolean;
      /** A column index to set apart (the recommended option). */
      highlight?: number;
    })
  | (Base & { type: "steps"; title?: string; steps: LiveStep[]; takeaway?: string })
  | (Base & { type: "quiz"; title?: string; questions: LiveQuizQuestion[] })
  | (Base & { type: "callout"; tone: LiveCalloutTone; title?: string; text: string; more?: string })
  | (Base & { type: "timeline"; title?: string; items: { label: string; detail?: string; time?: string }[] })
  | (Base & { type: "explorer"; title?: string; parts: LiveExplorerPart[]; links: [string, string][] })
  | (Base & { type: "stops"; title?: string; stops: { name: string; time?: string; note?: string; query: string }[] })
  | (Base & { type: "checklist"; id: string; title?: string; items: { label: string; note?: string }[] })
  | (Base & { type: "button"; label: string; prompt?: string; copy?: string })
  /**
   * An exercise the reader answers in the view (ChatGPT's practice cards): a
   * statement, a box to write in (a code editor when `language` is set),
   * hints revealed one at a time, and a send that posts the answer as the
   * user's next message. It never carries a solution.
   */
  | (Base & {
      type: "exercise";
      id: string;
      title: string;
      tag?: string;
      prompt: string;
      placeholder?: string;
      language?: string;
      hints: string[];
    })
  /**
   * The intelligent-UI set (2026-10): views for things people DO with an
   * answer, beyond reading it. A recipe that rescales for the guests and times
   * its steps, a question answered with a tap, options weighed side by side
   * and picked, a gallery of places or products, tabs, and flashcards.
   */
  | (Base & {
      type: "recipe";
      id: string;
      title?: string;
      /** The servings the quantities are written for. */
      servings: number;
      /** What one serving is called ("servings", "people", "cookies"). */
      yieldLabel: string;
      ingredients: LiveIngredient[];
      steps: { text: string; minutes?: number }[];
    })
  | (Base & {
      type: "choices";
      id: string;
      question?: string;
      options: { label: string; detail?: string; prompt: string }[];
      multi: boolean;
    })
  | (Base & { type: "compare"; title?: string; options: LiveCompareOption[]; recommend?: number })
  | (Base & { type: "cards"; title?: string; items: LiveCard[] })
  | (Base & { type: "tabs"; tabs: { label: string; children: LiveComponent[] }[]; pending: boolean })
  | (Base & { type: "flashcards"; title?: string; cards: { front: string; back: string }[] })
  /** A leaf that has not finished arriving. */
  | (Base & { type: "pending" });

export interface LiveSpec {
  title?: string;
  currency: string;
  data: Record<string, LiveValue>;
  lets: Record<string, string>;
  ui: LiveComponent[];
  /** The block has not closed: more is coming. */
  streaming: boolean;
}

export interface LiveParse {
  spec: LiveSpec | null;
  error?: string;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["true", "false", "null", "pi", "e"]);

const TYPE_ALIASES: Record<string, string> = {
  stat: "metric",
  kpi: "metric",
  switch: "toggle",
  segmented: "select",
  dropdown: "select",
  picker: "select",
  textfield: "input",
  "text-input": "input",
  field: "number",
  heading: "text",
  note: "text",
  route: "stops",
  map: "stops",
  itinerary: "stops",
  parts: "explorer",
  diagram: "explorer",
  todo: "checklist",
  practice: "exercise",
  question: "exercise",
  answer: "exercise",
  action: "button",
  stack: "section",
  group: "section",
  card: "section",
  columns: "row",
  bar: "progress",
  walkthrough: "steps",
  guide: "steps",
  lesson: "steps",
  "key-idea": "callout",
  keyidea: "callout",
  insight: "callout",
  process: "timeline",
  check: "quiz",
  ingredients: "recipe",
  cook: "recipe",
  choice: "choices",
  options: "choices",
  ask: "choices",
  "follow-up": "choices",
  followup: "choices",
  versus: "compare",
  vs: "compare",
  comparison: "compare",
  products: "cards",
  places: "cards",
  gallery: "cards",
  tab: "tabs",
  flashcard: "flashcards",
  deck: "flashcards",
};

const LAYOUTS = new Set(["row", "grid", "section"]);
const TONES = new Set(["insight", "tip", "warning", "note"]);

function str(v: LiveJSON | undefined, max: number = SPEC_LIMITS.label): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t.slice(0, max) : undefined;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function num(v: LiveJSON | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** An expression field: strings as-is, numbers and booleans as their literal. */
function expr(v: LiveJSON | undefined): string | undefined {
  if (typeof v === "string") return v.trim() ? v.trim().slice(0, 400) : undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  return undefined;
}

function fmt(v: LiveJSON | undefined): LiveFormat | undefined {
  return isLiveFormat(v) ? v : undefined;
}

function isRecord(v: LiveJSON | undefined): v is { [key: string]: LiveJSON } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Plain data, bounded: lists cut to 200, nesting cut at depth 4. */
function toValue(v: LiveJSON, depth = 0): LiveValue {
  if (v === null || typeof v !== "object") return v;
  if (depth >= 4) return null;
  if (Array.isArray(v)) return v.slice(0, SPEC_LIMITS.dataRows).map((x) => toValue(x, depth + 1));
  const out: Record<string, LiveValue> = {};
  for (const [k, x] of Object.entries(v)) out[k] = toValue(x, depth + 1);
  return out;
}

export function parseLiveUI(source: string): LiveParse {
  return normalizeLiveUI(readLiveJSON(source));
}

export function normalizeLiveUI(read: LiveJSONResult): LiveParse {
  if (read.error) return { spec: null, error: read.error };
  const root = read.value;
  if (root === undefined) {
    // Nothing usable yet: an empty, streaming spec.
    return { spec: { currency: "USD", data: {}, lets: {}, ui: [], streaming: true } };
  }
  if (!isRecord(root)) return { spec: null, error: "A Live UI block is a JSON object." };
  const open = read.open;

  const currencyRaw = str(root.currency, 3);
  const currency = currencyRaw && /^[A-Za-z]{3}$/.test(currencyRaw) ? currencyRaw.toUpperCase() : "USD";

  const data: Record<string, LiveValue> = {};
  if (isRecord(root.data)) {
    for (const [k, v] of Object.entries(root.data)) {
      if (!IDENT.test(k) || RESERVED.has(k)) continue;
      // A list still arriving is held back whole: half a receipt sums wrong.
      if (v !== null && typeof v === "object" && open.has(v)) continue;
      data[k] = toValue(v);
    }
  }

  const lets: Record<string, string> = {};
  const letSource = isRecord(root.let) ? root.let : isRecord(root.lets) ? root.lets : undefined;
  if (letSource) {
    for (const [k, v] of Object.entries(letSource)) {
      if (Object.keys(lets).length >= SPEC_LIMITS.lets) break;
      if (!IDENT.test(k) || RESERVED.has(k)) continue;
      const e = expr(v);
      if (e) lets[k] = e;
    }
  }

  const counter = { count: 0, ids: new Set<string>() };
  const uiRaw = Array.isArray(root.ui) ? root.ui : Array.isArray(root.components) ? root.components : [];
  const ui = components(uiRaw, "", 0, open, counter);
  // A ui list that is still open ends in something not yet drawn.
  if (Array.isArray(root.ui) && open.has(root.ui) && ui[ui.length - 1]?.type !== "pending") {
    ui.push({ key: `${ui.length}`, type: "pending" });
  }

  return {
    spec: {
      title: str(root.title),
      currency,
      data,
      lets,
      ui,
      streaming: open.has(root),
    },
  };
}

function components(
  list: LiveJSON[],
  prefix: string,
  depth: number,
  open: ReadonlySet<object>,
  counter: { count: number; ids: Set<string> },
): LiveComponent[] {
  const out: LiveComponent[] = [];
  list.forEach((raw, index) => {
    if (counter.count >= SPEC_LIMITS.components) return;
    const key = prefix ? `${prefix}.${index}` : `${index}`;
    if (!isRecord(raw)) return;
    const typeRaw = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : undefined;
    const type = typeRaw ? TYPE_ALIASES[typeRaw] ?? typeRaw : undefined;
    const isOpen = open.has(raw);
    if (isOpen && (!type || !(LAYOUTS.has(type) || type === "tabs"))) {
      out.push({ key, type: "pending" });
      return;
    }
    if (!type) return;
    const c = component(raw, type, typeRaw ?? type, key, depth, open, counter, isOpen);
    if (c) {
      counter.count++;
      out.push(c);
    }
  });
  return out;
}

function component(
  raw: { [key: string]: LiveJSON },
  type: string,
  typeRaw: string,
  key: string,
  depth: number,
  open: ReadonlySet<object>,
  counter: { count: number; ids: Set<string> },
  isOpen: boolean,
): LiveComponent | null {
  if (LAYOUTS.has(type)) {
    if (depth >= SPEC_LIMITS.nesting) return null;
    const kids = Array.isArray(raw.children) ? raw.children : Array.isArray(raw.items) ? raw.items : [];
    const children = components(kids, key, depth + 1, open, counter);
    const pending = isOpen || (Array.isArray(raw.children) && open.has(raw.children));
    if (!pending && children.length === 0) return null;
    if (type === "row") return { key, type, children, pending };
    if (type === "grid") {
      const columns = Math.max(2, Math.min(4, Math.trunc(num(raw.columns) ?? 2)));
      return { key, type, columns, children, pending };
    }
    return { key, type: "section", title: str(raw.title), children, pending };
  }

  // Inputs: a valid, unused identifier, or nothing.
  const inputTypes = new Set(["slider", "number", "stepper", "select", "toggle", "date", "input"]);
  if (inputTypes.has(type)) {
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!IDENT.test(id) || RESERVED.has(id) || counter.ids.has(id)) return null;
    const label = str(raw.label) ?? id;
    const c = input(raw, type, typeRaw, key, id, label);
    if (c) counter.ids.add(id);
    return c;
  }

  switch (type) {
    case "metric": {
      const value = expr(raw.value);
      if (!value) return null;
      return {
        key,
        type,
        label: str(raw.label) ?? "",
        value,
        format: fmt(raw.format),
        unit: str(raw.unit, 16),
        hint: str(raw.hint ?? raw.caption, SPEC_LIMITS.text),
        emphasis: raw.emphasis === true || raw.primary === true,
      };
    }
    case "text": {
      const text = str(raw.text ?? raw.content ?? raw.value, SPEC_LIMITS.text);
      if (!text) return null;
      const tone = typeRaw === "heading" || raw.tone === "heading" ? "heading" : raw.tone === "muted" || typeRaw === "note" ? "muted" : "body";
      return { key, type, text, tone };
    }
    case "progress": {
      const value = expr(raw.value);
      if (!value) return null;
      return { key, type, label: str(raw.label) ?? "", value, max: expr(raw.max) ?? "1", format: fmt(raw.format) };
    }
    case "chart": {
      const kindRaw = typeof raw.kind === "string" ? raw.kind : typeof raw.chart === "string" ? raw.chart : "line";
      const kind = kindRaw === "bar" || kindRaw === "column" ? "bar" : kindRaw === "area" ? "area" : "line";
      const seriesRaw: LiveJSON[] = Array.isArray(raw.series) ? raw.series : raw.y !== undefined ? [{ label: str(raw.label) ?? "", y: raw.y }] : [];
      const series: LiveChartSeries[] = [];
      for (const s of seriesRaw) {
        if (series.length >= SPEC_LIMITS.chartSeries) break;
        if (!isRecord(s)) continue;
        const y = expr(s.y ?? s.value);
        if (y) series.push({ label: str(s.label ?? s.name) ?? "", y });
      }
      if (series.length === 0) return null;
      let x: Extract<LiveComponent, { type: "chart" }>["x"];
      if (isRecord(raw.x)) {
        const from = expr(raw.x.from);
        const to = expr(raw.x.to);
        if (from && to) {
          const variable = typeof raw.x.var === "string" && IDENT.test(raw.x.var) ? raw.x.var : "x";
          x = { from, to, step: expr(raw.x.step) ?? "1", variable, label: str(raw.x.label) };
        }
      }
      const rows = expr(raw.rows);
      if (!x && !rows) return null;
      return {
        key,
        type,
        kind,
        title: str(raw.title),
        x,
        rows: x ? undefined : rows,
        xKey: x ? undefined : expr(raw.xKey ?? raw.xkey ?? raw.label_key) ?? "index",
        series,
        format: fmt(raw.format),
        xFormat: fmt(raw.xFormat),
        mark: expr(raw.mark),
      };
    }
    case "table": {
      const rows = expr(raw.rows);
      const cols = Array.isArray(raw.columns) ? raw.columns : [];
      const columns: Extract<LiveComponent, { type: "table" }>["columns"] = [];
      for (const c of cols) {
        if (columns.length >= SPEC_LIMITS.tableColumns) break;
        if (!isRecord(c)) continue;
        const value = expr(c.value ?? c.key);
        // An empty label is a deliberate blank (a comparison's aspect column).
        if (value) columns.push({ label: str(c.label) ?? (c.label === "" ? "" : value), value, format: fmt(c.format), unit: str(c.unit, 16) });
      }
      if (!rows || columns.length === 0) return null;
      const table: Extract<LiveComponent, { type: "table" }> = { key, type, rows, columns };
      if (raw.rowHeader === true) table.rowHeader = true;
      const hi = num(raw.highlight);
      if (hi !== undefined && Number.isInteger(hi) && hi >= 0 && hi < columns.length) table.highlight = hi;
      return table;
    }
    case "steps": {
      if (depth >= SPEC_LIMITS.nesting) return null;
      const list = Array.isArray(raw.steps) ? raw.steps : Array.isArray(raw.items) ? raw.items : [];
      const steps: LiveStep[] = [];
      list.forEach((s, index) => {
        if (steps.length >= SPEC_LIMITS.steps || !isRecord(s)) return;
        const title = str(s.title ?? s.label);
        if (!title) return;
        const kids = Array.isArray(s.ui) ? s.ui : Array.isArray(s.children) ? s.children : [];
        const step: LiveStep = { title, ui: components(kids, `${key}.${index}`, depth + 1, open, counter) };
        const summary = str(s.summary ?? s.text ?? s.body, SPEC_LIMITS.text);
        const detail = str(s.detail, SPEC_LIMITS.text);
        const notice = str(s.notice, 400);
        if (summary) step.summary = summary;
        if (detail) step.detail = detail;
        if (notice) step.notice = notice;
        steps.push(step);
      });
      if (steps.length === 0) return null;
      const out: Extract<LiveComponent, { type: "steps" }> = { key, type, steps };
      const title = str(raw.title);
      const takeaway = str(raw.takeaway, 400);
      if (title) out.title = title;
      if (takeaway) out.takeaway = takeaway;
      return out;
    }
    case "quiz": {
      const list = Array.isArray(raw.questions) ? raw.questions : raw.question !== undefined ? [raw] : [];
      const questions: LiveQuizQuestion[] = [];
      for (const q of list) {
        if (questions.length >= SPEC_LIMITS.questions) break;
        if (!isRecord(q)) continue;
        const question = str(q.question ?? q.q, 500);
        const opts = Array.isArray(q.options) ? q.options : [];
        const options: LiveQuizQuestion["options"] = [];
        let flagged = -1;
        for (const o of opts) {
          if (options.length >= SPEC_LIMITS.quizOptions) break;
          if (typeof o === "string" || typeof o === "number") {
            const label = str(o, 300);
            if (label) options.push({ label });
          } else if (isRecord(o)) {
            const label = str(o.label ?? o.text, 300);
            if (!label) continue;
            const option: { label: string; explanation?: string } = { label };
            const why = str(o.explanation ?? o.why, 600);
            if (why) option.explanation = why;
            if (o.correct === true && flagged < 0) flagged = options.length;
            options.push(option);
          }
        }
        let answer = -1;
        const a = q.answer;
        if (typeof a === "number" && Number.isInteger(a) && a >= 0 && a < options.length) answer = a;
        else if (typeof a === "string" && a.trim()) {
          const want = a.trim().toLowerCase();
          answer = options.findIndex((o) => o.label.toLowerCase() === want);
        }
        if (answer < 0) answer = flagged;
        if (!question || options.length < 2 || answer < 0) continue;
        const item: LiveQuizQuestion = { question, options, answer };
        const explanation = str(q.explanation, 800);
        const hint = str(q.hint, 400);
        if (explanation) item.explanation = explanation;
        if (hint) item.hint = hint;
        questions.push(item);
      }
      if (questions.length === 0) return null;
      const out: Extract<LiveComponent, { type: "quiz" }> = { key, type, questions };
      const title = list === raw.questions ? str(raw.title) : undefined;
      if (title) out.title = title;
      return out;
    }
    case "callout": {
      const text = str(raw.text ?? raw.content ?? raw.body, SPEC_LIMITS.text);
      if (!text) return null;
      const toneRaw = typeof raw.tone === "string" ? raw.tone.trim().toLowerCase() : "";
      const tone = (TONES.has(toneRaw) ? toneRaw : TONES.has(typeRaw) ? typeRaw : "insight") as LiveCalloutTone;
      const out: Extract<LiveComponent, { type: "callout" }> = { key, type, tone, text };
      const title = str(raw.title);
      const more = str(raw.more ?? raw.detail, SPEC_LIMITS.text);
      if (title) out.title = title;
      if (more) out.more = more;
      return out;
    }
    case "timeline": {
      const list = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.steps) ? raw.steps : [];
      const items: Extract<LiveComponent, { type: "timeline" }>["items"] = [];
      for (const it of list) {
        if (items.length >= SPEC_LIMITS.timeline) break;
        if (typeof it === "string" && it.trim()) {
          items.push({ label: it.trim().slice(0, 200) });
          continue;
        }
        if (!isRecord(it)) continue;
        const label = str(it.label ?? it.title ?? it.name, 200);
        if (!label) continue;
        const item: { label: string; detail?: string; time?: string } = { label };
        const detail = str(it.detail ?? it.description ?? it.text, 600);
        const time = str(it.time ?? it.when ?? it.date, 40);
        if (detail) item.detail = detail;
        if (time) item.time = time;
        items.push(item);
      }
      if (items.length === 0) return null;
      const out: Extract<LiveComponent, { type: "timeline" }> = { key, type, items };
      const title = str(raw.title);
      if (title) out.title = title;
      return out;
    }
    case "explorer": {
      const partsRaw = Array.isArray(raw.parts) ? raw.parts : [];
      const parts: LiveExplorerPart[] = [];
      const seen = new Set<string>();
      for (const p of partsRaw) {
        if (parts.length >= SPEC_LIMITS.parts) break;
        if (!isRecord(p)) continue;
        const label = str(p.label ?? p.name);
        if (!label) continue;
        let id = str(p.id) ?? label;
        if (seen.has(id)) id = `${id}-${parts.length}`;
        seen.add(id);
        const facts: { label: string; value: string }[] = [];
        if (Array.isArray(p.facts)) {
          for (const f of p.facts) {
            if (facts.length >= SPEC_LIMITS.facts) break;
            if (isRecord(f)) {
              const fl = str(f.label);
              const fv = str(f.value);
              if (fl && fv) facts.push({ label: fl, value: fv });
            }
          }
        }
        const at =
          Array.isArray(p.at) && p.at.length === 2 && num(p.at[0]) !== undefined && num(p.at[1]) !== undefined
            ? ([clamp(num(p.at[0])!, 0, 100), clamp(num(p.at[1])!, 0, 100)] as [number, number])
            : undefined;
        parts.push({
          id,
          label,
          summary: str(p.summary, 300),
          detail: str(p.detail ?? p.description, SPEC_LIMITS.text) ?? str(p.summary, 300) ?? "",
          facts,
          at,
        });
      }
      if (parts.length === 0) return null;
      const links: [string, string][] = [];
      if (Array.isArray(raw.links)) {
        for (const l of raw.links) {
          if (links.length >= SPEC_LIMITS.links) break;
          if (Array.isArray(l) && l.length === 2 && typeof l[0] === "string" && typeof l[1] === "string" && seen.has(l[0]) && seen.has(l[1])) {
            links.push([l[0], l[1]]);
          }
        }
      }
      // Hotspots only when every part has a position; a half-placed schematic is a list.
      const placed = parts.every((p) => p.at);
      if (!placed) for (const p of parts) delete p.at;
      return { key, type, title: str(raw.title), parts, links: placed ? links : [] };
    }
    case "stops": {
      const list = Array.isArray(raw.stops) ? raw.stops : Array.isArray(raw.items) ? raw.items : [];
      const stops: Extract<LiveComponent, { type: "stops" }>["stops"] = [];
      for (const s of list) {
        if (stops.length >= SPEC_LIMITS.stops) break;
        if (typeof s === "string" && s.trim()) {
          stops.push({ name: s.trim().slice(0, SPEC_LIMITS.label), query: s.trim().slice(0, 200) });
          continue;
        }
        if (!isRecord(s)) continue;
        const name = str(s.name ?? s.label);
        if (!name) continue;
        stops.push({ name, time: str(s.time ?? s.when, 40), note: str(s.note ?? s.detail, 400), query: str(s.query ?? s.address, 200) ?? name });
      }
      if (stops.length === 0) return null;
      return { key, type, title: str(raw.title), stops };
    }
    case "checklist": {
      const list = Array.isArray(raw.items) ? raw.items : [];
      const items: { label: string; note?: string }[] = [];
      for (const it of list) {
        if (items.length >= SPEC_LIMITS.checklist) break;
        if (typeof it === "string" && it.trim()) items.push({ label: it.trim().slice(0, 200) });
        else if (isRecord(it)) {
          const label = str(it.label ?? it.text, 200);
          if (label) items.push({ label, note: str(it.note, 300) });
        }
      }
      if (items.length === 0) return null;
      const idRaw = typeof raw.id === "string" ? raw.id.trim() : "";
      const id = IDENT.test(idRaw) ? idRaw : `checklist_${key.replace(/\./g, "_")}`;
      return { key, type, id, title: str(raw.title), items };
    }
    case "exercise": {
      const title = str(raw.title ?? raw.label, 200);
      const prompt = str(raw.prompt ?? raw.question ?? raw.text, SPEC_LIMITS.text);
      if (!title || !prompt) return null;
      const list = Array.isArray(raw.hints) ? raw.hints : raw.hint !== undefined ? [raw.hint] : [];
      const hints: string[] = [];
      for (const h of list) {
        if (hints.length >= SPEC_LIMITS.hints) break;
        const hint = str(h, 600);
        if (hint) hints.push(hint);
      }
      const languageRaw = str(raw.language ?? raw.lang, 20)?.toLowerCase();
      const language = languageRaw && /^[a-z0-9+#-]+$/.test(languageRaw) ? languageRaw : undefined;
      const idRaw = typeof raw.id === "string" ? raw.id.trim() : "";
      const id = IDENT.test(idRaw) ? idRaw : `exercise_${key.replace(/\./g, "_")}`;
      return { key, type, id, title, tag: str(raw.tag ?? raw.kind, 40), prompt, placeholder: str(raw.placeholder, 200), language, hints };
    }
    case "recipe": {
      const servings = Math.max(1, Math.min(100, Math.round(num(raw.servings ?? raw.serves ?? raw.yield) ?? 4)));
      const ingredients: LiveIngredient[] = [];
      for (const it of Array.isArray(raw.ingredients) ? raw.ingredients : []) {
        if (ingredients.length >= SPEC_LIMITS.ingredients) break;
        if (typeof it === "string" && it.trim()) ingredients.push({ name: it.trim().slice(0, 200) });
        else if (isRecord(it)) {
          const name = str(it.name ?? it.label ?? it.item, 200);
          if (!name) continue;
          const qty = num(it.qty ?? it.quantity ?? it.amount);
          ingredients.push({ name, qty: qty !== undefined && qty > 0 ? qty : undefined, unit: str(it.unit, 20), note: str(it.note, 200) });
        }
      }
      const steps: { text: string; minutes?: number }[] = [];
      for (const st of Array.isArray(raw.steps) ? raw.steps : Array.isArray(raw.method) ? raw.method : []) {
        if (steps.length >= SPEC_LIMITS.recipeSteps) break;
        if (typeof st === "string" && st.trim()) steps.push({ text: st.trim().slice(0, 600) });
        else if (isRecord(st)) {
          const text = str(st.text ?? st.step ?? st.title, 600);
          if (!text) continue;
          const minutes = num(st.minutes ?? st.timer ?? st.time);
          steps.push({ text, minutes: minutes !== undefined && minutes > 0 ? Math.min(minutes, 24 * 60) : undefined });
        }
      }
      if (ingredients.length === 0 && steps.length === 0) return null;
      const idRaw = typeof raw.id === "string" ? raw.id.trim() : "";
      const id = IDENT.test(idRaw) ? idRaw : `recipe_${key.replace(/\./g, "_")}`;
      return { key, type, id, title: str(raw.title), servings, yieldLabel: str(raw.yieldLabel ?? raw.unit, 30) ?? "servings", ingredients, steps };
    }
    case "choices": {
      const list = Array.isArray(raw.options) ? raw.options : Array.isArray(raw.choices) ? raw.choices : [];
      const options: { label: string; detail?: string; prompt: string }[] = [];
      for (const o of list) {
        if (options.length >= SPEC_LIMITS.choices) break;
        if (typeof o === "string" && o.trim()) options.push({ label: o.trim().slice(0, SPEC_LIMITS.label), prompt: o.trim().slice(0, 600) });
        else if (isRecord(o)) {
          const label = str(o.label ?? o.text);
          if (!label) continue;
          options.push({ label, detail: str(o.detail ?? o.description, 200), prompt: str(o.prompt ?? o.send, 600) ?? label });
        }
      }
      if (options.length < 2) return null;
      const idRaw = typeof raw.id === "string" ? raw.id.trim() : "";
      const id = IDENT.test(idRaw) ? idRaw : `choices_${key.replace(/\./g, "_")}`;
      return { key, type, id, question: str(raw.question ?? raw.title ?? raw.label, 300), options, multi: raw.multi === true || raw.multiple === true };
    }
    case "compare": {
      const strings = (v: LiveJSON | undefined, max: number) => {
        const out: string[] = [];
        for (const x of Array.isArray(v) ? v : []) {
          if (out.length >= max) break;
          const t = str(x, 200);
          if (t) out.push(t);
        }
        return out;
      };
      const options: LiveCompareOption[] = [];
      for (const o of Array.isArray(raw.options) ? raw.options : Array.isArray(raw.items) ? raw.items : []) {
        if (options.length >= SPEC_LIMITS.compare) break;
        if (!isRecord(o)) continue;
        const name = str(o.name ?? o.label ?? o.title);
        if (!name) continue;
        const facts: { label: string; value: string }[] = [];
        if (Array.isArray(o.facts)) {
          for (const f of o.facts) {
            if (facts.length >= SPEC_LIMITS.facts || !isRecord(f)) continue;
            const label = str(f.label);
            const value = str(f.value, 200);
            if (label && value) facts.push({ label, value });
          }
        }
        options.push({
          name,
          tagline: str(o.tagline ?? o.summary ?? o.description, 200),
          price: str(o.price, 40),
          badge: str(o.badge, 30),
          pros: strings(o.pros, SPEC_LIMITS.pros),
          cons: strings(o.cons, SPEC_LIMITS.pros),
          facts,
          prompt: str(o.prompt ?? o.send, 600),
        });
      }
      if (options.length < 2) return null;
      const rec = num(raw.recommend ?? raw.best);
      return { key, type, title: str(raw.title), options, recommend: rec !== undefined && rec >= 0 && rec < options.length ? Math.trunc(rec) : undefined };
    }
    case "cards": {
      const items: LiveCard[] = [];
      for (const it of Array.isArray(raw.items) ? raw.items : Array.isArray(raw.cards) ? raw.cards : []) {
        if (items.length >= SPEC_LIMITS.cards || !isRecord(it)) continue;
        const title = str(it.title ?? it.name ?? it.label);
        if (!title) continue;
        const tags: string[] = [];
        for (const t of Array.isArray(it.tags) ? it.tags : []) {
          if (tags.length >= SPEC_LIMITS.tags) break;
          const tag = str(t, 30);
          if (tag) tags.push(tag);
        }
        const rating = num(it.rating);
        items.push({
          title,
          subtitle: str(it.subtitle, 200),
          meta: str(it.meta ?? it.price, 60),
          detail: str(it.detail ?? it.description, 400),
          tags,
          rating: rating !== undefined ? clamp(rating, 0, 5) : undefined,
          prompt: str(it.prompt ?? it.send, 600),
        });
      }
      if (items.length === 0) return null;
      return { key, type, title: str(raw.title), items };
    }
    case "tabs": {
      if (depth >= SPEC_LIMITS.nesting) return null;
      const list = Array.isArray(raw.tabs) ? raw.tabs : Array.isArray(raw.items) ? raw.items : [];
      const tabs: { label: string; children: LiveComponent[] }[] = [];
      list.forEach((t, i) => {
        if (tabs.length >= SPEC_LIMITS.tabs || !isRecord(t)) return;
        const label = str(t.label ?? t.title);
        if (!label) return;
        const kids = Array.isArray(t.children) ? t.children : Array.isArray(t.ui) ? t.ui : [];
        tabs.push({ label, children: components(kids, `${key}.${i}`, depth + 1, open, counter) });
      });
      if (tabs.length === 0) return null;
      return { key, type, tabs, pending: isOpen };
    }
    case "flashcards": {
      const cards: { front: string; back: string }[] = [];
      for (const c of Array.isArray(raw.cards) ? raw.cards : Array.isArray(raw.items) ? raw.items : []) {
        if (cards.length >= SPEC_LIMITS.flashcards || !isRecord(c)) continue;
        const front = str(c.front ?? c.term ?? c.question, 300);
        const back = str(c.back ?? c.definition ?? c.answer, 600);
        if (front && back) cards.push({ front, back });
      }
      if (cards.length === 0) return null;
      return { key, type, title: str(raw.title), cards };
    }
    case "button": {
      const label = str(raw.label);
      const prompt = str(raw.prompt ?? raw.send, SPEC_LIMITS.text);
      const copy = expr(raw.copy);
      if (!label || (!prompt && !copy)) return null;
      return { key, type, label, prompt, copy: prompt ? undefined : copy };
    }
    default:
      return null;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/** Snap `value` onto [min, max] and the step grid from min. */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  const clamped = clamp(value, min, max);
  if (!(step > 0)) return clamped;
  const steps = Math.round((clamped - min) / step);
  const snapped = min + steps * step;
  // Kill float dust (0.1 + 0.2) at the step's own precision.
  const decimals = Math.min(10, Math.max(0, -Math.floor(Math.log10(step)) + 2));
  return clamp(Number(snapped.toFixed(decimals)), min, max);
}

function input(
  raw: { [key: string]: LiveJSON },
  type: string,
  typeRaw: string,
  key: string,
  id: string,
  label: string,
): LiveInput | null {
  switch (type) {
    case "slider": {
      const min = num(raw.min) ?? 0;
      const max = num(raw.max) ?? 100;
      if (!(max > min)) return null;
      const stepRaw = num(raw.step);
      const step = stepRaw && stepRaw > 0 ? Math.min(stepRaw, max - min) : (max - min) / 100;
      const value = snapToStep(num(raw.value) ?? min, min, max, step);
      return { key, type, id, label, min, max, step, value, format: fmt(raw.format), unit: str(raw.unit, 16) };
    }
    case "number": {
      const min = num(raw.min);
      const max = num(raw.max);
      const stepRaw = num(raw.step);
      let value = num(raw.value) ?? min ?? 0;
      if (min !== undefined) value = Math.max(min, value);
      if (max !== undefined) value = Math.min(max, value);
      return { key, type, id, label, min, max, step: stepRaw && stepRaw > 0 ? stepRaw : undefined, value, format: fmt(raw.format), unit: str(raw.unit, 16) };
    }
    case "stepper": {
      const min = num(raw.min) ?? 0;
      const max = num(raw.max) ?? 100;
      if (!(max > min)) return null;
      const stepRaw = num(raw.step);
      const step = stepRaw && stepRaw > 0 ? stepRaw : 1;
      return { key, type, id, label, min, max, step, value: snapToStep(num(raw.value) ?? min, min, max, step), unit: str(raw.unit, 16) };
    }
    case "select": {
      const list = Array.isArray(raw.options) ? raw.options : [];
      const options: LiveSelectOption[] = [];
      for (const o of list) {
        if (options.length >= SPEC_LIMITS.options) break;
        if (typeof o === "string" && o.trim()) options.push({ label: o.trim().slice(0, 60), value: o.trim().slice(0, 60) });
        else if (typeof o === "number" && Number.isFinite(o)) options.push({ label: String(o), value: o });
        else if (isRecord(o)) {
          const v = typeof o.value === "number" && Number.isFinite(o.value) ? o.value : str(o.value, 60) ?? str(o.label, 60);
          const l = str(o.label, 60) ?? (v !== undefined ? String(v) : undefined);
          if (v !== undefined && l) options.push({ label: l, value: v });
        }
      }
      if (options.length === 0) return null;
      const wanted = raw.value;
      const match = options.find((o) => o.value === wanted) ?? options.find((o) => String(o.value) === String(wanted));
      const value = match ? match.value : options[0].value;
      const styleRaw = raw.style === "menu" || raw.style === "segmented" ? raw.style : typeRaw === "segmented" ? "segmented" : undefined;
      const short = options.length <= 4 && options.every((o) => o.label.length <= 14);
      return { key, type, id, label, options, value, style: styleRaw ?? (short ? "segmented" : "menu") };
    }
    case "toggle":
      return { key, type, id, label, value: raw.value === true };
    case "date": {
      const v = typeof raw.value === "string" && parseISODate(raw.value) ? raw.value : todayISO();
      return { key, type, id, label, value: v };
    }
    case "input":
      return { key, type, id, label, value: str(raw.value, 200) ?? "", placeholder: str(raw.placeholder, 80) };
    default:
      return null;
  }
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Every input in the tree, depth-first. */
export function liveInputs(ui: readonly LiveComponent[]): LiveInput[] {
  const out: LiveInput[] = [];
  const walk = (list: readonly LiveComponent[]) => {
    for (const c of list) {
      if (c.type === "row" || c.type === "grid" || c.type === "section") walk(c.children);
      else if (c.type === "steps") for (const s of c.steps) walk(s.ui);
      else if (c.type === "tabs") for (const t of c.tabs) walk(t.children);
      else if (["slider", "number", "stepper", "select", "toggle", "date", "input"].includes(c.type)) out.push(c as LiveInput);
    }
  };
  walk(ui);
  return out;
}

/** The authored default of every input, by id. */
export function liveDefaults(spec: LiveSpec): Record<string, LiveValue> {
  const out: Record<string, LiveValue> = {};
  for (const i of liveInputs(spec.ui)) out[i.id] = i.value;
  return out;
}

/** FNV-1a 32-bit over UTF-16 code units, hex. Swift hashes `utf16` the same way. */
export function liveHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function liveStorageKey(messageId: string | undefined, source: string): string {
  return `live-ui:v1:${messageId ?? "-"}:${liveHash(source.trim())}`;
}
