import type { ClientActionApproval } from "@/lib/action-approval";
import { createSseSender, parseSseFrame } from "@/lib/chat-stream";
import { assistantTurnRecord, type AssistantTurnRecord } from "@/lib/chat/assistant-turn";
import { parseClientFeatures, type ClientFeature } from "@/lib/chat/client-features";
import { serializeActivity } from "@/lib/chat/run-record";
import { SourceRegistry } from "@/lib/chat/source-registry";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import { noticeRow, turnStartFacts } from "@/lib/chat/turn-start-facts";
import { TurnStream } from "@/lib/chat/turn-stream";
import type { TaintSource, TurnTaint } from "@/lib/web/taint";
import type { UrlLedgerKind } from "@/lib/web/types";
import type { ChatFinishReason, ClientActivityEvent, ClientMessage, StreamChunk } from "@/types/chat";
import type { CanonicalToolId } from "@/types/run";
import type { TurnScript } from "./turn-scripts";

/*
 * PLAYS A TURN SCRIPT THROUGH THE REAL PIPELINE: the sender, the accumulator,
 * the source registry and `TurnStream`, with the route's own framing around
 * them — the `meta` frame, the turn-start facts, the mid-turn notices and the
 * terminal frame. What comes out is the SSE a client would have read, byte for
 * byte, on the script's clock.
 *
 * `turn-stream.test.ts`, the native conformance test and the `/dev/run`
 * gallery all read turns from here, so none of them can pass against a wire
 * the server does not produce (SPEC §11.1). The route-side parts (meta, facts,
 * terminal frame) follow what the chat route sends; only the provider stream
 * and the database are replaced.
 */

/** Script time zero. Every `createdAt`, `startedAt` and activity id derives from it. */
export const SCRIPT_EPOCH_MS = Date.parse("2026-09-23T19:07:00.000Z");

export interface PlayedFrame {
  atMs: number;
  chunk: StreamChunk;
  /** The frame exactly as it went on the wire. */
  bytes: Uint8Array;
}

export interface PlayedTurn {
  frames: PlayedFrame[];
  /** The persisted message the terminal `done` frame carried; null when the turn ended otherwise. */
  done: ClientMessage | null;
  /** What `TurnStream.finish()` returned. */
  answer: string;
  activity: ClientActivityEvent[];
  record: AssistantTurnRecord;
  /** Every approval handed to the route, in order. */
  approvals: ClientActionApproval[];
  /** Every value `onToolActivityChange` reported, in order. */
  activeCounts: number[];
  taintMarks: Array<{ source: TaintSource; severity?: "suspicious" | "hostile" }>;
  ledger: Array<{ url: string; kind: UrlLedgerKind }>;
  providerSearches: number;
  usageEvents: number;
}

export interface PlayOptions {
  /** Overrides the script's own declaration: `[]` plays it as a profile-1 (native) request. */
  features?: readonly ClientFeature[];
  /** Tool detail off, as under lockdown. */
  toolDetailEnabled?: boolean;
}

/** A taint that records what marked it; the real one is WS2's (SPEC §6.5). */
function recordingTaint(marks: PlayedTurn["taintMarks"]): TurnTaint {
  let observed = false;
  let severity: "none" | "suspicious" | "hostile" = "none";
  return {
    mark(source: TaintSource, level?: "suspicious" | "hostile") {
      observed = true;
      if (level === "hostile" || (level === "suspicious" && severity === "none")) severity = level;
      marks.push(level ? { source, severity: level } : { source });
    },
    get observed() {
      return observed;
    },
    get severity() {
      return severity;
    },
  } as unknown as TurnTaint;
}

function offeredTools(script: TurnScript): CanonicalToolId[] {
  const offered: CanonicalToolId[] = [];
  for (const step of script.steps) {
    if (step.event.type !== "tool" || step.event.phase !== "call") continue;
    const id = step.event.name.includes("__") ? "mcp" : (step.event.name as CanonicalToolId);
    if (!offered.includes(id)) offered.push(id);
  }
  return offered;
}

const decoder = new TextDecoder();

