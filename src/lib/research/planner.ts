/**
 * The research planner: one call that scopes a run (SPEC §9.5, DECISIONS R2).
 *
 * Clarify and plan used to be two gates — a clarify call that could park the
 * run on a form, then a brief expansion, then a planner whose JSON was parsed
 * leniently and, when it did not parse, fed line by line into the legacy
 * query parser (B5). Now one call on the lead model returns the questions,
 * up to three optional clarifications, the searches, the sources it will
 * favour and the scope that sizes the run. It is asked for structured output
 * where the provider can hold a reply to a schema, validated here in every
 * case, retried once, and otherwise the run fails with `planner_invalid` — a
 * truncated object is never searched as if it were a list of queries.
 *
 * Pure: the model call is injected (`tools.ts` wires `streamChat`), so the
 * retry rule, the validation and the mapping onto the stored plan are all
 * testable offline.
 */

import {
  MAX_CLARIFICATION_CHARS,
  MAX_EVIDENCE_REQUIREMENTS,
  MAX_PLAN_QUERIES,
  MAX_PLAN_TITLE_CHARS,
  MAX_QUERY_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_RESEARCH_OBJECTIVES,
  MAX_SOURCE_KINDS,
  PLANNER_OUTPUT_TOKENS,
  PLANNER_PROMPT_CHARS,
  type EvidenceRequirement,
  type ResearchClarification,
  type ResearchObjective,
  type ResearchPlanRevision,
} from "@/lib/research/domain";
import { extractJsonObject } from "@/lib/research/plan-format";
import {
  CONVERSATION_CONTEXT_LABEL,
  PLANNER_RETRY_NOTE,
  RESEARCH_PLAN_SCHEMA,
  plannerRevisionNote,
  plannerSystemPrompt,
  researchDateLine,
  researchLanguageLine,
} from "@/lib/research/planner.prompt";
import { wrapUntrusted } from "@/lib/untrusted-content";
import type { ResearchEstimate, ResearchScope } from "@/types/research";

/** The planner's reply, as validated. */
export interface PlannerOutput {
  title: string;
  approach: string;
  questions: Array<{
    question: string;
    rationale: string;
    evidence: { minSources: number; primary: boolean; freshness?: string };
  }>;
  clarifications: Array<{ id: string; question: string; options?: string[] }>;
  sources: string[];
  queries: string[];
  scope: { breadth: "focused" | "broad" | "exhaustive"; freshness: "any" | "recent" | "live"; primarySources: boolean; quick: boolean };
  language: string;
}

const MAX_APPROACH = 600;
const MAX_CLARIFICATIONS_ASKED = 3;
/** The reply may name at most this many searches; the engine's own ceiling is MAX_PLAN_QUERIES. */
export const PLANNED_QUERY_LIMIT = 24;

const oneLine = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

function lines(value: unknown, max: number, chars: number, minChars = 3): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const line = oneLine(item, chars);
    if (line.length < minChars) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * JSON-looking text: the one thing the legacy line parser must never be
 * handed. A reply that opens with a brace or carries a `"question":` key is a
 * (possibly truncated) object, and its lines are keys and values, not searches.
 */
