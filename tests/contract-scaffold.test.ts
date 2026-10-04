import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ActivityPanel, type ActivityPanelProps } from "@/components/chat/panel/activity-panel";
import {
  reconcileRightPanel,
  rightPanelReducer,
  type RightPanelAction,
  type RightPanelState,
} from "@/components/chat/panel/panel-state";
import { RightColumnShell, type RightColumnShellProps } from "@/components/chat/panel/right-column-shell";
import { FaviconStack, type FaviconStackProps } from "@/components/chat/run/favicon-stack";
import { RunAnnouncer, type RunAnnouncerProps } from "@/components/chat/run/run-announcer";
import { RunBlock, type RunBlockProps } from "@/components/chat/run/run-block";
import { RunClock, type RunClockProps } from "@/components/chat/run/run-clock";
import { RunGlyph, type RunGlyphProps } from "@/components/chat/run/run-glyph";
import { RunLabel, type RunLabelProps } from "@/components/chat/run/run-label";
import { RunLine, type RunLineProps } from "@/components/chat/run/run-line";
import { GuideModeSwitch } from "@/components/research/guide-mode-switch";
import { ReportFullscreen } from "@/components/research/report-fullscreen";
import { ResearchConsole } from "@/components/research/research-console";
import { ResearchRecap } from "@/components/research/research-recap";
import { ScopeCard } from "@/components/research/scope-card";
import { RunPanelStates } from "@/app/dev/run/panel-states";
import { MAX_COMMENTARY_BYTES, PRESERVED_BLOCKS, splitAnswer, type TextSegment } from "@/lib/chat/answer-split";
import { assistantTurnRecord } from "@/lib/chat/assistant-turn";
import {
  CLIENT_FEATURES,
  WEB_CLIENT_FEATURES,
  parseClientFeatures,
  type ClientFeatureSet,
} from "@/lib/chat/client-features";
import { HISTORY_NOTE_MAX_CHARS_PER_TURN, withHistoryNotes } from "@/lib/chat/history-notes";
import { applyStreamChunk, type LiveMessage } from "@/lib/chat/live-message";
import { SourceRegistry } from "@/lib/chat/source-registry";
import { turnStartFacts } from "@/lib/chat/turn-start-facts";
import { TurnStream, type TurnStreamOptions } from "@/lib/chat/turn-stream";
import { formatDate, formatDuration, useUiLocale } from "@/lib/i18n-format";
import { Phrase, PhraseWithArgs, formatPhrase, phraseText } from "@/lib/i18n-phrase";
import type { NativeChatTool as LlmNativeChatTool, streamChat } from "@/lib/llm";
import { FINAL_ROUND_NOTE, createLoopController, roundBudgetFor } from "@/lib/llm/loop";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import type { McpToolset, ToolExecuteOptions, resolveConnectorsWithStatus } from "@/lib/mcp";
import { toolCapabilitiesFor, type ModelToolCapabilities } from "@/lib/model-tools";
import type { finalizeResearchRun, isResearchCompletionMessage } from "@/lib/research/completion";
import { researchBudgetFor } from "@/lib/research/envelope";
import { researchEntitlement } from "@/lib/research/entitlement";
import { estimateFor } from "@/lib/research/estimate";
import type { cancelResearchRun, keepResearchLeaseAlive } from "@/lib/research/lease";
import { RESEARCH_PHASE_UI } from "@/lib/research/phase";
import { createPhasePacer } from "@/lib/run/pacer";
import { usePhaseLock } from "@/lib/run/loop-phase";
import { derivePhase } from "@/lib/run/phase";
import { presentTool } from "@/lib/run/presentation";
import { claimLoop, publishResearchPhase, useLoopOwner } from "@/lib/run/store";
import { buildRunView } from "@/lib/run/timeline";
import type { PhraseLine, RunView } from "@/lib/run/types";
import { getTitleOverride, setTitleOverride, useTitleOverride } from "@/lib/title-override";
import { chatToolEntitlements, type ChatToolPlan } from "@/lib/tools/entitlements";
import { executeToolBatch, type BatchContext, type BatchResult, type ToolCallInput } from "@/lib/tools/dispatch";
import { ToolFeeAccumulator, enginePriceMicroUsd } from "@/lib/tools/metering";
import type { openChatToolset } from "@/lib/tools/toolset";
import { defineTool, type ChatToolset, type NativeChatTool, type ResolvedTool } from "@/lib/tools/types";
import type { fetchPageForChat } from "@/lib/web/fetch-page";
import { UrlLedger } from "@/lib/web/provenance";
import { chatWebSearch, keyedSearchEngineConfigured } from "@/lib/web/search";
import { TurnTaint } from "@/lib/web/taint";
import type { ChatSearchResult, LazyUrlLedger, PrivateSpanSet, TurnWebLimits } from "@/lib/web/types";
import type { ClientActivityEvent, StreamChunk } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";
import { TURN_SCRIPTS, scriptEvents } from "./fixtures/turn-scripts";
import type {
  ResearchEstimateCaps,
  ResearchPhase,
  ResearchRunSummary,
  ResearchRunViewAdditions,
  ResearchScope,
} from "@/types/research";
import {
  TERMINAL_TOOL_CALL_STATUSES,
  TOOL_CALL_STATUSES,
  type ChatSourceOrigin,
  type RunFact,
  type RunNotice,
  type ToolCallRecord,
} from "@/types/run";

