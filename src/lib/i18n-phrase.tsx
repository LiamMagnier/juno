import * as React from "react";

import { formatDate, formatDuration, formatNumber, useUiLocale } from "@/lib/i18n-format";
import type { ArgNode, PhraseLine, PhraseSpec } from "@/lib/run/types";

/*
 * The phrase runtime (SPEC §10.1–10.2): a fixed, translatable phrase plus
 * separate argument nodes, never a sentence with values spliced in.
 *
 * AutoTranslate's catalog matches whole strings, so "Searching the web for"
 * can be translated once and reused for every query, while the query itself
 * rides beside it untranslated, bidi-isolated and marked `translate="no"`.
 * Plurals are whole phrases ("source" / "sources") chosen with PluralRules;
 * numbers, durations and dates go through `Intl` in the UI locale.
 *
 * English only for now: every lookup returns its source text. WS5 connects
 * the translation store (a lookup by the catalog's source hash) behind the
 * same functions, so nothing that calls them changes.
 */

const FSI = "\u2068";
const PDI = "\u2069";
const SEPARATOR = " · ";

const QUOTE_GRAPHEMES = 40;
const FILE_GRAPHEMES = 32;

// ── Lookup ────────────────────────────────────────────────────────────────────

/** The phrase in the reader's language; its English source until translated. */
export function usePhrase(text: string): string {
  return text;
}

/** The same, outside React (announcer, document.title, toasts, exports). Sync; English until cached. */
export function formatPhrase(text: string, _locale?: string): string {
  return text;
}

/** Warms the translations of phrases a live surface is about to show. Non-English readers only. */
export function prefetchPhrases(_texts: readonly string[]): void {
  // Nothing to fetch until the translation store exists (WS5).
}

/** The `one` or `other` form, by `Intl.PluralRules` in the UI locale. Every other category is `other`. */
export function pluralPhrase(n: number, forms: { one: string; other: string }, locale?: string): string {
  let category: Intl.LDMLPluralRule = "other";
  try {
    category = new Intl.PluralRules(locale ?? "en").select(n);
  } catch {
    category = new Intl.PluralRules("en").select(n);
  }
  return formatPhrase(category === "one" ? forms.one : forms.other, locale);
}

// ── Argument text ─────────────────────────────────────────────────────────────

let graphemeSegmenter: Intl.Segmenter | null = null;

function graphemes(text: string): string[] {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

/** Cut to `max` graphemes, never inside one (an emoji or a combined accent stays whole). */
function truncateEnd(text: string, max: number): string {
  const parts = graphemes(text);
  return parts.length <= max ? text : `${parts.slice(0, max - 1).join("")}…`;
}

/** File names keep their start and their extension: "Quarterly rep…2026.pdf". */
function truncateMiddle(text: string, max: number): string {
  const parts = graphemes(text);
  if (parts.length <= max) return text;
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return `${parts.slice(0, head).join("")}…${parts.slice(parts.length - tail).join("")}`;
}

function isPhrase(part: PhraseSpec["parts"][number]): part is { phrase: string } {
  return "phrase" in part;
}

function specsOf(spec: PhraseSpec | PhraseLine): readonly PhraseSpec[] {
  return "parts" in spec ? [spec] : spec;
}

function numberText(value: number, approx: boolean | undefined, locale: string): string {
  return `${approx ? "~" : ""}${formatNumber(value, locale)}`;
}

/** An argument node as plain text. Verbatim values are isolated with FSI…PDI. */
function argText(node: ArgNode, locale: string): string {
  switch (node.kind) {
    case "quote":
      return `“${FSI}${truncateEnd(node.value, QUOTE_GRAPHEMES)}${PDI}”`;
    case "domain":
    case "label":
      return `${FSI}${node.value}${PDI}`;
    case "file":
      return `${FSI}${truncateMiddle(node.value, FILE_GRAPHEMES)}${PDI}`;
    case "number":
      return numberText(node.value, node.approx, locale);
    case "duration":
      return formatDuration(node.ms, node.style, locale);
    case "date":
      return formatDate(node.iso, node.style, locale);
    case "count":
      return `${numberText(node.n, node.approx, locale)} ${pluralPhrase(node.n, node, locale)}`;
  }
}

/**
 * A spec or line as plain text, for everything that is not DOM: the
 * announcer, composed `aria-label`s, `document.title`, notifications. Complete
 * phrases are joined with ". " so a screen reader pauses between them.
 */
export function phraseText(spec: PhraseSpec | PhraseLine, locale?: string): string {
  const at = locale ?? "en";
  return specsOf(spec)
    .map((one) => one.parts.map((part) => (isPhrase(part) ? formatPhrase(part.phrase, at) : argText(part, at))).join(" "))
    .join(". ");
}

// ── Components ────────────────────────────────────────────────────────────────

/** One phrase, translated when a translation exists. Marked so AutoTranslate leaves it alone. */
export function Phrase({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const shown = usePhrase(text);
  return (
    <span data-no-auto-translate className={className}>
      {shown}
    </span>
  );
}

function ArgNodeView({ node, locale }: { node: ArgNode; locale: string }): React.JSX.Element {
  switch (node.kind) {
    case "quote":
      return (
        <q translate="no" lang="" data-no-auto-translate>
          <bdi>{truncateEnd(node.value, QUOTE_GRAPHEMES)}</bdi>
        </q>
      );
    case "domain":
    case "label":
      return (
        <bdi translate="no" lang="" data-no-auto-translate>
          {node.value}
        </bdi>
      );
    case "file":
      return (
        <bdi translate="no" lang="" data-no-auto-translate>
          {truncateMiddle(node.value, FILE_GRAPHEMES)}
        </bdi>
      );
    case "count":
      return (
        <>
          <span data-no-auto-translate>{numberText(node.n, node.approx, locale)}</span>{" "}
          <Phrase text={pluralPhrase(node.n, node, locale)} />
        </>
      );
    default:
      return <span data-no-auto-translate>{argText(node, locale)}</span>;
  }
}

/**
 * Parts in order: a phrase through `<Phrase>`, each argument as its own node.
 * A line joins its specs with the design separator " · ".
 */
export function PhraseWithArgs({
  spec,
  className,
}: {
  spec: PhraseSpec | PhraseLine;
  className?: string;
}): React.JSX.Element {
  const locale = useUiLocale();
  return (
    <span className={className}>
      {specsOf(spec).map((one, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span aria-hidden="true">{SEPARATOR}</span> : null}
          {one.parts.map((part, j) => (
            <React.Fragment key={j}>
              {j > 0 ? " " : null}
              {isPhrase(part) ? <Phrase text={part.phrase} /> : <ArgNodeView node={part} locale={locale} />}
            </React.Fragment>
          ))}
        </React.Fragment>
      ))}
    </span>
  );
}
