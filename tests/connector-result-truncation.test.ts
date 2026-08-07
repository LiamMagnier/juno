import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UNTRUSTED_CLOSE, wrapUntrusted } from "@/lib/untrusted-content";
import {
  admitConnectorResult,
  MAX_CONNECTOR_RESULT_CHARS,
  truncateConnectorResult,
  type InjectionScanner,
} from "@/lib/work/connectors";

/*
 * Connector output that did not fit, and what the model is told about it.
 *
 * The bug this pins is not that results are cut — they have to be, and the cap
 * is the smallest of several that apply. It is that the cut used to be a bare
 * `.slice(0, 30_000)` in `stringifyToolResult`: no marker, no notice, no flag.
 * The model read the front of an answer, had no way to know that was all it had,
 * and summarised it as the whole thing.
 *
 * So the properties worth holding are the honesty ones. The notice exists, it
 * says the true numbers, it fits inside the cap rather than hanging over the
 * edge where the next limit downstream would shave it off, and it is the same
 * sentence every other truncating input path in this repository uses.
 *
 * All of it is pure. `src/lib/mcp.ts` is `server-only` and cannot be imported by
 * a test at all, which is the reason the cut itself lives in work/connectors.ts;
 * that mcp.ts really routes through it is checked statically at the bottom.
 */

const clean: InjectionScanner = () => ({
  detected: false,
  severity: "none",
  signals: [],
  matchCount: 0,
  truncated: false,
});

/** The sentence, verbatim, as web_fetch and attachments already say it. */
const HOUSE_SENTENCE = "Do not describe the rest as though you have read it.";

// -------------------------------------------------------------------------
// 1. Nothing is done to a result that fits
// -------------------------------------------------------------------------

test("a result inside the cap is returned untouched and unflagged", () => {
  const content = "issue #412: the runner times out on cold start";
  const cut = truncateConnectorResult(content);

  assert.equal(cut.text, content);
  assert.equal(cut.truncated, false);
  assert.equal(cut.totalChars, content.length);
  assert.equal(cut.includedChars, content.length);
});

test("a result exactly at the cap is not truncated", () => {
  // The boundary is worth pinning in both directions: an off-by-one here either
  // annotates a complete result as partial — teaching the model to distrust a
  // whole answer — or lets one character through unannounced.
  const exact = "x".repeat(MAX_CONNECTOR_RESULT_CHARS);
  const atCap = truncateConnectorResult(exact);
  assert.equal(atCap.truncated, false);
  assert.equal(atCap.text, exact);

  const overCap = truncateConnectorResult(`${exact}x`);
  assert.equal(overCap.truncated, true);
});

// -------------------------------------------------------------------------
// 2. The model is told, in the result, in the established words
// -------------------------------------------------------------------------

test("an over-long result carries a notice saying it is a prefix", () => {
  const content = "a".repeat(MAX_CONNECTOR_RESULT_CHARS * 2);
  const cut = truncateConnectorResult(content);

  assert.equal(cut.truncated, true);
  assert.match(cut.text, /\[Cut off here\./);
  assert.ok(
    cut.text.includes(HOUSE_SENTENCE),
    "the notice must carry the sentence the model already knows from web_fetch and attachments"
  );
  // The instruction is useless if it is not at the end of what was read: a
  // marker in the middle is a marker the model can finish reading past.
  assert.ok(cut.text.trimEnd().endsWith("]"), "the notice closes the result");
});

test("the numbers in the notice are the true ones", () => {
  const content = "b".repeat(MAX_CONNECTOR_RESULT_CHARS + 5_000);
  const cut = truncateConnectorResult(content);

  // What it claims.
  assert.ok(cut.text.includes(`This result is ${cut.totalChars} characters long`));
  assert.ok(cut.text.includes(`only the first ${cut.includedChars} are above`));

  // What is actually there. A notice that overstates how much was included is
  // worse than no notice: it invites the model to trust a boundary that moved.
  assert.equal(cut.totalChars, content.length);
  assert.equal(cut.text.slice(0, cut.includedChars), content.slice(0, cut.includedChars));
  assert.ok(cut.includedChars < cut.totalChars);
});

test("the notice is paid for out of the cap, not appended past it", () => {
  // completeExternalAction in src/lib/action-approval-store.ts stores the result
  // for replay and slices it at 30,000 characters of its own accord. A notice
  // that pushed the text over the cap would be the part that got cut, and the
  // replayed call would receive exactly the silent prefix this exists to stop.
  for (const size of [MAX_CONNECTOR_RESULT_CHARS + 1, MAX_CONNECTOR_RESULT_CHARS * 3]) {
    const cut = truncateConnectorResult("c".repeat(size));
    assert.ok(
      cut.text.length <= MAX_CONNECTOR_RESULT_CHARS,
      `truncated result was ${cut.text.length} characters, over the ${MAX_CONNECTOR_RESULT_CHARS} cap`
    );
    assert.ok(cut.text.includes(HOUSE_SENTENCE));
  }
});

test("the notice survives being enveloped as untrusted content", () => {
  // mcp.ts truncates and then wraps. The notice must end up inside the envelope,
  // describing the block it belongs to, with the closing marker still after it.
  const cut = truncateConnectorResult("d".repeat(MAX_CONNECTOR_RESULT_CHARS * 2));
  const wrapped = wrapUntrusted("GitHub · search_issues", cut.text);

  assert.ok(wrapped.includes(HOUSE_SENTENCE));
  assert.ok(wrapped.trimEnd().endsWith(UNTRUSTED_CLOSE));
  assert.ok(wrapped.indexOf(HOUSE_SENTENCE) < wrapped.lastIndexOf(UNTRUSTED_CLOSE));
});

// -------------------------------------------------------------------------
// 3. The fact reaches the record, not just the model
// -------------------------------------------------------------------------

test("admitConnectorResult records whether the content was a prefix", () => {
  const base = {
    connectorId: "github",
    tool: "search_issues",
    callId: "call_1",
    label: "GitHub",
    access: "read" as const,
    locality: "cloud" as const,
    content: "…",
  };

  const partial = admitConnectorResult({ ...base, truncated: true }, clean);
  assert.equal(partial.io.detail.contentTruncated, true);

  // Unstated means whole, not unknown: every caller that truncates knows it did.
  const whole = admitConnectorResult(base, clean);
  assert.equal(whole.io.detail.contentTruncated, false);
});

// -------------------------------------------------------------------------
// 4. One sentence, one cut — statically
// -------------------------------------------------------------------------

test("every input path that truncates says the same sentence", () => {
  // Three call sites, one phrasing. A fourth wording would mean a model that has
  // learnt to respect this on pages and attachments has to learn it again for
  // connector results.
  for (const path of [
    "../src/lib/work/connectors.ts",
    "../runner/agent-core/src/work/tools.ts",
    "../scripts/work-runner.ts",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.ok(source.includes(HOUSE_SENTENCE), `${path} no longer uses the shared truncation sentence`);
  }
});

test("mcp.ts truncates through the annotated cut, not a bare slice", () => {
  const source = readFileSync(new URL("../src/lib/mcp.ts", import.meta.url), "utf8");

  assert.ok(
    source.includes("truncateConnectorResult"),
    "connector results must be cut by the function that leaves a notice behind"
  );
  // The regression that was shipped, in the shape it was shipped in. A silent
  // slice anywhere on this path is the whole bug returning.
  assert.equal(
    /\.slice\(\s*0\s*,\s*30_?000\s*\)/.test(source),
    false,
    "a bare 30,000-character slice is back in mcp.ts — it cuts without telling the model"
  );
});
