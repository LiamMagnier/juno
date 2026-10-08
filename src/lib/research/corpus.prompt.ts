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

/**
 * The header and structure of the in-chat report (native path).
 *
 * The section ORDER is the research protocol's Stage 5 (institutional report
 * compilation); the native readers split on headings generically, so new
 * heading names are safe for them.
 */
export function chatReportContract(goal: string): string {
  return `# Autonomous Research Mode
The user requested an exhaustive, authoritative research investigation on: "${truncate(goal, 300)}".
You are a principal research analyst writing an institutional-grade REPORT, grounded strictly in the numbered source material below. Zero fluff: exact figures, dates and limits, every one cited.

# Report Structure:
1. "# Title": Clear, professional title naming the topic.
2. "## Executive Verdict & Decision Matrix": The core recommendation or answer and the key trade-offs in the first two paragraphs, then a Markdown decision matrix (situation or need → verdict → why, cited).
3. "## Comparative Matrix": One multi-dimensional Markdown table across every vector (specs, limits, pricing, ecosystem, enterprise and privacy terms…), one row per option or entity compared — or one row per vector when nothing is being compared. Every cell an exact figure with [n], or "not published".
4. "## Vector Deep Dives": One "### Subheading" per investigative vector: the hard evidence, exact figures with their dates and versions, and real-world edge cases. Use the prose for what the figures mean and their conditions; it need not repeat every table cell.
Tables are citation-checked cell by cell: every figure in a table carries its [n] in its own cell, or on the row label when one source backs the whole row, or on the column header when one source backs the whole column.
5. "## Nuances & Gotchas": Hidden rate limits, token quotas, degraded performance under load, deprecations, IP and training terms, cancellation friction — whatever the evidence shows.
6. "## Where Sources Disagree": Each conflicting claim, both sides cited, and which is better supported (official changelog or documentation over secondary reporting) and why.
7. "## Limitations & Open Questions": What remains uncertain or unverifiable from current evidence.
8. "## Methodology & Source Traceability": How the research was done in two or three sentences (including sources found versus read in full, from the research footprint when it is given), then a table attributing the evidence to its primary domains: domain, kind of record, publication or update date, what it established, citations.
9. "## Sources": Numbered list matching cited references as "[n] Title — URL".`;
}

