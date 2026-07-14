import WebSocket from "ws";
import type { ProviderEvents, VoiceProviderSession, VoiceSessionSeed, TranscriptEntry } from "./types.js";
import { requiredEnv } from "./types.js";

const LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Gemini Live API (native audio) over its stateful WebSocket.
 * Input 16 kHz PCM16, output 24 kHz PCM16. Connections live ~10 minutes: the
 * server sends goAway before dropping, and we transparently reconnect using
 * the session-resumption handle so one relay session spans many connections.
 */
export class GeminiLiveSession implements VoiceProviderSession {
  readonly provider = "gemini" as const;
  private ws: WebSocket | null = null;
  private events: ProviderEvents | null = null;
  private seed: VoiceSessionSeed | null = null;
  private resumeHandle: string | null = null;
  private closedByUs = false;
  private reconnecting = false;
  private assistantSpeaking = false;
  /** Gemini Live has no explicit cancel frame while automatic VAD is enabled.
   * After a manual interrupt, discard the old turn's remaining output until
   * the server acknowledges interruption or completes that turn. */
  private suppressAssistantOutput = false;
  private userTranscriptPending = false;
  private setupResolve: (() => void) | null = null;
  private model = process.env.RELAY_GEMINI_MODEL || "gemini-3.1-flash-live-preview";

  async connect(seed: VoiceSessionSeed, events: ProviderEvents): Promise<void> {
    this.seed = seed;
    this.events = events;
    await this.openConnection(seed, /* seedHistory */ true);
  }

