import "server-only";
import { streamChat } from "@/lib/llm";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";
import { getModelMetrics } from "@/lib/model-metrics";
import {
  noPreflightClarification,
  type PreflightClarificationQuestion,
  type PreflightClarificationQuestionType,
  type PreflightClarificationResult,
} from "@/lib/preflight-clarification";

/*
 * Pre-answer clarification triage
 * -------------------------------
 * A small, fast model reads the user's message (plus recent conversation
 * context) BEFORE Juno answers and decides whether asking 1–2 clarifying
 * questions first would materially improve the answer. The old regex layer
 * fired on keywords ("build" + "website" → canned question) regardless of how
 * specific the prompt already was; this layer reasons about the actual request
 * and writes questions specific to it — or, far more often, asks nothing.
 *
 * The whole check is latency-budgeted: the client aborts at 6s, so we keep a
 * hard 5s deadline server-side and fail OPEN (no clarification) on timeout,
 * provider errors, or unparseable output. A slow triage must never cost more
 * than it saves.
 */

// The client aborts its clarify fetch at 6s; auth + rate limit + the context
// query eat up to ~1.5s before triage starts, so the triage loop itself must
// stay within 4s or the user pays the full stall and gets nothing for it.
const TOTAL_DEADLINE_MS = 4000;
const FIRST_ATTEMPT_TIMEOUT_MS = 2600;
// One question keeps the interruption cheap: the single highest-impact
// unknown, answerable in one click (or one line via the "Other" input).
const MAX_QUESTIONS = 1;
const MAX_OPTIONS = 5;
const MAX_CONTEXT_MESSAGES = 6;
const DEAD_MODEL_COOLDOWN_MS = 10 * 60_000;

// Models that just failed with a won't-fix-itself error (quota, billing, bad
// key) sit out for a while so every triage doesn't burn latency re-proving it.
const modelCooldown = new Map<string, number>();

function isDeadProviderError(message: string): boolean {
  return /quota|credit|balance|billing|insufficient|api.?key|unauthorized|401|402|403/i.test(message);
}

export interface TriageContextMessage {
  role: "USER" | "ASSISTANT";
  content: string;
}

/**
 * Smartest of the fast configured models first. Triage is interactive so the
 * model must be fast (speed >= 8), but the question author needs enough
 * intelligence to honor the TRIAGE_SYSTEM quality bar — nano-class models
 * (intelligence 5/10) routinely produce generic, off-topic questions, which
 * is worse than asking nothing. Legacy/deprecated models are excluded. One
 * model per provider so a fallback attempt actually changes provider (quotas
 * and overloads are usually provider-wide).
 */
export function triageModelCandidates(): ModelInfo[] {
  const pool = MODEL_LIST.filter(
    (m) =>
      m.modality === "chat" &&
      !m.comingSoon &&
      !m.legacy &&
      m.minPlan === "FREE" &&
      isProviderConfigured(m.provider)
  ).map((m) => ({ m, metrics: getModelMetrics(m) }));
  // Prefer smart-and-fast; if no configured provider clears the intelligence
  // bar, fall back to the old fast-only bar rather than disabling the feature.
  let eligible = pool.filter(({ metrics }) => metrics.speed >= 8 && metrics.intelligence >= 7);
  if (!eligible.length) eligible = pool.filter(({ metrics }) => metrics.speed >= 8 && metrics.intelligence >= 5);
  const seen = new Set<string>();
  return eligible
    .sort(
      (a, b) =>
        b.metrics.intelligence - a.metrics.intelligence ||
        b.metrics.speed - a.metrics.speed ||
        a.m.cost - b.m.cost
    )
    .filter(({ m }) => (seen.has(m.provider) ? false : (seen.add(m.provider), true)))
    .map(({ m }) => m)
    .slice(0, 3);
}

