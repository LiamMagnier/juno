/**
 * A minimal PNG reader and writer, so the harness can compare screenshots
 * without adding a dependency (spec §14: no package adds npm dependencies).
 *
 * Reads 8-bit, non-interlaced greyscale, RGB, palette, grey+alpha and RGBA,
 * which covers Playwright screenshots and the native snapshot PNGs. Writes
 * 8-bit RGBA.
 */

import { deflateSync, inflateSync } from "node:zlib";

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(input: Uint8Array): Bitmap {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG file.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!width || !height) throw new Error("PNG has no IHDR.");
  if (bitDepth !== 8) throw new Error(`Only 8-bit PNGs are supported (got ${bitDepth}-bit).`);
  if (interlace !== 0) throw new Error("Interlaced PNGs are not supported.");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}.`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG image data is truncated.");
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += left;
          break;
        case 2:
          value += up;
          break;
        case 3:
          value += (left + up) >> 1;
          break;
        case 4:
          value += paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`Unknown PNG filter ${filter}.`);
      }
      out[x] = value & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    switch (colorType) {
      case 0:
        data[o] = data[o + 1] = data[o + 2] = pixels[i];
        data[o + 3] = 255;
        break;
      case 2:
        data[o] = pixels[i * 3];
        data[o + 1] = pixels[i * 3 + 1];
        data[o + 2] = pixels[i * 3 + 2];
        data[o + 3] = 255;
        break;
      case 3: {
        const index = pixels[i];
        if (!palette || index * 3 + 2 >= palette.length) throw new Error("PNG palette index out of range.");
        data[o] = palette[index * 3];
        data[o + 1] = palette[index * 3 + 1];
        data[o + 2] = palette[index * 3 + 2];
        data[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
        break;
      }
      case 4:
        data[o] = data[o + 1] = data[o + 2] = pixels[i * 2];
        data[o + 3] = pixels[i * 2 + 1];
        break;
      case 6:
        data[o] = pixels[i * 4];
        data[o + 1] = pixels[i * 4 + 1];
        data[o + 2] = pixels[i * 4 + 2];
        data[o + 3] = pixels[i * 4 + 3];
        break;
    }
  }
  return { width, height, data };
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(bitmap: Bitmap): Buffer {
  const { width, height, data } = bitmap;
  if (data.length !== width * height * 4) throw new Error("Bitmap data does not match its size.");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A blank bitmap filled with one colour. */
export function solidBitmap(width: number, height: number, rgba: readonly [number, number, number, number]): Bitmap {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set(rgba, i * 4);
  return { width, height, data };
}

export interface PixelDiff {
  /** Pixels whose largest channel difference exceeds the threshold. */
  differing: number;
  total: number;
  ratio: number;
  sameSize: boolean;
}

/** Counts differing pixels; a size change counts as every pixel differing. */
export function diffBitmaps(a: Bitmap, b: Bitmap, threshold = 16): PixelDiff {
  if (a.width !== b.width || a.height !== b.height) {
    const total = Math.max(a.width * a.height, b.width * b.height);
    return { differing: total, total, ratio: 1, sameSize: false };
  }
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
      Math.abs(a.data[i + 3] - b.data[i + 3])
    );
    if (delta > threshold) differing += 1;
  }
  const total = a.width * a.height;
  return { differing, total, ratio: total ? differing / total : 0, sameSize: true };
}
