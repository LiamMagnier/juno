/*
 * THE MEMORY EVALUATION SUITE — `npm run memory:bench -- --suite`.
 *
 * The recall benchmark (memory-bench.ts) answers one question: after reading
 * a person's history, does Juno believe the right things? This suite asks the
 * rest of what the brief (§10) lists, each against the production rules:
 *
 *   lifecycle      recall, precision, contradiction resolution (stale share),
 *                  forgotten facts resurrected, retrieval — the recall
 *                  benchmark's histories, product configuration.
 *   corrections    explicit corrections, conflicts, transitions (a job search
 *                  ended by a new job), and "keep both" cases where retiring
 *                  anything is a false contradiction.
 *   false memory   facts believed that are not true now, across every
 *                  history; facts invented by consolidation (must be 0:
 *                  dreaming only ever retires, never writes text).
 *   consolidation  near-duplicate merges: merged when the same, kept when not.
 *   scope          leakage across account / project / Orbit agent / another
 *                  member of a shared project, through the same reader rule
 *                  getMemoryProfile applies.
 *   sensitive      sensitive statements stored without opt-in (must be 0),
 *                  benign statements wrongly refused.
 *   summary        the case the recall benchmark missed: a consolidated
 *                  summary written mid-history, then a correction that does
 *                  not change the row count. Does the obsolete prose reach the
 *                  next turn? Measured under the count-only gate the product
 *                  had before 2026-10-04 and under the lifecycle gate.
 *   tokens         memory tokens injected per question (mean / p95 / max), how
 *                  many of the injected facts the question needed (precision),
 *                  and what an off-topic message ("what is 17 × 23?") is
 *                  handed — which should be next to nothing.
 *   latency        fact selection over a 2,000-fact account; session recall
 *                  ranking over a synthetic 20,000-message account.
 *   recall         session recall quality: does a question about an old
 *                  conversation find the right message (hit@1 / hit@5), and
 *                  what the 50-conversation scan window it replaces found.
 *   personalisation  inappropriate personalisation (§10.3): sensitive facts
 *                  handed to unrelated messages, inferred facts on a topic the
 *                  person switched off, facts on a topic they excluded — all
 *                  must be 0 — and, so the gates are not simply refusing,
 *                  sensitive facts used when the message is about them.
 *   deletion       what a forget, a topic exclusion, a delete or a revoked
 *                  topic leaves behind: retrieved, relearned, quoted in
 *                  another row, said by a summary or fed to a summariser.
 *                  Must be 0; the rules before 2026-10-25 are measured beside.
 *   manual         the person's own hand: a typed correction replaces what it
 *                  contradicts (and only that), a typed duplicate is one row.
 *
 * Offline and exact: no model, no database, no network. The database half of
 * session recall is measured by scripts/recall-bench.ts against Postgres.
 */

import {
  BENCH_CONFIGS,
  believes,
  emptyBenchStore,
  factMatches,
  ingestFact,
  recordedReader,
  replayScenario,
  runBenchmark,
  type BenchStore,
  type BenchSummary,
} from "@/lib/memory-bench";
import { MEMORY_BENCH_SCENARIOS } from "@/lib/memory-bench-scenarios";
import {
  BENIGN_NEAR_MISSES,
  MANUAL_CORRECTION_CASES,
  MANUAL_DUPLICATE_CASES,
  PERSONALISATION_EXCLUDED_QUERIES,
  PERSONALISATION_EXCLUSIONS,
  PERSONALISATION_FACTS,
  PERSONALISATION_OFF_TOPIC,
  PERSONALISATION_RELEVANT,
  CORRECTION_CASES,
  DUPLICATE_PAIRS,
  SCOPE_FACTS,
  SCOPE_QUERIES,
  SCOPE_READERS,
  SENSITIVE_STATEMENTS,
  type ScopeReaderSpec,
} from "@/lib/memory-eval-cases";
import {
  DEFAULT_MEMORY_TOKEN_BUDGET,
  classifyFact,
  consolidationMayUse,
  factsCoveredByForget,
  normalizeFact,
  planDeletionEffects,
  planDuplicateMerges,
  planFactIngestion,
  planRewriteEffects,
  scrubSummaryForSuppressions,
  planTimelineReconciliation,
  selectMemoriesForContext,
  summaryPredatesForget,
  summaryPredatesMemoryChange,
  summaryRebuildDecision,
  type LifecycleEntry,
} from "@/lib/memory-lifecycle";
import { readerMayUse, type MemoryReader } from "@/lib/memory-scope";
import { SENSITIVE_TOPICS, sensitiveTopicOf } from "@/lib/memory-sensitive";
import { proseCoveredBySuppression } from "@/lib/memory-suppression";
import {
  parseRecallQuery,
  rankRecallCandidates,
  recallEntities,
  recallTokens,
  type RecallCandidate,
} from "@/lib/recall/index-core";

const PRODUCT = BENCH_CONFIGS["+ re-judge pass (the product)"];

export interface SuiteOptions {
  /**
   * Emulate the agent boundary as it was before this work: an Orbit agent's
   * turn called getMemoryProfile(userId, { projectId }) with no agent
   * identity, so it read exactly what an ordinary chat in its scope read.
   * Used once, to record the baseline row.
   */
  legacyAgentScope?: boolean;
  /** Synthetic recall corpus size (messages). */
  recallMessages?: number;
}

