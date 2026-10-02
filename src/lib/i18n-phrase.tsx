import * as React from "react";

import { formatClock, formatDate, formatDuration, formatNumber, getUiLocale, subscribeUiLocale, useUiLocale } from "@/lib/i18n-format";
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
 * Translations come from the same place AutoTranslate's come from: the
 * build-time catalog maps a phrase to its id (`sha256(source).slice(0, 16)`),
 * and `translationStore` holds what `/api/i18n/translations` returned for it,
 * with AutoTranslate's chunking, `localStorage` cache and back-off. A phrase
 * renders in English until its translation is cached, then swaps in place;
 * English readers never load the catalog at all.
 */

const FSI = "\u2068";
const PDI = "\u2069";
const SEPARATOR = " · ";

const QUOTE_GRAPHEMES = 40;
const FILE_GRAPHEMES = 32;

// ── The catalog ───────────────────────────────────────────────────────────────

export type CatalogItem = { id: string; source: string };
export interface LoadedCatalog {
  /** Source text (whitespace-collapsed, trimmed) → its catalog entry. */
  sourceCatalog: Map<string, CatalogItem>;
  knownIds: Set<string>;
}

let catalogPromise: Promise<LoadedCatalog> | null = null;
let catalog: LoadedCatalog | null = null;

function indexCatalog(items: readonly CatalogItem[]): LoadedCatalog {
  return {
    sourceCatalog: new Map<string, CatalogItem>(items.map((item) => [item.source, item])),
    knownIds: new Set<string>(items.map((item) => item.id)),
  };
}

/**
 * The generated catalog, fetched once and only when a reader needs
 * translation: it is ~130 KB gzipped, and loading it at module scope put it
 * on every page for every visitor (see AutoTranslate's header).
 */
export function loadCatalog(): Promise<LoadedCatalog> {
  catalogPromise ??= import("@/lib/i18n-catalog.generated").then((m) => {
    catalog = indexCatalog(m.UI_TRANSLATION_CATALOG);
    translationStore.forgetUnknown(catalog.knownIds);
    translationStore.notify();
    return catalog;
  });
  return catalogPromise;
}

/** The catalog if it has loaded, without waiting for it. */
export function loadedCatalog(): LoadedCatalog | null {
  return catalog;
}

/** Test seam: a catalog of the given entries, as if it had loaded (`null` forgets it). */
export function setCatalogForTests(items: readonly CatalogItem[] | null): void {
  catalog = items ? indexCatalog(items) : null;
  catalogPromise = catalog ? Promise.resolve(catalog) : null;
  translationStore.notify();
}

// ── The translation store ─────────────────────────────────────────────────────

const CHUNK_SIZE = 30;
const BATCH_DELAY_MS = 20;
const THROTTLED_BACKOFF_MS = 5 * 60_000;
const UNAVAILABLE_BACKOFF_MS = 30_000;

function isEnglish(locale: string): boolean {
  return /^en(?:-|$)/i.test(locale);
}

function storageKey(locale: string): string {
  return `juno:ui-translations:${locale}:v1`;
}

/**
 * One store of translated UI strings, per locale, keyed by catalog id.
 *
 * It is what AutoTranslate's private map became, so the DOM walker and the
 * phrase runtime read and request through the same fetcher, the same 30-id
 * chunks, the same `localStorage` cache and the same back-off: a phrase the
 * walker already fetched is never fetched again for a `<Phrase>`, and the
 * other way round. Requests go only for the active locale (the reader's);
 * other locales hold only what was seeded (the galleries' `de` fixtures).
 */
class TranslationStore {
  private tables = new Map<string, Map<string, string>>();
  /** Loaded from storage already, per locale. */
  private hydrated = new Set<string>();
  private pending = new Set<string>();
  /** Permanent: the model had nothing usable for this id, so retrying is waste. */
  private failed = new Set<string>();
  /** Transient (429/5xx): ids stay missing and are retried after this deadline. */
  private retryAfter = 0;
  private queued = new Set<string>();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private revision = 0;
  private requestLocale: string | null = null;

  /** The reader's UI locale (AutoTranslate's resolved one). */
  get locale(): string {
    return getUiLocale();
  }

