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
  type ResearchVector,
  MAX_VECTOR_ITEMS,
  MAX_VECTOR_ITEM_CHARS,
} from "@/lib/research/domain";
import { contentTokens } from "@/lib/research/claim-analysis";
import { dedupeQueries, queryTokens, restatesGoal, subjectOf } from "@/lib/research/query-dedupe";
import { extractJsonObject } from "@/lib/research/plan-format";
import {
  CONVERSATION_CONTEXT_LABEL,
  PLANNER_RETRY_NOTE,
  RESEARCH_PLAN_SCHEMA,
  plannerProtocolRetryNote,
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
    /** The vector's metrics, primary sources and claims to verify (protocol Stage 1). */
    vector?: ResearchVector;
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
 * A reply cut off before its last brace, closed back into JSON (F1).
 *
 * The usual way a plan fails is not a wrong answer but a short one: a
 * thinking model spends the shared output budget and the object stops
 * mid-string. Every value that FINISHED is still good, so the text is cut
 * back to the last complete value (a comma outside a string, at whatever
 * depth) and the open arrays and objects are closed. Null when nothing
 * complete is left. Never invents a value: a cut only ever removes.
 */
export function repairTruncatedJson(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const body = text.slice(start);
  const stack: string[] = [];
  const cuts: Array<{ at: number; closers: string }> = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) return body.slice(0, i + 1);
    } else if (ch === ",") cuts.push({ at: i, closers: [...stack].reverse().join("") });
  }
  const attempts = [
    // The whole tail, when the cut fell between values. Never when it fell
    // inside a string: "Where do f" is not a question anybody asked.
    ...(stack.length && !inString ? [`${body}${[...stack].reverse().join("")}`] : []),
    ...cuts.reverse().slice(0, 64).map((cut) => `${body.slice(0, cut.at)}${cut.closers}`),
  ];
  for (const candidate of attempts) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Cut further back.
    }
  }
  return null;
}

const BREADTHS: Record<string, PlannerOutput["scope"]["breadth"]> = {
  focused: "focused", narrow: "focused", small: "focused", quick: "focused",
  broad: "broad", medium: "broad", moderate: "broad", standard: "broad", wide: "broad",
  exhaustive: "exhaustive", deep: "exhaustive", comprehensive: "exhaustive", survey: "exhaustive",
};
const FRESHNESS: Record<string, PlannerOutput["scope"]["freshness"]> = {
  any: "any", none: "any", timeless: "any",
  recent: "recent", current: "recent", month: "recent",
  live: "live", realtime: "live", "real-time": "live", daily: "live",
};

function questionText(item: unknown): string {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  const q = item as Record<string, unknown>;
  for (const key of ["question", "text", "q", "title"]) if (typeof q[key] === "string") return q[key] as string;
  return "";
}

/** The object that carries the plan: the reply itself, a bare question list, or one wrapper level down. */
function planObject(raw: unknown): Record<string, unknown> | null {
  if (Array.isArray(raw)) return { questions: raw };
  if (!raw || typeof raw !== "object") return null;
  const plan = raw as Record<string, unknown>;
  if (Array.isArray(plan.questions)) return plan;
  for (const value of Object.values(plan)) {
    if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).questions)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * The reply, validated, or null.
 *
 * Strict about substance — a reply with no real question is not a plan, and
 * nothing JSON-looking is ever read as lines (B5) — and forgiving about
 * shape (F1): a reply cut off mid-object keeps its complete questions, a
 * question written as a bare string is a question, and a scope this build
 * does not know is read by its nearest meaning or derived from the question
 * count. Every string and list is bounded on the way in, so a verbose model
 * costs the plan detail, never its validity.
 */