export function playTurnScript(script: TurnScript, options: PlayOptions = {}): PlayedTurn {
  const features = parseClientFeatures(options.features ?? script.features);
  let atMs = 0;
  const now = () => SCRIPT_EPOCH_MS + atMs;

  const frames: PlayedFrame[] = [];
  const controller = {
    enqueue(bytes: Uint8Array) {
      const parsed = parseSseFrame(decoder.decode(bytes).trim());
      if (!parsed) throw new Error("the sender wrote a frame with no data line");
      frames.push({ atMs, chunk: JSON.parse(parsed.data) as StreamChunk, bytes });
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const sender = createSseSender(controller, { features, now });

  const approvals: ClientActionApproval[] = [];
  const activeCounts: number[] = [];
  const taintMarks: PlayedTurn["taintMarks"] = [];
  const ledger: PlayedTurn["ledger"] = [];
  let providerSearches = 0;
  let usageEvents = 0;

  const sources = new SourceRegistry();
  const acc = new GenerationAccumulator({ sources });
  const turn = new TurnStream({
    sender,
    features,
    acc,
    sources,
    ledger: {
      addText() {},
      add(url: string, kind: UrlLedgerKind) {
        ledger.push({ url, kind });
      },
      match: () => null,
    },
    taint: recordingTaint(taintMarks),
    toolDetailEnabled: options.toolDetailEnabled ?? true,
    onToolActivityChange: (active) => activeCounts.push(active),
    onApproval: (approval) => {
      approvals.push(approval);
      // The route owns the approval frame; it goes out as it does today.
      sender.send({ type: "approval", approval });
    },
    onUsage: () => {
      usageEvents += 1;
    },
    onProviderSearch: () => {
      providerSearches += 1;
    },
    artifactEdit: false,
    now,
  });

  // The route's opening: `meta`, then the turn-start facts (SPEC §2.12).
  sender.send({
    type: "meta",
    conversationId: "conv_fixture",
    userMessageId: "msg_user_fixture",
    title: script.title,
    generationId: "gen_fixture",
  });
  for (const row of turnStartFacts({
    features,
    model: { key: "model", modelId: "anthropic:claude-fixture", provider: "anthropic", label: "Anthropic · Claude Fixture" },
    effort: null,
    context: { key: "context", historyMessages: 4, attachments: 0, projectFiles: 0 },
    connectors: script.start?.connectors ?? null,
    tools: { key: "tools", offered: offeredTools(script), nativeSearch: false, roundBudget: 10 },
    notices: script.start?.notices ?? [],
  })) {
    turn.emitActivity(row);
  }

  // The provider stream, with the route's mid-turn notices at their time.
  const notices = [...(script.notices ?? [])];
  for (const step of script.steps) {
    while (notices.length && notices[0].atMs <= step.atMs) {
      const next = notices.shift()!;
      atMs = next.atMs;
      turn.emitActivity(noticeRow(next.notice));
    }
    atMs = step.atMs;
    turn.apply(step.event);
  }
  for (const next of notices) {
    atMs = next.atMs;
    turn.emitActivity(noticeRow(next.notice));
  }
  atMs = (script.steps[script.steps.length - 1]?.atMs ?? 0) + 20;

  const finished = turn.finish(script.end === "completed" ? "completed" : "aborted");
  const finishReason: ChatFinishReason =
    script.end === "aborted" ? "user_stopped" : script.end === "failed" ? "network_error" : acc.finishReason;
  const hasOutput = !!(finished.answer || acc.reasoning);

  const handoff = !!script.handoffRunId && features.has("research_background");
  const persists = !handoff && (script.end === "completed" || hasOutput);
  // The route's closing rows, then the one write at the end (INV-13).
  if (persists) {
    sender.sendActivity({ kind: "done", title: finishReason === "stop" ? "Finished response" : "Response stopped" });
  }
  const record = assistantTurnRecord({
    answer: finished.answer,
    activity: sender.activityLog,
    reasoning: acc.reasoning,
    reasoningParts: acc.reasoningParts,
    sources: acc.sources,
    model: "anthropic:claude-fixture",
    finishReason,
  });

  let done: ClientMessage | null = null;
  if (handoff) {
    // The chat request that started a run writes no assistant row (INV-14).
    sender.send({ type: "handoff", to: "research", runId: script.handoffRunId!, userMessageId: "msg_user_fixture" });
  } else if (!persists) {
    sender.send({ type: "error", message: "The model stopped before writing anything.", finishReason });
  } else {
    // The message goes through the persisted round trip the route's own `done` does.
    const persisted = JSON.parse(JSON.stringify(record)) as AssistantTurnRecord;
    done = {
      id: "msg_assistant_fixture",
      role: "ASSISTANT",
      content: persisted.content,
      reasoning: persisted.reasoning,
      ...(persisted.reasoningParts.length ? { reasoningParts: persisted.reasoningParts } : {}),
      model: persisted.model,
      createdAt: new Date(now()).toISOString(),
      conversationId: "conv_fixture",
      attachments: [],
      ...(persisted.sources.length ? { sources: persisted.sources } : {}),
      activity: serializeActivity(persisted.activity),
      finishReason,
    };
    sender.send({
      type: "done",
      message: done,
      artifacts: [],
      memoryUpdated: false,
      quota: { plan: "PRO", used: 1, limit: null, remaining: null },
      finishReason,
      title: script.title,
    });
  }

  return {
    frames,
    done,
    answer: finished.answer,
    activity: finished.activity,
    record,
    approvals,
    activeCounts,
    taintMarks,
    ledger,
    providerSearches,
    usageEvents,
  };
}

/** Concatenated SSE bytes of a played turn: what a client's socket received. */
export function wireBytes(played: PlayedTurn): Uint8Array {
  const total = played.frames.reduce((sum, frame) => sum + frame.bytes.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const frame of played.frames) {
    out.set(frame.bytes, at);
    at += frame.bytes.length;
  }
  return out;
}