  /** Changes whenever a translation lands; `useSyncExternalStore`'s snapshot. */
  get version(): number {
    return this.revision;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.revision;

  notify(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  }

  private table(locale: string): Map<string, string> {
    let table = this.tables.get(locale);
    if (!table) {
      table = new Map();
      this.tables.set(locale, table);
    }
    if (!this.hydrated.has(locale)) {
      this.hydrated.add(locale);
      try {
        const stored = JSON.parse(globalThis.localStorage?.getItem(storageKey(locale)) ?? "{}") as Record<string, unknown>;
        for (const [id, value] of Object.entries(stored)) if (typeof value === "string") table.set(id, value);
      } catch {
        try {
          globalThis.localStorage?.removeItem(storageKey(locale));
        } catch {
          // Storage may be disabled.
        }
      }
    }
    return table;
  }

  private persist(locale: string): void {
    try {
      globalThis.localStorage?.setItem(storageKey(locale), JSON.stringify(Object.fromEntries(this.table(locale))));
    } catch {
      // Storage may be disabled/private; the CDN + in-memory server cache still help.
    }
  }

  /** The active locale changed: in-flight state and back-off belong to the old one. */
  private syncLocale(): string {
    const locale = this.locale;
    if (locale !== this.requestLocale) {
      this.requestLocale = locale;
      this.pending.clear();
      this.failed.clear();
      this.retryAfter = 0;
      this.queued.clear();
    }
    return locale;
  }

  get(id: string, locale: string = this.locale): string | undefined {
    if (isEnglish(locale)) return undefined;
    return this.table(locale).get(id);
  }

  isPending(id: string): boolean {
    this.syncLocale();
    return this.pending.has(id);
  }

  isFailed(id: string): boolean {
    this.syncLocale();
    return this.failed.has(id);
  }

  /** Milliseconds until a throttled or failing endpoint may be asked again (0 = now). */
  cooldownMs(now: number = Date.now()): number {
    this.syncLocale();
    return Math.max(0, this.retryAfter - now);
  }

  /** Puts translations in without a request: the galleries' `de` fixtures, and tests. */
  seed(locale: string, entries: Readonly<Record<string, string>>): void {
    const table = this.table(locale);
    for (const [id, value] of Object.entries(entries)) table.set(id, value);
    this.notify();
  }

  /** Drops ids the catalog no longer has, so a stale cache does not persist forever. */
  forgetUnknown(known: ReadonlySet<string>): void {
    for (const table of this.tables.values()) for (const id of [...table.keys()]) if (!known.has(id)) table.delete(id);
  }

  /**
   * Fetches the ids the active locale is missing, in chunks of 30, and
   * resolves when every chunk has answered. Ids already cached, in flight,
   * known to have no translation, or asked during a back-off are skipped.
   */
  async request(ids: readonly string[]): Promise<void> {
    const locale = this.syncLocale();
    if (isEnglish(locale) || typeof fetch === "undefined") return;
    if (this.retryAfter > Date.now()) return;
    const table = this.table(locale);
    const missing = [...new Set(ids)].filter((id) => !table.has(id) && !this.pending.has(id) && !this.failed.has(id));
    if (!missing.length) return;
    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += CHUNK_SIZE) chunks.push(missing.slice(i, i + CHUNK_SIZE));
    await Promise.allSettled(chunks.map((chunk) => this.requestChunk(locale, chunk)));
  }

  /** `request`, batched: every id asked within 20 ms goes out together. */
  enqueue(ids: readonly string[]): void {
    for (const id of ids) this.queued.add(id);
    if (this.batchTimer !== null || typeof setTimeout === "undefined") return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      const batch = [...this.queued];
      this.queued.clear();
      void this.request(batch);
    }, BATCH_DELAY_MS);
  }

  private async requestChunk(locale: string, ids: string[]): Promise<void> {
    ids.forEach((id) => this.pending.add(id));
    let landed = false;
    try {
      const params = new URLSearchParams({ locale, ids: [...ids].sort().join(",") });
      const res = await fetch(`/api/i18n/translations?${params}`, { credentials: "same-origin" });
      if (locale !== this.requestLocale) return;
      // Throttled, or the model walk is down — both recover on their own, so
      // leave these ids missing rather than burning them.
      if (res.status === 429 || res.status >= 500) {
        this.retryAfter = Date.now() + (res.status === 429 ? THROTTLED_BACKOFF_MS : UNAVAILABLE_BACKOFF_MS);
        return;
      }
      if (!res.ok) throw new Error(`translation request failed (${res.status})`);
      const data = (await res.json()) as { translations?: Record<string, unknown> };
      const table = this.table(locale);
      for (const id of ids) {
        const value = data.translations?.[id];
        if (typeof value === "string" && value.trim()) {
          table.set(id, value.trim());
          landed = true;
        } else this.failed.add(id);
      }
      this.persist(locale);
    } catch {
      if (locale === this.requestLocale) ids.forEach((id) => this.failed.add(id));
    } finally {
      ids.forEach((id) => this.pending.delete(id));
      if (landed) this.notify();
    }
  }
}

