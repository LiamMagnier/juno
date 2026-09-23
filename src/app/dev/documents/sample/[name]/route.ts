import { NextResponse } from "next/server";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { Workbook } from "exceljs";
import { buildSampleReport } from "../sample-pdf";
import { extractDocx } from "@/lib/knowledge/extract/docx";
import { extractPptx } from "@/lib/knowledge/extract/pptx";
import { readSheets, toReaderBlocks } from "@/lib/documents/reader-blocks";
import { loadCanvas, renderDocumentPage } from "@/lib/media/raster";
import type { ReaderDocument } from "@/lib/documents/reader-types";

export const runtime = "nodejs";

/**
 * Sample files for the dev document gallery (`/dev/documents`). 404 outside
 * development, like the gallery itself.
 *
 * Every sample is generated, not checked in, and the reading-view and preview
 * answers are produced by the REAL extractors and renderer — so the gallery
 * shows what a real upload of each format would look like, not a mock of it.
 * The gallery's fetch shim maps `/api/attachments/dev-*` onto these names.
 */

const para = (text: string, style?: string, numbered = false) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${numbered ? "<w:numPr/>" : ""}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const pageBreak = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;

async function sampleDocx(): Promise<Uint8Array> {
  const body = [
    para("Quarterly review — Q3 2026", "Title"),
    para("Summary", "Heading1"),
    para("Revenue grew 18% quarter on quarter, driven by the enterprise tier. Churn fell for the third quarter running, and net revenue retention reached 124%."),
    para("Highlights", "Heading2"),
    para("Enterprise seats up 31%", undefined, true),
    para("Gross margin steady at 78%", undefined, true),
    para("Support backlog cleared by week 9", undefined, true),
    pageBreak,
    para("Revenue by region", "Heading1"),
    "<w:tbl>" +
      [
        ["Region", "Q2", "Q3", "Change"],
        ["North America", "4.1M", "4.9M", "+19%"],
        ["Europe", "2.6M", "3.0M", "+15%"],
        ["Asia-Pacific", "1.2M", "1.5M", "+25%"],
      ]
        .map((row) => `<w:tr>${row.map((c) => `<w:tc>${para(c)}</w:tc>`).join("")}</w:tr>`)
        .join("") +
      "</w:tbl>",
    para("Asia-Pacific remains the smallest region but the fastest growing; the Singapore office opened in August."),
    pageBreak,
    para("Risks", "Heading1"),
    para("Two of the five largest customers renew in Q1. Both are in active expansion conversations, but a loss of either would take roughly 6% off annual recurring revenue."),
  ].join("");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

async function samplePptx(): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  const slides: Array<[string, string[], string]> = [
    ["K3 launch plan", ["Private beta: October", "Public launch: November 18", "Pricing: usage-based"], "Open with the latency chart."],
    ["Why sparse retrieval", ["10x cheaper to serve", "Explainable matches", "Within 1 point of dense recall"], "Keep this to one minute."],
    ["Risks", ["Vocabulary drift", "Cold-start latency"], ""],
  ];
  for (const [title, bullets, notes] of slides) {
    const slide = pptx.addSlide();
    slide.addText(title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true });
    slide.addText(bullets.map((b) => ({ text: b, options: { bullet: true } })), { x: 0.7, y: 1.5, w: 8.5, h: 3, fontSize: 18 });
    if (notes) slide.addNotes(notes);
  }
  const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return new Uint8Array(out);
}

async function sampleXlsx(): Promise<Uint8Array> {
  const workbook = new Workbook();
  const revenue = workbook.addWorksheet("Revenue");
  revenue.addRow(["Region", "Q1", "Q2", "Q3", "Total"]);
  const data: Array<[string, number, number, number]> = [
    ["North America", 3.6, 4.1, 4.9],
    ["Europe", 2.2, 2.6, 3.0],
    ["Asia-Pacific", 0.9, 1.2, 1.5],
  ];
  data.forEach(([region, a, b, c], i) => {
    const row = i + 2;
    revenue.addRow([region, a, b, c, { formula: `SUM(B${row}:D${row})`, result: +(a + b + c).toFixed(1) }]);
  });
  const hires = workbook.addWorksheet("Hiring");
  hires.addRow(["Team", "Open roles", "Filled"]);
  hires.addRow(["Research", 4, 2]);
  hires.addRow(["Platform", 6, null]);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

const MARKDOWN = `# K3 serving notes

The retrieval service **memory-maps** the index at start-up. Keep these in mind:

- Warm the page cache before sending traffic.
- Pruning is per query, so latency grows with query length.
- Shards can be added without re-training.

## Latency budget

| Stage | Budget |
|---|---|
| Encode query | 3 ms |
| Traverse postings | 6 ms |
| Re-rank top 100 | 2 ms |

> Retrieval quality degrades gracefully as the index grows.
`;

const CSV = `model,params,recall_at_10,latency_ms,notes
Dense baseline,110M,0.905,38.0,"HNSW, ef=128"
K3-S,66M,0.897,4.2,
K3-M,110M,0.906,6.9,"default, ""recommended"""
K3-L,340M,0.912,11.3,tail latency above 10ms
`;

const CODE = `import { createIndex, type Posting } from "./index";

/** Prune a query's postings to the top-k terms by weight. */
export function prune(terms: Map<string, number>, k = 40): Array<[string, number]> {
  return [...terms.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k);
}

export async function search(query: string, limit = 10): Promise<Posting[]> {
  const index = await createIndex();
  const terms = prune(await index.encode(query));
  // Retrieval touches only the postings of the surviving terms.
  return index.lookup(terms, limit);
}
`;

async function chartPng(): Promise<Uint8Array | null> {
  const canvas = await loadCanvas();
  if (!canvas) return null;
  const c = canvas.createCanvas(960, 600);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 960, 600);
  ctx.fillStyle = "#222";
  ctx.font = "bold 30px sans-serif";
  ctx.fillText("Queries per second by region", 60, 70);
  const bars: Array<[string, number, string]> = [
    ["NA", 420, "#d9734f"],
    ["EU", 310, "#c98e5c"],
    ["APAC", 190, "#5b8f99"],
    ["LATAM", 120, "#3d6f84"],
  ];
  ctx.strokeStyle = "#999";
  ctx.beginPath();
  ctx.moveTo(100, 520);
  ctx.lineTo(900, 520);
  ctx.stroke();
  bars.forEach(([label, v, color], i) => {
    ctx.fillStyle = color;
    ctx.fillRect(140 + i * 190, 520 - v, 120, v);
    ctx.fillStyle = "#333";
    ctx.font = "22px sans-serif";
    ctx.fillText(label, 160 + i * 190, 555);
    ctx.font = "16px sans-serif";
    ctx.fillText(`${v}k`, 170 + i * 190, 510 - v);
  });
  return new Uint8Array(await c.encode("png"));
}

