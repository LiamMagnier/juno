/*
 * Research engine stage — audit: validate the report's citations against the passages it cites, and finish the run.
 * Moved verbatim out of createResearchEngine (engine.ts).
 */
import { CITATION_AUDIT_ESTIMATE_MICRO_USD, citableSources } from "./limits";
import { MAX_REVISION_ROUNDS, parsePlan } from "@/lib/research/domain";
import type { ResearchRunRow, ResearchValidationResult, StepOutcome } from "./types";
import { citationMarkersOutsideCode } from "./writer-text";
import type { EngineContext } from "./context";
import { DIGEST_NOTICE } from "@/lib/research/digest";

export function createValidationStage(ctx: EngineContext) {
  const { deps, store, beat, append, advance, finish, announceFinish, affordable, stopForBudget, bill } = ctx;
  const doValidation = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    // The identical list the writer numbered — see `citableSources`. Handing
    // the audit every row put an unread row at index 1 of most runs, and
    // every citation was then judged against a page with no passages.
    const sources = citableSources(await store.listSources(run.id, run.userId));
    let report = run.report ?? "";
    let auditDegraded = false;
    let validation: ResearchValidationResult | null = null;
    if (deps.validateReport && report.trim()) {
      /*
       * The audit is a model stage, so it is gated like one. It used to be the
       * last un-gated cost path in a run: the judge's spend never reached the
       * ledger, so `affordable` could not see it and a run could cross its
       * ceiling by an entire stage — after synthesis, the most expensive call
       * it makes, had already been paid for.
       *
       * A stop here is honest rather than destructive: the draft is already
       * durable (synthesis wrote it into the row on the way in), so the run
       * ends `partially_completed` holding a readable report whose citations
       * nobody checked. The alternative — audit anyway and bill past the
       * ceiling — is the behaviour the column exists to prevent, and silently
       * skipping the audit while reporting `completed` would tell the reader
       * every citation had been verified when none had.
       */
      // A run with an envelope reserved its audit at its own judge budget
      // (B22); older runs keep the audit-wide reservation.
      const auditPlan = parsePlan(run.plan);
      const auditEstimate = auditPlan.envelope ? auditPlan.envelope.reserve.auditMicroUsd : CITATION_AUDIT_ESTIMATE_MICRO_USD;
      if (!(await affordable(run, auditEstimate))) {
        return stopForBudget(run, auditEstimate);
      }
      await append(run.id, run.userId, [{ kind: "citation_audit_started", payload: { sources: sources.length } }]);
      try {
        validation = await beat(
          () =>
            deps.validateReport!({
              userId: run.userId,
              runId: run.id,
              goal: run.goal,
              plan: parsePlan(run.plan),
              report,
              signal,
              sources,
            }),
          heartbeat
        );
        if (validation) {
          report = validation.report;
          // Same path every other stage bills through — `bill` → `addSpend`,
          // one writer. `citation_audit` is not in VENDOR_BILLED_STEPS because
          // the tokens are a model's, not a vendor's, which is the same reason
          // `plan` and `synthesis` are not.
          await bill(run, validation.costMicroUsd ?? 0, "citation_audit");
          await append(run.id, run.userId, [
            {
              kind: "citation_audit_completed",
              payload: validation.summary,
            },
            ...(validation.repaired
              ? [{ kind: "report_repaired" as const, payload: { reason: "citation_validation" } }]
              : []),
          ]);
        } else {
          auditDegraded = true;
          await append(run.id, run.userId, [
            {
              kind: "error",
              payload: {
                scope: "citation_audit",
                message: "Citation validation returned no result; claims remain unverified.",
              },
            },
          ]);
        }
      } catch (error) {
        /*
         * A validator that throws mid-audit loses whatever it had already spent
         * on the judge: the cost rides on the RESULT, and a rejected promise
         * carries no result to carry it. Accepted rather than papered over,
         * because the alternative is a second cost channel (a callback in the
         * deps contract) feeding the same ledger from two directions, which is
         * the shape that lets a stage get billed twice. The exposure is bounded
         * by the reservation already taken above: the ceiling was checked for
         * the whole stage before any of it ran.
         */
        auditDegraded = true;
        await append(run.id, run.userId, [
          {
            kind: "error",
            payload: {
              scope: "citation_audit",
              message: error instanceof Error ? error.message : "Citation validation failed.",
            },
          },
        ]);
      }
    }
    const cited = new Set<number>(citationMarkersOutsideCode(report));
    const dangling = [...cited].filter((n) => n < 1 || n > sources.length);
    if (dangling.length > 0) {
      await append(run.id, run.userId, [
        {
          kind: "error",
          payload: {
            scope: "citations",
            message: "The report cited sources that are not in the corpus.",
            markers: dangling,
          },
        },
      ]);
    }

    /*
     * A repaired report is evidence that the writer's first pass was not good
     * enough. Send it back through the same durable synthesis stage once, then
     * validate the replacement again. `revisionRound` lives in the plan JSON so
     * a worker crash between these two transitions cannot reopen an unbounded
     * paid loop. The repaired report is patched together with the state move,
     * so the next worker has a useful draft even if it starts at synthesizing.
     */
    const plan = parsePlan(run.plan);
    const revisionRound = plan.revisionRound ?? 0;
    // The evidence digest (F6) was written because the writer could not
    // write; sending it back to that writer is the loop it escaped.
    const shouldRevise =
      !plan.digest &&
      !!deps.synthesize &&
      !!validation &&
      report.trim().length > 0 &&
      revisionRound < MAX_REVISION_ROUNDS &&
      (validation.repaired || dangling.length > 0);
    if (shouldRevise && validation) {
      const nextPlan = parsePlan({ ...plan, revisionRound: revisionRound + 1 });
      const moved = await advance(
        run,
        "synthesizing",
        { plan: nextPlan, report },
        [
          {
            kind: "report_revision",
            payload: {
              phase: "requested",
              round: nextPlan.revisionRound,
              reason: "citation_validation",
              danglingCitations: dangling,
              ...validation.summary,
            },
          },
        ]
      );
      return moved ? { kind: "advanced", state: "synthesizing" } : { kind: "raced" };
    }
    const to = (plan.digest || dangling.length > 0 || auditDegraded ? "partially_completed" : "completed") as "completed" | "partially_completed";
    const reason = plan.digest
      ? "writer_digest"
      : dangling.length > 0
        ? "citations_unverified"
        : auditDegraded
          ? "citation_audit_degraded"
          : "completed";
    const error = plan.digest
      ? DIGEST_NOTICE
      : dangling.length > 0
        ? "Some citations in the report do not match a gathered source."
        : auditDegraded
          ? "Citation validation was unavailable; the report is usable but not fully verified."
          : null;

    /*
     * The web completion (§9.6.3, INV-14): the message, its report artifact,
     * the conversation's lastMessageAt, the run's pointer and this terminal
     * move are one transaction, written by `complete`. The events follow it,
     * and `run_completed` tells the panel which message now holds the report.
     */
    if (deps.complete && report.trim()) {
      const completed = await deps.complete({ run, plan: parsePlan(run.plan), report, sources, to, error });
      if (completed.raced) return { kind: "raced" };
      await announceFinish(run, run.state, to, { reason, error }, [
        {
          kind: "run_completed",
          payload: {
            messageId: completed.messageId,
            ...(completed.sourceOrder ? { sourceOrder: completed.sourceOrder } : {}),
          },
        },
      ]);
      return { kind: "finished", state: to };
    }

    const ended = await finish(run, to, { reason, report, error });
    return ended ? { kind: "finished", state: to } : { kind: "raced" };
  };


  return { doValidation };
}