export interface SuiteResult {
  lifecycle: Record<"live" | "re-read", BenchSummary & { contradictionResolution: number }>;
  corrections: {
    cases: number;
    passed: number;
    /** Order-independent: each case is also replayed newest-first. */
    passedReread: number;
    falseContradictions: number;
    failures: string[];
  };
  falseMemory: { believedNotTrue: number; believed: number; dreamInvented: number };
  consolidation: { mergedWhenSame: number; same: number; mergedWhenDifferent: number; different: number };
  scope: { checks: number; leaks: number; misses: number; leakDetail: string[] };
  sensitive: { sensitive: number; storedWithoutOptIn: number; benign: number; benignRefused: number; optInStored: number };
  summary: {
    scenarios: number;
    staleInjectedCountOnly: number;
    staleInjectedLifecycle: number;
    rebuildMissedCountOnly: number;
    rebuildMissedLifecycle: number;
  };
  tokens: {
    questions: number;
    mean: number;
    p95: number;
    max: number;
    budget: number;
    /** Injected facts the question expected, over all injected facts. */
    precision: number;
    /** Facts injected per on-topic question, on average. */
    factsMean: number;
    /** The same history asked things it has nothing to say about. */
    offTopicQuestions: number;
    offTopicMean: number;
    offTopicFactsMean: number;
  };
  latency: { factSelectP50Ms: number; factSelectP95Ms: number; recallRankP50Ms: number; recallRankP95Ms: number };
  recall: {
    messages: number;
    conversations: number;
    questions: number;
    /** Right conversation first / in the first five (one line per chat, as search_chats lists them). */
    hitAt1: number;
    hitAt5: number;
    legacyWindowHitAt5: number;
  };
  personalisation: {
    checks: number;
    /** Must be 0: the sum of the three kinds below. */
    inappropriate: number;
    sensitiveOffTopic: number;
    revokedTopic: number;
    excludedTopic: number;
    /** The same checks under the rules before 2026-10-25 (no read gates, sensitive facts ambient). */
    legacyInappropriate: number;
    /** Sensitive facts the message was about, topic allowed: used / asked. */
    appropriate: number;
    appropriateUsed: number;
    /** Facts the person typed on a topic they later switched off: still used / asked. */
    typed: number;
    typedKept: number;
  };
  deletion: { checks: number; leaks: number; legacyLeaks: number; leakDetail: string[] };
  manual: {
    cases: number;
    passed: number;
    /** The same cases under the old manual add: append a row, settle nothing. */
    legacyPassed: number;
    duplicates: number;
    /** Typed duplicates that left two believed rows saying the same thing. */
    duplicatesLeft: number;
    legacyDuplicatesLeft: number;
    failures: string[];
  };
}

// ---------------------------------------------------------------------------

const quantile = (values: number[], q: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
};
const round = (n: number, digits = 4) => Number(n.toFixed(digits));

/** Deterministic PRNG (mulberry32), so synthetic corpora are identical run to run. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function applyRejudge(store: BenchStore, now: Date) {
  for (const change of planTimelineReconciliation(store.entries, { now })) {
    const entry = store.entries.find((row) => row.id === change.id);
    if (!entry) continue;
    if (entry.status !== change.status) store.changedAt.set(entry.id, now);
    entry.status = change.status;
    if (change.supersededById !== undefined) entry.supersededById = change.supersededById;
    if (change.expiresAt) entry.expiresAt = change.expiresAt;
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

async function lifecycleSection(): Promise<SuiteResult["lifecycle"]> {
  const reader = recordedReader(MEMORY_BENCH_SCENARIOS);
  const out = {} as SuiteResult["lifecycle"];
  for (const setting of ["live", "re-read"] as const) {
    const { summary } = await runBenchmark(MEMORY_BENCH_SCENARIOS, { setting, config: PRODUCT, reader });
    out[setting] = { ...summary, contradictionResolution: round(1 - summary.stale) };
  }
  return out;
}

function correctionsSection(): SuiteResult["corrections"] {
  let passed = 0;
  let passedReread = 0;
  let falseContradictions = 0;
  const failures: string[] = [];
  for (const testCase of CORRECTION_CASES) {
    const lastAt = new Date(Math.max(...testCase.steps.map((s) => new Date(s.at).getTime())));
    const now = new Date(lastAt.getTime() + 86_400_000);
    const run = (order: typeof testCase.steps) => {
      const store = emptyBenchStore();
      for (const step of order) {
        ingestFact(
          store,
          { content: step.content, source: step.source ?? "AUTO", projectId: step.projectId ?? null, saidAt: new Date(step.at) },
          { now: order === testCase.steps ? new Date(step.at) : now, timeAware: true }
        );
      }
      applyRejudge(store, now);
      const believed = store.entries.filter((entry) => believes(entry, now));
      const holds = (fact: string) => believed.some((entry) => normalizeFact(entry.content) === normalizeFact(fact));
      const ok = testCase.believed.every(holds) && !testCase.notBelieved.some(holds);
      const wronglyRetired = testCase.kind === "keep-both" ? testCase.believed.filter((fact) => !holds(fact)).length : 0;
      return { ok, wronglyRetired };
    };
    const inOrder = run(testCase.steps);
    const reread = run([...testCase.steps].reverse());
    if (inOrder.ok) passed++;
    else failures.push(`${testCase.id} (in order)`);
    if (reread.ok) passedReread++;
    else failures.push(`${testCase.id} (re-read)`);
    falseContradictions += inOrder.wronglyRetired + reread.wronglyRetired;
  }
  return { cases: CORRECTION_CASES.length, passed, passedReread, falseContradictions, failures };
}

async function falseMemorySection(): Promise<SuiteResult["falseMemory"]> {
  const reader = recordedReader(MEMORY_BENCH_SCENARIOS);
  let believedCount = 0;
  let believedNotTrue = 0;
  let dreamInvented = 0;
  for (const scenario of MEMORY_BENCH_SCENARIOS) {
    for (const setting of ["live", "re-read"] as const) {
      const { store, now } = await replayScenario(scenario, { setting, config: PRODUCT, reader });
      const believed = store.entries.filter((entry) => believes(entry, now));
      believedCount += believed.length;
      believedNotTrue += believed.filter(
        (entry) =>
          !scenario.truth.current.some(
            (truth) => (entry.projectId ?? null) === truth.projectId && factMatches(entry.content, truth.fact)
          )
      ).length;
      // Consolidation may only retire: every row after it existed before it,
      // word for word.
      const before = new Map(store.entries.map((entry) => [entry.id, entry.content]));
      const count = store.entries.length;
      applyRejudge(store, now);
      if (store.entries.length !== count) dreamInvented += store.entries.length - count;
      for (const entry of store.entries) if (before.get(entry.id) !== entry.content) dreamInvented++;
    }
  }
  return { believedNotTrue, believed: believedCount, dreamInvented };
}

function consolidationSection(): SuiteResult["consolidation"] {
  let mergedWhenSame = 0;
  let mergedWhenDifferent = 0;
  const now = new Date("2026-09-01T00:00:00Z");
  for (const pair of DUPLICATE_PAIRS) {
    const store = emptyBenchStore();
    // Written directly, as two rows already stored — ingestion's exact-match
    // dedup is not what is being measured here.
    for (const [i, content] of [pair.a, pair.b].entries()) {
      const { category, confidence } = classifyFact(content);
      store.entries.push({
        id: `dup-${i}`,
        content,
        normalized: normalizeFact(content),
        category,
        projectId: null,
        source: "AUTO",
        kind: "FACT",
        confidence,
        status: "active",
        expiresAt: null,
        createdAt: new Date(now.getTime() - (2 - i) * 86_400_000),
        observedAt: new Date(now.getTime() - (2 - i) * 86_400_000),
      });
    }
    // The merge rule alone: a slot conflict retiring one of two cities is a
    // contradiction resolved, not a merge, and is scored elsewhere.
    const merged = planDuplicateMerges(store.entries).length === 1;
    if (merged && pair.same) mergedWhenSame++;
    if (merged && !pair.same) mergedWhenDifferent++;
  }
  return {
    mergedWhenSame,
    same: DUPLICATE_PAIRS.filter((p) => p.same).length,
    mergedWhenDifferent,
    different: DUPLICATE_PAIRS.filter((p) => !p.same).length,
  };
}

/** The reader a spec describes, exactly as getMemoryProfile builds it. */
export function readerOf(spec: ScopeReaderSpec, legacyAgentScope = false): MemoryReader {
  if (spec.agent && !legacyAgentScope) {
    return { kind: "agent", agentId: "agent", access: spec.agent.access, projectId: spec.projectId };
  }
  return spec.projectId ? { kind: "project", projectId: spec.projectId } : { kind: "account" };
}

