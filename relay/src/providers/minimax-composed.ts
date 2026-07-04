import WebSocket from "ws";
import type { ProviderEvents, VoiceProviderSession, VoiceSessionSeed } from "./types.js";
import { requiredEnv } from "./types.js";

/**
 * MiniMax has NO public speech-to-speech API (verified 2026-07): its 2024
 * "Realtime API" announcement never shipped docs. This adapter is the honest
 * composed pipeline instead:
 *
 *   client on-device speech recognition (needsClientTranscript)
 *     -> input.text -> MiniMax M-series chat completion (streaming)
 *     -> sentence chunks -> MiniMax T2A WebSocket TTS (speech-2.6-turbo, PCM 24k)
 *     -> audio back to the client.
 *
 * Latency is higher than true S2S; barge-in aborts both the LLM stream and
 * the TTS task.
 */
export class MinimaxComposedSession implements VoiceProviderSession {
  readonly provider = "minimax" as const;
  private events: ProviderEvents | null = null;
  private seed: VoiceSessionSeed | null = null;
  private messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  private llmAbort: AbortController | null = null;
  private tts: WebSocket | null = null;
  private ttsReady = false;
  private ttsQueue: string[] = [];
  private speaking = false;
  private generation = 0; // bumped on interrupt: stale async work checks it
  private closedByUs = false;

  private llmModel = process.env.RELAY_MINIMAX_MODEL || "MiniMax-M2.7-highspeed";
  private ttsModel = process.env.RELAY_MINIMAX_TTS_MODEL || "speech-2.6-turbo";
  private baseUrl = (process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1").replace(/\/$/, "");

  async connect(seed: VoiceSessionSeed, events: ProviderEvents): Promise<void> {
    this.seed = seed;
    this.events = events;
    this.messages = [
      { role: "system" as const, content: seed.instructions },
      ...seed.transcript
        .filter((t) => t.text.trim())
        .map((t) => ({ role: t.role, content: t.text }) as const),
    ];
    await this.openTts();
  }

  private async openTts(): Promise<void> {
    const key = requiredEnv("MINIMAX_API_KEY");
    const ws = new WebSocket("wss://api.minimax.io/ws/v1/t2a_v2", {
      headers: { Authorization: `Bearer ${key}` },
    });
    this.tts = ws;
    this.ttsReady = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("minimax tts connect timed out")), 15_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    ws.on("message", (data) => this.handleTts(data));
    ws.on("close", () => {
      this.ttsReady = false;
      if (!this.closedByUs) this.events?.onClosed("provider");
    });
    ws.on("error", (err) => this.events?.onError(`minimax tts: ${err.message}`));

    ws.send(
      JSON.stringify({
        event: "task_start",
        model: this.ttsModel,
        voice_setting: { voice_id: this.seed?.voice || "English_expressive_narrator", speed: 1, vol: 1, pitch: 0 },
        audio_setting: { format: "pcm", sample_rate: 24000, channel: 1 },
      })
    );
  }

  sendAudio(): void {
    // Composed pipeline: audio is transcribed on-device; nothing to do here.
  }

  sendVideoFrame(): void {
    // No video input in the composed pipeline.
  }

  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.interrupt(); // a new user utterance always supersedes current output
    this.messages.push({ role: "user", content: trimmed });
    this.events?.onTranscript({ role: "user", text: trimmed, final: true });
    void this.runLlmTurn();
  }

  interrupt(): void {
    this.generation++;
    this.llmAbort?.abort();
    this.llmAbort = null;
    this.ttsQueue = [];
    if (this.speaking) {
      this.speaking = false;
      this.events?.onTurn("end");
    }
    this.events?.onInterrupted();
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.llmAbort?.abort();
    try {
      this.tts?.send(JSON.stringify({ event: "task_finish" }));
    } catch {
      /* socket already gone */
    }
    this.tts?.close();
    this.tts = null;
  }

  private async runLlmTurn(): Promise<void> {
    const gen = this.generation;
    const ev = this.events;
    if (!ev) return;
    const key = requiredEnv("MINIMAX_API_KEY");
    const abort = new AbortController();
    this.llmAbort = abort;

    let full = "";
    let sentenceBuf = "";
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: this.llmModel, messages: this.messages, stream: true, max_tokens: 400 }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        throw new Error(`minimax llm ${res.status}: ${body.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (gen !== this.generation) return; // interrupted
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          if (!json || json === "[DONE]") continue;
          try {
            const delta = (JSON.parse(json) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]
              ?.delta?.content;
            if (typeof delta === "string" && delta) {
              full += delta;
              sentenceBuf += delta;
              ev.onTranscript({ role: "assistant", text: delta, final: false });
              // Flush complete sentences to TTS for early speech.
              const m = /^([\s\S]*?[.!?…。！？])(\s|$)/.exec(sentenceBuf);
              if (m && m[1].trim().length > 1) {
                this.speak(m[1].trim(), gen);
                sentenceBuf = sentenceBuf.slice(m[0].length);
              }
            }
          } catch {
            /* skip malformed frame */
          }
        }
      }
      if (gen !== this.generation) return;
      if (sentenceBuf.trim()) this.speak(sentenceBuf.trim(), gen);
      if (full.trim()) {
        this.messages.push({ role: "assistant", content: full });
        ev.onTranscript({ role: "assistant", text: full, final: true });
        // ~$0.06 per 1k TTS chars (speech-2.6-turbo $60/M) + rough LLM cost.
        ev.onUsage({ extraCostUsd: (full.length / 1000) * 0.06 + 0.0005 });
      }
    } catch (err) {
      if (!abort.signal.aborted) ev.onError(`minimax llm: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private speak(sentence: string, gen: number): void {
    if (gen !== this.generation) return;
    if (!this.tts || this.tts.readyState !== WebSocket.OPEN) return;
    if (!this.ttsReady) {
      this.ttsQueue.push(sentence);
      return;
    }
    this.tts.send(JSON.stringify({ event: "task_continue", text: sentence }));
  }

  private handleTts(data: WebSocket.RawData): void {
    let msg: { event?: string; data?: { audio?: string }; is_final?: boolean; base_resp?: { status_code?: number; status_msg?: string } };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const ev = this.events;
    if (!ev) return;

    if (msg.base_resp && msg.base_resp.status_code && msg.base_resp.status_code !== 0) {
      ev.onError(`minimax tts: ${msg.base_resp.status_msg ?? msg.base_resp.status_code}`);
      return;
    }
    if (msg.event === "task_started" || msg.event === "connected_success") {
      this.ttsReady = true;
      for (const s of this.ttsQueue.splice(0)) {
        this.tts?.send(JSON.stringify({ event: "task_continue", text: s }));
      }
      return;
    }
    if (msg.event === "task_continued" && msg.data?.audio) {
      // Audio arrives hex-encoded PCM.
      const pcm = Buffer.from(msg.data.audio, "hex");
      if (pcm.length) {
        if (!this.speaking) {
          this.speaking = true;
          ev.onTurn("start");
        }
        ev.onAudio(pcm, 24000);
        ev.onUsage({ audioOutSec: pcm.length / 2 / 24000 });
      }
      if (msg.is_final && this.speaking) {
        this.speaking = false;
        ev.onTurn("end");
      }
    }
  }
}