function bytes(body: Uint8Array | string, type: string) {
  const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new NextResponse(new Uint8Array(data), { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
}

async function readerOf(extracted: Awaited<ReturnType<typeof extractDocx>>): Promise<ReaderDocument> {
  const { blocks, truncated } = toReaderBlocks(extracted.blocks);
  return { status: "ready", source: "file", blocks, pageCount: extracted.pageCount ?? null, truncated };
}

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  if (process.env.NODE_ENV === "production") return new NextResponse("Not found", { status: 404 });
  const { name } = await params;

  switch (name) {
    case "report.pdf":
      return bytes(buildSampleReport(), "application/pdf");
    case "notes.md":
      return bytes(MARKDOWN, "text/markdown; charset=utf-8");
    case "data.csv":
      return bytes(CSV, "text/csv; charset=utf-8");
    case "search.ts":
      return bytes(CODE, "text/plain; charset=utf-8");
    case "chart.png": {
      const png = await chartPng();
      return png ? bytes(png, "image/png") : new NextResponse("No canvas", { status: 404 });
    }
    case "dev-pdf.thumb": {
      const page = await renderDocumentPage({ bytes: buildSampleReport(), page: 1, targetWidth: 640 });
      return page ? bytes(page.bytes, page.mimeType) : new NextResponse("No canvas", { status: 404 });
    }
    case "dev-pdf.preview":
      return NextResponse.json({ text: null, previewable: false, thumbnailUrl: "/dev/documents/sample/dev-pdf.thumb" });
    case "dev-docx.preview":
    case "dev-pptx.preview":
    case "dev-md.preview":
    case "dev-csv.preview":
    case "dev-ts.preview":
    case "dev-xlsx.preview": {
      const opening =
        name === "dev-docx.preview"
          ? "Quarterly review — Q3 2026\nSummary\nRevenue grew 18% quarter on quarter, driven by the enterprise tier."
          : name === "dev-pptx.preview"
            ? "K3 launch plan\nPrivate beta: October\nPublic launch: November 18"
            : name === "dev-md.preview"
              ? MARKDOWN.slice(0, 400)
              : name === "dev-csv.preview"
                ? CSV
                : name === "dev-ts.preview"
                  ? CODE.slice(0, 500)
                  : "Region | Q1 | Q2 | Q3 | Total\nNorth America | 3.6 | 4.1 | 4.9 | 12.6";
      return NextResponse.json({ text: opening, previewable: true, thumbnailUrl: null });
    }
    case "dev-docx.document":
      return NextResponse.json(await readerOf(await extractDocx({ bytes: await sampleDocx(), fileName: "quarterly_review.docx" })));
    case "dev-pptx.document":
      return NextResponse.json(await readerOf(await extractPptx({ bytes: await samplePptx(), fileName: "launch_plan.pptx" })));
    case "dev-xlsx.document": {
      const read = await readSheets(await sampleXlsx());
      return NextResponse.json({ status: "ready", source: "file", blocks: [], sheets: read?.sheets ?? [], pageCount: null, truncated: false } satisfies ReaderDocument);
    }
    case "quarterly_review.docx":
      return bytes(await sampleDocx(), "application/octet-stream");
    case "launch_plan.pptx":
      return bytes(await samplePptx(), "application/octet-stream");
    case "revenue.xlsx":
      return bytes(await sampleXlsx(), "application/octet-stream");
    default:
      return new NextResponse("Not found", { status: 404 });
  }
}
