/**
 * Microphone samples → a 16 kHz mono 16-bit WAV blob.
 *
 * Dictation records PCM rather than MediaRecorder's webm/opus because WAV is
 * the one container every speech-to-text provider accepts (Gemini does not
 * list webm), and 16 kHz is what those models resample to anyway: 32 kB per
 * second, so a minute of speech is under 2 MB.
 */

export interface PcmTake {
  /** Float32 frames in [-1, 1] at `sampleRate`. */
  chunks: Float32Array[];
  sampleRate: number;
  /** Total frames across `chunks`. */
  samples: number;
}

const TARGET_RATE = 16_000;

/** Average-downsample to 16 kHz: a box filter, enough for speech. */
function downsample(take: PcmTake): Int16Array {
  const ratio = take.sampleRate / TARGET_RATE;
  const outLength = Math.floor(take.samples / ratio);
  const out = new Int16Array(outLength);
  let chunkIndex = 0;
  let offset = 0;
  const next = () => {
    while (chunkIndex < take.chunks.length && offset >= take.chunks[chunkIndex].length) {
      chunkIndex++;
      offset = 0;
    }
    if (chunkIndex >= take.chunks.length) return 0;
    return take.chunks[chunkIndex][offset++];
  };
  let carry = 0;
  for (let i = 0; i < outLength; i++) {
    const end = (i + 1) * ratio;
    let sum = 0;
    let count = 0;
    while (carry < end) {
      sum += next();
      count++;
      carry++;
    }
    const v = count ? sum / count : 0;
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  return out;
}

export function encodeWav(take: PcmTake): Blob {
  const pcm = take.sampleRate === TARGET_RATE
    ? Int16Array.from(take.chunks.flatMap((c) => Array.from(c, (v) => Math.max(-1, Math.min(1, v)) * 0x7fff)))
    : downsample(take);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (at: number, text: string) => [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  write(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm.buffer as ArrayBuffer], { type: "audio/wav" });
}