export function parsePlannerOutput(text: string): PlannerOutput | null {
  // A bare list of questions is the one reply that opens with a bracket.
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const attempts = [extractJsonObject(text), /^\s*\[/.test(unfenced) ? unfenced : null, repairTruncatedJson(text)];
  let raw: unknown;
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      raw = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (planObject(raw)) break;
    raw = undefined;
  }
  const plan = planObject(raw);
  if (!plan) return null;

  const questions: PlannerOutput["questions"] = [];
  const seen = new Set<string>();
  for (const item of plan.questions as unknown[]) {
    const question = oneLine(questionText(item), MAX_QUERY_CHARS);
    if (question.length < 8 || seen.has(question.toLowerCase())) continue;
    seen.add(question.toLowerCase());
    const q = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    const evidence = q.evidence && typeof q.evidence === "object" && !Array.isArray(q.evidence) ? (q.evidence as Record<string, unknown>) : {};
    const minSources =
      typeof evidence.minSources === "number" && Number.isFinite(evidence.minSources)
        ? Math.max(1, Math.min(4, Math.round(evidence.minSources)))
        : 2;
    const freshness = oneLine(evidence.freshness, 160);
    const vector: ResearchVector = {
      metrics: lines(q.metrics, MAX_VECTOR_ITEMS, MAX_VECTOR_ITEM_CHARS, 3),
      sources: lines(q.primarySources ?? q.sources, MAX_VECTOR_ITEMS, MAX_VECTOR_ITEM_CHARS, 3),
      verify: lines(q.verify, MAX_VECTOR_ITEMS, MAX_VECTOR_ITEM_CHARS, 3),
    };
    const hasVector = vector.metrics.length + vector.sources.length + vector.verify.length > 0;
    questions.push({
      question,
      rationale: oneLine(q.rationale, MAX_RATIONALE_CHARS),
      evidence: { minSources, primary: evidence.primary === true, ...(freshness ? { freshness } : {}) },
      ...(hasVector ? { vector } : {}),
    });
    if (questions.length >= MAX_RESEARCH_OBJECTIVES) break;
  }
  if (questions.length === 0) return null;

  const scopeRaw = plan.scope && typeof plan.scope === "object" && !Array.isArray(plan.scope) ? (plan.scope as Record<string, unknown>) : {};
  const word = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");
  const breadth = BREADTHS[word(scopeRaw.breadth)] ?? (questions.length <= 2 ? "focused" : "broad");
  const freshness = FRESHNESS[word(scopeRaw.freshness)] ?? "any";

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

/**
 * Where a parsed plan breaks the research protocol's Stage 1 (RULE 0.1: "do
 * not generate 3–4 semantic paraphrases of the prompt and stop"). Empty when
 * the plan is a real decomposition. Deterministic — token overlap with the
 * request, query near-duplicates, the vector count and whether any vector
 * names a concrete metric — so the one corrective retry it can trigger is
 * paid only for a plan that is measurably shallow.
 *
 * A request too short to decompose (fewer than three content words) and a
 * plan that calls itself `quick` are never judged: "what is the boiling point
 * of ethanol" is one fact, not five vectors.
 */
export function planShallowness(output: PlannerOutput, goal: string): string[] {
  if (output.scope.quick || queryTokens(goal).size < 3) return [];
  const reasons: string[] = [];
  if (output.questions.length < 4) {
    reasons.push(`Only ${output.questions.length} vector${output.questions.length === 1 ? "" : "s"}; plan 4 to 6 orthogonal ones.`);
  }
  const restating = output.questions.filter((q) => restatesGoal(q.question, goal));
  if (restating.length > 0 && restating.length * 2 >= output.questions.length) {
    reasons.push(`Vectors that restate the request instead of decomposing it: ${restating.map((q) => `"${q.question}"`).join("; ")}.`);
  }
  if (output.questions.every((q) => !q.vector?.metrics.length)) {
    reasons.push("No vector names a concrete metric (an exact figure, limit, date, version or term) to extract.");
  }
  if (output.queries.length > 0) {
    const paraphrases = output.queries.filter((query) => restatesGoal(query, goal));
    const distinct = dedupeQueries(output.queries);
    if (paraphrases.length * 2 >= output.queries.length) {
      reasons.push(`Queries that search the request itself: ${paraphrases.slice(0, 4).map((q) => `"${q}"`).join("; ")}.`);
    } else if (distinct.length * 3 < output.queries.length * 2) {
      reasons.push("Many queries are near-duplicates of each other and would return the same results.");
    }
  }
  return reasons;
}

/** The model call the planner is given: one completion, billed by the caller. */
export type PlannerCompletion = (request: {
  system: string;
  prompt: string;
  maxTokens: number;
  /** The schema on the first attempt; null on the retry, which asks for plain JSON (F3). */
  responseSchema: typeof RESEARCH_PLAN_SCHEMA | null;
  attempt: 1 | 2;
}) => Promise<{ text: string; costMicroUsd: number }>;

/**
 * Who drafted the plan: the planner model (`model`), the plain-text planner
 * that writes two lists instead of JSON (`lines`), or nobody — the question
 * as asked (`goal`). The scope card says so for the last two (F4).
 */
export type PlannedBy = "model" | "lines" | "goal";

export type PlannerDraft =
  | { ok: true; output: PlannerOutput; costMicroUsd: number; plannedBy?: PlannedBy }
  | { ok: false; reason: "planner_invalid"; costMicroUsd: number };

/** The planner's request text: the goal first, in the person's own words, then what bounds it. */
export function plannerRequest(input: {
  goal: string;
  context?: string | null;
  constraints: string[];
  revision?: { questions: string[]; answers: Array<{ question: string; answer: string }> } | null;
}): string {
  return [
    input.goal.trim(),
    input.constraints.length ? `Constraints the research must respect:\n${input.constraints.map((c) => `- ${c}`).join("\n")}` : "",
    input.context?.trim() ? input.context.trim() : "",
    input.revision ? plannerRevisionNote(input.revision.questions, input.revision.answers) : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, PLANNER_PROMPT_CHARS);
}

/**
 * One structured call, and one retry that changes what it asks (B5, F3): a
 * smaller plan, in plain JSON mode, because a provider whose structured mode
 * could not hold the schema will not hold it on being asked the same way
 * twice. An aborted caller does not retry: nobody is waiting for the answer.
 */
export async function draftResearchPlan(
  input: {
    goal: string;
    context?: string | null;
    constraints: string[];
    pinnedSources: string[];
    privateSources?: string[];
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
    privateSources: input.privateSources,
    maxQueries: PLANNED_QUERY_LIMIT,
  });
  const request = plannerRequest(input);

  const first = await complete({ system, prompt: request, maxTokens: PLANNER_OUTPUT_TOKENS, responseSchema: RESEARCH_PLAN_SCHEMA, attempt: 1 });
  let costMicroUsd = first.costMicroUsd;
  const parsed = parsePlannerOutput(first.text);
  if (parsed) {
    /*
     * A plan that parses but restates the request is the protocol's first
     * anti-pattern. It gets the same single retry an unparseable reply gets —
     * so the planner never makes more than two calls — told exactly which
     * rules it broke. The retried plan is kept only if it is less shallow;
     * otherwise the first one runs, and the deterministic query clean-up in
     * `plannedResearch` still strips its paraphrased searches.
     */
    const shallow = planShallowness(parsed, input.goal);
    if (shallow.length === 0 || input.signal?.aborted) return { ok: true, output: parsed, costMicroUsd, plannedBy: "model" };
    const again = await complete({
      system,
      prompt: `${request}\n\n${plannerProtocolRetryNote(shallow)}`,
      maxTokens: PLANNER_OUTPUT_TOKENS,
      responseSchema: RESEARCH_PLAN_SCHEMA,
      attempt: 2,
    });
    costMicroUsd += again.costMicroUsd;
    const better = parsePlannerOutput(again.text);
    const output = better && planShallowness(better, input.goal).length < shallow.length ? better : parsed;
    return { ok: true, output, costMicroUsd, plannedBy: "model" };
  }
  if (input.signal?.aborted) return { ok: false, reason: "planner_invalid", costMicroUsd };

  const second = await complete({
    system,
    prompt: `${request}\n\n${PLANNER_RETRY_NOTE}`,
    maxTokens: PLANNER_OUTPUT_TOKENS,
    responseSchema: null,
    attempt: 2,
  });
  costMicroUsd += second.costMicroUsd;
  const retried = parsePlannerOutput(second.text);
  return retried ? { ok: true, output: retried, costMicroUsd, plannedBy: "model" } : { ok: false, reason: "planner_invalid", costMicroUsd };
}

