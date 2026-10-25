/**
 * Offline plans for deliverable workflows: a FIXED spec — what a model that
 * read the fixtures correctly would author — handed to Alevr's own renderers.
 * The renderers are the product under test; the spec is the stand-in for the
 * model. The validators then open the bytes the renderer produced.
 *
 * Product modules are imported lazily so the catalog, runner and validators
 * stay importable without the product's server-only graph.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecutionContext } from "../runner";

const out = (ctx: ExecutionContext, name: string, bytes: Buffer | string) => writeFileSync(path.join(ctx.outputsDir, name), bytes);

/**
 * The product's own re-open verdict, kept beside (not inside) the outputs for
 * the report: it is the product grading itself, so it never decides a state —
 * the independent validators do.
 */
function keepProductVerdict(ctx: ExecutionContext, name: string, validation: { ok: boolean; problems: string[] }): void {
  writeFileSync(path.join(ctx.attemptDir, `product-validation.${name}.json`), `${JSON.stringify(validation, null, 2)}\n`);
}

export async function workDocument(ctx: ExecutionContext): Promise<void> {
  const { generateDeliverable } = await import("@/lib/work/deliverables");
  const result = await generateDeliverable({
    spec: {
      kind: "document",
      title: "Meridian follow-up pilot — decision memo",
      subtitle: "Prepared from the operations export and the 2026-09-30 decision",
      blocks: [
        { type: "heading", level: 1, text: "Decision" },
        { type: "paragraph", text: "The steering group approved a two-week follow-up pilot, not a full rollout." },
        { type: "heading", level: 1, text: "Evidence" },
        {
          type: "list",
          ordered: false,
          items: [
            "Request volume rose from 80 to 100 per day (+25%).",
            "Median response time fell from 12 to 9 hours (−25%).",
            "Error rate rose from 2% (8 of 400) to 3% (15 of 500).",
          ],
        },
        { type: "heading", level: 1, text: "Risks" },
        { type: "paragraph", text: "The comparison is observational: there was no random allocation and the customer mix differs, so the improvement is not causal evidence. The error rate rose." },
        { type: "heading", level: 1, text: "Next steps" },
        {
          type: "table",
          caption: "Ownership",
          header: ["Owner", "Budget", "Final review"],
          rows: [["Maya Okafor", "EUR 2,400", "2026-10-19"]],
        },
        { type: "paragraph", text: "Stop the follow-up pilot if the error rate exceeds 4 percent." },
      ],
    },
    provenance: [
      { kind: "file", label: "brief.md" },
      { kind: "file", label: "decision.md" },
    ],
  });
  keepProductVerdict(ctx, "memo.docx", result.validation);
  out(ctx, "memo.docx", result.bytes);
}

const FAQ_MARKDOWN = `# Meridian pilot — FAQ

## What did the pilot measure?

Requests rose from 80 to 100 per day (+25%) and the median response time fell from 12 to 9 hours.

## Did errors change?

Yes. The error rate went from 2% (8 of 400) to 3% (15 of 500).

## Was a full rollout approved?

No. A two-week follow-up pilot was approved, owned by Maya Okafor, with a budget of EUR 2,400.

## When does the follow-up stop?

If the error rate exceeds 4 percent. The final review is on 2026-10-19.

## Is the improvement causal?

No. There was no random allocation and the groups differ.
`;

export async function chatDocxExport(ctx: ExecutionContext): Promise<void> {
  const { toDocx } = await import("@/lib/office-export");
  out(ctx, "faq.docx", await toDocx(FAQ_MARKDOWN, "Meridian pilot — FAQ"));
}

