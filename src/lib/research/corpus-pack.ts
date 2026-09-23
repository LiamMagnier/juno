/**
 * The writer's corpus, packed to a token budget (B7).
 *
 * `citableSources` is every row with a snapshot, up to 250, and the corpus
 * inlined each at up to 12,000 characters: ~3 million characters, ~800k
 * tokens, a prompt no provider accepts. The writer failed, the run ended with
 * an empty report, and on the native path the chat turn itself failed.
 *
 * Packing keeps every source's NUMBER — the audit numbers citations over the
 * same `citableSources` list, so dropping a row would point every later [n]
 * at the wrong page — and decides only how much of each body the writer sees:
 *
 *   1. the findings, first: claims already tied to a verbatim quote;
 *   2. the passages that carry those quotes;
 *   3. for each question, round-robin, the passages that best match it;
 *   4. the rest, by the source's composite score, until the budget is spent.
 *
 * A source the budget did not reach keeps its number, title and URL and loses
 * its body. Pure; `SYNTHESIS_FINDINGS_CHARS` bounds the findings.
 */

import {
  RESEARCH_SNAPSHOT_CHARS,
  SYNTHESIS_FINDINGS_CHARS,
  WRITER_CORPUS_MAX_TOKENS,
} from "@/lib/research/domain";
import { tokenCoverage } from "@/lib/research/claim-analysis";

const CHARS_PER_TOKEN = 4;
const PASSAGE_CHARS = 1_200;
/** Passages each question may claim in the relevance pass, before the composite fill. */
const PASSAGES_PER_QUESTION = 4;
/** Characters a source costs besides its body: number, title, URL, envelope markers. */
const SOURCE_OVERHEAD_CHARS = 700;
/** Characters one finding costs in the ledger besides its claim and quote. */
const FINDING_OVERHEAD_CHARS = 80;

/** The writer's budget for a lead with this context window: half of it, at most 120k tokens. */
export function writerCorpusBudgetTokens(contextWindow?: number | null): number {
  const half = typeof contextWindow === "number" && contextWindow > 0 ? Math.floor(contextWindow / 2) : WRITER_CORPUS_MAX_TOKENS;
  return Math.max(8_000, Math.min(WRITER_CORPUS_MAX_TOKENS, half));
}

export interface PackableSource {
  id?: string;
  snapshot: string | null;
  composite?: number | null;
  authority?: number | null;
}

export interface PackableFinding {
  claim: string;
  quote: string;
  /** 1-based index into the sources, as the corpus numbers them. */
  sourceIndex: number;
}

interface Passage {
  source: number;
  ordinal: number;
  text: string;
}

function passagesOf(body: string, source: number): Passage[] {
  const out: Passage[] = [];
  for (const block of body.slice(0, RESEARCH_SNAPSHOT_CHARS).split(/\n{2,}/)) {
    let rest = block.trim();
    while (rest) {
      out.push({ source, ordinal: out.length, text: rest.slice(0, PASSAGE_CHARS) });
      rest = rest.slice(PASSAGE_CHARS).trim();
    }
  }
  return out;
}

/**
 * Returns the sources in their original order with `snapshot` replaced by the
 * packed body (empty when the budget did not reach it), the findings that fit,
 * and the tokens the packing spent.
 */
export function packCorpus<T extends PackableSource>(
  sources: readonly T[],
  findings: readonly PackableFinding[],
  budgetTokens: number,
  questions: readonly string[] = []
): { sources: Array<T & { snapshot: string }>; findings: PackableFinding[]; tokens: number } {
  let left = Math.max(0, Math.floor(budgetTokens)) * CHARS_PER_TOKEN;
  // Numbers, titles and URLs first: they are what keeps every citation resolvable.
  left -= sources.length * SOURCE_OVERHEAD_CHARS;

  const keptFindings: PackableFinding[] = [];
  let findingChars = 0;
  for (const finding of findings) {
    const cost = finding.claim.length + finding.quote.length + FINDING_OVERHEAD_CHARS;
    if (cost > left || findingChars + cost > SYNTHESIS_FINDINGS_CHARS) break;
    keptFindings.push(finding);
    findingChars += cost;
    left -= cost;
  }

  const passages = sources.map((source, i) => passagesOf(source.snapshot ?? "", i));
  const chosen = sources.map(() => new Set<number>());
  const take = (passage: Passage): boolean => {
    if (chosen[passage.source].has(passage.ordinal)) return true;
    if (passage.text.length + 2 > left) return false;
    chosen[passage.source].add(passage.ordinal);
    left -= passage.text.length + 2;
    return true;
  };

  // The passages the findings quote.
  for (const finding of keptFindings) {
    const own = passages[finding.sourceIndex - 1];
    if (!own?.length) continue;
    const needle = finding.quote.replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();
    const hit =
      own.find((p) => needle && p.text.replace(/\s+/g, " ").toLowerCase().includes(needle)) ??
      [...own].sort((a, b) => tokenCoverage(finding.quote, b.text) - tokenCoverage(finding.quote, a.text))[0];
    if (hit) take(hit);
  }

  // Each question's best passages, one per question per turn.
  const ranked = questions.map((question) =>
    passages
      .flat()
      .map((passage) => ({ passage, score: tokenCoverage(question, passage.text) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, PASSAGES_PER_QUESTION)
      .map((item) => item.passage)
  );
  for (let k = 0; k < PASSAGES_PER_QUESTION; k += 1) {
    for (const list of ranked) {
      const passage = list[k];
      if (passage) take(passage);
    }
  }

  // The rest, strongest source first, each read from its top.
  const order = sources
    .map((source, i) => ({ i, composite: source.composite ?? -1, authority: source.authority ?? -1 }))
    .sort((a, b) => b.composite - a.composite || b.authority - a.authority || a.i - b.i);
  fill: for (const { i } of order) {
    for (const passage of passages[i]) {
      if (!take(passage)) break fill;
    }
  }

  const packed = sources.map((source, i) => ({
    ...source,
    snapshot: passages[i]
      .filter((passage) => chosen[i].has(passage.ordinal))
      .map((passage) => passage.text)
      .join("\n\n"),
  }));
  const bodyChars = packed.reduce((sum, source) => sum + source.snapshot.length, 0);
  return {
    sources: packed,
    findings: keptFindings,
    tokens: Math.ceil((bodyChars + findingChars + sources.length * SOURCE_OVERHEAD_CHARS) / CHARS_PER_TOKEN),
  };
}
