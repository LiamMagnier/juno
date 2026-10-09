/**
 * LEGACY → Live UI. Replies written before Live UI became the one interactive
 * answer system carry the old `:::kind` learning blocks (step-lab,
 * learning-card, process-timeline, comparison, quiz, deep-dive) and the older
 * ```juno-visual JSON fences. Nothing teaches a model to write them any more;
 * this turns the ones already saved into Live UI specs, so history renders
 * through the same renderer as a new answer instead of as raw YAML, and the
 * old components could be deleted. docs/design/LIVE_UI.md §12.
 *
 * The Swift twin is `JunoLiveUILegacy.swift`; contracts/live-ui/fixtures/
 * legacy.json pins that both produce the same spec from the same reply.
 *
 * Rules: never invent data. A Step Lab visual whose payload is missing draws
 * nothing (the old renderer filled in sample numbers); a block that cannot be
 * read becomes a one-line note rather than its source.
 */

import {
  findLearningBlocks,
  salvageLearningBlock,
  type LearningBlockPayload,
  type ParsedLearningBlock,
} from "@/lib/live-ui/legacy/learning-blocks";
import type { StepLab, StepLabStep } from "@/lib/live-ui/legacy/step-lab";

type J = string | number | boolean | null | J[] | { [key: string]: J };
type Obj = { [key: string]: J };

export const LEGACY_UNREADABLE_TEXT = "This part of an earlier answer could not be shown.";

const UNREADABLE: Obj = { ui: [{ type: "callout", tone: "note", text: LEGACY_UNREADABLE_TEXT }] };

// ── Small readers over the old payloads ─────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Trimmed text; numbers in their JavaScript form; empty → undefined. */
function text(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  return undefined;
}

