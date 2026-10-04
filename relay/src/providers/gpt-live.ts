import WebSocket from "ws";
import type {
  ProviderEvents,
  SessionEstablished,
  VoiceProviderSession,
  VoiceSessionSeed,
} from "./types.js";
import { requiredEnv } from "./types.js";
import { providerText, withWebSearchLimit } from "../voice-context.js";
import { resamplePcm16 } from "../audio.js";
import { DEFAULT_VOICE_REASONING_EFFORT, type VoiceDelegate, type VoiceReasoningEffort } from "../protocol.js";

const DEFAULT_LIVE_URL = "wss://api.openai.com/v1/live/sessions";

/** The voice model: https://developers.openai.com/api/docs/models/gpt-live-1 */
export const GPT_LIVE_MODEL = "gpt-live-1";
/**
 * The backend Responses model GPT-Live delegates to. GPT-6.1 Sol accepts
 * low / medium / high / xhigh / max and NOT none or minimal
 * (https://developers.openai.com/api/docs/models/gpt-6.1-sol), which is why
 * the voice effort ladder starts at low.
 */
export const GPT_LIVE_DELEGATE_MODEL = "gpt-6.1-sol";

/** Web search for the delegate unless the relay is told otherwise. */
function delegateWebSearch(): boolean {
  return process.env.RELAY_OPENAI_BACKEND_WEB_SEARCH !== "0";
}

/** Read per call, not at import: tests point this at a local server. */
function liveUrl(): string {
  return process.env.RELAY_OPENAI_LIVE_URL || DEFAULT_LIVE_URL;
}

/**
 * GPT-Live-1 over OpenAI's `/v1/live/sessions` WebSocket.
 *
 * This is NOT the Realtime dialect the `openai-realtime` module speaks, and it
 * is not reachable by changing a model id: different URL, different handshake
 * (`session.start`, not `session.update`), different event names, and a session
 * config that rejects unknown fields outright.
 *
 * The deeper difference is architectural. GPT-Live is full duplex — it listens
 * and speaks at once — and it does its own reasoning nowhere: anything past
 * conversation is DELEGATED to a backend Responses model (GPT-6.1 Sol), which
 * is where the caller's effort choice lands
 * (`delegation.responses.reasoning.effort`), with the hosted `web_search`
 * tool registered so a delegated turn can look things up
 * (https://developers.openai.com/api/docs/guides/live-delegation). The voice
 * layer is billed per minute and the backend separately, so the estimate this
 * session reports covers the voice layer alone.
 *
 * Audio is PCM16 mono 24 kHz in both directions.
 */
export class GptLiveSession implements VoiceProviderSession {
  readonly provider = "openai" as const;
  private ws: WebSocket | null = null;
  private events: ProviderEvents | null = null;
  private closedByUs = false;
  private assistantSpeaking = false;
  private userTranscriptPending = false;
  private assistantTranscriptPending = false;
  /** Discard output that belongs to a turn the caller already interrupted. */
  private suppressAssistantOutput = false;
  private speechGapTimer: ReturnType<typeof setTimeout> | null = null;
  private startedResolve: (() => void) | null = null;
  /** The last error frame seen, so an abrupt close can quote it. */
  private lastErrorDetail = "";
  private readonly effort: VoiceReasoningEffort;
  private readonly model: string;
  private readonly backendModel: string;
  private readonly webSearch: boolean;

  /**
   * Full duplex has no turn boundaries to report, and OpenAI's own migration
   * guide is explicit that GPT-Live has no event marking the end of a spoken
   * response. Juno's transcript and its speaking indicator are built on those
   * boundaries, so this session infers the closing one: a pause in output
   * audio longer than a breath ends the turn. Too short and one sentence
   * becomes three rows; too long and the indicator keeps glowing after the
   * model has stopped. 700ms sits above normal inter-word gaps in 24 kHz
   * speech and below the point a listener would call it silence.
   */
  private static readonly SPEECH_GAP_MS = 700;

  constructor(options: { effort?: VoiceReasoningEffort } = {}) {
    this.effort = options.effort ?? DEFAULT_VOICE_REASONING_EFFORT;
    this.model = process.env.RELAY_OPENAI_MODEL || GPT_LIVE_MODEL;
    this.backendModel = process.env.RELAY_OPENAI_BACKEND_MODEL || GPT_LIVE_DELEGATE_MODEL;
    this.webSearch = delegateWebSearch();
  }

  /** What the delegate is configured as — the caller sees exactly this. */
  delegate(): VoiceDelegate {
    return { model: this.backendModel, effort: this.effort, webSearch: this.webSearch };
  }

