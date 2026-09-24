"use client";

import * as React from "react";
import { filterMutations, isExcludedFromTranslation, type MutationRecordLike } from "@/lib/auto-translate-filter";
import { directionOf, languageOf, localeFromAcceptLanguage } from "@/lib/i18n";
import { setUiLocale } from "@/lib/i18n-format";
import { loadCatalog, translationStore, type CatalogItem } from "@/lib/i18n-phrase";

/*
 * THE CATALOG IS NOT IN THIS BUNDLE ANY MORE.
 *
 * `UI_TRANSLATION_CATALOG` is 4,644 generated entries — ~326 KB raw, ~131 KB
 * gzipped — and it was imported at module scope here, in a `"use client"`
 * component mounted by the ROOT layout. So every visitor to every page
 * downloaded it, parsed it, and built two hash tables from it (~9,300 inserts)
 * before anything could hydrate.
 *
 * The effect below already bails out four lines in for an English locale,
 * which is most sessions. It just bailed out AFTER the cost had been paid,
 * because a module-scope `new Map(...)` runs on import and an import runs
 * whatever the component decides afterwards.
 *
 * Now it is fetched with `await import()` on the far side of that bail-out
 * (`loadCatalog`, which lives with the phrase runtime so `<Phrase>` shares the
 * one fetch). A reader who needs translation waits one extra chunk — on a path
 * that is already about to make network calls for the translations themselves
 * — and everyone else never sees it at all.
 *
 * The translations themselves live in `translationStore` (the same module),
 * which this component used to keep as a private map: the DOM walker below
 * and the phrase runtime now read, request and cache through one store, so a
 * string is fetched once whichever of them saw it first.
 */
export { loadCatalog, translationStore } from "@/lib/i18n-phrase";

const TRANSLATABLE_ATTRIBUTES = ["aria-label", "alt", "placeholder", "title"] as const;

/** A scan is scheduled this long after the mutation that asked for it. */
const SCAN_DELAY_MS = 20;
/**
 * While anything on the page is `aria-busy` (a streaming answer, a run
 * block), scans are at most four a second: a token stream mutates the DOM
 * dozens of times a second and none of it is translatable.
 */
const BUSY_SCAN_INTERVAL_MS = 250;
/** Past this many dirty roots, one full walk is cheaper than sorting them out. */
const MAX_DIRTY_ROOTS = 200;

function splitWhitespace(value: string): { before: string; core: string; after: string } {
  const before = /^\s*/.exec(value)?.[0] ?? "";
  const after = /\s*$/.exec(value)?.[0] ?? "";
  return {
    before,
    core: value.slice(before.length, value.length - after.length).replace(/\s+/g, " "),
    after,
  };
}

/*
 * A textarea's *content* is whatever the user typed and must never be
 * translated — but its `placeholder` is UI copy and should be. Sharing one
 * exclusion list between the text walk and the attribute pass meant no textarea
 * placeholder in the app was ever translated, including the composer's
 * "Message Juno…", which sat in the catalog untranslated the whole time. The
 * two decisions are `isExcludedFromTranslation(el)` and
 * `isExcludedFromTranslation(el, "attributes")` (auto-translate-filter.ts).
 */

/** The roots none of whose ancestors is also a root: walking those covers the rest. */
function outermost(roots: readonly Node[]): Node[] {
  return roots.filter((root) => !roots.some((other) => other !== root && other.contains(root)));
}

/**
 * Translates exact, build-time-known UI strings after hydration. The browser
 * sends only opaque catalog ids to the server, so conversations and all other
 * user content stay on the device.
 */
