export type ClarificationQuestionType = "single-choice" | "multi-choice" | "text" | "textarea" | "checkbox";
export type ClarificationAnswerValue = string | string[] | boolean;

export interface ClarificationQuestion {
  id: string;
  question: string;
  type: ClarificationQuestionType;
  options: string[];
  allowCustom: boolean;
  customPlaceholder?: string;
  required: boolean;
  helperText?: string;
}

export interface ClarificationAnswer {
  id: string;
  question?: string;
  value?: ClarificationAnswerValue;
  skipped?: boolean;
}

export interface ClarificationWizardBlock {
  blockId: string;
  title: string;
  description?: string;
  mode: "step-by-step";
  questions: ClarificationQuestion[];
  submitLabel: string;
  skipLabel: string;
  closeLabel: string;
  submitted: boolean;
  submittedAt?: string;
  answers: ClarificationAnswer[];
}

export interface ParsedClarificationWizardBlock {
  block: ClarificationWizardBlock;
  start: number;
  end: number;
  raw: string;
}

export interface SubmitClarificationWizardPayload {
  messageId: string;
  blockId: string;
  originalUserMessage: string;
  answers: ClarificationAnswer[];
  skippedQuestions: string[];
}

const WIZARD_OPEN = ":::clarification-wizard";
const WIZARD_CLOSE = ":::";
const VALID_TYPES = new Set<ClarificationQuestionType>(["single-choice", "multi-choice", "text", "textarea", "checkbox"]);
const TOP_LEVEL_KEYS = new Set(["title", "description", "mode", "submitLabel", "skipLabel", "closeLabel", "submitted", "submittedAt"]);
const MAX_QUESTIONS = 5;
const MAX_OPTIONS = 8;
const MAX_STRING_LENGTH = 500;

function cleanString(value: unknown, fallback = ""): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return fallback;
  return String(value).replace(/\s+/g, " ").trim().slice(0, MAX_STRING_LENGTH) || fallback;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "no") return false;
  return fallback;
}

function keyValue(raw: string): { key: string; value: string } | null {
  const idx = raw.indexOf(":");
  if (idx === -1) return null;
  const key = raw.slice(0, idx).trim();
  if (!/^[A-Za-z][\w-]*$/.test(key)) return null;
  return { key, value: raw.slice(idx + 1).trim() };
}

interface RawQuestion {
  id?: string;
  question?: string;
  type?: string;
  options?: string[];
  allowCustom?: string;
  customPlaceholder?: string;
  required?: string;
  helperText?: string;
}

interface RawAnswer {
  id?: string;
  question?: string;
  value?: string;
  skipped?: string;
}

interface RawWizard {
  title?: string;
  description?: string;
  mode?: string;
  submitLabel?: string;
  skipLabel?: string;
  closeLabel?: string;
  submitted?: string;
  submittedAt?: string;
  questions: RawQuestion[];
  answers: RawAnswer[];
}

function parseWizardYaml(source: string): RawWizard | null {
  const raw: RawWizard = { questions: [], answers: [] };
  let section: "questions" | "answers" | null = null;
  let currentQuestion: RawQuestion | null = null;
  let currentAnswer: RawAnswer | null = null;
  let collectingOptions = false;

  const finishQuestion = () => {
    if (currentQuestion) raw.questions.push(currentQuestion);
    currentQuestion = null;
    collectingOptions = false;
  };
  const finishAnswer = () => {
    if (currentAnswer) raw.answers.push(currentAnswer);
    currentAnswer = null;
  };

  for (const originalLine of source.split(/\r?\n/)) {
    const line = originalLine.replace(/\t/g, "  ").trimEnd();
    if (!line.trim()) continue;
    const trimmed = line.trim();
    const topLevel = !/^\s/.test(line);
    const sectionListItem = !!section && trimmed.startsWith("- ");

    if (topLevel && !sectionListItem) {
      const kv = keyValue(trimmed);
      if (!kv) continue;
      if (kv.key === "questions") {
        finishAnswer();
        section = "questions";
        continue;
      }
      if (kv.key === "answers") {
        finishQuestion();
        section = "answers";
        continue;
      }
      finishQuestion();
      finishAnswer();
      section = null;
      if (TOP_LEVEL_KEYS.has(kv.key)) (raw as unknown as Record<string, string>)[kv.key] = kv.value;
      continue;
    }

    if (section === "questions") {
      if (trimmed.startsWith("- ")) {
        const item = trimmed.slice(2).trim();
        const kv = keyValue(item);
        if (collectingOptions && !kv) {
          currentQuestion ??= {};
          currentQuestion.options ??= [];
          if (currentQuestion.options.length < MAX_OPTIONS) currentQuestion.options.push(cleanString(item));
          continue;
        }
        finishQuestion();
        currentQuestion = {};
        collectingOptions = false;
        if (kv) (currentQuestion as unknown as Record<string, string>)[kv.key] = kv.value;
        continue;
      }

      const kv = keyValue(trimmed);
      if (!kv || !currentQuestion) continue;
      if (kv.key === "options") {
        currentQuestion.options ??= [];
        collectingOptions = true;
        continue;
      }
      collectingOptions = false;
      (currentQuestion as unknown as Record<string, string>)[kv.key] = kv.value;
      continue;
    }

    if (section === "answers") {
      if (trimmed.startsWith("- ")) {
        const item = trimmed.slice(2).trim();
        const kv = keyValue(item);
        finishAnswer();
        currentAnswer = {};
        if (kv) (currentAnswer as unknown as Record<string, string>)[kv.key] = kv.value;
        continue;
      }

      const kv = keyValue(trimmed);
      if (!kv || !currentAnswer) continue;
      (currentAnswer as unknown as Record<string, string>)[kv.key] = kv.value;
    }
  }

  finishQuestion();
  finishAnswer();
  return raw;
}

