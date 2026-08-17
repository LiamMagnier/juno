/**
 * Actually telling somebody that their Work run got somewhere.
 *
 * `notifications.ts` decides WHETHER and WHAT and deliberately holds no
 * database and no transport, so the decision table can be pinned by a test that
 * opens neither. This file is the other half: it reads the run, asks that
 * decision, and hands the answer to the one delivery channel Juno already has.
 *
 * **It is self-contained on purpose.** The cloud runner calls it with the two
 * identifiers it is already holding at the terminal path and nothing else — no
 * policy, no title, no recipient. Everything else is looked up here. That is
 * not tidiness: the runner's terminal path is also its catch-all failure path,
 * and a notification that needed five arguments assembled by a function that
 * has just thrown is a notification that never goes out on exactly the runs
 * where it matters most.
 *
 * **It never throws.** Same argument as `recordWorkAudit`: everything this
 * function reports has already happened, and failing the caller would stack a
 * second failure on the first without un-finishing the run. Errors go to the
 * operator console.
 *
 * **The only channel is email.** That is a statement of fact about the app
 * rather than a design choice made here. Juno has one delivery layer
 * (`sendEmail`, Resend, flag-gated on RESEND_API_KEY) and one wake-up channel
 * for native clients (the AccountChange feed) — but no Work table has a change
 * trigger, so no Work state reaches that feed today and there is nothing to
 * push. Building a second sender to fill the gap would be a fourth mechanism to
 * keep correct; the gap is recorded in the deployment notes instead.
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { prismaUnguarded } from "@/lib/db";
import { isEmailEnabled, sendEmail } from "@/lib/email";
import { env } from "@/lib/env";
import {
  WORK_SENSITIVITIES,
  isWorkStatus,
  maxSensitivity,
  type WorkSensitivity,
  type WorkStatus,
  type WorkTerminalReason,
} from "@/lib/work/domain";
import {
  WORK_NOTIFY_POLICIES,
  decideNotification,
  describeNotification,
  notificationKey,
  type WorkNotifyPolicy,
  type WorkNotifyUrgency,
} from "@/lib/work/notifications";
import { workNotificationEmail } from "@/lib/work/notify/email";

/**
 * How long the record of a delivery is kept.
 *
 * Ninety days, and the number barely matters: the thing being deduplicated is a
 * transition a run makes once, and a run that finished three months ago is not
 * going to finish again. It exists at all because the row lives in `RateLimit`,
 * whose only sweeping mechanism is expiry — see `claimDelivery` for why that
 * table and not a new one.
 */
const DELIVERY_RECORD_TTL_SEC = 90 * 24 * 60 * 60;

/**
 * What a run with no schedule behind it asks for.
 *
 * Matches `WorkSchedule.notifyPolicy`'s own default rather than inventing a
 * quieter one, because the two cases should behave the same way for the same
 * reason: tell me when you need me, and otherwise leave me alone. A manually
 * started run is also the case where the person is most likely still looking at
 * the tab, and "only when it needs me" is the policy that does not email
 * somebody about a task finishing on the screen in front of them.
 */
const DEFAULT_NOTIFY_POLICY: WorkNotifyPolicy = "on_attention";

export interface DeliverRunNotificationInput {
  /** The run that just changed state. */
  runId: string;
  /**
   * The account that owns it. Optional — resolved from the run when omitted —
   * but pass it when you have it: it turns the first read into an ownership
   * check rather than a lookup that trusts the id it was handed.
   */
  userId?: string;
  /** Injected rather than read from the clock, so expiry boundaries are testable. */
  now?: Date;
}

export type DeliverRunNotificationResult =
  | { delivered: false; reason: string }
  | { delivered: true; channel: "email"; urgency: WorkNotifyUrgency; reason: string };

/**
 * Notify the owner about one run, at most once per thing worth saying.
 *
 * Safe to call exactly once at a run's terminal path, and safe to call again
 * afterwards: the second call finds the delivery already recorded and returns
 * without sending. Also correct to call when a run parks in `waiting_input` or
 * `waiting_approval`, which are the states that most need it — a run that stops
 * to ask and never says so sits blocked until its approval expires, and from
 * the user's side it simply never finished.
 *
 * Returns why it did or did not send, for the caller's log. Callers that do not
 * care may `void` it.
 */
export async function deliverRunNotification(
  input: DeliverRunNotificationInput
): Promise<DeliverRunNotificationResult> {
  try {
    return await deliver(input);
  } catch (error) {
    console.error("[work-notify] delivery failed", {
      runId: input.runId,
      message: error instanceof Error ? error.message : String(error),
    });
    return { delivered: false, reason: "The notification could not be sent." };
  }
}

