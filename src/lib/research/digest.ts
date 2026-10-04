/**
 * The evidence digest (RESEARCH_V2 F6): the report a run delivers when no
 * model could write one.
 *
 * A writer that comes back empty twice — a provider outage, a refusal, a
 * timeout on both models — used to end the run `writer_empty` and throw away
 * every finding the run had paid for. The workers have already done the
 * reading: each finding is a claim, a verbatim quote and the page it came
 * from. So the digest lays them out under the questions they answer, each
 * cited to the source's number in the same citable order the writer and the
 * audit use, says plainly that nothing was synthesised, and lists what stayed
 * open. It costs nothing, invents nothing, and goes through the same citation
 * audit as any report.
 *
 * Pure and server-free, so the engine tests drive it directly.
 */

import { corpusFindings } from "@/lib/research/corpus";
import type { ResearchPlan } from "@/lib/research/domain";
import type { ResearchFindingRow } from "@/lib/research/agents/protocol";

/** The run's recorded reason, shown on the cover. */
export const DIGEST_NOTICE =
  "The report could not be written, so this is the evidence the researchers gathered, question by question, with its sources.";

const DIGEST_COPY = {
  bottomLine: "Bottom line",
  lead: "The full report could not be written for this research, so this is what the sources established, in the researchers' notes, under the question each one answers. Nothing here is synthesised beyond those notes; every line names its source.",
  noFinding: "The researchers noted no finding for this question in the sources they read.",
  open: "What remains open",
  allAnswered: "Every question has at least one sourced finding above; how far they agree is for the reader to weigh.",
  sources: "Sources read",
} as const;

const MAX_FINDINGS_PER_QUESTION = 6;
const MAX_UNSORTED_FINDINGS = 8;
const MAX_LISTED_SOURCES = 24;

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);
/** A heading's text: no line breaks, no Markdown that would end the heading early. */
const headingText = (text: string) => oneLine(text, 200).replace(/^#+\s*/, "");

/**
 * The digest's Markdown, or null when the run has nothing to cite: no
 * readable source at all, which is the one case that is still `writer_empty`.
 */
export function evidenceDigest(input: {
  goal: string;
  plan: Pick<ResearchPlan, "objectives" | "title">;
  /** The citable sources, in `citableSources` order: their position is their number. */
  sources: ReadonlyArray<{ id: string; url: string; title: string }>;
  findings: ReadonlyArray<Pick<ResearchFindingRow, "claim" | "quote" | "sourceId" | "objectiveId">>;
}): string | null {
  if (input.sources.length === 0) return null;
  const numbered = corpusFindings(input.plan as ResearchPlan, [...input.sources], input.findings);
  const byObjective = new Map<string, typeof numbered>();
  const unsorted: typeof numbered = [];
  const questionOf = new Map(input.plan.objectives.map((objective) => [objective.question, objective.id]));
  for (const finding of numbered) {
    const id = finding.objective ? questionOf.get(finding.objective) : undefined;
    if (!id) {
      unsorted.push(finding);
      continue;
    }
    const list = byObjective.get(id) ?? [];
    list.push(finding);
    byObjective.set(id, list);
  }

  const title = headingText(input.plan.title || input.goal.split("\n")[0] || "Research");
  const parts: string[] = [
    `<!-- juno:report title="${title.replace(/"/g, "'").slice(0, 80)}" -->`,
    `# ${title}`,
    "",
    "<!-- juno:section=bottom-line -->",
    `## ${DIGEST_COPY.bottomLine}`,
    "",
    DIGEST_COPY.lead,
  ];
  const open: string[] = [];
  for (const objective of input.plan.objectives) {
    const found = (byObjective.get(objective.id) ?? []).slice(0, MAX_FINDINGS_PER_QUESTION);
    parts.push("", `<!-- juno:section=question:${objective.id} -->`, `## ${headingText(objective.question)}`, "");
    if (found.length === 0) {
      parts.push(DIGEST_COPY.noFinding);
      open.push(objective.question);
      continue;
    }
    for (const finding of found) parts.push(`- ${oneLine(finding.claim, 600)} [${finding.sourceIndex}]`);
  }
  if (unsorted.length > 0) {
    // Findings a worker noted without naming the question: still evidence.
    if (input.plan.objectives.length === 0) parts.push("", "<!-- juno:section=findings -->", `## ${headingText(input.goal)}`, "");
    else parts.push("");
    for (const finding of unsorted.slice(0, MAX_UNSORTED_FINDINGS)) parts.push(`- ${oneLine(finding.claim, 600)} [${finding.sourceIndex}]`);
  }
  parts.push("", "<!-- juno:section=gaps -->", `## ${DIGEST_COPY.open}`, "");
  if (open.length) for (const question of open) parts.push(`- ${oneLine(question, 300)}`);
  else parts.push(DIGEST_COPY.allAnswered);
  parts.push("", "<!-- juno:section=method -->", `## ${DIGEST_COPY.sources}`, "");
  // Linked, not cited: a list of titles is not a claim for the audit to check.
  for (const source of input.sources.slice(0, MAX_LISTED_SOURCES)) {
    const label = oneLine(source.title || source.url, 160).replace(/[[\]]/g, "");
    parts.push(/^https?:\/\//i.test(source.url) ? `- [${label}](${source.url.replace(/[()\s]/g, (ch) => (ch === "(" ? "%28" : ch === ")" ? "%29" : "%20"))})` : `- ${label}`);
  }
  return parts.join("\n").trim();
}
