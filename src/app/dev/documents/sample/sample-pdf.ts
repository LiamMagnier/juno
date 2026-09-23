/**
 * A synthetic, multi-page technical report — the dev gallery's PDF.
 *
 * Written byte by byte (the approach `tests/pdf-extraction.test.ts` takes) so
 * the gallery exercises what real reports contain without a binary fixture in
 * the repo: standard-font text the text layer can select, a vector bar chart
 * with no text layer over its bars (what "select an area" is for), a ruled
 * table, an external link, an internal link, and one landscape page among
 * portrait ones.
 */

type Op = string;

interface PageSpec {
  width: number;
  height: number;
  ops: Op[];
  links: Array<{ rect: [number, number, number, number]; uri?: string; toPage?: number }>;
}

function esc(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function text(x: number, y: number, size: number, font: "F1" | "F2" | "F3", str: string): Op {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${esc(str)}) Tj ET`;
}

/** Greedy wrap on an average Helvetica advance of ~0.5em. */
function wrap(str: string, size: number, width: number): string[] {
  const max = Math.floor(width / (size * 0.5));
  const lines: string[] = [];
  let line = "";
  for (const word of str.split(/\s+/)) {
    if ((line + " " + word).trim().length > max) {
      lines.push(line.trim());
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function paragraph(ops: Op[], x: number, y: number, width: number, str: string, size = 11, leading = 15): number {
  for (const line of wrap(str, size, width)) {
    ops.push(text(x, y, size, "F1", line));
    y -= leading;
  }
  return y - 6;
}

const REPORT = {
  intro:
    "K3 is a sparse retrieval system designed for corpora of billions of passages. It replaces dense nearest-neighbour search with a learned inverted index whose postings are pruned per query, keeping recall within one point of dense retrieval while cutting serving cost by an order of magnitude.",
  abstract:
    "We describe the architecture, training recipe and serving stack of K3, and report results on three public benchmarks. On MS MARCO, K3-L reaches 0.912 recall at ten with a median latency of 11 ms on commodity CPUs. We also release ablations over vocabulary size, pruning thresholds and the distillation schedule.",
  architecture:
    "The encoder maps a query to a weighted bag of vocabulary terms. Twelve transformer layers with sixteen attention heads each produce term weights; a sparsity regulariser keeps the average query to forty non-zero terms. Documents are encoded offline with the same model and written to a compressed inverted index that the retrieval service memory-maps at start-up.",
  results:
    "All three K3 variants match or beat the dense baseline on recall while serving several times faster. The largest variant is the only one whose latency exceeds ten milliseconds, and it does so only at the tail, where long queries touch more postings.",
  discussion:
    "Sparse retrieval trades a small amount of recall for interpretability and cost. Because every retrieved passage is explained by the terms it shares with the query, failure cases can be read directly from the index, which made most of the improvements in this report possible. Retrieval quality degrades gracefully as the index grows, since pruning is applied per query rather than per shard.",
  limitations:
    "K3 depends on a fixed vocabulary, so terms that appear after training reach the index only through their sub-word pieces. Multilingual retrieval is out of scope for this report. The latency figures assume the index fits in memory; on a cold start the first queries are dominated by page faults.",
  conclusion:
    "A learned sparse index can serve retrieval at dense-retrieval quality for a fraction of the cost. The main open question is how far the approach scales with vocabulary size, which we leave to future work.",
};

export function buildSampleReport(): Uint8Array {
  const pages: PageSpec[] = [];
  const W = 612;
  const H = 792;
  const L = 72;
  const TW = W - 2 * L;

  // Page 1 — title, abstract, introduction, links.
  {
    const ops: Op[] = [];
    ops.push(text(L, 700, 24, "F2", "K3: Scaling Sparse Retrieval"));
    ops.push(text(L, 676, 12, "F1", "Technical report  -  September 2026  -  Juno Research"));
    ops.push("0.8 0.8 0.8 RG 0.75 w 72 662 m 540 662 l S");
    ops.push(text(L, 636, 14, "F2", "Abstract"));
    let y = paragraph(ops, L, 616, TW, REPORT.abstract);
    ops.push(text(L, y - 8, 14, "F2", "1  Introduction"));
    y = paragraph(ops, L, y - 28, TW, REPORT.intro);
    ops.push(text(L, y - 4, 11, "F1", "Project page: https://example.com/k3"));
    ops.push(text(L, y - 22, 11, "F1", "See Figure 1 on page 2 for serving throughput."));
    pages.push({
      width: W,
      height: H,
      ops,
      links: [
        { rect: [L + 70, y - 8, L + 250, y + 8], uri: "https://example.com/k3" },
        { rect: [L, y - 26, L + 260, y - 10], toPage: 2 },
      ],
    });
  }

  // Page 2 — architecture and a vector bar chart with no text over the bars.
  {
    const ops: Op[] = [];
    ops.push(text(L, 720, 16, "F2", "2  Architecture"));
    const y = paragraph(ops, L, 696, TW, REPORT.architecture);
    const baseX = 120;
    const baseY = y - 260;
    const values = [42, 58, 71, 96];
    const colors = ["0.85 0.45 0.33", "0.80 0.56 0.36", "0.36 0.56 0.60", "0.24 0.44 0.52"];
    // Axes.
    ops.push(`0.2 0.2 0.2 RG 1 w ${baseX} ${baseY} m ${baseX} ${baseY + 220} l S`);
    ops.push(`${baseX} ${baseY} m ${baseX + 340} ${baseY} l S`);
    for (let t = 0; t <= 100; t += 25) {
      const ty = baseY + t * 2;
      ops.push(`0.85 0.85 0.85 RG 0.5 w ${baseX} ${ty} m ${baseX + 340} ${ty} l S`);
      ops.push(text(baseX - 26, ty - 3, 8, "F1", String(t)));
    }
    values.forEach((v, i) => {
      const x = baseX + 30 + i * 78;
      ops.push(`${colors[i]} rg ${x} ${baseY} 48 ${v * 2} re f`);
      ops.push(text(x + 16, baseY - 14, 9, "F1", `Q${i + 1}`));
    });
    ops.push(text(L, baseY - 40, 10, "F3", "Figure 1: Queries per second by quarter, in thousands."));
    pages.push({ width: W, height: H, ops, links: [] });
  }

  // Page 3 — results table.
  {
    const ops: Op[] = [];
    ops.push(text(L, 720, 16, "F2", "3  Results"));
    let y = paragraph(ops, L, 696, TW, REPORT.results);
    const rows = [
      ["Model", "Params", "Recall@10", "Latency (ms)"],
      ["Dense baseline", "110M", "0.905", "38.0"],
      ["K3-S", "66M", "0.897", "4.2"],
      ["K3-M", "110M", "0.906", "6.9"],
      ["K3-L", "340M", "0.912", "11.3"],
    ];
    const colX = [L, L + 170, L + 260, L + 370];
    const rowH = 22;
    const top = y - 10;
    rows.forEach((row, r) => {
      const ry = top - r * rowH;
      row.forEach((cell, c) => ops.push(text(colX[c] + 6, ry - 15, 10, r === 0 ? "F2" : "F1", cell)));
      ops.push(`0.75 0.75 0.75 RG 0.5 w ${L} ${ry - rowH} m ${W - L} ${ry - rowH} l S`);
    });
    ops.push(`0.2 0.2 0.2 RG 1 w ${L} ${top} m ${W - L} ${top} l S`);
    y = top - rows.length * rowH - 24;
    ops.push(text(L, y, 10, "F3", "Table 1: Recall at ten and median latency on MS MARCO dev."));
    pages.push({ width: W, height: H, ops, links: [] });
  }

  // Page 4 — landscape appendix with a line chart.
  {
    const LW = 792;
    const LH = 612;
    const ops: Op[] = [];
    ops.push(text(L, 540, 16, "F2", "Appendix A  Ablations"));
    ops.push(text(L, 516, 11, "F1", "Recall at ten as the pruning threshold rises. Past 0.6 recall falls quickly."));
    const bx = 120;
    const by = 140;
    ops.push(`0.2 0.2 0.2 RG 1 w ${bx} ${by} m ${bx} ${by + 300} l S ${bx} ${by} m ${bx + 520} ${by} l S`);
    const pts = [0.91, 0.912, 0.91, 0.905, 0.9, 0.884, 0.85, 0.79, 0.71];
    const path = pts.map((p, i) => `${bx + i * 62} ${by + (p - 0.7) * 1400} ${i === 0 ? "m" : "l"}`).join(" ");
    ops.push(`0.85 0.45 0.33 RG 2 w ${path} S`);
    pts.forEach((_, i) => ops.push(text(bx + i * 62 - 6, by - 16, 8, "F1", (i / 10).toFixed(1))));
    ops.push(text(L, by - 44, 10, "F3", "Figure 2: Recall@10 against the pruning threshold."));
    pages.push({ width: LW, height: LH, ops, links: [] });
  }

  // Pages 5–8 — prose, for scrolling, paging and find.
  for (const [title, body] of [
    ["4  Discussion", REPORT.discussion],
    ["5  Limitations", REPORT.limitations],
    ["6  Conclusion", REPORT.conclusion],
    ["References", "[1] Nguyen et al. MS MARCO: a human generated machine reading comprehension dataset. [2] Formal et al. SPLADE: sparse lexical and expansion model for first stage ranking. [3] Karpukhin et al. Dense passage retrieval for open-domain question answering."],
  ] as const) {
    const ops: Op[] = [];
    ops.push(text(L, 720, 16, "F2", title));
    let y = paragraph(ops, L, 696, TW, body);
    y = paragraph(ops, L, y - 10, TW, body.split(". ").reverse().join(". "));
    paragraph(ops, L, y - 10, TW, REPORT.intro);
    pages.push({ width: W, height: H, ops, links: [] });
  }

  // ── Serialise ────────────────────────────────────────────────────────────
  const objects: string[] = [];
  const reserve = () => objects.push("") ; // returns new length = object number
  const catalog = reserve();
  const pagesObj = reserve();
  const f1 = reserve();
  const f2 = reserve();
  const f3 = reserve();
  const pageNums = pages.map(() => reserve());
  const contentNums = pages.map(() => reserve());
  const set = (num: number, body: string) => {
    objects[num - 1] = body;
  };

  set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  set(pagesObj, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  set(f1, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  set(f2, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  set(f3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>");

  pages.forEach((page, i) => {
    const annots = page.links.map((link) => {
      const num = reserve();
      const action = link.uri
        ? `/A << /S /URI /URI (${esc(link.uri)}) >>`
        : `/Dest [${pageNums[(link.toPage ?? 1) - 1]} 0 R /XYZ 0 ${pages[(link.toPage ?? 1) - 1].height} 0]`;
      set(num, `<< /Type /Annot /Subtype /Link /Rect [${link.rect.join(" ")}] /Border [0 0 0] ${action} >>`);
      return num;
    });
    const stream = page.ops.join("\n") + "\n";
    set(contentNums[i], `<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    set(
      pageNums[i],
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${contentNums[i]} 0 R` +
        (annots.length ? ` /Annots [${annots.map((n) => `${n} 0 R`).join(" ")}]` : "") +
        " >>",
    );
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Latin-1: every character above is ASCII, so byte offsets equal string offsets.
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
