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
  private ttsBusy = false;
  private ttsQueue: string[] = [];
  private speaking = false;
  private generation = 0; // bumped on interrupt: stale async work checks it
  private closedByUs = false;

  private llmModel = process.env.RELAY_MINIMAX_MODEL || "MiniMax-M2.7-highspeed";
  private ttsModel = process.env.RELAY_MINIMAX_TTS_MODEL || "speech-2.6-turbo";
  private baseUrl = (process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1").replace(/\/$/, "");

  async connect(seed: VoiceSessionSeed, events: ProviderEvents): Promise<void> {
    this.closedByUs = false;
    this.seed = seed;
    this.events = events;
    this.messages = [
      { role: "system" as const, content: seed.instructions },
      ...seed.transcript
        .filter((t) => t.text.trim())
        .map((t) => ({ role: t.role, content: t.text }) as const),
    ];
    await this.openTts(this.generation);
  }

  private async openTts(expectedGeneration: number): Promise<void> {
    if (this.closedByUs || expectedGeneration !== this.generation) return;
    const key = requiredEnv("MINIMAX_API_KEY");
    const ws = new WebSocket("wss://api.minimax.io/ws/v1/t2a_v2", {
      headers: { Authorization: `Bearer ${key}` },
    });
    this.tts = ws;
    this.ttsReady = false;
    this.ttsBusy = false;

    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (callback: () => void) => {
          clearTimeout(timer);
          ws.off("open", onOpen);
          ws.off("error", onError);
          ws.off("close", onClose);
          callback();
        };
        const onOpen = () => finish(resolve);
        const onError = (err: Error) => finish(() => reject(err));
        const onClose = () => finish(() => reject(new Error("minimax tts closed while connecting")));
        const timer = setTimeout(
          () => finish(() => reject(new Error("minimax tts connect timed out"))),
          15_000
        );
        ws.once("open", onOpen);
        ws.once("error", onError);
        ws.once("close", onClose);
      });
    } catch (err) {
      if (this.tts === ws) {
        this.tts = null;
        this.ttsReady = false;
        this.ttsBusy = false;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      throw err;
    }

    if (
      this.closedByUs ||
      expectedGeneration !== this.generation ||
      this.tts !== ws ||
      ws.readyState !== WebSocket.OPEN
    ) {
      if (this.tts === ws) this.tts = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      return;
    }

    ws.on("message", (data) => this.handleTts(data, ws));
    ws.on("close", () => {
      if (this.tts !== ws) return;
      this.tts = null;
      this.ttsReady = false;
      this.ttsBusy = false;
      if (!this.closedByUs) this.events?.onClosed("provider");
    });
    ws.on("error", (err) => {
      if (this.tts === ws) this.events?.onError(`minimax tts: ${err.message}`);
    });

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
    void this.runLlmTurn();
  }

  interrupt(): void {
    const hadActiveOutput = Boolean(this.llmAbort) || this.ttsBusy || this.ttsQueue.length > 0 || this.speaking;
    if (hadActiveOutput) this.generation++;
    this.llmAbort?.abort();
    this.llmAbort = null;
    this.ttsQueue = [];
    if (this.speaking) {
      this.speaking = false;
      this.events?.onTurn("end");
    }
    if (hadActiveOutput && !this.closedByUs) {
      const generation = this.generation;
      this.finishTtsSocket();
      void this.openTts(generation).catch((err) => {
        if (this.closedByUs || generation !== this.generation) return;
        this.events?.onError(`minimax tts restart: ${err instanceof Error ? err.message : String(err)}`);
        this.events?.onClosed("provider");
      });
    }
    this.events?.onInterrupted();
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.generation++;
    this.llmAbort?.abort();
    this.llmAbort = null;
    this.ttsQueue = [];
    this.finishTtsSocket();
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
    } finally {
      if (this.llmAbort === abort) this.llmAbort = null;
    }
  }

  private speak(sentence: string, gen: number): void {
    if (gen !== this.generation) return;
    const ws = this.tts;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ttsReady) {
      this.ttsQueue.push(sentence);
      return;
    }
    this.continueTts(ws, sentence);
  }

  private continueTts(ws: WebSocket, sentence: string): void {
    if (this.tts !== ws || ws.readyState !== WebSocket.OPEN) return;
    this.ttsBusy = true;
    ws.send(JSON.stringify({ event: "task_continue", text: sentence }));
  }

  private finishTtsSocket(): void {
    const ws = this.tts;
    this.tts = null;
    this.ttsReady = false;
    this.ttsBusy = false;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: "task_finish" }));
    } catch {
      /* socket already gone */
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }

  private handleTts(data: WebSocket.RawData, ws: WebSocket): void {
    if (this.tts !== ws || this.closedByUs) return;
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
        this.continueTts(ws, s);
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
      if (msg.is_final) this.ttsBusy = false;
    }
  }
}
