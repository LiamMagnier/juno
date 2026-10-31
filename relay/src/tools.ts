import { mintRelayCallbackToken, type RelayCallbackClaims, type VoiceToolGrant } from "./auth.js";
import type { ServerMessage, VoiceToolApproval, VoiceToolDeclaration, VoiceToolStatus } from "./protocol.js";
import type { VoiceToolCall } from "./providers/types.js";

/*
 * THE CHAT'S TOOLS, IN A VOICE CALL.
 *
 * The relay holds a socket, a user id and the provider's key. It does not hold
 * a database, a connector's OAuth token, the approval policy or the tool
 * registry, and this module keeps it that way: every tool a call can use is
 * listed by Juno (`GET /api/voice/tools`) and every call runs ON Juno
 * (`POST /api/voice/tools`), through the same toolset, dispatcher and approval
 * broker a typed chat turn uses. What crosses to the relay is a tool's name,
 * description and JSON Schema going out, and its result text coming back.
 *
 * Both legs are authenticated the way memory and spend are: a short-lived HMAC
 * callback token under the shared AUTH_SECRET, with an audience of its own and
 * the call's grant (conversation, connectors, time zone) signed inside it —
 * the claims the app put in the call's session token, carried back unchanged.
 *
 * APPROVALS. A change (send, create, book, delete) asks exactly when the chat
 * would ask, because it is the chat's broker asking. Juno streams the pending
 * approval before the call blocks on it; the relay puts the chat's own card on
 * the caller's screen (`tool.activity`) and answers the model at once with
 * "this is waiting, ask them", so the model can ask out loud instead of falling
 * silent. The person answers in one of two ways:
 *
 *   - on screen, through the card, which posts the decision with the cookie
 *     and the receipt digest as it does in the chat (`/api/approvals/[id]`);
 *   - aloud, for an action that can be put back or one that leaves Juno, by a
 *     clear yes or no in THEIR next turn — a turn that began after the card was
 *     raised, so the request that caused it can never count as its own answer,
 *     and not while the model's own voice was playing, so an echo of the model
 *     saying "yes" can never count either.
 *     The model never decides, and neither does the relay: it reads the
 *     person's transcribed words (`spokenDecision`) and tells their own
 *     signed-in client (`tool.spoken`), which answers the card through the
 *     same decision route, with the same digest, as a tap would. A decision
 *     arrives at Juno only from a signed-in person.
 *
 * Anything that cannot be undone (`screen`, the destructive class) takes the
 * card: a spoken yes is answered with "please tap Approve". When the broker
 * lets the call through, its outcome reaches the model as a turn of its own.
 */

/** The most tools one call is given, whatever Juno lists: a voice model choosing among more answers worse and later. */
export const VOICE_TOOLS_MAX = 32;
/**
 * How long a call start waits for the list before going ahead without tools:
 * past Juno's own budget for listing (5.5 s, which covers one connector's 5 s
 * connect), so a slow app costs the call that app, not every tool.
 */
const LIST_TIMEOUT_MS = 6_000;
/** One tool call's bound once it is running (the chat's connector bound). */
const CALL_TIMEOUT_MS = 60_000;
/** How long a change may wait on the person in a call before it is dropped (the receipt is superseded). */
export const VOICE_APPROVAL_WAIT_MS = 120_000;
/** The most result text one answer to the model carries. Juno bounds it first; this is the relay not trusting that. */
const RESULT_MAX_CHARS = 12_000;
/** A line of the call stream longer than this is not one Juno wrote. */
const STREAM_LINE_MAX_CHARS = 256_000;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CONFIRMATIONS = new Set(["none", "voice_or_screen", "screen"]);
const RESULT_STATUSES = new Set<VoiceToolStatus>(["succeeded", "failed", "denied", "cancelled"]);

/** How a tool's change is confirmed: not at all (a read), aloud or on screen, or only on screen. */
export type VoiceToolConfirmation = "none" | "voice_or_screen" | "screen";

export interface VoiceToolListing {
  declarations: VoiceToolDeclaration[];
  meta: Map<string, { label: string; confirm: VoiceToolConfirmation }>;
  /** Juno's note about these tools, for the instructions. */
  instructions: string | null;
}