  established(): SessionEstablished {
    // The delegate always reasons (GPT-6.1 Sol has no `none`), so a GPT-Live
    // call is a thinking call; how hard is `delegate.effort`.
    return { thinking: true, model: this.model, effort: this.effort, delegate: this.delegate() };
  }

  async connect(seed: VoiceSessionSeed, events: ProviderEvents): Promise<void> {
    this.events = events;
    const key = requiredEnv("OPENAI_API_KEY");
    const ws = new WebSocket(liveUrl(), { headers: { Authorization: `Bearer ${key}` } });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gpt-live connect timed out")), 15_000);
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
      if (detail) console.error("[gpt-live] closed", code, detail.slice(0, 300));
      if (!this.closedByUs) {
        if (detail) this.events?.onError(`gpt-live closed (${code}): ${detail.slice(0, 200)}`);
        this.events?.onClosed("provider");
      }
    });
    ws.on("error", (err) => this.events?.onError(`gpt-live: ${err.message}`));

    // The session config rejects unknown fields, so a rejected handshake comes
    // back as a close or a session.error rather than as a reply. Settle the
    // wait on all three, or every cause reads as a timeout.
    const started = new Promise<void>((resolve, reject) => {
      let settle = (err?: Error) => {
        void err;
      };
      const onStartClose = (code: number, reason: Buffer) => {
        const detail = reason?.toString().trim().slice(0, 200) || this.lastErrorDetail;
        // 1006 is synthetic: no close frame ever arrived, so the socket was
        // dropped rather than refused with a reason. Saying "refused, check
        // your model id" there invents a diagnosis the server never gave —
        // after an accepted upgrade it points at the account not carrying
        // GPT-Live, which no model id can fix.
        settle(
          new Error(
            code === 1006 && !detail
              ? `gpt-live dropped the connection after session.start with no close frame (model "${this.model}"). ` +
                `The upgrade was accepted, so the endpoint is reachable — most often this is an account without ` +
                `GPT-Live enabled. Pin RELAY_OPENAI_MODEL to a gpt-realtime id to use the previous protocol.`
              : `gpt-live refused the session for model "${this.model}" (close ${code}${detail ? `: ${detail}` : ""}). ` +
                `Check the model id and the backend delegation model "${this.backendModel}"; ` +
                `override them with RELAY_OPENAI_MODEL and RELAY_OPENAI_BACKEND_MODEL.`
          )
        );
      };
      const onStartError = (err: Error) => settle(new Error(`gpt-live session failed: ${err.message}`));
      const timer = setTimeout(
        () => settle(new Error(`gpt-live session timed out after 15s (model "${this.model}", no reply to session.start)`)),
        15_000
      );
      settle = (err?: Error) => {
        clearTimeout(timer);
        ws.off("close", onStartClose);
        ws.off("error", onStartError);
        this.startedResolve = null;
        if (err) reject(err);
        else resolve();
      };
      ws.on("close", onStartClose);
      ws.on("error", onStartError);
      this.startedResolve = () => settle();
    });

    this.send({
      type: "session.start",
      event_id: "juno_session_start",
      session: {
        model: this.model,
        // The shared instructions say the call cannot browse; with a
        // web-searching delegate it can, and must be told so or it refuses.
        instructions: this.webSearch ? withWebSearchLimit(seed.instructions) : seed.instructions,
        audio: {
          format: { type: "audio/pcm", rate: 24000 },
          // Always its own default. The only voice a seed carries is an
          // agent's (AGENT_VOICES in registry.ts), and those are Realtime and
          // Gemini names this protocol is not vetted against: a refusal here
          // would drop the call onto the Realtime fallback (openai-voice.ts)
          // under a notice that is not true.
          output: { voice: "marin" },
        },
        delegation: {
          type: "responses",
          responses: {
            model: this.backendModel,
            // Always said out loud: the API's default is `medium`, and the
            // caller's choice is the point of the control.
            reasoning: { effort: this.effort },
            // Hosted web search, so a delegated "what's the latest on…" is
            // answered from the web rather than from the training cutoff.
            ...(this.webSearch ? { tools: [{ type: "web_search" }] } : {}),
          },
        },
      },
    });

    await started;

    for (const turn of seed.transcript) {
      if (!turn.text.trim()) continue;
      this.sendItem(turn.role === "assistant" ? "assistant" : "user", [
        { type: turn.role === "assistant" ? "output_text" : "input_text", text: providerText(turn.text, turn.context) },
      ]);
    }
  }

  sendAudio(pcm16k: Buffer): void {
    // The mic arrives at 16 kHz; GPT-Live takes 24 kHz on this socket.
    const pcm24k = resamplePcm16(pcm16k, 16000, 24000);
    this.send({ type: "session.input_audio.append", audio: pcm24k.toString("base64") });
    this.events?.onUsage({ audioInSec: pcm16k.length / 2 / 16000 });
  }

  sendText(text: string): void {
    this.sendItem("user", [{ type: "input_text", text }]);
  }

  sendVideoFrame(jpeg: Buffer): void {
    this.sendItem("user", [
      { type: "input_image", detail: "auto", image_url: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
    ]);
  }

  interrupt(): void {
    // GPT-Live's migration guide lists no replacement for response.cancel:
    // being full duplex, it yields to the caller's voice on its own. So end
    // the turn locally and discard what is still arriving from it — with no
    // cancel to acknowledge and no end-of-response event, the drain is over
    // when the audio pauses, and armSpeechGap is what notices that.
    if (this.assistantSpeaking) {
      this.suppressAssistantOutput = true;
      this.endAssistantTurn();
      this.armSpeechGap();
    }
    this.events?.onInterrupted();
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.clearSpeechGap();
    this.send({ type: "session.close" });
    this.ws?.close();
    this.ws = null;
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private sendItem(role: "user" | "assistant", content: Record<string, unknown>[]): void {
    this.send({ type: "response.item.create", item: { type: "message", role, content } });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: {
      type?: string;
      delta?: string;
      error?: { message?: string } | string;
      message?: string;
    };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const ev = this.events;
    if (!ev) return;

    switch (msg.type) {
      case "session.started":
        this.startedResolve?.();
        this.startedResolve = null;
        return;

      case "session.input_audio.append":
        return; // our own frame echoed back

      case "session.output_audio.delta": {
        if (!msg.delta) return;
        if (this.suppressAssistantOutput) {
          // Tail of a response the caller talked over. Keep the countdown
          // running on it: the pause at its end is how we learn the old turn
          // has finished draining and the next one may be heard.
          this.armSpeechGap();
          return;
        }
        const pcm = Buffer.from(msg.delta, "base64");
        if (!this.assistantSpeaking) {
          this.assistantSpeaking = true;
          // The caller's turn is over the moment the model answers: GPT-Live
          // reports no completion for input transcription either.
          this.finalizeUserTranscript();
          ev.onTurn("start");
        }
        ev.onAudio(pcm, 24000);
        ev.onUsage({ audioOutSec: pcm.length / 2 / 24000 });
        this.armSpeechGap();
        return;
      }

      case "session.input_transcript.delta":
        if (!msg.delta) return;
        // No server event marks the start of the caller's speech; the first
        // fragment of their transcript is the earliest honest anchor for it.
        if (!this.userTranscriptPending) ev.onUserSpeechStart();
        this.userTranscriptPending = true;
        ev.onTranscript({ role: "user", text: msg.delta, final: false });
        return;

      case "session.output_transcript.delta":
        if (this.suppressAssistantOutput || !msg.delta) return;
        this.assistantTranscriptPending = true;
        ev.onTranscript({ role: "assistant", text: msg.delta, final: false });
        return;

      case "error":
      case "session.error": {
        const detail =
          typeof msg.error === "string" ? msg.error : msg.error?.message || msg.message || "unknown error";
        this.lastErrorDetail = detail.slice(0, 200);
        ev.onError(`gpt-live: ${detail}`);
        if (msg.type === "session.error") ev.onClosed("error");
        return;
      }

      default:
        return;
    }
  }

  /** Restart the silence countdown that stands in for an end-of-turn event. */
  private armSpeechGap(): void {
    this.clearSpeechGap();
    this.speechGapTimer = setTimeout(() => {
      this.speechGapTimer = null;
      if (this.suppressAssistantOutput) {
        // The interrupted response has stopped arriving. Anything after this
        // pause belongs to a new answer, and the caller should hear it.
        this.suppressAssistantOutput = false;
        return;
      }
      this.endAssistantTurn();
    }, GptLiveSession.SPEECH_GAP_MS);
  }

  private clearSpeechGap(): void {
    if (this.speechGapTimer) clearTimeout(this.speechGapTimer);
    this.speechGapTimer = null;
  }

  private endAssistantTurn(): void {
    this.clearSpeechGap();
    if (!this.assistantSpeaking) return;
    this.assistantSpeaking = false;
    this.events?.onTurn("end");
    if (this.assistantTranscriptPending) {
      this.assistantTranscriptPending = false;
      this.events?.onTranscript({ role: "assistant", text: "", final: true });
    }
  }

  private finalizeUserTranscript(): void {
    if (!this.userTranscriptPending) return;
    this.userTranscriptPending = false;
    this.events?.onTranscript({ role: "user", text: "", final: true });
  }
}