export function looksLikeJson(text: string): boolean {
  return /^\s*[{[]/.test(text) || /"question"\s*:/.test(text);
}

/**
 * The reply, validated, or null.
 *
 * Strict about shape — a reply without questions, or with a scope this build
 * does not know, is not a plan — and forgiving about size: every string and
 * list is bounded on the way in, so a verbose model costs the plan detail,
 * never its validity.
 */
export function parsePlannerOutput(text: string): PlannerOutput | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const plan = raw as Record<string, unknown>;
  if (!Array.isArray(plan.questions)) return null;

  const questions: PlannerOutput["questions"] = [];
  const seen = new Set<string>();
  for (const item of plan.questions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const q = item as Record<string, unknown>;
    const question = oneLine(q.question, MAX_QUERY_CHARS);
    if (question.length < 8 || seen.has(question.toLowerCase())) continue;
    seen.add(question.toLowerCase());
    const evidence = q.evidence && typeof q.evidence === "object" && !Array.isArray(q.evidence) ? (q.evidence as Record<string, unknown>) : {};
    const minSources =
      typeof evidence.minSources === "number" && Number.isFinite(evidence.minSources)
        ? Math.max(1, Math.min(4, Math.round(evidence.minSources)))
        : 2;
    const freshness = oneLine(evidence.freshness, 160);
    questions.push({
      question,
      rationale: oneLine(q.rationale, MAX_RATIONALE_CHARS),
      evidence: { minSources, primary: evidence.primary === true, ...(freshness ? { freshness } : {}) },
    });
    if (questions.length >= MAX_RESEARCH_OBJECTIVES) break;
  }
  if (questions.length === 0) return null;

  const scopeRaw = plan.scope && typeof plan.scope === "object" && !Array.isArray(plan.scope) ? (plan.scope as Record<string, unknown>) : null;
  if (!scopeRaw) return null;
  const breadth = scopeRaw.breadth;
  const freshness = scopeRaw.freshness;
  if (breadth !== "focused" && breadth !== "broad" && breadth !== "exhaustive") return null;
  if (freshness !== "any" && freshness !== "recent" && freshness !== "live") return null;

  const clarifications: PlannerOutput["clarifications"] = [];
  if (Array.isArray(plan.clarifications)) {
    const ids = new Set<string>();
    for (const item of plan.clarifications) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const c = item as Record<string, unknown>;
      const question = oneLine(c.question, MAX_CLARIFICATION_CHARS);
      if (question.length < 4) continue;
      let id = oneLine(c.id, 32) || `c${clarifications.length + 1}`;
      if (ids.has(id)) id = `c${clarifications.length + 1}`;
      ids.add(id);
      const options = lines(c.options, 4, MAX_CLARIFICATION_CHARS, 1);
      clarifications.push({ id, question, ...(options.length ? { options } : {}) });
      if (clarifications.length >= MAX_CLARIFICATIONS_ASKED) break;
    }
  }

  return {
    title: oneLine(plan.title, MAX_PLAN_TITLE_CHARS),
    approach: oneLine(plan.approach, MAX_APPROACH),
    questions,
    clarifications,
    sources: lines(plan.sources, MAX_SOURCE_KINDS, 80),
    queries: lines(plan.queries, PLANNED_QUERY_LIMIT, MAX_QUERY_CHARS, 8),
    scope: { breadth, freshness, primarySources: scopeRaw.primarySources === true, quick: scopeRaw.quick === true },
    language: oneLine(plan.language, 35),
  };
}

/** The model call the planner is given: one completion, billed by the caller. */
export type PlannerCompletion = (request: {
  system: string;
  prompt: string;
  maxTokens: number;
  responseSchema: typeof RESEARCH_PLAN_SCHEMA;
  attempt: 1 | 2;
}) => Promise<{ text: string; costMicroUsd: number }>;

export type PlannerDraft =
  | { ok: true; output: PlannerOutput; costMicroUsd: number }
  | { ok: false; reason: "planner_invalid"; costMicroUsd: number };

/**
 * One call, and one retry that says what was wrong with the first (B5).
 * An aborted caller does not retry: nobody is waiting for the second answer.
 */
export async function draftResearchPlan(
  input: {
    goal: string;
    context?: string | null;
    constraints: string[];
    pinnedSources: string[];
    dateLine: string;
    languageName?: string | null;
    revision?: { questions: string[]; answers: Array<{ question: string; answer: string }> } | null;
    signal?: AbortSignal;
  },
  complete: PlannerCompletion
): Promise<PlannerDraft> {
  const system = plannerSystemPrompt({
    dateLine: input.dateLine,
    languageLine: input.languageName ? researchLanguageLine(input.languageName) : null,
    pinnedSources: input.pinnedSources,
    maxQueries: PLANNED_QUERY_LIMIT,
  });
  const request = [
    input.goal.trim(),
    input.constraints.length ? `Constraints the research must respect:\n${input.constraints.map((c) => `- ${c}`).join("\n")}` : "",
    input.context?.trim() ? input.context.trim() : "",
    input.revision ? plannerRevisionNote(input.revision.questions, input.revision.answers) : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, PLANNER_PROMPT_CHARS);

  const first = await complete({ system, prompt: request, maxTokens: PLANNER_OUTPUT_TOKENS, responseSchema: RESEARCH_PLAN_SCHEMA, attempt: 1 });
  let costMicroUsd = first.costMicroUsd;
  const parsed = parsePlannerOutput(first.text);
  if (parsed) return { ok: true, output: parsed, costMicroUsd };
  if (input.signal?.aborted) return { ok: false, reason: "planner_invalid", costMicroUsd };

  const second = await complete({
    system,
    prompt: `${request}\n\n${PLANNER_RETRY_NOTE}`,
    maxTokens: PLANNER_OUTPUT_TOKENS,
    responseSchema: RESEARCH_PLAN_SCHEMA,
    attempt: 2,
  });
  costMicroUsd += second.costMicroUsd;
  const retried = parsePlannerOutput(second.text);
  return retried ? { ok: true, output: retried, costMicroUsd } : { ok: false, reason: "planner_invalid", costMicroUsd };
}

