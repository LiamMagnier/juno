import WebSocket from "ws";
import type { ProviderEvents, VoiceProviderSession, VoiceSessionSeed } from "./types.js";
import { requiredEnv } from "./types.js";
import { providerText } from "../voice-context.js";

const DEFAULT_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** The REST host the token exchange talks to; tests point it elsewhere. */
function restBase(): string {
  return process.env.RELAY_GEMINI_REST_URL || "https://generativelanguage.googleapis.com";
}

/** Read per call, not at import: tests point this at a local server. */
function liveUrl(): string {
  return process.env.RELAY_GEMINI_LIVE_URL || DEFAULT_LIVE_URL;
}

/**
 * Name what kind of key this is, without ever printing it.
 *
 * The Live surface takes a classic AI Studio key (`AIza…`). The newer `AQ.…`
 * keys authenticate only against the OpenAI-compat surface, and the failure
 * they produce here is a generic credential rejection that reads like a
 * revoked key rather than a key of the wrong kind.
 */
function describeGeminiKey(key: string): string {
  const source = process.env.GEMINI_LIVE_API_KEY ? "GEMINI_LIVE_API_KEY" : "GOOGLE_API_KEY";
  if (key.startsWith("AQ.")) {
    return (
      `${source} holds a new "AQ." key, which this socket does not take as a query key — that is expected, ` +
      `and the relay answers it by exchanging the key for a short-lived token.`
    );
  }
  if (!key.startsWith("AIza")) {
    return `${source} holds a key in neither known format, so nothing can be said about its kind.`;
  }
  return (
    `${source} holds a classic "AIza" key, so the shape is right — check that it is enabled for the ` +
    `Generative Language API and not restricted by referrer or IP.`
  );
}

/**
 * The API key travels in the query string, so it can surface in whatever a
 * socket error quotes back. Scrub it on the way out — an error message ends up
 * in a relay log and on the caller's screen, and neither is a place for a
 * credential.
 */
