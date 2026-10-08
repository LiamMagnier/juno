/*
 * Research engine stage — corpus: search, browse, link-hop and read — the sweep that turns queries into stored snapshots.
 * Moved verbatim out of createResearchEngine (engine.ts).
 */
import {
  DEEPEN_BELOW_CHARS,
  HOP_MIN_OVERLAP,
  HOP_PAGE_SHARE,
  MAX_DEEPENED_SOURCES,
  MAX_HOP_SOURCES,
  MAX_READ_SOURCES,
  MAX_SOURCES,
  READ_CONCURRENCY,
  READ_ESTIMATE_MICRO_USD,
  SEARCH_CONCURRENCY,
  SEARCH_ESTIMATE_MICRO_USD,
  SEED_PAGE_SHARE,
  SNAPSHOT_CHARS,
} from "./limits";
import {
  MAX_PINNED_SOURCES,
  MAX_UNREADABLE_SOURCES,
  fallbackResearchQueries,
  parsePlan,
  planBudget,
} from "@/lib/research/domain";
import {
  type ResearchPageLink,
  type ResearchPageResult,
  type ResearchRunRow,
  type ResearchSourceRow,
  type StepOutcome,
  pageSkipMessage,
  pageWasSkipped,
  permanentSkip,
} from "./types";
import { canonicalUrl } from "@/lib/search/url-safety";
import { classifiedSourceType, waves } from "./coverage";
import { contentTokens, hostOfUrl, scoreSource, sourceTypeOf } from "@/lib/research/claim-analysis";
import { splitPassages } from "./writer-text";
import { duplicateOf } from "@/lib/research/query-dedupe";
import { assessSource, isAggregator } from "@/lib/research/source-policy";
import type { EngineContext } from "./context";
import { enabledOptions, isPrivateSourceUrl, webEnabled } from "@/lib/research/private-sources";
import type { createWorkerStage } from "./workers";

/** Questions one investigation pass asks of the person's own sources. */
export const MAX_PRIVATE_QUESTIONS = 9;
/** Private passages one pass stores, over every enabled source together. */
export const MAX_PRIVATE_HITS = 24;

/** Below this many better unread candidates, a sweep pass back-fills with aggregators. */
export const AGGREGATOR_BACKFILL_BELOW = 3;

