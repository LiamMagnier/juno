import type { SseSender } from "@/lib/chat-stream";
import { parseClientFeatures, type ClientFeature } from "@/lib/chat/client-features";
import { SourceRegistry } from "@/lib/chat/source-registry";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import { TurnStream } from "@/lib/chat/turn-stream";
import { TurnTaint } from "@/lib/web/taint";
import type { ClientActivityEvent, ClientMessage, StreamChunk } from "@/types/chat";

import { TURN_SCRIPTS, type TurnScript } from "../../../../tests/fixtures/turn-scripts";

/*
 * The `/dev/run` fixtures (SPEC §11.1), GENERATED, never hand-written: each
 * one is a turn script from `tests/fixtures/turn-scripts.ts` played through
 * the server's own `TurnStream` with a recording sender, so the gallery can
 * never pass against a wire the server does not produce. `turn-stream.test.ts`
 * (WS4) asserts the same frames.
 *
 * The recording sender mirrors `createSseSender`: it stamps an activity row's
 * id, time and `seq` at first emission and keeps them on every re-send. Its
 * clock is the script's (`atMs` after the fixture's start), so a row's
 * `createdAt` says when it happened in the turn and the view's timing reads
 * like the real turn's.
 *
 * Fixture 19 is the exception: a pre-rework message never streams again, so
 * it has no frames and its `done` is the persisted legacy row.
 */

export interface RunFixture {
  number: number;
  id: string;
  title: string;
  features: readonly ClientFeature[];
  frames: Array<{ atMs: number; chunk: StreamChunk }>;
  /** The persisted shape the player swaps in at the end (and renders alone on "reload"). */
  done: ClientMessage;
  /** A pre-rework row, rendered at rest only. */
  legacy: boolean;
  /** Needs the WS9b `MessageList` mode (the research hand-off). */
  needsMessageList: boolean;
}

export type FixtureResult =
  | { ok: true; fixture: RunFixture }
  | { ok: false; number: number; id: string; title: string; error: string };

/** The fixtures' shared start: a fixed instant, so every build of a fixture is identical. */
export const FIXTURE_EPOCH = Date.parse("2026-09-23T19:07:00.000Z");

function recordingSender(clock: { atMs: number }, frames: RunFixture["frames"]): SseSender {
  const activityLog: ClientActivityEvent[] = [];
  let counter = 0;
  const send = (chunk: StreamChunk) => {
    frames.push({ atMs: clock.atMs, chunk });
  };
  return {
    send,
    sendActivity(event) {
      counter += 1;
      const entry: ClientActivityEvent = {
        ...event,
        id: `activity-${FIXTURE_EPOCH + clock.atMs}-${counter}`,
        createdAt: new Date(FIXTURE_EPOCH + clock.atMs).toISOString(),
        seq: event.seq ?? counter,
      };
      activityLog.push(entry);
      send({ type: "activity", event: entry });
      return entry;
    },
    activityLog,
  };
}

function legacyFixture(script: TurnScript): RunFixture {
  const row = script.legacy!;
  return {
    number: script.fixture,
    id: script.id,
    title: script.title,
    features: script.features,
    frames: [],
    done: {
      id: `msg_${script.fixture}`,
      role: "ASSISTANT",
      content: row.content,
      reasoning: row.reasoning,
      activity: row.activity,
      sources: row.activity
        .filter((event) => event.kind === "visit" && event.url)
        .map((event) => ({ title: event.detail ?? event.url!, url: event.url!, snippet: "" })),
      createdAt: row.activity[0]?.createdAt ?? new Date(FIXTURE_EPOCH).toISOString(),
      attachments: [],
      finishReason: "stop",
    },
    legacy: true,
    needsMessageList: false,
  };
}

/** Plays one script through `TurnStream`. Never throws: a stub that is not built yet is reported. */
export function buildFixture(script: TurnScript): FixtureResult {
  if (script.legacy) return { ok: true, fixture: legacyFixture(script) };
  const frames: RunFixture["frames"] = [];
  const clock = { atMs: 0 };
  try {
    const features = parseClientFeatures(script.features);
    const sender = recordingSender(clock, frames);
    const acc = new GenerationAccumulator();
    const sources = new SourceRegistry();
    const stream = new TurnStream({
      sender,
      features,
      acc,
      sources,
      ledger: null,
      taint: new TurnTaint({ staticContent: false }),
      toolDetailEnabled: true,
      onToolActivityChange: () => {},
      onApproval: (approval) => sender.send({ type: "approval", approval }),
      onUsage: () => {},
      onProviderSearch: () => {},
      artifactEdit: false,
    });
    for (const step of script.steps) {
      clock.atMs = step.atMs;
      stream.apply(step.event);
    }
    const lastAt = script.steps.at(-1)?.atMs ?? 0;
    clock.atMs = lastAt + 10;
    const { answer, activity } = stream.finish(script.end === "aborted" ? "aborted" : "completed");
    const done: ClientMessage = {
      id: `msg_${script.fixture}`,
      role: "ASSISTANT",
      content: answer,
      reasoning: acc.reasoning || null,
      reasoningParts: acc.reasoningParts.length ? [...acc.reasoningParts] : null,
      sources: [...sources.all()],
      activity,
      createdAt: new Date(FIXTURE_EPOCH).toISOString(),
      attachments: [],
      finishReason: script.end === "aborted" ? "user_stopped" : script.end === "failed" ? "error" : acc.finishReason,
    };
    if (script.handoffRunId) {
      frames.push({ atMs: clock.atMs, chunk: { type: "handoff", to: "research", runId: script.handoffRunId, userMessageId: null } });
    } else if (script.end === "completed") {
      frames.push({
        atMs: clock.atMs,
        chunk: { type: "done", message: done, artifacts: [], memoryUpdated: false, quota: {} as never, finishReason: done.finishReason ?? "stop" },
      });
    } else {
      // A Stop keeps the partial answer; a dropped connection shows the error card.
      frames.push({
        atMs: clock.atMs,
        chunk: {
          type: "error",
          message: script.end === "aborted" ? "Stopped." : "The connection dropped before the answer finished.",
          finishReason: script.end === "aborted" ? "user_stopped" : "error",
          preservePartial: true,
        },
      });
    }
    return {
      ok: true,
      fixture: {
        number: script.fixture,
        id: script.id,
        title: script.title,
        features: script.features,
        frames,
        done,
        legacy: false,
        needsMessageList: Boolean(script.handoffRunId),
      },
    };
  } catch (error) {
    return {
      ok: false,
      number: script.fixture,
      id: script.id,
      title: script.title,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let cache: FixtureResult[] | null = null;

/** Every fixture, 1–28, built once. */
export function runFixtures(): FixtureResult[] {
  cache ??= TURN_SCRIPTS.map(buildFixture);
  return cache;
}
