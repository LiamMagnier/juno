export type StepLabVisualType =
  | "tokenization"
  | "embedding"
  | "attention"
  | "transformer-processing"
  | "probability-distribution"
  | "next-token-selection"
  | "generic-process";

export interface StepLabStep {
  id: string;
  title: string;
  summary: string;
  detail?: string;
  visualType: StepLabVisualType;
  data?: unknown;
}

export interface StepLabQuizOption {
  label: string;
  correct?: boolean;
  explanation?: string;
}

export interface StepLabQuiz {
  question: string;
  options: StepLabQuizOption[];
}

export interface StepLab {
  blockId: string;
  title: string;
  label?: string;
  description?: string;
  /** "compact" tightens paddings/typography for chat width. */
  density?: "compact" | "comfortable";
  steps: StepLabStep[];
  submitLabel?: string;
  quiz?: StepLabQuiz;
}

export interface ParsedStepLabBlock {
  block: StepLab;
  start: number;
  end: number;
  raw: string;
  error?: string;
}

const STEP_LAB_OPEN = ":::step-lab";
const STEP_LAB_CLOSE = ":::";
const VALID_VISUAL_TYPES = new Set<StepLabVisualType>([
  "tokenization",
  "embedding",
  "attention",
  "transformer-processing",
  "probability-distribution",
  "next-token-selection",
  "generic-process",
]);
const MAX_STEPS = 8;
const MAX_OPTIONS = 8;
const MAX_STRING_LENGTH = 1200;
const PARSED_STEP_LAB_CACHE = new Map<string, { block: StepLab; error?: string }>();

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

function countIndent(line: string): number {
  const match = /^ */.exec(line);
  return match?.[0].length ?? 0;
}

export function cleanString(value: unknown, fallback = ""): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return fallback;
  return String(value).replace(/\s+/g, " ").trim().slice(0, MAX_STRING_LENGTH) || fallback;
}

/** Like cleanString but preserves paragraph breaks (deep dives, card bodies). */
export function cleanText(value: unknown, max = 4000, fallback = ""): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return fallback;
  return (
    String(value)
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, max) || fallback
  );
}

/**
 * Split a YAML flow-sequence body on top-level commas only — commas inside a
 * quoted item are preserved. Without this, `["a, b", "c"]` splits mid-string
 * and leaves a dangling quote on the fragment (e.g. `"a` / `b"`).
 */
function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === ",") {
      items.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  items.push(buf);
  return items;
}

function parseScalar(value: string): YamlValue {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowItems(inner)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => parseScalar(part));
  }
  return trimmed;
}

function splitKeyValue(text: string): { key: string; value: string } | null {
  const index = text.indexOf(":");
  if (index === -1) return null;
  const key = text.slice(0, index).trim();
  if (!/^[A-Za-z][\w-]*$/.test(key)) return null;
  return { key, value: text.slice(index + 1).trim() };
}

function preprocess(source: string): Line[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "  ").replace(/\s+$/, ""))
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => ({ indent: countIndent(line), text: line.trim() }));
}

