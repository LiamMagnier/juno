import { canonicalSemanticBody, type SemanticArtifactType } from "@/lib/work/deliverables/semantic";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const workbook = {
  title: "Growth model",
  names: { conversion: "Assumptions!$B$3" },
  sheets: [
    {
      name: "Model",
      freeze: { rows: 1, cols: 1 },
      columns: { A: { width: 10 }, B: { width: 12 }, C: { width: 10 }, D: { width: 14 } },
      rows: [
        [{ v: "Month", bold: true }, { v: "Visitors", bold: true }, { v: "Orders", bold: true }, { v: "Revenue", bold: true }],
        ...MONTHS.map((month, i) => {
          const r = i + 2;
          return [
            month,
            i === 0 ? { f: "=Assumptions!B2", fmt: "integer" } : { f: `=ROUND(B${r - 1}*(1+Assumptions!$B$5),0)`, fmt: "integer" },
            { f: `=ROUND(B${r}*conversion,0)`, fmt: "integer" },
            { f: `=C${r}*Assumptions!$B$4`, fmt: "currency" },
          ];
        }),
        [{ v: "Total", bold: true }, null, { f: "=SUM(C2:C13)", fmt: "integer", bold: true }, { f: "=SUM(D2:D13)", fmt: "currency", bold: true }],
      ],
      charts: [
        { type: "line", title: "Revenue by month", categories: "A2:A13", series: [{ name: "Revenue", values: "D2:D13" }] },
        { type: "column", title: "Orders by month", categories: "A2:A13", series: [{ name: "Orders", values: "C2:C13" }] },
      ],
    },
    {
      name: "Assumptions",
      freeze: { rows: 1 },
      columns: { A: { width: 22 }, B: { width: 12 } },
      rows: [
        [{ v: "Assumption", bold: true }, { v: "Value", bold: true }],
        ["Monthly visitors", { v: 120000, fmt: "integer" }],
        ["Conversion rate", { v: 0.05, fmt: "percent" }],
        ["Average order value", { v: 48, fmt: "currency" }],
        ["Monthly growth", { v: 0.04, fmt: "percent" }],
      ],
    },
  ],
};

const document = {
  title: "Q3 operating review",
  metadata: { author: "Alevr" },
  sources: [
    { id: "s1", title: "Q3 finance pack", publisher: "Finance" },
    { id: "s2", title: "Customer survey, September", url: "https://example.com/survey" },
  ],
  blocks: [
    { type: "heading", level: 1, text: "Q3 operating review" },
    { type: "paragraph", style: "lead", text: "Revenue grew **18%** quarter on quarter while costs held flat [@s1]." },
    { type: "heading", level: 2, text: "What moved" },
    { type: "list", ordered: false, items: [{ text: "Self-serve conversion rose to 5.4%", level: 0 }, { text: "Enterprise pipeline doubled", level: 0 }, { text: "Two of three regions above plan", level: 1 }] },
    { type: "table", header: ["Region", "Revenue", "vs plan"], rows: [["EMEA", "4.2m", "+6%"], ["Americas", "6.1m", "+11%"], ["APAC", "1.9m", "−4%"]], caption: "Revenue by region, Q3" },
    { type: "callout", tone: "warning", title: "Watch", text: "APAC churn is up for the second quarter running [@s2]." },
    { type: "paragraph", text: "We recommend holding hiring until the APAC retention plan lands." },
  ],
};

const deck = {
  title: "Launch plan",
  theme: { accent: "#2d49c9", headingFont: "Georgia" },
  master: { footer: "Launch plan · Q4", slideNumbers: true },
  slides: [
    { layout: "title", title: "Launch plan", subtitle: "Q4 2026", notes: "Open with the one number that matters." },
    { layout: "title-content", title: "Why now", elements: [{ type: "text", paragraphs: [{ text: "Demand doubled since spring", bullet: true }, { text: "Two competitors left the segment", bullet: true }, { text: "Our cost to serve fell 30%", bullet: true }] }], notes: "Keep this under a minute." },
    { layout: "two-column", title: "Pricing", elements: [{ type: "table", header: ["Plan", "Price"], rows: [["Starter", "$9"], ["Pro", "$20"], ["Team", "$45"]] }, { type: "chart", chartType: "column", categories: ["Q1", "Q2", "Q3", "Q4"], series: [{ name: "Users (k)", values: [10, 14, 19, 26] }] }] },
    { layout: "section", title: "Execution" },
  ],
};

export const FIXTURES: Record<SemanticArtifactType, string> = {
  SPREADSHEET: canonicalSemanticBody("SPREADSHEET", JSON.stringify(workbook)),
  DOCUMENT: canonicalSemanticBody("DOCUMENT", JSON.stringify(document)),
  PRESENTATION: canonicalSemanticBody("PRESENTATION", JSON.stringify(deck)),
};

/** The chat edit each fixture demonstrates: what a person asks, and the operations the model sends. */
export function chatEdit(type: SemanticArtifactType, content: string): { ask: string; ops: Record<string, unknown>[] } {
  const model = JSON.parse(content);
  switch (type) {
    case "SPREADSHEET":
      return { ask: "Increase conversion assumption to 7.5% and update the charts", ops: [{ op: "setCell", sheet: "Assumptions", cell: "conversion", value: 0.075 }] };
    case "DOCUMENT":
      return {
        ask: "Make the recommendation sharper and flag the hiring point for finance",
        ops: [
          { op: "suggestRevision", blockId: model.blocks[6].id, kind: "replace", text: "Hold hiring until APAC retention recovers; revisit in November." },
          { op: "comment", blockId: model.blocks[4].id, text: "Finance to confirm the APAC figure." },
        ],
      };
    case "PRESENTATION":
      return {
        ask: "Q4 users came in at 31k — update the pricing chart",
        ops: [{ op: "updateChart", slideId: model.slides[2].id, elementId: model.slides[2].elements[1].id, series: [{ name: "Users (k)", values: [10, 14, 19, 31] }] }],
      };
  }
}
