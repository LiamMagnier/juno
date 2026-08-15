/**
 * What a `report` looks like once the app's markdown renderer has had it.
 *
 * The interesting assertions here are the ones that FAIL on the raw file and
 * pass on the prepared one, because they are the reason
 * `src/lib/work/deliverables/report-preview.ts` exists at all. Both halves are
 * checked: the raw case is asserted to be broken, so that the day the chat
 * renderer stops corrupting reports this test says so instead of quietly
 * passing on a preparer nobody needs any more.
 *
 * Everything runs through the real `react-markdown` with the real plugins, not
 * against an AST this file poked at. A preview is HTML in a browser, and the
 * question a reader has — "does the figure in my table still say $1.2M" — is a
 * question about the rendered output. `renderToStaticMarkup` is the closest a
 * `tsx --test` process gets to that, and it is close enough to catch every
 * failure this module was written for.
 *
 * Two things the component keeps to itself — its plugin list and
 * `normalizeMathDelimiters` — are reproduced below because they are not
 * exported. A copy that drifts is worse than no test, so the first section is a
 * source check over `src/components/chat/markdown.tsx` asserting the properties
 * the copies depend on are still true of the original.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import {
  prepareReportPreview,
  REPORT_PREVIEW_MAX_CHARS,
} from "@/lib/work/deliverables/report-preview";
import { buildReport, type ReportSpec } from "@/lib/work/deliverables/report";

const CHAT_MARKDOWN = path.join(process.cwd(), "src/components/chat/markdown.tsx");

// ---------------------------------------------------------------------------
// 1. The renderer this module is written against
// ---------------------------------------------------------------------------

test("the chat renderer still has the three properties the preparer assumes", () => {
  const source = fs.readFileSync(CHAT_MARKDOWN, "utf8");

  // Why `$` becomes `&#36;`.
  assert.ok(
    /remarkMath/.test(source),
    "chat/markdown.tsx no longer uses remark-math; report-preview.ts escapes every $ to avoid it"
  );
  // Why `\[` becomes `&#91;`. This exact replacement is what turns report.ts's
  // escaped brackets into display math.
  assert.ok(
    source.includes('.replace(/\\\\\\[/g, "$$$$")'),
    "normalizeMathDelimiters no longer rewrites \\[ to $$; re-derive report-preview.ts's escape table"
  );
  // Why raw HTML never becomes markup. Checked across the whole app rather than
  // in this one component, because the plugin only has to be added SOMEWHERE
  // that shares the renderer for the property to stop holding. Matched on the
  // import rather than the name, so that prose about the plugin — this repo has
  // several paragraphs of it — does not read as a use of it.
  const root = path.join(process.cwd(), "src");
  const usesRehypeRaw = fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .filter((entry) =>
      /(from|import|require\()\s*["']rehype-raw["']/.test(fs.readFileSync(path.join(root, entry), "utf8"))
    );
  assert.deepEqual(
    usesRehypeRaw,
    [],
    "something now imports rehype-raw; report markdown would render as markup and the site frame's argument would apply to it"
  );
});

// ---------------------------------------------------------------------------
// 2. The renderer, reproduced
// ---------------------------------------------------------------------------

/** Copy of `normalizeMathDelimiters`, guarded by the source check above. */
function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) return markdown;
  return markdown
    .split("\n")
    .map((line) =>
      line
        .split(/(`[^`]*`)/g)
        .map((seg) =>
          seg.startsWith("`")
            ? seg
            : seg
                .replace(/\\\[/g, "$$$$")
                .replace(/\\\]/g, "$$$$")
                .replace(/\\\(/g, "$$")
                .replace(/\\\)/g, "$$")
        )
        .join("")
    )
    .join("\n");
}

const REMARK_PLUGINS = [remarkGfm, remarkMath] satisfies Options["remarkPlugins"];
const REHYPE_PLUGINS: Options["rehypePlugins"] = [
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
  [rehypeKatex, { throwOnError: false, output: "htmlAndMathml" }],
];

