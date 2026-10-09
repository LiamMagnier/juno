import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { layoutPageText, type PositionedItem } from "@/lib/search/pdf-layout";
import { assignedState, linkedDataToText, scriptBlobKind, stateToText } from "@/lib/web/embedded-data";
import { extractUrlDocument, type ExtractResult } from "@/lib/web/extract";
import { htmlToCleanText } from "@/lib/web/html-text";
import { renderTable } from "@/lib/web/html-table";

/*
 * Reading depth: what the extractor yields for the saved corpus in
 * tests/fixtures/reading (PDFs, data tables, JS-rendered pages), through the
 * same `extractUrlDocument` path research and chat use, with no network.
 * `tests/fixtures/reading/measure.ts` prints the same numbers for a person.
 */

const DIR = path.join(__dirname, "fixtures", "reading");

async function read(name: string): Promise<ExtractResult> {
  const bytes = readFileSync(path.join(DIR, name));
  const type = name.endsWith(".pdf") ? "application/pdf" : "text/html; charset=utf-8";
  const outcome = await extractUrlDocument(`https://fixture.example/${name}`, undefined, {
    maxChars: 60_000,
    transport: async () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } }),
  });
  assert.ok(outcome.ok, `${name}: ${JSON.stringify(!outcome.ok && outcome.failure)}`);
  return outcome.page;
}

function tableRows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => /^\|.*\|$/.test(line) && !/^\|(?:\s*---\s*\|)+$/.test(line))
    .map((line) => line.slice(1, -1).split(" | ").map((cell) => cell.trim()));
}

// ── HTML data tables ────────────────────────────────────────────────────────

test("a pricing table keeps its rows and columns, colspan repeated across the plans it covers", async () => {
  const page = await read("pricing-table.html");
  const rows = tableRows(page.text);
  assert.deepEqual(rows[0], ["Feature", "Free", "Team", "Business", "Enterprise"]);
  assert.deepEqual(rows.find((row) => row[0] === "Price per seat"), ["Price per seat", "$0", "$12 /mo", "$24 /mo", "Contact sales"]);
  // colspan=2: the 6,000 belongs to Business AND Enterprise.
  assert.deepEqual(rows.find((row) => row[0] === "API requests per minute"), ["API requests per minute", "60", "600", "6,000", "6,000"]);
  // Prose around the table and the chrome rule are unchanged.
  assert.match(page.text, /Annual billing saves 20%/);
  assert.doesNotMatch(page.text, /Privacy/);
});

test("a headerless key/value spec table becomes a list, rowspan carried down, and a <dl> pairs terms with values", async () => {
  const page = await read("spec-sheet.html");
  assert.match(page.text, /^- Memory: 16 GB unified memory, configurable to 32 GB$/m);
  assert.match(page.text, /^- Weight: 1\.42 kg \(Wi-Fi\)$/m);
  assert.match(page.text, /^- Weight: 1\.47 kg \(5G\)$/m);
  assert.match(page.text, /^- HDMI: HDMI 2\.1, up to 8K at 60 Hz$/m);
});

test("renderTable: multi-row headers join per column, layout tables fall back to paragraphs, pipes are escaped", () => {
  const cell = (text: string, header = false, colspan = 1) => ({ text, header, colspan, rowspan: 1 });
  const md = renderTable([
    { head: true, cells: [cell("", true), cell("Pro", true, 2)] },
    { head: true, cells: [cell("Metric", true), cell("Monthly", true), cell("Annual", true)] },
    { head: false, cells: [cell("Price"), cell("$20"), cell("$16 \\| billed yearly")] },
  ]);
  assert.equal(md, "| Metric | Pro — Monthly | Pro — Annual |\n| --- | --- | --- |\n| Price | $20 | $16 \\| billed yearly |");
  // One column, or cells that are paragraphs: layout, not data.
  assert.equal(renderTable([{ head: false, cells: [cell("only")] }, { head: false, cells: [cell("column")] }]), null);
  const prose = "word ".repeat(80).trim();
  assert.equal(renderTable([{ head: false, cells: [cell(prose), cell(prose)] }, { head: false, cells: [cell(prose), cell(prose)] }]), null);
});

