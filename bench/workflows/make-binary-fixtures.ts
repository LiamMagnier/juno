/**
 * Regenerates the three binary input fixtures of the workflow benchmark.
 *
 *   npx tsx bench/workflows/make-binary-fixtures.ts
 *   npm run bench:workflows -- manifest      # then re-freeze the hashes
 *
 * The fixtures are COMMITTED and frozen by bench/workflows/fixtures/MANIFEST.json:
 * every product in a comparison must be handed the same bytes, and OOXML
 * writers stamp the current time into the zip, so regenerating changes every
 * hash. Run this only to change a fixture on purpose, then re-run `manifest`
 * and say so in the commit. The PDF needs LibreOffice (`soffice`).
 *
 * The libraries used here (exceljs, docx) are input tooling only. Nothing in
 * the validators depends on them, and the product under test reads these
 * files with its own extractors.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AlignmentType, Document, HeadingLevel, Packer, PageBreak, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import ExcelJS from "exceljs";

const FILES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "files");

async function invoicesWorkbook(): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "workflow-bench fixture";
  wb.created = new Date("2026-10-01T00:00:00Z");
  wb.modified = new Date("2026-10-01T00:00:00Z");
  const sheet = wb.addWorksheet("Invoices");
  sheet.addRow(["id", "customer", "status", "amount_eur"]);
  const rows: Array<[string, string, string, number]> = [
    ["I01", "North", "paid", 125.5],
    ["I02", "South", "paid", 200],
    ["I03", "North", "unpaid", 80.25],
    ["I04", "West", "cancelled", 45],
    ["I05", "South", "paid", 64.5],
    ["I02", "South", "paid", 200],
    ["I06", "West", "unpaid", 30.75],
  ];
  for (const row of rows) sheet.addRow(row);
  const notes = wb.addWorksheet("Notes");
  notes.addRow(["Amounts are in EUR."]);
  notes.addRow(["Invoice I02 was exported twice by the billing system."]);
  writeFileSync(path.join(FILES, "invoices.xlsx"), Buffer.from(await wb.xlsx.writeBuffer()));
}

function cell(text: string, bold = false): TableCell {
  return new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })], width: { size: 33, type: WidthType.PERCENTAGE } });
}

async function meetingNotes(): Promise<void> {
  const doc = new Document({
    creator: "workflow-bench fixture",
    title: "Meridian follow-up — meeting notes",
    sections: [
      {
        children: [
          new Paragraph({ text: "Meridian follow-up — meeting notes 2026-10-01", heading: HeadingLevel.TITLE }),
          new Paragraph({ text: "Decisions", heading: HeadingLevel.HEADING_1 }),
          new Paragraph("The two-week follow-up pilot starts on 2026-10-05."),
          new Paragraph("The budget stays at EUR 2,400; no extra spend without the steering group."),
          new Paragraph({ text: "Action items", heading: HeadingLevel.HEADING_1 }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ children: [cell("Owner", true), cell("Action", true), cell("Due", true)] }),
              new TableRow({ children: [cell("Maya Okafor"), cell("Define the evaluation metrics"), cell("2026-10-08")] }),
              new TableRow({ children: [cell("Tom Becker"), cell("Confirm the EUR 2,400 budget with finance"), cell("2026-10-06")] }),
              new TableRow({ children: [cell("Léa Martin"), cell("Prepare the final review deck"), cell("2026-10-17")] }),
            ],
          }),
          new Paragraph({ text: "Open questions", heading: HeadingLevel.HEADING_1 }),
          new Paragraph("Whether the supplier's 6-hour claim can be checked against raw data."),
        ],
      },
    ],
  });
  writeFileSync(path.join(FILES, "meeting-notes.docx"), await Packer.toBuffer(doc));
}

async function pilotReportPdf(): Promise<void> {
  const doc = new Document({
    creator: "workflow-bench fixture",
    title: "Meridian pilot report",
    sections: [
      {
        children: [
          new Paragraph({ text: "Meridian pilot report", heading: HeadingLevel.TITLE }),
          new Paragraph("Summary: the pilot handled 100 requests per day with a median response time of 9 hours."),
          new Paragraph("The comparison with the baseline is observational and does not establish causality."),
          new Paragraph({ children: [new PageBreak()] }),
          new Paragraph({ text: "Governance", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            alignment: AlignmentType.LEFT,
            text: "Stop condition: the follow-up pilot stops if the error rate exceeds 4 percent.",
          }),
          new Paragraph("Final review: 2026-10-19. Evaluation owner: Maya Okafor."),
        ],
      },
    ],
  });
  const work = mkdtempSync(path.join(tmpdir(), "bench-fixture-"));
  try {
    const docx = path.join(work, "pilot-report.docx");
    writeFileSync(docx, await Packer.toBuffer(doc));
    const run = spawnSync(
      "soffice",
      [`-env:UserInstallation=file://${work}/profile`, "--headless", "--convert-to", "pdf", "--outdir", work, docx],
      { encoding: "utf8", timeout: 120_000 }
    );
    if (run.status !== 0) throw new Error(`soffice failed: ${run.stderr || run.error}`);
    renameSync(path.join(work, "pilot-report.pdf"), path.join(FILES, "pilot-report.pdf"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  await invoicesWorkbook();
  await meetingNotes();
  await pilotReportPdf();
  console.log(`Wrote invoices.xlsx, meeting-notes.docx and pilot-report.pdf to ${FILES}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