/** Markdown as the preview would paint it. */
function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS },
      normalizeMathDelimiters(markdown)
    )
  );
}

/**
 * What a reader sees: tags removed, and React's own text escaping undone.
 *
 * The second half matters as much as the first. React escapes `<`, `>`, `&`,
 * `"` and `'` when it writes a text node, so a report that legitimately
 * contains `alert("x")` arrives here as `alert(&quot;x&quot;)` — and a test
 * that compared the raw string would be asserting React's escaping rather than
 * what the preview says.
 */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// 3. The two corruptions, before and after
// ---------------------------------------------------------------------------

test("currency in a report is destroyed by the renderer and survives preparation", () => {
  const source = "Revenue was $1.2M in Q1 and $3.4M in Q2.";

  const raw = render(source);
  assert.ok(raw.includes("katex"), "expected the raw file to be typeset as math — the bug this fixes");
  assert.ok(!visibleText(raw).includes("$1.2M"), "the raw file loses its currency markers");

  const prepared = render(prepareReportPreview(source).markdown);
  assert.ok(!prepared.includes("katex"), "prepared markdown must reach no math renderer");
  assert.equal(visibleText(prepared).trim(), source);
});

test("brackets report.ts escaped are turned into display math and survive preparation", () => {
  // Exactly what `escapeMarkdownInline` writes for the text "See [note] below".
  const source = "See \\[note\\] below";

  const raw = render(source);
  assert.ok(raw.includes("katex"), "expected \\[…\\] to be read as LaTeX — the bug this fixes");

  const prepared = render(prepareReportPreview(source).markdown);
  assert.ok(!prepared.includes("katex"));
  assert.equal(visibleText(prepared).trim(), "See [note] below");
});

test("an escaped backslash before a bracket is not mistaken for an escaped bracket", () => {
  // `\\` is a literal backslash; the `[` after it opens a real link. Left as
  // the pair it is, the two characters `\[` sit in the output for
  // normalizeMathDelimiters' /\\\[/g to find.
  const source = "a \\\\[link](https://example.com/) b";

  // The raw file renders as `a $$link](https://example.com/) b`: the label is
  // gone, the link syntax is on screen as text, and the only reason a URL is
  // still clickable is remark-gfm autolinking the bare one that spilled out.
  assert.ok(visibleText(render(source)).includes("$$link]("), "expected the raw link to be eaten");

  const html = render(prepareReportPreview(source).markdown);
  assert.ok(html.includes('<a href="https://example.com/">link</a>'), "the link must survive whole");
  assert.ok(visibleText(html).includes("\\"), "the literal backslash must survive");
});

// ---------------------------------------------------------------------------
// 4. Images: the property the site bundle format has and markdown does not
// ---------------------------------------------------------------------------

test("an image is fetched on paint from the raw file and is a link after preparation", () => {
  const source = "![chart](https://tracker.example/beacon.png)";

  assert.ok(render(source).includes("<img"), "expected the raw file to load a remote image");

  const prepared = prepareReportPreview(source);
  assert.equal(prepared.imageRefs, 1);
  const html = render(prepared.markdown);
  assert.ok(!html.includes("<img"), "nothing may be fetched when the preview paints");
  assert.ok(html.includes('href="https://tracker.example/beacon.png"'), "the url stays reachable");
  assert.ok(visibleText(html).startsWith("!"), "the file's own ! is shown, not a substituted label");
});

test("a reference-style image is disarmed too", () => {
  const source = "![chart][src]\n\n[src]: https://tracker.example/beacon.png";
  assert.ok(render(source).includes("<img"));

  const prepared = prepareReportPreview(source);
  assert.equal(prepared.imageRefs, 1);
  assert.ok(!render(prepared.markdown).includes("<img"));
});

