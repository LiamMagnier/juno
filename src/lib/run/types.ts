/**
 * The client run model's shared shapes (SPEC §7).
 *
 * The run UI's modules — the view builder, the phase derivation, the
 * presentation registry, the loop arbiter — are built in one workstream and
 * read by three others (the Activity panel, the Research UI, integration). The
 * types live here so a consumer can be written against them before the
 * modules behind them exist; each module re-exports the ones it owns.
 *
 * Types only.
 */

import type { ChatFinishReason, ClientMemoryReceipt, ClientToolDetail } from "@/types/chat";
import type { RunFact, RunNotice, ToolCallRecord } from "@/types/run";
import type { ToolIconKind } from "@/lib/tools/types";

// ── The view (src/lib/run/timeline.ts) ────────────────────────────────────────

export type RunItem =
  | { kind: "reasoning"; key: string; seq: number; round: number; part?: number; text: string; live: boolean }
  | { kind: "commentary"; key: string; seq: number; round: number; text: string; inline: boolean }
  | { kind: "tool"; key: string; seq: number; round: number; call: ToolCallRecord;
      detail?: ClientToolDetail; live: boolean }
  | { kind: "notice"; key: string; seq: number; notice: RunNotice | null; legacyTitle: string; legacyDetail?: string };

export interface RunView {
  typed: boolean;                      // false → built by the legacy adapter
  items: RunItem[];                    // chronological by seq
  tools: Extract<RunItem, { kind: "tool" }>[];
  facts: { model?: RunFact; effort?: RunFact; context?: RunFact; tools?: RunFact; connectors?: RunFact;
           /** The research completion message's fact (SPEC §9.6.3): its line leads "Researched for". */
           research?: RunFact;
           memory: ClientMemoryReceipt[] };
  counts: { sources: number; searches: number; codeRuns: number; filesCreated: number;
            connectorsUsed: string[]; filesRead: string[]; failedTools: number; warnings: number };
  hasReasoning: boolean;
  timing: { startedAt: number | null; firstAnswerAt: number | null; endedAt: number | null;
            workedMs: number | null };
  pendingApprovalIds: string[];
  latestStepKeys: string[];            // for the peek: newest last
}

// ── Phases (src/lib/run/phase.ts) ─────────────────────────────────────────────

export type RunPhase =
  | "queued" | "thinking" | "searching" | "reading" | "tool" | "waiting" | "writing"
  | "answering" | "done" | "stopped" | "failed";

export interface PhaseState {
  phase: RunPhase;
  /** The call or segment the label describes (drives the label params). */
  subjectKey?: string;
  stalled: boolean;
  calm: boolean;               // ≥ 20 s of continuous working
  /** Escalation caption tier: 0 none, 1 after 2 min of working, 2 after 10 min. */
  escalation: 0 | 1 | 2;
  /** Two or more reads (or searches) started within `coalesceWindowMs`: the label counts them
   *  ("Reading 3 sources") instead of naming one. Absent for a single call. */
  coalesced?: number;
  /** How long the run has been working without a break, in ms (drives calm and escalation). */
  workingMs?: number;
  /** While `stalled`: the time of the last stream frame, from which "No response for" counts. */
  stalledSince?: number;
}

/**
 * A phase as the pacer releases it: what the line may show right now.
 * `reveal` is "none" before 150 ms, "glyph" until 400 ms, then "label" (SPEC §7.3).
 */
export interface PacedPhase extends PhaseState {
  reveal: "none" | "glyph" | "label";
}

/** What `derivePhase` reads besides the view: the live state of the stream. */
export interface PhaseInputs {
  streaming: boolean;
  error: boolean;
  finishReason: ChatFinishReason | null;
  /** A round's text was flushed to the answer area as answer text (the provisional hold). */
  answerStarted: boolean;
  /** Time of the last stream frame other than `ping`. */
  lastEventAt: number;
  now: number;
  startedAt: number;
}

// ── Presentation (src/lib/run/presentation.ts) ────────────────────────────────

export type ArgNode =
  | { kind: "quote"; value: string }     // rendered <q translate="no">, grapheme-truncated at 40
  | { kind: "domain"; value: string }    // <bdi translate="no">
  | { kind: "file"; value: string }      // <bdi translate="no">, middle-truncated at 32
  | { kind: "label"; value: string }     // connector label / third-party tool title
  | { kind: "number"; value: number; approx?: boolean }   // Intl.NumberFormat; approx → "~" prefix
  | { kind: "duration"; ms: number; style: "narrow" | "long" | "digital" }
  | { kind: "date"; iso: string; style: "short" | "medium" }
  /** A clock time ("14:02" / "2:02 PM"), formatClock in the UI locale: approval receipts. */
  | { kind: "time"; iso: string }
  /** A whole-phrase plural: a number node followed by `one` or `other`, chosen with
   *  Intl.PluralRules in the UI locale. `one`/`other` are *_COPY literals. */
  | { kind: "count"; n: number; one: string; other: string; approx?: boolean };

/** One translatable unit: at most ONE bare phrase, placed first or last, plus argument nodes.
 *  A phrase is a *_COPY literal, so the exact-match catalog matches it whole. */
export interface PhraseSpec { parts: ReadonlyArray<{ phrase: string } | ArgNode> }

/** A displayed line: complete PhraseSpecs joined by the design separator " · ", never a sentence. */
export type PhraseLine = readonly PhraseSpec[];

export interface ToolPresentation {
  icon: ToolIconKind;
  running(record: ToolCallRecord): PhraseLine;
  done(record: ToolCallRecord): PhraseLine;
  failed(record: ToolCallRecord): PhraseLine;       // by error.code
  figure(record: ToolCallRecord): PhraseSpec | null;
}

// ── The loop arbiter (src/lib/run/store.ts) ───────────────────────────────────

/** 1 wins: the open panel's live item, then the chat line, the artifact card, a Research row. */
export type LoopPriority = 1 | 2 | 3 | 4;

// ── The provisional hold (src/lib/run/provisional-text.ts) ────────────────────

/** How the client classified one live round's text before the server did (SPEC §7.3). */
export type RoundVerdict = "answer" | "commentary";

/**
 * One message's live answer-area state, shared by the run block (which runs the
 * hold and the peek collapse) and the answer body (which renders what it may).
 */
export interface LiveAnswerState {
  /** Per round: settled by the hold. A round absent here is still held (or needs no hold). */
  verdicts: Readonly<Record<number, RoundVerdict>>;
  /** The peek has finished collapsing (or never opened): answer text may render. */
  revealed: boolean;
}