function scopeSection(opts: SuiteOptions): SuiteResult["scope"] {
  const now = new Date("2026-09-01T00:00:00Z");
  const rows = SCOPE_FACTS.map((fact, i) => {
    const { category, confidence } = classifyFact(fact.content);
    return {
      fact,
      entry: {
        id: `scope-${i}`,
        content: fact.content,
        normalized: normalizeFact(fact.content),
        category,
        projectId: fact.projectId,
        source: "MANUAL" as const,
        kind: "FACT" as const,
        confidence,
        status: "active",
        // A dentist appointment "tomorrow" is temporary; keep it believed at `now`.
        expiresAt: null,
        createdAt: now,
        observedAt: now,
      } satisfies LifecycleEntry,
    };
  });
  let checks = 0;
  let leaks = 0;
  let misses = 0;
  const leakDetail: string[] = [];
  for (const spec of SCOPE_READERS) {
    const reader = readerOf(spec, opts.legacyAgentScope);
    // The query half: rows are always the reader's own (userId at the query).
    const own = rows.filter((row) => row.fact.userId === spec.userId);
    const eligible = own.filter((row) => readerMayUse(row.entry, reader)).map((row) => row.entry);
    const seen = new Set<string>();
    for (const query of SCOPE_QUERIES) {
      const { selected } = selectMemoriesForContext(eligible, {
        query,
        projectId: spec.projectId,
        isolateProjectMemory: spec.projectId !== null,
        now,
        budgetTokens: 10_000,
        limit: 100,
      });
      for (const memory of selected) seen.add(memory.id);
    }
    for (const row of rows) {
      checks++;
      const allowed = row.fact.readers.includes(spec.id);
      const shown = seen.has(row.entry.id);
      if (shown && !allowed) {
        leaks++;
        leakDetail.push(`${spec.id} ← ${row.fact.content}`);
      }
      if (!shown && allowed) misses++;
    }
  }
  return { checks, leaks, misses, leakDetail };
}

function sensitiveSection(): SuiteResult["sensitive"] {
  const now = new Date("2026-09-01T00:00:00Z");
  let storedWithoutOptIn = 0;
  let optInStored = 0;
  for (const statement of SENSITIVE_STATEMENTS) {
    const store = emptyBenchStore();
    const plan = ingestFact(store, { content: statement.content, source: "AUTO", projectId: null, saidAt: now }, { now, timeAware: true });
    if (plan.action !== "skip") storedWithoutOptIn++;
    const opted = emptyBenchStore();
    const optPlan = ingestFact(
      opted,
      { content: statement.content, source: "AUTO", projectId: null, saidAt: now },
      { now, timeAware: true, allowedSensitiveTopics: [statement.topic] }
    );
    if (optPlan.action !== "skip") optInStored++;
  }
  let benignRefused = 0;
  for (const content of BENIGN_NEAR_MISSES) {
    const store = emptyBenchStore();
    const plan = ingestFact(store, { content, source: "AUTO", projectId: null, saidAt: now }, { now, timeAware: true });
    if (plan.action === "skip" || sensitiveTopicOf(content) !== null) benignRefused++;
  }
  return {
    sensitive: SENSITIVE_STATEMENTS.length,
    storedWithoutOptIn,
    benign: BENIGN_NEAR_MISSES.length,
    benignRefused,
    optInStored,
  };
}

/**
 * The summary case. A summary is "written" at the middle of each history (the
 * believed account-wide facts, as prose would carry them); the history then
 * continues; at the end, the next turn either injects that summary or benches
 * it, under each gate. Stale = a fact the scenario says stopped being true,
 * present in injected prose.
 */
