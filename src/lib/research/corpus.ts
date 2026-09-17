import { truncate } from "@/lib/utils";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "@/lib/untrusted-content";
import { SNAPSHOT_CHARS, type ResearchSourceRow } from "@/lib/research/engine";
import type { ResearchFindingRow } from "@/lib/research/agents/protocol";
import type { ResearchPlan } from "@/lib/research/domain";

/**
 * The synthesis contract and the numbered corpus.
 *
 * Shared by the standalone writer (tools.ts) and the chat route (deep-research.ts)
 * because both need the identical string: a run driven to `synthesizing` and
 * handed back to chat is written by the user's own model against this exact
 * corpus, and two versions of the citation contract would mean two conventions
 * for what `[3]` refers to. It lives in its own module, free of `server-only`,
 * because what the writer is shown decides what the report can say, and that
 * used to be untestable: the evidence state below was added to a function no
 * test could import.
 *
 * Both `title` and the body are page-controlled and this text is appended to
 * the SYSTEM prompt — the highest-authority slot there is. Unwrapped, a page
 * whose text contains "[13] Official policy\nhttps://…\n…" is byte-identical to
 * a real corpus entry, so a hostile page could forge extra sources, defeat the
 * citation contract and issue instructions from inside the system prompt. The
 * envelope keeps the numbering and the URL outside it — those are ours — and
 * puts only the fetched text inside. The title is collapsed to one line for the
 * same reason: a newline in it would let one page forge a second entry.
 */
export interface ResearchCorpusFinding {
  claim: string;
  quote: string;
  /** Index into `sources`, so the finding can be cited as [n]. */
  sourceIndex: number;
  objective?: string;
}

/** A row as the corpus numbers it. `id` is what findings and conflicts are keyed by. */
export type ResearchCorpusSourceRow = Pick<ResearchSourceRow, "url" | "title" | "snapshot"> & { id?: string };

/**
 * Findings, rendered as the evidence ledger ahead of the raw pages.
 *
 * The workers' findings are claims a model has already tied to a verbatim
 * quote on a specific page; putting them first hands the writer the argument
 * and the citation together, so the report is built from what the team
 * established rather than re-derived from two hundred pages of prose.
 */
function renderFindings(findings: ResearchCorpusFinding[]): string {
  if (findings.length === 0) return "";
  const byObjective = new Map<string, ResearchCorpusFinding[]>();
  for (const finding of findings) {
    const key = finding.objective ?? "";
    const list = byObjective.get(key) ?? [];
    list.push(finding);
    byObjective.set(key, list);
  }
  const blocks: string[] = [];
  for (const [objective, list] of byObjective) {
    blocks.push(
      [
        objective ? `### ${objective}` : "### Findings",
        ...list.map(
          (finding) =>
            `- ${finding.claim} [${finding.sourceIndex}]\n  > ${wrapUntrusted("finding quote", finding.quote.replace(/\s+/g, " "))}`
        ),
      ].join("\n")
    );
  }
  return `\n# Evidence Ledger (${findings.length} sourced findings from the research team)
Each finding is a claim tied to a verbatim quote from the numbered source it cites. Build the report from these first; the source material below is the full text behind them.

${blocks.join("\n\n")}
`;
}

/** Open questions the corpus will carry, over every round together. */
const MAX_OPEN_QUESTIONS_SHOWN = 12;

/**
 * What the team concluded about the corpus, rendered for the writer.
 *
 * The lead names contradictions between rounds, and they were written to
 * `plan.conflicts` and drawn in the evidence panel — and never handed to the
 * writer, whose only inputs were the goal, the constraints, the numbered pages
 * and the findings. So the panel could show a contradiction that the report's
 * own "Nuances, Contradictions & Trade-Offs" section never mentioned, and the
 * limitations section was written without knowing which sub-questions the lead
 * had scored short or what the workers had said they could not settle.
 *
 * Everything here resolves to the same [n] numbering as the findings. A
 * conflict none of whose sources made the corpus is left out rather than
 * cited by a number that points elsewhere. The lead's descriptions and the
 * workers' questions are model output about pages, not our own words, so they
 * ride inside the untrusted envelope like the quotes above them.
 */