/*
 * THE CONTRACT SCAFFOLD (docs/chat-rework/SPEC.md §12.3, §12.7).
 *
 * Wave 1 of the chat rework runs eight workstreams in parallel, each against
 * the others' functions, types and components before those exist. WS0 lands
 * every one of them with its final signature. This file names every §12.7
 * symbol, so the list in the spec and the code cannot drift apart, and checks
 * the pieces §13.1 gives WS0 to finish.
 *
 * It asserts nothing about a stub's body, or a value its owner may still
 * tune: every wave-1 branch replaces its stubs and must still pass this file
 * unchanged. WS0's checks of its interim bodies sit in the owners' own files,
 * which those workstreams rewrite: `tool-dispatch` (the minimal dispatcher),
 * `model-tool-capabilities`, `i18n-phrase`, `i18n-format` and `run-css-reduced`.
 *
 * A symbol whose final body needs the database, MCP or the search stack lives
 * in a module that is, or will be, `server-only`, which throws on import under
 * `tsx --test` (SPEC §13 harness rule 1). Those are named with `import type`:
 * nothing is loaded, but a missing or renamed symbol still fails typecheck.
 * `serializeActivity` is private until WS4 moves it into the pure
 * `run-record.ts` (§2.7), so it is found as text.
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Every §12.7 type, and the server-bound functions, named once: a missing or renamed one fails typecheck. */
export type ContractTypes = [
  BatchContext,
  BatchResult,
  ToolCallInput,
  ToolExecuteOptions,
  ChatToolset,
  ResolvedTool,
  NativeChatTool,
  ChatToolPlan,
  LazyUrlLedger,
  PrivateSpanSet,
  ChatSearchResult,
  TurnWebLimits,
  AdapterRequest,
  ProviderTransport,
  ModelToolCapabilities,
  TurnStreamOptions,
  TextSegment,
  ClientFeatureSet,
  ChatSourceOrigin,
  ToolCallRecord,
  RunFact,
  RunNotice,
  LiveMessage,
  RunView,
  PhraseLine,
  RunBlockProps,
  RunGlyphProps,
  RunLabelProps,
  RunLineProps,
  FaviconStackProps,
  RunClockProps,
  RunAnnouncerProps,
  RightColumnShellProps,
  ActivityPanelProps,
  RightPanelState,
  RightPanelAction,
  ResearchScope,
  ResearchEstimateCaps,
  ResearchPhase,
  ResearchRunSummary,
  ResearchRunViewAdditions,
  ClientActivityEvent,
  StreamChunk,
  LlmEvent,
  typeof streamChat,
  typeof resolveConnectorsWithStatus,
  typeof openChatToolset,
  typeof fetchPageForChat,
  typeof keepResearchLeaseAlive,
  typeof cancelResearchRun,
  typeof finalizeResearchRun,
  typeof isResearchCompletionMessage,
];

/** Compile-time only: `true` when `A` and `B` are the same type. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;
type StreamChatOptions = Parameters<typeof streamChat>[0];

/**
 * The compile-only additions to the server-only files (§12.3): `streamChat`'s
 * final options, declared ahead of WS3 so wave-1 callers compile (§5.0);
 * `NativeChatTool` still importable from `llm.ts`; the executor's per-call
 * options (§3.1).
 */