/** What the planner's reply becomes on the stored plan. */
export interface PlannedResearch {
  title: string;
  approach: string;
  objectives: ResearchObjective[];
  queries: string[];
  clarifications: ResearchClarification[];
  sourceKinds: string[];
  scope: ResearchScope;
  language: string;
}

function evidenceFor(id: string, question: PlannerOutput["questions"][number]): EvidenceRequirement[] {
  return [
    {
      id: `${id}-evidence-1`,
      description: `Direct evidence answering: ${question.question}`,
      preferredSourceTypes: question.evidence.primary ? ["official", "primary"] : ["official", "primary", "reputable_secondary"],
      minimumIndependentSources: question.evidence.minSources,
      requiresPrimarySource: question.evidence.primary,
      ...(question.evidence.freshness ? { freshnessRule: question.evidence.freshness } : {}),
      status: "missing",
    },
  ].slice(0, MAX_EVIDENCE_REQUIREMENTS) as EvidenceRequirement[];
}

/**
 * The reply mapped onto the plan the engine stores. Question ids are the
 * objective ids the coverage matrix, the worker briefs and the card's edits
 * all key on; a revision keeps the reader's ids for the questions it kept.
 */
export function plannedResearch(output: PlannerOutput, opts: { keepIds?: Array<string | undefined> } = {}): PlannedResearch {
  const used = new Set<string>();
  const objectives: ResearchObjective[] = output.questions.map((question, index) => {
    const kept = opts.keepIds?.[index];
    let id = kept && !used.has(kept) ? kept : `objective-${index + 1}`;
    for (let n = index + 1; used.has(id); n += 1) id = `objective-${n + 1}`;
    used.add(id);
    return {
      id,
      question: question.question,
      ...(question.rationale ? { rationale: question.rationale } : {}),
      importance: Math.max(0.5, 1 - index * 0.1),
      status: "open",
      evidenceRequirements: evidenceFor(id, question),
      childObjectiveIds: [],
    };
  });
  // Every question is searched: its own words when the planner wrote no query
  // for it, which beats nothing and which the workers refine from there.
  const queries = [...output.queries];
  const seen = new Set(queries.map((query) => query.toLowerCase()));
  for (const objective of objectives) {
    if (queries.length >= MAX_PLAN_QUERIES) break;
    const own = objective.question.replace(/\?$/, "");
    if (!queries.some((query) => query.toLowerCase().includes(own.toLowerCase().slice(0, 24))) && !seen.has(own.toLowerCase())) {
      queries.push(own);
      seen.add(own.toLowerCase());
    }
  }
  return {
    title: output.title,
    approach: output.approach,
    objectives,
    queries: queries.slice(0, MAX_PLAN_QUERIES),
    clarifications: output.clarifications.map((c) => ({
      id: c.id,
      question: c.question,
      ...(c.options?.length ? { suggestions: c.options } : {}),
      skippable: true,
    })),
    sourceKinds: output.sources,
    scope: { ...output.scope, questions: objectives.length },
    language: output.language,
  };
}

/**
 * DECISIONS R2's tiny scope: one question, at most three minutes and nothing
 * to ask — the card would be a formality, so the run starts on its own.
 */
export function isTinyScope(scope: ResearchScope, estimate: ResearchEstimate, clarifications: number): boolean {
  return scope.questions === 1 && estimate.minutesUpTo <= 3 && clarifications === 0;
}

/**
 * The content language (D-1 option C): the explicit response-language
 * setting, else the language the question was asked in, else the UI locale.
 * Frozen per run; only the report and the prompts follow it.
 */
export function contentLanguage(input: { explicit?: string | null; planner?: string | null; uiLocale?: string | null }): string {
  for (const candidate of [input.explicit, input.planner, input.uiLocale]) {
    const tag = candidate?.trim();
    if (!tag || tag === "auto") continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(tag);
      if (canonical) return canonical;
    } catch {
      // Not a language tag; try the next source.
    }
  }
  return "en";
}