export function parseYamlSubset(source: string): YamlValue {
  const lines = preprocess(source);

  function parseNode(index: number, indent: number): { value: YamlValue; next: number } {
    if (index >= lines.length || lines[index].indent < indent) return { value: {}, next: index };
    if (lines[index].text.startsWith("- ")) return parseSequence(index, indent);
    return parseMapping(index, indent);
  }

  function parseSequence(index: number, indent: number): { value: YamlValue[]; next: number } {
    const items: YamlValue[] = [];
    let i = index;
    while (i < lines.length) {
      const line = lines[i];
      if (line.indent < indent || line.indent !== indent || !line.text.startsWith("- ")) break;
      const itemText = line.text.slice(2).trim();
      i += 1;

      let item: YamlValue;
      const inlineKv = splitKeyValue(itemText);
      if (!itemText) {
        const nested = parseNode(i, indent + 2);
        item = nested.value;
        i = nested.next;
      } else if (inlineKv) {
        const object: Record<string, YamlValue> = {};
        object[inlineKv.key] = inlineKv.value ? parseScalar(inlineKv.value) : {};
        while (i < lines.length && lines[i].indent > indent) {
          const nestedLine = lines[i];
          if (nestedLine.indent !== indent + 2) break;
          const nestedKv = splitKeyValue(nestedLine.text);
          if (!nestedKv) break;
          i += 1;
          if (nestedKv.value) {
            object[nestedKv.key] = parseScalar(nestedKv.value);
          } else if (i < lines.length && (lines[i].indent > nestedLine.indent || lines[i].text.startsWith("- "))) {
            const nested = parseNode(i, lines[i].indent > nestedLine.indent ? nestedLine.indent + 2 : lines[i].indent);
            object[nestedKv.key] = nested.value;
            i = nested.next;
          } else {
            object[nestedKv.key] = {};
          }
        }
        item = object;
      } else {
        item = parseScalar(itemText);
      }
      items.push(item);
    }
    return { value: items, next: i };
  }

  function parseMapping(index: number, indent: number): { value: Record<string, YamlValue>; next: number } {
    const object: Record<string, YamlValue> = {};
    let i = index;
    while (i < lines.length) {
      const line = lines[i];
      if (line.indent < indent || line.indent !== indent || line.text.startsWith("- ")) break;
      const kv = splitKeyValue(line.text);
      if (!kv) {
        i += 1;
        continue;
      }
      i += 1;
      if (kv.value) {
        object[kv.key] = parseScalar(kv.value);
      } else if (i < lines.length && (lines[i].indent > line.indent || lines[i].text.startsWith("- "))) {
        const nested = parseNode(i, lines[i].indent > line.indent ? line.indent + 2 : lines[i].indent);
        object[kv.key] = nested.value;
        i = nested.next;
      } else {
        object[kv.key] = {};
      }
    }
    return { value: object, next: i };
  }

  return parseNode(0, 0).value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeVisualType(value: unknown, step: Record<string, unknown>): StepLabVisualType {
  const raw = cleanString(value).toLowerCase() as StepLabVisualType;
  if (VALID_VISUAL_TYPES.has(raw)) return raw;
  const hint = `${cleanString(step.id)} ${cleanString(step.title)} ${cleanString(step.summary)}`.toLowerCase();
  if (/token/.test(hint)) return "tokenization";
  if (/embed|vector/.test(hint)) return "embedding";
  if (/attention|context/.test(hint)) return "attention";
  if (/transformer|layer/.test(hint)) return "transformer-processing";
  if (/probab|distribution|softmax|candidate/.test(hint)) return "probability-distribution";
  if (/select|output|next/.test(hint)) return "next-token-selection";
  return "generic-process";
}

export function stableId(source: string, prefix = "step-lab"): string {
  let h = 5381;
  for (let i = 0; i < source.length; i++) h = ((h << 5) + h + source.charCodeAt(i)) >>> 0;
  return prefix + "-" + h.toString(36);
}

function normalizeQuiz(value: unknown): StepLabQuiz | undefined {
  if (!isRecord(value)) return undefined;
  const question = cleanString(value.question);
  const options = arrayOfRecords(value.options)
    .map((option) => ({
      label: cleanString(option.label ?? option.title ?? option.text),
      correct: option.correct === true,
      explanation: cleanString(option.explanation) || undefined,
    }))
    .filter((option) => option.label)
    .slice(0, MAX_OPTIONS);
  return question && options.length ? { question, options } : undefined;
}

function makeFallbackLab(raw: string, error: string, seed: string): StepLab {
  const titleMatch = /^title:\s*(.+)$/m.exec(raw);
  const title = titleMatch ? cleanString(titleMatch[1], "Visual explanation") : "Visual explanation";
  return {
    blockId: stableId(`${seed}:fallback:${raw}`),
    title,
    label: "Step Lab",
    description: "This visual explanation was incomplete, so Juno is showing a safe fallback.",
    steps: [
      {
        id: "fallback",
        title: "Visual explanation",
        summary: "The Step Lab data was malformed or incomplete.",
        detail: error,
        visualType: "generic-process",
        data: {
          input: title,
          transform: "Validate the explanation data",
          output: "Readable fallback instead of a broken block",
        },
      },
    ],
  };
}

function cacheParsedStepLab(key: string, value: { block: StepLab; error?: string }): { block: StepLab; error?: string } {
  if (PARSED_STEP_LAB_CACHE.size > 80) {
    const oldestKey = PARSED_STEP_LAB_CACHE.keys().next().value;
    if (oldestKey != null) PARSED_STEP_LAB_CACHE.delete(oldestKey);
  }
  PARSED_STEP_LAB_CACHE.set(key, value);
  return value;
}

export function parseStepLab(source: string, seed = ""): { block: StepLab; error?: string } {
  const cacheKey = `${seed}\0${source}`;
  const cached = PARSED_STEP_LAB_CACHE.get(cacheKey);
  if (cached) return cached;

  let raw: unknown;
  try {
    raw = parseYamlSubset(source);
  } catch (error) {
    return cacheParsedStepLab(cacheKey, {
      block: makeFallbackLab(source, error instanceof Error ? error.message : "Could not parse Step Lab data.", seed),
      error: "Malformed Step Lab data.",
    });
  }

  if (!isRecord(raw)) {
    return cacheParsedStepLab(cacheKey, {
      block: makeFallbackLab(source, "The Step Lab block must be a mapping.", seed),
      error: "Invalid Step Lab schema.",
    });
  }
  const rawSteps = arrayOfRecords(raw.steps);
  const steps = rawSteps
    .map((step, index): StepLabStep | null => {
      const title = cleanString(step.title, `Step ${index + 1}`);
      const summary = cleanString(step.summary ?? step.body ?? step.description);
      if (!title || !summary) return null;
      const id = cleanString(step.id, `step_${index + 1}`).replace(/[^\w-]/g, "_").slice(0, 80);
      return {
        id,
        title,
        summary,
        detail: cleanString(step.detail ?? step.details) || undefined,
        visualType: normalizeVisualType(step.visualType ?? step.type, step),
        data: step.data,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_STEPS) as StepLabStep[];

  if (!steps.length) {
    return cacheParsedStepLab(cacheKey, {
      block: makeFallbackLab(source, "Add at least one step with title, summary, visualType, and data.", seed),
      error: "Step Lab has no valid steps.",
    });
  }

  const density = cleanString(raw.density).toLowerCase();
  return cacheParsedStepLab(cacheKey, {
    block: {
      blockId: stableId(`${seed}:${source}`),
      title: cleanString(raw.title, "Interactive learning lab"),
      label: cleanString(raw.label, "Step Lab"),
      description: cleanString(raw.description) || undefined,
      density: density === "compact" ? "compact" : density === "comfortable" ? "comfortable" : undefined,
      steps,
      submitLabel: cleanString(raw.submitLabel, "Finish"),
      quiz: normalizeQuiz(raw.quiz),
    },
  });
}

export function findStepLabBlocks(text: string): ParsedStepLabBlock[] {
  const blocks: ParsedStepLabBlock[] = [];
  const linePattern = /.*(?:\r?\n|$)/g;
  let inCodeFence = false;
  let fenceMarker = "";
  let pending: { start: number; innerStart: number } | null = null;

  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(text))) {
    const line = match[0];
    if (!line) break;
    const lineStart = match.index;
    const trimmed = line.trim();

    if (!pending && /^(```|~~~)/.test(trimmed)) {
      const marker = trimmed.slice(0, 3);
      if (!inCodeFence) {
        inCodeFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inCodeFence = false;
        fenceMarker = "";
      }
    }

    if (inCodeFence) continue;

    if (!pending && (trimmed === STEP_LAB_OPEN || trimmed.startsWith(STEP_LAB_OPEN + " "))) {
      pending = { start: lineStart, innerStart: lineStart + line.indexOf(STEP_LAB_OPEN) + STEP_LAB_OPEN.length };
      continue;
    }

    if (pending && trimmed === STEP_LAB_CLOSE) {
      const end = lineStart + line.length;
      const inner = text.slice(pending.innerStart, lineStart);
      const parsed = parseStepLab(inner, `${pending.start}:${end}`);
      blocks.push({
        block: parsed.block,
        error: parsed.error,
        start: pending.start,
        end,
        raw: text.slice(pending.start, end),
      });
      pending = null;
    }
  }

  if (pending) {
    const end = text.length;
    const inner = text.slice(pending.innerStart);
    const parsed = parseStepLab(inner, `${pending.start}:${end}`);
    blocks.push({
      block: parsed.block,
      error: parsed.error,
      start: pending.start,
      end,
      raw: text.slice(pending.start),
    });
  }

  return blocks;
}

export function stepLabFromLegacySteps(input: {
  title?: string;
  description?: string;
  label?: string;
  steps: Array<{ title?: string; label?: string; body?: string; text?: string; detail?: string; value?: string }>;
}): StepLab {
  const steps = input.steps.map((step, index) => {
    const title = cleanString(step.title ?? step.label, `Step ${index + 1}`);
    const summary = cleanString(step.body ?? step.text ?? step.detail ?? step.value, "Explore this stage of the process.");
    const visualType = normalizeVisualType(undefined, { title, summary, id: step.label ?? title });
    return {
      id: cleanString(step.label, `step_${index + 1}`).replace(/[^\w-]/g, "_"),
      title,
      summary,
      detail: cleanString(step.detail && step.detail !== summary ? step.detail : "") || undefined,
      visualType,
      data: undefined,
    };
  });
  return {
    blockId: stableId(`${input.title ?? ""}:${steps.map((step) => step.title).join("|")}`),
    title: cleanString(input.title, "Interactive learning lab"),
    label: input.label ?? "Step Lab",
    description: cleanString(input.description) || undefined,
    steps,
    submitLabel: "Finish",
  };
}