/** Bulleted or numbered lines under a heading, bounded. */
function listUnder(text: string, heading: RegExp, stop: RegExp): string[] {
  const out: string[] = [];
  let inside = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (heading.test(line)) {
      inside = true;
      continue;
    }
    if (inside && stop.test(line)) break;
    if (!inside || !line) continue;
    const item = line.replace(/^(?:[-*\u2022]|\d+[.)])\s*/, "").trim();
    if (item) out.push(item);
  }
  return out;
}

/**
 * The plain-text planner's reply (F4a): two headed lists, QUESTIONS and
 * SEARCHES, and nothing else. Null when there is no question in it, and —
 * B5 — when the reply is JSON-looking, which is never read as lines.
 */
export function planFromLines(text: string): PlannerOutput | null {
  if (!text.trim() || looksLikeJson(text)) return null;
  const questionsHeading = /^#{0,3}\s*\**\s*questions?\s*\**\s*:?\s*\**$/i;
  const searchesHeading = /^#{0,3}\s*\**\s*(searches|queries|search queries)\s*\**\s*:?\s*\**$/i;
  const questions = lines(listUnder(text, questionsHeading, searchesHeading), MAX_RESEARCH_OBJECTIVES, MAX_QUERY_CHARS, 8);
  if (questions.length === 0) return null;
  const queries = lines(listUnder(text, searchesHeading, questionsHeading), PLANNED_QUERY_LIMIT, MAX_QUERY_CHARS, 8);
  return {
    title: "",
    approach: "",
    questions: questions.map((question) => ({ question, rationale: "", evidence: { minSources: 2, primary: false } })),
    clarifications: [],
    sources: [],
    queries,
    scope: { breadth: questions.length <= 2 ? "focused" : "broad", freshness: "any", primarySources: false, quick: false },
    language: "",
  };
}

