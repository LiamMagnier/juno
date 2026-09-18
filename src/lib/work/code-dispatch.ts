import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { encryptMessageText } from "@/lib/message-crypto";
import { appendTaskEvents, persistCodeTaskOutcome } from "@/lib/code-remote";
import { CloudDispatchError, dispatchCloudRunner, getCloudRunnerReadiness } from "@/lib/cloud-code";
import {
  codeRoutineConversationSeed,
  codeRoutineTaskDraft,
  parseCodeRoutineConfig,
  type CodeRoutineConfig,
} from "@/lib/work/code-routine";

/**
 * Starting one Code run for one fire of a routine.
 *
 * Two callers, one implementation: the scheduler when a clock fire comes due,
 * and the fire route when something calls a routine's API trigger. They are
 * different processes asking the same question — "make this routine's run
 * happen now" — and two copies of it would drift on exactly the parts that are
 * hard to see: the order of the conversation, the task and the dispatch; what
 * happens to the row when GitHub refuses the dispatch; and which of the three
 * is idempotent.
 *
 * WHY NOT A CALL INTO `POST /api/code/tasks`
 *
 * That route does this for a person: it reads a browser session, applies a
 * per-user burst limit and a cloud concurrency cap, inherits the environment
 * and the branch from the previous message in the conversation, and claims
 * attachments. A routine has no session to read, no previous message to inherit
 * from, no attachments, and its concurrency is governed by its own
 * `maxConcurrentRuns` plus the account cap the schedulers already enforce
 * through `planScheduleDispatch` — so calling that route would mean either
 * forging a session or re-deriving half of it anyway. What the two DO share is
 * the sequence below, and every step of it is here for a reason that route's
 * comments state: the transcript is written before the dispatch because a
 * runner can start the instant GitHub accepts it, and a failed dispatch leaves
 * the task and writes the failure into the conversation rather than deleting
 * the evidence of a fire that happened.
 *
 * The one deliberate difference is continuity: a routine's fire never reuses
 * the previous fire's branch. See `codeRoutineTaskDraft`.
 */

export type CodeRunOutcome =
  /** A run exists and a runner has been asked for. */
  | { outcome: "started"; taskId: string; conversationId: string }
  /** This exact fire already produced a run. Nothing new was created. */
  | { outcome: "replay"; taskId: string; conversationId: string | null }
  /**
   * Nothing was started, and nothing will be until a person acts.
   *
   * `recorded` says whether the failure is visible to the user as a finished
   * run in the routine's history — it is whenever a task row got as far as
   * existing — so a caller knows whether it still has to say something itself.
   */
  | { outcome: "refused"; reason: CodeRunRefusal; message: string; recorded: boolean };

export const CODE_RUN_REFUSALS = [
  /** The routine's `codeConfig` cannot be read, so there is no repository. */
  "config_invalid",
  /** No linked GitHub connector to clone and open a pull request as. */
  "github_not_connected",
  /** No dispatch token, or the runner workflow is missing or disabled. */
  "cloud_runner_not_configured",
  /** GitHub accepted nothing. Usually temporary. */
  "dispatch_failed",
] as const;

export type CodeRunRefusal = (typeof CODE_RUN_REFUSALS)[number];

export interface CodeRunInput {
  scheduleId: string;
  userId: string;
  name: string;
  instructions: string;
  timezone: string;
  /** The stored `WorkSchedule.codeConfig`, unparsed. */
  codeConfig: unknown;
  /** The fire this run is for. Names the conversation and dates it. */
  fireAt: Date;
  /** Text the caller sent with an API fire, or null. Already length-checked
   *  and consent-checked by the route; wrapped as untrusted data here. */
  fireText: string | null;
  /**
   * The key that makes one fire produce one run.
   *
   * `CodeTask` has the same `(userId, idempotencyKey)` unique index `WorkRun`
   * has, so two schedulers racing on one fire — or one retrying after a lost
   * response — collide in the database rather than starting two cloud runs
   * against the same repository.
   */
  idempotencyKey: string;
}

