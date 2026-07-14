import type WebSocket from "ws";
import { resamplePcm16 } from "./audio.js";
import type { ClientMessage, ServerMessage, VoiceHistoryEntry, VoiceProviderId } from "./protocol.js";
import {
  PLAYBACK_SAMPLE_RATE,
  VOICE_HISTORY_MAX_TOTAL_CHARS,
  VOICE_HISTORY_MAX_TURN_CHARS,
  VOICE_HISTORY_MAX_TURNS,
} from "./protocol.js";
import { PROVIDERS } from "./providers/registry.js";
import type { ProviderEvents, TranscriptEntry, VoiceProviderSession } from "./providers/types.js";

const VOICE_INSTRUCTIONS = `You are Juno, a warm, quick-witted voice assistant. You are having a spoken conversation: keep replies short and conversational (one to three sentences unless asked for more), never use markdown, lists, or symbols that sound wrong aloud, and match the user's language. It is fine to be interrupted mid-sentence — just pick up naturally.`;

/** One connected client = one RelaySession. Owns at most one provider session
 *  and the running transcript, which survives provider switches. */
export class RelaySession {
  private provider: VoiceProviderSession | null = null;
  private providerId: VoiceProviderId | null = null;
  private transcript: TranscriptEntry[] = [];
  // Rolling partials per role so switch-seeding only carries finalized turns.
  private partial: Record<"user" | "assistant", string> = { user: "", assistant: "" };
  private usage = { audioInSec: 0, audioOutSec: 0, extraCostUsd: 0 };
  private usageTimer: NodeJS.Timeout | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private switching = false;
  private closed = false;
  private historySeeded = false;

  constructor(
    private ws: WebSocket,
    readonly userId: string
  ) {
    this.usageTimer = setInterval(() => this.pushUsage(), 5000);
  }

