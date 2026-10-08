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

export const LIVE_UI_FENCES = ["live-ui", "live", "juno-live"] as const;

export function isLiveUIFence(lang: string | null | undefined): boolean {
  return !!lang && (LIVE_UI_FENCES as readonly string[]).includes(lang.trim().toLowerCase());
}

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
  options: 12,
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
    })
  | (Base & { type: "table"; rows: string; columns: { label: string; value: string; format?: LiveFormat; unit?: string }[] })
  | (Base & { type: "explorer"; title?: string; parts: LiveExplorerPart[]; links: [string, string][] })
  | (Base & { type: "stops"; title?: string; stops: { name: string; time?: string; note?: string; query: string }[] })
  | (Base & { type: "checklist"; id: string; title?: string; items: { label: string; note?: string }[] })
  | (Base & { type: "button"; label: string; prompt?: string; copy?: string })
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
  action: "button",
  stack: "section",
  group: "section",
  card: "section",
  columns: "row",
  bar: "progress",
};

const LAYOUTS = new Set(["row", "grid", "section"]);

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
    if (isOpen && (!type || !LAYOUTS.has(type))) {
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
      const seriesRaw = Array.isArray(raw.series) ? raw.series : raw.y !== undefined ? [{ label: str(raw.label) ?? "", y: raw.y }] : [];
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
        if (value) columns.push({ label: str(c.label) ?? value, value, format: fmt(c.format), unit: str(c.unit, 16) });
      }
      if (!rows || columns.length === 0) return null;
      return { key, type, rows, columns };
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