function appBase(): string | null {
  const appUrl = process.env.JUNO_APP_URL;
  return appUrl ? appUrl.replace(/\/$/, "") : null;
}

/** The call's grant, as the claims a callback carries back. */
export function toolClaims(sessionId: string, grant: VoiceToolGrant): RelayCallbackClaims {
  return {
    sid: sessionId,
    ...(grant.conversationId ? { cid: grant.conversationId } : {}),
    ...(grant.connectorIds.length ? { cx: grant.connectorIds } : {}),
    ...(grant.timeZone ? { tz: grant.timeZone } : {}),
  };
}

/** Juno's answer to the list request, read as untrusted input: anything malformed is dropped, not repaired. */
export function readToolListing(body: unknown): VoiceToolListing | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { tools?: unknown }).tools;
  if (!Array.isArray(raw)) return null;
  const declarations: VoiceToolDeclaration[] = [];
  const meta: VoiceToolListing["meta"] = new Map();
  for (const entry of raw) {
    if (declarations.length >= VOICE_TOOLS_MAX) break;
    if (!entry || typeof entry !== "object") continue;
    const tool = entry as Record<string, unknown>;
    const { name, description, parameters, label, confirm } = tool;
    if (typeof name !== "string" || !NAME.test(name) || meta.has(name)) continue;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) continue;
    if ((parameters as { type?: unknown }).type !== "object") continue;
    declarations.push({
      name,
      description: typeof description === "string" ? description.slice(0, 1_024) : name,
      parameters: parameters as Record<string, unknown>,
    });
    meta.set(name, {
      label: typeof label === "string" && label.trim() ? label.trim().slice(0, 120) : name,
      // A tool whose confirmation is unreadable is treated as the strictest.
      confirm: typeof confirm === "string" && CONFIRMATIONS.has(confirm) ? (confirm as VoiceToolConfirmation) : "screen",
    });
  }
  const note = (body as { instructions?: unknown }).instructions;
  return {
    declarations,
    meta,
    instructions: typeof note === "string" && note.trim() ? note.replace(/\u0000/g, "").trim().slice(0, 2_000) : null,
  };
}

/**
 * Ask Juno which tools this call may use. Server to server, under the tools
 * audience. Any failure is "no tools": a call that cannot reach Juno's tools is
 * still a call, told it has none.
 */
