/*
 * THE MEMORY RECALL BENCHMARK — how well what Juno believes matches what is
 * true, after reading a person's history.
 *
 * WHY IT EXISTS. "Re-read old history to improve accuracy" is a claim, and
 * the only honest way to make it is with a number before and a number after.
 * Nothing measured memory before this: the unit tests pin individual rules,
 * and none of them says whether, after a year of chats, Juno believes the
 * right things.
 *
 * WHAT IT RUNS. The production pieces, not copies: the extraction prompt
 * (memory-extraction.ts), the ingestion rules that dedupe, supersede and expire
 * (planFactIngestion), the forget rule (factsCoveredByForget), and retrieval
 * (selectMemoriesForContext). The only stand-in is the model that reads each
 * chat — offline, a READER that answers with the facts recorded against each
 * message, minus anything the prompt listed as already known or asked it to
 * forget, which is what a model following the prompt does. `--live` swaps in
 * a real model. The database half is a small in-memory store that applies
 * each ingestion plan the way `saveCandidates` does.
 *
 * THREE SETTINGS, because they are three different situations:
 *
 *   live      each chat distilled as it happens, in order — the chat turn's
 *             after-hook.
 *   re-read   the whole history read afterwards, NEWEST CHAT FIRST — which
 *             is how "Learn from past chats" and the background dreamer read
 *             it (`pendingBackfill` orders by last message, descending). Any
 *             forgets the person made are already in place.
 *   repair    history that WAS read newest-first by the old rules — every
 *             conflict judged in reading order, every temporary fact dated
 *             from the reading — which is what existing accounts have stored
 *             today. With the re-judge pass on, the time each fact was said is
 *             recovered from its source message, as the database half does,
 *             and the timeline is judged again.
 *
 * WHAT IT SCORES, at the scenario's "now":
 *
 *   recall      share of what is true now that Juno believes, in the right scope
 *   stale       share of what USED to be true that Juno still believes (lower is better)
 *   forgotten   statements the person asked Juno to forget that it believes again
 *   precision   share of what Juno believes that is true now
 *   retrieval   share of the facts a question needs that reach its context
 *   leaks       facts that reach a context they must not: another scope's,
 *               a forgotten one, a stale one the probe names
 *
 * Facts match on the lifecycle's own normalised form, or — for a live model's
 * paraphrase — on a token overlap high enough that "lives in Lisbon" and
 * "lives in Porto" never match.
 *
 * Pure: no Prisma, no network unless a live reader is passed in.
 */

import {
  DEFAULT_MEMORY_TOKEN_BUDGET,
  factsCoveredByForget,
  normalizeFact,
  planFactIngestion,
  planTimelineReconciliation,
  selectMemoriesForContext,
  significantTokens,
  type LifecycleEntry,
} from "@/lib/memory-lifecycle";
import {
  EXTRACTION_KNOWN_FACTS,
  extractionSystemPrompt,
  extractionUserMessage,
  parseExtraction,
} from "@/lib/memory-extraction";

// ---------------------------------------------------------------------------
// Dataset shape
// ---------------------------------------------------------------------------

export interface BenchTurn {
  /** What the person wrote. */
  text: string;
  /** What a model following the extraction prompt keeps from it. */
  facts: string[];
}

export interface BenchConversation {
  id: string;
  title: string;
  projectId: string | null;
  /** When the chat began; message n is a minute after message n-1. */
  at: string;
  turns: BenchTurn[];
}

export interface TruthFact {
  projectId: string | null;
  fact: string;
}

export interface BenchProbe {
  id: string;
  /** The scope the question is asked in. */
  projectId: string | null;
  query: string;
  /** Facts the answer needs in context. Empty: the right answer is "nothing". */
  expect: string[];
  /** Facts that must not be in context. */
  mustNot?: string[];
}