/**
 * The floor under every planner (F4b): the question as asked. Each question
 * sentence in the goal is one question (a goal of three questions is three
 * questions), searched in its own words; a goal with none is one question.
 * It names no evidence it has not been told about and asks nothing. The
 * person sees it at the scope card, marked as such, before anything is spent.
 */
export function goalFloorPlan(goal: string): PlannerOutput {
  const text = goal.replace(/\s+/g, " ").trim();
  const sentences = (text.match(/[^?!.]+\?/g) ?? []).map((s) => s.trim()).filter((s) => s.length >= 8);
  const asked = sentences.length >= 2 ? sentences.slice(0, 4) : [text.slice(0, MAX_QUERY_CHARS)];
  const questions = asked
    .map((question) => oneLine(question, MAX_QUERY_CHARS))
    .filter((question, i, all) => question.length >= 3 && all.findIndex((q) => q.toLowerCase() === question.toLowerCase()) === i);
  const safe = questions.length ? questions : [oneLine(text || "Research request", MAX_QUERY_CHARS)];
  return {
    title: oneLine(text.split(/(?<=[?!.])\s/)[0] ?? text, MAX_PLAN_TITLE_CHARS),
    approach: "",
    questions: safe.map((question) => ({ question, rationale: "", evidence: { minSources: 2, primary: false } })),
    clarifications: [],
    sources: [],
    // A search engine reads the first dozen words; a pasted paragraph is not a search.
    queries: safe.map((question) => question.replace(/\?$/, "").split(" ").slice(0, 16).join(" ")).filter((query) => query.length >= 3),
    scope: { breadth: safe.length <= 2 ? "focused" : "broad", freshness: "any", primarySources: false, quick: false },
    language: "",
  };
}

/**
 * A mapping search built from a vector itself (protocol Stage 2): the subject,
 * the primary record that holds the vector's figures, and its first metric —
 * "Acme API rate-limit documentation requests per minute". Used when the
 * planner wrote no usable query for a vector, in place of the old fallback
 * that searched the vector's own question (a paraphrase by construction).
 */
export function vectorQuery(subject: string, objective: Pick<ResearchObjective, "question" | "vector">): string {
  const vector = objective.vector;
  const parts = [subject, vector?.sources[0] ?? "", vector?.metrics[0] ?? ""].map((part) => part.trim()).filter(Boolean);
  const text = parts.length > 1 ? parts.join(" ") : objective.question.replace(/\?$/, "");
  return text.split(/\s+/).slice(0, 14).join(" ").slice(0, MAX_QUERY_CHARS);
}

/**
 * The plan's searches after the protocol's deterministic clean-up: queries
 * that restate the request are dropped (RULE 0.1), near-duplicates collapse
 * to one, and every vector the remaining list does not reach gets a query
 * built from its own primary source and metric. A plan whose every query was
 * a paraphrase therefore still searches — but for the records, not the prompt.
 */
function mappingQueries(output: PlannerOutput, objectives: ResearchObjective[], goal?: string): string[] {
  const fromPlanner = goal ? output.queries.filter((query) => !restatesGoal(query, goal)) : [...output.queries];
  const queries = dedupeQueries(fromPlanner);
  const subject = subjectOf(output.title || goal || "");
  for (const objective of objectives) {
    if (queries.length >= MAX_PLAN_QUERIES) break;
    let reached: boolean;
    if (objective.vector) {
      // A vector is reached when some query names its record or its figures:
      // two shared words with its metrics and primary sources.
      const own = contentTokens(`${objective.vector.metrics.join(" ")} ${objective.vector.sources.join(" ")}`);
      reached = queries.some((query) => {
        let shared = 0;
        for (const token of contentTokens(query)) if (own.has(token)) shared += 1;
        return shared >= 2;
      });
    } else {
      // A plan without vectors (the lines planner, an older reply) keeps the
      // rule it always had: the question's own opening words.
      const own = objective.question.replace(/\?$/, "").toLowerCase().slice(0, 24);
      reached = queries.some((query) => query.toLowerCase().includes(own));
    }
    if (reached) continue;
    const extra = objective.vector ? vectorQuery(subject, objective) : objective.question.replace(/\?$/, "");
    if (extra && dedupeQueries([extra], queries).length) queries.push(extra);
  }
  // A plan left with nothing (every query restated the goal and no vector
  // could build one) keeps the planner's own list rather than search nothing.
  return (queries.length ? queries : dedupeQueries(output.queries)).slice(0, MAX_PLAN_QUERIES);
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
export function plannedResearch(
  output: PlannerOutput,
  opts: { keepIds?: Array<string | undefined>; goal?: string } = {}
): PlannedResearch {
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
      ...(question.vector ? { vector: question.vector } : {}),
    };
  });
  const queries = mappingQueries(output, objectives, opts.goal);
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