test("a dangerous link protocol is blanked, which is why links are left alone", () => {
  // report-preview.ts deliberately does not touch links, and the reason it can
  // afford not to is react-markdown's default `urlTransform`. Asserted here so
  // that the day a `urlTransform` override lands on the chat renderer, this
  // says so rather than the preparer silently becoming the last line.
  for (const href of ["javascript:alert(1)", "vbscript:msgbox", "data:text/html,<b>"]) {
    const html = render(prepareReportPreview(`[go](${href})`).markdown);
    assert.ok(html.includes('<a href="">'), `${href} must not survive as an href`);
  }
  // An ordinary citation is untouched: that is the point of not touching links.
  assert.ok(
    render(prepareReportPreview("[go](https://example.com/a)").markdown).includes(
      'href="https://example.com/a"'
    )
  );
});

// ---------------------------------------------------------------------------
// 5. Raw HTML
// ---------------------------------------------------------------------------

test("raw HTML in the stored bytes reaches the renderer as no HTML at all", () => {
  const source = '<script>alert(1)</script><img src="https://tracker.example/b.png" onerror="alert(2)">';

  // react-markdown hands a raw node to React as a string, so it already comes
  // out escaped. That is exactly the guarantee this module refuses to depend
  // on: it belongs to `hast-util-to-jsx-runtime`'s current treatment of `raw`,
  // several dependencies away from anything this repo controls.
  assert.equal(visibleText(render(source)).trim(), source);

  const prepared = prepareReportPreview(source);
  assert.ok(!prepared.markdown.includes("<"), "no markup may be handed over to be trusted with");

  const html = render(prepared.markdown);
  assert.ok(!html.includes("<script"), "no element may be produced");
  assert.ok(!html.includes("<img"), "no element may be produced");
  // The escaped form `onerror=&quot;` is text and is expected; an unescaped
  // quote after it would mean a real attribute.
  assert.ok(!html.includes('onerror="'), "no attribute may be produced");
  // And the reader still sees every character the file holds.
  assert.equal(visibleText(html).trim(), source);
});

// ---------------------------------------------------------------------------
// 6. Where the rewrite must not reach
// ---------------------------------------------------------------------------

test("code spans and fences are copied byte for byte", () => {
  const source = [
    "Prose with $5 and \\[brackets\\].",
    "",
    "Inline `awk '{print $5}'` and ``a`b`` stay put.",
    "",
    "```sh",
    "echo $HOME \\[not an escape\\]",
    "```",
  ].join("\n");

  const prepared = prepareReportPreview(source).markdown;
  assert.ok(prepared.includes("`awk '{print $5}'`"), "an inline code span must not be rewritten");
  assert.ok(prepared.includes("``a`b``"), "a two-backtick span must not be rewritten");
  assert.ok(prepared.includes("echo $HOME \\[not an escape\\]"), "a fenced block must not be rewritten");
  assert.ok(prepared.includes("&#36;5"), "prose outside the code must still be rewritten");

  // And a character reference must never end up INSIDE code, where it would be
  // shown as its eight literal characters.
  const html = render(prepared);
  assert.ok(!html.includes("&amp;#36;"), "no escaped reference may be visible");
  assert.ok(visibleText(html).includes("{print $5}"));
});

test("an unmatched backtick does not swallow the rest of the line", () => {
  const prepared = prepareReportPreview("a ` b $5 c").markdown;
  assert.ok(prepared.includes("&#36;5"), "text after a lone backtick is prose, not code");
});

// ---------------------------------------------------------------------------
// 7. Truncation
// ---------------------------------------------------------------------------

test("a long report is cut on a line boundary and says so", () => {
  const line = "x".repeat(500);
  const source = Array.from({ length: 1_000 }, () => line).join("\n");
  assert.ok(source.length > REPORT_PREVIEW_MAX_CHARS, "fixture must exceed the cap");

  const prepared = prepareReportPreview(source);
  assert.equal(prepared.truncated, true);
  assert.ok(prepared.markdown.length <= REPORT_PREVIEW_MAX_CHARS);
  // Cut between lines, never mid-line: every kept line is a whole one.
  for (const kept of prepared.markdown.split("\n")) assert.equal(kept, line);
});

