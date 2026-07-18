/**
 * Inline visual learning blocks — the unified `:::kind … :::` layer.
 *
 * The assistant embeds compact interactive lessons directly in chat replies:
 *
 *   :::learning-card        one key idea, toned (insight/tip/warning/note)
 *   :::step-lab             guided multi-step walkthrough (see step-lab.ts)
 *   :::process-timeline     ordered stages of a process
 *   :::comparison           side-by-side option/row comparison
 *   :::quiz                 one-question local check (no message sent)
 *   :::deep-dive            collapsed expandable detail section
 *
 * Bodies are the same forgiving YAML subset Step Lab uses. Parsing is cached,
 * fence-aware (no blocks inside ``` code), validated per kind, and never
 * throws — malformed blocks degrade to a labeled fallback, and a block whose
 * closing `:::` hasn't streamed in yet is surfaced as `streaming` so the UI
 * can show a placeholder instead of parsing half-written YAML.
 */

import {
  arrayOfRecords,
  cleanString,
  cleanText,
  isRecord,
  parseStepLab,
  parseYamlSubset,
  stableId,
  type StepLab,
} from "@/lib/step-lab";

export type LearningBlockKind =
  | "step-lab"
  | "learning-card"
  | "process-timeline"
  | "comparison"
  | "quiz"
  | "deep-dive";

export type LearningCardTone = "insight" | "tip" | "warning" | "note";

export interface LearningCardData {
  title: string;
  icon?: string; // short emoji, rendered as plain text
  tone: LearningCardTone;
  content: string;
}

export interface ProcessTimelineStep {
  label: string;
  description?: string;
}

export interface ProcessTimelineData {
  title?: string;
  steps: ProcessTimelineStep[];
}

export interface ComparisonRow {
  label: string;
  values: string[];
}

export interface ComparisonData {
  title?: string;
  columns: string[];
  rows: ComparisonRow[];
  verdict?: string;
}

export interface QuizOption {
  label: string;
  correct: boolean;
  explanation?: string;
}

export interface QuizQuestion {
  question: string;
  options: QuizOption[];
  explanation?: string;
  /** Optional on-demand hint revealed before answering. */
  hint?: string;
}

export interface QuizData {
  /** Optional heading for a multi-question quiz. */
  title?: string;
  /** One or more questions, walked through in order with a recap at the end. */
  questions: QuizQuestion[];
}

export interface DeepDiveData {
  title: string;
  summary: string;
  content: string;
}

export type LearningBlockPayload =
  | { kind: "step-lab"; lab: StepLab }
  | { kind: "learning-card"; card: LearningCardData }
  | { kind: "process-timeline"; timeline: ProcessTimelineData }
  | { kind: "comparison"; comparison: ComparisonData }
  | { kind: "quiz"; quiz: QuizData }
  | { kind: "deep-dive"; deepDive: DeepDiveData };

export interface ParsedLearningBlock {
  blockId: string;
  kind: LearningBlockKind;
  /** null while streaming (unclosed) or when the block is beyond salvage. */
  payload: LearningBlockPayload | null;
  /** Human-readable problem when the block was malformed but salvaged/fallback. */
  error?: string;
  /** The closing ::: has not arrived yet — render a placeholder, do not parse. */
  streaming?: boolean;
  start: number;
  end: number;
  raw: string;
}

const KINDS: LearningBlockKind[] = ["step-lab", "learning-card", "process-timeline", "comparison", "quiz", "deep-dive"];
const KIND_SET = new Set<string>(KINDS);
const OPEN_PREFIX = ":::";
const CLOSE = ":::";
const MAX_TIMELINE_STEPS = 10;
const MAX_COMPARISON_ROWS = 8;
const MAX_COMPARISON_COLS = 4;
const MAX_QUIZ_OPTIONS = 6;
const MAX_QUIZ_QUESTIONS = 8;

export const LEARNING_BLOCK_LABELS: Record<LearningBlockKind, string> = {
  "step-lab": "Step Lab",
  "learning-card": "Key idea",
  "process-timeline": "Process",
  comparison: "Comparison",
  quiz: "Quick check",
  "deep-dive": "Deep dive",
};

// Matches every block opener for cheap stripping (speech/persistence paths).
export const LEARNING_BLOCK_RE = new RegExp(`^:::(?:${KINDS.join("|")})\\b[\\s\\S]*?(?:^:::\\s*$|$(?![\\s\\S]))`, "gim");

const PARSE_CACHE = new Map<string, { payload: LearningBlockPayload | null; error?: string }>();

function cachePut(key: string, value: { payload: LearningBlockPayload | null; error?: string }) {
  if (PARSE_CACHE.size > 120) {
    const oldest = PARSE_CACHE.keys().next().value;
    if (oldest != null) PARSE_CACHE.delete(oldest);
  }
  PARSE_CACHE.set(key, value);
  return value;
}

