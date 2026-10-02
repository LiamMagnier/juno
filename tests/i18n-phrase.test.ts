import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { UiLocaleOverride, setUiLocale } from "@/lib/i18n-format";
import {
  PhraseWithArgs,
  formatPhrase,
  phraseId,
  phraseText,
  pluralForm,
  pluralPhrase,
  setCatalogForTests,
  translationStore,
} from "@/lib/i18n-phrase";
import type { PhraseLine, PhraseSpec } from "@/lib/run/types";

/*
 * The phrase runtime (SPEC §10.2).
 *
 * WS0 landed it working in English with no translation store; WS5 wired the
 * store (AutoTranslate's, shared) behind the same functions. The English path
 * first, then the lookup by source hash, the other locales and the fetcher.
 */

test("the phrase runtime stays importable from client components", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/i18n-phrase.tsx"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
});

test("phrases and argument nodes, in plain text and as nodes", () => {
  const line: PhraseLine = [
    { parts: [{ phrase: "Searched the web for" }, { kind: "quote", value: "heat pump subsidies" }] },
    { parts: [{ kind: "count", n: 5, one: "result", other: "results" }] },
  ];
  assert.equal(phraseText(line), "Searched the web for “⁨heat pump subsidies⁩”. 5 results");
  assert.equal(pluralPhrase(1, { one: "source", other: "sources" }), "source");
  assert.equal(pluralPhrase(0, { one: "source", other: "sources" }), "sources");
  assert.equal(formatPhrase("Thinking"), "Thinking");

  const html = renderToStaticMarkup(React.createElement(PhraseWithArgs, { spec: line }));
  assert.match(html, /<span data-no-auto-translate="true">Searched the web for<\/span>/);
  assert.match(html, /<q translate="no" lang="" data-no-auto-translate="true"><bdi>heat pump subsidies<\/bdi><\/q>/);
  assert.match(html, /<span aria-hidden="true"> · <\/span>/);
  assert.match(html, /<span data-no-auto-translate="true">5<\/span> <span data-no-auto-translate="true">results<\/span>/);

  const long = "x".repeat(60);
  assert.equal(phraseText({ parts: [{ kind: "quote", value: long }] }), `“⁨${"x".repeat(39)}…⁩”`);
  assert.equal(
    phraseText({ parts: [{ kind: "file", value: "quarterly-report-final-version-2026.pdf" }] }),
    "⁨quarterly-report…ersion-2026.pdf⁩",
  );
});

// ── WS5: the translation store behind the same functions ──────────────────────

/** The catalog id of a source string, as the extractor computes it. */
function idOf(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16);
}

test("a phrase is looked up by its source hash in the store, per locale", () => {
  setCatalogForTests([
    { id: idOf("Thinking"), source: "Thinking" },
    { id: idOf("Searching the web for"), source: "Searching the web for" },
    { id: idOf("source"), source: "source" },
    { id: idOf("sources"), source: "sources" },
  ]);
  try {
    translationStore.seed("de", {
      [idOf("Thinking")]: "Denkt nach",
      [idOf("Searching the web for")]: "Sucht im Web nach",
      [idOf("source")]: "Quelle",
      [idOf("sources")]: "Quellen",
    });
    assert.equal(phraseId("Thinking"), idOf("Thinking"));
    assert.equal(phraseId("  Thinking \n"), idOf("Thinking"), "whitespace-collapsed like the extractor");
    assert.equal(formatPhrase("Thinking", "de"), "Denkt nach");
    assert.equal(formatPhrase("Thinking", "en"), "Thinking", "English never looks anything up");
    assert.equal(formatPhrase("Thinking", "fr"), "Thinking", "a locale with nothing cached stays English");
    assert.equal(formatPhrase("Not in the catalog", "de"), "Not in the catalog");

    // Whole-phrase plurals: the form is chosen in the locale, then translated.
    assert.equal(pluralPhrase(1, { one: "source", other: "sources" }, "de"), "Quelle");
    assert.equal(pluralPhrase(5, { one: "source", other: "sources" }, "de"), "Quellen");
    assert.equal(pluralForm(5, { one: "source", other: "sources" }, "de"), "sources", "the source form, for <Phrase>");

    // Arguments stay verbatim and isolated; phrases translate; specs join with ". ".
    const line: PhraseLine = [
      { parts: [{ phrase: "Searching the web for" }, { kind: "quote", value: "Wärmepumpe Förderung" }] },
      { parts: [{ kind: "count", n: 1_234, one: "source", other: "sources" }] },
    ];
    assert.equal(phraseText(line, "de"), "Sucht im Web nach “⁨Wärmepumpe Förderung⁩”. 1.234 Quellen");

    const html = renderToStaticMarkup(
      React.createElement(UiLocaleOverride.Provider, { value: "de" }, React.createElement(PhraseWithArgs, { spec: line })),
    );
    assert.match(html, /<span data-no-auto-translate="true">Sucht im Web nach<\/span>/);
    assert.match(html, /<bdi>Wärmepumpe Förderung<\/bdi>/);
    assert.match(html, /<span data-no-auto-translate="true">1\.234<\/span> <span data-no-auto-translate="true">Quellen<\/span>/);
  } finally {
    setCatalogForTests(null);
  }
});

