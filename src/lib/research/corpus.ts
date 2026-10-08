import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "@/lib/untrusted-content";
import { SNAPSHOT_CHARS, type ResearchSourceRow } from "@/lib/research/engine";
import type { ResearchFindingRow } from "@/lib/research/agents/protocol";
import type { ResearchPlan } from "@/lib/research/domain";
import {
  CITATION_RULES,
  CONFLICTS_INTRO,
  EVIDENCE_LEDGER_HEADER,
  EVIDENCE_STATE_HEADER,
  GAP_AUDIT_INTRO,
  OPEN_QUESTIONS_INTRO,
  SHORT_OBJECTIVES_INTRO,
  SOURCE_MATERIAL_HEADER,
  chatReportContract,
  constraintsBlock,
  reportWriterContract,
} from "@/lib/research/corpus.prompt";
import { renderGapAudit } from "@/lib/research/gap-audit";
import { assessSource, type SourceTier } from "@/lib/research/source-policy";
import { hostOfUrl } from "@/lib/research/claim-analysis";
import { privateSourceMetaLine } from "@/lib/research/private-sources";

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
export type ResearchCorpusSourceRow = Pick<ResearchSourceRow, "url" | "title" | "snapshot"> & {
  id?: string;
  publishedAt?: Date | null;
};

const TIER_NAME: Record<SourceTier, string> = {
  primary: "primary record",
  official: "official",
  reputable: "trade press",
  general: "secondary",
  community: "community report",
  aggregator: "aggregator/affiliate — do not cite for figures a primary record states",
};

/**
 * One line of OUR metadata above each source (protocol Stages 2 and 5): its
 * kind under the source policy, its domain and its date. Outside the
 * untrusted envelope because we computed it; it is what lets the writer
 * prefer the record over the roundup and fill the traceability table.
 */
export function sourceMetaLine(source: Pick<ResearchCorpusSourceRow, "url" | "title" | "snapshot" | "publishedAt">): string {
  // The person's own record: no domain to rank, and the writer must mark what it supports.
  const own = privateSourceMetaLine(source.url, source.publishedAt);
  if (own) return own;
  const tier = assessSource({ url: source.url, title: source.title, text: source.snapshot }).tier;
  const date = source.publishedAt instanceof Date && Number.isFinite(source.publishedAt.getTime())
    ? `published ${source.publishedAt.toISOString().slice(0, 10)}`
    : "undated";
  return `(${TIER_NAME[tier]} · ${hostOfUrl(source.url) || "unknown domain"} · ${date})`;
}

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
  return `\n${EVIDENCE_LEDGER_HEADER(findings.length)}

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
  const questionOf = (id: string) => plan.objectives.find((objective) => objective.id === id)?.question ?? id;
  const audit = plan.gapAudit ? renderGapAudit(plan.gapAudit.entries, questionOf) : [];
  if (conflicts.length === 0 && short.length === 0 && open.length === 0 && audit.length === 0) return "";

  const sections: string[] = [];
  if (conflicts.length > 0) {
    sections.push(
      [
        CONFLICTS_INTRO,
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
        SHORT_OBJECTIVES_INTRO,
        ...short.map((objective) => `- ${objective.question} (${objective.status.replace(/_/g, " ")})`),
      ].join("\n")
    );
  }
  if (audit.length > 0) {
    // The audit quotes finding claims, which are model output about pages.
    sections.push([GAP_AUDIT_INTRO, wrapUntrusted("gap audit", audit.join("\n"))].join("\n"));
  }
  if (open.length > 0) {
    sections.push(
      [
        OPEN_QUESTIONS_INTRO,
        wrapUntrusted("worker notes", open.map((question) => `- ${question.replace(/\s+/g, " ")}`).join("\n")),
      ].join("\n")
    );
  }
  return `\n${EVIDENCE_STATE_HEADER}\n${sections.join("\n\n")}\n`;
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

/**
 * The plan's vectors with the figures each had to produce and the claims each
 * had to verify (protocol Stage 1), so the deep dives and the comparative
 * matrix are written against the same contract the workers were sent with.
 * Planner output, not page content — but the planner read the user's goal and
 * conversation, so it rides in the envelope all the same.
 */
function renderVectors(plan: ResearchPlan): string {
  const lines = plan.objectives
    .filter((objective) => objective.vector)
    .map((objective) => {
      const vector = objective.vector!;
      return [
        `- ${objective.question}`,
        vector.metrics.length ? `  figures: ${vector.metrics.join("; ")}` : "",
        vector.verify.length ? `  verify: ${vector.verify.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    });
  return lines.length
    ? `\n# Investigative Vectors (the figures each vector had to establish; say plainly which the evidence does not give)\n${wrapUntrusted("research plan", lines.join("\n"))}\n`
    : "";
}

export interface ResearchCorpusOptions {
  /**
   * `chat` (default): the native in-chat contract, where the user's own model
   * writes the report (INV-11). `report`: the web writer's structured contract
   * — summary, markers, one section per question, no sources list (§9.6.3).
   */
  contract?: "chat" | "report";
  /** The run's date line, for the report contract (§9.3). */
  dateLine?: string | null;
  /** "Write in {language}." for the report contract (§9.5). */
  languageLine?: string | null;
}

export function buildResearchCorpus(
  goal: string,
  plan: ResearchPlan,
  sources: ResearchCorpusSourceRow[],
  findings: ResearchCorpusFinding[] = [],
  options: ResearchCorpusOptions = {}
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
      return `[${i + 1}] ${title}\n${source.url}\n${sourceMetaLine(source)}\n${wrapUntrusted(source.url, body)}`;
    })
    .join("\n\n");
  const header =
    options.contract === "report"
      ? reportWriterContract({
          goal,
          questions: plan.objectives.map((objective) => ({ id: objective.id, question: objective.question })),
          dateLine: options.dateLine ?? plan.today ?? null,
          languageLine: options.languageLine ?? null,
        })
      : chatReportContract(goal);
  return `${header}

${CITATION_RULES}
${constraintsBlock(plan.constraints)}
${UNTRUSTED_CONTENT_RULE}
${renderVectors(plan)}${renderFindings(findings)}${renderEvidenceState(plan, indexOf)}
${SOURCE_MATERIAL_HEADER}
${corpus}`;
}