test("a single line past the whole budget is cut rather than kept in full", () => {
  const prepared = prepareReportPreview("y".repeat(REPORT_PREVIEW_MAX_CHARS + 5_000));
  assert.equal(prepared.truncated, true);
  assert.equal(prepared.markdown.length, REPORT_PREVIEW_MAX_CHARS);
});

test("a report inside the budget is not marked truncated", () => {
  const prepared = prepareReportPreview("# Title\n\nA short report.\n");
  assert.equal(prepared.truncated, false);
  assert.equal(prepared.imageRefs, 0);
});

// ---------------------------------------------------------------------------
// 8. A real report, end to end
// ---------------------------------------------------------------------------

/**
 * Built by `buildReport` rather than hand-written, because the escaping this
 * module compensates for is that function's, and a fixture written by hand is a
 * fixture that stops matching the day `escapeMarkdownInline` changes.
 */
const SPEC: ReportSpec = {
  kind: "report",
  title: "Q1 figures",
  subtitle: "Draft for review",
  summary: "Revenue reached $1.2M against a $900k plan.",
  blocks: [
    { type: "heading", level: 2, text: "Notes" },
    { type: "paragraph", text: "See [note 3] for the $300k reclassification. 3 * 4 * 5 = 60." },
    { type: "paragraph", text: '<script>alert("x")</script> was in the source data.' },
    {
      type: "table",
      header: ["Line", "Q1"],
      rows: [
        ["Revenue", "$1.2M"],
        ["Plan", "$900k"],
      ],
    },
    { type: "code", language: "sh", lines: ["awk '{ total += $2 } END { print total }' ledger.tsv"] },
  ],
};

test("a real report renders in the preview saying what the file says", () => {
  const { markdown } = buildReport(SPEC, [
    { kind: "web_page", label: "Ledger export", url: "https://example.com/ledger" },
  ]);

  const prepared = prepareReportPreview(markdown);
  assert.equal(prepared.truncated, false);
  assert.equal(prepared.imageRefs, 0);

  const html = render(prepared.markdown);
  const text = visibleText(html);

  assert.ok(!html.includes("katex"), "nothing in a report is math");
  assert.ok(!html.includes("<img"), "nothing in a report is fetched on paint");
  assert.ok(!html.includes("<script"), "the payload is text");

  // The figures, with their currency markers intact.
  assert.ok(text.includes("$1.2M"));
  assert.ok(text.includes("$900k"));
  assert.ok(text.includes("$300k"));
  // The brackets report.ts escaped, back as brackets.
  assert.ok(text.includes("[note 3]"));
  // The multiplication `escapeMarkdownInline` protects from becoming italics.
  assert.ok(text.includes("3 * 4 * 5 = 60"));
  // The payload, visible as text rather than swallowed.
  assert.ok(text.includes('<script>alert("x")</script>'));
  // The code block's `$2`, untouched inside its fence.
  assert.ok(text.includes("{ total += $2 }"));
  // The citation, still a link a reviewer can follow.
  assert.ok(html.includes('href="https://example.com/ledger"'));
});

// ---------------------------------------------------------------------------
// 9. Which kinds are offered a preview at all
// ---------------------------------------------------------------------------

test("preview is offered for exactly the two kinds that guarantee something to show", async () => {
  const { canPreviewArtifact } = await import("@/components/work/work-site-preview");
  const { WORK_ARTIFACT_KINDS } = await import("@/lib/work/domain");

  assert.deepEqual(WORK_ARTIFACT_KINDS.filter(canPreviewArtifact), ["report", "site"]);

  // Named individually rather than by the filter above, so that adding a kind
  // to WORK_ARTIFACT_KINDS cannot quietly satisfy this test: the four refusals
  // below are arguments in `canPreviewArtifact`'s comment, and each is a claim
  // that this build cannot show that kind honestly.
  for (const refused of ["bundle", "archive", "document", "pdf"]) {
    assert.equal(canPreviewArtifact(refused), false, `${refused} has no guaranteed, faithful preview`);
  }
});
