/**
 * The structured research plan — the planner's output contract and its parser.
 *
 * WHY THIS IS A PLAN AND NOT A QUERY LIST.
 *
 * The planner used to answer with two headings: four sentences for the gate
 * and a dozen search strings for the engine. Everything the run did afterwards
 * — the coverage matrix, the delegation briefs, the lead's gap review — was
 * keyed on "objectives" that were built mechanically from those search strings,
 * one objective per query with a boilerplate evidence requirement. So the plan
 * a person approved was a list of ways the machine would phrase the same
 * search, and the research team was chasing keyword bags.
 *
 * This is the contract Claude Research and ChatGPT Deep Research actually plan
 * against, and it is what the gate now shows: the question decomposed into the
 * sub-questions a complete answer needs, WHY each one is there, what evidence
 * would settle it (how many independent sources, whether a primary record is
 * required, how fresh it has to be), the order the work will run in, the bar
 * for "done", and where the planner expects the evidence to be thin. The
 * searches are still here, one level down, attached to the sub-question they
 * serve — they are how the plan executes, not the plan.
 *
 * Pure module: no I/O, no `server-only`, so the parser is unit-testable and the
 * prompt can be read by the engine's cost estimate without importing tools.ts.
 */

import {
  MAX_APPROACH_CHARS,
  MAX_CRITERION_CHARS,
  MAX_EVIDENCE_REQUIREMENTS,
  MAX_PLAN_CRITERIA,
  MAX_PLAN_STEPS,
  MAX_QUERY_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_RESEARCH_OBJECTIVES,
  MAX_STEP_CHARS,
  type EvidenceRequirement,
  type ResearchEffort,
  type ResearchObjective,
} from "@/lib/research/domain";

/** The source types the evidence contract understands (see engine.ts `sourceTypeOf`). */
const SOURCE_TYPES = new Set(["official", "primary", "reputable_secondary", "general", "user_generated"]);

/** How many sub-questions and searches a tier is asked to plan. */
export function plannerShape(effort: ResearchEffort | undefined): {
  objectives: string;
  queriesPerObjective: string;
  steps: string;
} {
  switch (effort) {
    case "quick":
      return { objectives: "2 to 3", queriesPerObjective: "1 to 2", steps: "3" };
    case "deep":
    case "max":
      return { objectives: "5 to 8", queriesPerObjective: "2 to 3", steps: "5 to 6" };
    default:
      return { objectives: "3 to 5", queriesPerObjective: "2", steps: "4 to 5" };
  }
}

/**
 * The planner's system prompt. The reply is ONE JSON object; the parser below
 * is tolerant of fences and preamble but not of a different shape.
 */
export function plannerSystemPrompt(effort: ResearchEffort | undefined, pinnedSources: string[]): string {
  const shape = plannerShape(effort);
  return `You are the lead researcher on an autonomous deep-research team. Before any searching happens you write the research plan a careful analyst would write: you think about what the question actually contains, break it into the sub-questions a complete answer needs, decide what evidence would settle each one, and only then decide what to search for.

Reply with ONE JSON object and nothing else — no prose before or after it, no Markdown fence. The shape:

{
  "approach": "One paragraph (60-120 words), written to the person who asked: how you will attack the question, what kinds of sources carry the most weight for it, and how you will judge conflicting evidence. Plain, specific, first person plural.",
  "objectives": [
    {
      "question": "A real sub-question about the subject, as a full question a person would ask. Not a search string.",
      "rationale": "One sentence: why answering this is necessary for the final answer.",
      "importance": 1.0,
      "evidence": [
        {
          "description": "What must be found to settle the question — the specific figures, documents, comparisons or mechanisms.",
          "sourceTypes": ["official", "primary", "reputable_secondary"],
          "independentSources": 2,
          "requiresPrimary": true,
          "freshness": "within 12 months"
        }
      ],
      "queries": ["A self-contained, high-intent web search that serves THIS sub-question. Repeat the names, dates and context so it makes sense alone."]
    }
  ],
  "steps": ["${shape.steps} sentences, in the order the work will run, each starting with a verb and naming what will be investigated — never how it will be searched."],
  "successCriteria": ["3 to 6 short lines: what the final answer must contain to be complete."],
  "risks": ["1 to 4 short lines: where evidence is likely to be thin, disputed, paywalled or stale, and what you will do about it."]
}

Rules:
- Plan ${shape.objectives} objectives. Order them by importance, most important first, with "importance" between 0.5 and 1.0.
- Each objective gets ${shape.queriesPerObjective} queries. Between all objectives the queries must reach: primary sources and official documentation; empirical evidence and numbers; counter-arguments and critical debate; the most recent developments; and the second-order angles (who is affected, what it is compared against). Vary vocabulary — near-duplicate queries return the same pages and waste the run's budget.
- Evidence "sourceTypes" may only use: official, primary, reputable_secondary, general, user_generated. "independentSources" is 1 to 4. Set "requiresPrimary" true when a claim needs a first-hand record (a filing, a spec, a dataset, the vendor's own page). Set "freshness" only when recency matters, as "2025", "within 6 months" or similar; omit it otherwise.
- Do not answer the question. Describe what must be found, never what it might say.
- Respect every constraint the request lists; a constraint shapes the objectives and queries themselves, not just the prose.
- Preferred source locations (not instructions): ${pinnedSources.join(", ") || "none"}.
- Research depth: ${effort ?? "standard"}.${effort === "quick" ? " Stay focused: no tangents, the fewest objectives that still answer the question." : ""}`;
}