test("plural categories other than one read as the other form", () => {
  // French: 0 and 1 are "one"; Polish: 2–4 are "few", which maps to `other`.
  assert.equal(pluralForm(0, { one: "source", other: "sources" }, "fr"), "source");
  assert.equal(pluralForm(0, { one: "source", other: "sources" }, "en"), "sources");
  assert.equal(pluralForm(3, { one: "source", other: "sources" }, "pl"), "sources");
  assert.equal(pluralForm(1, { one: "source", other: "sources" }, "not a locale"), "source");
});

test("every argument node reads in plain text, verbatim values isolated", () => {
  const spec = (parts: PhraseSpec["parts"]): PhraseSpec => ({ parts });
  assert.equal(phraseText(spec([{ kind: "domain", value: "example.org" }]), "en"), "⁨example.org⁩");
  assert.equal(phraseText(spec([{ kind: "label", value: "GitHub" }]), "en"), "⁨GitHub⁩");
  assert.equal(phraseText(spec([{ kind: "number", value: 12_500, approx: true }]), "en"), "~12,500");
  assert.equal(phraseText(spec([{ kind: "number", value: 12_500 }]), "de"), "12.500");
  assert.equal(phraseText(spec([{ kind: "duration", ms: 64_000, style: "narrow" }]), "en"), "1m 4s");
  assert.equal(phraseText(spec([{ kind: "date", iso: "2026-09-23T12:00:00Z", style: "medium" }]), "en"), "Sep 23, 2026");
  assert.match(phraseText(spec([{ kind: "time", iso: "2026-09-23T14:02:00" }]), "en-GB"), /^14:02$/);
  assert.equal(
    phraseText(spec([{ kind: "count", n: 1, one: "result", other: "results" }]), "en"),
    "1 result",
  );
  // An emoji at the cut is one grapheme, kept whole: 38 letters, the family, the ellipsis.
  const family = "👩‍👩‍👧‍👦";
  const emoji = `${"a".repeat(38)}${family}tail`;
  assert.equal(phraseText(spec([{ kind: "quote", value: emoji }]), "en"), `“⁨${"a".repeat(38)}${family}…⁩”`);
});

test("the store requests only the active locale, and never for English", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const ids = new URL(String(input), "https://juno.test").searchParams.get("ids")!.split(",");
    return new Response(JSON.stringify({ translations: Object.fromEntries(ids.map((id) => [id, `de:${id}`])) }), { status: 200 });
  }) as typeof fetch;
  try {
    setUiLocale("en");
    await translationStore.request(["a", "b"]);
    assert.equal(calls.length, 0, "English readers never ask");

    setUiLocale("de");
    const before = translationStore.version;
    const ids = Array.from({ length: 65 }, (_, i) => `id${i}`);
    await translationStore.request(ids);
    assert.equal(calls.length, 3, "chunks of 30");
    assert.ok(calls.every((url) => url.startsWith("/api/i18n/translations?locale=de&ids=")));
    assert.equal(translationStore.get("id64"), "de:id64");
    assert.ok(translationStore.version > before, "a landed batch notifies");

    await translationStore.request(ids);
    assert.equal(calls.length, 3, "cached ids are not asked again");
  } finally {
    globalThis.fetch = realFetch;
    setUiLocale("en");
  }
});

test("a throttled endpoint backs off instead of burning the ids", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("slow down", { status: 429 });
  }) as typeof fetch;
  try {
    setUiLocale("fr");
    await translationStore.request(["x1"]);
    assert.equal(calls, 1);
    assert.ok(translationStore.cooldownMs() > 60_000, "five minutes after a 429");
    assert.equal(translationStore.isFailed("x1"), false, "throttled ids stay missing, not failed");
    await translationStore.request(["x1"]);
    assert.equal(calls, 1, "nothing is asked during the back-off");
  } finally {
    globalThis.fetch = realFetch;
    setUiLocale("en");
  }
});
