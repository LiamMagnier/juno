import type {
  ProviderEvents,
  VoiceProviderSession,
  VoiceSessionSeed,
  SessionEstablished,
} from "./types.js";
import { GptLiveSession } from "./gpt-live.js";
import type { VoiceReasoningEffort } from "../protocol.js";
import { OpenAiShapedRealtimeSession, type RealtimeDialect } from "./openai-realtime.js";

/**
 * OpenAI voice, which is two protocols wearing one provider id.
 *
 * GPT-Live-1 is the current one and what this tries first. It is also a
 * capability an account either carries or does not, and an account without it
 * does not get a polite refusal — the upgrade is accepted and the socket is
 * then dropped with no close frame. There is no way to ask in advance.
 *
 * So ask by connecting, and keep the Realtime dialect as the answer to "no".
 * The alternative shapes badly in both directions: defaulting to Realtime
 * means an account that HAS GPT-Live never gets it, and failing hard means a
 * working voice mode is switched off by a capability check nobody ran.
 *
 * What is not acceptable is doing this quietly. A fallback session reasons
 * nowhere near where the caller asked it to — there is no delegate behind the
 * Realtime model — so `established()` reports the state the caller actually
 * got (thinking false, no delegate) and a note saying which protocol
 * answered. The relay puts both on session.ready, where they reach the UI
 * without ending the call the way an error would.
 */
export class OpenAiVoiceSession implements VoiceProviderSession {
  readonly provider = "openai" as const;
  private active: VoiceProviderSession | null = null;
  private readonly effort: VoiceReasoningEffort | undefined;
  private notice: string | undefined;
  private fellBack = false;

  constructor(
    private readonly dialect: RealtimeDialect,
    options: { effort?: VoiceReasoningEffort } = {}
  ) {
    this.effort = options.effort;
  }

  async connect(seed: VoiceSessionSeed, events: ProviderEvents): Promise<void> {
    const live = new GptLiveSession({ effort: this.effort });
    try {
      await live.connect(seed, events);
      this.active = live;
      return;
    } catch (err) {
      // Leave nothing half-open behind: the failed attempt owns a socket.
      await live.close().catch(() => {});
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[openai-voice] GPT-Live unavailable, falling back to Realtime:", reason);

      const realtime = new OpenAiShapedRealtimeSession(this.dialect);
      // If the fallback cannot connect either, that error is the one worth
      // raising: it is the protocol that used to work, so its failure is
      // about the key or the account, not about GPT-Live.
      await realtime.connect(seed, events);
      this.active = realtime;
      this.fellBack = true;
      this.notice =
        "GPT-Live is not available on this account, so this call is running on the previous Realtime model, " +
        "which has no thinking mode and no delegate to search the web. Everything else works.";
    }
  }

  established(): SessionEstablished {
    // A fallback session reasons nowhere the caller asked it to. Reporting the
    // request back would make the menu show a mode nothing is running.
    const answered = this.active?.established?.();
    return {
      thinking: this.fellBack ? false : (answered?.thinking ?? false),
      notice: this.notice,
      // Whichever leg answered names itself; the two run different models on
      // different protocols, so this is the only place that knows.
      model: answered?.model,
      delegate: this.fellBack ? undefined : answered?.delegate,
      effort: this.fellBack ? undefined : answered?.effort,
    };
  }

  sendAudio(pcm16k: Buffer): void {
    this.active?.sendAudio(pcm16k);
  }

  sendText(text: string): void {
    this.active?.sendText(text);
  }

  sendVideoFrame(jpeg: Buffer): void {
    this.active?.sendVideoFrame(jpeg);
  }

  interrupt(): void {
    this.active?.interrupt();
  }

  async close(): Promise<void> {
    const active = this.active;
    this.active = null;
    await active?.close();
  }
}
