import test from "node:test";
import assert from "node:assert/strict";
import { generateDeliverable, type DeliverableRequest } from "@/lib/work/deliverables";
import {
  PREVIEW_MAX_CELL_CHARS,
  PREVIEW_MAX_COLUMNS,
  PREVIEW_MAX_ROWS,
  buildSpreadsheetPreview,
  describePreviewOmissions,
} from "@/lib/work/deliverables/spreadsheet-preview";

/*
 * A spreadsheet deliverable, looked at without Excel.
 *
 * Every case here generates a real .xlsx through the same `generateDeliverable`
 * a run uses and then reads the produced bytes back, for the reason the
 * directory's own header gives about validation: a preview is a verdict a
 * person makes about the file they are about to send somebody, so it has to be
 * a verdict about the stored bytes and not about the spec that made them. A
 * test that asserted against the spec would pass with the writer broken.
 */

async function previewOf(request: DeliverableRequest) {
  const generated = await generateDeliverable(request);
  return buildSpreadsheetPreview(generated.bytes);
}

test("a generated workbook reads back as the grid that was written", async () => {
  const preview = await previewOf({
    spec: {
      kind: "spreadsheet",
      title: "Q3 pipeline",
      sheets: [
        {
          name: "Deals",
          columns: [{ header: "Account" }, { header: "Stage" }, { header: "Value" }],
          rows: [
            ["Northwind", "Won", 42000],
            // A blank is not a zero and not an empty string, and a text cell
            // that looks numeric must stay text: the whole argument
            // `spreadsheet.ts` is written around, checked here on the way back
            // out rather than only on the way in.
            ["Contoso", null, "007"],
          ],
        },
      ],
    },
  });

  assert.equal(preview.sheets.length, 1);
  assert.equal(preview.omittedSheets, 0);
  const [sheet] = preview.sheets;
  assert.equal(sheet.name, "Deals");
  // Row one is the header the builder writes from `columns`, which is why the
  // component draws the first row as one for every workbook Juno produces.
  assert.deepEqual(sheet.rows, [
    ["Account", "Stage", "Value"],
    ["Northwind", "Won", "42000"],
    ["Contoso", "", "007"],
  ]);
  assert.equal(sheet.omittedRows, 0);
  assert.equal(sheet.omittedColumns, 0);
  assert.equal(describePreviewOmissions(sheet), null);
});

test("a date comes back as a date and not as the reader's timezone", async () => {
  // `String(date)` is a locale- and timezone-dependent sentence, and a preview
  // whose dates read differently on two machines is the bug the typed cell
  // exists to prevent, reintroduced one layer up.
  const preview = await previewOf({
    spec: {
      kind: "spreadsheet",
      title: "Dates",
      sheets: [
        {
          name: "Sheet1",
          columns: [{ header: "When", format: "date" }],
          rows: [[{ date: "2026-03-04T00:00:00.000Z" }]],
        },
      ],
    },
  });
  assert.equal(preview.sheets[0].rows[1][0], "2026-03-04");
});

test("a sheet larger than the window is truncated and says so", async () => {
  const rows: number[][] = [];
  for (let index = 0; index < PREVIEW_MAX_ROWS + 25; index++) rows.push([index]);

  const preview = await previewOf({
    spec: {
      kind: "spreadsheet",
      title: "Long",
      sheets: [{ name: "Sheet1", columns: [{ header: "n" }], rows }],
    },
  });
  const [sheet] = preview.sheets;
  assert.equal(sheet.rows.length, PREVIEW_MAX_ROWS);
  // The header row counts against the window, so the sheet holds
  // PREVIEW_MAX_ROWS + 25 + 1 rows in total and 25 + 1 are left out.
  assert.equal(sheet.omittedRows, 26);
  assert.equal(
    describePreviewOmissions(sheet),
    "26 more rows in the file. Download it to see everything."
  );
});

test("a wide sheet is windowed on columns too, and the sentence names both", async () => {
  const columns = Array.from({ length: PREVIEW_MAX_COLUMNS + 1 }, (_, index) => ({
    header: `c${index}`,
  }));
  const preview = await previewOf({
    spec: {
      kind: "spreadsheet",
      title: "Wide",
      sheets: [{ name: "Sheet1", columns, rows: [columns.map((column) => column.header)] }],
    },
  });
  const [sheet] = preview.sheets;
  assert.equal(sheet.rows[0].length, PREVIEW_MAX_COLUMNS);
  assert.equal(sheet.omittedColumns, 1);
  assert.equal(
    describePreviewOmissions(sheet),
    "1 more column in the file. Download it to see everything."
  );
});

test("one enormous cell cannot make a preview larger than the document", async () => {
  const long = "x".repeat(PREVIEW_MAX_CELL_CHARS * 4);
  const preview = await previewOf({
    spec: {
      kind: "spreadsheet",
      title: "Verbose",
      sheets: [{ name: "Sheet1", columns: [{ header: "note" }], rows: [[long]] }],
    },
  });
  const cell = preview.sheets[0].rows[1][0];
  assert.equal(cell.length, PREVIEW_MAX_CELL_CHARS);
  assert.ok(cell.endsWith("…"));
});

test("bytes that are not a workbook throw rather than preview as empty", async () => {
  // The route turns this into "this workbook could not be opened", which is a
  // different answer from "the run produced nothing" and the reader needs the
  // difference: one is a broken file, the other is a wasted run.
  await assert.rejects(() => buildSpreadsheetPreview(new TextEncoder().encode("not a workbook")));
});
