/**
 * Typed report specs -> markdown, and the same blocks -> print-ready HTML.
 *
 * The stored bytes of a `report` artifact are the markdown: `ARTIFACT_MIME`
 * maps the kind to `text/markdown`, and markdown is the form that survives
 * being pasted into a ticket, a wiki and an email. The HTML rendering exists
 * because "print this" and "read this as a page" are the two things markdown
 * cannot do on its own, and because `site.ts` needs exactly the same
 * block-to-HTML function — one renderer, so a table that lays out correctly in
 * a printed report lays out correctly in a published page.
 *
 * Both renderers escape. Markdown escaping is the less obvious of the two and
 * matters just as much: a figure written as `3 * 4 * 5` becomes `3 4 5` in
 * italics if the `*`s go through unescaped, and nothing downstream can tell
 * that the number was ever there. The HTML renderer emits no script, no inline
 * handler and no remote subresource — see `site.ts` for why that is a hard rule
 * rather than a default.
 */

import { z } from "zod";
import {
  assertRectangularTable,
  documentBlockSchema,
  toRuns,
  type DocumentBlock,
  type RichText,
  type TableBlock,
} from "@/lib/work/deliverables/document";
import { DeliverableError, type ProvenanceEntry } from "@/lib/work/deliverables/validate";

const MAX_BLOCKS = 5_000;

export const reportSpecSchema = z.object({
  kind: z.literal("report"),
  title: z.string().trim().min(1).max(300),
  subtitle: z.string().trim().max(300).optional(),
  /** One paragraph at the top, before the body. Rendered as a lead. */
  summary: z.string().trim().max(4_000).optional(),
  blocks: z.array(documentBlockSchema).min(1).max(MAX_BLOCKS),
});

export type ReportSpec = z.infer<typeof reportSpecSchema>;

