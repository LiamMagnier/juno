import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  IPTC_COMPOSITE_TRAINED_ALGORITHMIC,
  IPTC_TRAINED_ALGORITHMIC,
  aiXmpPacket,
  markAiGenerated,
} from "../src/lib/ai-content-marking";

const INPUT = { generator: "Test Image <1>", product: "Alevr" };

async function image(format: "png" | "jpeg" | "webp", opts: { lossless?: boolean; alpha?: boolean } = {}): Promise<Buffer> {
  const base = sharp({
    create: { width: 3, height: 2, channels: opts.alpha ? 4 : 3, background: { r: 200, g: 40, b: 90, alpha: 0.5 } },
  });
  if (format === "png") return base.png().toBuffer();
  if (format === "jpeg") return base.jpeg().toBuffer();
  return base.webp({ lossless: opts.lossless ?? false }).toBuffer();
}

async function assertMarkedAndDecodable(bytes: Buffer, original: Buffer) {
  const meta = await sharp(bytes).metadata();
  const before = await sharp(original).metadata();
  assert.equal(meta.width, before.width);
  assert.equal(meta.height, before.height);
  assert.ok(meta.xmp, "the file carries an XMP packet a standard reader finds");
  const xmp = meta.xmp!.toString("utf8");
  assert.match(xmp, /Iptc4xmpExt:DigitalSourceType="http:\/\/cv\.iptc\.org\/newscodes\/digitalsourcetype\/trainedAlgorithmicMedia"/);
  // The pixels are untouched.
  const [a, b] = await Promise.all([sharp(bytes).raw().toBuffer(), sharp(original).raw().toBuffer()]);
  assert.ok(a.equals(b));
}

test("PNG gets an XMP iTXt and an ai-generated tEXt chunk, still decodes, pixels unchanged", async () => {
  const original = await image("png");
  const result = markAiGenerated(original, "image/png", INPUT);
  assert.equal(result.marked, "xmp");
  assert.ok(result.bytes.includes(Buffer.from("tEXtai-generated\0true", "latin1")));
  await assertMarkedAndDecodable(result.bytes, original);
});

test("JPEG gets an APP1 XMP segment after JFIF, still decodes", async () => {
  const original = await image("jpeg");
  const result = markAiGenerated(original, "image/jpeg", INPUT);
  assert.equal(result.marked, "xmp");
  await assertMarkedAndDecodable(result.bytes, original);
  // JFIF (APP0) stays the first segment when the encoder wrote one.
  if (original[2] === 0xff && original[3] === 0xe0) assert.equal(result.bytes[3], 0xe0);
});

test("WebP, lossy, lossless and with alpha, gets a VP8X-flagged XMP chunk", async () => {
  for (const opts of [{}, { lossless: true }, { lossless: true, alpha: true }, { alpha: true }]) {
    const original = await image("webp", opts);
    const result = markAiGenerated(original, "image/webp", INPUT);
    assert.equal(result.marked, "xmp", JSON.stringify(opts));
    await assertMarkedAndDecodable(result.bytes, original);
    assert.equal(result.bytes.readUInt32LE(4), result.bytes.length - 8, "RIFF size matches the file");
  }
});

test("marking twice is a no-op", async () => {
  for (const [format, mime] of [["png", "image/png"], ["jpeg", "image/jpeg"], ["webp", "image/webp"]] as const) {
    const once = markAiGenerated(await image(format), mime, INPUT);
    const twice = markAiGenerated(once.bytes, mime, INPUT);
    assert.equal(twice.marked, "skipped-already", format);
    assert.ok(twice.bytes.equals(once.bytes));
  }
});

test("a file with a C2PA manifest is left alone, so its signature still verifies", async () => {
  const png = await image("png");
  // Splice a caBX chunk (the C2PA box in PNG) before IEND.
  const iend = png.length - 12;
  const cabx = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from("caBX", "latin1"), Buffer.from("jumb"), Buffer.alloc(4)]);
  const signed = Buffer.concat([png.subarray(0, iend), cabx, png.subarray(iend)]);
  const result = markAiGenerated(signed, "image/png", INPUT);
  assert.equal(result.marked, "skipped-c2pa");
  assert.ok(result.bytes.equals(signed));
});

test("video, audio, unknown and broken files pass through unchanged", () => {
  const bytes = Buffer.from("not really a file");
  for (const mime of ["video/mp4", "audio/mpeg", "application/octet-stream"]) {
    assert.equal(markAiGenerated(bytes, mime, INPUT).marked, "skipped-unsupported");
  }
  for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
    const result = markAiGenerated(bytes, mime, INPUT);
    assert.equal(result.marked, "skipped-malformed");
    assert.ok(result.bytes.equals(bytes));
  }
});

test("the packet names the tool, escapes it, and says 'composite' for an edit; no personal data", () => {
  const packet = aiXmpPacket(INPUT);
  assert.ok(packet.includes(IPTC_TRAINED_ALGORITHMIC));
  assert.ok(packet.includes("Alevr (Test Image &lt;1&gt;)"));
  assert.ok(aiXmpPacket({ ...INPUT, edited: true }).includes(IPTC_COMPOSITE_TRAINED_ALGORITHMIC));
  assert.doesNotMatch(packet, /@|user|prompt/i);
});
