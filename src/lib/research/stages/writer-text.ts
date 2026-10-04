/*
 * Research engine — the writer's output, as text: timebox constants, the
 * report/summary/title split, passages and citation markers. Pure.
 */
import { MAX_PASSAGES_PER_SOURCE, PASSAGE_CHARS } from "./limits";
import { parseWriterOutput } from "@/lib/research/report-structure";

/** The writer's timebox ceiling (R8): a quarter of the run's clock, never more than this. */
export const WRITER_TIMEBOX_MAX_MS = 6 * 60_000;
/** The corpus share the one retry after an unusable report is packed to (B6). */
export const WRITER_RETRY_CORPUS_SCALE = 0.7;

/**
 * The writer's reply as the run stores it: the report (what the audit checks
 * and the reader reads), and beside it on the plan the summary and title the
 * structured writer puts ahead of it (§9.6.3). A reply with no markers is all
 * report, as every writer's was before.
 */
export function writerParts(text: string): { summary: string; title: string; report: string } {
  if (!/<!--\s*juno:(report|summary)/i.test(text)) return { summary: "", title: "", report: text.trim() };
  const parsed = parseWriterOutput(text);
  return { summary: parsed.summary, title: parsed.title, report: parsed.report };
}

/** The run's recorded error when sizing refuses it: the same lines the chat and the API show (§9.9). */

export function splitPassages(
  text: string
): Array<{ text: string; locator: string; ordinal: number }> {
  const out: Array<{ text: string; locator: string; ordinal: number }> = [];
  let cursor = 0;
  for (const chunk of text.split(/\n{2,}/)) {
    const start = text.indexOf(chunk, cursor);
    cursor = start + chunk.length;
    const trimmed = chunk.trim();
    if (trimmed.length < 80) continue;
    const body = trimmed.slice(0, PASSAGE_CHARS);
    out.push({
      text: body,
      locator: `chars:${start}-${start + body.length}`,
      ordinal: out.length,
    });
    if (out.length >= MAX_PASSAGES_PER_SOURCE) break;
  }
  return out;
}

/**
 * Citation markers that a reader can actually see.
 *
 * Code fences frequently contain examples such as `const source = "[100]"`.
 * Treating those as report citations creates a false partial-completion result;
 * strip fenced blocks before matching, while allowing the three-digit source
 * indices that deep runs can legitimately produce.
 */
export function citationMarkersOutsideCode(markdown: string): number[] {
  const visible = markdown.replace(/(^|\n)```[\s\S]*?```(?=\n|$)/g, "$1");
  const markers = new Set<number>();
  for (const match of visible.matchAll(/\[(\d{1,3})\]/g)) markers.add(Number(match[1]));
  return [...markers];
}