async function deliver(
  input: DeliverRunNotificationInput
): Promise<DeliverRunNotificationResult> {
  const now = input.now ?? new Date();

  // Unguarded, and for the same reason audit.ts is: the caller is the cloud
  // runner or the scheduler, which have no session user to scope to. When the
  // caller does know the owner it is put in the WHERE, so a wrong pairing of
  // run and account reads as "no such run" rather than notifying the wrong
  // person about somebody else's task.
  const run = await prismaUnguarded.workRun.findFirst({
    where: { id: input.runId, ...(input.userId ? { userId: input.userId } : {}) },
    select: {
      id: true,
      userId: true,
      sessionId: true,
      status: true,
      terminalReason: true,
      origin: true,
      inputSensitivity: true,
      outputSensitivity: true,
      session: { select: { title: true } },
      schedule: { select: { notifyPolicy: true } },
      host: { select: { displayName: true } },
    },
  });

  if (run === null) {
    return { delivered: false, reason: "That run is not there to notify about." };
  }
  if (!isWorkStatus(run.status)) {
    // A status column holding something outside the vocabulary is a bug
    // elsewhere, and guessing which sentence to send about it is how a user
    // gets told something untrue about their own files.
    console.error("[work-notify] run has an unknown status", {
      runId: run.id,
      status: run.status,
    });
    return { delivered: false, reason: "This run is in a state Juno cannot describe." };
  }

  const status: WorkStatus = run.status;
  const terminalReason = asTerminalReason(run.terminalReason);
  const policy = asNotifyPolicy(run.schedule?.notifyPolicy);

  // What "this exact thing" is, for both the decision and the deduplication.
  // Keyed on the approval or the question rather than the status, because a run
  // legitimately blocks several times and a status-keyed notification would fire
  // once and then go quiet for the rest of the task.
  const occasion = await resolveOccasion(run.id, run.userId, status, terminalReason, now);
  const key = notificationKey(run.id, occasion.subject);

  const decision = decideNotification({
    status,
    terminalReason,
    policy,
    // Who started it, which is all that can honestly be known. There is no
    // presence signal in this schema — `WorkSession.lastActivityAt` is bumped by
    // the run itself, so reading it as "the user is here" would call every long
    // task attended — so this says "a person kicked this off", not "a person is
    // watching right now". The decision only consults it for non-terminal
    // transitions under the `all` policy, where over-reading it costs a
    // suppressed notification rather than a duplicate one.
    attended: run.origin !== "schedule" && run.origin !== "trigger",
    alreadyNotified: await alreadyDelivered(key),
  });

  if (!decision.notify) return { delivered: false, reason: decision.reason };

  if (!isEmailEnabled()) {
    // Nothing is claimed in this branch. Email being unconfigured is an operator
    // state, not a delivery, and burning the key here would silence the run for
    // good the moment the key was added.
    return { delivered: false, reason: "No delivery channel is configured on this deployment." };
  }

  const user = await prismaUnguarded.user.findUnique({
    where: { id: run.userId },
    select: { email: true },
  });
  if (!user?.email) {
    return { delivered: false, reason: "This account has no email address to write to." };
  }

  const mayQuote = mayIncludeRunDetail(run.inputSensitivity, run.outputSensitivity);
  const message = describeNotification({
    title: run.session.title,
    status,
    terminalReason,
    hostName: run.host?.displayName ?? null,
    question: mayQuote ? occasion.question : null,
    approvalSummary: mayQuote ? occasion.approvalSummary : null,
  });

  // The claim is the last thing before the send and the first thing that is
  // irreversible. Two runners racing — the executor's own terminal path and a
  // lease sweeper that decided the run was abandoned — both reach here, and
  // exactly one of them wins the row.
  if (!(await claimDelivery(key, now))) {
    return { delivered: false, reason: "Another worker is already sending this one." };
  }

  // Persist durable in-app notification
  try {
    const notifType = status === "waiting_approval" ? "work_approval"
      : status === "waiting_input" ? "work_approval"
      : status === "completed" ? "work_completed"
      : "work_failed";
    await prismaUnguarded.notification.create({
      data: {
        userId: run.userId,
        type: notifType,
        title: message.subject,
        body: message.summary,
        priority: decision.urgency === "blocking" ? "urgent" : "normal",
        sourceType: "work_session",
        sourceId: run.sessionId,
        actionable: status === "waiting_approval" || status === "waiting_input",
        actionData: {
          runId: run.id,
          sessionId: run.sessionId,
          taskUrl: taskUrl(run.sessionId),
          question: occasion.question ?? null,
          approvalSummary: occasion.approvalSummary ?? null,
        },
      },
    });
  } catch (notifErr) {
    console.warn("[work-notify] could not write in-app notification", notifErr);
  }

  const template = workNotificationEmail({
    message,
    urgency: decision.urgency,
    taskUrl: taskUrl(run.sessionId),
  });
  const result = await sendEmail({
    to: user.email,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });

  if (!("ok" in result)) {
    // `{ skipped: true }`: the API key went away between `isEmailEnabled` above
    // and this call. This is the one outcome where "did anything go out?" has an
    // unambiguous answer — `sendEmail` returns this before it opens a socket —
    // so the claim is released rather than held. Holding it would spend the run's
    // only notification on a moment of misconfiguration and stay quiet for ever
    // afterwards, which is the failure this whole file exists to prevent.
    await releaseDelivery(key);
    return { delivered: false, reason: "No delivery channel is configured on this deployment." };
  }

  if (!result.ok) {
    // Here the claim is deliberately NOT released. A send that failed and a send
    // whose acknowledgement was lost look identical from here, and Resend
    // accepting a message it never told us about is the exact case that turns a
    // retry into a second email. Under-notifying is recoverable — the run's own
    // row still says what happened, and the task list still shows it; notifying
    // twice trains the reader to ignore the channel.
    console.error("[work-notify] the channel refused the message", { runId: run.id, key });
    return { delivered: false, reason: "The message could not be handed to the mail provider." };
  }

  return {
    delivered: true,
    channel: "email",
    urgency: decision.urgency,
    reason: decision.reason,
  };
}

