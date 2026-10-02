import { NextResponse } from "next/server";
import sharp from "sharp";
import { Workbook } from "exceljs";

export const runtime = "nodejs";

/**
 * The files the `/dev/tool-runs` fixtures say a run made, generated on
 * request: the bar chart, the CSV, the workbook and a long log. 404 outside
 * development, like the gallery. Nothing here is checked in as a binary.
 */

const REGIONS: Array<[string, number]> = [
  ["East", 15002],
  ["North", 18240.5],
  ["South", 21877.1],
  ["West", 24410.75],
];

function chartSvg(): string {
  const w = 864;
  const h = 576;
  const max = Math.max(...REGIONS.map(([, v]) => v));
  const bars = REGIONS.map(([name, value], i) => {
    const bh = Math.round((value / max) * 380);
    const x = 120 + i * 170;
    return `<rect x="${x}" y="${470 - bh}" width="110" height="${bh}" fill="#4c72b0"/><text x="${x + 55}" y="505" font-size="22" text-anchor="middle" fill="#222">${name}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><text x="${w / 2}" y="54" font-size="28" text-anchor="middle" fill="#111" font-family="sans-serif">Average revenue by region</text><line x1="100" y1="470" x2="790" y2="470" stroke="#333"/>${bars}</svg>`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  if (process.env.NODE_ENV === "production") return new NextResponse("Not found", { status: 404 });
  const { name } = await params;
  switch (name) {
    case "chart.png": {
      const png = await sharp(Buffer.from(chartSvg())).png().toBuffer();
      return new NextResponse(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
    }
    case "summary.csv":
      return new NextResponse(["region,revenue", ...REGIONS.map(([r, v]) => `${r},${v.toFixed(2)}`)].join("\n"), {
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      });
    case "out.xlsx": {
      const book = new Workbook();
      const sheet = book.addWorksheet("Summary");
      sheet.addRow(["Region", "Average revenue"]);
      for (const [r, v] of REGIONS) sheet.addRow([r, v]);
      const bytes = await book.xlsx.writeBuffer();
      return new NextResponse(new Uint8Array(bytes as ArrayBuffer), {
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
    }
    case "log.txt": {
      const lines: string[] = [];
      for (let i = 0; i < 2000; i++) lines.push(String(i));
      return new NextResponse(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    default:
      return new NextResponse("Not found", { status: 404 });
  }
}
