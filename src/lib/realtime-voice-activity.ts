/** Map linear microphone RMS onto the speech window used by native Juno. */
export function normalizedSpeechLoudness(rms: number): number {
  if (!(rms > 0)) return 0;
  const quietFloorDb = -52;
  const loudCeilingDb = -12;
  const decibels = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (decibels - quietFloorDb) / (loudCeilingDb - quietFloorDb)));
}

/**
 * Time-based voice activity detector for browser AudioWorklet frames.
 * AudioWorklet cadence changes with hardware buffer size, so durations are
 * explicit rather than assuming the native 30 Hz meter cadence.
 */
export class RealtimeVoiceActivityDetector {
  private speaking = false;
  private aboveMs = 0;
  private belowMs = 0;

  constructor(
    private readonly onsetThreshold = 0.34,
    private readonly releaseThreshold = 0.20,
    private readonly onsetMs = 90,
    private readonly releaseMs = 400,
  ) {}

  observe(loudness: number, durationMs: number): "began" | "ended" | null {
    const span = Math.max(0, durationMs);
    if (loudness >= this.onsetThreshold) {
      this.aboveMs += span;
      this.belowMs = 0;
    } else if (loudness <= this.releaseThreshold) {
      this.belowMs += span;
      this.aboveMs = 0;
    } else {
      return null;
    }

    if (!this.speaking && this.aboveMs >= this.onsetMs) {
      this.speaking = true;
      this.aboveMs = 0;
      return "began";
    }
    if (this.speaking && this.belowMs >= this.releaseMs) {
      this.speaking = false;
      this.belowMs = 0;
      return "ended";
    }
    return null;
  }

  reset(): void {
    this.speaking = false;
    this.aboveMs = 0;
    this.belowMs = 0;
  }
}