  async handleText(raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "session.start":
        // Existing chat context is accepted once, on the initial start only.
        // Provider switches reuse the relay's finalized running transcript.
        if (!this.historySeeded) {
          this.transcript = sanitizeHistory(msg.history);
          this.historySeeded = true;
        }
        await this.startProvider(msg.provider);
        return;
      case "session.switch":
        await this.startProvider(msg.provider);
        return;
      case "input.text": {
        const text = String(msg.text ?? "").trim().slice(0, 4000);
        if (!text) return;
        const displayText = String(msg.displayText ?? text).trim().slice(0, 4000) || text;
        // Typed turns are first-class voice turns: keep them in provider-switch
        // history and echo them to the client transcript immediately.
        this.transcript.push({ role: "user", text, final: true });
        this.send({ type: "transcript", role: "user", text: displayText, final: true, turnId: msg.turnId });
        this.provider?.sendText(text);
        return;
      }
      case "control.interrupt":
        this.provider?.interrupt();
        return;
      case "video.frame": {
        const jpeg = Buffer.from(String(msg.jpegBase64 ?? ""), "base64");
        if (jpeg.length > 0 && jpeg.length < 2_000_000) this.provider?.sendVideoFrame(jpeg);
        return;
      }
      case "ping":
        this.send({ type: "pong" });
        return;
    }
  }

  handleAudio(pcm16k: Buffer): void {
    this.provider?.sendAudio(pcm16k);
  }

  private async startProvider(id: VoiceProviderId): Promise<void> {
    const factory = PROVIDERS[id];
    if (!factory) {
      this.send({ type: "error", message: `Unknown provider "${id}".` });
      return;
    }
    if (!factory.available()) {
      this.send({ type: "error", message: `${id} is not configured on this relay.` });
      return;
    }
    if (this.switching) return;
    this.switching = true;
    try {
      // Tear down the old session but keep the transcript for re-seeding.
      if (this.provider) {
        this.flushPartials();
        await this.provider.close().catch(() => {});
        this.provider = null;
      }
      if (this.sessionTimer) clearTimeout(this.sessionTimer);

      const session = factory.create();
      const events = this.makeEvents(id, session);
      await session.connect(
        { instructions: VOICE_INSTRUCTIONS, transcript: this.transcript.slice(-30) },
        events
      );
      this.provider = session;
      this.providerId = id;
      this.sessionTimer = setTimeout(() => {
        void this.provider?.close().catch(() => {});
        this.send({ type: "session.closed", reason: "session-limit" });
      }, factory.capabilities.maxSessionSec * 1000);
      this.send({ type: "session.ready", provider: id, capabilities: factory.capabilities });
    } catch (err) {
      this.send({
        type: "error",
        message: `Couldn't start ${id}: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.switching = false;
    }
  }

  private makeEvents(id: VoiceProviderId, session: VoiceProviderSession): ProviderEvents {
    const isCurrent = () => this.provider === session;
    return {
      onAudio: (pcm, rate) => {
        if (!isCurrent() || this.closed) return;
        const out = rate === PLAYBACK_SAMPLE_RATE ? pcm : resamplePcm16(pcm, rate, PLAYBACK_SAMPLE_RATE);
        if (this.ws.readyState === this.ws.OPEN) this.ws.send(out, { binary: true });
      },
      onTranscript: (t) => {
        if (!isCurrent()) return;
        if (t.final) {
          // Partial-accumulating providers (Gemini) send final:"" as a commit.
          const text = (t.text || this.partial[t.role]).trim();
          this.partial[t.role] = "";
          if (text) this.transcript.push({ role: t.role, text, final: true });
          if (t.text) this.send({ type: "transcript", role: t.role, text: t.text, final: true });
          else if (text) this.send({ type: "transcript", role: t.role, text, final: true });
        } else {
          this.partial[t.role] += t.text;
          this.send({ type: "transcript", role: t.role, text: t.text, final: false });
        }
      },
      onTurn: (phase) => isCurrent() && this.send({ type: "turn", speaker: "assistant", phase }),
      onInterrupted: () => {
        if (!isCurrent()) return;
        // Providers do not send a final transcript event for cancelled output.
        // Preserve the audible/visible prefix for provider-switch context, then
        // let the client seal its matching partial when it receives interrupted.
        this.commitPartial("assistant");
        this.send({ type: "interrupted" });
      },
      onUsage: (u) => {
        if (!isCurrent()) return;
        this.usage.audioInSec += u.audioInSec ?? 0;
        this.usage.audioOutSec += u.audioOutSec ?? 0;
        this.usage.extraCostUsd += u.extraCostUsd ?? 0;
      },
      onError: (message) => isCurrent() && this.send({ type: "error", message }),
      onClosed: (reason) => {
        if (!isCurrent()) return;
        this.send({ type: "session.closed", reason });
      },
    };
  }

  private flushPartials(): void {
    for (const role of ["user", "assistant"] as const) {
      this.commitPartial(role);
    }
  }

  private commitPartial(role: "user" | "assistant"): void {
    const text = this.partial[role].trim();
    this.partial[role] = "";
    if (text) this.transcript.push({ role, text, final: true });
  }

  private pushUsage(): void {
    if (!this.providerId) return;
    const p = PROVIDERS[this.providerId].pricing;
    const est =
      this.usage.audioInSec * p.audioInPerSec + this.usage.audioOutSec * p.audioOutPerSec + this.usage.extraCostUsd;
    if (this.usage.audioInSec === 0 && this.usage.audioOutSec === 0 && est === 0) return;
    this.send({
      type: "usage",
      provider: this.providerId,
      audioInSec: Math.round(this.usage.audioInSec * 10) / 10,
      audioOutSec: Math.round(this.usage.audioOutSec * 10) / 10,
      estCostUsd: Math.round(est * 10000) / 10000,
    });
  }

  private send(msg: ServerMessage): void {
    if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async destroy(): Promise<void> {
    this.closed = true;
    if (this.usageTimer) clearInterval(this.usageTimer);
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    await this.provider?.close().catch(() => {});
    this.provider = null;
  }
}

/** Keep the most recent valid turns within both per-turn and total bounds.
 * Iterate newest-first so old context is discarded before the latest user
 * request when the client sends more than the relay allows. */
function sanitizeHistory(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) return [];

  const result: TranscriptEntry[] = [];
  let remaining = VOICE_HISTORY_MAX_TOTAL_CHARS;
  const candidates = value.slice(-VOICE_HISTORY_MAX_TURNS) as VoiceHistoryEntry[];

  for (let i = candidates.length - 1; i >= 0 && remaining > 0; i--) {
    const turn = candidates[i];
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.text !== "string") continue;
    const text = turn.text.trim().slice(0, Math.min(VOICE_HISTORY_MAX_TURN_CHARS, remaining));
    if (!text) continue;
    result.unshift({ role: turn.role, text, final: true });
    remaining -= text.length;
  }

  return result;
}