export function createCorpusStage(ctx: EngineContext, stages: Pick<ReturnType<typeof createWorkerStage>, "doWorkerRounds">) {
  const { deps, store, append, fetchPage, markSyndicatedCopies, advance, affordable, affordableCount, stopForBudget, bill, webSearch, forgetFingerprint } = ctx;
  const { doWorkerRounds } = stages;
  const doSearching = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    // The reader switched the web off at the gate: this run reads only their own sources.
    if (!webEnabled(plan.sources)) return { kind: "advanced", state: "investigating" };
    const queries = plan.queries.length ? plan.queries : fallbackResearchQueries(run.goal, plan.effort);
    const resultsPerQuery = planBudget(plan).resultsPerQuery;
    const plannedIssued = new Set(plan.issuedQueries ?? []);
    // Legacy runs did not persist issuedQueries. Treat their first resumed
    // search as unissued so a schema rollout cannot silently skip gathering.
    const unissued = plan.issuedQueries === undefined ? queries : queries.filter((query) => !plannedIssued.has(query));
    /*
     * Protocol Stage 3: a follow-up that is a near-paraphrase of a search the
     * run already made (the sweep's or a worker's) is skipped rather than paid
     * for again — it would return the same page of results. Exact repeats were
     * already filtered above; this catches reorderings and padding.
     */
    const ran = [...plannedIssued, ...(plan.workerQueries ?? [])];
    // Except the F5 widening: those ARE rewordings of searches that found
    // nothing, and an empty corpus is the one case where that is the point.
    const widening =
      plannedIssued.size > 0 &&
      !!plan.broadenedAt &&
      (store.listSourceUrls ? await store.listSourceUrls(run.id, run.userId) : await store.listSources(run.id, run.userId)).length === 0;
    const pending: string[] = [];
    for (const query of unissued) {
      if (plannedIssued.size > 0 && !widening && (duplicateOf(query, ran) || duplicateOf(query, pending))) continue;
      pending.push(query);
    }
    let current = run;
    const issued = new Set(plannedIssued);
    // The provider roster is a property of the deployment, not of the query, so
    // it rides the FIRST query of the sweep only. Repeating it on every event
    // would be the same fact a dozen times in a timeline a person has to read.
    let providersAnnounced = plannedIssued.size > 0;

    /*
     * SEARCH dispatches in waves, the same shape READ uses, and the two
     * properties that used to justify keeping it serial are why the wave is
     * sized the way it is rather than partitioned up front.
     *
     * `waves()` is deliberately NOT used here. It cuts a fixed partition, so a
     * ceiling that can only afford one query of a four-wide slice would drop
     * the other three on the floor and stop — which is how a 17k budget that
     * paid for two queries serially came back paying for one. The cursor below
     * re-asks `affordableCount` from the LIVE spend on every pass, so the wave
     * is exactly as wide as the projection can cover and the queries it could
     * not take are reconsidered against the money the last wave actually cost.
     * That is what keeps "the ceiling stops the sweep midway" true query for
     * query, not merely wave for wave.
     *
     * Cancellation moves from a per-query boundary to a per-wave one, and that
     * is the honest cost of parallelism: four calls handed to Promise.all are
     * four calls paid for whatever the next check would have said. What still
     * holds — and is what the user is actually owed — is that a cancel stops
     * the run before it pays for the NEXT wave, because the state re-read at
     * the top of the loop happens before anything is dispatched.
     */
    let cursor = 0;
    while (cursor < pending.length) {
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "investigating") return { kind: "raced" };
      current = fresh;
      // A long sweep can outlast the worker lease on its own, and a lease that
      // expires mid-step is a second worker adopting a run that is still being
      // driven — the same queries, billed twice.
      await heartbeat?.();

      // One budget decision for the whole wave, taken BEFORE anything goes out.
      // Checking per query and then firing four in parallel is not a ceiling:
      // requests already in flight cannot be recalled.
      const allowed = await affordableCount(
        current,
        SEARCH_ESTIMATE_MICRO_USD,
        Math.min(SEARCH_CONCURRENCY, pending.length - cursor)
      );
      if (allowed === 0) return stopForBudget(current, SEARCH_ESTIMATE_MICRO_USD);
      const wave = pending.slice(cursor, cursor + allowed);
      cursor += allowed;

      const found = await Promise.all(
        wave.map(async (query) => ({
          query,
          // Through the context's guard: the web may be off for this run, and
          // nothing from the person's own sources may reach a search vendor.
          searched: await webSearch(current, query, resultsPerQuery, signal),
        }))
      );

      // Persisting is sequential on purpose — the same reason READ gives. The
      // parallel part is the network; the ledger, the event seq and the plan
      // row are per-run serial resources, and interleaving writes to them buys
      // nothing and races.
      for (const { query, searched } of found) {
        if (!searched.ok) {
          // Withheld, not run: recorded so a resumed pass does not try again,
          // and said on the timeline so a thin web corpus has its reason.
          if (searched.reason === "private_only") {
            await append(run.id, run.userId, [
              { kind: "query_issued", payload: { query, results: 0, withheld: "private" } },
            ]);
          }
          issued.add(query);
          const latestSkip = (await store.loadRun(current.id, current.userId)) ?? current;
          await store.savePlan({
            runId: current.id,
            userId: current.userId,
            plan: { ...parsePlan(latestSkip.plan), issuedQueries: [...issued] },
          });
          continue;
        }
        const result = searched.result;
        await bill(current, result.costMicroUsd, "search");
        await append(run.id, run.userId, [
          {
            kind: "query_issued",
            payload: {
              query: searched.sent,
              results: result.hits.length,
              ...(searched.sanitised ? { sanitised: true } : {}),
              ...(result.engines?.length ? { engines: result.engines } : {}),
              ...(!providersAnnounced && result.providers ? { providers: result.providers } : {}),
            },
          },
        ]);
        providersAnnounced = true;
        for (const hit of result.hits.slice(0, MAX_SOURCES)) {
          // Search backends that return the page body in the same call (Tavily's
          // `include_raw_content`) have already been paid for it. Storing the
          // snapshot here is what stops READ fetching the identical page a second
          // time and billing the run twice for one document.
          const body = hit.rawContent?.trim() ? hit.rawContent.slice(0, SNAPSHOT_CHARS) : null;
          const score = scoreSource({
            url: hit.url,
            title: hit.title,
            text: body ?? hit.snippet,
            publishedAt: hit.publishedAt,
          });
          const sourceType = sourceTypeOf({ url: hit.url, text: body ?? hit.snippet, authority: score.authority });
          const stored = await store.upsertSource({
            runId: run.id,
            userId: run.userId,
            url: hit.url,
            title: hit.title,
            publishedAt: hit.publishedAt,
            ...(body ? { snapshot: body, contentHash: deps.hash(body) } : {}),
            ...score,
            sourceType,
          });
          if (stored.created) {
            await append(run.id, run.userId, [
              { kind: "source_found", payload: { url: hit.url, title: hit.title, query } },
            ]);
          }
        }
        issued.add(query);
        // Per query rather than once per wave: a worker killed between two
        // members of a wave has already been billed for the ones behind it, and
        // a resumed run that re-issued them would pay the vendor twice for the
        // same results.
        const latest = (await store.loadRun(current.id, current.userId)) ?? current;
        const latestPlan = parsePlan(latest.plan);
        await store.savePlan({
          runId: current.id,
          userId: current.userId,
          plan: { ...latestPlan, issuedQueries: [...issued] },
        });
      }
    }
    // Searching, pinned-source ingestion and reading are one investigation
    // round now. The coordinator below calls the remaining two legs before it
    // hands the corpus to the lead for review.
    return { kind: "advanced", state: "investigating" };
  };

  /**
   * OWN SOURCES: the person's files, project, library, memory and connectors.
   *
   * Runs before the web sweep in every investigation pass, so the private
   * fingerprint exists before any web query is sent (the sweep's and the
   * workers' queries are cleaned against it). Each question is searched once
   * per run: `plan.sources.issued` is the ledger, so a follow-up pass searches
   * only questions it has not asked before. Only enabled, offered options are
   * handed to the retriever, and a failure is a timeline line, never the end
   * of the run — the web half still answers.
   *
   * Every hit becomes an ordinary source row — snapshot, hash, passages — so
   * the workers can quote it, the writer can cite it and the citation audit
   * can check it, exactly as for a web page. Its `private.invalid` URL is what
   * marks it, everywhere, as the person's own.
   */
  const doPrivateSources = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    const selection = plan.sources;
    const options = enabledOptions(selection);
    if (!deps.searchPrivate || !selection || options.length === 0) return { kind: "advanced", state: "investigating" };
    const asked = new Set(selection.issued ?? []);
    const questions = [run.goal, ...plan.objectives.map((objective) => objective.question)]
      .map((question) => question.replace(/\s+/g, " ").trim())
      .filter((question, i, all) => question && !asked.has(question) && all.indexOf(question) === i)
      .slice(0, MAX_PRIVATE_QUESTIONS);
    if (questions.length === 0) return { kind: "advanced", state: "investigating" };
    await heartbeat?.();

    let found: Awaited<ReturnType<NonNullable<typeof deps.searchPrivate>>>;
    try {
      found = await deps.searchPrivate({
        userId: run.userId,
        runId: run.id,
        conversationId: run.conversationId,
        options,
        questions,
        selection,
        timeZone: plan.timeZone ?? null,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) return { kind: "raced" };
      console.error("[research] private source search failed", { runId: run.id, error });
      await append(run.id, run.userId, [
        { kind: "error", payload: { scope: "private_sources", recoverable: true, message: "Your own sources could not be searched this time." } },
      ]);
      found = { hits: [], skipped: [] };
    }

    const fresh = await store.loadRun(run.id, run.userId);
    if (!fresh || fresh.state !== "investigating") return { kind: "raced" };

    for (const skip of found.skipped) {
      await append(run.id, run.userId, [
        { kind: "error", payload: { scope: "private_source", key: skip.key, recoverable: true, message: skip.reason } },
      ]);
    }
    let read = 0;
    for (const hit of found.hits.slice(0, MAX_PRIVATE_HITS)) {
      // Belt and braces: the retriever's contract is `private.invalid` addresses
      // for enabled options only; anything else is dropped here.
      if (!isPrivateSourceUrl(hit.url) || !selection.enabled.includes(hit.optionKey)) continue;
      const text = hit.text.slice(0, SNAPSHOT_CHARS).trim();
      if (!text) continue;
      const stored = await store.upsertSource({
        runId: run.id,
        userId: run.userId,
        url: hit.url,
        title: hit.title,
        ...(hit.publishedAt ? { publishedAt: hit.publishedAt } : {}),
        contentHash: deps.hash(text),
        snapshot: text,
        // The person's own record: first-hand for whatever it says about
        // their own affairs, and chosen by them at the gate.
        authority: 1,
        freshness: 1,
        directness: 1,
        independence: 1,
        composite: 1,
        sourceType: "primary",
      });
      await store.savePassages({ userId: run.userId, sourceId: stored.id, passages: splitPassages(text) });
      read += 1;
      await append(run.id, run.userId, [
        ...(stored.created ? [{ kind: "source_found" as const, payload: { url: hit.url, title: hit.title, private: hit.kind } }] : []),
        { kind: "source_read", payload: { url: hit.url, title: hit.title, private: hit.kind } },
      ]);
    }

    const latest = (await store.loadRun(run.id, run.userId)) ?? fresh;
    const latestPlan = parsePlan(latest.plan);
    if (latestPlan.sources) {
      await store.savePlan({
        runId: run.id,
        userId: run.userId,
        plan: { ...latestPlan, sources: { ...latestPlan.sources, issued: [...(latestPlan.sources.issued ?? []), ...questions] } },
      });
    }
    if (read > 0) forgetFingerprint(run.id);
    return { kind: "advanced", state: "investigating" };
  };

  /**
   * BROWSE: the user's pinned sources.
   *
   * Separate from SEARCH because a pinned source is not a search result — it
   * is an instruction, and it must be read whether or not any query surfaced
   * it. This is also the stage steering lands in, which is why a run steered
   * with a new URL resumes here rather than re-planning.
   */
  const doBrowsing = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    let current = run;
    for (const url of plan.pinnedSources.slice(0, Math.min(MAX_PINNED_SOURCES, planBudget(plan).pages))) {
      if (!(await affordable(current, READ_ESTIMATE_MICRO_USD))) {
        return stopForBudget(current, READ_ESTIMATE_MICRO_USD);
      }
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "investigating") return { kind: "raced" };
      current = fresh;
      await heartbeat?.();

      const page = await fetchPage(run.userId, url, signal);
      if (!page || pageWasSkipped(page)) {
        // A pinned source that will not load is worth saying out loud: the user
        // chose it, and silently proceeding without it produces a report that
        // looks like it considered something it never saw. The reason matters
        // as much as the fact — "that URL is a PDF and this build cannot read
        // one" is actionable; "could not be read" is not.
        await append(run.id, run.userId, [
          {
            kind: "error",
            payload: {
              scope: "pinned_source",
              url,
              message: page ? pageSkipMessage(page) : "Could not be read.",
              ...(page ? { reason: page.skipped } : {}),
            },
          },
        ]);
        continue;
      }
      await bill(current, page.costMicroUsd, "fetch");
      const text = page.text.slice(0, SNAPSHOT_CHARS);
      const score = scoreSource({ url, title: page.title, text, publishedAt: page.publishedAt ?? null });
      const stored = await store.upsertSource({
        runId: run.id,
        userId: run.userId,
        url,
        title: page.title || url,
        // Only when the page carries one: a null here would clear a date a
        // search result had already supplied for the same row.
        ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
        contentHash: deps.hash(text),
        snapshot: text,
        // Pinned by the user, so it outranks anything the search backend
        // surfaced; the number is recorded so a reader can see why.
        authority: 1,
        freshness: score.freshness,
        directness: score.directness,
        independence: score.independence,
        composite: score.composite,
        sourceType: sourceTypeOf({ url, text, authority: 1 }),
      });
      await append(run.id, run.userId, [
        { kind: "source_read", payload: { url, title: page.title, pinned: true } },
      ]);
      await store.savePassages({
        userId: run.userId,
        sourceId: stored.id,
        passages: splitPassages(text),
      });
    }
    return { kind: "advanced", state: "investigating" };
  };

  /**
   * HOP: follow the links a page it just read pointed at.
   *
   * Every fetched page was already being parsed into markdown with its `<a>`
   * tags turned into `[text](url)` — and then the links were dropped on the
   * floor. Nothing in the run had ever followed one, which meant the corpus was
   * strictly whatever a search index happened to rank: the primary source an
   * article cites, the specification a summary links to, the dataset behind a
   * chart, were all one click away and none of them reachable.
   *
   * Three things keep this from becoming a crawler. It runs ONE hop, from pages
   * this stage opened, never from pages discovered by a previous hop. Candidates
   * must earn it — the anchor text has to be about an objective, and an off-host
   * link scores higher because a link to another page of the same site is the
   * one least likely to add an independent witness. And it is bounded by
   * `MAX_HOP_SOURCES`, by the run's remaining source budget, and by money: a hop
   * the budget cannot pay for is skipped silently rather than ending the run,
   * because unlike a source with no text at all, this was always optional.
   */
  const doLinkHop = async (
    run: ResearchRunRow,
    existing: ReadonlyArray<{ source: ResearchSourceRow }>,
    discovered: ReadonlyArray<{ from: string; link: ResearchPageLink }>,
    hopPages: number,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<{ run: ResearchRunRow; outcome?: StepOutcome; added: number; fetched: number; passages: number }> => {
    /*
     * The hop's own allowance, handed in by READ out of the seed share. It
     * used to be computed as the page budget minus the number of source ROWS,
     * read or not — and every tier discovers more rows than it has pages, so
     * the room was negative on every production run and this stage returned
     * before ranking a single link. `MAX_SOURCES` no longer figures here
     * either: it bounds the synthesis corpus, not fetches, and `known` below
     * already dedupes against the rows the run holds.
     */
    const room = Math.min(MAX_HOP_SOURCES, Math.max(0, Math.floor(hopPages)));
    if (discovered.length === 0 || room <= 0) return { run, added: 0, fetched: 0, passages: 0 };

    const plan = parsePlan(run.plan);
    const wanted = contentTokens(
      [...plan.objectives.map((objective) => objective.question), ...plan.queries].join(" ")
    );
    if (wanted.size === 0) return { run, added: 0, fetched: 0, passages: 0 };

    const known = new Set(existing.map(({ source }) => canonicalUrl(source.url)));
    const ranked: Array<{ href: string; text: string; from: string; score: number }> = [];
    for (const { from, link } of discovered) {
      const key = canonicalUrl(link.href);
      if (known.has(key)) continue;
      known.add(key);
      // The path segments count as anchor text: plenty of citation links are
      // bare URLs or read "here", and `/reports/2024-emissions-methodology` is
      // the only thing about them that says what they are.
      let path = "";
      try {
        path = decodeURIComponent(new URL(link.href).pathname).replace(/[-_/.]+/g, " ");
      } catch {
        continue;
      }
      const anchorTokens = contentTokens(`${link.text} ${path}`);
      if (anchorTokens.size < 2) continue;
      // The source policy (protocol Stage 2): a link out to a roundup is not
      // worth a fetch, and a link to the record a page cites is the point.
      const policy = assessSource({ url: link.href, title: link.text });
      if (policy.tier === "aggregator") continue;
      let matched = 0;
      for (const token of anchorTokens) if (wanted.has(token)) matched += 1;
      let score = matched / anchorTokens.size;
      if (hostOfUrl(link.href) !== hostOfUrl(from)) score += 0.15;
      if (policy.tier === "primary" || policy.tier === "official") score += 0.15;
      if (score < HOP_MIN_OVERLAP) continue;
      ranked.push({ href: link.href, text: link.text, from, score });
    }
    if (ranked.length === 0) return { run, added: 0, fetched: 0, passages: 0 };

    const targets = ranked.sort((a, b) => b.score - a.score).slice(0, room);
    let current = run;
    let added = 0;
    let fetched = 0;
    let passages = 0;

    for (const wave of waves(targets, READ_CONCURRENCY)) {
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "investigating") return { run: current, outcome: { kind: "raced" }, added, fetched, passages };
      current = fresh;
      await heartbeat?.();

      const allowed = await affordableCount(current, READ_ESTIMATE_MICRO_USD, wave.length);
      if (allowed === 0) break;

      const dispatched = wave.slice(0, allowed);
      const pages = await Promise.all(
        dispatched.map(async (target) => ({
          target,
          page: await fetchPage(run.userId, target.href, signal),
        }))
      );

      for (const { target, page } of pages) {
        // A link that will not load is not worth an event: unlike a pinned
        // source or a ranked search result, nobody asked for this one and a
        // timeline full of "a link failed" is noise around the real findings.
        if (!page || pageWasSkipped(page)) continue;
        await bill(current, page.costMicroUsd, "fetch");
        const text = page.text.slice(0, SNAPSHOT_CHARS);
        if (!text) continue;
        const score = scoreSource({ url: target.href, title: page.title || target.text, text, publishedAt: page.publishedAt ?? null });
        const stored = await store.upsertSource({
          runId: run.id,
          userId: run.userId,
          url: target.href,
          title: page.title || target.text || target.href,
          ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
          contentHash: deps.hash(text),
          snapshot: text,
          ...score,
          sourceType: sourceTypeOf({ url: target.href, text, authority: score.authority }),
        });
        fetched += 1;
        if (stored.created) added += 1;
        passages += await store.savePassages({
          userId: run.userId,
          sourceId: stored.id,
          passages: splitPassages(text),
        });
        await append(run.id, run.userId, [
          {
            kind: "source_found",
            payload: { url: target.href, title: page.title, via: target.from, hop: 1 },
          },
          { kind: "source_read", payload: { url: target.href, title: page.title, hop: 1 } },
        ]);
      }

      if (allowed < wave.length) break;
    }

    return { run: current, added, fetched, passages };
  };

  /**
   * READ: fetch whatever has no stored body, then cut every body into passages.
   *
   * Passages are what a claim gets cited against, so they are extracted here
   * rather than at the moment the text arrived — a source whose snapshot came
   * back with the search results has never been through this stage, and a
   * corpus where half the sources have passages and half do not is a report
   * that can only cite half of what it read.
   */
  const doReading = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const sources = (await store.listSources(run.id, run.userId))
      .map((source) => {
        const score = scoreSource({
          url: source.url,
          title: source.title,
          text: source.snapshot ?? "",
          publishedAt: source.publishedAt,
        });
        return {
          source,
          sourceType: classifiedSourceType(source),
          score: {
            authority: source.authority ?? score.authority,
            freshness: source.freshness ?? score.freshness,
            directness: source.directness ?? score.directness,
            independence: source.independence ?? score.independence,
            composite: source.composite ?? score.composite,
          },
        };
      })
      .sort(
        (a, b) =>
          b.score.composite - a.score.composite ||
          b.score.authority - a.score.authority ||
          a.source.fetchedAt.getTime() - b.source.fetchedAt.getTime()
      );
    await append(run.id, run.userId, [
      {
        kind: "source_ranked",
        payload: {
          order: sources.slice(0, MAX_READ_SOURCES).map(({ source, sourceType, score }) => ({
            sourceId: source.id,
            host: hostOfUrl(source.url),
            sourceType,
            ...score,
          })),
        },
      },
    ]);
    let current = run;
    let fetched = 0;
    let passages = 0;
    /** Outbound links from pages this stage actually opened, for the hop below. */
    const discovered: Array<{ from: string; link: ResearchPageLink }> = [];

    const plan = parsePlan(run.plan);
    const budget = planBudget(plan);
    // A quarter of the tier's pages, not all of them — see SEED_PAGE_SHARE.
    // URLs an earlier pass found dead for good are skipped, so a follow-up
    // reads the next ranked source instead of paying their timeouts again.
    const seedPages = Math.ceil(budget.pages * SEED_PAGE_SHARE);
    const unreadable = new Set((plan.unreadable ?? []).map((url) => canonicalUrl(url)));
    const live = sources.filter(({ source }) => !unreadable.has(canonicalUrl(source.url)));
    /*
     * Which sources this pass opens (protocol Stages 2 and 3).
     *
     * The pass used to take the top `seedPages` sources by score, read or
     * not. On the first pass that is the same thing; on a FOLLOW-UP pass — the
     * gap audit's targeted searches — the top of the ranking is the pages the
     * run already read, so the new sources the follow-up searched for were
     * never opened and the follow-up bought nothing but search fees. Fetch
     * slots now go to sources that NEED a fetch (no body, or only a search
     * preview), best first; and aggregators/affiliate roundups wait until no
     * better unread candidate is left. The slots are also held under what is
     * left of the run's page ceiling, which the follow-up passes used to
     * ignore.
     */
    const pagesSoFar = (plan.seedPagesRead ?? 0) + (plan.rounds ?? []).reduce((n, item) => n + item.pagesRead, 0);
    const fetchSlots = Math.max(0, Math.min(seedPages, MAX_READ_SOURCES, budget.pages - pagesSoFar));
    // A page this sweep already fetched is read, however short it is: a short
    // pricing page fetched on the first pass is not re-fetched on every pass.
    const fetchedBefore = new Set((plan.sweepFetched ?? []).map((url) => canonicalUrl(url)));
    // A private source is never fetched: its text is what the owner-scoped
    // retrieval stored, however short (a calendar event is one line).
    const needsFetch = (source: ResearchSourceRow) =>
      !isPrivateSourceUrl(source.url) &&
      (source.snapshot ?? "").length < DEEPEN_BELOW_CHARS &&
      !fetchedBefore.has(canonicalUrl(source.url));
    const unread = live.filter(({ source }) => needsFetch(source));
    const aggregator = ({ source }: (typeof live)[number]) => isAggregator({ url: source.url, title: source.title, text: source.snapshot });
    const better = unread.filter((item) => !aggregator(item));
    // Aggregators and affiliate roundups are not read at all while the run
    // has better sources — read or waiting to be; they only back-fill a thin
    // corpus (a niche topic with few records of its own).
    const betterHeld = live.filter((item) => !aggregator(item) && (!!item.source.snapshot || needsFetch(item.source))).length;
    const fetchFirst = (betterHeld >= AGGREGATOR_BACKFILL_BELOW ? better : [...better, ...unread.filter(aggregator)]).slice(0, fetchSlots);
    const passagesOnly = live.filter(({ source }) => !needsFetch(source)).slice(0, Math.min(MAX_READ_SOURCES, seedPages));
    const chosen = new Set([...fetchFirst, ...passagesOnly]);
    const targets = live.filter((item) => chosen.has(item));
    /** URLs this pass found dead for good, appended to the plan below. */
    const dead: string[] = [];
    /** URLs this pass fetched, so a later pass does not fetch them again. */
    const fetchedUrls: string[] = [];
    for (const wave of waves(targets, READ_CONCURRENCY)) {
      const fresh = await store.loadRun(current.id, current.userId);
      if (!fresh || fresh.state !== "investigating") return { kind: "raced" };
      current = fresh;
      // A wave of eight fetches at a 25s timeout each can outlive the two-minute
      // worker lease on its own; without this the sweeper adopts a run that is
      // still being driven and re-fetches every page against the same budget.
      await heartbeat?.();

      /**
       * DEEPEN: open a page the search engine only skimmed.
       *
       * A search backend that returns page text (Tavily's `include_raw_content`,
       * Exa's `text`) has its result stored as the snapshot during SEARCH, and
       * this stage then treated any snapshot at all as "already read" and never
       * fetched the page. That is the difference between a search result and a
       * source: those payloads are frequently a few hundred characters of lede,
       * and the whole run — the corpus, the passages, every citation checked
       * against them — was built on the preview rather than the document.
       *
       * It is the same move as the `open_page` step that follows `search` in
       * every comparable agent loop, and it is deliberately RANKED rather than
       * universal: only sources good enough to be worth the fetch, and only when
       * what we hold is too thin to be the real page. A run whose budget runs out
       * mid-deepening still has the snippets and still answers.
       */
      const jobs = wave.map(({ source }) => {
        const text = source.snapshot ?? "";
        return {
          source,
          text,
          required: text.length === 0 && !fetchedBefore.has(canonicalUrl(source.url)),
          deepen: text.length > 0 && text.length < DEEPEN_BELOW_CHARS && !fetchedBefore.has(canonicalUrl(source.url)),
        };
      });
      const required = jobs.filter((job) => job.required);
      const deepenSlots = Math.max(0, MAX_DEEPENED_SOURCES - fetched);
      const deepening = jobs.filter((job) => job.deepen).slice(0, deepenSlots);

      // One budget decision for the whole wave, taken BEFORE anything is
      // dispatched. Checking per fetch and then firing eight in parallel is not
      // a ceiling — the requests already in flight cannot be recalled. Required
      // fetches are served first: a source with no text at all is the
      // difference between a source and a link, while a deepen is an upgrade
      // the run can live without.
      const allowed = await affordableCount(
        current,
        READ_ESTIMATE_MICRO_USD,
        required.length + deepening.length
      );
      // Sequential reading stopped the run at the first required fetch it could
      // not project paying for. Preserve that exactly: pay for as many of this
      // wave's required fetches as the ceiling allows, then stop — rather than
      // skipping the rest of the wave and carrying on into the next one, which
      // would silently leave read-able sources unread with no receipt anywhere.
      const budgetShort = allowed < required.length;
      const dispatch = budgetShort
        ? required.slice(0, allowed)
        : [...required, ...deepening.slice(0, allowed - required.length)];
      const pages = new Map<string, ResearchPageResult | null>();
      await Promise.all(
        dispatch.map(async (job) => {
          pages.set(job.source.id, await fetchPage(run.userId, job.source.url, signal));
        })
      );

      // Persisting is sequential on purpose. The parallel part is the network;
      // the ledger, the event seq and the plan row are all per-run serial
      // resources, and interleaving writes to them buys nothing and races.
      for (const job of jobs) {
        let text = job.text;
        const page = pages.get(job.source.id) ?? null;

        if (job.required) {
          if (!page || pageWasSkipped(page)) {
            if (page) {
              await append(run.id, run.userId, [
                {
                  kind: "error",
                  payload: {
                    scope: "source",
                    url: job.source.url,
                    message: pageSkipMessage(page),
                    reason: page.skipped,
                  },
                },
              ]);
              if (permanentSkip(page)) dead.push(job.source.url);
            }
            continue;
          }
          await bill(current, page.costMicroUsd, "fetch");
          text = page.text.slice(0, SNAPSHOT_CHARS);
          const publishedAt = page.publishedAt ?? job.source.publishedAt;
          const score = scoreSource({ url: job.source.url, text, publishedAt });
          await store.upsertSource({
            runId: run.id,
            userId: run.userId,
            url: job.source.url,
            title: page.title || job.source.title,
            publishedAt,
            contentHash: deps.hash(text),
            snapshot: text,
            ...score,
            sourceType: sourceTypeOf({ url: job.source.url, text, authority: score.authority }),
          });
          fetched += 1;
          fetchedUrls.push(job.source.url);
          for (const link of page.links ?? []) discovered.push({ from: job.source.url, link });
          await append(run.id, run.userId, [
            { kind: "source_read", payload: { url: job.source.url, title: page.title } },
          ]);
        } else if (page && !pageWasSkipped(page) && page.text.length > text.length) {
          // Only take the deeper copy if it IS deeper; a paywall or a consent wall
          // returns a short body, and overwriting a usable snippet with it would
          // lose the only text this source ever had.
          await bill(current, page.costMicroUsd, "fetch");
          text = page.text.slice(0, SNAPSHOT_CHARS);
          const publishedAt = page.publishedAt ?? job.source.publishedAt;
          const score = scoreSource({ url: job.source.url, text, publishedAt });
          await store.upsertSource({
            runId: run.id,
            userId: run.userId,
            url: job.source.url,
            title: page.title || job.source.title,
            publishedAt,
            contentHash: deps.hash(text),
            snapshot: text,
            ...score,
            sourceType: sourceTypeOf({ url: job.source.url, text, authority: score.authority }),
          });
          fetched += 1;
          fetchedUrls.push(job.source.url);
          for (const link of page.links ?? []) discovered.push({ from: job.source.url, link });
          await append(run.id, run.userId, [
            { kind: "source_read", payload: { url: job.source.url, title: page.title, deepened: true } },
          ]);
        }

        passages += await store.savePassages({
          userId: run.userId,
          sourceId: job.source.id,
          passages: splitPassages(text),
        });
        await append(run.id, run.userId, [
          { kind: "source_read", payload: { url: job.source.url, title: job.source.title, ranked: true } },
        ]);
      }

      if (budgetShort) return stopForBudget(current, READ_ESTIMATE_MICRO_USD);
    }

    const hop = await doLinkHop(current, sources, discovered, Math.ceil(budget.pages * HOP_PAGE_SHARE), signal, heartbeat);
    if (hop.outcome) return hop.outcome;
    current = hop.run;
    fetched += hop.fetched;
    passages += hop.passages;

    // What this pass fetched goes on the plan — the rows cannot say which of
    // them cost a fetch — and so do the URLs it found dead for good.
    const latest = (await store.loadRun(current.id, current.userId)) ?? current;
    const latestPlan = parsePlan(latest.plan);
    const unreadableNow = [...(latestPlan.unreadable ?? []), ...dead];
    const saved = await store.savePlan({
      runId: current.id,
      userId: current.userId,
      plan: {
        ...latestPlan,
        seedPagesRead: (latestPlan.seedPagesRead ?? 0) + fetched,
        ...(fetchedUrls.length ? { sweepFetched: [...(latestPlan.sweepFetched ?? []), ...fetchedUrls].slice(-MAX_SOURCES) } : {}),
        ...(unreadableNow.length ? { unreadable: unreadableNow.slice(-MAX_UNREADABLE_SOURCES) } : {}),
      },
    });
    current = saved ?? latest;

    await append(run.id, run.userId, [
      {
        kind: "passages_extracted",
        payload: {
          fetched,
          passages,
          sourcesTotal: sources.length + hop.added,
          ...(hop.added > 0 ? { followedLinks: hop.added } : {}),
        },
      },
    ]);

    // Two reprints of one story must not satisfy "two independent sources"
    // before the team has even been briefed.
    current = await markSyndicatedCopies(current);

    // The sweep seeded the corpus; now the team goes to work on it.
    const agents = await doWorkerRounds(current, signal, heartbeat);
    if (agents.outcome) return agents.outcome;
    current = agents.run;

    const moved = await advance(current, "reviewing");
    return moved ? { kind: "advanced", state: "reviewing" } : { kind: "raced" };
  };

  // ── the agent rounds ────────────────────────────────────────────────────

  /**
   * The briefs for the first round: one worker per sub-question, and when the
   * tier affords more workers than there are sub-questions, the most important
   * ones get a second worker sent along a different axis — counter-evidence,
   * the latest developments, primary records — so two workers on one question
   * never read the same pages.
   */

  return { doPrivateSources, doSearching, doBrowsing, doLinkHop, doReading };
}