  private async openConnection(seed: VoiceSessionSeed, seedHistory: boolean): Promise<void> {
    // The Live API needs a credential the CORE generativelanguage surface
    // accepts (a classic AI Studio API key). New "AQ."-format keys only work
    // on the OpenAI-compat surface — mint a standard key and set it here.
    const key = process.env.GEMINI_LIVE_API_KEY || requiredEnv("GOOGLE_API_KEY");
    const ws = new WebSocket(LIVE_URL, { headers: { "x-goog-api-key": key } });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gemini live connect timed out")), 15_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    ws.on("message", (data) => this.handleMessage(data));
    ws.on("close", (code, reason) => {
      const detail = reason?.toString() || "";
      if (detail) console.error("[gemini-live] closed", code, detail.slice(0, 300));
      // goAway-triggered reconnects set this.reconnecting first.
      if (!this.closedByUs && !this.reconnecting) {
        if (detail) this.events?.onError(`gemini closed (${code}): ${detail.slice(0, 200)}`);
        this.events?.onClosed("provider");
      }
    });
    ws.on("error", (err) => this.events?.onError(`gemini: ${err.message}`));

    const setupDone = new Promise<void>((resolve, reject) => {
      this.setupResolve = resolve;
      setTimeout(() => reject(new Error("gemini setup timed out")), 15_000);
    });

    this.send({
      setup: {
        model: `models/${this.model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          ...(seed.voice
            ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: seed.voice } } } }
            : {}),
        },
        systemInstruction: { parts: [{ text: seed.instructions }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Longer sessions: sliding-window compression + resumption handles.
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      },
    });

    await setupDone;

    // Resumption restores server-side context; only seed history on first open.
    if (seedHistory && seed.transcript.length) {
      this.send({
        clientContent: {
          turns: seed.transcript
            .filter((t) => t.text.trim())
            .map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
          turnComplete: false,
        },
      });
    }
  }

  sendAudio(pcm16k: Buffer): void {
    this.send({
      realtimeInput: { audio: { data: pcm16k.toString("base64"), mimeType: "audio/pcm;rate=16000" } },
    });
    this.events?.onUsage({ audioInSec: pcm16k.length / 2 / 16000 });
  }

  sendText(text: string): void {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
  }

  sendVideoFrame(jpeg: Buffer): void {
    this.send({ realtimeInput: { video: { data: jpeg.toString("base64"), mimeType: "image/jpeg" } } });
  }

  interrupt(): void {
    // Gemini has no explicit cancel event; its VAD cancels on user speech.
    // For the manual mute-button case, drop our speaking state so the client
    // UI recovers; the client flushes its own playback queue.
    const hadActiveOutput = this.assistantSpeaking;
    if (hadActiveOutput) {
      this.suppressAssistantOutput = true;
      this.assistantSpeaking = false;
      this.events?.onTurn("end");
    }
    this.events?.onInterrupted();
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: {
      setupComplete?: unknown;
      goAway?: { timeLeft?: string };
      sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
      serverContent?: {
        interrupted?: boolean;
        turnComplete?: boolean;
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }> };
      };
    };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const ev = this.events;
    if (!ev) return;

    if (msg.setupComplete !== undefined) {
      this.setupResolve?.();
      this.setupResolve = null;
      return;
    }
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
    }
    if (msg.goAway) {
      // Connection is about to die — roll to a fresh one with the handle.
      void this.reconnect();
      return;
    }
    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      const alreadyReported = this.suppressAssistantOutput;
      this.suppressAssistantOutput = false;
      if (this.assistantSpeaking) {
        this.assistantSpeaking = false;
        ev.onTurn("end");
      }
      if (!alreadyReported) ev.onInterrupted();
    }
    if (sc.inputTranscription?.text) {
      this.userTranscriptPending = true;
      ev.onTranscript({ role: "user", text: sc.inputTranscription.text, final: false });
    }

    // Gemini emits input transcription as rolling chunks with no dedicated
    // completion event. Once the model starts answering, the user's turn is
    // complete; commit the relay's accumulated user caption exactly once.
    const suppressAssistantOutput = this.suppressAssistantOutput;
    const modelResponseStarted =
      Boolean(sc.outputTranscription?.text) || Boolean(sc.modelTurn?.parts?.some((part) => part.text || part.inlineData));
    if (modelResponseStarted && !suppressAssistantOutput) this.finalizeUserTranscript();

    if (sc.outputTranscription?.text && !suppressAssistantOutput)
      ev.onTranscript({ role: "assistant", text: sc.outputTranscription.text, final: false });

    for (const part of suppressAssistantOutput ? [] : sc.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (inline?.data && inline.mimeType?.startsWith("audio/pcm")) {
        if (!this.assistantSpeaking) {
          this.assistantSpeaking = true;
          ev.onTurn("start");
        }
        const rate = Number(/rate=(\d+)/.exec(inline.mimeType)?.[1] ?? 24000);
        const pcm = Buffer.from(inline.data, "base64");
        ev.onAudio(pcm, rate);
        ev.onUsage({ audioOutSec: pcm.length / 2 / rate });
      }
    }
    if (sc.turnComplete) {
      // Fallback for textless/error responses where no model delta marked the
      // boundary. The pending flag prevents a duplicate final event.
      if (!suppressAssistantOutput) this.finalizeUserTranscript();
      if (!suppressAssistantOutput && this.assistantSpeaking) {
        this.assistantSpeaking = false;
        ev.onTurn("end");
        // Gemini transcription arrives as rolling partials; mark the turn's
        // transcript final so clients can commit the caption line.
        ev.onTranscript({ role: "assistant", text: "", final: true });
      }
      this.suppressAssistantOutput = false;
    }
  }

  private finalizeUserTranscript(): void {
    if (!this.userTranscriptPending) return;
    this.userTranscriptPending = false;
    this.events?.onTranscript({ role: "user", text: "", final: true });
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closedByUs || !this.seed) return;
    this.reconnecting = true;
    try {
      const old = this.ws;
      this.ws = null;
      old?.close();
      await this.openConnection(this.seed, /* seedHistory */ this.resumeHandle == null);
    } catch (err) {
      this.events?.onError(`gemini reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
      this.events?.onClosed("provider");
    } finally {
      this.reconnecting = false;
    }
  }
}
