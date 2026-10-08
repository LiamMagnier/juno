/*
 * Research engine stage — scheduler: delegations, the lead's round review, worker tool binding, and parallel worker rounds under the per-host gate.
 * Moved verbatim out of createResearchEngine (engine.ts).
 */
import {
  CHUNK_PREVIEW_CHARS,
  type ReviewRoundInput,
  type ReviewRoundOutput,
  type WorkerResult,
  type WorkerStopReason,
  type WorkerTools,
  type WorkerSearchHit,
  chunkOrdinal,
  chunkText,
  compileFindPattern,
} from "@/lib/research/agents/protocol";
import {
  COVERAGE_TARGET,
  MAX_DELEGATIONS_PER_ROUND,
  MAX_RESEARCH_ROUNDS,
  MAX_ROUND_OPEN_QUESTIONS,
  MAX_WORKER_QUERIES,
  PAGE_FETCH_FEE_MICRO_USD,
  type ResearchConflict,
  type ResearchDelegation,
  type ResearchPlan,
  type ResearchRound,
  SATURATION_NEW_CLAIM_SHARE,
  SEARCH_FEE_MICRO_USD,
  VENDOR_ESTIMATE_MARGIN,
  budgetExhausted,
  buildResearchObjectives,
  investigationElapsedMs,
  modelCallEstimateMicroUsd,
  parsePlan,
  planBudget,
  reviewEstimateMicroUsd,
  workerEstimateMicroUsd,
} from "@/lib/research/domain";
import {
  AUDIT_ASSIST_MAX_FINDINGS,
  AUDIT_ASSIST_OUTPUT_TOKENS,
  AUDIT_ASSIST_PROMPT_CHARS,
  AUDIT_ASSIST_SYSTEM,
  shouldAssist,
} from "@/lib/research/audit-assist";
import { comparisonOptions } from "@/lib/research/metric-match";
import {
  MAX_SOURCES,
  READ_ESTIMATE_MICRO_USD,
  SEARCH_ESTIMATE_MICRO_USD,
  SNAPSHOT_CHARS,
  researchBriefText,
} from "./limits";
import {
  type AuditAssistInput,
  type ResearchRunRow,
  type ResearchSourceRow,
  type StepOutcome,
  pageSkipMessage,
  pageWasSkipped,
} from "./types";
import { canonicalUrl } from "@/lib/search/url-safety";
import { hostOfUrl, scoreSource, sourceTypeOf } from "@/lib/research/claim-analysis";
import { runAll } from "@/lib/research/agents/scheduler";
import { duplicateOf, subjectOf } from "@/lib/research/query-dedupe";
import { rankByPolicy, tierLabel } from "@/lib/research/source-policy";
import { extractLeads, type ResearchLead } from "@/lib/research/leads";
import { auditGaps, renderGapAudit } from "@/lib/research/gap-audit";
import type { ResearchObjective } from "@/lib/research/domain";
import { splitPassages } from "./writer-text";
import type { EngineContext } from "./context";

/**
 * Rounds a run makes before it may write, when its envelope allows them
 * (protocol RULE 0.3: "do not stop at round 1"). A first round that the lead
 * judges sufficient still sends a second one after the leads its findings
 * opened and the figures the gap audit found missing — and only when there
 * are some: a second round with nothing to chase is not research, it is spend.
 */
export const MIN_RESEARCH_ROUNDS = 2;