export type ServerOnlyAdditions = [
  Holds<Same<StreamChatOptions["toolset"], ChatToolset | undefined>>,
  Holds<Same<StreamChatOptions["responseSchema"], AdapterRequest["responseSchema"] | undefined>>,
  Holds<Same<LlmNativeChatTool, NativeChatTool>>,
  Holds<Same<Parameters<McpToolset["execute"]>[4], ToolExecuteOptions | undefined>>,
];

// ── Every symbol is there, and the scaffold's graph stays server-only-free ────

/** The §12.7 functions, classes and components a test can import, by owning workstream. */
const EXPORTS: Record<string, Record<string, unknown>> = {
  WS1: { executeToolBatch, chatToolEntitlements, ToolFeeAccumulator, enginePriceMicroUsd },
  WS2: { chatWebSearch, keyedSearchEngineConfigured, UrlLedger, TurnTaint },
  WS3: { createLoopController, roundBudgetFor, toolCapabilitiesFor },
  WS4: { TurnStream, splitAnswer, turnStartFacts, withHistoryNotes, SourceRegistry, assistantTurnRecord },
  WS5: {
    applyStreamChunk,
    buildRunView,
    presentTool,
    derivePhase,
    createPhasePacer,
    claimLoop,
    useLoopOwner,
    usePhaseLock,
    publishResearchPhase,
    RunBlock,
    RunGlyph,
    RunLabel,
    RunLine,
    FaviconStack,
    RunClock,
    RunAnnouncer,
    Phrase,
    PhraseWithArgs,
    formatPhrase,
    phraseText,
    formatDuration,
    formatDate,
    useUiLocale,
  },
  WS6: { RightColumnShell, ActivityPanel, rightPanelReducer, reconcileRightPanel, RunPanelStates },
  WS7: { researchEntitlement, researchBudgetFor },
  WS0: { estimateFor, setTitleOverride, useTitleOverride },
  WS8: { ScopeCard, ResearchConsole, ResearchRecap, ReportFullscreen, GuideModeSwitch, RESEARCH_PHASE_UI },
};

test("every importable §12.7 function, class and component is exported", () => {
  for (const [owner, symbols] of Object.entries(EXPORTS)) {
    for (const [name, value] of Object.entries(symbols)) {
      assert.ok(value !== undefined && value !== null, `${owner}: ${name} is not exported`);
    }
  }
  assert.equal(typeof RESEARCH_PHASE_UI, "object");
});