export async function workReport(ctx: ExecutionContext): Promise<void> {
  const { generateDeliverable } = await import("@/lib/work/deliverables");
  const result = await generateDeliverable({
    spec: {
      kind: "report",
      title: "Meridian pilot report",
      summary: "The pilot raised request volume by 25% and cut the median response time by 25%, while the error rate rose from 2% to 3%. A two-week follow-up pilot was approved.",
      blocks: [
        { type: "heading", level: 2, text: "Findings" },
        {
          type: "table",
          header: ["Finding", "Value", "Source"],
          rows: [
            ["Request volume", "+25% (80 → 100 per day)", "brief.md"],
            ["Median response time", "−25% (12 → 9 hours)", "brief.md"],
            ["Error rate", "2% → 3%", "brief.md"],
            ["Supplier claim (verbatim, unverified)", "<script>alert('x')</script>", "supplier-note.md"],
          ],
        },
        { type: "heading", level: 2, text: "Limitations" },
        { type: "paragraph", text: "No random allocation; customer mix differs; five working days only." },
        { type: "heading", level: 2, text: "Sources" },
        { type: "list", ordered: false, items: ["brief.md — operations analytics export", "decision.md — approved decision, 2026-09-30", "supplier-note.md — external, unverified"] },
      ],
    },
    provenance: [
      { kind: "file", label: "brief.md" },
      { kind: "file", label: "decision.md" },
      { kind: "file", label: "supplier-note.md" },
    ],
  });
  if (!result.printableHtml) throw new Error("report: the product produced no printable HTML");
  out(ctx, "report.html", result.printableHtml);
  out(ctx, "report.md", result.bytes);
}

export async function semanticWorkbook(ctx: ExecutionContext): Promise<void> {
  const { normalizeWorkbook } = await import("@/lib/work/deliverables/semantic/workbook/model");
  const { exportWorkbookXlsx } = await import("@/lib/work/deliverables/semantic/workbook/xlsx");
  const model = normalizeWorkbook({
    kind: "spreadsheet",
    version: 1,
    title: "Meridian invoices",
    sheets: [
      {
        name: "Invoices",
        rows: [
          [{ v: "Invoice", bold: true }, { v: "Customer", bold: true }, { v: "Status", bold: true }, { v: "Amount EUR", bold: true }, null, { v: "Summary", bold: true }, { v: "EUR", bold: true }],
          ["I01", "North", "paid", { v: 125.5, fmt: "currency" }, null, "Paid", { f: '=SUMIF(C2:C7,"paid",D2:D7)', fmt: "currency" }],
          ["I02", "South", "paid", { v: 200, fmt: "currency" }, null, "Unpaid", { f: '=SUMIF(C2:C7,"unpaid",D2:D7)', fmt: "currency" }],
          ["I03", "North", "unpaid", { v: 80.25, fmt: "currency" }, null, "Total (excl. cancelled)", { f: "=G2+G3", fmt: "currency" }],
          ["I04", "West", "cancelled", { v: 45, fmt: "currency" }],
          ["I05", "South", "paid", { v: 64.5, fmt: "currency" }],
          ["I06", "West", "unpaid", { v: 30.75, fmt: "currency" }],
        ],
        freeze: { rows: 1 },
        charts: [{ type: "column", title: "Paid vs unpaid (EUR)", categories: "F2:F3", series: [{ name: "EUR", values: "G2:G3" }], anchor: { cell: "I2", cols: 8, rows: 14 } }],
      },
    ],
  });
  out(ctx, "invoices.xlsx", await exportWorkbookXlsx(model));
}

export async function workSpreadsheet(ctx: ExecutionContext): Promise<void> {
  const { generateDeliverable } = await import("@/lib/work/deliverables");
  const result = await generateDeliverable({
    spec: {
      kind: "spreadsheet",
      title: "Expenses September 2026",
      sheets: [
        {
          name: "Expenses",
          columns: [{ header: "Date", format: "date" }, { header: "Category", format: "text" }, { header: "Amount EUR", format: "number" }],
          rows: [
            [{ date: "2026-09-01T00:00:00.000Z" }, "travel", 120],
            [{ date: "2026-09-04T00:00:00.000Z" }, "software", 39],
            [{ date: "2026-09-10T00:00:00.000Z" }, "travel", 80.5],
            [{ date: "2026-09-12T00:00:00.000Z" }, "software", 39],
            [{ date: "2026-09-15T00:00:00.000Z" }, "meals", 25.5],
          ],
          freezeHeader: true,
        },
        {
          name: "Summary",
          columns: [{ header: "Category", format: "text" }, { header: "Total EUR", format: "number" }],
          rows: [["travel", 200.5], ["software", 78], ["meals", 25.5], ["Total", 304]],
          freezeHeader: true,
        },
      ],
    },
  });
  keepProductVerdict(ctx, "expenses.xlsx", result.validation);
  out(ctx, "expenses.xlsx", result.bytes);
}