export async function fetchVoiceTools(
  userId: string,
  sessionId: string,
  grant: VoiceToolGrant,
  fetchImpl: typeof fetch = fetch
): Promise<VoiceToolListing | null> {
  const base = appBase();
  if (!base) return null;
  try {
    const res = await fetchImpl(`${base}/api/voice/tools`, {
      headers: {
        Authorization: `Bearer ${mintRelayCallbackToken(userId, 60, "juno.voice.tools", toolClaims(sessionId, grant))}`,
      },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return readToolListing(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// A spoken yes or no
// ---------------------------------------------------------------------------

/** Words that are a yes on their own. A pure confirmation needs at least one. */
const STRONG_YES = new Set([
  "yes", "yeah", "yep", "yup", "yea", "sure", "ok", "okay", "confirm", "confirmed", "approve", "approved",
  "correct", "absolutely", "definitely", "alright", "affirmative",
  // A few of the languages a call is most often held in.
  "oui", "ja", "si", "sí", "sim", "da",
]);
/** Words that may sit beside a yes without changing it ("yes please, go ahead and send it"). */
const YES_COMPANIONS = new Set([
  "please", "go", "ahead", "do", "it", "that", "this", "send", "post", "create", "book", "save", "add", "schedule",
  "fine", "good", "great", "sounds", "thanks", "thank", "you", "all", "right", "just", "and", "now", "the", "one",
  "uh", "um", "hmm", "so", "well", "then", "merci", "danke", "gracias", "por", "favor", "bitte", "sil", "vous", "plait",
]);
/** Two-word yeses whose words are each only companions. */
const YES_PHRASES = [["go", "ahead"], ["do", "it"], ["send", "it"], ["sounds", "good"], ["that's", "fine"]];
const NO_WORDS = new Set([
  "no", "nope", "nah", "don't", "dont", "cancel", "stop", "never", "not", "wait", "hold", "decline", "deny",
  "non", "nein", "nee", "não", "nao", "niet",
]);

/** A spoken yes is at most this many words; anything longer is a sentence about something else. */
const MAX_DECISION_WORDS = 8;

/**
 * Whether the person's words answer a pending approval.
 *
 * Deliberately narrow. A yes is an utterance made ONLY of confirmation words
 * ("yes", "yeah go ahead", "okay send it", "oui merci") with at least one of
 * them a yes on its own: "send Bob an email saying yes" is a request, not an
 * answer, because "bob" and "email" are not confirmation words. A no is any
 * short utterance with a refusal in it and no yes ("no", "don't send that",
 * "wait"). Both at once ("no, yes, go") answers nothing, and anything else
 * answers nothing — the card stays on screen. Pure.
 */
export function spokenDecision(utterance: string): "allow" | "deny" | null {
  const words = utterance
    .toLowerCase()
    .normalize("NFC")
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
  if (words.length === 0 || words.length > MAX_DECISION_WORDS) return null;
  const refuses = words.some((word) => NO_WORDS.has(word)) || words.join(" ").includes("do not");
  const strong =
    words.some((word) => STRONG_YES.has(word)) ||
    YES_PHRASES.some(([a, b]) => words.some((word, i) => word === a && words[i + 1] === b));
  if (refuses) return strong ? null : "deny";
  if (!strong) return null;
  const pure = words.every((word) => STRONG_YES.has(word) || YES_COMPANIONS.has(word) || word === "that's");
  return pure ? "allow" : null;
}

// ---------------------------------------------------------------------------
// What the model is told
// ---------------------------------------------------------------------------

function quoted(preview: string): string {
  const line = preview.replace(/\s+/g, " ").trim().slice(0, 300);
  return line ? `"${line}"` : "this action";
}

/** The answer to a call that is now waiting on the person. */
export function pendingApprovalText(preview: string, spoken: boolean): string {
  return spoken
    ? `This needs the person's go-ahead and has not happened yet: ${quoted(preview)}. Ask them now, in one short sentence, whether to go ahead. They can say yes or no, or answer on the card on their screen. Do not call this tool again and do not say it is done: you will be told what happened.`
    : `This needs the person's go-ahead on their screen and has not happened yet: ${quoted(preview)}. Ask them to tap Approve or Decline on the card; a spoken yes is not enough for this one. Do not call this tool again and do not say it is done: you will be told what happened.`;
}

/** The turn that brings a waiting call's outcome to the model. */
export function lateOutcomeText(label: string, text: string): string {
  return `[Alevr: the outcome of "${label}", which was waiting for the person. This is a tool result, not something the person said.]\n${text}`;
}

export const SCREEN_ONLY_TEXT =
  "[Alevr: the person said yes aloud, but this action can only be approved on their screen. Ask them to tap Approve on the card, or Decline.]";
export const OVERLAPPED_YES_TEXT =
  "[Alevr: a yes that began while you were still speaking is not taken as an answer. Once you have finished, ask the person to say it again, or to tap Approve on the card.]";
const UNREACHABLE_TEXT = "The tool could not be reached, so nothing was done. Say so briefly.";
const TIMED_OUT_TEXT = "The tool did not finish in time, so its outcome is unknown. Say so briefly, and do not claim it worked.";

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

interface PendingApproval {
  callId: string;
  approval: VoiceToolApproval;
  spoken: boolean;
  /** The person's turn count when the card went up: only a later turn may answer it. */
  raisedAfterTurn: number;
  deciding: boolean;
  late: (text: string) => void;
}

function approvalOf(value: unknown): VoiceToolApproval | null {
  if (!value || typeof value !== "object") return null;
  const approval = value as Record<string, unknown>;
  if (typeof approval.id !== "string" || !approval.id || approval.id.length > 200) return null;
  if (typeof approval.receiptDigest !== "string" || !approval.receiptDigest || approval.receiptDigest.length > 200) return null;
  return {
    ...approval,
    id: approval.id,
    receiptDigest: approval.receiptDigest,
    riskClass: typeof approval.riskClass === "string" ? approval.riskClass : "unknown",
    preview: typeof approval.preview === "string" ? approval.preview.slice(0, 8_192) : "",
  };
}

/** Juno's call stream, one JSON object per line, until it ends or `signal` stops it. */
async function* ndjsonLines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  // A read waiting on a body the abort did not reach must still end.
  const stop = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.length > STREAM_LINE_MAX_CHARS && !buffered.includes("\n")) return;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          try {
            yield JSON.parse(line) as unknown;
          } catch {
            // A line that is not JSON is skipped; the result line decides the call.
          }
        }
        newline = buffered.indexOf("\n");
      }
    }
    const tail = (buffered + decoder.decode()).trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as unknown;
      } catch {
        // As above.
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
    // The result line ends the call; whatever follows it is not read.
    await reader.cancel().catch(() => undefined);
  }
}