test("hostile tables stay bounded: a million cells and absurd spans cost linear time and a capped grid", () => {
  const row = `<tr>${"<td colspan=99999 rowspan=99999>9</td>".repeat(50)}</tr>`;
  const html = `<html><body><table>${row.repeat(4000)}</table><p>${"tail ".repeat(200)}</p></body></html>`;
  // Linear time is well under a second here; a quadratic walk takes minutes.
  // The best of three runs under a generous bound, because release builds run
  // this under amd64 emulation beside other work, where one run can stall.
  let text = "";
  let best = Infinity;
  for (let attempt = 0; attempt < 3 && best >= 8_000; attempt++) {
    const started = performance.now();
    text = htmlToCleanText(html).text;
    best = Math.min(best, performance.now() - started);
  }
  assert.ok(best < 8_000, `best of three runs took ${Math.round(best)} ms`);
  const widest = Math.max(...text.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split(" | ").length));
  assert.ok(widest <= 24, `columns capped, saw ${widest}`);
  assert.ok(text.split("\n").filter((l) => l.startsWith("|")).length <= 302);
  assert.match(text, /tail tail/);
});

test("an unclosed table and nested tables still read: the inner table's text flows into its cell", () => {
  const { text } = htmlToCleanText(
    "<html><body><p>Intro paragraph long enough to be text.</p><table><tr><th>Plan</th><th>Limits</th></tr><tr><td>Pro</td><td><table><tr><td>500</td><td>requests</td></tr></table></td></tr><tr><td>Max</td><td>2,000 requests"
  );
  const rows = tableRows(text);
  assert.deepEqual(rows[0], ["Plan", "Limits"]);
  assert.deepEqual(rows[1], ["Pro", "500 requests"]);
  assert.deepEqual(rows[2], ["Max", "2,000 requests"]);
});

// ── JS-rendered pages ───────────────────────────────────────────────────────

test("a Next.js shell is read from __NEXT_DATA__: the plans become a table, plumbing is left out", async () => {
  const page = await read("next-data.html");
  assert.equal(page.shell, false, "recovered text is the page; no headless render needed");
  const rows = tableRows(page.text);
  assert.deepEqual(rows[0], ["Name", "Price", "Period", "Description"]);
  assert.deepEqual(rows.find((row) => row[0] === "Teams")?.slice(0, 3), ["Teams", "$40", "per user per month"]);
  assert.match(page.text, /A request is one message sent to a premium model/);
  assert.doesNotMatch(page.text, /buildId|x1y2z3|_next\/static|scriptLoader/);
});

test("app state from window.__INITIAL_STATE__ and a JSON island is read; secrets-shaped values are not", async () => {
  const page = await read("app-state.html");
  assert.match(page.text, /\| 2026-08-21 \| Elevated error rates on the EU region \| major \| 2h 14m \|/);
  assert.match(page.text, /\| Scale \| 3000 \| 6000 \|/);
  assert.match(page.text, /99\.95%/);
  assert.doesNotMatch(page.text, /d41d8cd98f00b204e9800998ecf8427e/);
});

test("JSON-LD fills a client-rendered product page: offers with prices, rating, FAQ", async () => {
  const page = await read("jsonld-product.html");
  assert.match(page.text, /\| Black \| 349\.00 \| USD \| InStock \|/);
  assert.match(page.text, /\| Silver \| 369\.00 \| USD \| PreOrder \|/);
  assert.match(page.text, /Rating: 4\.6 from 1287 reviews/);
  assert.match(page.text, /Q: Does the Orbit Pro support aptX\?\nA: Yes, aptX Adaptive and LDAC/);
});

test("a news article's JSON-LD supplies the body, the date and the author the markup did not render", async () => {
  const page = await read("jsonld-article.html");
  assert.match(page.text, /fined the grid operator EUR 4\.2 million/);
  assert.equal(page.publishedAt?.toISOString(), "2026-05-02T06:30:00.000Z");
  assert.equal(page.author, "Maria Keller");
  assert.equal(page.shell, false);
});