/** "French", for the prompts' language line. The tag itself when Intl cannot name it. */
export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * The date line, from the run's creation instant in the requester's zone
 * (else UTC), frozen as `plan.today` so a run resumed tomorrow still knows
 * the day its question was asked.
 */
export function todayLine(createdAt: Date, timeZone?: string | null): string {
  const zone = (() => {
    if (!timeZone) return "UTC";
    try {
      new Intl.DateTimeFormat("en", { timeZone });
      return timeZone;
    } catch {
      return "UTC";
    }
  })();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(createdAt);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return researchDateLine({ weekday: part("weekday"), day: part("day"), month: part("month"), year: part("year"), timeZone: zone });
}

/** One turn of the conversation before the research request. */
export interface ContextTurn {
  role: "USER" | "ASSISTANT";
  content: string;
}

const CONTEXT_TURNS = 6;
const CONTEXT_TURN_CHARS = 600;
const CONTEXT_TOTAL_CHARS = 4_000;

/**
 * `plan.context` (B20): the last six turns before the triggering message,
 * oldest first, each as `User:` / `Assistant:` and its first 600 characters,
 * at most 4,000 in all, wrapped as untrusted reference. The goal itself stays
 * the user's own words; the clarification wrapper never reaches here.
 */
export function researchGoalContext(turns: readonly ContextTurn[]): string | null {
  const recent = turns.filter((turn) => turn.content.trim()).slice(-CONTEXT_TURNS);
  if (recent.length === 0) return null;
  const rendered: string[] = [];
  let total = 0;
  // Newest first while budgeting, so the turns nearest the request survive the cap.
  for (const turn of [...recent].reverse()) {
    const line = `${turn.role === "USER" ? "User" : "Assistant"}: ${turn.content.replace(/\s+/g, " ").trim().slice(0, CONTEXT_TURN_CHARS)}`;
    if (total + line.length > CONTEXT_TOTAL_CHARS) break;
    rendered.unshift(line);
    total += line.length + 1;
  }
  return rendered.length ? wrapUntrusted(CONVERSATION_CONTEXT_LABEL, rendered.join("\n")) : null;
}

/**
 * The reader's edits at the gate, as the planner is told them: the questions
 * in their order, and each answer beside the question it answers.
 */
export function revisionForPlanner(
  revision: ResearchPlanRevision,
  asked: ResearchClarification[]
): { questions: string[]; answers: Array<{ question: string; answer: string }> } {
  const byId = new Map(asked.map((c) => [c.id, c.question]));
  return {
    questions: (revision.questions ?? []).map((q) => q.question),
    answers: Object.entries(revision.answers ?? {})
      .filter(([id, answer]) => byId.has(id) && answer.trim())
      .map(([id, answer]) => ({ question: byId.get(id)!, answer })),
  };
}

/**
 * A typed reply that confirms the pending scope card (DECISIONS R3, §9.6.1).
 * Anchored at both ends: "yes, but only EU sources" is a new instruction, not
 * a confirmation, and goes to the chat as a normal turn.
 */
export const TYPED_CONFIRMATION = /^\s*(yes|start|go( ahead)?|ok(ay)?|sure|do it|oui|ja|sí|si)\s*[.!]?\s*$/i;

/** How long a card waits for a typed "yes" to mean it. */
export const TYPED_CONFIRMATION_WINDOW_MS = 30 * 60_000;

/**
 * Whether a typed message confirms the pending card: the newest run waits at
 * the gate, entered it less than 30 minutes ago, nothing else was said since
 * the planning turn, and the message is a bare yes (§9.6.1).
 */
export function typedConfirmationApplies(input: {
  text: string;
  run: { state: string; draftedAt: string | null } | null;
  /** User messages sent after the one that started the run, not counting this one. */
  userMessagesSince: number;
  now: Date;
}): boolean {
  if (!input.run || input.run.state !== "awaiting_plan_confirmation") return false;
  const drafted = input.run.draftedAt ? Date.parse(input.run.draftedAt) : NaN;
  if (!Number.isFinite(drafted) || input.now.getTime() - drafted >= TYPED_CONFIRMATION_WINDOW_MS) return false;
  if (input.userMessagesSince > 0) return false;
  return TYPED_CONFIRMATION.test(input.text);
}