// ---------------------------------------------------------------------------
// What the run is trying to say
// ---------------------------------------------------------------------------

interface NotifyOccasion {
  /** The `subject` half of `notificationKey` — what makes this event distinct. */
  subject: string;
  question: string | null;
  approvalSummary: string | null;
}

/**
 * The specific thing that happened, and the words the run itself used for it.
 *
 * A blocked run's own sentence is far better than the generic fallback — "Move
 * 14 files from Downloads to Archive" tells the reader whether it is worth
 * getting out of bed for, and "Juno is waiting for you to approve one action"
 * does not — so it is fetched when there is one.
 */
async function resolveOccasion(
  runId: string,
  userId: string,
  status: WorkStatus,
  terminalReason: WorkTerminalReason | null,
  now: Date
): Promise<NotifyOccasion> {
  if (status === "waiting_approval") {
    const approval = await prismaUnguarded.workApproval.findFirst({
      where: { runId, userId, decision: "pending", expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      select: { id: true, summary: true },
    });
    if (approval !== null) {
      return {
        subject: `approval:${approval.id}`,
        question: null,
        approvalSummary: approval.summary,
      };
    }
  }

  if (status === "waiting_input") {
    // The latest `question_asked` is the open one, because this branch only runs
    // for a run parked in `waiting_input` — a run whose question was answered
    // has left that status.
    const asked = await prismaUnguarded.workEvent.findFirst({
      where: { runId, userId, kind: "question_asked" },
      orderBy: { seq: "desc" },
      select: { id: true, payload: true },
    });
    if (asked !== null) {
      const question = readQuestion(asked.payload);
      return {
        subject: `question:${question.id ?? asked.id}`,
        question: question.text,
        approvalSummary: null,
      };
    }
  }

  // Everything else happens once per run: `terminalReason` is a write-once
  // column, so a terminal run has exactly one of these no matter how many times
  // this function is called.
  return {
    subject: `terminal:${terminalReason ?? status}`,
    question: null,
    approvalSummary: null,
  };
}

/** `{ question: { id, question, why, options } }`, as the runner emits it. */
function readQuestion(payload: Prisma.JsonValue): { id: string | null; text: string | null } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { id: null, text: null };
  }
  const wrapper = (payload as Record<string, unknown>).question;
  if (wrapper === null || typeof wrapper !== "object" || Array.isArray(wrapper)) {
    return { id: null, text: null };
  }
  const fields = wrapper as Record<string, unknown>;
  return {
    id: typeof fields.id === "string" && fields.id.length > 0 ? fields.id : null,
    text: typeof fields.question === "string" && fields.question.length > 0 ? fields.question : null,
  };
}

