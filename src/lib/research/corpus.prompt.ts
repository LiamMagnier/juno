/**
 * What the research writer is told (SPEC §9.6.3, §9.9). Model-facing,
 * English, and kept in a `*.prompt.ts` file so the i18n extractor never
 * harvests it (INV-29, §10.5). `corpus.ts` assembles these around the
 * numbered sources.
 *
 * Two contracts. The CHAT contract is the native in-chat path's (INV-11):
 * the user's own chat model streams the report, headings and all, exactly as
 * it always has — only the word "Deep" left its header (§9.9). The REPORT
 * contract is the web engine's writer: one call that writes the cited
 * summary and the report with its section markers, which the completion and
 * the reader key on in any language.
 */

import { truncate } from "@/lib/utils";

/** The header and structure of the in-chat report (native path, frozen shape). */
export function chatReportContract(goal: string): string {
  return `# Autonomous Research Mode
The user requested an exhaustive, authoritative research investigation on: "${truncate(goal, 300)}".
You are writing a comprehensive, publication-grade research REPORT, grounded strictly in the numbered source material below.

# Report Structure:
1. "# Title": Clear, professional title naming the topic.
2. "## Executive Summary": High-level synthesis highlighting key findings, core thesis, and high-impact takeaways.
3. "## Key Findings & Core Analysis": Detailed thematic sections (using "### Subheadings") breaking down the subject with quantitative data, benchmark comparisons, timelines, and technical details. Use Markdown comparison tables where appropriate.
4. "## Nuances, Contradictions & Trade-Offs": Explicitly analyze conflicting claims or divergent evidence between sources.
5. "## Limitations & Open Questions": What remains uncertain or unverifiable from current evidence.
6. "## Sources": Numbered list matching cited references as "[n] Title — URL".`;
}

/**
 * The web writer's contract: the summary and the report in one reply, each
 * section preceded by its marker. The model writes the headings in the
 * report's language; the markers stay as written, and are what everything
 * downstream reads (I-14). No sources section: the reader renders sources
 * from rows, cited then read.
 */
export function reportWriterContract(input: {
  goal: string;
  questions: ReadonlyArray<{ id: string; question: string }>;
  dateLine?: string | null;
  languageLine?: string | null;
}): string {
  const questionSections = input.questions
    .map(
      (question) =>
        `<!-- juno:section=question:${question.id} -->\n## ${question.question.replace(/\s+/g, " ").trim()}\n{what the evidence establishes about this question, cited}`
    )
    .join("\n\n");
  return `# Research report
${input.dateLine ? `${input.dateLine}\n` : ""}The user asked for a research investigation on: "${truncate(input.goal, 600)}".
You are the lead researcher. Write the final report for the person who asked, grounded strictly in the numbered source material below, and a short summary that opens the reply.${input.languageLine ? `\n${input.languageLine} Write the summary, the title and every heading and sentence of the report in that language. Keep every <!-- juno:… --> marker exactly as written below, in English.` : ""}

# Reply format
Reply with exactly this shape, and nothing before or after it. The markers are HTML comments: copy each one on its own line, unchanged, directly above what it names.

<!-- juno:summary -->
{120 to 250 words: the answer first, then the two or three findings that carry it, cited with [n]}
<!-- juno:report title="{the report's title, at most 80 characters}" -->
# {the same title}
<!-- juno:section=bottom-line -->
## Bottom line
{the answer in a few sentences, cited}
<!-- juno:section=findings -->
## Key findings
{the findings that matter most, each cited; tables where they compare}

${questionSections}

<!-- juno:section=conflicts -->
## Where sources disagree
{each disagreement, with both sides cited; say which is better supported and why}
<!-- juno:section=gaps -->
## What could not be established
{what the sources could not settle; never fill a gap from memory}
<!-- juno:section=method -->
## Method
{how the research was done: what was searched and read, in two or three sentences}

Translate the headings ("Bottom line", "Key findings", "Where sources disagree", "What could not be established", "Method") into the report's language; a question heading is the question as written above, translated when the report's language differs. Do not write a sources, references or bibliography section.`;
}

/** The citation and accuracy rules both contracts share. */
export const CITATION_RULES = `# Citation & Accuracy Rules:
- Cite EVERY factual assertion, statistic, quote, and claim inline with bracketed numbers (e.g. [1], [2][4]) mapping directly to the numbered source list below.
- Strict factual grounding: Do NOT fabricate details or cite numbers outside the numbered list.
- When sources disagree or have different methodologies, explain the disagreement and cite each source.
- Two sources repeating the same press release or mirror text are not independent corroboration.
- Separate observed facts from inferences. Explain evidence strength without invented confidence percentages.
- Distinguish publication dates from the dates events occurred. Prefer original studies and official records.
- Do not treat absent evidence as evidence of absence. Failed fetches and unavailable sources remain limitations.
- Keep the report proportionate to the question. Do not pad it to appear exhaustive.`;

/** The constraints block: the user's own instructions, for the whole report. */
export function constraintsBlock(constraints: readonly string[]): string {
  return constraints.length
    ? `\nConstraints the user set for this research (these are the user's own instructions, and they apply to the whole report):\n${constraints
        .map((c) => `- ${c}`)
        .join("\n")}\n`
    : "";
}

export const EVIDENCE_LEDGER_HEADER = (count: number) =>
  `# Evidence Ledger (${count} sourced findings from the research team)
Each finding is a claim tied to a verbatim quote from the numbered source it cites. Build the report from these first; the source material below is the full text behind them.`;

export const EVIDENCE_STATE_HEADER = "# Evidence State (the research team's own review)";
export const CONFLICTS_INTRO =
  "Contradictions and duplicate sources the team flagged. Address each one where the report discusses disagreement, citing both sides; a duplicate is one witness, not two:";
export const SHORT_OBJECTIVES_INTRO =
  "Sub-questions the team could not fully answer. Say what is missing where the report lists what could not be established, rather than filling the gap from memory:";
export const OPEN_QUESTIONS_INTRO = "Questions the researchers could not settle from the pages they read:";
export const SOURCE_MATERIAL_HEADER = "# Numbered Source Material:";
