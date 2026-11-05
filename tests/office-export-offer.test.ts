import test from "node:test";
import assert from "node:assert/strict";
import { officeExportOffer } from "@/lib/canvas/office-export-offer";

test("no convertible format, no offer", () => {
  assert.equal(officeExportOffer({ formats: 0, isLatest: true, dirty: false }), "none");
});

test("an older version on screen is never exported as if it were the one shown", () => {
  assert.equal(officeExportOffer({ formats: 1, isLatest: false, dirty: false }), "none");
});

test("the saved latest version exports", () => {
  assert.equal(officeExportOffer({ formats: 2, isLatest: true, dirty: false }), "ready");
});

test("an unsaved edit holds the export until it is saved, since the file is built from the saved version", () => {
  assert.equal(officeExportOffer({ formats: 1, isLatest: true, dirty: true }), "save-first");
});