function parseLearningCard(raw: Record<string, unknown>): { payload: LearningBlockPayload | null; error?: string } {
  const content = cleanText(raw.content ?? raw.body ?? raw.text, 2000);
  if (!content) return { payload: null, error: "Learning card needs `content`." };
  const toneRaw = cleanString(raw.tone).toLowerCase();
  const tone: LearningCardTone =
    toneRaw === "tip" || toneRaw === "warning" || toneRaw === "note" ? toneRaw : "insight";
  return {
    payload: {
      kind: "learning-card",
      card: {
        title: cleanString(raw.title, "Core idea"),
        icon: cleanString(raw.icon).slice(0, 8) || undefined,
        tone,
        content,
      },
    },
  };
}

function parseProcessTimeline(raw: Record<string, unknown>): { payload: LearningBlockPayload | null; error?: string } {
  const steps = arrayOfRecords(raw.steps ?? raw.items)
    .map((step) => {
      const label = cleanString(step.label ?? step.title ?? step.name);
      if (!label) return null;
      return { label, description: cleanText(step.description ?? step.body ?? step.detail, 500) || undefined };
    })
    .filter(Boolean)
    .slice(0, MAX_TIMELINE_STEPS) as ProcessTimelineStep[];
  if (steps.length < 2) return { payload: null, error: "Process timeline needs at least two steps with labels." };
  return {
    payload: {
      kind: "process-timeline",
      timeline: { title: cleanString(raw.title) || undefined, steps },
    },
  };
}

function parseComparison(raw: Record<string, unknown>): { payload: LearningBlockPayload | null; error?: string } {
  const columns = (Array.isArray(raw.columns) ? raw.columns : [])
    .map((col) => cleanString(col))
    .filter(Boolean)
    .slice(0, MAX_COMPARISON_COLS);
  const rows = arrayOfRecords(raw.rows ?? raw.items)
    .map((row) => {
      const label = cleanString(row.label ?? row.title ?? row.name ?? row.focus);
      const source = row.values ?? row.cells;
      const values = (Array.isArray(source) ? source : [])
        .map((value) => cleanText(value, 400))
        .slice(0, Math.max(columns.length, 1));
      if (!label || values.length === 0) return null;
      return { label, values };
    })
    .filter(Boolean)
    .slice(0, MAX_COMPARISON_ROWS) as ComparisonRow[];
  if (columns.length < 2 || rows.length === 0) {
    return { payload: null, error: "Comparison needs 2+ columns and at least one row with values." };
  }
  return {
    payload: {
      kind: "comparison",
      comparison: {
        title: cleanString(raw.title) || undefined,
        columns,
        rows,
        verdict: cleanText(raw.verdict ?? raw.takeaway, 400) || undefined,
      },
    },
  };
}

/** Parse one question block (shared by the single- and multi-question shapes).
 *  Returns null when it lacks a question, <2 options, or any correct answer. */