export function AutoTranslate({ locale, autoDetect = true }: { locale: string; autoDetect?: boolean }) {
  React.useEffect(() => {
    if (!document.body) return;
    // Accept-Language is the server source of truth. navigator.languages is a
    // client fallback for unusual proxies/webviews that strip that header —
    // hence `languageOf`, not `locale === "en"`: a stripped header resolves to
    // the bare "en" default, but so does a real "en-US", and the strict compare
    // rescued only the former. An explicit choice is never second-guessed.
    const navigatorLocale = navigator.languages?.length
      ? localeFromAcceptLanguage(navigator.languages.join(","))
      : locale;
    const activeLocale =
      autoDetect && languageOf(locale) === "en" && languageOf(navigatorLocale) !== "en" ? navigatorLocale : locale;

    // Set before the English bail-out: switching back to English must clear a
    // previous locale's lang/dir rather than leave the document mislabelled.
    // The phrase runtime and every Intl formatter follow the same locale.
    document.documentElement.lang = activeLocale;
    document.documentElement.dir = directionOf(activeLocale);
    setUiLocale(activeLocale);
    if (languageOf(activeLocale) === "en") return;

    // Everything from here on needs the catalog, so it is fetched once and the
    // rest of the effect runs inside. `stopped` is checked on the far side of
    // the await: an unmount during the fetch must not start a scanner.
    let cancelled = false;
    let teardown: (() => void) | null = null;
    void loadCatalog().then(({ sourceCatalog }) => {
      if (cancelled) return;
      teardown = start(sourceCatalog);
    });
    return () => {
      cancelled = true;
      teardown?.();
    };

    function start(sourceCatalog: Map<string, CatalogItem>) {
    let stopped = false;
    let scanTimer: ReturnType<typeof setTimeout> | null = null;
    // When the pending scanTimer will fire, so a sooner request can preempt it.
    let scanAt = Number.POSITIVE_INFINITY;
    let lastScanAt = 0;
    // The first scan, and the one after a translation batch lands, walk the
    // whole page; every other scan walks only what changed.
    let fullScan = true;
    const dirty = new Set<Node>();

    const wanted = (id: string) => !translationStore.isPending(id) && !translationStore.isFailed(id);

    const translateText = (textNode: Text, missing: Set<string>) => {
      if (!textNode.nodeValue) return;
      const { before, core, after } = splitWhitespace(textNode.nodeValue);
      const item = sourceCatalog.get(core);
      if (!item) return;
      const translated = translationStore.get(item.id);
      if (translated && translated !== core) textNode.nodeValue = `${before}${translated}${after}`;
      else if (!translated && wanted(item.id)) missing.add(item.id);
    };

    const translateAttributes = (element: Element, missing: Set<string>) => {
      for (const attribute of TRANSLATABLE_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        const item = sourceCatalog.get(value.replace(/\s+/g, " ").trim());
        if (!item) continue;
        const translated = translationStore.get(item.id);
        if (translated && translated !== value) element.setAttribute(attribute, translated);
        else if (!translated && wanted(item.id)) missing.add(item.id);
      }
    };

    /**
     * One pass over `root`: text and attributes together, and an excluded
     * subtree is pruned whole (FILTER_REJECT) instead of walked and then
     * skipped node by node — a streaming answer or a run clock is never
     * entered at all.
     */
    const walk = (root: Node, missing: Set<string>) => {
      if (root.nodeType === Node.TEXT_NODE) {
        if (!isExcludedFromTranslation(root.parentElement)) translateText(root as Text, missing);
        return;
      }
      if (root.nodeType !== Node.ELEMENT_NODE) return;
      const element = root as Element;
      if (!isExcludedFromTranslation(element, "attributes")) translateAttributes(element, missing);
      if (isExcludedFromTranslation(element)) return;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
          const child = node as Element;
          // Collected in the same pass. A textarea is pruned for its text
          // (what the user typed) but its placeholder is UI copy.
          if (!isExcludedFromTranslation(child, "attributes")) translateAttributes(child, missing);
          return isExcludedFromTranslation(child) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        },
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) translateText(node as Text, missing);
    };

    const scan = async () => {
      scanTimer = null;
      scanAt = Number.POSITIVE_INFINITY;
      if (stopped) return;
      lastScanAt = Date.now();
      const missing = new Set<string>();
      if (fullScan || dirty.size > MAX_DIRTY_ROOTS) {
        fullScan = false;
        dirty.clear();
        walk(document.body, missing);
      } else {
        const roots = outermost([...dirty]);
        dirty.clear();
        for (const root of roots) if (root.isConnected) walk(root, missing);
      }
      if (!missing.size) return;
      const cooldown = translationStore.cooldownMs();
      if (cooldown > 0) {
        fullScan = true;
        scheduleScan(cooldown);
        return;
      }
      // A batch that lands notifies the store, which schedules the full scan
      // that applies it (below).
      await translationStore.request([...missing]);
      if (stopped) return;
      // A throttled chunk left its ids missing; come back for them unprompted,
      // since a mutation may never arrive to trigger the next scan.
      const retry = translationStore.cooldownMs();
      if (retry > 0) {
        fullScan = true;
        scheduleScan(retry);
      }
    };

    const scheduleScan = (delay = SCAN_DELAY_MS) => {
      if (stopped) return;
      const now = Date.now();
      // At most four scans a second while anything streams.
      const busy = document.querySelector('[aria-busy="true"]') !== null;
      const wait = busy ? Math.max(delay, lastScanAt + BUSY_SCAN_INTERVAL_MS - now) : delay;
      const at = now + wait;
      if (scanTimer) {
        // Only bail for a request that would fire no sooner than the pending one.
        // A plain `if (scanTimer) return` let the 5-minute post-429 cooldown
        // swallow every ordinary scan behind it, so DOM rendered during those
        // minutes stayed English even when its translations were already cached
        // locally. Preempting is safe: scan() applies cached strings before it
        // consults the cooldown, so an early run issues no request and re-arms
        // the cooldown itself.
        if (at >= scanAt) return;
        clearTimeout(scanTimer);
      }
      scanAt = at;
      scanTimer = setTimeout(() => void scan(), wait);
    };

    scheduleScan();
    // A translation batch arriving (from this walker or from a `<Phrase>`)
    // re-walks the page once to apply it.
    const unsubscribe = translationStore.subscribe(() => {
      fullScan = true;
      scheduleScan();
    });
    // Mutations inside an excluded subtree — every streamed token, every clock
    // tick — are dropped here, before they can schedule anything.
    const observer = new MutationObserver((records) => {
      const roots = filterMutations(records as unknown as ReadonlyArray<MutationRecordLike & { target: Node; addedNodes?: ArrayLike<Node> }>);
      if (!roots.length) return;
      for (const root of roots) dirty.add(root);
      scheduleScan();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
    });

    // `start`'s own teardown, handed back to the effect's cleanup above.
    return () => {
      stopped = true;
      unsubscribe();
      observer.disconnect();
      if (scanTimer) clearTimeout(scanTimer);
    };
    }
  }, [locale, autoDetect]);

  return null;
}