const TOTALS_MARKDOWN = `Invoice totals (duplicate I02 counted once, cancelled I04 excluded):

| Status | Invoices | Amount EUR |
|---|---|---|
| Paid | 3 | 390.00 |
| Unpaid | 2 | 111.00 |
`;

export async function chatXlsxExport(ctx: ExecutionContext): Promise<void> {
  const { toXlsx } = await import("@/lib/office-export");
  out(ctx, "totals.xlsx", await toXlsx(TOTALS_MARKDOWN, "Invoice totals"));
}

export async function workPresentation(ctx: ExecutionContext): Promise<void> {
  const { generateDeliverable } = await import("@/lib/work/deliverables");
  const result = await generateDeliverable({
    spec: {
      kind: "presentation",
      title: "Meridian follow-up pilot",
      slides: [
        { layout: "title", title: "Meridian: run a follow-up pilot", subtitle: "Decision brief, 2026-09-30" },
        {
          layout: "bullets",
          title: "Evidence",
          bullets: [{ text: "Requests: 80 → 100 per day (+25%)" }, { text: "Median response: 12 → 9 hours (−25%)" }, { text: "Errors: 2% → 3%" }],
        },
        {
          layout: "bullets",
          title: "Caveats",
          bullets: [{ text: "Observational: no random allocation" }, { text: "Customer mix differs between groups" }, { text: "Only five working days measured" }],
        },
        { layout: "table", title: "Budget and ownership", header: ["Owner", "Budget", "Final review"], rows: [["Maya Okafor", "EUR 2,400", "2026-10-19"]] },
        {
          layout: "bullets",
          title: "Decision",
          bullets: [{ text: "Approve the two-week follow-up pilot, not a full rollout" }, { text: "Stop if the error rate exceeds 4%" }],
        },
      ],
    },
  });
  keepProductVerdict(ctx, "decision.pptx", result.validation);
  out(ctx, "decision.pptx", result.bytes);
}

export async function semanticDeck(ctx: ExecutionContext): Promise<void> {
  const { normalizeDeck } = await import("@/lib/work/deliverables/semantic/deck/model");
  const { exportDeckPptx } = await import("@/lib/work/deliverables/semantic/deck/pptx-export");
  const model = normalizeDeck({
    title: "Meridian pilot data",
    slides: [
      {
        layout: "title-content",
        title: "Baseline vs pilot",
        elements: [
          {
            type: "chart",
            chartType: "column",
            title: "Baseline vs pilot",
            categories: ["Requests per day", "Median response (h)"],
            series: [
              { name: "Baseline", values: [80, 12] },
              { name: "Pilot", values: [100, 9] },
            ],
            showLegend: true,
          },
        ],
      },
      {
        layout: "title-content",
        title: "Errors",
        elements: [{ type: "table", header: ["Period", "Errors", "Requests", "Rate"], rows: [["Baseline", "8", "400", "2%"], ["Pilot", "15", "500", "3%"]] }],
      },
    ],
  });
  out(ctx, "pilot-data.pptx", await exportDeckPptx(model));
}

export const MULTILINGUAL_LINES = ["Réunion à Paris — coût 12,50 €", "会議は東京で開催されます", "الاجتماع في دبي", "Grüße aus Köln", "🚀 launch"];

export async function multilingualExport(ctx: ExecutionContext): Promise<void> {
  const { toDocx, toPptx, toXlsx } = await import("@/lib/office-export");
  const prose = `# Note\n\n${MULTILINGUAL_LINES.map((l) => `- ${l}`).join("\n")}\n`;
  const table = `| Language | Text |\n|---|---|\n${["fr", "ja", "ar", "de", "emoji"].map((code, i) => `| ${code} | ${MULTILINGUAL_LINES[i]} |`).join("\n")}\n`;
  out(ctx, "note.docx", await toDocx(prose, "Multilingual note"));
  out(ctx, "note.xlsx", await toXlsx(table, "Multilingual note"));
  out(ctx, "note.pptx", await toPptx(prose, "Multilingual note"));
}