async function summarySection(): Promise<SuiteResult["summary"]> {
  const reader = recordedReader(MEMORY_BENCH_SCENARIOS);
  let scenarios = 0;
  let staleCountOnly = 0;
  let staleLifecycle = 0;
  let missedCountOnly = 0;
  let missedLifecycle = 0;
  for (const scenario of MEMORY_BENCH_SCENARIOS) {
    let summary: { facts: string[]; updatedAt: Date; entryCount: number } | null = null;
    const { store, now } = await replayScenario(scenario, {
      setting: "live",
      config: PRODUCT,
      reader,
      checkpoint: (snapshot, at) => {
        const accountFacts = snapshot.entries.filter((entry) => entry.kind === "FACT" && entry.projectId === null);
        summary = {
          facts: accountFacts.filter((entry) => believes(entry, at)).map((entry) => entry.content),
          updatedAt: at,
          entryCount: accountFacts.length,
        };
      },
    });
    const written = summary as { facts: string[]; updatedAt: Date; entryCount: number } | null;
    if (!written || written.facts.length === 0) continue;
    scenarios++;
    const accountFacts = store.entries.filter((entry) => entry.kind === "FACT" && entry.projectId === null);
    const newest = (dates: (Date | undefined)[]) =>
      dates.filter((d): d is Date => !!d).reduce<Date | null>((a, d) => (!a || d > a ? d : a), null);
    const newestRetirementAt = newest(
      accountFacts.filter((entry) => entry.status !== "active").map((entry) => store.changedAt.get(entry.id))
    );
    const newestExpiryAt = newest(
      accountFacts.map((entry) => entry.expiresAt ?? undefined).filter((d) => !!d && d.getTime() <= now.getTime())
    );
    const newestSuppressionAt = newest(
      accountFacts.filter((entry) => entry.status === "suppressed").map((entry) => store.changedAt.get(entry.id))
    );
    const staleIn = (facts: string[]) =>
      scenario.truth.stale
        .filter((truth) => truth.projectId === null)
        .filter((truth) => facts.some((fact) => factMatches(fact, truth.fact)))
        .filter((truth) => !accountFacts.some((entry) => believes(entry, now) && factMatches(entry.content, truth.fact)))
        .length;

    // Count-only gate (before 2026-10-04): rebuild on count change or a newer
    // forget; the profile benched prose only for a newer forget.
    const countOnly = summaryRebuildDecision({
      summary: { entryCount: written.entryCount, updatedAt: written.updatedAt },
      factCount: accountFacts.length,
      newestSuppressionAt,
      newestExpiryAt: null,
      newestRetirementAt: null,
      now,
    });
    const countOnlyInjects = !summaryPredatesForget(written.updatedAt, newestSuppressionAt);
    const staleNow = staleIn(written.facts);
    if (countOnlyInjects) staleCountOnly += staleNow;
    if (staleNow > 0 && countOnly === "fresh") missedCountOnly++;

    // Lifecycle gate (current): retirements and elapsed expiries bench the
    // prose immediately and trigger a rebuild.
    const lifecycle = summaryRebuildDecision({
      summary: { entryCount: written.entryCount, updatedAt: written.updatedAt },
      factCount: accountFacts.length,
      newestSuppressionAt,
      newestExpiryAt,
      newestRetirementAt,
      now,
    });
    const lifecycleInjects =
      !summaryPredatesForget(written.updatedAt, newestSuppressionAt) &&
      !summaryPredatesMemoryChange(written.updatedAt, { newestRetirementAt, newestExpiryAt });
    if (lifecycleInjects) staleLifecycle += staleNow;
    if (staleNow > 0 && lifecycle === "fresh") missedLifecycle++;
  }
  return {
    scenarios,
    staleInjectedCountOnly: staleCountOnly,
    staleInjectedLifecycle: staleLifecycle,
    rebuildMissedCountOnly: missedCountOnly,
    rebuildMissedLifecycle: missedLifecycle,
  };
}

/**
 * Messages no remembered fact helps answer. Asked of every history: whatever
 * memory injects for these is pure overhead on that turn.
 */
const OFF_TOPIC_QUERIES = [
  "What is 17 times 23?",
  "Explain how a hash map handles collisions.",
  "Translate 'good morning' into Spanish.",
  "Summarise the causes of the French Revolution in three bullets.",
  "thanks!",
];

async function tokensSection(): Promise<SuiteResult["tokens"]> {
  const reader = recordedReader(MEMORY_BENCH_SCENARIOS);
  const used: number[] = [];
  const offTopic: number[] = [];
  let injected = 0;
  let needed = 0;
  let offTopicFacts = 0;
  for (const scenario of MEMORY_BENCH_SCENARIOS) {
    const { store, now } = await replayScenario(scenario, { setting: "live", config: PRODUCT, reader });
    const select = (query: string, projectId: string | null) =>
      selectMemoriesForContext(store.entries, {
        query,
        projectId,
        isolateProjectMemory: projectId !== null,
        now,
        budgetTokens: DEFAULT_MEMORY_TOKEN_BUDGET,
      });
    for (const probe of scenario.probes) {
      const { usedTokens, selected } = select(probe.query, probe.projectId);
      used.push(usedTokens);
      injected += selected.length;
      needed += selected.filter((memory) => probe.expect.some((fact) => factMatches(memory.content, fact))).length;
    }
    for (const query of OFF_TOPIC_QUERIES) {
      const { usedTokens, selected } = select(query, null);
      offTopic.push(usedTokens);
      offTopicFacts += selected.length;
    }
  }
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  return {
    questions: used.length,
    mean: round(mean(used), 1),
    p95: quantile(used, 0.95),
    max: Math.max(...used),
    budget: DEFAULT_MEMORY_TOKEN_BUDGET,
    precision: injected ? round(needed / injected, 3) : 1,
    factsMean: round(injected / Math.max(1, used.length), 1),
    offTopicQuestions: offTopic.length,
    offTopicMean: round(mean(offTopic), 1),
    offTopicFactsMean: round(offTopicFacts / Math.max(1, offTopic.length), 1),
  };
}

// ---------------------------------------------------------------------------
// Inappropriate personalisation, deletion, manual corrections (brief §10.3)
// ---------------------------------------------------------------------------

const EVAL_NOW = new Date("2026-09-01T00:00:00Z");

function storedEntry(
  id: string,
  content: string,
  source: "AUTO" | "MANUAL",
  extra: Partial<LifecycleEntry> = {}
): LifecycleEntry {
  const { category, confidence } = classifyFact(content, { source });
  const said = new Date(EVAL_NOW.getTime() - 30 * 86_400_000);
  return {
    id,
    content,
    normalized: normalizeFact(content),
    category,
    projectId: null,
    source,
    kind: "FACT",
    confidence,
    status: "active",
    expiresAt: null,
    createdAt: said,
    observedAt: said,
    ...extra,
  };
}