export const translationStore = new TranslationStore();

// A locale change re-renders every phrase (their translations are per locale).
subscribeUiLocale(() => translationStore.notify());

/** The catalog id of a phrase, or null when the catalog has not loaded or does not know it. */
export function phraseId(text: string): string | null {
  const source = text.replace(/\s+/g, " ").trim();
  return catalog?.sourceCatalog.get(source)?.id ?? null;
}

function lookup(text: string, locale: string): string | null {
  if (isEnglish(locale)) return null;
  if (!catalog) {
    void loadCatalog();
    return null;
  }
  const id = phraseId(text);
  if (!id) return null;
  const translated = translationStore.get(id, locale);
  if (translated !== undefined) return translated;
  if (locale === translationStore.locale) translationStore.enqueue([id]);
  return null;
}

// ── Lookup ────────────────────────────────────────────────────────────────────

/** The phrase in the reader's language; its English source until translated. */
export function usePhrase(text: string): string {
  const locale = useUiLocale();
  React.useSyncExternalStore(translationStore.subscribe, translationStore.getVersion, serverVersion);
  return lookup(text, locale) ?? text;
}

const serverVersion = () => 0;

/**
 * The same, outside React (announcer, document.title, toasts, exports). Sync;
 * English until cached, and asking for the translation makes it cached for the
 * next call.
 */
export function formatPhrase(text: string, locale?: string): string {
  return lookup(text, locale ?? translationStore.locale) ?? text;
}

/**
 * Warms the translations of phrases a live surface is about to show, so the
 * live line never starts in English. Non-English readers only; on idle.
 */
export function prefetchPhrases(texts: readonly string[]): void {
  if (isEnglish(translationStore.locale) || typeof window === "undefined") return;
  const run = () => {
    void loadCatalog().then(() => {
      const ids = texts.map(phraseId).filter((id): id is string => id !== null);
      void translationStore.request(ids);
    });
  };
  const idle = (window as Window & { requestIdleCallback?: (fn: () => void) => number }).requestIdleCallback;
  if (idle) idle(run);
  else setTimeout(run, 200);
}

/**
 * The English source of the `one` or `other` form, by `Intl.PluralRules` in
 * the locale. Every category but "one" is `other` (an accepted limitation for
 * few/many languages until the ICU pipeline lands).
 */
export function pluralForm(n: number, forms: { one: string; other: string }, locale?: string): string {
  let category: Intl.LDMLPluralRule = "other";
  try {
    category = new Intl.PluralRules(locale ?? getUiLocale()).select(n);
  } catch {
    category = new Intl.PluralRules("en").select(n);
  }
  return category === "one" ? forms.one : forms.other;
}

/** The `one` or `other` form, translated, by `Intl.PluralRules` in the UI locale. */
export function pluralPhrase(n: number, forms: { one: string; other: string }, locale?: string): string {
  return formatPhrase(pluralForm(n, forms, locale), locale);
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
    case "time":
      return formatClock(new Date(node.iso), locale);
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
  const at = locale ?? getUiLocale();
  let out = "";
  for (const one of specsOf(spec)) {
    const text = one.parts.map((part) => (isPhrase(part) ? formatPhrase(part.phrase, at) : argText(part, at))).join(" ");
    if (!text) continue;
    // A phrase that is already a sentence keeps its own stop: "…left. Resets on", never "left..".
    out = out ? `${out}${SENTENCE_END.test(out) ? " " : ". "}${text}` : text;
  }
  return out;
}

const SENTENCE_END = /[.!?…。！？]$/u;

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
          <Phrase text={pluralForm(node.n, node, locale)} />
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
