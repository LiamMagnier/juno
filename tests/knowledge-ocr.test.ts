import test from "node:test";
import assert from "node:assert/strict";
import { ocrPagesToBlocks } from "@/lib/knowledge/ocr";

test("OCR output becomes explicitly low-confidence, page-citable blocks", () => {
  const result = ocrPagesToBlocks(
    [
      { page: 2, text: "  Second page  ", confidence: 0.82, bbox: [1, 2, 3, 4, 5] },
      { page: 1, text: "First page", confidence: 1.4 },
      { page: 3, text: "   ", confidence: 0.4 },
    ],
    "scan.pdf"
  );

  assert.deepEqual(result.pages.map((page) => page.page), [1, 2]);
  assert.deepEqual(result.blocks.map((block) => block.page), [1, 2]);
  assert.deepEqual(result.blocks.map((block) => block.confidence), [1, 0.82]);
  assert.equal(result.blocks[0].confidence, 1);
  assert.equal(result.blocks[1].path, "scan.pdf");
  assert.deepEqual(result.blocks[1].bbox, [1, 2, 3, 4]);
});

test("OCR pages are bounded to the configured page ceiling", () => {
  const result = ocrPagesToBlocks(
    Array.from({ length: 120 }, (_, index) => ({ page: index + 1, text: `Page ${index + 1}`, confidence: 0.5 })),
    "long-scan.pdf"
  );
  assert.equal(result.blocks.length, 100);
  assert.equal(result.blocks.at(-1)?.page, 100);
});
