import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

/*
 * THE DECK IS A MODEL, NOT A RENDERING (BRIEF §29/§30).
 *
 * A presentation is stored as slides with closed layouts and typed elements.
 * These tests hold the four promises that makes: normalization refuses what
 * it cannot represent instead of guessing; an edit names one slide and leaves
 * every other slide deepEqual (no regeneration); the fit check catches what a
 * file that "opens fine" still gets wrong; and the .pptx carries the model's
 * own text, notes, chart data and tables, read back out of the written XML.
 */

import { SemanticError } from "@/lib/work/deliverables/semantic/shared";
import {
  DECK_LAYOUTS,
  normalizeDeck,
  outlineDeck,
  serializeDeck,
  type DeckModel,
} from "@/lib/work/deliverables/semantic/deck/model";
import { applyDeckOps, type DeckOpInput } from "@/lib/work/deliverables/semantic/deck/ops";
import { fitTextSize, validateDeckFit } from "@/lib/work/deliverables/semantic/deck/fit";
import { exportDeckPptx, readDeckPptx } from "@/lib/work/deliverables/semantic/deck/pptx-export";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function sixSlideDeck(): DeckModel {
  return normalizeDeck({
    title: "Quarterly review",
    master: { footer: "Acme Corp — internal", logoText: "ACME" },
    slides: [
      { layout: "title", title: "Quarterly review", subtitle: "Q3 2026", notes: "Welcome everyone." },
      { layout: "section", title: "Results" },
      {
        layout: "title-content",
        title: "Highlights",
        elements: [
          {
            type: "text",
            paragraphs: [
              { text: "Revenue up 18% quarter on quarter", bullet: true },
              { text: "Churn down to 2.1%", bullet: true },
              { text: "Enterprise tier carried the growth", bullet: true, level: 1 },
            ],
          },
        ],
        notes: "Pause on churn.",
      },
      {
        layout: "two-column",
        title: "Revenue by quarter",
        elements: [
          {
            type: "chart",
            chartType: "column",
            title: "Revenue ($k)",
            categories: ["Q1", "Q2", "Q3", "Q4"],
            series: [
              { name: "Revenue", values: [10, 12, 15, 18] },
              { name: "Cost", values: [7, 8, 9, 9] },
            ],
          },
          { type: "text", paragraphs: [{ text: "Growth accelerated in Q3.", bullet: false }] },
        ],
        notes: "Chart notes.",
        transition: "fade",
      },
      {
        layout: "title-content",
        title: "Pricing",
        elements: [
          {
            type: "table",
            header: ["Plan", "Price", "Seats"],
            rows: [
              ["Starter", "$9", "1"],
              ["Team", "$29", "10"],
            ],
          },
        ],
      },
      {
        layout: "title-only",
        title: "Team",
        elements: [
          { type: "image", src: PNG, alt: "Team photo", box: { x: 0.5, y: 1.4, w: 4, h: 3 } },
          { type: "shape", shape: "roundRect", box: { x: 5, y: 1.4, w: 4, h: 1 }, text: "Hiring 4 engineers" },
          { type: "shape", shape: "arrow", box: { x: 5, y: 3, w: 3, h: 0 } },
        ],
        transition: "push",
      },
    ],
  });
}

