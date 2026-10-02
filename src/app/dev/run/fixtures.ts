import type { ClientFeature } from "@/lib/chat/client-features";
import type { ClientMessage, StreamChunk } from "@/types/chat";

import { playTurnScript, SCRIPT_EPOCH_MS } from "../../../../tests/fixtures/turn-player";
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
export const FIXTURE_EPOCH = SCRIPT_EPOCH_MS;

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
  try {
    const played = playTurnScript(script, { features: script.features });
    const done: ClientMessage = played.done ?? {
      id: `msg_${script.fixture}`,
      role: "ASSISTANT",
      content: played.answer,
      reasoning: null,
      reasoningParts: null,
      sources: [...(played.record.sources ?? [])],
      activity: played.activity,
      createdAt: new Date(FIXTURE_EPOCH).toISOString(),
      attachments: [],
      finishReason: script.end === "aborted" ? "user_stopped" : script.end === "failed" ? "error" : "stop",
    };
    return {
      ok: true,
      fixture: {
        number: script.fixture,
        id: script.id,
        title: script.title,
        features: script.features,
        frames: played.frames.map((frame) => ({ atMs: frame.atMs, chunk: frame.chunk })),
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

export const RUN_FIXTURES: RunFixture[] = TURN_SCRIPTS
  .map(buildFixture)
  .filter((r): r is { ok: true; fixture: RunFixture } => r.ok)
  .map((r) => r.fixture);