export function redactKey(message: string): string {
  // Both credentials ride in the query now — the key directly, and the
  // short-lived token it can be exchanged for.
  return message.replace(/([?&](?:key|access_token)=)[^&\s"']+/gi, "$1***");
}

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
  /** Set once the key has been exchanged; the socket then carries this. */
  private ephemeralToken: string | null = null;
  private readonly thinking: boolean;
  private readonly model: string;

  /**
   * Thinking is a MODEL here, not a parameter. Gemini 3.8 Live answers at
   * conversational latency; Extended Thinking is turn-based and reasons while
   * it speaks, narrating over the pause instead of leaving one. Both publish
   * the same per-minute audio rate, but Extended Thinking bills its reasoning
   * as output tokens, so a minute of it costs several times more than the
   * duration-based estimate below suggests.
   */
  constructor(options: { thinking?: boolean } = {}) {
    this.thinking = options.thinking === true;
    this.model = this.thinking
      ? process.env.RELAY_GEMINI_THINKING_MODEL || "gemini-3.8-live-extended-thinking"
      : process.env.RELAY_GEMINI_MODEL || "gemini-3.8-live";
  }

  async connect(seed: VoiceSessionSeed, events: ProviderEvents): Promise<void> {
    this.seed = seed;
    this.events = events;
    try {
      await this.openConnection(seed, /* seedHistory */ true);
    } catch (err) {
      // Google is retiring the classic "AIza" keys, and the "AQ." ones that
      // replaced them are not accepted as a `key` query parameter on this
      // socket. The documented path for them is to swap the key for a
      // short-lived token server-side — which is what this process is — and
      // carry that instead. Only worth trying when the credential is what was
      // refused; a wrong model id would fail the same way twice.
      if (!(err as { authRejected?: boolean }).authRejected) throw err;
      const token = await this.mintEphemeralToken().catch((mintErr: unknown) => {
        // Report the exchange's own failure, not a second copy of the socket's:
        // a key that cannot mint a token is a fact about the key, stated plainly.
        throw new Error(
          `${err instanceof Error ? err.message : String(err)} Exchanging it for a short-lived token failed too: ` +
            `${mintErr instanceof Error ? mintErr.message : String(mintErr)}`
        );
      });
      this.ephemeralToken = token;
      await this.openConnection(seed, /* seedHistory */ true);
    }
  }

  /**
   * Swap the API key for a short-lived Live token.
   *
   * `uses: 1` and the two expiries are the shape Google's own example uses:
   * a minute to open the session, half an hour to hold it. Nothing here is
   * cached — a token is worth one connection, and reconnects mint their own.
   */
  private async mintEphemeralToken(): Promise<string> {
    const key = process.env.GEMINI_LIVE_API_KEY || requiredEnv("GOOGLE_API_KEY");
    const now = Date.now();
    const res = await fetch(`${restBase()}/v1beta/auth_tokens`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText} — ${redactKey(text).replace(/\s+/g, " ").slice(0, 200)}`);
    }
    const name = (JSON.parse(text) as { name?: string }).name;
    if (!name) throw new Error("the token service answered 200 with no token in it");
    return name;
  }

  private async openConnection(seed: VoiceSessionSeed, seedHistory: boolean): Promise<void> {
    // This comment used to say that "AQ." keys work only on the OpenAI-compat
    // surface and that you should mint a classic one instead. Both halves are
    // now wrong: AI Studio issues nothing but "AQ." keys, so there is no
    // classic one to mint, and a probe of both surfaces shows the compat one
    // rejecting an AQ key with "Invalid Auth key" while the native one takes
    // it. What this socket will not do is accept one as `?key=`, which is what
    // the token exchange in connect() is for. `npm run gemini:live-auth`
    // re-runs that probe against whatever key is configured.
    const key = process.env.GEMINI_LIVE_API_KEY || requiredEnv("GOOGLE_API_KEY");
    // The Live socket authenticates by QUERY PARAMETER. `x-goog-api-key` is
    // what the REST surface takes, and it is simply not read on the WebSocket
    // upgrade — Google answers "Expected OAuth 2 access token, login cookie or
    // other valid authentication credential", which reads like a rejected key
    // and is really a credential it never saw. The header stays because
    // ephemeral tokens do travel that way and sending both costs nothing.
    const url = new URL(liveUrl());
    if (this.ephemeralToken) {
      // A token is accepted on the Constrained variant of the method, and as
      // `access_token` rather than `key`.
      url.pathname = `${url.pathname}Constrained`;
      url.searchParams.set("access_token", this.ephemeralToken);
    } else {
      url.searchParams.set("key", key);
    }
    const ws = new WebSocket(url.toString(), { headers: { "x-goog-api-key": key } });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gemini live connect timed out")), 15_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(new Error(redactKey(err.message)));
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
    ws.on("error", (err) => this.events?.onError(`gemini: ${redactKey(err.message)}`));

    // Gemini rejects a setup frame by CLOSING the socket, and this promise
    // used to settle on exactly two things: setupComplete, or a 15s timer. A
    // retired model id, a key the Live surface will not take, and a genuinely
    // mute server therefore all printed the same sentence — "gemini setup
    // timed out" — while the close carrying the real reason went to the relay
    // log and no further. Settle on the close too, and quote the server: that
    // sentence is the one that names the fix.
    const setupDone = new Promise<void>((resolve, reject) => {
      let settle = (err?: Error) => {
        void err;
      };
      const onSetupClose = (code: number, reason: Buffer) => {
        const detail = reason?.toString().trim().slice(0, 200);
        // Google reports an unusable credential and an unusable model through
        // the same close, so say which one this looks like rather than listing
        // both and leaving the reader to guess. The key's SHAPE is knowable
        // here without asking anyone: the Live surface takes classic AI Studio
        // keys, and the newer "AQ." keys reach only the OpenAI-compat surface.
        const authRejected = code === 1008 || /authenticat|credential|API key|permission/i.test(detail);
        const fail = (message: string) => {
          const error = new Error(message) as Error & { authRejected?: boolean };
          error.authRejected = authRejected;
          return error;
        };
        settle(
          fail(
            authRejected
              ? `gemini rejected the credential (close ${code}${detail ? `: ${detail}` : ""}). ` +
                describeGeminiKey(key) +
                ` The model id "${this.model}" was never reached — Google checks the credential first.`
              : `gemini refused the session setup for model "${this.model}" (close ${code}${detail ? `: ${detail}` : ""}). ` +
                `Check that the model id exists on the Live API; override it with RELAY_GEMINI_MODEL.`
          )
        );
      };
      const onSetupError = (err: Error) => settle(new Error(`gemini setup failed: ${redactKey(err.message)}`));
      const timer = setTimeout(
        () => settle(new Error(`gemini setup timed out after 15s (model "${this.model}", no reply to the setup frame)`)),
        15_000
      );
      settle = (err?: Error) => {
        clearTimeout(timer);
        ws.off("close", onSetupClose);
        ws.off("error", onSetupError);
        this.setupResolve = null;
        if (err) reject(err);
        else resolve();
      };
      ws.on("close", onSetupClose);
      ws.on("error", onSetupError);
      this.setupResolve = () => settle();
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
            .map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: providerText(t.text, t.context) }] })),
          turnComplete: false,
        },
      });
    }
  }

  sendAudio(pcm16k: Buffer): void {
    const base64 = pcm16k.toString("base64");
    this.send({
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64 }],
        audio: { data: base64, mimeType: "audio/pcm;rate=16000" },
      },
    });
    this.events?.onUsage({ audioInSec: pcm16k.length / 2 / 16000 });
  }

  sendText(text: string): void {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
  }

  sendVideoFrame(jpeg: Buffer): void {
    const base64 = jpeg.toString("base64");
    this.send({
      realtimeInput: {
        mediaChunks: [{ mimeType: "image/jpeg", data: base64 }],
        video: { data: base64, mimeType: "image/jpeg" },
      },
    });
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
      // Gemini reports no speech-onset event of its own; the cancel its VAD
      // raises when the caller starts talking is the same boundary.
      ev.onUserSpeechStart();
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
      this.events?.onError(`gemini reconnect failed: ${redactKey(err instanceof Error ? err.message : String(err))}`);
      this.events?.onClosed("provider");
    } finally {
      this.reconnecting = false;
    }
  }
}