export async function startCodeRoutineRun(input: CodeRunInput): Promise<CodeRunOutcome> {
  const parsed = parseCodeRoutineConfig(input.codeConfig);
  if (!parsed.ok) {
    return { outcome: "refused", reason: "config_invalid", message: parsed.message, recorded: false };
  }

  // Checked before anything is written. A retry of a fire whose response was
  // lost must find its own run rather than open a second conversation, and the
  // unique index below is the backstop for the concurrent version of the same
  // race.
  const existing = await prisma.codeTask.findFirst({
    where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
    select: { id: true, conversationId: true },
  });
  if (existing) {
    return { outcome: "replay", taskId: existing.id, conversationId: existing.conversationId };
  }

  // Both of these refuse BEFORE a row exists, exactly as the create route does,
  // because a task that can never be dispatched is worse than no task: it sits
  // `queued` for ever with nothing anywhere saying why.
  const github = await prisma.connection.findFirst({
    where: { userId: input.userId, provider: "github" },
    select: { id: true },
  });
  if (!github) {
    return {
      outcome: "refused",
      reason: "github_not_connected",
      message:
        "This routine needs a linked GitHub account to clone its repository and open a pull request.",
      recorded: false,
    };
  }
  const readiness = await getCloudRunnerReadiness();
  if (!readiness.ready) {
    return {
      outcome: "refused",
      reason: "cloud_runner_not_configured",
      message: readiness.message,
      recorded: false,
    };
  }

  const config: CodeRoutineConfig = parsed.config;
  const draft = codeRoutineTaskDraft({
    name: input.name,
    instructions: input.instructions,
    config,
    fireText: input.fireText,
  });

  // The conversation first, because the task points at it and the user turn
  // below is written into it. A conversation left behind by a task create that
  // then failed is an empty Code session the user can delete; a task pointing
  // at a conversation that does not exist is a run with no transcript.
  const conversation = await prisma.conversation.create({
    data: {
      userId: input.userId,
      ...codeRoutineConversationSeed(input.name, input.fireAt, input.timezone, config.model),
    },
  });

  let task;
  try {
    task = await prisma.codeTask.create({
      data: {
        userId: input.userId,
        deviceId: null,
        scheduleId: input.scheduleId,
        conversationId: conversation.id,
        idempotencyKey: input.idempotencyKey,
        ...draft,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Two dispatchers raced past the pre-read. The loser drops its empty
      // conversation and reports the winner's run, so one fire is still one
      // run and the account is not left with a stray Code session per race.
      await prisma.conversation
        .deleteMany({ where: { id: conversation.id, userId: input.userId } })
        .catch(() => undefined);
      const winner = await prisma.codeTask.findFirst({
        where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
        select: { id: true, conversationId: true },
      });
      if (winner) {
        return { outcome: "replay", taskId: winner.id, conversationId: winner.conversationId };
      }
    }
    throw error;
  }

  // The user turn before the dispatch, and that ordering is load-bearing: a
  // runner can start as soon as GitHub accepts, so writing the transcript
  // afterwards leaves a window in which a live run has no prompt behind it.
  await prisma.$transaction(async (tx) => {
    await tx.message.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        // The prompt as the run received it, wrapped fire text and all, because
        // the transcript has to be able to answer "what did it actually read".
        content: encryptMessageText(draft.prompt),
      },
    });
    await tx.conversation.updateMany({
      where: { id: conversation.id, userId: input.userId },
      data: { lastMessageAt: new Date() },
    });
  });

  try {
    // Only the task id and the callback origin — the repository is not a
    // dispatch input, because inputs are printed into a public Actions log.
    await dispatchCloudRunner({ taskId: task.id, callbackBase: env.appUrl.replace(/\/$/, "") });
  } catch (error) {
    // The fire happened, so it is written down as a run that failed rather than
    // deleted. A routine that has been unable to start for a fortnight has to
    // look different from one that has not fired, and the console is not a
    // surface any user can see.
    const vanished = error instanceof CloudDispatchError && error.status === 404;
    try {
      await appendTaskEvents(
        task.id,
        [
          {
            kind: "error",
            payload: {
              message: vanished
                ? "The cloud runner workflow is missing from the runner repository, so this run could not start."
                : "The cloud runner could not be started for this run.",
            },
            key: `dispatch:${task.id}`,
          },
        ],
        { status: "failed", fromStatus: "queued" }
      );
      const failed = await prisma.codeTask.findUnique({ where: { id: task.id } });
      if (failed) await persistCodeTaskOutcome(failed);
    } catch {
      // The stuck-task sweeper reconciles a task left queued. Nothing further
      // can be done here, and the refusal below is what the caller reports.
    }
    return {
      outcome: "refused",
      reason: vanished ? "cloud_runner_not_configured" : "dispatch_failed",
      message: vanished
        ? "The cloud runner workflow is missing from the runner repository, so this routine cannot start a run."
        : "The cloud runner could not be started. This is usually temporary.",
      recorded: true,
    };
  }

  return { outcome: "started", taskId: task.id, conversationId: conversation.id };
}