const TRIAGE_SYSTEM = `You are the pre-answer triage step for Juno, an AI assistant. Before Juno answers, you decide whether pausing to ask the user ONE quick clarifying question FIRST would make Juno's answer meaningfully better.

DEFAULT TO NOT ASKING. Most messages — including most vague ones — should be answered directly with reasonable assumptions. Interrupting the user is expensive; only do it when the answer to your question would genuinely change what Juno produces.

Ask ONLY when ALL of these hold:
1. The request is a substantial piece of work (building, creating, writing, planning something non-trivial) — not a question, explanation, or chat.
2. It is missing a decision that materially changes the deliverable (audience, purpose, platform, subject matter), AND the conversation so far doesn't already answer it.
3. A wrong assumption would waste real effort — the user would have to ask for a redo, not a tweak.

NEVER ask when:
- The message is a factual question, an explanation request, or casual conversation. Juno can pick a sensible depth and tone on its own.
- It is a follow-up in an ongoing conversation and the context already pins down what the user means.
- The user provided code, an error, a document, or other concrete material to work from.
- The request is already specific enough to act on, even if some minor details are open.
- You can only think of generic questions. If a question could be pasted under a different request unchanged ("What should the focus be?", "What tone do you want?"), it is generic — do not ask it.

Question quality bar (when you do ask):
- Ask exactly ONE question — the single highest-impact unknown. If two things feel unclear, ask about the one that changes the deliverable most.
- The question must reference the specifics of THIS request; options must be concrete, mutually distinct, and cover the likely real answers — so the user can one-click instead of typing.
- Never ask about things Juno can decide well itself (colors, file structure, phrasing).

Respond with ONLY a JSON object, no markdown fences, no commentary:
{"needsClarification": false, "reason": "<one short sentence>"}
or
{"needsClarification": true, "reason": "<one short sentence>", "title": "<2-4 word card title>", "description": "<one short sentence shown under the title>", "questions": [{"id": "<snake_case>", "question": "<the question>", "type": "single-choice", "options": ["<opt>", "<opt>", "<opt>"], "elseLabel": "<short label for choosing a custom answer>", "elsePlaceholder": "<hint for a custom answer>"}]}

Question "type" is one of: single-choice, multi-choice, text, text-long. Use text/text-long only when options genuinely can't cover the answer (e.g. "What is the site about?"). Write the title, description, question, options, elseLabel and elsePlaceholder in the SAME language as the user's message.`;

function buildTriageUserMessage(message: string, recentMessages: TriageContextMessage[]): string {
  const parts: string[] = [];
  const context = recentMessages.slice(-MAX_CONTEXT_MESSAGES).filter((m) => m.content.trim());
  if (context.length) {
    parts.push("Conversation so far (most recent last):");
    for (const m of context) {
      parts.push(`${m.role === "USER" ? "User" : "Juno"}: ${m.content.replace(/\s+/g, " ").trim().slice(0, 800)}`);
    }
    parts.push("");
  }
  parts.push("New user message to triage:");
  parts.push(message.slice(0, 4000));
  return parts.join("\n");
}

function cleanLine(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  return String(value).replace(/\s+/g, " ").trim().slice(0, max) || fallback;
}

