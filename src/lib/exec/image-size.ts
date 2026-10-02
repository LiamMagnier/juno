/** Image dimensions read from the header bytes, for produced images (pure). */
import { EXEC_LIMITS } from "@/lib/exec/config";

/** Width and height from a PNG, GIF, JPEG or WebP header; null when unknown. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length >= 24 && view.readUInt32BE(0) === 0x89504e47) {
    return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
  }
  if (view.length >= 10 && view.toString("ascii", 0, 3) === "GIF") {
    return { width: view.readUInt16LE(6), height: view.readUInt16LE(8) };
  }
  if (view.length >= 30 && view.toString("ascii", 0, 4) === "RIFF" && view.toString("ascii", 8, 12) === "WEBP") {
    const chunk = view.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + view.readUIntLE(24, 3), height: 1 + view.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: view.readUInt16LE(26) & 0x3fff, height: view.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = view.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if (view.length >= 4 && view[0] === 0xff && view[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < view.length) {
      if (view[offset] !== 0xff) return null;
      const marker = view[offset + 1];
      const length = view.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.readUInt16BE(offset + 5), width: view.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

/**
 * Whether a produced image may go back to the model in the tool round. The
 * file is attached either way; this is about the provider request. Anthropic
 * rejects an image over 8000 px on a side with a 400 that fails the whole turn,
 * and a program writes one easily (`savefig(dpi=1000)`), so an image whose
 * header gives no size, or a size over the bound, is not sent (the text then
 * says how many images follow, which is how the model knows).
 */
export function sendableDimensions(dimensions: { width: number; height: number } | null): boolean {
  if (!dimensions) return false;
  const { width, height } = dimensions;
  return width > 0 && height > 0 && width <= EXEC_LIMITS.maxImageSide && height <= EXEC_LIMITS.maxImageSide;
}