// ---------------------------------------------------------------------------
// Sending it only once
// ---------------------------------------------------------------------------

/**
 * The row that records a delivery.
 *
 * `RateLimit` rather than a table of its own, because Work has no schema of
 * mine to add one to and this is precisely the shape that table already holds
 * for `sendBudgetAlert`: a string key whose existence means "this was already
 * sent". Being the primary key is what makes the claim atomic — the insert
 * either creates the row or violates the constraint, with no window between
 * checking and writing for a second worker to slip through. A `findFirst` +
 * `create` pair would have one, and the retry-while-finishing race in the brief
 * is exactly what would fit inside it.
 *
 * Prefixed so the key cannot collide with a real rate-limit bucket, and cannot
 * be produced by any other caller.
 */
function deliveryRecordKey(key: string): string {
  return `work:notify:${key}`;
}

async function alreadyDelivered(key: string): Promise<boolean> {
  const row = await prismaUnguarded.rateLimit.findUnique({
    where: { key: deliveryRecordKey(key) },
    select: { key: true },
  });
  return row !== null;
}

/**
 * Take the right to send this one, or discover somebody else already has.
 *
 * Deliberately not expiry-aware on read: a record whose `expiresAt` has passed
 * still means the message went out, and re-sending a three-month-old "your task
 * finished" would be worse than never mentioning it. Expiry is only there so
 * the row is sweepable.
 */
async function claimDelivery(key: string, now: Date): Promise<boolean> {
  try {
    await prismaUnguarded.rateLimit.create({
      data: {
        key: deliveryRecordKey(key),
        count: 1,
        expiresAt: new Date(now.getTime() + DELIVERY_RECORD_TTL_SEC * 1000),
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}

/**
 * Give the claim back, for the one caller that knows nothing was sent.
 *
 * Only ever called by the worker that just won `claimDelivery`, so the row is
 * this call's own. `deleteMany` rather than `delete` regardless, because
 * `delete` throws on a row that is not there and the only thing that reaction
 * could achieve is turning a released claim into a logged exception on a path
 * that has already decided not to notify anybody.
 */
async function releaseDelivery(key: string): Promise<void> {
  await prismaUnguarded.rateLimit.deleteMany({ where: { key: deliveryRecordKey(key) } });
}

// ---------------------------------------------------------------------------
// Reading columns that are strings in the database
// ---------------------------------------------------------------------------

function asNotifyPolicy(value: string | null | undefined): WorkNotifyPolicy {
  return (WORK_NOTIFY_POLICIES as readonly string[]).includes(value ?? "")
    ? (value as WorkNotifyPolicy)
    : DEFAULT_NOTIFY_POLICY;
}

function asTerminalReason(value: string | null): WorkTerminalReason | null {
  // Read through `statusForTerminalReason`'s vocabulary rather than trusted, so
  // an unrecognised value degrades to "no reason recorded" — which produces the
  // generic sentence for the status — instead of being passed through as one.
  const known: readonly string[] = [
    "completed",
    "failed",
    "cancelled",
    "budget_exceeded",
    "timed_out",
    "host_offline",
    "interrupted",
    "superseded",
  ];
  return value !== null && known.includes(value) ? (value as WorkTerminalReason) : null;
}

/**
 * Whether the run's own words may leave the account.
 *
 * The same rule `allowsScreenshotRelay` applies to images: `restricted` never
 * goes out. An approval summary and a question are the run's most useful
 * sentences and also the two places a restricted document's contents can
 * surface — "Send the Q3 board pack to …" is a summary and a leak. At
 * `restricted` the detail is dropped and `describeNotification` falls back to
 * its generic sentence, so the reader still learns that the task is blocked and
 * still gets a link; they just have to open Juno to see what it is blocked on.
 */
function mayIncludeRunDetail(inputSensitivity: string, outputSensitivity: string): boolean {
  const sensitivity = maxSensitivity(
    asSensitivity(inputSensitivity),
    asSensitivity(outputSensitivity)
  );
  return sensitivity !== "restricted";
}

function asSensitivity(value: string): WorkSensitivity {
  // Unrecognised reads as the most restrictive, not the most permissive: a
  // column holding something unexpected is not a licence to email its contents.
  return (WORK_SENSITIVITIES as readonly string[]).includes(value)
    ? (value as WorkSensitivity)
    : "restricted";
}

function taskUrl(sessionId: string): string {
  return `${env.appUrl.replace(/\/$/, "")}/work/${sessionId}`;
}
