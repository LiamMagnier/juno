/*
 * Research engine stage — writer: synthesise the report from the packed corpus, inside its timebox, with one smaller retry.
 * Moved verbatim out of createResearchEngine (engine.ts).
 */
import type { ResearchRunRow, ResearchSourceRow, StepOutcome } from "./types";
import { WRITER_RETRY_CORPUS_SCALE, WRITER_TIMEBOX_MAX_MS, writerParts } from "./writer-text";
import { citableSources, synthesisEstimateMicroUsd } from "./limits";
import { isUsableReport } from "@/lib/research/report-structure";
import { parsePlan, planBudget } from "@/lib/research/domain";
import type { EngineContext } from "./context";
import { evidenceDigest } from "@/lib/research/digest";

export function createSynthesisStage(ctx: EngineContext) {
  const { deps, store, beat, append, advance, finish, affordable, stopForBudget, bill } = ctx;
  const doSynthesis = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    // No writer wired in: this is the chat path, where the route streams the
    // report through the user's own model. The job's work is done, and the run
    // waits at `synthesizing` for the caller that asked to be handed the
    // corpus. `drive({ until: "synthesizing" })` is how that caller stops here.
    if (!deps.synthesize) return { kind: "blocked", state: "synthesizing" };
    const plan = parsePlan(run.plan);
    const revisionRound = plan.revisionRound ?? 0;
    const revision =
      revisionRound > 0 && run.report?.trim()
        ? { report: run.report, round: revisionRound }
        : undefined;
    // The corpus is loaded BEFORE the ceiling check, which is the reverse of
    // every other stage here and is the point: synthesis is the one call whose
    // price is set by how much this particular run gathered, and a flat
    // reservation is simultaneously far too much for a three-source run and not
    // half enough for a fifty-source one. `listSources` is a single indexed read
    // and the run is about to make it anyway. Filtered to the citable rows
    // BEFORE the cap, so a readable row past position 250 is not dropped by a
    // slice that counted unread rows ahead of it.
    const sources = citableSources(await store.listSources(run.id, run.userId));
    const estimate = synthesisEstimateMicroUsd(sources, !!revision);
    if (!(await affordable(run, estimate))) {
      return stopForBudget(run, estimate);
    }
    const findings = store.listFindings ? await store.listFindings(run.id, run.userId) : [];
    // The writer is timeboxed to a quarter of the run's clock, six minutes at
    // most, and heartbeats the lease while it writes (B3, R8).
    const timeoutMs = Math.max(60_000, Math.min(WRITER_TIMEBOX_MAX_MS, Math.floor(planBudget(plan).wallClockMs * 0.25)));
    const write = async (corpusScale: number) => {
      const written = await beat(
        () =>
          deps.synthesize!({
            userId: run.userId,
            goal: run.goal,
            plan,
            sources,
            findings,
            signal,
            ...(revision ? { revision } : {}),
            corpusScale,
            timeoutMs,
          }),
        heartbeat
      );
      await bill(run, written.costMicroUsd, "synthesis");
      return written;
    };

    let written = await write(1);
    let parts = writerParts(written.report);
    /*
     * B6: an empty or unusable report is not a report. It used to advance
     * with `report: ""`, skip the audit (nothing to check) and finish
     * `completed` — a finished run with nothing in it. One retry on a corpus
     * packed 30% smaller (the usual cause is a prompt the provider refused or
     * cut short), then the run fails and says why. A revision keeps its
     * audited draft instead, as it always has.
     */
    if (!revision && !isUsableReport(parts.report)) {
      const fresh = (await store.loadRun(run.id, run.userId)) ?? run;
      if (fresh.state !== "synthesizing") return { kind: "raced" };
      const retryEstimate = Math.ceil(estimate * WRITER_RETRY_CORPUS_SCALE);
      if (await affordable(fresh, retryEstimate)) {
        await append(run.id, run.userId, [
          { kind: "error", payload: { scope: "writer", recoverable: true, message: "The report came back empty; writing it again from a smaller corpus." } },
        ]);
        written = await write(WRITER_RETRY_CORPUS_SCALE);
        parts = writerParts(written.report);
      }
      if (!isUsableReport(parts.report)) {
        const latest = (await store.loadRun(run.id, run.userId)) ?? fresh;
        if (latest.state !== "synthesizing") return { kind: "raced" };
        return deliverDigest(latest, sources);
      }
    }
    const fresh = (await store.loadRun(run.id, run.userId)) ?? run;
    if (fresh.state !== "synthesizing") return { kind: "raced" };
    // A failed rewrite must not erase the already audited report.
    const report = parts.report.trim() || revision?.report || "";
    const latestPlan = parsePlan(fresh.plan);
    const planPatch =
      parts.summary || parts.title
        ? {
            ...latestPlan,
            ...(parts.summary ? { summary: parts.summary } : {}),
            ...(parts.title ? { title: parts.title } : {}),
          }
        : undefined;
    const moved = await advance(fresh, "validating_citations", { report, ...(planPatch ? { plan: planPatch } : {}) }, [
      {
        kind: "report_ready",
        payload: { chars: report.length, ...(revision ? { revisionRound } : {}) },
      },
    ]);
    return moved ? { kind: "advanced", state: "validating_citations" } : { kind: "raced" };
  };

  /**
   * VALIDATE: every [n] in the report has to point at a source that exists.
   *
   * A citation to source 14 of a 9-source corpus is the failure this catches,
   * and it is a failure the synthesis model makes often enough to be worth a
   * deterministic check. The validator may repair the draft; the bounded
   * revision branch below then gives the writer one chance to produce a clean
   * replacement before the run becomes terminal.
   */

  /**
   * F6: no model could write the report, so the run delivers what it
   * gathered — the evidence digest, cited, through the same audit — and
   * finishes `partially_completed` instead of throwing the findings away.
   * Only a run with nothing readable at all still ends `writer_empty`.
   */
  const deliverDigest = async (
    run: ResearchRunRow,
    sources: readonly ResearchSourceRow[]
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    // Read now, not reused from before the writer ran: the digest is the run's latest notes.
    const findings = store.listFindings ? await store.listFindings(run.id, run.userId) : [];
    const digest = evidenceDigest({ goal: run.goal, plan, sources, findings });
    if (!digest) {
      const ended = await finish(run, "failed", {
        reason: "writer_empty",
        error: "The report could not be written, and no source could be read to show instead.",
      });
      return ended ? { kind: "finished", state: "failed" } : { kind: "raced" };
    }
    const parts = writerParts(digest);
    const moved = await advance(
      run,
      "validating_citations",
      { report: parts.report, plan: { ...plan, digest: true, ...(parts.title && !plan.title ? { title: parts.title } : {}) } },
      [
        { kind: "error", payload: { scope: "writer", recoverable: true, message: "The report could not be written. Delivering the evidence the researchers gathered instead." } },
        { kind: "report_ready", payload: { chars: parts.report.length, digest: true } },
      ]
    );
    return moved ? { kind: "advanced", state: "validating_citations" } : { kind: "raced" };
  };

  return { doSynthesis, deliverDigest };
}