/** Resolves an `@/…` or relative specifier to a file under src/, or null for a package. */
function resolveLocal(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(root, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep) && path.extname(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${path.relative(root, from)}`);
}

/** Static imports and re-exports that survive compilation: `import type` / `export type` are erased. */
function runtimeSpecifiers(source: string): string[] {
  const found: string[] = [];
  const statement = /^\s*(import|export)\s+(?!type\s)(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["'];?/gm;
  for (const match of source.matchAll(statement)) {
    if (match[1] === "export" && !/\sfrom\s/.test(match[0])) continue;
    found.push(match[2]);
  }
  return found;
}

/** Walks a module's runtime import graph and returns the files that import "server-only". */
function serverOnlyIn(entry: string): string[] {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier === "server-only") {
        offenders.push(path.relative(root, file));
        continue;
      }
      const next = resolveLocal(file, specifier);
      if (next) visit(next);
    }
  };
  visit(entry);
  return offenders;
}

/**
 * The modules this file loads, all of which the spec keeps free of
 * `server-only` for good (§13 harness rules 1–2). Not listed, and only named
 * as types above: `tools/toolset.ts` (opens MCP), `web/fetch-page.ts` (the
 * search stack's extractor) and `research/{lease,completion}.ts` (the
 * database).
 */
test("no module this file loads pulls server-only into a test's import graph", () => {
  const modules = [
    "src/lib/chat/client-features.ts",
    "src/lib/chat/source-registry.ts",
    "src/lib/chat/answer-split.ts",
    "src/lib/chat/turn-stream.ts",
    "src/lib/chat/turn-start-facts.ts",
    "src/lib/chat/history-notes.ts",
    "src/lib/chat/live-message.ts",
    "src/lib/chat/assistant-turn.ts",
    "src/lib/tools/types.ts",
    "src/lib/tools/dispatch.ts",
    "src/lib/tools/metering.ts",
    "src/lib/tools/entitlements.ts",
    "src/lib/llm/types.ts",
    "src/lib/llm/loop.ts",
    "src/lib/model-tools.ts",
    "src/lib/web/types.ts",
    "src/lib/web/search.ts",
    "src/lib/web/provenance.ts",
    "src/lib/web/taint.ts",
    "src/lib/web/limits.ts",
    "src/lib/run/types.ts",
    "src/lib/run/timeline.ts",
    "src/lib/run/presentation.ts",
    "src/lib/run/phase.ts",
    "src/lib/run/pacer.ts",
    "src/lib/run/store.ts",
    "src/lib/run/loop-phase.ts",
    "src/lib/i18n-phrase.tsx",
    "src/lib/i18n-format.ts",
    "src/lib/title-override.ts",
    "src/lib/research/estimate.ts",
    "src/lib/research/envelope.ts",
    "src/lib/research/phase.ts",
    "src/lib/research/entitlement.ts",
    "src/types/run.ts",
    "src/types/research.ts",
    "src/types/chat.ts",
    "src/types/llm.ts",
    "src/components/chat/run/run-block.tsx",
    "src/components/chat/panel/right-column-shell.tsx",
    "src/components/chat/research-run-panel.tsx",
    "src/app/dev/run/panel-states.tsx",
    "tests/fixtures/turn-scripts.ts",
  ];
  for (const file of modules) {
    assert.deepEqual(serverOnlyIn(path.join(root, file)), [], `${file} reaches server-only`);
  }
});

test("serializeActivity is where WS4 keeps it", () => {
  // In serializers.ts (server-only, private) until WS4 moves it into run-record.ts (§2.7).
  const homes = ["src/lib/serializers.ts", "src/lib/chat/run-record.ts"].filter((rel) => existsSync(path.join(root, rel)));
  assert.ok(
    homes.some((rel) => /function serializeActivity\(/.test(read(rel))),
    "serializeActivity is in neither serializers.ts nor run-record.ts",
  );
});

test("the spec's fixed limits and vocabularies", () => {
  assert.equal(HISTORY_NOTE_MAX_CHARS_PER_TURN, 1_200);
  assert.equal(MAX_COMMENTARY_BYTES, 65_536);
  assert.equal(PRESERVED_BLOCKS.length, 4);
  // The ends a tool call can reach, which the `tool` `result` event and the native mirror share (§2.5).
  assert.deepEqual([...TERMINAL_TOOL_CALL_STATUSES], ["succeeded", "failed", "denied", "expired", "cancelled"]);
  for (const status of TERMINAL_TOOL_CALL_STATUSES) assert.ok(TOOL_CALL_STATUSES.includes(status));

  const spec = defineTool({
    id: "calculate",
    title: "Calculate",
    description: "Evaluates an arithmetic expression.",
    input: { type: "object", properties: { expression: { type: "string", description: "The expression." } }, required: ["expression"] },
    risk: "read",
    parallelSafe: true,
    timeoutMs: 1_000,
    icon: "calculator",
    broker: "none",
    dedupe: true,
    present: (args: { expression?: unknown }) => ({ expression: String(args.expression ?? "") }),
    execute: async () => ({ status: "succeeded", text: "= 2", body: "= 2" }),
  });
  assert.equal(spec.id, "calculate");
});

// ── Client features (SPEC §2.2) ───────────────────────────────────────────────

test("parseClientFeatures keeps known features once, drops the rest, never rejects", () => {
  const none = parseClientFeatures(undefined);
  assert.equal(none.profile1, true);
  assert.deepEqual(none.list, []);
  assert.equal(none.has("timeline"), false);

  const mixed = parseClientFeatures(["timeline", "holograms", "resume", "timeline", "", "TIMELINE"]);
  assert.deepEqual(mixed.list, ["timeline", "resume"]);
  assert.equal(mixed.profile1, false);
  assert.equal(mixed.has("resume"), true);
  assert.equal(mixed.has("citations"), false);

  const unknownOnly = parseClientFeatures(["holograms", "teleport"]);
  assert.equal(unknownOnly.profile1, true, "only unknown features: still profile 1");

  const flood = parseClientFeatures([...Array.from({ length: 5_000 }, (_, i) => `x${i}`), ...CLIENT_FEATURES]);
  assert.ok(flood.list.length <= 16);
  assert.deepEqual(parseClientFeatures([...CLIENT_FEATURES, ...CLIENT_FEATURES]).list, [...CLIENT_FEATURES]);
  assert.deepEqual(parseClientFeatures(["resume", 7 as unknown as string, null as unknown as string]).list, ["resume"]);
  assert.deepEqual([...WEB_CLIENT_FEATURES], [...CLIENT_FEATURES]);
});

// ── The loop controller (SPEC §4.1, §4.6) ─────────────────────────────────────

test("the loop's last request is final, and nextIsFinal says so one request ahead", () => {
  const loop = createLoopController({ budget: 4 });
  assert.equal(loop.budget, 4);
  assert.equal(loop.nextIsFinal(), false);
  assert.deepEqual(loop.beginRequest(), { index: 0, final: false });
  assert.deepEqual(loop.beginRequest(), { index: 1, final: false });
  assert.equal(loop.nextIsFinal(), false);
  assert.deepEqual(loop.beginRequest(), { index: 2, final: false });
  assert.equal(loop.nextIsFinal(), true, "the next request is the fourth, and the last");
  assert.equal(loop.finalReason, null);
  assert.deepEqual(loop.beginRequest(), { index: 3, final: true });
  assert.equal(loop.requests, 4);
  assert.equal(loop.finalReason, "rounds");
});

test("requestFinal is idempotent and the first reason wins", () => {
  const loop = createLoopController({ budget: 10 });
  loop.beginRequest();
  assert.equal(loop.nextIsFinal(), false);
  loop.requestFinal("searches");
  loop.requestFinal("budget");
  loop.requestFinal("searches");
  assert.equal(loop.finalReason, "searches");
  assert.equal(loop.nextIsFinal(), true);
  assert.deepEqual(loop.beginRequest(), { index: 1, final: true });
  assert.equal(loop.finalReason, "searches");

  const exhausted = createLoopController({ budget: 2 });
  exhausted.beginRequest();
  exhausted.beginRequest();
  exhausted.requestFinal("budget");
  assert.equal(exhausted.finalReason, "rounds", "a request after the rounds ran out does not rename the reason");
});

test("a one-request loop is final from the start without claiming it cut anything", () => {
  const loop = createLoopController({ budget: 1 });
  assert.equal(loop.nextIsFinal(), true);
  assert.deepEqual(loop.beginRequest(), { index: 0, final: true });
  assert.equal(loop.finalReason, null);
  assert.equal(createLoopController({ budget: 0 }).budget, 1);
});

test("round budgets by effort, voice unchanged", () => {
  assert.equal(roundBudgetFor("minimal", false), 4);
  assert.equal(roundBudgetFor("low", false), 4);
  assert.equal(roundBudgetFor("medium", false), 10);
  assert.equal(roundBudgetFor(null, false), 10);
  assert.equal(roundBudgetFor(undefined, false), 10);
  assert.equal(roundBudgetFor("high", false), 16);
  assert.equal(roundBudgetFor("xhigh", false), 24);
  assert.equal(roundBudgetFor("max", false), 24);
  assert.equal(roundBudgetFor("max", true), 7);
  assert.match(FINAL_ROUND_NOTE, /^\[Juno: this is the last step\. Do not call tools\./);
});

// ── The estimate line (SPEC §9.2) ─────────────────────────────────────────────

/** The §9.2 initial calibration (`secondsPerPage` 9, `fixedMinutes` 2) under a MAX-like plan. */
const CAPS: ResearchEstimateCaps = {
  maxWorkers: 6,
  maxRounds: 3,
  maxPages: 150,
  maxMinutes: 30,
  secondsPerPage: 9,
  fixedMinutes: 2,
};

test("estimateFor follows the scope and stays inside the caps", () => {
  const scope: ResearchScope = { questions: 4, breadth: "broad", freshness: "any", primarySources: false, quick: false };
  // 4 questions × 8 pages; 2 rounds; 4 workers: ceil(2 + 32 × 9 / 60 / 4) = ceil(3.2) = 4.
  assert.deepEqual(estimateFor(scope, CAPS), { minutesUpTo: 4, pagesUpTo: 32 });
  // One more question reads more pages; its own worker keeps the clock where it was.
  assert.deepEqual(estimateFor({ ...scope, questions: 5 }, CAPS), { minutesUpTo: 4, pagesUpTo: 40 });
  // Primary sources raise the demand by a quarter.
  assert.equal(estimateFor({ ...scope, primarySources: true }, CAPS).pagesUpTo, 40);
  // The plan's page cap and clock bound the demand: 8 × 12 × 1.25 = 120 pages wanted, 6 workers.
  assert.deepEqual(
    estimateFor({ ...scope, questions: 8, breadth: "exhaustive", primarySources: true }, { ...CAPS, maxPages: 100 }),
    { minutesUpTo: 5, pagesUpTo: 100 },
  );
  assert.deepEqual(
    estimateFor({ ...scope, questions: 20, breadth: "exhaustive" }, { ...CAPS, maxPages: 999, maxMinutes: 4 }),
    { minutesUpTo: 4, pagesUpTo: 96 },
    "questions stop at 8, minutes at the plan clock",
  );
  assert.equal(estimateFor({ ...scope, questions: 0 }, CAPS).pagesUpTo, 8, "at least one question");
});

test("a one-question focused scope is tiny enough to skip the card (DECISIONS R2)", () => {
  const tiny: ResearchScope = { questions: 1, breadth: "focused", freshness: "any", primarySources: false, quick: true };
  // ceil(2 + 4 × 9 / 60) = 3: at most 3 minutes, so §9.5 auto-confirms it.
  assert.deepEqual(estimateFor(tiny, CAPS), { minutesUpTo: 3, pagesUpTo: 4 });
  assert.ok(estimateFor({ ...tiny, breadth: "broad" }, CAPS).minutesUpTo > 3, "a broad question is not tiny");
});

// ── The title override (SPEC §9.8) ────────────────────────────────────────────

test("the most recently set title override wins, and clearing it hands back to the one before", () => {
  assert.equal(getTitleOverride(), null);
  setTitleOverride("research:run_1", "Report ready");
  assert.equal(getTitleOverride(), "Report ready");
  setTitleOverride("print", "Heat pumps in 2026");
  assert.equal(getTitleOverride(), "Heat pumps in 2026");
  setTitleOverride("print", null);
  assert.equal(getTitleOverride(), "Report ready");
  setTitleOverride("research:run_1", "");
  assert.equal(getTitleOverride(), null);
});

// ── The rest of what WS0 owns alone ───────────────────────────────────────────

test("thinking-matrix no longer animates a shadow (SPEC §7.9, Tailwind)", () => {
  const tailwind = read("tailwind.config.ts");
  const matrix = tailwind.slice(tailwind.indexOf('"thinking-matrix": {'), tailwind.indexOf('"thinking-pulse": {'));
  assert.ok(matrix.length > 0, "the thinking-matrix keyframes moved");
  assert.doesNotMatch(matrix, /boxShadow/);
});

test("one turn script per /dev/run fixture, in order", () => {
  const fixtures = TURN_SCRIPTS.map((script) => script.fixture);
  // 1–28 from §11.1; WS4 may add more after them.
  assert.deepEqual(fixtures.slice(0, 28), Array.from({ length: 28 }, (_, i) => i + 1));
  assert.deepEqual(fixtures, [...fixtures].sort((a, b) => a - b));
  assert.equal(new Set(fixtures).size, fixtures.length, "a fixture number is used twice");
  for (const script of TURN_SCRIPTS) {
    const times = script.steps.map((step) => step.atMs);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${script.id}: steps out of order`);
    const events = scriptEvents(script);
    if (script.legacy) {
      // A persisted pre-rework row (§7.7): it never streams, and no event in it has a `seq` (INV-20).
      assert.equal(events.length, 0, `${script.id}: a legacy row has no stream`);
      assert.ok(script.legacy.content.length > 0);
      assert.ok(script.legacy.activity.every((event) => event.seq === undefined), `${script.id}: a legacy row carries no seq`);
      continue;
    }
    if (script.end === "completed" && script.handoffRunId === undefined) {
      assert.equal(events.at(-1)?.type, "finish", `${script.id}: a completed stream ends with finish`);
    }
    // Every result closes a call that was announced before it.
    const called = new Set<string>();
    for (const event of events) {
      if (event.type === "tool" && event.phase === "call") called.add(event.callId);
      if (event.type === "tool" && event.phase === "result") assert.ok(called.has(event.callId), `${script.id}: ${event.callId}`);
    }
  }
});