function expectSemantic(fn: () => unknown, code: string, pattern?: RegExp, opIndex?: number): SemanticError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SemanticError, `expected SemanticError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (pattern) assert.match(err.message, pattern);
    if (opIndex !== undefined) assert.equal(err.opIndex, opIndex);
    return err;
  }
  assert.fail("expected a SemanticError");
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

test("normalize assigns slide and element ids, explicit regions and neutral defaults", () => {
  const deck = sixSlideDeck();
  assert.equal(deck.kind, "presentation");
  assert.equal(deck.version, 1);
  assert.deepEqual(
    deck.slides.map((slide) => slide.id),
    ["s1", "s2", "s3", "s4", "s5", "s6"]
  );
  const elementIds = deck.slides.flatMap((slide) => slide.elements.map((element) => element.id));
  assert.deepEqual(elementIds, ["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
  // A two-column slide's elements fill left, then right.
  const twoColumn = deck.slides[3].elements;
  assert.equal(twoColumn[0].type === "chart" && twoColumn[0].region, "left");
  assert.equal(twoColumn[1].type === "text" && twoColumn[1].region, "right");
  assert.equal(deck.theme.background, "#FFFFFF");
  assert.equal(deck.master.slideNumbers, true);
  assert.equal(deck.master.footer, "Acme Corp — internal");
  // Idempotent: a normalized deck normalizes to itself, and survives JSON.
  assert.deepEqual(normalizeDeck(deck), deck);
  assert.deepEqual(normalizeDeck(JSON.parse(serializeDeck(deck))), deck);
});

test("normalize keeps given ids and numbers missing ones after the highest", () => {
  const deck = normalizeDeck({
    title: "T",
    slides: [
      { id: "s7", layout: "title-content", title: "A", elements: [{ id: "e9", type: "text", paragraphs: [{ text: "x" }] }] },
      { layout: "title-content", title: "B", elements: [{ type: "text", paragraphs: [{ text: "y" }] }] },
    ],
  });
  assert.equal(deck.slides[1].id, "s8");
  assert.equal(deck.slides[1].elements[0].id, "e10");
  expectSemantic(
    () => normalizeDeck({ title: "T", slides: [{ id: "a", layout: "blank" }, { id: "a", layout: "blank" }] }),
    "invalid_model",
    /used twice/
  );
});

test("normalize refuses a series whose length does not match the categories", () => {
  expectSemantic(
    () =>
      normalizeDeck({
        title: "T",
        slides: [
          {
            layout: "title-content",
            title: "Chart",
            elements: [{ type: "chart", chartType: "bar", categories: ["A", "B", "C"], series: [{ name: "S", values: [1, 2] }] }],
          },
        ],
      }),
    "invalid_model",
    /2 values for 3 categories/
  );
});

test("normalize refuses a box outside the slide, a bad region, ragged tables and an unsafe image", () => {
  const slide = (element: unknown) => ({ title: "T", slides: [{ layout: "title-content", title: "X", elements: [element] }] });
  expectSemantic(
    () => normalizeDeck(slide({ type: "text", paragraphs: [{ text: "x" }], box: { x: 8, y: 1, w: 3, h: 1 } })),
    "invalid_model",
    /outside the 10 x 5.625 in slide/
  );
  expectSemantic(
    () => normalizeDeck(slide({ type: "text", paragraphs: [{ text: "x" }], region: "right" })),
    "invalid_model",
    /does not have/
  );
  expectSemantic(
    () => normalizeDeck(slide({ type: "table", header: ["A", "B"], rows: [["1"]] })),
    "invalid_model",
    /row 1 has 1 cells/
  );
  for (const src of ["javascript:alert(1)", "http://example.com/a.png", "data:image/svg+xml;base64,PHN2Zz4=", "file:///etc/passwd"]) {
    expectSemantic(() => normalizeDeck(slide({ type: "image", src, alt: "x" })), "invalid_model");
  }
  // An https image is allowed in the model (the exporter does not fetch it).
  assert.ok(normalizeDeck(slide({ type: "image", src: "https://example.com/a.png", alt: "Logo" })));
  // Bounds: slide count, elements per slide, titles on layouts without one.
  expectSemantic(
    () => normalizeDeck({ title: "T", slides: Array.from({ length: 201 }, () => ({ layout: "blank" })) }),
    "invalid_model"
  );
  expectSemantic(
    () =>
      normalizeDeck({
        title: "T",
        slides: [{ layout: "blank", elements: Array.from({ length: 31 }, () => ({ type: "shape", shape: "rect", box: { x: 1, y: 1, w: 1, h: 1 } })) }],
      }),
    "invalid_model"
  );
  expectSemantic(() => normalizeDeck({ title: "T", slides: [{ layout: "blank", title: "Nope" }] }), "invalid_model", /no title placeholder/);
  expectSemantic(() => normalizeDeck({ title: "T", slides: [{ layout: "section", elements: [{ type: "text", paragraphs: [{ text: "x" }] }] }] }), "invalid_model", /no content region/);
});

test("outline is addressable and bounded", () => {
  const deck = sixSlideDeck();
  const outline = outlineDeck(deck);
  assert.match(outline, /\[s4\] two-column "Revenue by quarter"/);
  assert.match(outline, /\[e2\] chart column "Revenue \(\$k\)" \(left\): categories Q1\.\.Q4 \(4\); series Revenue 10,12,15,18 \| Cost 7,8,9,9/);
  assert.match(outline, /\[e1\] text \(body\): • Revenue up 18%/);
  assert.match(outline, /\[e4\] table \(body\): 3 cols x 2 rows; header Plan \| Price \| Seats/);
  assert.match(outline, /notes: Pause on churn\./);
  const short = outlineDeck(deck, 400);
  assert.ok(short.length < 600);
  assert.match(short, /… \d+ more slides$/);
});

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

test("each operation changes what it names and reports one sentence", () => {
  const deck = sixSlideDeck();
  const ops: DeckOpInput[] = [
    { op: "updateSlide", id: "s3", title: "Highlights of Q3", notes: "New notes", transition: "fade" },
    { op: "insertSlide", after: "s3", slide: { layout: "title-content", title: "Inserted", elements: [{ type: "text", paragraphs: [{ text: "New" }] }] } },
    { op: "duplicateSlide", id: "s2" },
    { op: "moveSlide", id: "s6", after: null },
    { op: "setElement", slideId: "s5", element: { type: "text", region: "body", paragraphs: [{ text: "Footnote" }] } },
    { op: "removeElement", slideId: "s6", elementId: "e7" },
    { op: "updateTable", slideId: "s5", elementId: "e4", rows: [["Starter", "$12", "1"]] },
    { op: "setTheme", theme: { accent: "#AA3300" } },
    { op: "setMaster", master: { footer: null, slideNumbers: false } },
    { op: "deleteSlide", id: "s1" },
  ];
  const { model, changes } = applyDeckOps(deck, ops);
  assert.equal(changes.length, ops.length);
  assert.deepEqual(changes.slice(0, 4), [
    "Changed the title, speaker notes, transition of slide 3",
    'Inserted a new slide 4 ("Inserted")',
    "Duplicated slide 2 as slide 3",
    "Moved slide 8 to position 1",
  ]);
  assert.match(changes[5], /Removed the shape from slide 1/);
  assert.match(changes[6], /Updated the table on slide/);
  const ids = model.slides.map((slide) => slide.id);
  assert.deepEqual(ids, ["s6", "s2", "s8", "s3", "s7", "s4", "s5"]);
  const s3 = model.slides.find((slide) => slide.id === "s3")!;
  assert.equal(s3.title, "Highlights of Q3");
  assert.equal(s3.notes, "New notes");
  assert.equal(s3.transition, "fade");
  const inserted = model.slides.find((slide) => slide.id === "s7")!;
  assert.equal(inserted.elements[0].id, "e8");
  const duplicate = model.slides.find((slide) => slide.id === "s8")!;
  assert.equal(duplicate.title, "Results");
  const s5 = model.slides.find((slide) => slide.id === "s5")!;
  assert.equal(s5.elements.length, 2);
  assert.equal(s5.elements[1].id, "e9");
  assert.deepEqual(s5.elements[0].type === "table" && s5.elements[0].rows, [["Starter", "$12", "1"]]);
  assert.equal(model.theme.accent, "#AA3300");
  assert.equal(model.master.footer, undefined);
  assert.equal(model.master.slideNumbers, false);
  assert.equal(model.master.logoText, "ACME");
  // The input is untouched.
  assert.deepEqual(deck, sixSlideDeck());
});

test("updateSlide layout change remaps regions, and refuses one with nowhere to go", () => {
  const deck = sixSlideDeck();
  const { model } = applyDeckOps(deck, [{ op: "updateSlide", id: "s3", layout: "two-column" }]);
  const element = model.slides[2].elements[0];
  assert.equal(element.type === "text" && element.region, "left");
  expectSemantic(() => applyDeckOps(deck, [{ op: "updateSlide", id: "s4", layout: "title-content" }]), "invalid_op", /no "right" region/, 1);
  // Subtitle only lives on the title layout: changing away needs it cleared.
  expectSemantic(() => applyDeckOps(deck, [{ op: "updateSlide", id: "s1", layout: "section" }]), "invalid_op", /subtitle/, 1);
  const cleared = applyDeckOps(deck, [{ op: "updateSlide", id: "s1", layout: "section", subtitle: null }]);
  assert.equal(cleared.model.slides[0].subtitle, undefined);
});

test("a failing batch is all-or-nothing and names the failing operation", () => {
  const deck = sixSlideDeck();
  const before = structuredClone(deck);
  expectSemantic(
    () =>
      applyDeckOps(deck, [
        { op: "updateSlide", id: "s1", title: "Changed" },
        { op: "updateChart", slideId: "s4", elementId: "e2", categories: ["A", "B"] },
      ]),
    "invalid_op",
    /2 values for 4 categories|4 values for 2 categories/,
    2
  );
  expectSemantic(() => applyDeckOps(deck, [{ op: "updateSlide", id: "s1", title: "x" }, { op: "deleteSlide", id: "nope" }]), "not_found", /no slide "nope"/, 2);
  expectSemantic(() => applyDeckOps(deck, [{ op: "updateText", slideId: "s4", elementId: "e2", paragraphs: [{ text: "x" }] }]), "invalid_op", /not text/, 1);
  expectSemantic(
    () => applyDeckOps(deck, [{ op: "setElement", slideId: "s1", element: { id: "e2", type: "text", paragraphs: [{ text: "x" }], box: { x: 1, y: 1, w: 1, h: 1 } } }]),
    "invalid_op",
    /another slide/,
    1
  );
  expectSemantic(
    () => applyDeckOps(deck, [{ op: "setElement", slideId: "s6", element: { type: "shape", shape: "rect", box: { x: 9, y: 5, w: 2, h: 2 } } }]),
    "invalid_op",
    /outside/,
    1
  );
  // A malformed op is refused by the schema with its index.
  expectSemantic(() => applyDeckOps(deck, [{ op: "updateSlide", id: "s1", title: "ok" }, { op: "explode" } as never]), "invalid_op", undefined, 2);
  assert.deepEqual(deck, before);
});

test("EDIT ONE SLIDE WITHOUT REGENERATING: chart + text on slide 4 leave every other slide deepEqual", () => {
  const deck = sixSlideDeck();
  const before = structuredClone(deck);
  const { model, changes } = applyDeckOps(deck, [
    { op: "updateChart", slideId: "s4", elementId: "e2", series: [{ name: "Revenue", values: [11, 13, 17, 21] }, { name: "Cost", values: [7, 8, 9, 10] }] },
    { op: "updateText", slideId: "s4", elementId: "e3", paragraphs: [{ text: "Growth accelerated again in Q4." }] },
  ]);
  assert.deepEqual(changes, ["Updated the chart on slide 4", "Updated the text on slide 4"]);
  for (const index of [0, 1, 2, 4, 5]) assert.deepEqual(model.slides[index], before.slides[index]);
  assert.deepEqual(model.theme, before.theme);
  assert.deepEqual(model.master, before.master);
  const [beforeSlide, afterSlide] = [before.slides[3], model.slides[3]];
  // Only the two targeted elements changed; the slide's own fields did not.
  const { elements: beforeElements, ...beforeRest } = beforeSlide;
  const { elements: afterElements, ...afterRest } = afterSlide;
  assert.deepEqual(afterRest, beforeRest);
  assert.equal(afterElements.length, beforeElements.length);
  const chart = afterElements[0];
  assert.ok(chart.type === "chart");
  assert.deepEqual(chart.series[0].values, [11, 13, 17, 21]);
  assert.deepEqual({ ...chart, series: undefined }, { ...beforeElements[0], series: undefined });
  const text = afterElements[1];
  assert.ok(text.type === "text");
  assert.equal(text.paragraphs[0].text, "Growth accelerated again in Q4.");
  assert.equal(text.region, "right");
  assert.deepEqual(deck, before);
});

// ---------------------------------------------------------------------------
// fit
// ---------------------------------------------------------------------------

test("fit: a clean deck passes", () => {
  assert.deepEqual(validateDeckFit(sixSlideDeck()), []);
});

test("fit: catches an overflowing paragraph, an out-of-bounds box, overlap, density and an empty slide", () => {
  const long = "This sentence keeps going well past what a small box can hold at any readable size. ".repeat(12);
  const deck = normalizeDeck({
    title: "T",
    slides: [
      { layout: "title-content", title: "Overflow", elements: [{ type: "text", box: { x: 0.5, y: 1.4, w: 3, h: 1 }, paragraphs: [{ text: long }] }] },
      {
        layout: "title-only",
        title: "Overlap",
        elements: [
          { type: "image", src: PNG, alt: "a", box: { x: 1, y: 1.4, w: 4, h: 3 } },
          { type: "chart", chartType: "line", categories: ["a", "b"], series: [{ name: "s", values: [1, 2] }], box: { x: 3, y: 2, w: 4, h: 3 } },
        ],
      },
      {
        layout: "title-content",
        title: "Dense",
        elements: [
          {
            type: "chart",
            chartType: "column",
            categories: Array.from({ length: 20 }, (_, i) => `C${i + 1}`),
            series: [{ name: "s", values: Array.from({ length: 20 }, (_, i) => i) }],
          },
        ],
      },
      { layout: "blank" },
    ],
  });
  // An element the footer band would clip (the master shows slide numbers).
  const footer = applyDeckOps(deck, [{ op: "setElement", slideId: "s2", element: { type: "text", box: { x: 7.2, y: 4.6, w: 2.5, h: 0.9 }, paragraphs: [{ text: "Source" }] } }]).model;
  // A hand-built model (not normalized) with a box past the slide edge.
  const outside = structuredClone(footer);
  outside.slides[0].elements.push({ type: "shape", id: "e99", shape: "rect", box: { x: 9, y: 5, w: 2, h: 1 } });

  const issues = validateDeckFit(outside);
  const kinds = (slideId: string) => issues.filter((issue) => issue.slideId === slideId).map((issue) => issue.kind).sort();
  assert.deepEqual(kinds("s1"), ["outside", "overflow"]);
  assert.ok(issues.some((issue) => issue.slideId === "s1" && issue.kind === "overflow" && issue.elementId === "e1"));
  assert.ok(issues.some((issue) => issue.slideId === "s1" && issue.kind === "outside" && issue.elementId === "e99"));
  assert.deepEqual(kinds("s2"), ["outside", "overlap"]);
  assert.deepEqual(kinds("s3"), ["dense"]);
  assert.deepEqual(kinds("s4"), ["empty"]);
});

test("fit: tables that cannot fit even at the minimum size are reported", () => {
  const deck = normalizeDeck({
    title: "T",
    slides: [
      {
        layout: "title-content",
        title: "Big table",
        elements: [{ type: "table", header: ["A", "B"], rows: Array.from({ length: 30 }, (_, i) => [`Row ${i}`, "value"]) }],
      },
    ],
  });
  const issues = validateDeckFit(deck);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "overflow");
  assert.equal(issues[0].elementId, "e1");
});

test("fitTextSize returns the largest size that fits, or null below the floor", () => {
  const box = DECK_LAYOUTS["title-content"].placeholders.body!.box;
  assert.equal(fitTextSize([{ text: "Short" }], box, 18, 12), 18);
  const medium = Array.from({ length: 14 }, (_, i) => ({ text: `Bullet number ${i} with a little more text`, bullet: true }));
  const size = fitTextSize(medium, box, 18, 12);
  assert.ok(size !== null && size < 18 && size >= 12, `got ${size}`);
  const huge = Array.from({ length: 40 }, () => ({ text: "x ".repeat(200) }));
  assert.equal(fitTextSize(huge, box, 18, 12), null);
});

// ---------------------------------------------------------------------------
// .pptx
// ---------------------------------------------------------------------------

test("export writes a real .pptx: slides, notes, chart parts, layouts", async () => {
  const deck = sixSlideDeck();
  const bytes = await exportDeckPptx(deck);
  const zip = await JSZip.loadAsync(bytes);
  assert.ok(zip.file("ppt/presentation.xml"));
  const files = Object.keys(zip.files);
  assert.equal(files.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length, 6);
  assert.equal(files.filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f)).length, 6);
  assert.equal(files.filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f)).length, 1);
  assert.ok(files.some((f) => /^ppt\/embeddings\/.*\.xlsx$/.test(f)), "chart carries its data workbook");
  const usedLayouts = new Set(deck.slides.map((slide) => slide.layout)).size;
  assert.ok(files.filter((f) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f)).length >= usedLayouts);
  assert.ok(files.filter((f) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(f)).length >= 1);
  assert.ok(files.some((f) => /^ppt\/media\/.*\.png$/.test(f)), "the data: image is embedded");
  // Titles land in layout placeholders, not free text boxes.
  const slide3 = await zip.file("ppt/slides/slide3.xml")!.async("string");
  assert.match(slide3, /<p:ph[\s\S]*?type="title"/);
  assert.match(slide3, /<p:ph[\s\S]*?type="body"/);
  // The footer and logo text live on the layouts.
  const layouts = await Promise.all(files.filter((f) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f)).map((f) => zip.file(f)!.async("string")));
  assert.ok(layouts.some((xml) => xml.includes("Acme Corp — internal") && xml.includes("ACME")));
});

test("readDeckPptx roundtrip: texts, notes, chart data, tables, images, layouts, transitions", async () => {
  const deck = sixSlideDeck();
  const read = await readDeckPptx(await exportDeckPptx(deck));
  assert.equal(read.slideCount, 6);
  assert.equal(read.title, "Quarterly review");
  assert.deepEqual(
    read.slides.map((slide) => slide.layoutName),
    deck.slides.map((slide) => slide.layout)
  );
  for (const [index, slide] of deck.slides.entries()) {
    const back = read.slides[index];
    if (slide.title) assert.ok(back.texts.includes(slide.title), `slide ${index + 1} title`);
    if (slide.subtitle) assert.ok(back.texts.includes(slide.subtitle));
    for (const element of slide.elements) {
      if (element.type === "text") for (const p of element.paragraphs) assert.ok(back.texts.includes(p.text), p.text);
      if (element.type === "table") for (const cell of [...element.header, ...element.rows.flat()]) assert.ok(back.texts.includes(cell), cell);
      if (element.type === "shape" && element.text) assert.ok(back.texts.includes(element.text));
    }
    assert.equal(back.notes, slide.notes ?? "");
    assert.equal(back.charts, slide.elements.filter((e) => e.type === "chart").length);
    assert.equal(back.tables, slide.elements.filter((e) => e.type === "table").length);
    assert.equal(back.images, slide.elements.filter((e) => e.type === "image").length);
    assert.equal(back.shapes, slide.elements.filter((e) => e.type === "shape").length);
    assert.equal(back.transition, slide.transition ?? "none");
  }
  const chart = read.slides[3].chartData[0];
  assert.equal(chart.type, "bar");
  assert.equal(chart.barDir, "col");
  assert.deepEqual(chart.categories, ["Q1", "Q2", "Q3", "Q4"]);
  assert.deepEqual(chart.series, [
    { name: "Revenue", values: [10, 12, 15, 18] },
    { name: "Cost", values: [7, 8, 9, 9] },
  ]);
});

test("an https image is not fetched: it exports as a labelled placeholder", async () => {
  const deck = normalizeDeck({
    title: "T",
    slides: [{ layout: "title-content", title: "Logo", elements: [{ type: "image", src: "https://example.com/logo.png", alt: "Company logo" }] }],
  });
  const read = await readDeckPptx(await exportDeckPptx(deck));
  assert.equal(read.slides[0].images, 0);
  assert.equal(read.slides[0].imagePlaceholders, 1);
  assert.ok(read.slides[0].texts.includes("Image: Company logo"));
});

test("edit -> export -> read shows the new chart values on that slide and unchanged texts elsewhere", async () => {
  const deck = sixSlideDeck();
  const first = await readDeckPptx(await exportDeckPptx(deck));
  const { model } = applyDeckOps(deck, [
    { op: "updateChart", slideId: "s4", elementId: "e2", categories: ["Jan", "Feb", "Mar", "Apr"], series: [{ name: "Revenue", values: [3, 5, 8, 13] }] },
    { op: "updateText", slideId: "s4", elementId: "e3", paragraphs: [{ text: "Fibonacci, apparently." }] },
  ]);
  const second = await readDeckPptx(await exportDeckPptx(model));
  assert.deepEqual(second.slides[3].chartData[0].categories, ["Jan", "Feb", "Mar", "Apr"]);
  assert.deepEqual(second.slides[3].chartData[0].series, [{ name: "Revenue", values: [3, 5, 8, 13] }]);
  assert.ok(second.slides[3].texts.includes("Fibonacci, apparently."));
  assert.ok(!second.slides[3].texts.includes("Growth accelerated in Q3."));
  for (const index of [0, 1, 2, 4, 5]) {
    assert.deepEqual(second.slides[index].texts, first.slides[index].texts);
    assert.equal(second.slides[index].notes, first.slides[index].notes);
  }
});