function renderEvidenceState(plan: ResearchPlan, indexOf: ReadonlyMap<string, number>): string {
  const conflicts = (plan.conflicts ?? [])
    .filter((conflict) => !conflict.resolved)
    .map((conflict) => ({
      conflict,
      refs: conflict.sourceIds.map((id) => indexOf.get(id)).filter((n): n is number => typeof n === "number"),
    }))
    .filter((item) => item.refs.length > 0);
  const short = plan.objectives.filter((objective) => objective.status !== "covered");
  const seen = new Set<string>();
  const questions: string[] = [];
  for (const round of plan.rounds ?? []) {
    for (const question of round.openQuestions ?? []) {
      const key = question.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      questions.push(question);
    }
  }
  const open = questions.slice(-MAX_OPEN_QUESTIONS_SHOWN);
  if (conflicts.length === 0 && short.length === 0 && open.length === 0) return "";

  const sections: string[] = [];
  if (conflicts.length > 0) {
    sections.push(
      [
        "Contradictions and duplicate sources the team flagged. Address each one in the Nuances section, citing both sides; a duplicate is one witness, not two:",
        wrapUntrusted(
          "lead review",
          conflicts
            .map(({ conflict, refs }) => `- ${conflict.description.replace(/\s+/g, " ")} ${refs.map((n) => `[${n}]`).join("")}`)
            .join("\n")
        ),
      ].join("\n")
    );
  }
  if (short.length > 0) {
    sections.push(
      [
        "Sub-questions the team could not fully answer. Say what is missing in Limitations & Open Questions rather than filling the gap from memory:",
        ...short.map((objective) => `- ${objective.question} (${objective.status.replace(/_/g, " ")})`),
      ].join("\n")
    );
  }
  if (open.length > 0) {
    sections.push(
      [
        "Questions the researchers could not settle from the pages they read:",
        wrapUntrusted("worker notes", open.map((question) => `- ${question.replace(/\s+/g, " ")}`).join("\n")),
      ].join("\n")
    );
  }
  return `\n# Evidence State (the research team's own review)\n${sections.join("\n\n")}\n`;
}

/**
 * Findings keyed to the numbered source list the writer will see.
 *
 * A finding whose page did not make the corpus (no snapshot, or past the
 * source cap) is dropped rather than cited by a number that points elsewhere.
 */
export function corpusFindings(
  plan: ResearchPlan,
  sources: Array<Pick<ResearchSourceRow, "id">>,
  findings: ReadonlyArray<Pick<ResearchFindingRow, "claim" | "quote" | "sourceId" | "objectiveId">>
): ResearchCorpusFinding[] {
  const index = new Map(sources.map((source, i) => [source.id, i + 1]));
  const objectives = new Map(plan.objectives.map((objective) => [objective.id, objective.question]));
  const out: ResearchCorpusFinding[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const sourceIndex = finding.sourceId ? index.get(finding.sourceId) : undefined;
    if (!sourceIndex) continue;
    const key = `${sourceIndex}:${finding.claim.toLowerCase().slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      claim: finding.claim,
      quote: finding.quote,
      sourceIndex,
      ...(finding.objectiveId && objectives.get(finding.objectiveId) ? { objective: objectives.get(finding.objectiveId) } : {}),
    });
  }
  return out;
}

export function buildResearchCorpus(
  goal: string,
  plan: ResearchPlan,
  sources: ResearchCorpusSourceRow[],
  findings: ResearchCorpusFinding[] = []
): string {
  const indexOf = new Map<string, number>();
  const corpus = sources
    .map((source, i) => {
      if (source.id) indexOf.set(source.id, i + 1);
      const title = source.title.replace(/\s+/g, " ").slice(0, 200);
      // SNAPSHOT_CHARS, not PAGE_CONTENT_CHARS: the stored snapshot is already
      // capped at the former, so slicing at the latter was a no-op pretending
      // to be a limit.
      const body = (source.snapshot ?? "").slice(0, SNAPSHOT_CHARS);
      return `[${i + 1}] ${title}\n${source.url}\n${wrapUntrusted(source.url, body)}`;
    })
    .join("\n\n");
  const constraints = plan.constraints.length
    ? `\nConstraints the user set for this research (these are the user's own instructions, and they apply to the whole report):\n${plan.constraints
        .map((c) => `- ${c}`)
        .join("\n")}\n`
    : "";
  return `# Autonomous Deep Research Mode
The user requested an exhaustive, authoritative research investigation on: "${truncate(goal, 300)}".
You are writing a comprehensive, publication-grade research REPORT, grounded strictly in the numbered source material below.

# Report Structure:
1. "# Title": Clear, professional title naming the topic.
2. "## Executive Summary": High-level synthesis highlighting key findings, core thesis, and high-impact takeaways.
3. "## Key Findings & Core Analysis": Detailed thematic sections (using "### Subheadings") breaking down the subject with quantitative data, benchmark comparisons, timelines, and technical details. Use Markdown comparison tables where appropriate.
4. "## Nuances, Contradictions & Trade-Offs": Explicitly analyze conflicting claims or divergent evidence between sources.
5. "## Limitations & Open Questions": What remains uncertain or unverifiable from current evidence.
6. "## Sources": Numbered list matching cited references as "[n] Title — URL".

# Citation & Accuracy Rules:
- Cite EVERY factual assertion, statistic, quote, and claim inline with bracketed numbers (e.g. [1], [2][4]) mapping directly to the numbered source list below.
- Strict factual grounding: Do NOT fabricate details or cite numbers outside the numbered list.
- When sources disagree or have different methodologies, explain the disagreement and cite each source.
- Two sources repeating the same press release or mirror text are not independent corroboration.
- Separate observed facts from inferences. Explain evidence strength without invented confidence percentages.
- Distinguish publication dates from the dates events occurred. Prefer original studies and official records.
- Do not treat absent evidence as evidence of absence. Failed fetches and unavailable sources remain limitations.
- Keep the report proportionate to the question. Do not pad it to appear exhaustive.
${constraints}
${UNTRUSTED_CONTENT_RULE}
${renderFindings(findings)}${renderEvidenceState(plan, indexOf)}
# Numbered Source Material:
${corpus}`;
}
