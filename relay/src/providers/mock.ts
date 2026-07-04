import type { ProviderEvents, VoiceProviderSession, VoiceSessionSeed } from "./types.js";

/**
 * Dev-only provider (RELAY_ENABLE_MOCK=1): no external calls. Replies to any
 * user speech burst or text with a synthesized "voice" (vowel-ish tone) and a
 * scripted transcript, supports barge-in. Lets clients exercise the ENTIRE
 * relay pipeline — auth, audio both ways, transcripts, interruption — with no
 * provider account.
 */
export class MockVoiceSession implements VoiceProviderSession {
  readonly provider = "mock" as const;
  private events: ProviderEvents | null = null;
  private speakTimer: NodeJS.Timeout | null = null;
  private voicedMs = 0;
  private silentMs = 0;
  private replying = false;
  private counter = 0;

  async connect(_seed: VoiceSessionSeed, events: ProviderEvents): Promise<void> {
    this.events = events;
  }

  sendAudio(pcm16k: Buffer): void {
    // Tiny energy-based VAD: reply after ~400ms of voice followed by ~600ms of silence.
    let sum = 0;
    for (let i = 0; i < pcm16k.length; i += 2) {
      const s = pcm16k.readInt16LE(i) / 32768;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / Math.max(1, pcm16k.length / 2));
    const ms = (pcm16k.length / 2 / 16000) * 1000;
    if (rms > 0.02) {
      this.voicedMs += ms;
      this.silentMs = 0;
      if (this.replying) this.interrupt(); // barge-in
    } else if (this.voicedMs > 400) {
      this.silentMs += ms;
      if (this.silentMs > 600) {
        this.voicedMs = 0;
        this.silentMs = 0;
        this.reply("I heard you loud and clear. This is the mock voice provider speaking.");
      }
    }
    this.events?.onUsage({ audioInSec: ms / 1000 });
  }

  sendText(text: string): void {
    this.events?.onTranscript({ role: "user", text, final: true });
    this.reply(`You said: ${text}. Mock reply number ${++this.counter}.`);
  }

  sendVideoFrame(): void {}

  interrupt(): void {
    if (this.speakTimer) clearInterval(this.speakTimer);
    this.speakTimer = null;
    if (this.replying) {
      this.replying = false;
      this.events?.onTurn("end");
      this.events?.onInterrupted();
    }
  }

  async close(): Promise<void> {
    if (this.speakTimer) clearInterval(this.speakTimer);
    this.speakTimer = null;
    this.events = null;
  }

  private reply(text: string): void {
    const ev = this.events;
    if (!ev || this.replying) return;
    this.replying = true;
    ev.onTurn("start");

    const words = text.split(" ");
    let wordIdx = 0;
    let t = 0;
    const totalSec = Math.max(1.5, words.length * 0.28);
    this.speakTimer = setInterval(() => {
      if (!this.replying) return;
      // 200ms of warbly vowel-ish tone per tick at 24 kHz.
      const n = Math.floor(24000 * 0.2);
      const buf = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) {
        const tt = t + i / 24000;
        const f = 170 + 40 * Math.sin(2 * Math.PI * 1.7 * tt);
        const s = 0.3 * Math.sin(2 * Math.PI * f * tt) + 0.12 * Math.sin(2 * Math.PI * f * 3 * tt);
        const am = 0.55 + 0.45 * Math.abs(Math.sin(2 * Math.PI * 2.4 * tt));
        buf.writeInt16LE(Math.round(s * am * 32767 * 0.5), i * 2);
      }
      t += 0.2;
      ev.onAudio(buf, 24000);
      ev.onUsage({ audioOutSec: 0.2 });
      // Drip the transcript alongside the audio.
      const wordsDue = Math.floor((t / totalSec) * words.length);
      while (wordIdx < Math.min(wordsDue, words.length)) {
        ev.onTranscript({ role: "assistant", text: (wordIdx ? " " : "") + words[wordIdx], final: false });
        wordIdx++;
      }
      if (t >= totalSec) {
        if (this.speakTimer) clearInterval(this.speakTimer);
        this.speakTimer = null;
        this.replying = false;
        while (wordIdx < words.length) {
          ev.onTranscript({ role: "assistant", text: (wordIdx ? " " : "") + words[wordIdx], final: false });
          wordIdx++;
        }
        ev.onTranscript({ role: "assistant", text, final: true });
        ev.onTurn("end");
      }
    }, 200);
  }
}