/** Retire what a block-list statement covers — what forgetStatements does to the rows. */
function forgetInStore(entries: LifecycleEntry[], statement: string): void {
  for (const id of factsCoveredByForget(statement, entries)) {
    const entry = entries.find((row) => row.id === id);
    if (entry) entry.status = "suppressed";
  }
}

function personalisationSection(): SuiteResult["personalisation"] {
  const allTopics = ["health", "religion", "sexuality", "finances"];
  // Health and religion switched off later; the rest still on.
  const afterRevoke = ["sexuality", "finances"];
  const topicOf = new Map(PERSONALISATION_FACTS.map((f) => [f.id, f.topic ?? null]));
  const excludedIds = new Set(PERSONALISATION_FACTS.filter((f) => f.excluded).map((f) => f.id));

  const run = (gated: boolean) => {
    const entries = PERSONALISATION_FACTS.map((f) =>
      storedEntry(f.id, f.content, f.source, f.id === "insulin-typed" ? { confidence: 0.9 } : {})
    );
    // The exclusions as the product applies them: a forget (facts retired) and
    // the block-list passed to retrieval. Before topics existed the same rows
    // were statements that matched none of these facts, so nothing happened.
    if (gated) for (const statement of PERSONALISATION_EXCLUSIONS) forgetInStore(entries, statement);
    const select = (query: string, allowed: readonly string[]) =>
      selectMemoriesForContext(entries, {
        query,
        now: EVAL_NOW,
        budgetTokens: DEFAULT_MEMORY_TOKEN_BUDGET,
        ...(gated
          ? { suppressions: PERSONALISATION_EXCLUSIONS, allowedSensitiveTopics: allowed }
          : { legacySensitiveAmbient: true }),
      }).selected.map((m) => m.id);

    let checks = 0;
    let sensitiveOffTopic = 0;
    let revokedTopic = 0;
    let excludedTopic = 0;
    for (const allowed of [allTopics, afterRevoke]) {
      for (const query of PERSONALISATION_OFF_TOPIC) {
        const ids = select(query, allowed);
        checks++;
        sensitiveOffTopic += ids.filter((id) => topicOf.get(id)).length;
        excludedTopic += ids.filter((id) => excludedIds.has(id)).length;
      }
    }
    for (const probe of PERSONALISATION_RELEVANT) {
      if (afterRevoke.includes(probe.topic)) continue;
      const ids = select(probe.query, afterRevoke);
      checks++;
      revokedTopic += ids.filter((id) => topicOf.get(id) === probe.topic && id !== "insulin-typed").length;
    }
    for (const query of PERSONALISATION_EXCLUDED_QUERIES) {
      for (const allowed of [allTopics, afterRevoke]) {
        checks++;
        excludedTopic += select(query, allowed).filter((id) => excludedIds.has(id)).length;
      }
    }
    let appropriateUsed = 0;
    for (const probe of PERSONALISATION_RELEVANT) if (select(probe.query, allTopics).includes(probe.expect)) appropriateUsed++;
    const typedKept = select("When should I take my insulin before meals?", afterRevoke).includes("insulin-typed") ? 1 : 0;
    return { checks, sensitiveOffTopic, revokedTopic, excludedTopic, appropriateUsed, typedKept };
  };

  const now = run(true);
  const legacy = run(false);
  return {
    checks: now.checks,
    inappropriate: now.sensitiveOffTopic + now.revokedTopic + now.excludedTopic,
    sensitiveOffTopic: now.sensitiveOffTopic,
    revokedTopic: now.revokedTopic,
    excludedTopic: now.excludedTopic,
    legacyInappropriate: legacy.sensitiveOffTopic + legacy.revokedTopic + legacy.excludedTopic,
    appropriate: PERSONALISATION_RELEVANT.length,
    appropriateUsed: now.appropriateUsed,
    typed: 1,
    typedKept: now.typedKept,
  };
}

