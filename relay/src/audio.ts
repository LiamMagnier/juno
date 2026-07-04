/** PCM16LE mono helpers. All relay audio is Buffer of little-endian Int16. */

/** Linear-interpolation resample (fine for speech). */
export function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;
  const inSamples = Math.floor(input.length / 2);
  if (inSamples === 0) return Buffer.alloc(0);
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  const ratio = (inSamples - 1) / Math.max(1, outSamples - 1);
  for (let i = 0; i < outSamples; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const frac = pos - i0;
    const s0 = input.readInt16LE(i0 * 2);
    const s1 = input.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

export function pcm16DurationSec(bytes: number, rate: number): number {
  return bytes / 2 / rate;
}