function parseQuizQuestion(raw: Record<string, unknown>): QuizQuestion | null {
  const question = cleanText(raw.question ?? raw.title ?? raw.q, 500);
  const answerText = cleanString(raw.answer).toLowerCase();
  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  const options = rawOptions
    .map((option): QuizOption | null => {
      if (typeof option === "string" || typeof option === "number") {
        const label = cleanString(option);
        if (!label) return null;
        return { label, correct: !!answerText && label.toLowerCase() === answerText };
      }
      if (!isRecord(option)) return null;
      const label = cleanString(option.label ?? option.text ?? option.title);
      if (!label) return null;
      return {
        label,
        correct: option.correct === true || (!!answerText && label.toLowerCase() === answerText),
        explanation: cleanText(option.explanation ?? option.why, 500) || undefined,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_QUIZ_OPTIONS) as QuizOption[];
  if (!question || options.length < 2) return null;
  if (!options.some((option) => option.correct)) return null;
  return {
    question,
    options,
    explanation: cleanText(raw.explanation, 800) || undefined,
    hint: cleanText(raw.hint, 400) || undefined,
  };
}

function parseQuiz(raw: Record<string, unknown>): { payload: LearningBlockPayload | null; error?: string } {
  // Multi-question shape (`questions:` list) OR the legacy single-question shape
  // (question/options at the top level). Both normalize to a questions array.
  const list = Array.isArray(raw.questions) ? raw.questions : null;
  const questions = (list ? list.filter(isRecord).map(parseQuizQuestion) : [parseQuizQuestion(raw)])
    .filter(Boolean)
    .slice(0, MAX_QUIZ_QUESTIONS) as QuizQuestion[];
  if (!questions.length) {
    return { payload: null, error: "Quiz needs a question with 2+ options and a correct answer." };
  }
  return {
    payload: {
      kind: "quiz",
      quiz: {
        // A quiz-level title only makes sense in multi-question mode; in the
        // legacy single shape `title` was an alias for the question itself.
        title: list ? cleanString(raw.title) || undefined : undefined,
        questions,
      },
    },
  };
}

function parseDeepDive(raw: Record<string, unknown>): { payload: LearningBlockPayload | null; error?: string } {
  const title = cleanString(raw.title);
  const content = cleanText(raw.content ?? raw.body ?? raw.detail, 4000);
  if (!title || !content) return { payload: null, error: "Deep dive needs `title` and `content`." };
  return {
    payload: {
      kind: "deep-dive",
      deepDive: { title, summary: cleanText(raw.summary, 500) || title, content },
    },
  };
}

/** Parse one closed block body. Never throws. */
export function parseLearningBlock(
  kind: LearningBlockKind,
  source: string,
  seed = ""
): { payload: LearningBlockPayload | null; error?: string } {
  const cacheKey = `${kind}\0${seed}\0${source}`;
  const cached = PARSE_CACHE.get(cacheKey);
  if (cached) return cached;

  if (kind === "step-lab") {
    const parsed = parseStepLab(source, seed);
    return cachePut(cacheKey, { payload: { kind: "step-lab", lab: parsed.block }, error: parsed.error });
  }

  let raw: unknown;
  try {
    raw = parseYamlSubset(source);
  } catch {
    return cachePut(cacheKey, { payload: null, error: "Malformed block data." });
  }
  if (!isRecord(raw)) return cachePut(cacheKey, { payload: null, error: "Block body must be key: value data." });

  const result =
    kind === "learning-card"
      ? parseLearningCard(raw)
      : kind === "process-timeline"
        ? parseProcessTimeline(raw)
        : kind === "comparison"
          ? parseComparison(raw)
          : kind === "quiz"
            ? parseQuiz(raw)
            : parseDeepDive(raw);
  return cachePut(cacheKey, result);
}

/**
 * Scan message text for learning blocks. Skips fenced code. The trailing block
 * whose `:::` close hasn't arrived is returned with `streaming: true` and is
 * NOT parsed (its body is still being generated).
 */
export function findLearningBlocks(text: string): ParsedLearningBlock[] {
  const blocks: ParsedLearningBlock[] = [];
  const linePattern = /.*(?:\r?\n|$)/g;
  let inCodeFence = false;
  let fenceMarker = "";
  let pending: { kind: LearningBlockKind; start: number; innerStart: number } | null = null;

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

    if (!pending && trimmed.startsWith(OPEN_PREFIX)) {
      const kindToken = trimmed.slice(OPEN_PREFIX.length).split(/[\s{]/)[0].toLowerCase();
      if (KIND_SET.has(kindToken)) {
        pending = {
          kind: kindToken as LearningBlockKind,
          start: lineStart,
          innerStart: lineStart + line.length,
        };
        continue;
      }
    }

    if (pending && trimmed === CLOSE) {
      const end = lineStart + line.length;
      const inner = text.slice(pending.innerStart, lineStart);
      const seed = `${pending.start}:${end}`;
      const parsed = parseLearningBlock(pending.kind, inner, seed);
      blocks.push({
        blockId: stableId(`${seed}:${pending.kind}:${inner}`, "learn"),
        kind: pending.kind,
        payload: parsed.payload,
        error: parsed.error,
        start: pending.start,
        end,
        raw: text.slice(pending.start, end),
      });
      pending = null;
    }
  }

  if (pending) {
    // Unclosed trailing block — still streaming in. Surface a placeholder;
    // parsing waits for the closing delimiter.
    blocks.push({
      blockId: stableId(`${pending.start}:streaming:${pending.kind}`, "learn"),
      kind: pending.kind,
      payload: null,
      streaming: true,
      start: pending.start,
      end: text.length,
      raw: text.slice(pending.start),
    });
  }

  return blocks;
}

/**
 * Parse a block that never received its closing ::: (the reply finished or was
 * truncated mid-block). Called by the renderer once the message stops
 * streaming, so a cut-off lesson still renders instead of a stuck placeholder.
 */
export function salvageLearningBlock(block: ParsedLearningBlock): ParsedLearningBlock {
  if (!block.streaming) return block;
  const newlineIdx = block.raw.indexOf("\n");
  const inner = newlineIdx === -1 ? "" : block.raw.slice(newlineIdx + 1);
  const parsed = parseLearningBlock(block.kind, inner, `salvage:${block.start}`);
  return { ...block, payload: parsed.payload, error: parsed.error ?? "This block was cut off mid-stream.", streaming: false };
}