function deletionSection(): SuiteResult["deletion"] {
  let checks = 0;
  let leaks = 0;
  let legacyLeaks = 0;
  const leakDetail: string[] = [];
  const check = (name: string, leakedNow: boolean, leakedBefore: boolean) => {
    checks++;
    if (leakedNow) {
      leaks++;
      leakDetail.push(name);
    }
    if (leakedBefore) legacyLeaks++;
  };
  const ids = (entries: LifecycleEntry[], query: string, suppressions: readonly string[], allowed?: readonly string[]) =>
    selectMemoriesForContext(entries, {
      query,
      now: EVAL_NOW,
      suppressions,
      ...(allowed ? { allowedSensitiveTopics: allowed } : {}),
    }).selected.map((m) => m.id);
  const relearned = (content: string, suppressions: readonly string[], entries: LifecycleEntry[]) =>
    planFactIngestion({ content, source: "AUTO" }, { entries, suppressions, now: EVAL_NOW, allowedSensitiveTopics: [] }).action !== "skip";
  /** The rule before topics: containment of the statement, both ways, nothing else. */
  const legacyCovers = (content: string, statement: string) => {
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const c = norm(content);
    const n = norm(statement);
    return n.length > 0 && (c.includes(n) || n.includes(c));
  };

  // A — forget one statement.
  {
    const entries = [
      storedEntry("acme", "The user works at Acme as a designer.", "AUTO"),
      storedEntry("porto", "The user lives in Porto.", "AUTO"),
    ];
    const statement = "The user works at Acme";
    forgetInStore(entries, statement);
    check("forget: retrieved", ids(entries, "Where do I work? Acme designer", [statement]).includes("acme"), false);
    check("forget: relearned", relearned("The user works at Acme as a designer.", [statement], entries), false);
    const prose = "## Work context\nThe user works at Acme as a designer. They live in Porto.";
    check(
      "forget: said by a summary",
      /Acme/.test(scrubSummaryForSuppressions(prose, [statement])),
      /Acme/.test(prose)
    );
  }

  // B — exclude a topic.
  {
    const statement = "Anything about my divorce";
    const facts = [
      storedEntry("d1", "The user is going through a divorce.", "AUTO"),
      storedEntry("d2", "The user's divorce lawyer is called Ana.", "AUTO"),
      storedEntry("p", "The user lives in Porto.", "AUTO"),
    ];
    forgetInStore(facts, statement);
    const legacyRetired = facts.filter((f) => legacyCovers(f.content, statement)).length;
    const query = "What do you remember about my divorce and my lawyer Ana?";
    const now = ids(facts, query, [statement]);
    for (const id of ["d1", "d2"]) check(`topic: ${id} retrieved`, now.includes(id), legacyRetired === 0);
    check(
      "topic: new fact relearned",
      relearned("The user divorced their husband in 2025.", [statement], facts),
      !legacyCovers("The user divorced their husband in 2025.", statement)
    );
    const prose = "## Personal context\nThe user lives in Porto. They are going through a divorce.";
    check("topic: said by a summary", /divorce/.test(scrubSummaryForSuppressions(prose, [statement])), true);
    const digest = "Talked through the divorce settlement options";
    check("topic: fed to a summariser as a digest", !proseCoveredBySuppression(digest, [statement]), !legacyCovers(digest, statement));
  }

  // C — delete a fact another row was merged into.
  {
    const keep = storedEntry("keep", "The user prefers short answers with code examples.", "MANUAL");
    const stored = storedEntry("merged", "The user prefers short answers with examples.", "AUTO");
    const [merge] = planDuplicateMerges([keep, stored]);
    const merged = { ...stored, status: "superseded", supersededById: keep.id, reason: merge?.reason ?? null };
    const effects = planDeletionEffects([{ id: keep.id, content: keep.content }], [merged]);
    const after = effects.find((e) => e.id === merged.id);
    const reasonAfter = after ? after.reason : merged.reason;
    check("delete: quoted in another row's reason", !!reasonAfter?.includes(keep.content), !!merged.reason?.includes(keep.content));
    check("delete: pointed at by another row", !(after?.clearSupersededBy ?? false), false);
  }

  // D — switch a sensitive topic off.
  {
    const entries = [storedEntry("dia", "The user has type 1 diabetes.", "AUTO"), storedEntry("p", "The user lives in Porto.", "AUTO")];
    check("revoked: retrieved", ids(entries, "snacks for my diabetes before a run", [], []).includes("dia"), true);
    check("revoked: fed to a summariser", consolidationMayUse(entries[0], [], []), true);
  }

  // E — delete a fact that had replaced another: the older belief is not believed again.
  {
    const lisbon = storedEntry("lisbon", "The user lives in Lisbon.", "AUTO", { status: "superseded", supersededById: "porto" });
    const effects = planDeletionEffects([{ id: "porto", content: "The user lives in Porto." }], [lisbon]);
    check("delete: older belief resurrected", effects.some((e) => e.id === "lisbon" && e.reason.includes("Porto")), false);
    check("delete: dangling pointer", !effects.some((e) => e.id === "lisbon" && e.clearSupersededBy), false);
  }

  return { checks, leaks, legacyLeaks, leakDetail };
}

/** writeManualFact over an in-memory store, write for write. */
function manualWriteInStore(entries: LifecycleEntry[], content: string, projectId: string | null, now: Date, seq: { n: number }) {
  const plan = planFactIngestion(
    { content, source: "MANUAL", projectId, observedAt: now },
    { entries, suppressions: [], now, allowedSensitiveTopics: SENSITIVE_TOPICS }
  );
  if (plan.action === "skip") return;
  const retire = (id: string, byId: string) => {
    const entry = entries.find((row) => row.id === id);
    if (entry && entry.id !== byId && entry.status === "active") {
      entry.status = "superseded";
      entry.supersededById = byId;
    }
  };
  let id: string;
  if (plan.action === "refresh") {
    const known = entries.find((row) => row.id === plan.entryId)!;
    if (plan.revive || plan.reinstate) {
      known.status = "active";
      known.supersededById = null;
    }
    known.source = "MANUAL";
    known.observedAt = now;
    id = known.id;
  } else {
    seq.n += 1;
    id = `typed-${seq.n}`;
    entries.push({
      id,
      content: plan.content,
      normalized: plan.normalized,
      category: plan.category,
      projectId,
      source: "MANUAL",
      kind: "FACT",
      confidence: plan.confidence,
      status: plan.status,
      expiresAt: plan.expiresAt,
      createdAt: now,
      observedAt: plan.observedAt,
      supersededById: plan.supersededById ?? null,
    });
  }
  if (plan.supersedes) retire(plan.supersedes.entryId, id);
  for (const resolved of plan.resolves ?? []) retire(resolved.entryId, id);
  if (entries.find((row) => row.id === id)?.status === "active") {
    for (const effect of planRewriteEffects({ id, content, projectId }, entries, { now })) retire(effect.entryId, id);
  }
}