/** The vector's contract, as a worker brief reads it (protocol Stage 1 → Stage 3). */
export function vectorBrief(objective: Pick<ResearchObjective, "vector">): string {
  const vector = objective.vector;
  if (!vector) return "";
  return [
    vector.metrics.length ? `Exact figures to extract (from the page, with their dates): ${vector.metrics.join("; ")}.` : "",
    vector.sources.length ? `Primary records to target first: ${vector.sources.join("; ")}.` : "",
    vector.verify.length ? `Claims to verify or refute against a primary record: ${vector.verify.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function createWorkerStage(ctx: EngineContext) {
  const { deps, store, heartbeatMs, beat, append, fetchPage, markSyndicatedCopies, affordable, affordableCount, writerReserve, applySteering, bill, windowSpent } = ctx;
  const initialDelegations = (plan: ResearchPlan, workers: number): ResearchDelegation[] => {
    const objectives = plan.objectives.length ? plan.objectives : buildResearchObjectives("", plan.queries);
    const ranked = [...objectives].sort((a, b) => b.importance - a.importance);
    const out: ResearchDelegation[] = [];
    const limit = Math.min(workers, MAX_DELEGATIONS_PER_ROUND);
    for (const objective of ranked) {
      if (out.length >= limit) break;
      const requirements = objective.evidenceRequirements.map((r) => r.description).filter(Boolean);
      out.push({
        workerId: `w1-${out.length + 1}`,
        objectiveId: objective.id,
        objective: objective.question,
        whatToFind: [
          `Establish, with quotes from authoritative pages, what is known about: ${objective.question}.`,
          ...(vectorBrief(objective) ? [vectorBrief(objective)] : []),
          ...(requirements.length && !objective.vector ? [`Evidence needed: ${requirements.slice(0, 3).join("; ")}.`] : []),
          "Prefer official documentation, pricing pages, changelogs, filings, repositories and benchmarks over articles about them; never cite an aggregator or affiliate roundup when the record exists; note the date of every figure.",
        ].join(" "),
        boundaries: "Other workers cover the other sub-questions; stay on this one.",
      });
    }
    const axes = [
      {
        label: "counter-evidence",
        find: "Find the strongest disagreement, criticism, failure cases and conflicting numbers about: {q}. Look for sceptical experts, independent audits, complaints, retractions and second opinions.",
        bounds: "Another worker is collecting the mainstream account and official figures; do not repeat it.",
      },
      {
        label: "recent developments",
        find: "Find the most recent developments, announcements, releases, rulings and data about: {q}. Prioritise the last twelve months and record exact dates.",
        bounds: "Another worker covers background and the established record; only bring back what is new.",
      },
      {
        label: "primary records",
        find: "Find the primary records behind: {q} — original studies, filings, specifications, datasets, official statistics, court or regulator documents — and quote the figures directly from them.",
        bounds: "Another worker covers secondary reporting; skip news summaries unless they link to the primary document.",
      },
    ];
    let axis = 0;
    for (const objective of ranked) {
      if (out.length >= limit) break;
      const a = axes[axis % axes.length]!;
      axis += 1;
      out.push({
        workerId: `w1-${out.length + 1}`,
        objectiveId: objective.id,
        objective: objective.question,
        whatToFind: a.find.replace("{q}", objective.question),
        boundaries: a.bounds,
      });
    }
    return out;
  };

  /**
   * The lead's fallback review, when no reviewer is wired.
   *
   * Counts independent hosts behind each sub-question's findings and keeps
   * going only while a round is still adding claims — the saturation rule
   * `SATURATION_NEW_CLAIM_SHARE` states.
   */
  const fallbackReview = (input: ReviewRoundInput): ReviewRoundOutput => {
    const coverage: Record<string, number> = {};
    const gaps: ReviewRoundOutput["gaps"] = [];
    for (const objective of input.objectives) {
      const own = input.findings.filter((finding) => finding.objectiveId === objective.id);
      const hosts = new Set(own.map((finding) => hostOfUrl(finding.url)));
      const score = Math.min(1, hosts.size * 0.4 + Math.min(own.length, 6) * 0.05);
      coverage[objective.id] = Number(score.toFixed(2));
      if (score < COVERAGE_TARGET) {
        gaps.push({
          objectiveId: objective.id,
          reason: own.length === 0 ? "No sourced finding answers this yet." : "Only one line of evidence so far.",
          whatToFind: `Find independent, primary evidence for: ${objective.question}. Go somewhere the last round did not: a different kind of source, a specific dataset or filing, the field's own vocabulary.`,
          boundaries: "Do not re-read pages the run has already opened unless you need a specific figure from them.",
        });
      }
    }
    const newThisRound = input.findings.filter((finding) => finding.round === input.round).length;
    const saturated = input.round > 1 && newThisRound < Math.max(2, input.findings.length * SATURATION_NEW_CLAIM_SHARE);
    const decision = gaps.length > 0 && input.roundsLeft > 0 && input.pagesLeft > 0 && !saturated ? "continue" : "synthesize";
    return {
      coverage,
      gaps: decision === "continue" ? gaps : [],
      contradictions: [],
      decision,
      reason:
        decision === "continue"
          ? `${gaps.length} sub-question${gaps.length === 1 ? "" : "s"} still short of evidence.`
          : saturated
            ? "The last round added little that was new."
            : gaps.length === 0
              ? "Every sub-question has independent, sourced evidence."
              : "No rounds or pages left for the remaining gaps.",
      costMicroUsd: 0,
    };
  };

  /**
   * The tools one worker holds, bound to this run.
   *
   * The engine implements them rather than the worker because the engine owns
   * the money and the corpus: every search is billed and its hits become
   * sources, every page opened is stored with its passages so the citation
   * audit can later check a claim against the bytes the worker saw, and every
   * finding lands in the shared table the lead reviews. The per-run counters
   * (`pagesRead`, `spent`) are shared across the round's workers on purpose —
   * the tier's page ceiling is a ceiling on the RUN.
   */
  const bindWorkerTools = (
    run: ResearchRunRow,
    workerId: string,
    round: number,
    objectiveId: string,
    shared: {
      pagesRead: number;
      toolCalls: number;
      pageCeiling: number;
      resultsPerQuery: number;
      /** Every query the round's workers issued, for the plan's ledger. */
      queries: string[];
      /** Canonical URLs an earlier pass found dead for good. */
      unreadable: ReadonlySet<string>;
      /** Every search the run made before this round: a near-duplicate is refused (protocol Stage 3). */
      issued: readonly string[];
      /** This round's searches and their results, so a teammate's near-duplicate is served from cache. */
      results: Map<string, WorkerSearchHit[]>;
    },
    perWorker: { maxToolCalls: number; deadline: number },
    signal?: AbortSignal
  ): WorkerTools => {
    let calls = 0;
    const tick = async (tool: string, arg: string, startedAt: number, ok: boolean) => {
      calls += 1;
      shared.toolCalls += 1;
      await append(run.id, run.userId, [
        {
          kind: "worker_tool_call",
          payload: { workerId, round, tool, arg: arg.slice(0, 200), ms: Date.now() - startedAt, ok },
        },
      ]);
    };
    /** The stop the NEXT call would hit, decided after this one ran. */
    const stopAfter = async (): Promise<WorkerStopReason | undefined> => {
      if (signal?.aborted) return "aborted";
      if (calls >= perWorker.maxToolCalls) return "tool_limit";
      if (Date.now() >= perWorker.deadline) return "time_limit";
      const fresh = await store.loadRun(run.id, run.userId);
      if (!fresh || fresh.state !== "investigating") return "aborted";
      if (budgetExhausted(fresh.costMicroUsd, fresh.budgetMicroUsd)) return "budget";
      return undefined;
    };
    // One indexed row where the store offers it; the corpus scan is the
    // fallback for the test stores only. See `ResearchStore.findSourceByUrl`.
    const sourceByUrl = async (url: string): Promise<ResearchSourceRow | null> => {
      if (store.findSourceByUrl) return store.findSourceByUrl(run.id, run.userId, url);
      const key = canonicalUrl(url);
      return (await store.listSources(run.id, run.userId)).find((source) => canonicalUrl(source.url) === key) ?? null;
    };
    const digestOf = (source: ResearchSourceRow, alreadyRead: boolean) => {
      const text = source.snapshot ?? "";
      const chunks = chunkText(text);
      return {
        ok: true as const,
        sourceId: source.id,
        url: source.url,
        title: source.title,
        summary: text.slice(0, 700).replace(/\s+/g, " "),
        chunkCount: chunks.length,
        chunks: chunks.map((chunk) => ({ ordinal: chunk.ordinal, preview: chunk.text.slice(0, CHUNK_PREVIEW_CHARS).replace(/\s+/g, " ") })),
        alreadyRead,
      };
    };

    return {
      async search(query) {
        const startedAt = Date.now();
        // A paraphrase of a search the team already ran returns the same page
        // of results for a second fee. Refused before anything is billed, and
        // counted as a call so a worker that insists still runs out of calls.
        // A teammate ran it THIS round: same results, served from the round's
        // cache — no second fee, and the worker still sees what is there.
        const cachedAs = duplicateOf(query, [...shared.results.keys()]);
        if (cachedAs) {
          await tick("search", query, startedAt, true);
          return {
            result: { hits: shared.results.get(cachedAs) ?? [], note: `A teammate already ran "${cachedAs}" this round; these are its results (no new search was made).` },
            stop: await stopAfter(),
          };
        }
        const duplicate = duplicateOf(query, [...shared.issued, ...shared.queries]);
        if (duplicate) {
          await tick("search", query, startedAt, false);
          return {
            result: {
              hits: [],
              note: `Not run: a near-duplicate of the team's earlier search "${duplicate}". Search for a specific primary record instead (a docs page, pricing page, changelog, filing or repository), or use the field's own vocabulary.`,
            },
            stop: await stopAfter(),
          };
        }
        if (!(await affordable(run, SEARCH_ESTIMATE_MICRO_USD))) {
          await tick("search", query, startedAt, false);
          return { result: { hits: [], note: "The run's budget cannot pay for another search." }, stop: "budget" };
        }
        const result = await deps.search({ userId: run.userId, query, count: shared.resultsPerQuery, signal });
        await bill(run, result.costMicroUsd, "search");
        // On the round's shared list, not written to the plan here: workers run
        // in parallel and a read-modify-write of the plan JSON from each call
        // would lose updates. `doWorkerRounds` persists the list once with the
        // round, which is what lets the gap expander see what the team tried.
        shared.queries.push(query);
        await append(run.id, run.userId, [
          { kind: "query_issued", payload: { query, results: result.hits.length, workerId, round, ...(result.engines?.length ? { engines: result.engines } : {}) } },
        ]);
        // What the run already holds, by URL and text length only: this map
        // marks results the run has read, and loading every snapshot to build
        // it was the whole corpus per search.
        const known = new Map<string, number>(
          store.listSourceUrls
            ? (await store.listSourceUrls(run.id, run.userId)).map((source) => [canonicalUrl(source.url), source.snapshotChars])
            : (await store.listSources(run.id, run.userId)).map((source) => [canonicalUrl(source.url), source.snapshot?.length ?? 0])
        );
        const hits = [];
        for (const hit of result.hits) {
          const knownChars = known.get(canonicalUrl(hit.url));
          if (knownChars === undefined) {
            const body = hit.rawContent?.trim() ? hit.rawContent.slice(0, SNAPSHOT_CHARS) : null;
            const score = scoreSource({ url: hit.url, title: hit.title, text: body ?? hit.snippet, publishedAt: hit.publishedAt });
            const stored = await store.upsertSource({
              runId: run.id,
              userId: run.userId,
              url: hit.url,
              title: hit.title,
              publishedAt: hit.publishedAt,
              ...(body ? { snapshot: body, contentHash: deps.hash(body) } : {}),
              ...score,
              sourceType: sourceTypeOf({ url: hit.url, text: body ?? hit.snippet, authority: score.authority }),
            });
            if (stored.created) {
              await append(run.id, run.userId, [{ kind: "source_found", payload: { url: hit.url, title: hit.title, query, workerId } }]);
            }
            known.set(canonicalUrl(hit.url), body?.length ?? 0);
          }
          hits.push({ url: hit.url, title: hit.title, snippet: hit.snippet.slice(0, 300), read: (knownChars ?? 0) >= 2_000 });
        }
        await tick("search", query, startedAt, true);
        // Primary records first and every hit labelled, so the worker opens
        // the vendor's own page rather than the roundup that outranked it.
        const ranked = rankByPolicy(hits).map(({ assessment, ...hit }) => ({ ...hit, quality: tierLabel(assessment.tier) }));
        shared.results.set(query, ranked);
        return { result: { hits: ranked }, stop: await stopAfter() };
      },

      async openPage(url) {
        const startedAt = Date.now();
        const existing = await sourceByUrl(url);
        if (existing?.snapshot && existing.snapshot.length >= 2_000) {
          await tick("open_page", url, startedAt, true);
          return { result: digestOf(existing, true), stop: await stopAfter() };
        }
        if (shared.unreadable.has(canonicalUrl(url))) {
          await tick("open_page", url, startedAt, false);
          return { result: { ok: false, url, reason: "that page could not be read earlier in this run" }, stop: await stopAfter() };
        }
        if (shared.pagesRead >= shared.pageCeiling) {
          await tick("open_page", url, startedAt, false);
          return { result: { ok: false, url, reason: "the run has read every page its tier allows" }, stop: "page_limit" };
        }
        if (!(await affordable(run, READ_ESTIMATE_MICRO_USD))) {
          await tick("open_page", url, startedAt, false);
          return { result: { ok: false, url, reason: "the run's budget cannot pay for another page" }, stop: "budget" };
        }
        const page = await fetchPage(run.userId, url, signal);
        if (!page || pageWasSkipped(page)) {
          await tick("open_page", url, startedAt, false);
          if (page) {
            await append(run.id, run.userId, [
              { kind: "error", payload: { scope: "source", url, message: pageSkipMessage(page), reason: page.skipped, workerId } },
            ]);
          }
          return { result: { ok: false, url, reason: page ? pageSkipMessage(page) : "the page returned no readable text" }, stop: await stopAfter() };
        }
        await bill(run, page.costMicroUsd, "fetch");
        const text = page.text.slice(0, SNAPSHOT_CHARS);
        const publishedAt = page.publishedAt ?? existing?.publishedAt ?? null;
        const score = scoreSource({ url, title: page.title || existing?.title, text, publishedAt });
        const stored = await store.upsertSource({
          runId: run.id,
          userId: run.userId,
          url,
          title: page.title || existing?.title || url,
          publishedAt,
          contentHash: deps.hash(text),
          snapshot: text,
          ...score,
          sourceType: sourceTypeOf({ url, text, authority: score.authority }),
        });
        await store.savePassages({ userId: run.userId, sourceId: stored.id, passages: splitPassages(text) });
        shared.pagesRead += 1;
        await append(run.id, run.userId, [{ kind: "source_read", payload: { url, title: page.title, workerId, round } }]);
        await tick("open_page", url, startedAt, true);
        // Built from what was just stored, not read back: the text in hand is
        // the text on the row, and a second corpus load per open was the
        // dearest part of the tool.
        const row: ResearchSourceRow = {
          ...(existing ?? { contentHash: null, authority: null, fetchedAt: deps.now() }),
          id: stored.id,
          url,
          title: page.title || existing?.title || url,
          publishedAt,
          snapshot: text,
        };
        return { result: digestOf(row, false), stop: await stopAfter() };
      },

      async findInPage(url, pattern) {
        const startedAt = Date.now();
        const source = await sourceByUrl(url);
        if (!source?.snapshot) {
          await tick("find_in_page", pattern, startedAt, false);
          return { result: { ok: false, matches: [], reason: "open the page first" }, stop: await stopAfter() };
        }
        const regex = compileFindPattern(pattern);
        const matches = chunkText(source.snapshot)
          .filter((chunk) => regex.test(chunk.text))
          .slice(0, 6)
          .map((chunk) => ({ ordinal: chunk.ordinal, text: chunk.text }));
        await tick("find_in_page", pattern, startedAt, true);
        return { result: { ok: true, matches }, stop: await stopAfter() };
      },

      async noteFinding(finding) {
        const startedAt = Date.now();
        const source = await sourceByUrl(finding.url);
        if (!source) {
          await tick("note_finding", finding.claim, startedAt, false);
          return { result: { ok: false, reason: "cite a page you opened in this run" }, stop: await stopAfter() };
        }
        // The quote has to be IN the page. A worker that paraphrases and calls
        // it a quote has produced a claim the citation audit will reject later;
        // catching it here costs one string search and teaches the worker.
        const haystack = (source.snapshot ?? "").replace(/\s+/g, " ").toLowerCase();
        if (!haystack) {
          // A row with no body is a search hit, not a page: every result the
          // run has ever seen has one. Skipping the check for those — which
          // this used to do — let a worker note any quote against any URL it
          // had merely seen in a result list, and the check's whole purpose is
          // that a finding is a quote from a page the worker read.
          await tick("note_finding", finding.claim, startedAt, false);
          return { result: { ok: false, reason: "open that page with open_page before citing it" }, stop: await stopAfter() };
        }
        const needle = finding.quote.replace(/\s+/g, " ").toLowerCase();
        const probe = needle.length > 80 ? needle.slice(0, 80) : needle;
        if (!haystack.includes(probe)) {
          await tick("note_finding", finding.claim, startedAt, false);
          return { result: { ok: false, reason: "the quote does not appear verbatim on that page — use find_in_page and quote exactly" }, stop: await stopAfter() };
        }
        if (store.addFinding) {
          await store.addFinding({
            runId: run.id,
            userId: run.userId,
            workerId,
            round,
            objectiveId,
            sourceId: source.id,
            url: source.url,
            claim: finding.claim,
            quote: finding.quote,
            locator: chunkOrdinal(finding.locator) !== null ? finding.locator! : null,
            confidence: finding.confidence ?? null,
          });
        }
        await tick("note_finding", finding.claim, startedAt, true);
        return { result: { ok: true }, stop: await stopAfter() };
      },
    };
  };

  /**
   * The agent rounds: a team of workers, a lead's review, repeat.
   *
   * Runs inside the `investigating` step after the sweep has seeded the
   * corpus. Each round dispatches the tier's worker count in parallel, each
   * with its own brief and its own tool loop, then hands what they noted to
   * the lead, who scores every sub-question and either writes the next
   * round's briefs or declares the corpus ready. Rounds are recorded on the
   * plan as they finish, so a driver that resumes the run picks up at the
   * round after the last one recorded rather than paying for it twice.
   *
   * Skipped entirely when no worker is wired (the test engines), and bounded
   * in every unit the tier names: workers per round, rounds, tool calls per
   * worker, pages for the run, wall clock for the run and per worker, money.
   */
  const doWorkerRounds = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<{ run: ResearchRunRow; outcome?: StepOutcome }> => {
    if (!deps.runWorker) return { run };
    let current = run;
    let plan = parsePlan(current.plan);
    const budget = planBudget(plan);
    const startedAt = plan.budget?.startedAt ?? deps.now().toISOString();
    if (!plan.budget?.startedAt) {
      plan = { ...plan, budget: { ...budget, startedAt } };
      current = (await store.savePlan({ runId: run.id, userId: run.userId, plan })) ?? current;
    }
    const totalRounds = Math.min(budget.rounds, MAX_RESEARCH_ROUNDS);
    let delegations: ResearchDelegation[] = [];
    const lastRecorded = plan.rounds?.[plan.rounds.length - 1];
    if (lastRecorded?.review?.decision === "synthesize") return { run: current };
    let round = (plan.rounds?.length ?? 0) + 1;
    if (round > totalRounds) return { run: current };
    const workerTokens = { used: plan.rounds?.reduce((n, r) => n + r.tokens, 0) ?? 0 };
    /** Whether any workers went out, so the syndication pass below runs only over pages they could have added. */
    let ranARound = false;

    while (round <= totalRounds) {
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "investigating") return { run: current, outcome: { kind: "raced" } };
      current = fresh;
      plan = parsePlan(current.plan);
      await heartbeat?.();

      // A round boundary: "Finish now" stops the rounds (§9.7), and guidance
      // queued since the last boundary becomes constraints before the briefs
      // are written (§9.4).
      if (plan.finishRequestedAt) break;
      // A spent usage window is the run's money limit (§6): write with what it has.
      if (await windowSpent(current)) {
        // Reloaded so nothing after the loop saves the plan from before the stop.
        current = (await store.loadRun(current.id, current.userId)) ?? current;
        plan = parsePlan(current.plan);
        break;
      }
      if ((plan.steering ?? []).some((entry) => entry.appliedAtRound === null)) {
        current = await applySteering(current, round);
        plan = parsePlan(current.plan);
      }

      if (investigationElapsedMs(plan, deps.now()) >= budget.wallClockMs) break;
      if (workerTokens.used >= budget.tokens) break;

      /*
       * Pages READ means pages FETCHED: the sweep's, from the plan, plus what
       * every recorded round's workers opened. It used to be the count of rows
       * with a snapshot, which a search backend that returns page bodies fills
       * to several hundred before anything has been fetched — so this gate
       * broke out here on every tier and the team never ran. See
       * `ResearchPlan.seedPagesRead`.
       */
      const readNow = (plan.seedPagesRead ?? 0) + (plan.rounds ?? []).reduce((n, item) => n + item.pagesRead, 0);
      const pageCeiling = Math.min(MAX_SOURCES, budget.pages);
      if (readNow >= pageCeiling) break;

      if (delegations.length === 0) {
        const previous = plan.rounds?.[plan.rounds.length - 1]?.review;
        // A resumed run rebuilds the next round's briefs from the recorded
        // review; a fresh one sends the first team out on the plan itself.
        delegations = previous && round > 1
          ? previous.gaps.map((gap, i) => {
              const objective = plan.objectives.find((item) => item.id === gap.objectiveId);
              return {
                workerId: `w${round}-${i + 1}`,
                objectiveId: gap.objectiveId,
                objective: objective?.question ?? gap.objectiveId,
                whatToFind: `Close this gap: ${gap.reason} Go somewhere the last round did not — a different kind of source, a specific dataset or filing, the field's own vocabulary.`,
                boundaries: "Do not re-read pages the run has already opened unless you need a specific figure from them.",
              };
            })
          : initialDelegations(plan, budget.workers);
      }
      delegations = delegations.slice(0, Math.min(budget.workers, MAX_DELEGATIONS_PER_ROUND));
      if (delegations.length === 0) break;

      /*
       * One budget decision for the whole round, taken BEFORE any worker
       * starts, at the worker's worst case: its whole tool loop at the worker
       * model's own rates, plus a vendor fee per call. It was an ad-hoc
       * formula — a search fee for every third tool call — that reserved about
       * a third of the vendor fees alone and nothing for the model, whose
       * spend only reaches the ledger when the worker returns; a budgeted run
       * could overshoot its ceiling by a full round of worker calls. Without
       * rates (the tests) the vendor fees are the floor.
       */
      const perWorkerEstimate = deps.modelRates?.worker
        ? workerEstimateMicroUsd(budget, deps.modelRates.worker)
        : budget.toolCallsPerWorker * Math.max(SEARCH_FEE_MICRO_USD, PAGE_FETCH_FEE_MICRO_USD) * VENDOR_ESTIMATE_MARGIN;
      // B8: the round is priced with the writer's and the audit's reservation
      // held back, so investigation can never starve the report.
      const affordableWorkers = await affordableCount(current, perWorkerEstimate, delegations.length, writerReserve(plan));
      if (affordableWorkers === 0) break;
      delegations = delegations.slice(0, affordableWorkers);

      const roundStartedAt = deps.now().toISOString();
      const findingsBefore = store.listFindings ? await store.listFindings(current.id, current.userId) : [];
      const citedBefore = new Set(findingsBefore.map((finding) => canonicalUrl(finding.url)));
      const shared = {
        pagesRead: readNow,
        toolCalls: 0,
        pageCeiling,
        resultsPerQuery: budget.resultsPerQuery,
        queries: [] as string[],
        unreadable: new Set((plan.unreadable ?? []).map((url) => canonicalUrl(url))),
        issued: [...(plan.issuedQueries ?? []), ...(plan.workerQueries ?? [])],
        results: new Map<string, WorkerSearchHit[]>(),
      };
      // URLs with text, for the brief; by URL and length only, since the
      // snapshots themselves are not needed to tell a worker what to skip.
      const visited = store.listSourceUrls
        ? (await store.listSourceUrls(current.id, current.userId)).filter((source) => source.snapshotChars > 0).map((source) => source.url)
        : (await store.listSources(current.id, current.userId)).filter((source) => source.snapshot).map((source) => source.url);
      const recentQueries = [...(plan.issuedQueries ?? []), ...(plan.workerQueries ?? [])].slice(-24);
      const roundDeadline = Date.now() + Math.min(budget.workerWallClockMs, Math.max(30_000, budget.wallClockMs - investigationElapsedMs(plan, deps.now())));

      await append(current.id, current.userId, [
        ...delegations.map((delegation) => ({
          kind: "worker_spawned" as const,
          payload: {
            workerId: delegation.workerId,
            round,
            objectiveId: delegation.objectiveId,
            objective: delegation.objective,
            whatToFind: delegation.whatToFind.slice(0, 400),
          },
        })),
      ]);

      // Workers run in parallel up to the tier's width; the heartbeat keeps the
      // lease alive underneath them, since a round comfortably outlives it.
      const pulse = setInterval(() => void heartbeat?.().catch(() => undefined), heartbeatMs);
      let settled: Awaited<ReturnType<typeof runAll<ResearchDelegation, WorkerResult>>>;
      try {
        settled = await runAll(
          delegations,
          budget.workers,
          async (delegation) => {
            const tools = bindWorkerTools(
              current,
              delegation.workerId,
              round,
              delegation.objectiveId,
              shared,
              { maxToolCalls: budget.toolCallsPerWorker, deadline: roundDeadline },
              signal
            );
            return deps.runWorker!({
              userId: current.userId,
              brief: {
                delegation,
                round,
                goal: current.goal,
                brief: researchBriefText(plan),
                constraints: plan.constraints,
                visited,
                recentQueries,
                ...(plan.today ? { today: plan.today } : {}),
              },
              tools,
              limits: { maxToolCalls: budget.toolCallsPerWorker, wallClockMs: Math.max(30_000, roundDeadline - Date.now()) },
              signal,
            });
          },
          signal
        );
      } finally {
        clearInterval(pulse);
      }
      ranARound = true;

      const reports: ReviewRoundInput["workerReports"] = [];
      let roundTokens = 0;
      let roundCalls = 0;
      /** Why each worker stopped, for the all-failed check after the loop. */
      const roundResults: WorkerResult["reason"][] = [];
      for (let i = 0; i < delegations.length; i += 1) {
        const delegation = delegations[i]!;
        const outcome = settled[i]!;
        const result: WorkerResult = outcome.ok
          ? outcome.value
          : { summary: "", openQuestions: [], followUps: [], tokens: 0, costMicroUsd: 0, reason: "error", toolCalls: 0, elapsedMs: 0 };
        roundTokens += result.tokens;
        roundCalls += result.toolCalls;
        roundResults.push(result.reason);
        await bill(current, result.costMicroUsd, "worker");
        reports.push({
          workerId: delegation.workerId,
          objectiveId: delegation.objectiveId,
          summary: result.summary,
          openQuestions: result.openQuestions,
          followUps: result.followUps,
        });
        await append(current.id, current.userId, [
          {
            kind: "worker_finished",
            payload: {
              workerId: delegation.workerId,
              round,
              objectiveId: delegation.objectiveId,
              reason: result.reason,
              toolCalls: result.toolCalls,
              tokens: result.tokens,
              ms: result.elapsedMs,
              summary: result.summary.slice(0, 600),
              openQuestions: result.openQuestions.slice(0, 4),
            },
          },
        ]);
      }
      workerTokens.used += roundTokens;

      /*
       * EVERY WORKER FAILED TO START — stop, and say so.
       *
       * `model_unavailable` is `runResearchWorker` reporting that it could not
       * build an adapter at all: no configured provider serves a model this
       * loop can drive. That is a deployment fact, so it will be just as true
       * for round two and round three; without this the run walked the whole
       * ladder spawning workers that returned instantly, reviewed rounds with
       * no findings in them, and ended with a report written from the seed
       * sweep alone — which is a shallow run that never once said why.
       *
       * An `error` reason is NOT this case: that is a worker whose model call
       * failed mid-loop, which is worth retrying in the next round.
       */
      if (roundResults.length > 0 && roundResults.every((reason) => reason === "model_unavailable")) {
        await append(current.id, current.userId, [
          {
            kind: "error",
            payload: {
              stage: "investigating",
              recoverable: true,
              message:
                "No configured model can run a research worker, so this run gathered sources without the agent team. Configure a provider with an agentic chat model for a full investigation.",
            },
          },
        ]);
        break;
      }
      /*
       * EVERY WORKER STAYED IDLE — the same shape as above, one layer up. An
       * `idle` worker had a model but never called a tool: it answered every
       * turn in prose through every nudge. A whole round of that has produced
       * nothing to review, and a model that ignores its tools once will do it
       * again next round, so the ladder stops here and says so rather than
       * paying to review empty rounds while the timeline shows each worker
       * as "done".
       */
      if (roundResults.length > 0 && roundResults.every((reason) => reason === "idle")) {
        await append(current.id, current.userId, [
          {
            kind: "error",
            payload: {
              stage: "investigating",
              recoverable: true,
              message:
                "Every research worker in this round answered in prose without searching or opening a page, so the round produced no findings. The report is written from the sources gathered so far.",
            },
          },
        ]);
        break;
      }

      const findings = store.listFindings ? await store.listFindings(current.id, current.userId) : [];
      const roundFindings = findings.filter((finding) => finding.round === round);
      const newClaims = roundFindings.filter((finding) => !citedBefore.has(canonicalUrl(finding.url))).length;

      // The lead reviews the round — on its model when the ceiling can cover
      // the call, and deterministically when it cannot, rather than skipping
      // the review or auditing on credit.
      const latestPlan = parsePlan(((await store.loadRun(current.id, current.userId)) ?? current).plan);

      /*
       * Protocol Stage 3 and 4, deterministic and free: the leads this round's
       * findings opened (deprecations, new tiers, rate limits, incidents…) as
       * micro-queries, and the gap audit (figures still missing, figures that
       * disagree, figures resting on old pages). Both go to the lead, and both
       * shape the next round's briefs below whatever the lead decides.
       */
      const issuedSoFar = [...shared.issued, ...shared.queries];
      const leadFindings = findings.map((finding) => ({
        objectiveId: finding.objectiveId,
        url: finding.url,
        claim: finding.claim,
        quote: finding.quote,
        round: finding.round,
      }));
      const auditSources = (await store.listSources(current.id, current.userId)).map((source) => ({
        id: source.id,
        url: source.url,
        publishedAt: source.publishedAt,
      }));
      const auditSubject = subjectOf(latestPlan.title || current.goal);
      // Known entities first (compared options, the subject): German
      // capitalises every noun, and a lead must name who, not "Preiserhöhung".
      const entities = [...comparisonOptions(current.goal), auditSubject].filter(Boolean);
      const workerFollowUps = reports.flatMap((report) => report.followUps.map((query) => ({ objectiveId: report.objectiveId, query })));
      const readRound = (
        confirmed: ReadonlyArray<{ objectiveId: string; metric: string }>,
        modelLeads: ReadonlyArray<{ objectiveId: string; query: string; signal: string; from: string }>
      ) => {
        const roundLeads: ResearchLead[] = extractLeads({
          findings: leadFindings,
          round,
          issued: issuedSoFar,
          goal: current.goal,
          suggested: workerFollowUps,
          entities,
          language: latestPlan.language ?? null,
          modelLeads,
        });
        const roundAudit = auditGaps({
          objectives: latestPlan.objectives,
          findings,
          sources: auditSources,
          now: deps.now(),
          subject: auditSubject,
          issued: [...issuedSoFar, ...roundLeads.map((lead) => lead.query)],
          goal: current.goal,
          confirmed,
        });
        return { leads: roundLeads, audit: roundAudit };
      };
      let confirmedFigures = latestPlan.gapAudit?.confirmed ?? [];
      let { leads, audit } = readRound(confirmedFigures, []);

      /*
       * The optional assist: ONE cheap-model call per round, only when a
       * finding could close a missing figure the normaliser could not match,
       * or a finding is in a language the lead patterns are thinnest in, and
       * only when the ceiling can pay with the writer's reserve held back.
       * Its confirmations only remove gaps; its leads pass the same filters.
       */
      let assisted: { confirmed: number; leads: number } | null = null;
      if (deps.auditAssist) {
        const gapped = new Set(audit.entries.filter((entry) => entry.missingFigures.length).map((entry) => entry.objectiveId));
        const shown = [
          ...findings.filter((finding) => finding.round === round),
          ...findings.filter((finding) => finding.round !== round && finding.objectiveId && gapped.has(finding.objectiveId)),
        ].slice(0, AUDIT_ASSIST_MAX_FINDINGS);
        const assistInput: AuditAssistInput = {
          userId: current.userId,
          goal: current.goal,
          language: latestPlan.language ?? null,
          objectives: latestPlan.objectives.map((objective) => ({
            id: objective.id,
            question: objective.question,
            missing: audit.entries.find((entry) => entry.objectiveId === objective.id)?.missingFigures.filter((m) => m !== "any exact figure") ?? [],
          })),
          findings: shown.map((finding, i) => ({ index: i + 1, objectiveId: finding.objectiveId, claim: finding.claim, quote: finding.quote, url: finding.url })),
          issued: [...issuedSoFar, ...leads.map((lead) => lead.query)],
          signal,
        };
        const estimate = modelCallEstimateMicroUsd(AUDIT_ASSIST_PROMPT_CHARS + AUDIT_ASSIST_SYSTEM.length, AUDIT_ASSIST_OUTPUT_TOKENS, deps.modelRates?.worker);
        if (shouldAssist(assistInput) && (await affordableCount(current, estimate, 1, writerReserve(latestPlan))) > 0) {
          try {
            const answer = await beat(() => deps.auditAssist!(assistInput), heartbeat);
            await bill(current, answer.costMicroUsd, "review");
            const byIndex = new Map(assistInput.findings.map((finding) => [finding.index, finding]));
            const seenConfirmed = new Set(confirmedFigures.map((item) => `${item.objectiveId}\u0000${item.metric}`));
            confirmedFigures = [
              ...confirmedFigures,
              ...answer.confirmed
                .map((item) => ({ objectiveId: item.objectiveId, metric: item.metric }))
                .filter((item) => !seenConfirmed.has(`${item.objectiveId}\u0000${item.metric}`)),
            ].slice(-40);
            const modelLeads = answer.leads.map((lead) => ({
              objectiveId: lead.objectiveId,
              query: lead.query,
              signal: lead.signal,
              from: byIndex.get(lead.finding)?.url ?? "",
            }));
            ({ leads, audit } = readRound(confirmedFigures, modelLeads));
            assisted = { confirmed: answer.confirmed.length, leads: answer.leads.length };
          } catch (error) {
            console.error("[research] audit assist failed", { runId: current.id, error });
          }
        }
      }
      const questionOf = (id: string) => latestPlan.objectives.find((objective) => objective.id === id)?.question ?? id;
      const auditLines = renderGapAudit(audit.entries, questionOf);
      const reviewInput: ReviewRoundInput = {
        userId: current.userId,
        goal: current.goal,
        brief: researchBriefText(latestPlan),
        constraints: latestPlan.constraints,
        objectives: latestPlan.objectives,
        findings,
        workerReports: reports,
        round,
        roundsLeft: totalRounds - round,
        pagesLeft: Math.max(0, pageCeiling - shared.pagesRead),
        previous: latestPlan.rounds?.[latestPlan.rounds.length - 1]?.review,
        ...(auditLines.length ? { audit: auditLines } : {}),
        ...(leads.length ? { leads: leads.map((lead) => `[${lead.objectiveId}] ${lead.query} (${lead.signal})`) } : {}),
        ...(latestPlan.today ? { today: latestPlan.today } : {}),
        ...(latestPlan.envelope?.leadModel ? { leadModelId: latestPlan.envelope.leadModel } : {}),
        signal,
      };
      const leadAffordable =
        !deps.modelRates?.lead || (await affordable(current, reviewEstimateMicroUsd(deps.modelRates.lead)));
      let review: ReviewRoundOutput;
      try {
        review =
          deps.reviewRound && leadAffordable
            ? await beat(() => deps.reviewRound!(reviewInput), heartbeat)
            : fallbackReview(reviewInput);
      } catch (error) {
        console.error("[research] round review failed", { runId: current.id, error });
        review = fallbackReview(reviewInput);
      }
      await bill(current, review.costMicroUsd, "review");

      // Contradictions the lead named become conflicts the report must address.
      const conflicts: ResearchConflict[] = [
        ...(latestPlan.conflicts ?? []),
        ...review.contradictions.map((item, i) => ({
          id: `lead-r${round}-${i + 1}`,
          kind: "contradictory_evidence" as const,
          ...(item.objectiveId ? { objectiveId: item.objectiveId } : {}),
          sourceIds: item.sourceIds,
          description: item.description,
          severity: "medium" as const,
          resolved: false,
        })),
      ];
      for (const item of review.contradictions) {
        await append(current.id, current.userId, [
          { kind: "conflict_found", payload: { kind: "contradictory_evidence", description: item.description, sourceIds: item.sourceIds, round } },
        ]);
      }

      const objectives = latestPlan.objectives.map((objective) => {
        const score = review.coverage[objective.id] ?? 0;
        return {
          ...objective,
          status: score >= COVERAGE_TARGET ? ("covered" as const) : score > 0 ? ("partially_covered" as const) : objective.status,
        };
      });
      const openQuestions: string[] = [];
      const seenQuestions = new Set<string>();
      for (const report of reports) {
        for (const question of report.openQuestions) {
          const key = question.toLowerCase();
          if (seenQuestions.has(key)) continue;
          seenQuestions.add(key);
          openQuestions.push(question);
        }
      }
      /*
       * The next round's briefs: the lead's gaps, each carrying the leads and
       * audit gaps for its vector, plus one lead-chasing brief for every vector
       * whose findings opened a lead the lead did not brief. And RULE 0.3: a
       * first round the lead called sufficient still gets a second when the
       * envelope has one and there is something concrete to chase.
       */
      const pagesLeft = Math.max(0, pageCeiling - shared.pagesRead);
      const leadsFor = (objectiveId: string) => leads.filter((lead) => lead.objectiveId === objectiveId).map((lead) => lead.query);
      const auditFor = (objectiveId: string) => {
        const entry = audit.entries.find((item) => item.objectiveId === objectiveId);
        if (!entry) return "";
        return [
          entry.missingFigures.length ? `Figures still missing: ${entry.missingFigures.join("; ")}.` : "",
          entry.conflicts.length ? `Sources disagree — reconcile against the official changelog or documentation: ${entry.conflicts.map((c) => c.description).join(" | ")}.` : "",
          entry.stale.length ? `These figures rest on old or undated pages; confirm the current value and its effective date: ${entry.stale.join(" | ")}.` : "",
          entry.unverified.length ? `Still unverified: ${entry.unverified.join("; ")}.` : "",
        ]
          .filter(Boolean)
          .join(" ");
      };
      const withLeads = (objectiveId: string, text: string) => {
        const own = leadsFor(objectiveId);
        return [text, own.length ? `Micro-queries opened by the last round's findings — run these first: ${own.join("; ")}.` : "", auditFor(objectiveId)]
          .filter(Boolean)
          .join(" ")
          .slice(0, 1_200);
      };
      const leadsContinue = review.decision === "continue" && review.gaps.length > 0;
      const auditGapObjectives = audit.entries
        .filter((entry) => entry.missingFigures.length || entry.conflicts.length || entry.stale.length)
        .map((entry) => entry.objectiveId);
      const forcedRound =
        !leadsContinue &&
        round < Math.min(MIN_RESEARCH_ROUNDS, totalRounds) &&
        pagesLeft > 0 &&
        !latestPlan.finishRequestedAt &&
        (leads.length > 0 || auditGapObjectives.length > 0);
      const nextGaps: ReviewRoundOutput["gaps"] = leadsContinue
        ? review.gaps.map((gap) => ({ ...gap, whatToFind: withLeads(gap.objectiveId, gap.whatToFind) }))
        : [];
      if (leadsContinue || forcedRound) {
        const briefed = new Set(nextGaps.map((gap) => gap.objectiveId));
        const chase = [...new Set([...leads.map((lead) => lead.objectiveId), ...(forcedRound ? auditGapObjectives : [])])];
        for (const objectiveId of chase) {
          if (briefed.has(objectiveId) || !latestPlan.objectives.some((objective) => objective.id === objectiveId)) continue;
          briefed.add(objectiveId);
          const own = leadsFor(objectiveId);
          nextGaps.push({
            objectiveId,
            reason: own.length
              ? `Follow the leads the last round uncovered: ${own.join("; ")}.`
              : `Close the audit's gaps: ${auditFor(objectiveId) || "missing figures"}`.slice(0, 400),
            whatToFind: withLeads(
              objectiveId,
              "Chase what the last round uncovered: open the primary pages these searches surface and record exact figures, versions and effective dates."
            ),
            boundaries: "Do not re-establish what the last round already recorded; only chase these leads and the figures still missing.",
          });
        }
      }
      const continuing = nextGaps.length > 0 && (leadsContinue || forcedRound);
      const recordedDecision: ReviewRoundOutput["decision"] = continuing ? "continue" : "synthesize";
      const recordedReason = forcedRound && continuing
        ? `${review.reason} A second round follows the ${leads.length} lead${leads.length === 1 ? "" : "s"} and ${auditGapObjectives.length} audit gap${auditGapObjectives.length === 1 ? "" : "s"} the first round surfaced.`.trim()
        : review.reason;

      const recorded: ResearchRound = {
        round,
        delegations,
        pagesRead: shared.pagesRead - readNow,
        toolCalls: roundCalls || shared.toolCalls,
        tokens: roundTokens,
        claims: roundFindings.length,
        newClaims,
        startedAt: roundStartedAt,
        finishedAt: deps.now().toISOString(),
        review: {
          coverage: review.coverage,
          // What the NEXT round was briefed on — leads and forced rounds
          // included — so a resumed run rebuilds the same briefs.
          gaps: (continuing ? nextGaps : review.gaps).map((gap) => ({ objectiveId: gap.objectiveId, reason: gap.reason })),
          contradictions: review.contradictions.length,
          decision: recordedDecision,
          reason: recordedReason,
        },
        ...(openQuestions.length ? { openQuestions: openQuestions.slice(0, MAX_ROUND_OPEN_QUESTIONS) } : {}),
        ...(leads.length ? { leads: leads.map((lead) => lead.query).slice(0, MAX_ROUND_OPEN_QUESTIONS) } : {}),
      };
      const rounds = [...(latestPlan.rounds ?? []).filter((item) => item.round !== round), recorded];
      const workerQueries = [...(latestPlan.workerQueries ?? []), ...shared.queries].slice(-MAX_WORKER_QUERIES);
      const saved = await store.savePlan({
        runId: current.id,
        userId: current.userId,
        plan: {
          ...latestPlan,
          objectives,
          conflicts,
          rounds,
          ...(workerQueries.length ? { workerQueries } : {}),
          gapAudit: {
            at: deps.now().toISOString(),
            pass: (latestPlan.gapAudit?.pass ?? 0) + 1,
            entries: audit.entries,
            queries: audit.queries,
            ...(confirmedFigures.length ? { confirmed: confirmedFigures } : {}),
          },
        },
      });
      current = saved ?? current;

      await append(current.id, current.userId, [
        {
          kind: "round_reviewed",
          payload: {
            round,
            decision: recordedDecision,
            reason: recordedReason,
            coverage: review.coverage,
            gaps: (continuing ? nextGaps : review.gaps).map((gap) => ({ objectiveId: gap.objectiveId, reason: gap.reason })),
            contradictions: review.contradictions.length,
            claims: roundFindings.length,
            newClaims,
            ...(leads.length ? { leads: leads.map((lead) => ({ objectiveId: lead.objectiveId, query: lead.query, signal: lead.signal })) } : {}),
            ...(audit.hasGaps ? { audit: auditLines.slice(0, 8) } : {}),
            ...(assisted ? { assisted } : {}),
          },
        },
        {
          kind: "budget_checkpoint",
          payload: {
            round,
            pagesRead: shared.pagesRead,
            pageCeiling,
            toolCalls: roundCalls || shared.toolCalls,
            tokens: workerTokens.used,
            tokenCeiling: budget.tokens,
            elapsedMs: investigationElapsedMs(parsePlan(current.plan), deps.now()),
            wallClockMs: budget.wallClockMs,
            spentMicroUsd: current.costMicroUsd.toString(),
            budgetMicroUsd: current.budgetMicroUsd === null ? null : current.budgetMicroUsd.toString(),
          },
        },
      ]);

      if (!continuing) break;
      // Saturation is the lead's call, but the arithmetic backstops it: a
      // round that added almost nothing new is not worth paying for again.
      if (round > 1 && findings.length > 0 && newClaims < findings.length * SATURATION_NEW_CLAIM_SHARE) break;
      delegations = nextGaps.map((gap, i) => {
        const objective = objectives.find((item) => item.id === gap.objectiveId);
        return {
          workerId: `w${round + 1}-${i + 1}`,
          objectiveId: gap.objectiveId,
          objective: objective?.question ?? gap.objectiveId,
          whatToFind: gap.whatToFind,
          boundaries: gap.boundaries,
        };
      });
      round += 1;
    }
    const finished = (await store.loadRun(current.id, current.userId)) ?? current;
    // The workers' pages can be reprints of each other just as the sweep's
    // could; mark them before the corpus is judged and written.
    return { run: ranARound ? await markSyndicatedCopies(finished) : finished };
  };

  /**
   * COVERAGE: persist the evidence matrix and schedule a bounded follow-up.
   *
   * This is intentionally separate from the post-synthesis citation audit. A
   * plan can have plenty of sources and still miss one of its questions; the
   * controller must discover that while there is still budget to search.
   */

  return { initialDelegations, fallbackReview, bindWorkerTools, doWorkerRounds };
}