/** Tolerant JSON extraction: models sometimes wrap output in fences or prose. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const QUESTION_TYPES = new Set<PreflightClarificationQuestionType>(["single-choice", "multi-choice", "text", "text-long"]);

function sanitizeQuestion(value: unknown, index: number): PreflightClarificationQuestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const q = value as Record<string, unknown>;
  const question = cleanLine(q.question, 300);
  if (!question) return null;
  const rawType = cleanLine(q.type, 20) as PreflightClarificationQuestionType;
  const type = QUESTION_TYPES.has(rawType) ? rawType : "single-choice";
  const options = (Array.isArray(q.options) ? q.options : [])
    .map((opt) => cleanLine(opt, 120))
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);
  // A choice question with fewer than two options can't be chosen from —
  // degrade to free text instead of showing a broken card.
  const effectiveType = (type === "single-choice" || type === "multi-choice") && options.length < 2 ? "text" : type;
  return {
    id: cleanLine(q.id, 80).replace(/[^\w-]/g, "_") || `question_${index + 1}`,
    question,
    type: effectiveType,
    options: effectiveType === "text" || effectiveType === "text-long" ? [] : options,
    allowElse: true,
    elseLabel: cleanLine(q.elseLabel, 60) || "Something else",
    elsePlaceholder: cleanLine(q.elsePlaceholder, 200) || "Type your own answer...",
    required: false,
  };
}

function sanitizeTriageOutput(raw: string): PreflightClarificationResult | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj.needsClarification !== "boolean") return null;
  const reason = cleanLine(obj.reason, 300) || "Triage decision.";
  if (!obj.needsClarification) return noPreflightClarification(reason);
  const questions = (Array.isArray(obj.questions) ? obj.questions : [])
    .map((q, i) => sanitizeQuestion(q, i))
    .filter(Boolean)
    .slice(0, MAX_QUESTIONS) as PreflightClarificationQuestion[];
  // The popover keys its answer map by question id — colliding ids would make
  // one answer silently overwrite another, so uniquify defensively.
  const seenIds = new Set<string>();
  for (const q of questions) {
    while (seenIds.has(q.id)) q.id = `${q.id}_2`;
    seenIds.add(q.id);
  }
  if (!questions.length) return noPreflightClarification("Triage asked for clarification without usable questions.");
  return {
    needsClarification: true,
    reason,
    title: cleanLine(obj.title, 60) || "One quick question",
    description: cleanLine(obj.description, 200) || "Pick the closest option, type your own answer, or skip.",
    questions,
  };
}

async function attemptTriage(model: ModelInfo, system: string, userMsg: string, timeoutMs: number): Promise<PreflightClarificationResult | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let out = "";
  try {
    for await (const ev of streamChat({
      model,
      system,
      history: [{ role: "USER", content: userMsg, attachments: [] }],
      maxTokens: 600,
      signal: ctrl.signal,
    })) {
      if (ev.type === "text") out += ev.text;
    }
  } catch (e) {
    const msg = ctrl.signal.aborted ? `timed out after ${timeoutMs}ms` : e instanceof Error ? e.message : String(e);
    console.error(`[clarify-triage] ${model.id} failed:`, msg);
    // Quota/key errors sit out long (they won't fix themselves); a timeout sits
    // out briefly so a hung provider isn't re-probed on every single message.
    if (ctrl.signal.aborted) modelCooldown.set(model.id, Date.now() + 60_000);
    else if (isDeadProviderError(msg)) modelCooldown.set(model.id, Date.now() + DEAD_MODEL_COOLDOWN_MS);
    return null;
  } finally {
    clearTimeout(timer);
  }
  const parsed = sanitizeTriageOutput(out);
  if (!parsed) console.error(`[clarify-triage] ${model.id} unusable output (${out.length} chars)`);
  return parsed;
}

/**
 * Decide whether to show pre-answer clarification questions for this message.
 * Fails open — anything short of a confident, well-formed "ask" from the triage
 * model means Juno just answers.
 */
export async function triagePreflightClarification(input: {
  message: string;
  recentMessages?: TriageContextMessage[];
}): Promise<PreflightClarificationResult> {
  const all = triageModelCandidates();
  if (!all.length) return noPreflightClarification("No fast model is configured for the clarification check.");
  const now = Date.now();
  const healthy = all.filter((m) => (modelCooldown.get(m.id) ?? 0) <= now);
  // If everything is cooling down, try anyway — failing open still needs an attempt.
  const candidates = healthy.length ? healthy : all;

  const userMsg = buildTriageUserMessage(input.message, input.recentMessages ?? []);
  const started = Date.now();
  for (const model of candidates) {
    const remaining = TOTAL_DEADLINE_MS - (Date.now() - started);
    if (remaining < 800) break;
    const result = await attemptTriage(model, TRIAGE_SYSTEM, userMsg, Math.min(FIRST_ATTEMPT_TIMEOUT_MS, remaining));
    if (result) return result;
  }
  return noPreflightClarification("Clarification triage was unavailable — answering directly.");
}