export interface RenderedReport {
  /** The stored bytes of the artifact, before encoding. */
  markdown: string;
  /** A self-contained page with a print stylesheet. Never persisted today. */
  html: string;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * The five characters that change the meaning of HTML.
 *
 * `'` is escaped along with `"` because these strings are also interpolated
 * into attribute values, and an attribute quoted with single quotes is legal
 * HTML that a `"`-only escaper walks straight out of.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Characters that start or end inline markdown syntax. */
const MARKDOWN_INLINE = /[\\`*_[\]<>]/g;
/** Characters that turn a line into a block when they lead it. */
const MARKDOWN_LINE_START = /^(\s*)([#>+-]|\d+[.)])/;

function escapeMarkdownInline(value: string): string {
  return value.replace(MARKDOWN_INLINE, (char) => `\\${char}`);
}

/**
 * Escapes a line that would otherwise become a heading, quote or list item.
 *
 * The case this prevents: a paragraph whose text legitimately begins "1. Check
 * the invoice" renders as an ordered list, silently re-numbered from 1 by every
 * markdown renderer that reads it, so a report that referred to step 7 now says
 * step 1.
 */
function escapeMarkdownLineStart(value: string): string {
  return value.replace(MARKDOWN_LINE_START, (_match, indent: string, marker: string) => {
    const head = marker.slice(0, -1);
    const tail = marker.slice(-1);
    return `${indent}${head}\\${tail}`;
  });
}

/**
 * A run array as inline markdown.
 *
 * Code runs get a backtick fence long enough to contain whatever backticks the
 * text itself holds, which is the rule CommonMark specifies and the reason a
 * value like `` a`b `` does not tear the rest of the line apart.
 */
function inlineMarkdown(value: RichText): string {
  return toRuns(value)
    .map((run) => {
      if (run.code) {
        const longestRun = [...run.text.matchAll(/`+/g)].reduce(
          (longest, match) => Math.max(longest, match[0].length),
          0
        );
        const fence = "`".repeat(longestRun + 1);
        // A code span whose content starts or ends with a backtick needs the
        // padding spaces; CommonMark strips exactly one on each side.
        const pad = run.text.startsWith("`") || run.text.endsWith("`") ? " " : "";
        return `${fence}${pad}${run.text}${pad}${fence}`;
      }
      let text = escapeMarkdownInline(run.text);
      if (run.italic) text = `*${text}*`;
      if (run.bold) text = `**${text}**`;
      return text;
    })
    .join("");
}

/** A run array as inline HTML. Structural tags only; no style attributes. */
function inlineHtml(value: RichText): string {
  return toRuns(value)
    .map((run) => {
      let html = escapeHtml(run.text);
      if (run.code) html = `<code>${html}</code>`;
      if (run.italic) html = `<em>${html}</em>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      return html;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** A fence long enough that nothing in the block can close it early. */
function codeFence(lines: readonly string[]): string {
  const longest = lines.reduce((best, line) => {
    const match = /^\s*(`{3,})/.exec(line);
    return match ? Math.max(best, match[1].length) : best;
  }, 2);
  return "`".repeat(longest + 1);
}

function tableMarkdown(block: TableBlock): string[] {
  // A `|` inside a cell is what shears a row apart in every markdown table
  // parser there is, including the one in office-export.ts.
  const cell = (value: RichText) => inlineMarkdown(value).replace(/\|/g, "\\|");
  const lines = [
    `| ${block.header.map(cell).join(" | ")} |`,
    `| ${block.header.map(() => "---").join(" | ")} |`,
    ...block.rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
  return block.caption ? [`**${escapeMarkdownInline(block.caption)}**`, "", ...lines] : lines;
}

export function renderBlocksMarkdown(blocks: readonly DocumentBlock[], where: string): string {
  const out: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        out.push(`${"#".repeat(block.level)} ${inlineMarkdown(block.text)}`, "");
        break;
      case "paragraph":
        out.push(escapeMarkdownLineStart(inlineMarkdown(block.text)), "");
        break;
      case "list":
        block.items.forEach((item, index) => {
          out.push(`${block.ordered ? `${index + 1}.` : "-"} ${inlineMarkdown(item)}`);
        });
        out.push("");
        break;
      case "quote":
        out.push(`> ${inlineMarkdown(block.text)}`, "");
        break;
      case "code": {
        const fence = codeFence(block.lines);
        out.push(`${fence}${block.language ?? ""}`, ...block.lines, fence, "");
        break;
      }
      case "table":
        assertRectangularTable(block, where);
        out.push(...tableMarkdown(block), "");
        break;
      case "pageBreak":
        // Markdown has no page break. A thematic break is what every renderer
        // that paginates markdown turns into one, and it reads correctly in the
        // renderers that do not.
        out.push("---", "");
        break;
    }
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function tableHtml(block: TableBlock): string {
  const rows = [
    `<thead><tr>${block.header.map((cell) => `<th>${inlineHtml(cell)}</th>`).join("")}</tr></thead>`,
    `<tbody>${block.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell)}</td>`).join("")}</tr>`)
      .join("")}</tbody>`,
  ].join("");
  const caption = block.caption ? `<caption>${escapeHtml(block.caption)}</caption>` : "";
  // The wrapper is what stops a twelve-column table from forcing the whole page
  // to scroll sideways on a phone.
  return `<div class="table-scroll"><table>${caption}${rows}</table></div>`;
}

/**
 * Typed blocks as HTML, shared by the report page and every site page.
 *
 * Everything that came from the spec goes through `escapeHtml` or `inlineHtml`.
 * There is no branch that passes authored text through as markup, which is the
 * property `site.ts` depends on and `validate.ts` re-checks by scanning the
 * bundle it produced.
 */
export function renderBlocksHtml(blocks: readonly DocumentBlock[], where: string): string {
  const out: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const tag = `h${block.level}`;
        out.push(`<${tag}>${inlineHtml(block.text)}</${tag}>`);
        break;
      }
      case "paragraph":
        out.push(`<p>${inlineHtml(block.text)}</p>`);
        break;
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        out.push(`<${tag}>${block.items.map((item) => `<li>${inlineHtml(item)}</li>`).join("")}</${tag}>`);
        break;
      }
      case "quote":
        out.push(`<blockquote><p>${inlineHtml(block.text)}</p></blockquote>`);
        break;
      case "code": {
        const language = block.language ? ` data-language="${escapeHtml(block.language)}"` : "";
        out.push(`<pre${language}><code>${escapeHtml(block.lines.join("\n"))}</code></pre>`);
        break;
      }
      case "table":
        assertRectangularTable(block, where);
        out.push(tableHtml(block));
        break;
      case "pageBreak":
        out.push('<div class="page-break"></div>');
        break;
    }
  }

  return out.join("\n");
}

/**
 * The one stylesheet a report page carries.
 *
 * Inlined rather than linked because a report is handed to somebody as a single
 * file, and a linked stylesheet is a page that renders as unstyled text the
 * moment it leaves the machine that produced it. No `@import`, no web font, no
 * remote anything: the file has to render identically offline, and every remote
 * reference is also a beacon that tells its host when and where the report was
 * opened.
 */
