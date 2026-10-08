/**
 * Builds the PDF half of the reading-depth corpus (`tests/reading-depth.test.ts`).
 *
 * Run once with `npx tsx tests/fixtures/reading/build-pdfs.ts`; the output is
 * checked in beside this file so the test reads bytes, not a builder. Every
 * PDF is a real document (correct xref offsets, a Helvetica text layer) whose
 * text is placed with absolute `Tm` positions, the way producers lay out
 * columns and tables, so pdf.js hands the extractor positioned text items
 * exactly as it does for a document downloaded from the web:
 *
 * - `report.pdf`: two pages of single-column prose with headings (the control).
 * - `two-column.pdf`: a two-column paper whose content stream is written line
 *   by line ACROSS the columns (left line 1, right line 1, left line 2…), the
 *   order several typesetters emit and the one a naive join turns into
 *   alternating half-sentences.
 * - `pricing-table.pdf`: a ruled-less pricing grid, one text object per cell,
 *   row by row, between two paragraphs.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

interface Run {
  x: number;
  y: number;
  text: string;
  size?: number;
}

function escapePdf(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function stream(runs: readonly Run[]): string {
  return runs
    .map((run) => `BT /F1 ${run.size ?? 10} Tf 1 0 0 1 ${run.x} ${run.y} Tm (${escapePdf(run.text)}) Tj ET`)
    .join("\n")
    .concat("\n");
}

export function buildPositionedPdf(pages: ReadonlyArray<readonly Run[]>, info: Record<string, string> = {}): Uint8Array {
  const objects: string[] = [];
  const pageObj = (i: number) => 4 + i * 2;
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
  pages.forEach((runs, i) => {
    const content = stream(runs);
    objects.push(
      `${pageObj(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>\nendobj\n`
    );
    objects.push(`${pageObj(i) + 1} 0 obj\n<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream\nendobj\n`);
  });
  let trailerExtras = "";
  if (Object.keys(info).length) {
    const num = objects.length + 1;
    objects.push(`${num} 0 obj\n<< ${Object.entries(info).map(([k, v]) => `/${k} (${escapePdf(v)})`).join(" ")} >>\nendobj\n`);
    trailerExtras = ` /Info ${num} 0 R`;
  }
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += obj;
  }
  const startxref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtras} >>\nstartxref\n${startxref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/** Words wrapped to `width` characters, one positioned run per line. */
function paragraph(text: string, x: number, top: number, width: number, leading = 13): { runs: Run[]; bottom: number } {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > width) {
      lines.push(line.trim());
      line = word;
    } else line = `${line} ${word}`;
  }
  if (line.trim()) lines.push(line.trim());
  return { runs: lines.map((l, i) => ({ x, y: top - i * leading, text: l })), bottom: top - lines.length * leading };
}

const REPORT_P1 = [
  "This annual review covers the network operator's capacity, reliability and pricing for the 2025 financial year.",
  "Installed capacity reached 32.4 GW at the end of the year, up from 29.1 GW a year earlier, while peak demand was 27.8 GW on 14 January.",
  "Unplanned outages fell to 1.9 percent of available hours, the lowest figure since the operator began publishing the series in 2016.",
];
const REPORT_P2 = [
  "The regulator approved a standing charge of 0.42 EUR per day for domestic customers, effective 1 April 2025.",
  "Transmission losses were 2.1 percent of energy delivered, against a regulatory target of 2.5 percent.",
];

function reportPdf(): Uint8Array {
  const page1: Run[] = [{ x: 72, y: 740, text: "Annual Network Review 2025", size: 16 }];
  let top = 710;
  for (const p of REPORT_P1) {
    const { runs, bottom } = paragraph(p, 72, top, 90);
    page1.push(...runs);
    top = bottom - 12;
  }
  const page2: Run[] = [{ x: 72, y: 740, text: "Tariffs and losses", size: 14 }];
  top = 712;
  for (const p of REPORT_P2) {
    const { runs, bottom } = paragraph(p, 72, top, 90);
    page2.push(...runs);
    top = bottom - 12;
  }
  return buildPositionedPdf([page1, page2], { Title: "Annual Network Review 2025", Author: "Grid Operator", CreationDate: "D:20250610120000Z" });
}

const LEFT =
  "Transformer models trained on the corpus reach 71.3 percent exact match on the held-out split. The gain over the recurrent baseline is largest on questions that need two or more hops of reasoning across documents.";
const RIGHT =
  "Inference cost scales linearly with context length up to 128,000 tokens. Beyond that length the retrieval variant is cheaper by a factor of 3.2 while losing only 0.4 points of accuracy on the same split.";

function twoColumnPdf(): Uint8Array {
  const left = paragraph(LEFT, 54, 700, 46).runs;
  const right = paragraph(RIGHT, 318, 700, 46).runs;
  const runs: Run[] = [{ x: 150, y: 750, text: "Retrieval at Scale: Results", size: 14 }];
  // Line by line across the gutter: the hard order.
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i]) runs.push(left[i]!);
    if (right[i]) runs.push(right[i]!);
  }
  return buildPositionedPdf([runs]);
}

export const PRICING_ROWS = [
  ["Plan", "Price per seat", "Included seats", "Storage"],
  ["Free", "$0", "1", "5 GB"],
  ["Team", "$12 per month", "10", "100 GB"],
  ["Business", "$24 per month", "50", "1 TB"],
  ["Enterprise", "Contact sales", "Unlimited", "Unlimited"],
];

function pricingTablePdf(): Uint8Array {
  const runs: Run[] = [{ x: 72, y: 740, text: "Acme Cloud pricing, effective 1 March 2026", size: 14 }];
  runs.push(...paragraph("All prices are per seat per month, billed annually. Monthly billing adds 20 percent.", 72, 712, 90).runs);
  const columns = [72, 190, 330, 450];
  PRICING_ROWS.forEach((row, r) => {
    row.forEach((cell, c) => runs.push({ x: columns[c]!, y: 660 - r * 18, text: cell }));
  });
  runs.push(...paragraph("Seats above the included number are billed at the plan's per-seat price.", 72, 548, 90).runs);
  return buildPositionedPdf([runs]);
}

if (process.argv[1] && /build-pdfs\.ts$/.test(process.argv[1])) {
  const dir = path.dirname(process.argv[1]);
  writeFileSync(path.join(dir, "report.pdf"), reportPdf());
  writeFileSync(path.join(dir, "two-column.pdf"), twoColumnPdf());
  writeFileSync(path.join(dir, "pricing-table.pdf"), pricingTablePdf());
  console.log("wrote report.pdf, two-column.pdf, pricing-table.pdf");
}