export interface BenchScenario {
  id: string;
  title: string;
  description: string;
  /** When the scenario is scored. */
  now: string;
  conversations: BenchConversation[];
  forgets?: { at: string; statement: string }[];
  truth: {
    current: TruthFact[];
    stale: TruthFact[];
    forgotten?: string[];
  };
  probes: BenchProbe[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type BenchSetting = "live" | "re-read" | "repair";

export interface BenchConfig {
  /**
   * Which stored facts the reader is told it already knows: the newest from
   * any scope in any state (extractor v1), or only what is believed in the
   * chat's own scope (v2).
   */
  knownScope: "any" | "same";
  /** Hand ingestion the time each fact was said, rather than letting it assume "now". */
  timeAware: boolean;
  /** Run the re-judge pass (planTimelineReconciliation) once reading is done. */
  rejudge: boolean;
}

export const BENCH_SETTINGS: readonly BenchSetting[] = ["live", "re-read", "repair"];

/**
 * The pipelines a run compares. The last is what the product runs; the one
 * before it isolates the re-judge pass's share. What the code did BEFORE this
 * work cannot be re-run — those rules are gone — so it is not a row here but a
 * recorded measurement (tests/fixtures/memory-recall-record.json, `baseline`),
 * which the report prints beside these.
 */
export const BENCH_CONFIGS: Record<string, BenchConfig> = {
  "judged by when it was said": { knownScope: "same", timeAware: true, rejudge: false },
  "+ re-judge pass (the product)": { knownScope: "same", timeAware: true, rejudge: true },
};

/** The model seam: the extraction prompt in, the raw answer out. */
export type BenchReader = (prompt: { system: string; userMsg: string }) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Token overlap above which two phrasings count as one fact. */
const PARAPHRASE_JACCARD = 0.6;

export function factMatches(stored: string, truth: string): boolean {
  if (normalizeFact(stored) === normalizeFact(truth)) return true;
  const a = new Set(significantTokens(stored));
  const b = new Set(significantTokens(truth));
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared) >= PARAPHRASE_JACCARD;
}

// ---------------------------------------------------------------------------
// The offline reader
// ---------------------------------------------------------------------------

/**
 * A reader that does what the extraction prompt asks: it returns the facts
 * recorded against the messages it was shown, leaving out anything listed as
 * already known and anything it was asked to forget.
 *
 * It reads its instructions out of the prompt text itself — the same text a
 * model gets — so a change to what the prompt lists (the whole difference
 * between extractor v1 and v2) changes what this reader returns, exactly as
 * it would change what a model returns.
 */
export function recordedReader(scenarios: readonly BenchScenario[]): BenchReader {
  const byText = new Map<string, string[]>();
  for (const scenario of scenarios) {
    for (const conversation of scenario.conversations) {
      for (const turn of conversation.turns) byText.set(turn.text, turn.facts);
    }
  }
  return async ({ system, userMsg }) => {
    // The bullets directly under a heading, up to the first line that is not
    // one — the forget list runs straight into "Already known:" with no blank
    // line between them.
    const listed = (heading: string) => {
      const start = system.indexOf(`${heading}\n`);
      if (start === -1) return [];
      const out: string[] = [];
      for (const line of system.slice(start + heading.length + 1).split("\n")) {
        if (!line.startsWith("- ")) break;
        out.push(line.slice(2));
      }
      return out;
    };
    const known = new Set(listed("Already known:").map(normalizeFact));
    const forget = listed("The user asked to FORGET the following — never extract anything about them:");
    const messages = userMsg
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2));
    const facts = messages
      .flatMap((message) => byText.get(message) ?? [])
      .filter((fact) => !known.has(normalizeFact(fact)))
      .filter((fact) => !forget.some((statement) => factMatches(fact, statement)));
    return JSON.stringify({ facts, digest: null });
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const MINUTE = 60_000;

export interface BenchStore {
  entries: LifecycleEntry[];
  suppressions: string[];
  seq: number;
  /** When each row's fact was really said — what its source message's time gives the database half. */
  saidAt: Map<string, Date>;
  /**
   * When each row last changed status — the `updatedAt` a retirement leaves
   * in the database. The summary-injection evaluation reads it the way
   * `readMemorySummaryChanges` reads the newest retirement.
   */
  changedAt: Map<string, Date>;
}
type Store = BenchStore;

function turnTime(conversation: BenchConversation, index: number): Date {
  return new Date(new Date(conversation.at).getTime() + index * MINUTE);
}

function endOf(conversation: BenchConversation): Date {
  return turnTime(conversation, conversation.turns.length);
}

/** One chat read into the store, the way extractConversationMemory + saveCandidates do it. */
async function readConversation(
  store: Store,
  conversation: BenchConversation,
  config: Pick<BenchConfig, "knownScope" | "timeAware">,
  reader: BenchReader,
  now: Date
): Promise<void> {
  // A chunk's facts are dated by its last message — the one the row's
  // sourceMessageId points at, since the reader returns facts for the chunk
  // rather than per message.
  const saidAt = turnTime(conversation, conversation.turns.length - 1);
  const scope = conversation.projectId ?? null;
  // The reader's "Already known": v1 listed every fact from any scope in any
  // state; v2 lists only what is believed, in the chat's own scope.
  const known = store.entries
    .filter((entry) =>
      config.knownScope === "any"
        ? entry.kind === "FACT"
        : believes(entry, now) && (entry.projectId ?? null) === scope
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, EXTRACTION_KNOWN_FACTS)
    .map((entry) => entry.content);
  const system = extractionSystemPrompt({ offLimitsLabels: [], suppressions: store.suppressions, known });
  const userMsg = extractionUserMessage({
    title: conversation.title,
    messages: conversation.turns.map((turn) => turn.text),
  });
  const parsed = parseExtraction((await reader({ system, userMsg })) ?? "");
  if (!parsed) return;

  for (const fact of parsed.facts) {
    ingestFact(store, { content: fact, source: "AUTO", projectId: scope, saidAt }, { now, timeAware: config.timeAware });
  }
}

/**
 * One fact through `planFactIngestion` into the store, applied the way
 * `saveCandidates` applies it, write for write. Exported for the evaluation
 * suite's correction and sensitivity cases, which feed facts directly.
 */
export function ingestFact(
  store: BenchStore,
  fact: { content: string; source: "AUTO" | "MANUAL"; projectId: string | null; saidAt: Date },
  opts: { now: Date; timeAware: boolean; allowedSensitiveTopics?: readonly string[] }
): ReturnType<typeof planFactIngestion> {
  const { now, timeAware } = opts;
  const { saidAt } = fact;
  const scope = fact.projectId;
  const plan = planFactIngestion(
    { content: fact.content, source: fact.source, projectId: scope, ...(timeAware ? { observedAt: saidAt } : {}) },
    { entries: store.entries, suppressions: store.suppressions, now, allowedSensitiveTopics: opts.allowedSensitiveTopics ?? [] }
  );
  if (plan.action === "skip") return plan;
  // Mirrors saveCandidates, write for write.
  const supersede = (entryId: string, byId: string) => {
    const older = store.entries.find((entry) => entry.id === entryId);
    // `saveCandidates` supersedes only a row that is still active.
    if (older && older.status === "active") {
      older.status = "superseded";
      older.supersededById = byId;
      store.changedAt.set(older.id, now);
    }
  };
  if (plan.action === "refresh") {
    const known = store.entries.find((entry) => entry.id === plan.entryId);
    if (!known) return plan;
    if (plan.revive) known.status = "active";
    if (plan.expiresAt !== undefined) known.expiresAt = plan.expiresAt;
    if (plan.observedAt) known.observedAt = plan.observedAt;
    if (saidAt.getTime() > (store.saidAt.get(known.id)?.getTime() ?? 0)) store.saidAt.set(known.id, saidAt);
    if (plan.reinstate) {
      known.status = "active";
      known.supersededById = null;
      store.changedAt.set(known.id, now);
    }
    if (plan.supersedes) supersede(plan.supersedes.entryId, known.id);
    for (const resolved of plan.resolves ?? []) supersede(resolved.entryId, known.id);
    return plan;
  }
  store.seq += 1;
  const id = `bench-${store.seq}`;
  store.entries.push({
    id,
    content: plan.content,
    normalized: plan.normalized,
    category: plan.category,
    projectId: scope,
    source: fact.source,
    kind: "FACT",
    confidence: plan.confidence,
    status: plan.status,
    expiresAt: plan.expiresAt,
    createdAt: now,
    observedAt: timeAware ? plan.observedAt : null,
    supersededById: plan.supersededById ?? null,
  });
  store.saidAt.set(id, saidAt);
  if (plan.supersedes) supersede(plan.supersedes.entryId, id);
  for (const resolved of plan.resolves ?? []) supersede(resolved.entryId, id);
  return plan;
}

/** An empty store, for callers that feed facts directly. */
export function emptyBenchStore(): BenchStore {
  return { entries: [], suppressions: [], seq: 0, saidAt: new Map(), changedAt: new Map() };
}

/** The re-judge pass, applied the way reconcileMemoryTimeline applies it. */
function rejudge(store: Store, now: Date): void {
  for (const change of planTimelineReconciliation(store.entries, { now })) {
    const entry = store.entries.find((row) => row.id === change.id);
    if (!entry) continue;
    if (entry.status !== change.status) store.changedAt.set(entry.id, now);
    entry.status = change.status;
    if (change.supersededById !== undefined) entry.supersededById = change.supersededById;
    if (change.expiresAt) entry.expiresAt = change.expiresAt;
  }
}

function forget(store: Store, statement: string, at: Date): void {
  for (const id of factsCoveredByForget(statement, store.entries)) {
    const entry = store.entries.find((row) => row.id === id);
    if (entry) {
      entry.status = "suppressed";
      store.changedAt.set(entry.id, at);
    }
  }
  if (!store.suppressions.some((existing) => normalizeFact(existing) === normalizeFact(statement))) {
    store.suppressions.push(statement);
  }
}

export interface ScenarioScore {
  scenario: string;
  recall: number;
  /** null when the scenario has nothing stale to hold on to. */
  stale: number | null;
  forgotten: number;
  precision: number;
  /** null when no probe expects anything. */
  retrieval: number | null;
  leaks: number;
  /** The raw counts behind the shares, so a run can be summed across scenarios. */
  counts: {
    current: number;
    currentHeld: number;
    stale: number;
    staleHeld: number;
    believed: number;
    believedTrue: number;
    expected: number;
    found: number;
  };
  /** What each probe got, for the report. */
  probes: { id: string; found: number; expected: number; leaked: string[] }[];
  /** True facts Juno does not believe, and stale ones it still does — the misses, named. */
  missing: string[];
  holding: string[];
}

/**
 * Replays one scenario into a fresh store — the part of a run before scoring.
 * Exported for the evaluation suite (memory-eval.ts), which scores the same
 * replay along more axes. `checkpoint`, when given, is called once, in the
 * live setting, after the event at the middle of the history: the moment the
 * summary-injection evaluation "writes a summary".
 */
export async function replayScenario(
  scenario: BenchScenario,
  opts: {
    setting: BenchSetting;
    config: BenchConfig;
    reader: BenchReader;
    checkpoint?: (store: BenchStore, at: Date) => void;
  }
): Promise<{ store: BenchStore; now: Date }> {
  const store: Store = { entries: [], suppressions: [], seq: 0, saidAt: new Map(), changedAt: new Map() };
  const now = new Date(scenario.now);

  if (opts.setting === "live") {
    const events = [
      ...scenario.conversations.map((conversation) => ({ at: endOf(conversation), conversation, statement: null })),
      ...(scenario.forgets ?? []).map((f) => ({ at: new Date(f.at), conversation: null, statement: f.statement })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    const middle = Math.max(0, Math.floor((events.length - 1) / 2));
    for (const [index, event] of events.entries()) {
      if (event.conversation) await readConversation(store, event.conversation, opts.config, opts.reader, event.at);
      else if (event.statement) forget(store, event.statement, event.at);
      if (index === middle) opts.checkpoint?.(store, event.at);
    }
    if (opts.config.rejudge) rejudge(store, now);
  } else {
    for (const f of scenario.forgets ?? []) forget(store, f.statement, now);
    const newestFirst = [...scenario.conversations].sort((a, b) => endOf(b).getTime() - endOf(a).getTime());
    // "repair" reads the way the old rules did: no times handed to
    // ingestion, so every judgement is made in reading order.
    const readWith = opts.setting === "repair" ? { ...opts.config, timeAware: false } : opts.config;
    for (const conversation of newestFirst) {
      await readConversation(store, conversation, readWith, opts.reader, now);
    }
    if (opts.config.rejudge) {
      if (opts.setting === "repair") {
        // What the database half does before judging: recover when each row
        // was said from its source message.
        for (const entry of store.entries) entry.observedAt = store.saidAt.get(entry.id) ?? entry.observedAt ?? null;
      }
      rejudge(store, now);
    }
  }
  return { store, now };
}

export async function runScenario(
  scenario: BenchScenario,
  opts: { setting: BenchSetting; config: BenchConfig; reader: BenchReader }
): Promise<ScenarioScore> {
  const { store, now } = await replayScenario(scenario, opts);
  return score(scenario, store, now);
}

/** Whether the store believes this row at `now`: an active, unexpired fact. */
export function believes(entry: LifecycleEntry, now: Date): boolean {
  return (
    entry.kind === "FACT" &&
    entry.status === "active" &&
    (entry.expiresAt === null || entry.expiresAt.getTime() > now.getTime())
  );
}

function score(scenario: BenchScenario, store: Store, now: Date): ScenarioScore {
  const believed = store.entries.filter((entry) => believes(entry, now));
  const held = (truth: TruthFact) =>
    believed.some((entry) => (entry.projectId ?? null) === truth.projectId && factMatches(entry.content, truth.fact));

  const current = scenario.truth.current;
  const stale = scenario.truth.stale;
  const forgottenStatements = scenario.truth.forgotten ?? [];
  const currentHeld = current.filter(held).length;
  const staleHeld = stale.filter(held).length;
  const believedTrue = believed.filter((entry) =>
    current.some((truth) => (entry.projectId ?? null) === truth.projectId && factMatches(entry.content, truth.fact))
  ).length;
  const forgotten = forgottenStatements.filter((statement) =>
    believed.some((entry) => factMatches(entry.content, statement))
  ).length;

  let leaks = 0;
  let expected = 0;
  let foundTotal = 0;
  const probeScores: ScenarioScore["probes"] = [];
  for (const probe of scenario.probes) {
    const { selected } = selectMemoriesForContext(store.entries, {
      query: probe.query,
      projectId: probe.projectId,
      isolateProjectMemory: probe.projectId !== null,
      now,
      budgetTokens: DEFAULT_MEMORY_TOKEN_BUDGET,
    });
    const inContext = (fact: string) => selected.some((memory) => factMatches(memory.content, fact));
    const found = probe.expect.filter((fact) =>
      selected.some((memory) => (memory.projectId ?? null) === probe.projectId && factMatches(memory.content, fact))
    ).length;
    expected += probe.expect.length;
    foundTotal += found;
    const leaked = [
      ...(probe.mustNot ?? []).filter(inContext),
      ...forgottenStatements.filter(inContext),
      ...selected
        .filter((memory) => (memory.projectId ?? null) !== probe.projectId)
        .map((memory) => `[other scope] ${memory.content}`),
    ];
    const unique = [...new Set(leaked)];
    leaks += unique.length;
    probeScores.push({ id: probe.id, found, expected: probe.expect.length, leaked: unique });
  }

  return {
    scenario: scenario.id,
    recall: current.length ? currentHeld / current.length : 1,
    stale: stale.length ? staleHeld / stale.length : null,
    forgotten,
    precision: believed.length ? believedTrue / believed.length : 1,
    retrieval: expected ? foundTotal / expected : null,
    leaks,
    counts: {
      current: current.length,
      currentHeld,
      stale: stale.length,
      staleHeld,
      believed: believed.length,
      believedTrue,
      expected,
      found: foundTotal,
    },
    probes: probeScores,
    missing: current.filter((truth) => !held(truth)).map((truth) => scoped(truth)),
    holding: stale.filter(held).map((truth) => scoped(truth)),
  };
}

function scoped(truth: TruthFact): string {
  return truth.projectId ? `[${truth.projectId}] ${truth.fact}` : truth.fact;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface BenchSummary {
  recall: number;
  stale: number;
  forgotten: number;
  precision: number;
  retrieval: number;
  leaks: number;
}

/**
 * Micro-averaged over every truth statement and probe in the run, so a
 * scenario with sixty facts weighs sixty times one with one — each fact is a
 * thing a person told Juno, and each counts the same.
 */
export function summarize(scores: readonly ScenarioScore[]): BenchSummary {
  const total = scores.reduce(
    (sum, score) => {
      for (const key of Object.keys(sum.counts) as (keyof ScenarioScore["counts"])[]) {
        sum.counts[key] += score.counts[key];
      }
      sum.forgotten += score.forgotten;
      sum.leaks += score.leaks;
      return sum;
    },
    {
      counts: { current: 0, currentHeld: 0, stale: 0, staleHeld: 0, believed: 0, believedTrue: 0, expected: 0, found: 0 },
      forgotten: 0,
      leaks: 0,
    }
  );
  const { counts } = total;
  return {
    recall: counts.current ? counts.currentHeld / counts.current : 1,
    stale: counts.stale ? counts.staleHeld / counts.stale : 0,
    forgotten: total.forgotten,
    precision: counts.believed ? counts.believedTrue / counts.believed : 1,
    retrieval: counts.expected ? counts.found / counts.expected : 1,
    leaks: total.leaks,
  };
}

export async function runBenchmark(
  scenarios: readonly BenchScenario[],
  opts: { setting: BenchSetting; config: BenchConfig; reader: BenchReader }
): Promise<{ scores: ScenarioScore[]; summary: BenchSummary }> {
  const scores: ScenarioScore[] = [];
  for (const scenario of scenarios) scores.push(await runScenario(scenario, opts));
  return { scores, summary: summarize(scores) };
}
