import assert from "node:assert/strict";
import test from "node:test";
import {
  canRaster,
  canRenderDocumentPage,
  imageDimensions,
  renderDocumentPage,
  transformImage,
} from "@/lib/media/raster";

/*
 * The claim: a real PDF becomes a real picture.
 *
 * Everything in the Library, the picker and the composer that stopped saying
 * "PDF" on a grey square rests on one operation — page one of an actual file,
 * drawn. A test with a stubbed renderer would prove the plumbing and nothing
 * about the thing that was broken, so the fixture below is a PDF assembled
 * byte by byte (the same approach `pdf-extraction.test.ts` takes, and for the
 * same reason: there is no valid PDF you can write as a string literal,
 * because every object's offset has to appear in the xref table).
 *
 * `inspect_image` rests on the same module: a crop is the same decode and draw
 * with a source rectangle, so both are exercised here.
 */

interface PageSpec {
  text?: string;
  /** A raw content stream — used to draw ink at a known place on the page. */
  raw?: string;
}

function buildPdf(pages: PageSpec[]): Uint8Array {
  const objects: string[] = [];
  const pageObjNum = (i: number) => 4 + i * 2;
  const kids = pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(" ");

  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  pages.forEach((page, i) => {
    const num = pageObjNum(i);
    const contentNum = num + 1;
    objects.push(
      `${num} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const stream = page.raw ?? `BT /F1 24 Tf 72 700 Td (${page.text ?? ""}) Tj ET\n`;
    objects.push(`${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  // latin1, not utf8: a PDF is a byte format and the offsets above are byte
  // offsets, so any multi-byte encoding shifts every one of them.
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/** A solid black square, in page units, at (x, y) with side `size`. */
function inkSquare(x: number, y: number, size: number): string {
  return `0 0 0 rg\n${x} ${y} ${size} ${size} re f\n`;
}

/** PNG and JPEG magic bytes — what the route promises it is serving. */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

test("a renderable format is recognised by MIME type alone", () => {
  assert.equal(canRenderDocumentPage("application/pdf"), true);
  assert.equal(canRenderDocumentPage("APPLICATION/PDF"), true);
  assert.equal(canRenderDocumentPage("image/png"), false);
  assert.equal(canRenderDocumentPage("text/plain"), false);
});

test("page one of a real PDF renders to a JPEG at the asked-for width", async (t) => {
  if (!(await canRaster())) {
    // The rasteriser is an optional native module. Where it is missing the
    // product degrades to the extension badge, which is a supported state —
    // so the suite reports the gap rather than failing the build.
    t.skip("no canvas binding on this platform");
    return;
  }

  const bytes = buildPdf([{ text: "Quarterly Report" }, { text: "Second page" }]);
  const rendered = await renderDocumentPage({ bytes, page: 1, targetWidth: 320 });

  assert.ok(rendered, "a valid PDF must produce a rendering");
  assert.equal(rendered!.mimeType, "image/jpeg");
  assert.ok(isJpeg(rendered!.bytes), "the bytes must actually be a JPEG");
  assert.equal(rendered!.width, 320);
  // US Letter is 612×792, so the height follows the page's own aspect rather
  // than being squared off — a thumbnail that crops the masthead is the bug.
  assert.ok(Math.abs(rendered!.height - Math.round(320 * (792 / 612))) <= 2);
  assert.ok(rendered!.bytes.byteLength < 200_000, "a tile must stay cheap to serve");
});

test("a page past the end of the document renders nothing rather than throwing", async (t) => {
  if (!(await canRaster())) return t.skip("no canvas binding on this platform");
  const bytes = buildPdf([{ text: "Only page" }]);
  assert.equal(await renderDocumentPage({ bytes, page: 9 }), null);
});

test("bytes that are not a PDF render nothing rather than throwing", async (t) => {
  if (!(await canRaster())) return t.skip("no canvas binding on this platform");
  // One damaged upload must not take out the request that asked for its tile.
  assert.equal(await renderDocumentPage({ bytes: new Uint8Array([1, 2, 3, 4]) }), null);
});

test("a crop keeps the region it was asked for and magnifies it", async (t) => {
  if (!(await canRaster())) return t.skip("no canvas binding on this platform");

  // Ink in the TOP-LEFT of the page only. PDF user space has y growing upward,
  // so a square at y=700 on a 792-high page is near the top of the image.
  const bytes = buildPdf([{ raw: inkSquare(40, 700, 60) }]);
  const page = await renderDocumentPage({ bytes, targetWidth: 800 });
  assert.ok(page);

  const cropped = await transformImage(page!.bytes, {
    region: { x: 0, y: 0, width: 20, height: 20 },
    maxEdge: 1_400,
    minEdge: 768,
  });
  assert.ok(cropped, "a crop of a valid image must come back");

  /*
   * THE POINT OF THE TOOL, asserted: a 20% crop is 160 px of an 800 px page,
   * and 160 px handed to a model is no more legible than the original was.
   * `minEdge` is what scales it back up, so the crop must come back LARGER
   * than the region it was taken from.
   */
  assert.ok(cropped!.width >= 768, `crop should be magnified, got ${cropped!.width}px`);
  assert.ok(cropped!.width <= 1_400, "and never past the ceiling");

  const whole = await imageDimensions(page!.bytes);
  assert.equal(whole?.width, 800);

  // The crop is darker than the same-sized crop of an empty corner: the ink
  // came with the region, rather than the region being read off the wrong
  // corner of the page (the y-axis flip is easy to get backwards, and a test
  // that only checked dimensions would never notice).
  const empty = await transformImage(page!.bytes, {
    region: { x: 70, y: 70, width: 20, height: 20 },
    maxEdge: 1_400,
    minEdge: 768,
  });
  assert.ok(empty);
  assert.ok(
    cropped!.bytes.byteLength > empty!.bytes.byteLength,
    "the corner with ink must not encode to the same size as blank paper",
  );
});

test("a crop of undecodable bytes is null, and tone options still encode", async (t) => {
  if (!(await canRaster())) return t.skip("no canvas binding on this platform");
  assert.equal(await transformImage(new Uint8Array([0, 1, 2])), null);
  assert.equal(await imageDimensions(new Uint8Array([0, 1, 2])), null);

  const bytes = buildPdf([{ text: "Faded scan" }]);
  const page = await renderDocumentPage({ bytes, targetWidth: 400 });
  const toned = await transformImage(page!.bytes, { grayscale: true, contrast: 1.6, rotate: 90 });
  assert.ok(toned);
  // A quarter turn swaps the axes; getting this wrong silently letterboxes a
  // sideways scan into an unreadable strip.
  assert.ok(toned!.width > toned!.height, "90° must transpose the output");
});
