import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PhraseWithArgs, formatPhrase, phraseText, pluralPhrase } from "@/lib/i18n-phrase";
import type { PhraseLine } from "@/lib/run/types";

/*
 * The phrase runtime (SPEC §10.2).
 *
 * WS0 landed it working in English with no translation store; these are the
 * checks of that English path. WS5 owns this file and adds the store lookup by
 * source hash, and the other locales, when it wires the store.
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
