/**
 * The peek's reasoning excerpt (SPEC §7.5): the newest complete sentence of
 * the latest reasoning segment, as one line under the live label.
 *
 * Sentences are found with `Intl.Segmenter` in the reader's locale, never by
 * splitting on ". ", so Japanese and Chinese (whose sentences end in "。" with
 * no space after) and abbreviations ("e.g. this") read correctly. A sentence
 * still being streamed is never shown half-written: the excerpt is the last
 * one that has ended. The provider's bold headline lines are the label's job,
 * not the excerpt's, and are left out.
 *
 * Pure.
 */

const HEADLINE_LINE = /^\s*\*\*[^\n]{1,120}\*\*\s*$/gm;
/** A sentence that has ended: final punctuation, then optional closing quotes or brackets. */
const ENDED = /[.!?。！？…‼⁇⁈⁉][)"'”’»」』\]]*\s*$/u;

const segmenters = new Map<string, Intl.Segmenter>();

function sentenceSegmenter(locale: string): Intl.Segmenter {
  let segmenter = segmenters.get(locale);
  if (!segmenter) {
    try {
      segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
    } catch {
      segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    }
    segmenters.set(locale, segmenter);
  }
  return segmenter;
}

/** The newest sentence of `text` that has ended, trimmed and on one line; null when none has. */
export function newestSentence(text: string, locale: string): string | null {
  const body = text.replace(HEADLINE_LINE, " ").replace(/\s+/g, " ").trim();
  if (!body) return null;
  const sentences = Array.from(sentenceSegmenter(locale).segment(body), (part) => part.segment.trim()).filter(Boolean);
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    if (ENDED.test(sentences[i])) return sentences[i];
  }
  return null;
}