function manualSection(): SuiteResult["manual"] {
  const now = EVAL_NOW;
  const failures: string[] = [];
  let passed = 0;
  let legacyPassed = 0;
  for (const testCase of MANUAL_CORRECTION_CASES) {
    const build = () =>
      testCase.stored.map((row, i) =>
        storedEntry(`s${i}`, row.content, row.source, {
          projectId: row.projectId ?? null,
          status: row.status ?? "active",
          ...(row.source === "MANUAL" ? { confidence: 0.9 } : {}),
          observedAt: new Date(now.getTime() - (40 - i) * 86_400_000),
        })
      );
    const judge = (entries: LifecycleEntry[]) => {
      const believed = entries.filter((entry) => believes(entry, now));
      const holds = (fact: string) => believed.some((entry) => normalizeFact(entry.content) === normalizeFact(fact));
      return testCase.believed.every(holds) && !testCase.notBelieved.some(holds);
    };
    const entries = build();
    manualWriteInStore(entries, testCase.typed, testCase.projectId ?? null, now, { n: 0 });
    if (judge(entries)) passed++;
    else failures.push(testCase.id);
    const legacy = build();
    const { category, confidence } = classifyFact(testCase.typed, { source: "MANUAL" });
    legacy.push({ ...storedEntry("typed", testCase.typed, "MANUAL"), category, confidence, createdAt: now, observedAt: now });
    if (judge(legacy)) legacyPassed++;
  }
  let duplicatesLeft = 0;
  let legacyDuplicatesLeft = 0;
  for (const dup of MANUAL_DUPLICATE_CASES) {
    const count = (entries: LifecycleEntry[]) =>
      entries.filter((entry) => believes(entry, now) && normalizeFact(entry.content) === normalizeFact(dup.typed)).length;
    const entries = [storedEntry("d", dup.stored, "AUTO")];
    manualWriteInStore(entries, dup.typed, null, now, { n: 0 });
    if (count(entries) !== 1) duplicatesLeft++;
    const legacy = [storedEntry("d", dup.stored, "AUTO"), storedEntry("t", dup.typed, "MANUAL")];
    if (count(legacy) !== 1) legacyDuplicatesLeft++;
  }
  return {
    cases: MANUAL_CORRECTION_CASES.length,
    passed,
    legacyPassed,
    duplicates: MANUAL_DUPLICATE_CASES.length,
    duplicatesLeft,
    legacyDuplicatesLeft,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Synthetic session-recall corpus
// ---------------------------------------------------------------------------

const TOPICS = [
  "kitchen renovation quotes", "marathon training plan", "quarterly tax filing", "garden irrigation timer",
  "wedding speech draft", "react hydration error", "postgres vacuum tuning", "holiday itinerary japan",
  "podcast microphone setup", "bread sourdough starter", "car insurance renewal", "flutter layout overflow",
  "invoice template design", "chess opening repertoire", "solar panel sizing", "guitar chord progression",
];
const FILLER = [
  "can you help me think through this", "here is what I have so far", "that makes sense, thanks",
  "what would you change", "let me try that and come back", "give me a shorter version", "explain the trade-offs",
  "rewrite it in plain language", "what are the risks", "compare the two options",
];

export interface SyntheticMessage {
  id: string;
  conversationId: string;
  projectId: string | null;
  createdAt: Date;
  text: string;
}

export interface RecallProbe {
  query: string;
  /** The message that answers it. */
  messageId: string;
  /** Its conversation: a hit is the right conversation, as search_chats lists one line per chat. */
  conversationId: string;
  projectId: string | null;
}

/**
 * A long-time account: `messages` messages over two years in conversations of
 * ~20 messages, mostly routine topics, with planted decisions — each a
 * distinctive conversation the probes ask about ("what did we decide about
 * Orbit permissions two weeks ago?"), including near-duplicates on purpose
 * (the same topic discussed three times, months apart).
 */
export function syntheticRecallCorpus(messages: number, now: Date, seed = 7) {
  const random = prng(seed);
  const corpus: SyntheticMessage[] = [];
  const perConversation = 20;
  const conversations = Math.max(1, Math.floor(messages / perConversation));
  const span = 730 * 86_400_000;
  const planted: { topic: string; decision: string; daysAgo: number; projectId: string | null; query: string }[] = [
    { topic: "Orbit permissions", decision: "We decided Orbit agents ask before sending any email and never inherit private memory.", daysAgo: 14, projectId: null, query: "What did we decide about Orbit permissions two weeks ago?" },
    { topic: "Orbit permissions", decision: "Orbit permissions draft: maybe agents could send email freely, undecided.", daysAgo: 160, projectId: null, query: "" },
    { topic: "Orbit permissions", decision: "Orbit permissions follow-up: still undecided on calendar writes.", daysAgo: 300, projectId: null, query: "" },
    { topic: "pricing tiers", decision: "Final call on pricing tiers: Free, Plus at 12 dollars and Team at 30 dollars per seat.", daysAgo: 220, projectId: "p-biz", query: "pricing tiers decision Plus Team" },
    { topic: "database choice", decision: "We chose Postgres with pgbouncer over DynamoDB for the ledger service.", daysAgo: 400, projectId: null, query: "why did we pick Postgres over DynamoDB for the ledger" },
    { topic: "logo feedback", decision: "Logo direction: keep the Continuum mark, drop the gradient, use the presence blue only once.", daysAgo: 95, projectId: "p-brand", query: "Continuum logo gradient feedback" },
    { topic: "visa appointment", decision: "Your visa appointment is at the consulate in Lyon on the 14th, bring the bank statements.", daysAgo: 610, projectId: null, query: "visa appointment Lyon consulate documents" },
    { topic: "router fallback", decision: "Decision: the auto router falls back to the cheaper model when latency exceeds four seconds.", daysAgo: 45, projectId: null, query: "auto router fallback latency decision" },
  ];
  const plantedIds: RecallProbe[] = [];
  let id = 0;
  for (let c = 0; c < conversations; c++) {
    const conversationId = `c${c}`;
    const start = now.getTime() - span + Math.floor((c / conversations) * span);
    const topic = TOPICS[Math.floor(random() * TOPICS.length)];
    const projectId = random() < 0.2 ? "p-biz" : random() < 0.1 ? "p-brand" : null;
    for (let m = 0; m < perConversation; m++) {
      const filler = FILLER[Math.floor(random() * FILLER.length)];
      corpus.push({
        id: `m${id++}`,
        conversationId,
        projectId,
        createdAt: new Date(start + m * 60_000),
        text: m % 2 === 0 ? `About the ${topic}: ${filler}.` : `For the ${topic}, ${filler} — here are three options with notes.`,
      });
    }
  }
  for (const [i, plant] of planted.entries()) {
    const conversationId = `planted-${i}`;
    const at = now.getTime() - plant.daysAgo * 86_400_000;
    const messageId = `planted-${i}-answer`;
    corpus.push(
      { id: `planted-${i}-q`, conversationId, projectId: plant.projectId, createdAt: new Date(at), text: `Let's settle the ${plant.topic} question.` },
      { id: messageId, conversationId, projectId: plant.projectId, createdAt: new Date(at + 60_000), text: plant.decision }
    );
    if (plant.query) plantedIds.push({ query: plant.query, messageId, conversationId, projectId: plant.projectId });
  }
  return { corpus, probes: plantedIds, conversations: conversations + planted.length };
}

/**
 * In-memory stand-in for the database half: an inverted index over the same
 * tokens the blind index stores (identity hasher — the ranking never sees a
 * hash anyway), producing the candidates the SQL produces.
 */
export function inMemoryRecall(corpus: readonly SyntheticMessage[]) {
  const words = new Map<string, Set<number>>();
  const entities = new Map<string, Set<number>>();
  const tokenCounts: number[] = [];
  corpus.forEach((message, i) => {
    const ws = recallTokens(message.text);
    const es = recallEntities(message.text);
    tokenCounts.push(ws.length + es.length);
    for (const w of ws) (words.get(w) ?? words.set(w, new Set()).get(w)!).add(i);
    for (const e of es) (entities.get(e) ?? entities.set(e, new Set()).get(e)!).add(i);
  });
  const meanTokenCount = tokenCounts.reduce((a, b) => a + b, 0) / Math.max(1, tokenCounts.length);
  return {
    search(query: string, opts: { now: Date; projectId: string | null; limit?: number }) {
      const parsed = parseRecallQuery(query, opts.now);
      const hits = new Map<number, { words: string[]; entities: string[] }>();
      for (const w of parsed.words) for (const i of words.get(w) ?? []) {
        const hit = hits.get(i) ?? { words: [], entities: [] };
        hit.words.push(w);
        hits.set(i, hit);
      }
      for (const e of parsed.entities) for (const i of entities.get(e) ?? []) hits.get(i)?.entities.push(e);
      const df = new Map(parsed.words.map((w) => [w, words.get(w)?.size ?? 0]));
      const candidates: (RecallCandidate & { index: number })[] = [...hits].map(([i, hit]) => ({
        index: i,
        messageId: corpus[i].id,
        conversationId: corpus[i].conversationId,
        projectId: corpus[i].projectId,
        createdAt: corpus[i].createdAt,
        matchedWords: hit.words,
        matchedEntities: hit.entities,
        tokenCount: tokenCounts[i],
      }));
      return rankRecallCandidates(candidates, {
        query: parsed,
        corpusSize: corpus.length,
        documentFrequency: df,
        meanTokenCount,
        projectId: opts.projectId,
        now: opts.now,
      }).slice(0, opts.limit ?? 8);
    },
  };
}

/** What the replaced scan could see: the 50 most recently active conversations, 1,500 messages. */
function legacyWindow(corpus: readonly SyntheticMessage[]): Set<string> {
  const lastAt = new Map<string, number>();
  for (const m of corpus) lastAt.set(m.conversationId, Math.max(lastAt.get(m.conversationId) ?? 0, m.createdAt.getTime()));
  const recent = new Set([...lastAt].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([id]) => id));
  return new Set(
    corpus
      .filter((m) => recent.has(m.conversationId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 1500)
      .map((m) => m.id)
  );
}

function recallAndLatencySection(opts: SuiteOptions): { recall: SuiteResult["recall"]; latency: SuiteResult["latency"] } {
  const now = new Date("2026-10-01T12:00:00Z");
  const size = opts.recallMessages ?? 20_000;
  const { corpus, probes, conversations } = syntheticRecallCorpus(size, now);
  const index = inMemoryRecall(corpus);
  const window = legacyWindow(corpus);
  let hitAt1 = 0;
  let hitAt5 = 0;
  let legacy = 0;
  const rankTimes: number[] = [];
  for (const probe of probes) {
    const t0 = performance.now();
    const results = index.search(probe.query, { now, projectId: probe.projectId });
    rankTimes.push(performance.now() - t0);
    // Best result per conversation, as the search_chats tool lists them.
    const chats = [...new Set(results.map((r) => r.conversationId))];
    if (chats[0] === probe.conversationId) hitAt1++;
    if (chats.slice(0, 5).includes(probe.conversationId)) hitAt5++;
    if (window.has(probe.messageId)) legacy++;
  }
  // Repeat for stable latency figures.
  for (let r = 0; r < 20; r++) {
    for (const probe of probes) {
      const t0 = performance.now();
      index.search(probe.query, { now, projectId: probe.projectId });
      rankTimes.push(performance.now() - t0);
    }
  }

  // Fact selection over a crowded account.
  const random = prng(11);
  const facts: LifecycleEntry[] = Array.from({ length: 2000 }, (_, i) => {
    const content = `The user ${["prefers", "uses", "likes", "works on", "is learning"][i % 5]} ${TOPICS[i % TOPICS.length]} variant ${i}.`;
    const { category, confidence } = classifyFact(content);
    const at = new Date(now.getTime() - Math.floor(random() * 700) * 86_400_000);
    return {
      id: `f${i}`, content, normalized: normalizeFact(content), category, projectId: i % 7 === 0 ? "p1" : null,
      source: "AUTO", kind: "FACT", confidence, status: "active", expiresAt: null, createdAt: at, observedAt: at,
    };
  });
  const selectTimes: number[] = [];
  for (let q = 0; q < 200; q++) {
    const t0 = performance.now();
    selectMemoriesForContext(facts, { query: `${TOPICS[q % TOPICS.length]} plan`, projectId: q % 3 === 0 ? "p1" : null, now });
    selectTimes.push(performance.now() - t0);
  }

  return {
    recall: {
      messages: corpus.length,
      conversations,
      questions: probes.length,
      hitAt1,
      hitAt5,
      legacyWindowHitAt5: legacy,
    },
    latency: {
      factSelectP50Ms: round(quantile(selectTimes, 0.5), 2),
      factSelectP95Ms: round(quantile(selectTimes, 0.95), 2),
      recallRankP50Ms: round(quantile(rankTimes, 0.5), 2),
      recallRankP95Ms: round(quantile(rankTimes, 0.95), 2),
    },
  };
}

export async function runMemorySuite(opts: SuiteOptions = {}): Promise<SuiteResult> {
  const { recall, latency } = recallAndLatencySection(opts);
  return {
    lifecycle: await lifecycleSection(),
    corrections: correctionsSection(),
    falseMemory: await falseMemorySection(),
    consolidation: consolidationSection(),
    scope: scopeSection(opts),
    sensitive: sensitiveSection(),
    summary: await summarySection(),
    tokens: await tokensSection(),
    latency,
    recall,
    personalisation: personalisationSection(),
    deletion: deletionSection(),
    manual: manualSection(),
  };
}

/** The deterministic part of a result — latency varies by machine and is never compared. */
export function deterministicPart(result: SuiteResult): Omit<SuiteResult, "latency"> {
  const { latency: _latency, ...rest } = result;
  return rest;
}