test("a shell with nothing but configuration stays a shell (the headless path, when enabled, decides)", async () => {
  const bytes = readFileSync(path.join(DIR, "empty-spa.html"));
  const outcome = await extractUrlDocument("https://fixture.example/empty-spa.html", undefined, {
    transport: async () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.deepEqual(outcome, { ok: false, failure: { reason: "empty_document", shell: true } });
});

test("server-rendered pages are not padded with their own hydration state", () => {
  const body = `<p>${"Server rendered sentence with real words. ".repeat(30)}</p>`;
  const html = `<html><body><div id="__next">${body}</div><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"note":"Hydration copy of the same page text for the client."}}}</script></body></html>`;
  const parsed = htmlToCleanText(html);
  assert.doesNotMatch(parsed.text, /Hydration copy/);
  assert.equal(parsed.recovered, undefined);
});

test("embedded data parsing is bounded and never throws", () => {
  assert.equal(scriptBlobKind("application/ld+json", undefined), "ld");
  assert.equal(scriptBlobKind("text/javascript", "__NEXT_DATA__"), "state");
  assert.equal(scriptBlobKind("module", "app"), null);
  // Only a lone assignment of a JSON literal; code after it is not state.
  assert.deepEqual(assignedState('window.__STATE__ = {"a":1};'), { json: '{"a":1}', name: "__STATE__" });
  assert.equal(assignedState('window.__STATE__ = {"a":1}; fetch("/x")'), null);
  assert.equal(assignedState("var x = 1"), null);
  // Broken and hostile JSON: nothing, no throw.
  assert.equal(stateToText([{ kind: "state", body: "{not json" }]), "");
  const deep = "[".repeat(200_000) + "]".repeat(200_000);
  assert.equal(stateToText([{ kind: "state", body: deep }]), "");
  assert.deepEqual(linkedDataToText([{ kind: "ld", body: "[[[[" }]), { text: "" });
  const wide = JSON.stringify({ items: Array.from({ length: 50_000 }, (_, i) => ({ name: `Item ${i}`, price: i })) });
  const started = performance.now();
  const text = stateToText([{ kind: "state", body: wide }]);
  assert.ok(performance.now() - started < 3_000);
  assert.ok(text.length <= 41_000);
});

// ── PDFs ────────────────────────────────────────────────────────────────────

test("a single-column PDF report reads in order, with paragraph breaks the passage splitter can use", async () => {
  const page = await read("report.pdf");
  assert.equal(page.contentType, "pdf");
  assert.match(page.text, /Installed capacity reached 32\.4 GW at the end of the year, up from 29\.1 GW a year earlier,\nwhile peak demand/);
  assert.ok(page.text.split(/\n{2,}/).length >= 5, "paragraphs separated by blank lines");
  assert.equal(page.author, "Grid Operator");
});

test("a two-column PDF written line by line across the gutter reads left column, then right", async () => {
  const page = await read("two-column.pdf");
  const left = page.text.indexOf("Transformer models trained on the corpus reach\n71.3 percent exact match");
  const right = page.text.indexOf("Inference cost scales linearly with context\nlength up to 128,000 tokens");
  assert.ok(left >= 0 && right > left, page.text);
  assert.doesNotMatch(page.text, /reach Inference/);
});

test("a PDF pricing grid becomes a Markdown table with the header row", async () => {
  const page = await read("pricing-table.pdf");
  const rows = tableRows(page.text);
  assert.deepEqual(rows[0], ["Plan", "Price per seat", "Included seats", "Storage"]);
  assert.deepEqual(rows.find((row) => row[0] === "Business"), ["Business", "$24 per month", "50", "1 TB"]);
  assert.match(page.text, /Monthly billing adds 20 percent\.\n\n\| Plan/);
});

test("layoutPageText falls back to stream order for rotated text and keeps prose lines intact", () => {
  const item = (str: string, x: number, y: number, extra: Partial<PositionedItem> = {}): PositionedItem => ({ str, x, y, width: str.length * 5, height: 10, ...extra });
  assert.equal(layoutPageText([item("B", 300, 700, { upright: false, hasEOL: true }), item("A", 50, 700)]), "B\nA");
  // Word-spaced items on one baseline join with single spaces.
  assert.equal(layoutPageText([item("Revenue", 72, 700), item("rose", 110, 700), item("4%.", 135, 700)]), "Revenue rose 4%.");
  assert.equal(layoutPageText([]), "");
});