/**
 * The web writer's contract: the summary and the report in one reply, each
 * section preceded by its marker. The model writes the headings in the
 * report's language; the markers stay as written, and are what everything
 * downstream reads (I-14). No sources section: the reader renders sources
 * from rows, cited then read.
 *
 * The order is the research protocol's Stage 5: executive verdict and
 * decision matrix, comparative matrix, vector deep dives, nuances and
 * gotchas, then methodology with source traceability.
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
        `<!-- juno:section=question:${question.id} -->\n## ${question.question.replace(/\s+/g, " ").trim()}\n{the deep dive for this vector: the hard evidence, exact figures with their dates and versions, real-world edge cases, cited}`
    )
    .join("\n\n");
  return `# Research report
${input.dateLine ? `${input.dateLine}\n` : ""}The user asked for a research investigation on: "${truncate(input.goal, 600)}".
You are the principal analyst. Write the final report for the person who asked — institutional grade, zero fluff — grounded strictly in the numbered source material below, and a short summary that opens the reply.${input.languageLine ? `\n${input.languageLine} Write the summary, the title and every heading and sentence of the report in that language. Keep every <!-- juno:… --> marker exactly as written below, in English.` : ""}

# Reply format
Reply with exactly this shape, and nothing before or after it. The markers are HTML comments: copy each one on its own line, unchanged, directly above what it names.

<!-- juno:summary -->
{120 to 250 words: the verdict first, then the two or three figures that carry it, cited with [n]}
<!-- juno:report title="{the report's title, at most 80 characters}" -->
# {the same title}
<!-- juno:section=bottom-line -->
## Executive verdict
{the core recommendation or answer and the key trade-offs, in the first two paragraphs, cited; then a decision matrix as a Markdown table — the situation or need, the verdict for it, and why, cited}
<!-- juno:section=matrix -->
## Comparative matrix
{one multi-dimensional Markdown table across every vector — specs, limits, pricing, ecosystem, enterprise and privacy terms, whatever the vectors measured — one row per option or entity being compared, or one row per vector when the question compares nothing; every cell an exact figure with its [n], or "not published"}

${questionSections}

<!-- juno:section=gotchas -->
## Nuances and gotchas
{hidden rate limits, quotas, degraded performance under load, deprecations and effective dates, IP and training terms, cancellation friction — whatever the evidence shows, each cited; omit nothing the evidence flags}
<!-- juno:section=conflicts -->
## Where sources disagree
{each disagreement, with both sides cited; say which is better supported — an official changelog or documentation over secondary reporting — and why}
<!-- juno:section=gaps -->
## What could not be established
{what the sources could not settle, including figures the gap audit found missing; never fill a gap from memory}
<!-- juno:section=method -->
## Methodology and source traceability
{two or three sentences on how the research was done (vectors, rounds, what was searched, and how many sources were found against how many were read in full, from the research footprint when it is given), then a Markdown table attributing the evidence to its primary domains: domain, kind of record (documentation, pricing page, changelog, filing, repository, press…), publication or update date, what it established, citations}

Tables are citation-checked cell by cell: every figure in a table carries its [n] in its own cell — or on the row label when one source backs the whole row, or on the column header when one source backs the whole column — so the deep dives explain what the figures mean rather than repeating every cell. Translate the headings ("Executive verdict", "Comparative matrix", "Nuances and gotchas", "Where sources disagree", "What could not be established", "Methodology and source traceability") into the report's language; a vector heading is the question as written above, translated when the report's language differs. Do not write a sources, references or bibliography section.`;
}

/** The citation and accuracy rules both contracts share. */
export const CITATION_RULES = `# Citation & Accuracy Rules:
- Cite EVERY factual assertion, statistic, quote, and claim inline with bracketed numbers (e.g. [1], [2][4]) mapping directly to the numbered source list below.
- Strict factual grounding: Do NOT fabricate details or cite numbers outside the numbered list.
- When sources disagree or have different methodologies, explain the disagreement and cite each source.
- Two sources repeating the same press release or mirror text are not independent corroboration.
- Separate observed facts from inferences. Explain evidence strength without invented confidence percentages.
- Distinguish publication dates from the dates events occurred. Prefer original studies and official records.
- Source hierarchy: each source below is labelled with its kind, domain and date. Cite the primary record (documentation, pricing page, changelog, filing, repository, benchmark) for every figure it carries; never cite an aggregator, affiliate roundup or sponsored list for a figure a primary record states, and say so when only an aggregator carries one.
- State every figure exactly as the source does — number, unit, tier, version — with the date it applies from when the source gives one.
- Do not treat absent evidence as evidence of absence. Failed fetches and unavailable sources remain limitations.
- Keep the report proportionate to the question. Do not pad it to appear exhaustive.
- Sources labelled PRIVATE are the person's own files, mail, calendar, notes or memories, read with their permission. Cite them like any source, and mark every sentence that rests on one with "(your sources)" after its citation, so the reader can tell their own data from the public record. Quote from them only what the question needs; never reproduce whole messages or documents. When the public record and their own sources disagree, say so.`;

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
export const GAP_AUDIT_INTRO =
  "The pre-writing gap audit, per vector: figures still missing, figures sources state differently, and figures resting on old or undated pages. Name each in the report — missing ones under what could not be established, conflicting ones under where sources disagree, old ones with their date:";
export const CONFLICTS_INTRO =
  "Contradictions and duplicate sources the team flagged. Address each one where the report discusses disagreement, citing both sides; a duplicate is one witness, not two:";
export const SHORT_OBJECTIVES_INTRO =
  "Sub-questions the team could not fully answer. Say what is missing where the report lists what could not be established, rather than filling the gap from memory:";
export const OPEN_QUESTIONS_INTRO = "Questions the researchers could not settle from the pages they read:";
export const SOURCE_MATERIAL_HEADER = "# Numbered Source Material:";