export const PRINT_STYLESHEET = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 3rem 1.5rem; max-width: 46rem;
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #16181d; background: #fff;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2.2em 0 0.6em; font-weight: 650; }
h1 { font-size: 2rem; margin-top: 0; }
h2 { font-size: 1.45rem; }
h3 { font-size: 1.2rem; }
p { margin: 0 0 1em; }
.lead { font-size: 1.1rem; color: #3d434f; }
.meta { color: #6b7280; font-size: 0.9rem; margin: 0 0 2.5rem; }
ul, ol { margin: 0 0 1em; padding-left: 1.4em; }
li { margin: 0.25em 0; }
blockquote { margin: 0 0 1em; padding: 0.2em 0 0.2em 1em; border-left: 3px solid #d4d7dd; color: #40454f; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em;
  background: #f4f5f7; padding: 0.15em 0.35em; border-radius: 4px; }
pre { background: #f4f5f7; padding: 1em; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
.table-scroll { overflow-x: auto; margin: 0 0 1.4em; }
table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
caption { text-align: left; font-weight: 650; padding-bottom: 0.5em; }
th, td { border: 1px solid #dfe1e6; padding: 0.5em 0.7em; text-align: left; vertical-align: top; }
th { background: #f4f5f7; }
.page-break { height: 0; }
.sources { margin-top: 3rem; border-top: 1px solid #e3e5ea; padding-top: 1.2rem; font-size: 0.92rem; }
.sources h2 { font-size: 1.05rem; margin-top: 0; }
.sources li { margin: 0.4em 0; color: #40454f; }
.sources .kind { color: #6b7280; }
@media print {
  body { padding: 0; max-width: none; font-size: 11pt; }
  .page-break { break-after: page; page-break-after: always; }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  table, blockquote, pre { break-inside: avoid; page-break-inside: avoid; }
  a[href]::after { content: " (" attr(href) ")"; font-size: 0.85em; color: #555; }
}
@media (prefers-color-scheme: dark) {
  :root { color-scheme: dark; }
  body { color: #e7e9ee; background: #14161a; }
  .lead { color: #b9bec9; }
  .meta, .sources .kind { color: #8d94a2; }
  blockquote { border-left-color: #3a3f49; color: #b9bec9; }
  code, pre, th { background: #1e2128; }
  th, td { border-color: #2c313a; }
  .sources { border-top-color: #2c313a; }
}
`.trim();

/**
 * The sources block, rendered into the deliverable itself.
 *
 * `WorkArtifactVersion.provenance` is what the Juno UI cites, but a report is
 * a file that gets forwarded, and a claim that arrives without its sources
 * attached is a claim nobody downstream can check. Rendering them into the
 * document is the only way they travel with it.
 */
function sourcesMarkdown(provenance: readonly ProvenanceEntry[]): string[] {
  if (provenance.length === 0) return [];
  const lines = ["## Sources", ""];
  for (const entry of provenance) {
    const label = escapeMarkdownInline(entry.label);
    const where = entry.url ?? entry.ref;
    lines.push(`- ${label}${where ? ` — ${escapeMarkdownInline(where)}` : ""} (${entry.kind})`);
  }
  lines.push("");
  return lines;
}

function sourcesHtml(provenance: readonly ProvenanceEntry[]): string {
  if (provenance.length === 0) return "";
  const items = provenance
    .map((entry) => {
      // `escapeHtml` on the href is not enough on its own — a `javascript:` URL
      // is perfectly well-formed HTML — so only http(s) becomes a link and
      // everything else is rendered as inert text.
      const safeUrl = entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : null;
      const label = escapeHtml(entry.label);
      const body = safeUrl
        ? `<a href="${escapeHtml(safeUrl)}" rel="noreferrer noopener">${label}</a>`
        : label;
      const ref = entry.ref && !safeUrl ? ` — ${escapeHtml(entry.ref)}` : "";
      return `<li>${body}${ref} <span class="kind">(${escapeHtml(entry.kind)})</span></li>`;
    })
    .join("");
  return `<section class="sources"><h2>Sources</h2><ul>${items}</ul></section>`;
}

/**
 * Renders a report to both of its forms.
 *
 * The markdown is what is stored and downloaded; the HTML is what a print or
 * preview surface would use. Returning both from one call rather than exposing
 * two entry points is deliberate — they must be built from the same blocks in
 * the same pass, or a report prints something its markdown does not say.
 */
export function buildReport(spec: ReportSpec, provenance: readonly ProvenanceEntry[]): RenderedReport {
  const where = `report "${spec.title}"`;

  const head: string[] = [`# ${escapeMarkdownInline(spec.title)}`, ""];
  if (spec.subtitle) head.push(`*${escapeMarkdownInline(spec.subtitle)}*`, "");
  if (spec.summary) head.push(escapeMarkdownLineStart(escapeMarkdownInline(spec.summary)), "");

  const markdown = [
    ...head,
    renderBlocksMarkdown(spec.blocks, where),
    ...sourcesMarkdown(provenance),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat("\n");

  const body = [
    `<h1>${escapeHtml(spec.title)}</h1>`,
    spec.subtitle ? `<p class="meta">${escapeHtml(spec.subtitle)}</p>` : "",
    spec.summary ? `<p class="lead">${escapeHtml(spec.summary)}</p>` : "",
    renderBlocksHtml(spec.blocks, where),
    sourcesHtml(provenance),
  ]
    .filter((part) => part !== "")
    .join("\n");

  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // No referrer on the citation links: a report opened from a private folder
    // must not announce that folder's origin to every source it cites.
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(spec.title)}</title>`,
    `<style>${PRINT_STYLESHEET}</style>`,
    "</head>",
    `<body><main>${body}</main></body>`,
    "</html>",
    "",
  ].join("\n");

  if (markdown.trim() === "") {
    throw new DeliverableError("invalid_spec", `${where} rendered to nothing.`);
  }

  return { markdown, html };
}