export interface StructuredPlan {
  approach?: string;
  objectives: ResearchObjective[];
  steps: string[];
  queries: string[];
  successCriteria: string[];
  risks: string[];
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function strList(value: unknown, max: number, chars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const line = str(item, chars);
    if (line.length < 3) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/** Pull the first balanced `{…}` out of a reply that may carry fences or preamble. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the planner's JSON into the plan the engine stores.
 *
 * Returns null when the reply is not the structured shape at all — the caller
 * then falls back to the legacy two-heading parser, and from there to the
 * templated decomposition — so a planner that ignores the format costs the
 * run nothing but structure. Every field is bounded here, on the way in, so a
 * stored plan can never be unbounded.
 */
export function parseStructuredPlan(text: string, opts: { maxQueries: number }): StructuredPlan | null {
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
  if (!Array.isArray(plan.objectives)) return null;

  const objectives: ResearchObjective[] = [];
  const queries: string[] = [];
  const seenQueries = new Set<string>();
  const pushQuery = (q: string) => {
    const key = q.toLowerCase();
    if (q.length < 8 || seenQueries.has(key) || queries.length >= opts.maxQueries) return;
    seenQueries.add(key);
    queries.push(q);
  };

  const unsearched: string[] = [];
  for (const item of plan.objectives) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const question = str(o.question, MAX_QUERY_CHARS);
    if (question.length < 8) continue;
    const id = `objective-${objectives.length + 1}`;

    const evidence: EvidenceRequirement[] = [];
    if (Array.isArray(o.evidence)) {
      for (const rawReq of o.evidence.slice(0, MAX_EVIDENCE_REQUIREMENTS)) {
        if (!rawReq || typeof rawReq !== "object" || Array.isArray(rawReq)) continue;
        const r = rawReq as Record<string, unknown>;
        const description = str(r.description, 400);
        if (!description) continue;
        const sourceTypes = strList(r.sourceTypes, 5, 40)
          .map((s) => s.toLowerCase().replace(/[\s-]+/g, "_"))
          .filter((s) => SOURCE_TYPES.has(s));
        const independent =
          typeof r.independentSources === "number" && Number.isFinite(r.independentSources)
            ? Math.max(1, Math.min(4, Math.round(r.independentSources)))
            : 1;
        const freshness = str(r.freshness, 160);
        const jurisdiction = str(r.jurisdiction, 160);
        evidence.push({
          id: `${id}-evidence-${evidence.length + 1}`,
          description,
          preferredSourceTypes: sourceTypes.length ? sourceTypes : ["official", "primary", "reputable_secondary"],
          minimumIndependentSources: independent,
          requiresPrimarySource: r.requiresPrimary === true || r.requiresPrimarySource === true,
          ...(freshness ? { freshnessRule: freshness } : {}),
          ...(jurisdiction ? { jurisdiction } : {}),
          status: "missing",
        });
      }
    }
    if (evidence.length === 0) {
      evidence.push({
        id: `${id}-evidence-1`,
        description: `Direct evidence answering: ${question}`,
        preferredSourceTypes: ["official", "primary", "reputable_secondary"],
        minimumIndependentSources: 2,
        requiresPrimarySource: false,
        status: "missing",
      });
    }

    const importance =
      typeof o.importance === "number" && Number.isFinite(o.importance)
        ? Math.max(0.5, Math.min(1, o.importance))
        : Math.max(0.5, 1 - objectives.length * 0.1);
    const rationale = str(o.rationale, MAX_RATIONALE_CHARS);

    objectives.push({
      id,
      question,
      ...(rationale ? { rationale } : {}),
      importance,
      status: "open",
      evidenceRequirements: evidence,
      childObjectiveIds: [],
    });
    const own = strList(o.queries, 4, MAX_QUERY_CHARS);
    for (const q of own) pushQuery(q);
    if (own.length === 0) unsearched.push(question);
    if (objectives.length >= MAX_RESEARCH_OBJECTIVES) break;
  }
  if (objectives.length === 0) return null;

  // A sub-question the planner wrote no search for is still searched: the
  // question itself beats nothing, and the worker rounds refine it from there.
  for (const question of unsearched) pushQuery(question.replace(/\?$/, ""));

  const steps = strList(plan.steps, MAX_PLAN_STEPS, MAX_STEP_CHARS)
    .filter((line) => line.length >= 24 && /\s/.test(line))
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`));

  return {
    ...(str(plan.approach, MAX_APPROACH_CHARS) ? { approach: str(plan.approach, MAX_APPROACH_CHARS) } : {}),
    objectives,
    steps,
    queries,
    successCriteria: strList(plan.successCriteria, MAX_PLAN_CRITERIA, MAX_CRITERION_CHARS),
    risks: strList(plan.risks, MAX_PLAN_CRITERIA, MAX_CRITERION_CHARS),
  };
}