export interface VoiceToolBridgeOptions {
  userId: string;
  /** The relay session's id: the broker's receipts for this call are keyed by it. */
  sessionId: string;
  grant: VoiceToolGrant;
  /** To the caller's client: the call's chips. */
  send: (msg: ServerMessage) => void;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Test seam: the list, instead of asking Juno. */
  listing?: VoiceToolListing | null;
  approvalWaitMs?: number;
}

/** One call's tools: the list, the calls in flight, and the approvals waiting on the person. */
export class VoiceToolBridge {
  private listing: VoiceToolListing | null = null;
  private loaded = false;
  private closed = false;
  private readonly inflight = new Map<string, AbortController>();
  private readonly pending = new Map<string, PendingApproval>();
  /** The person's turns so far; a turn is counted when it OPENS. */
  private turnSeq = 0;
  /** The current turn opened while the call's own voice could still be heard. */
  private turnOverlapped = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: VoiceToolBridgeOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Once per call. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.listing =
      this.opts.listing !== undefined
        ? this.opts.listing
        : await fetchVoiceTools(this.opts.userId, this.opts.sessionId, this.opts.grant, this.fetchImpl).catch(() => null);
  }

  get declarations(): VoiceToolDeclaration[] {
    return this.listing?.declarations ?? [];
  }

  get instructions(): string | null {
    return this.listing?.instructions ?? null;
  }

  /**
   * The person began a turn (speech onset, the first words of a caption, or a
   * typed turn). `overAssistant` is true when it began while the model's own
   * speech was still playing: a microphone without echo cancellation can hear
   * the model say "yes", and a model steered by a tool result could say it on
   * purpose, so such a turn may decline a card but never approve one.
   */
  userTurnOpened(overAssistant = false): void {
    this.turnSeq += 1;
    this.turnOverlapped = overAssistant;
  }

  /**
   * The person's turn, finished. A clear yes or no in a turn that began after
   * a card went up answers it — when exactly one card is waiting; with two,
   * which one a "yes" meant is a guess, so the cards decide.
   */
  userTurnFinal(text: string): void {
    if (this.closed || this.pending.size === 0) return;
    const decision = spokenDecision(text);
    if (!decision) return;
    const eligible = [...this.pending.values()].filter((p) => !p.deciding && p.raisedAfterTurn < this.turnSeq);
    if (eligible.length !== 1) return;
    const [waiting] = eligible;
    if (decision === "allow" && !waiting.spoken) {
      waiting.late(SCREEN_ONLY_TEXT);
      return;
    }
    if (decision === "allow" && this.turnOverlapped) {
      waiting.late(OVERLAPPED_YES_TEXT);
      return;
    }
    // The relay records nothing itself: it tells the person's own signed-in
    // client what they said, and the client answers the card through the
    // chat's decision route, with the digest it was shown.
    waiting.deciding = true;
    this.opts.send({
      type: "tool.spoken",
      id: waiting.callId,
      approvalId: waiting.approval.id,
      decision: decision === "allow" ? "allow_once" : "deny",
    });
  }

  /**
   * Run one tool call on Juno. Resolves with what the model is answered with
   * now; when the call waits on the person, that is a note saying so, and the
   * outcome is handed to `late` once it exists.
   */
  run(call: VoiceToolCall, late: (text: string) => void): Promise<string> {
    const meta = this.listing?.meta.get(call.name);
    if (!meta) return Promise.resolve(`Unknown tool "${call.name.slice(0, 64)}". Only the tools you were given can be used.`);
    if (this.closed) return Promise.resolve("The call is ending, so nothing was run.");
    if (this.inflight.has(call.id)) return Promise.resolve("This call is already running; wait for its result.");
    const base = appBase();
    if (!base) return Promise.resolve(UNREACHABLE_TEXT);

    const controller = new AbortController();
    this.inflight.set(call.id, controller);
    // Unref'd: a call's bound must never be what keeps a stopping relay alive.
    let timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    timer.unref?.();
    const rearm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), ms);
      timer.unref?.();
    };

    let answered = false;
    let resolveNow: (text: string) => void = () => {};
    const now = new Promise<string>((resolve) => (resolveNow = resolve));
    const answer = (text: string) => {
      const bounded = text.slice(0, RESULT_MAX_CHARS);
      if (!answered) {
        answered = true;
        resolveNow(bounded);
      } else if (!this.closed) {
        late(lateOutcomeText(meta.label, bounded));
      }
    };
    const activity = (status: VoiceToolStatus, extra: { approval?: VoiceToolApproval; spoken?: boolean } = {}) => {
      if (!this.closed) this.opts.send({ type: "tool.activity", id: call.id, name: call.name, label: meta.label, status, ...extra });
    };

    activity("running");
    let approvalId: string | null = null;
    void (async () => {
      try {
        const res = await this.fetchImpl(`${base}/api/voice/tools`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson",
            Authorization: `Bearer ${mintRelayCallbackToken(
              this.opts.userId,
              60,
              "juno.voice.tools",
              toolClaims(this.opts.sessionId, this.opts.grant)
            )}`,
          },
          body: JSON.stringify({ callId: call.id.slice(0, 200), name: call.name, arguments: call.arguments.slice(0, 64_000) }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          activity("failed");
          answer(UNREACHABLE_TEXT);
          return;
        }
        for await (const frame of ndjsonLines(res.body, controller.signal)) {
          const record = (frame ?? {}) as { type?: unknown; approval?: unknown; spoken?: unknown; status?: unknown; text?: unknown };
          if (record.type === "approval") {
            const approval = approvalOf(record.approval);
            if (!approval || approvalId) continue;
            approvalId = approval.id;
            // Spoken only when both the receipt (the call's real arguments) and
            // the tool's listing allow it: either one saying "screen" wins.
            const spoken = record.spoken === true && meta.confirm !== "screen";
            this.pending.set(approval.id, {
              callId: call.id,
              approval,
              spoken,
              raisedAfterTurn: this.turnSeq,
              deciding: false,
              late: (text) => {
                if (!this.closed) late(text);
              },
            });
            rearm(this.opts.approvalWaitMs ?? VOICE_APPROVAL_WAIT_MS);
            activity("awaiting_approval", { approval, spoken });
            answer(pendingApprovalText(approval.preview, spoken));
            continue;
          }
          if (record.type === "result") {
            const status = RESULT_STATUSES.has(record.status as VoiceToolStatus) ? (record.status as VoiceToolStatus) : "failed";
            if (approvalId) this.pending.delete(approvalId);
            activity(status);
            answer(typeof record.text === "string" && record.text.trim() ? record.text : UNREACHABLE_TEXT);
            return;
          }
        }
        // The stream ended with no result: cut off by the call ending or the
        // time running out, or Juno going away mid-call.
        if (this.closed) return;
        activity(controller.signal.aborted ? "cancelled" : "failed");
        answer(controller.signal.aborted ? TIMED_OUT_TEXT : UNREACHABLE_TEXT);
      } catch {
        if (this.closed) return;
        activity(controller.signal.aborted ? "cancelled" : "failed");
        answer(controller.signal.aborted ? TIMED_OUT_TEXT : UNREACHABLE_TEXT);
      } finally {
        clearTimeout(timer);
        if (approvalId) this.pending.delete(approvalId);
        this.inflight.delete(call.id);
      }
    })();
    return now;
  }

  /** The call ended: everything in flight is cancelled, and Juno supersedes any approval still waiting. */
  close(): void {
    this.closed = true;
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    this.pending.clear();
  }
}