function number(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Builds an object leaving out undefined values, in the order given. */
function obj(entries: [string, J | undefined][]): Obj {
  const out: Obj = {};
  for (const [k, v] of entries) if (v !== undefined) out[k] = v;
  return out;
}

function spec(title: string | undefined, data: Obj | undefined, ui: J[]): Obj {
  return obj([
    ["title", title],
    ["data", data && Object.keys(data).length ? data : undefined],
    ["ui", ui],
  ]);
}

// ── Step Lab visuals ────────────────────────────────────────────────────────

/** The visual area of one old step, as Live UI components. Its data goes in `data` under `s<n>_…`. */
function stepVisual(step: StepLabStep, n: number, data: Obj): J[] {
  const d = isRecord(step.data) ? step.data : {};
  const name = (k: string) => `s${n}_${k}`;
  switch (step.visualType) {
    case "tokenization": {
      const rows: Obj[] = [];
      for (const item of list(d.tokens)) {
        if (rows.length >= 12) break;
        if (typeof item === "string" || typeof item === "number") {
          const t = text(item);
          if (t) rows.push({ token: t });
        } else if (isRecord(item)) {
          const t = text(item.text ?? item.token);
          // Shown as written: a vocabulary id is a label, not a quantity to group.
          if (t) rows.push(obj([["token", t], ["id", text(item.id)]]));
        }
      }
      if (!rows.length) return [];
      data[name("tokens")] = rows;
      const out: J[] = [];
      const input = text(d.input);
      if (input) out.push({ type: "text", tone: "muted", text: `Input: “${input}”` });
      const columns: J[] = [{ label: "Token", value: "token" }];
      if (rows.some((r) => r.id !== undefined)) columns.push({ label: "ID", value: "id" });
      out.push({ type: "table", rows: name("tokens"), columns });
      return out;
    }
    case "embedding": {
      const rows: Obj[] = [];
      for (const item of list(d.examples)) {
        if (rows.length >= 8 || !isRecord(item)) continue;
        const t = text(item.token ?? item.text);
        const vector = list(item.vector)
          .map(number)
          .filter((x): x is number => x !== undefined)
          .slice(0, 6);
        if (t && vector.length) rows.push({ token: t, vector: vector.map(String).join(", ") });
      }
      if (!rows.length) return [];
      data[name("vectors")] = rows;
      return [{ type: "table", rows: name("vectors"), columns: [{ label: "Token", value: "token" }, { label: "Vector", value: "vector" }] }];
    }
    case "attention": {
      const tokens = list(d.tokens)
        .map(text)
        .filter((x): x is string => !!x)
        .slice(0, 7);
      const matrix = list(d.matrix)
        .map((row) =>
          list(row)
            .map(number)
            .filter((x): x is number => x !== undefined)
            .slice(0, tokens.length),
        )
        .filter((row) => row.length)
        .slice(0, tokens.length);
      if (tokens.length < 2 || matrix.length !== tokens.length) return [];
      data[name("attention")] = tokens.map((t, r) => {
        const row: Obj = { token: t };
        matrix[r].forEach((w, c) => (row[`w${c}`] = w));
        return row;
      });
      return [
        {
          type: "table",
          rows: name("attention"),
          rowHeader: true,
          columns: [{ label: "", value: "token" }, ...tokens.map((t, c) => ({ label: t, value: `w${c}`, format: "number" }))],
        },
      ];
    }
    case "transformer-processing": {
      const out: J[] = [];
      const layers = number(d.layers);
      if (layers !== undefined) out.push({ type: "metric", label: "Layers", value: String(layers) });
      const tokens = list(d.tokens)
        .map(text)
        .filter((x): x is string => !!x)
        .slice(0, 5);
      if (tokens.length) out.push({ type: "text", tone: "muted", text: `Tokens: ${tokens.join(", ")}` });
      return out;
    }
    case "probability-distribution": {
      const rows: Obj[] = [];
      for (const item of list(d.candidates)) {
        if (rows.length >= 6 || !isRecord(item)) continue;
        const t = text(item.token ?? item.text);
        const p = number(item.probability ?? item.p);
        if (t && p !== undefined) rows.push({ token: t, p: p > 1 ? p / 100 : p });
      }
      if (!rows.length) return [];
      data[name("candidates")] = rows;
      return [{ type: "chart", kind: "bar", rows: name("candidates"), xKey: "token", series: [{ label: "Probability", y: "p" }], format: "percent" }];
    }
    case "next-token-selection": {
      const token = text(d.selectedToken ?? d.token ?? d.output);
      if (!token) return [];
      const prompt = text(d.prompt);
      return [{ type: "text", text: prompt ? `${prompt} **${token}**` : `**${token}**` }];
    }
    default: {
      const items: J[] = [];
      const input = text(d.input);
      const transform = text(d.transform ?? d.process);
      const output = text(d.output);
      if (input) items.push({ label: "Input", detail: input });
      if (transform) items.push({ label: "Transform", detail: transform });
      if (output) items.push({ label: "Output", detail: output });
      return items.length ? [{ type: "timeline", items }] : [];
    }
  }
}

function quizComponent(
  title: string | undefined,
  questions: { question: string; options: { label: string; correct?: boolean; explanation?: string }[]; explanation?: string; hint?: string }[],
): J | null {
  const out: J[] = [];
  for (const q of questions) {
    const answer = q.options.findIndex((o) => o.correct === true);
    if (answer < 0 || q.options.length < 2) continue;
    out.push(
      obj([
        ["question", q.question],
        ["options", q.options.map((o) => obj([["label", o.label], ["explanation", o.explanation]]))],
        ["answer", answer],
        ["explanation", q.explanation],
        ["hint", q.hint],
      ]),
    );
  }
  if (!out.length) return null;
  return obj([["type", "quiz"], ["title", title], ["questions", out]]);
}

function stepLabSpec(lab: StepLab): Obj {
  const data: Obj = {};
  const steps: J[] = lab.steps.map((step, i) => {
    const ui = stepVisual(step, i + 1, data);
    return obj([
      ["title", step.title],
      ["summary", step.summary],
      ["detail", step.detail],
      ["notice", step.notice],
      ["ui", ui.length ? ui : undefined],
    ]);
  });
  const quiz = lab.quiz ? quizComponent(undefined, lab.quiz.questions) : null;
  if (quiz) {
    const last = steps[steps.length - 1] as Obj;
    last.ui = [...((last.ui as J[] | undefined) ?? []), quiz];
  }
  const ui: J[] = [];
  if (lab.description) ui.push({ type: "text", tone: "muted", text: lab.description });
  ui.push(obj([["type", "steps"], ["steps", steps], ["takeaway", lab.takeaway]]));
  return spec(lab.title, data, ui);
}

// ── Blocks ──────────────────────────────────────────────────────────────────

/** One old learning block's payload as a Live UI spec. */
export function legacyPayloadSpec(payload: LearningBlockPayload): Obj {
  switch (payload.kind) {
    case "step-lab":
      return stepLabSpec(payload.lab);
    case "learning-card": {
      const c = payload.card;
      return spec(undefined, undefined, [obj([["type", "callout"], ["tone", c.tone], ["title", c.title], ["text", c.content]])]);
    }
    case "process-timeline": {
      const t = payload.timeline;
      return spec(t.title, undefined, [{ type: "timeline", items: t.steps.map((s) => obj([["label", s.label], ["detail", s.description]])) }]);
    }
    case "comparison": {
      const c = payload.comparison;
      const rows = c.rows.map((row) => {
        const r: Obj = { c0: row.label };
        c.columns.forEach((_, j) => (r[`c${j + 1}`] = row.values[j] ?? ""));
        return r;
      });
      const ui: J[] = [
        {
          type: "table",
          rows: "rows",
          rowHeader: true,
          columns: [{ label: "", value: "c0" }, ...c.columns.map((label, j) => ({ label, value: `c${j + 1}` }))],
        },
      ];
      if (c.verdict) ui.push({ type: "callout", tone: "insight", text: c.verdict });
      return spec(c.title, { rows }, ui);
    }
    case "quiz": {
      const quiz = quizComponent(undefined, payload.quiz.questions);
      return quiz ? spec(payload.quiz.title, undefined, [quiz]) : UNREADABLE;
    }
    case "deep-dive": {
      const d = payload.deepDive;
      return spec(undefined, undefined, [obj([["type", "callout"], ["tone", "note"], ["title", d.title], ["text", d.summary], ["more", d.content]])]);
    }
  }
}

/** A found block (closed or cut off) as a Live UI spec. */
export function legacyBlockSpec(block: ParsedLearningBlock): Obj {
  const b = block.streaming ? salvageLearningBlock(block) : block;
  if (!b.payload) return UNREADABLE;
  // A Step Lab the parser could not read comes back as its own placeholder lab.
  if (b.payload.kind === "step-lab" && b.payload.lab.steps.length === 1 && b.payload.lab.steps[0].id === "fallback") return UNREADABLE;
  return legacyPayloadSpec(b.payload);
}

/** A spec as the body of a ```live-ui fence: one line, no backticks to close the fence early. */
export function liveSource(specObj: Obj): string {
  return JSON.stringify(specObj).replace(/`/g, "\\u0060");
}

/**
 * Replace every old `:::kind` block in a reply with a ```live-ui fence. Text
 * with no old blocks comes back unchanged (the same string).
 */
export function rewriteLegacyBlocks(text: string): string {
  if (!text.includes(":::")) return text;
  const blocks = findLearningBlocks(text);
  if (!blocks.length) return text;
  let out = "";
  let cursor = 0;
  for (const block of blocks) {
    out += text.slice(cursor, block.start);
    out += `\n\n\`\`\`live-ui\n${liveSource(legacyBlockSpec(block))}\n\`\`\`\n\n`;
    cursor = block.end;
  }
  return out + text.slice(cursor);
}

// ── juno-visual fences ──────────────────────────────────────────────────────

export const LEGACY_VISUAL_FENCES = ["juno-visual", "juno-ui", "juno-block", "visual", "visual-block"] as const;

export function isLegacyVisualFence(lang: string | null | undefined): boolean {
  return !!lang && (LEGACY_VISUAL_FENCES as readonly string[]).includes(lang.trim().toLowerCase());
}

interface VisualItem {
  title?: string;
  label?: string;
  primary: string;
}

function visualItem(v: unknown): VisualItem | null {
  if (typeof v === "string") return { primary: v.trim() };
  if (!isRecord(v)) return null;
  return {
    title: text(v.title ?? v.name),
    label: text(v.label ?? v.step ?? v.id ?? v.date),
    primary: text(v.body ?? v.description ?? v.content) ?? text(v.text) ?? text(v.detail ?? v.details) ?? text(v.value) ?? "",
  };
}

function visualItems(raw: Record<string, unknown>): VisualItem[] {
  for (const k of ["items", "steps", "cards", "nodes"]) {
    const items = list(raw[k])
      .map(visualItem)
      .filter((x): x is VisualItem => !!x);
    if (items.length) return items;
  }
  return [];
}

const itemTitle = (item: VisualItem, fallback: string) => item.title ?? item.label ?? fallback;

/** A ```juno-visual fence body as a Live UI spec; null when it is not a visual at all. */
export function legacyVisualSpec(source: string): Obj | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const type = (text(raw.type ?? raw.kind) ?? "cards").toLowerCase();
  const title = text(raw.title);
  const subtitle = text(raw.subtitle ?? raw.description);
  const body = text(raw.body ?? raw.text);
  const items = visualItems(raw);
  const intro: J[] = subtitle ? [{ type: "text", tone: "muted", text: subtitle }] : [];

  switch (type) {
    case "cards": {
      if (!items.length) return UNREADABLE;
      const parts = items.slice(0, 24).map((item, i) => obj([["id", `p${i + 1}`], ["label", itemTitle(item, `Card ${i + 1}`)], ["detail", item.primary || itemTitle(item, `Card ${i + 1}`)]]));
      return spec(title, undefined, [...intro, { type: "explorer", parts }]);
    }
    case "steps": {
      if (!items.length) return UNREADABLE;
      const steps = items.slice(0, 12).map((item, i) => obj([["title", itemTitle(item, `Step ${i + 1}`)], ["summary", item.primary || undefined]]));
      const lead = subtitle ?? body;
      return spec(title, undefined, [...(lead ? [{ type: "text", tone: "muted", text: lead }] : []), { type: "steps", steps }]);
    }
    case "flow":
    case "flowchart":
    case "diagram":
    case "timeline": {
      if (!items.length) return UNREADABLE;
      const moment = type === "timeline" ? "Moment" : "Step";
      const timeline = items.slice(0, 20).map((item, i) =>
        obj([
          ["label", itemTitle(item, `${moment} ${i + 1}`)],
          ["detail", item.primary || undefined],
          ["time", type === "timeline" && item.title ? item.label : undefined],
        ]),
      );
      return spec(title, undefined, [...intro, { type: "timeline", items: timeline }]);
    }
    case "comparison":
    case "table": {
      const columnsRaw = list(raw.columns)
        .map(text)
        .filter((x): x is string => !!x);
      const columns = (columnsRaw.length ? columnsRaw : ["Option A", "Option B"]).slice(0, 7);
      const rowsRaw = list(raw.rows).filter((r) => typeof r === "string" || isRecord(r));
      const rows: Obj[] = [];
      if (rowsRaw.length) {
        rowsRaw.slice(0, 100).forEach((r, i) => {
          const item = visualItem(r)!;
          const values = isRecord(r) ? (r.values ?? r.cells) : undefined;
          const row: Obj = { c0: itemTitle(item, `Row ${i + 1}`) };
          columns.forEach((col, j) => {
            let v: string | undefined;
            if (Array.isArray(values)) v = text(values[j]);
            else if (isRecord(values)) v = text(values[col] ?? values[col.toLowerCase()] ?? values[String(j)]);
            else v = j === 0 ? item.primary : undefined;
            row[`c${j + 1}`] = v ?? "";
          });
          rows.push(row);
        });
      } else {
        items.forEach((item, i) => {
          const row: Obj = { c0: itemTitle(item, `Row ${i + 1}`) };
          columns.forEach((_, j) => (row[`c${j + 1}`] = j === 0 ? item.primary : ""));
          rows.push(row);
        });
      }
      if (!rows.length) return UNREADABLE;
      return spec(title, { rows }, [
        ...intro,
        { type: "table", rows: "rows", rowHeader: true, columns: [{ label: "", value: "c0" }, ...columns.map((label, j) => ({ label, value: `c${j + 1}` }))] },
      ]);
    }
    case "quiz": {
      const options = list(raw.options)
        .map((o) => {
          const item = visualItem(o);
          if (!item) return null;
          const label = item.title ?? item.label ?? item.primary;
          if (!label) return null;
          return {
            label,
            correct: isRecord(o) && o.correct === true,
            explanation: isRecord(o) ? text(o.explanation ?? o.why) : undefined,
          };
        })
        .filter((x): x is { label: string; correct: boolean; explanation: string | undefined } => !!x)
        .slice(0, 6);
      const question = text(raw.question) ?? title ?? "Which option fits best?";
      const quiz = quizComponent(undefined, [{ question, options }]);
      return quiz ? spec(question === title ? undefined : title, undefined, [quiz]) : UNREADABLE;
    }
    case "callout": {
      const lines = [body, ...items.map((i) => i.primary || i.title || i.label)].filter((x): x is string => !!x);
      if (!lines.length) return UNREADABLE;
      return spec(undefined, undefined, [obj([["type", "callout"], ["tone", "insight"], ["title", title], ["text", lines.join("\n")]])]);
    }
    default:
      return null;
  }
}

/** The Live UI source for a ```juno-visual fence. While streaming, an unparsable body is "" (a skeleton). */
export function legacyVisualSource(source: string, streaming = false): string {
  const s = legacyVisualSpec(source);
  if (s) return liveSource(s);
  return streaming ? "" : liveSource(UNREADABLE);
}
