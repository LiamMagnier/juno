"use client";

import * as React from "react";
import { UI_TRANSLATION_CATALOG } from "@/lib/i18n-catalog.generated";
import { directionOf, languageOf, localeFromAcceptLanguage } from "@/lib/i18n";

type CatalogItem = (typeof UI_TRANSLATION_CATALOG)[number];

const sourceCatalog = new Map<string, CatalogItem>(UI_TRANSLATION_CATALOG.map((item) => [item.source, item]));
const knownIds = new Set<string>(UI_TRANSLATION_CATALOG.map((item) => item.id));
const TRANSLATABLE_ATTRIBUTES = ["aria-label", "alt", "placeholder", "title"] as const;
const EXCLUDED_SELECTOR = [
  "[data-no-auto-translate]",
  "[translate='no']",
  "[contenteditable='true']",
  "code",
  "pre",
  "script",
  "style",
  "svg",
  "math",
  "textarea",
].join(",");

function splitWhitespace(value: string): { before: string; core: string; after: string } {
  const before = /^\s*/.exec(value)?.[0] ?? "";
  const after = /\s*$/.exec(value)?.[0] ?? "";
  return {
    before,
    core: value.slice(before.length, value.length - after.length).replace(/\s+/g, " "),
    after,
  };
}

function excluded(element: Element | null): boolean {
  return Boolean(element?.closest(EXCLUDED_SELECTOR));
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
    document.documentElement.lang = activeLocale;
    document.documentElement.dir = directionOf(activeLocale);
    if (languageOf(activeLocale) === "en") return;

    const storageKey = `juno:ui-translations:${activeLocale}:v1`;
    const translations = new Map<string, string>();
    const pending = new Set<string>();
    // Permanent: the model had nothing usable for this id, so retrying is waste.
    const failed = new Set<string>();
    // Transient (429/5xx): ids stay missing and are retried after this deadline.
    // Marking a throttled chunk `failed` stranded it for the effect's lifetime,
    // leaving the page permanently half-translated.
    let retryAfter = 0;

    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
      for (const [id, value] of Object.entries(stored)) {
        if (knownIds.has(id) && typeof value === "string") {
          translations.set(id, value);
        }
      }
    } catch {
      localStorage.removeItem(storageKey);
    }

    let stopped = false;
    let scanTimer: ReturnType<typeof setTimeout> | null = null;
    // When the pending scanTimer will fire, so a sooner request can preempt it.
    let scanAt = Number.POSITIVE_INFINITY;

    const persist = () => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(translations)));
      } catch {
        // Storage may be disabled/private; the CDN + in-memory server cache still help.
      }
    };

    const requestChunk = async (ids: string[]) => {
      ids.forEach((id) => pending.add(id));
      try {
        const params = new URLSearchParams({ locale: activeLocale, ids: [...ids].sort().join(",") });
        const res = await fetch(`/api/i18n/translations?${params}`, { credentials: "same-origin" });
        // Throttled, or the model walk is down — both recover on their own, so
        // leave these ids missing rather than burning them.
        if (res.status === 429 || res.status >= 500) {
          retryAfter = Date.now() + (res.status === 429 ? 5 * 60_000 : 30_000);
          return;
        }
        if (!res.ok) throw new Error(`translation request failed (${res.status})`);
        const data = (await res.json()) as { translations?: Record<string, unknown> };
        for (const id of ids) {
          const value = data.translations?.[id];
          if (typeof value === "string" && value.trim()) translations.set(id, value.trim());
          else failed.add(id);
        }
        persist();
      } catch {
        ids.forEach((id) => failed.add(id));
      } finally {
        ids.forEach((id) => pending.delete(id));
      }
    };

    const applyAndCollect = (root: Element): string[] => {
      const missing = new Set<string>();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const textNode = node as Text;
        const parent = textNode.parentElement;
        if (!excluded(parent) && textNode.nodeValue) {
          const { before, core, after } = splitWhitespace(textNode.nodeValue);
          const item = sourceCatalog.get(core);
          if (item) {
            const translated = translations.get(item.id);
            if (translated && translated !== core) textNode.nodeValue = `${before}${translated}${after}`;
            else if (!pending.has(item.id) && !failed.has(item.id)) missing.add(item.id);
          }
        }
        node = walker.nextNode();
      }

      const elements = [root, ...root.querySelectorAll("*")];
      for (const element of elements) {
        if (excluded(element)) continue;
        for (const attribute of TRANSLATABLE_ATTRIBUTES) {
          const value = element.getAttribute(attribute);
          if (!value) continue;
          const item = sourceCatalog.get(value.replace(/\s+/g, " ").trim());
          if (!item) continue;
          const translated = translations.get(item.id);
          if (translated && translated !== value) element.setAttribute(attribute, translated);
          else if (!pending.has(item.id) && !failed.has(item.id)) missing.add(item.id);
        }
      }
      return [...missing];
    };

    const scan = async () => {
      scanTimer = null;
      scanAt = Number.POSITIVE_INFINITY;
      if (stopped) return;
      const missing = applyAndCollect(document.body);
      if (!missing.length) return;
      const cooldown = retryAfter - Date.now();
      if (cooldown > 0) {
        scheduleScan(cooldown);
        return;
      }
      const chunks: string[][] = [];
      for (let i = 0; i < missing.length; i += 30) chunks.push(missing.slice(i, i + 30));
      await Promise.allSettled(chunks.map(requestChunk));
      if (stopped) return;
      applyAndCollect(document.body);
      // A throttled chunk left its ids missing; come back for them unprompted,
      // since a mutation may never arrive to trigger the next scan.
      const retry = retryAfter - Date.now();
      if (retry > 0) scheduleScan(retry);
    };

    const scheduleScan = (delay = 20) => {
      if (stopped) return;
      const at = Date.now() + delay;
      if (scanTimer) {
        // Only bail for a request that would fire no sooner than the pending one.
        // A plain `if (scanTimer) return` let the 5-minute post-429 cooldown
        // swallow every ordinary scan behind it, so DOM rendered during those
        // minutes stayed English even when its translations were already cached
        // locally. Preempting is safe: scan() applies cached strings before it
        // consults retryAfter, so an early run issues no request and re-arms the
        // cooldown itself.
        if (at >= scanAt) return;
        clearTimeout(scanTimer);
      }
      scanAt = at;
      scanTimer = setTimeout(() => void scan(), delay);
    };

    scheduleScan();
    // Wrapped: the observer would otherwise pass MutationRecord[] as `delay`.
    const observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
    });

    return () => {
      stopped = true;
      observer.disconnect();
      if (scanTimer) clearTimeout(scanTimer);
    };
  }, [locale, autoDetect]);

  return null;
}