function normalizeAnswerValue(value: string | undefined): ClarificationAnswerValue | undefined {
  if (value == null) return undefined;
  const trimmed = cleanString(value);
  if (!trimmed) return undefined;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.includes(" | ")) return trimmed.split(" | ").map((part) => cleanString(part)).filter(Boolean);
  return trimmed;
}

function normalizeWizard(raw: RawWizard, blockId: string): ClarificationWizardBlock | null {
  const questions = raw.questions
    .map((question, index): ClarificationQuestion | null => {
      const id = cleanString(question.id, `question_${index + 1}`).replace(/[^\w-]/g, "_").slice(0, 80);
      const text = cleanString(question.question);
      if (!id || !text) return null;
      const type = cleanString(question.type, "single-choice") as ClarificationQuestionType;
      const safeType = VALID_TYPES.has(type) ? type : "single-choice";
      const options = (question.options ?? []).map((option) => cleanString(option)).filter(Boolean).slice(0, MAX_OPTIONS);
      return {
        id,
        question: text,
        type: safeType,
        options,
        allowCustom: parseBoolean(question.allowCustom),
        customPlaceholder: cleanString(question.customPlaceholder) || undefined,
        required: parseBoolean(question.required),
        helperText: cleanString(question.helperText) || undefined,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_QUESTIONS) as ClarificationQuestion[];

  if (questions.length === 0) return null;

  const knownIds = new Set(questions.map((question) => question.id));
  const answers = raw.answers
    .map((answer): ClarificationAnswer | null => {
      const id = cleanString(answer.id).replace(/[^\w-]/g, "_").slice(0, 80);
      if (!id || !knownIds.has(id)) return null;
      const value = normalizeAnswerValue(answer.value);
      const skipped = parseBoolean(answer.skipped);
      return {
        id,
        question: cleanString(answer.question) || questions.find((question) => question.id === id)?.question,
        value,
        skipped,
      };
    })
    .filter(Boolean) as ClarificationAnswer[];

  return {
    blockId,
    title: cleanString(raw.title, "Quick clarification"),
    description: cleanString(raw.description) || undefined,
    mode: "step-by-step",
    questions,
    submitLabel: cleanString(raw.submitLabel, "Continue"),
    skipLabel: cleanString(raw.skipLabel, "Skip"),
    closeLabel: cleanString(raw.closeLabel, "Close"),
    submitted: parseBoolean(raw.submitted),
    submittedAt: cleanString(raw.submittedAt) || undefined,
    answers,
  };
}

function hashId(source: string): string {
  let h = 5381;
  for (let i = 0; i < source.length; i++) h = ((h << 5) + h + source.charCodeAt(i)) >>> 0;
  return "cw-" + h.toString(36);
}

export function parseClarificationWizard(source: string, seed = ""): ClarificationWizardBlock | null {
  const raw = parseWizardYaml(source);
  if (!raw) return null;
  return normalizeWizard(raw, hashId(`${seed}\n${source}`));
}

export function findClarificationWizardBlocks(text: string): ParsedClarificationWizardBlock[] {
  const blocks: ParsedClarificationWizardBlock[] = [];
  const linePattern = /.*(?:\r?\n|$)/g;
  let inCodeFence = false;
  let fenceMarker = "";
  let pending:
    | {
        start: number;
        innerStart: number;
      }
    | null = null;

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

    if (!pending && trimmed === WIZARD_OPEN) {
      pending = { start: lineStart, innerStart: lineStart + line.length };
      continue;
    }

    if (pending && trimmed === WIZARD_CLOSE) {
      const end = lineStart + line.length;
      const inner = text.slice(pending.innerStart, lineStart);
      const block = parseClarificationWizard(inner, `${pending.start}:${end}`);
      if (block) {
        blocks.push({
          block,
          start: pending.start,
          end,
          raw: text.slice(pending.start, end),
        });
      }
      pending = null;
    }
  }

  return blocks;
}

function scalar(value: unknown): string {
  return cleanString(value).replace(/\r?\n/g, " ");
}

function answerValueToString(value: ClarificationAnswerValue | undefined): string {
  if (Array.isArray(value)) return value.map(scalar).filter(Boolean).join(" | ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return scalar(value);
}

export function answerDisplayValue(answer: ClarificationAnswer): string {
  if (answer.skipped) return "Skipped";
  const value = answerValueToString(answer.value);
  return value || "No answer";
}

export function serializeClarificationWizardBlock(block: ClarificationWizardBlock): string {
  const lines = [WIZARD_OPEN];
  lines.push(`title: ${scalar(block.title) || "Quick clarification"}`);
  if (block.description) lines.push(`description: ${scalar(block.description)}`);
  lines.push("mode: step-by-step");
  if (block.submitted) lines.push("submitted: true");
  if (block.submittedAt) lines.push(`submittedAt: ${scalar(block.submittedAt)}`);
  lines.push("questions:");
  for (const question of block.questions) {
    lines.push(`- id: ${scalar(question.id)}`);
    lines.push(`  question: ${scalar(question.question)}`);
    lines.push(`  type: ${question.type}`);
    if (question.options.length) {
      lines.push("  options:");
      for (const option of question.options) lines.push(`  - ${scalar(option)}`);
    }
    if (question.allowCustom) lines.push("  allowCustom: true");
    if (question.customPlaceholder) lines.push(`  customPlaceholder: ${scalar(question.customPlaceholder)}`);
    if (question.required) lines.push("  required: true");
    if (question.helperText) lines.push(`  helperText: ${scalar(question.helperText)}`);
  }
  if (block.answers.length) {
    lines.push("answers:");
    for (const answer of block.answers) {
      lines.push(`- id: ${scalar(answer.id)}`);
      if (answer.question) lines.push(`  question: ${scalar(answer.question)}`);
      lines.push(`  value: ${answerValueToString(answer.value)}`);
      if (answer.skipped) lines.push("  skipped: true");
    }
  }
  lines.push(`submitLabel: ${scalar(block.submitLabel) || "Continue"}`);
  lines.push(`skipLabel: ${scalar(block.skipLabel) || "Skip"}`);
  lines.push(`closeLabel: ${scalar(block.closeLabel) || "Close"}`);
  lines.push(WIZARD_CLOSE);
  return lines.join("\n");
}

export function markClarificationWizardSubmitted(
  content: string,
  blockId: string,
  answers: ClarificationAnswer[],
  submittedAt = new Date().toISOString()
): string | null {
  const blocks = findClarificationWizardBlocks(content);
  const target = blocks.find((entry) => entry.block.blockId === blockId);
  if (!target) return null;
  const nextBlock: ClarificationWizardBlock = {
    ...target.block,
    submitted: true,
    submittedAt,
    answers,
  };
  return `${content.slice(0, target.start)}${serializeClarificationWizardBlock(nextBlock)}${content.slice(target.end)}`;
}

export function formatClarificationVisibleMessage(payload: {
  originalUserMessage: string;
  answers: ClarificationAnswer[];
  skippedQuestions: string[];
}): string {
  const answered = payload.answers.filter((answer) => !answer.skipped && answerValueToString(answer.value));
  const skipped = payload.skippedQuestions.filter(Boolean);
  const lines = ["Here are my clarification answers:"];
  if (answered.length) {
    for (const answer of answered) {
      lines.push(`- ${answer.question ?? answer.id}: ${answerDisplayValue(answer)}`);
    }
  } else {
    lines.push("- No specific answers; continue with reasonable assumptions.");
  }
  if (skipped.length) lines.push(`Skipped: ${skipped.join(", ")}`);
  lines.push("");
  lines.push("Please continue with my original request.");
  return lines.join("\n");
}

export function formatClarificationModelMessage(payload: {
  originalUserMessage: string;
  answers: ClarificationAnswer[];
  skippedQuestions: string[];
}): string {
  const answered = payload.answers.filter((answer) => !answer.skipped && answerValueToString(answer.value));
  const skipped = payload.skippedQuestions.filter(Boolean);
  const lines = [
    "The user answered the clarification wizard for the previous request.",
    "",
    "Original request:",
    payload.originalUserMessage.trim() || "(Previous user request in this conversation.)",
    "",
    "Clarification answers:",
  ];
  if (answered.length) {
    for (const answer of answered) lines.push(`- ${answer.id}: ${answerDisplayValue(answer)}`);
  } else {
    lines.push("- None provided.");
  }
  if (skipped.length) {
    lines.push("");
    lines.push("Skipped questions:");
    for (const skippedQuestion of skipped) lines.push(`- ${skippedQuestion}`);
  }
  lines.push("");
  lines.push("Now continue and answer the original request using these answers. Make reasonable assumptions for skipped questions.");
  return lines.join("\n");
}
