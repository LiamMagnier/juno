/**
 * Actually telling somebody that their Work run got somewhere.
 *
 * `notifications.ts` decides WHETHER and WHAT and deliberately holds no
 * database and no transport, so the decision table can be pinned by a test that
 * opens neither. This file is the other half: it reads the run, asks that
 * decision, and hands the answer to the channels.
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
 * **Two channels, each deduplicated on its own.** First `notifyUser`: the
 * inbox row and a push to every phone, Mac and browser whose switch is on —
 * written whether or not this deployment can send email, because the inbox
 * used to exist only where Resend was configured. Then email, as before, when
 * it is configured and the account has an address. Each keeps its own record
 * of what it sent, so a deployment without email never blocks the inbox and a
 * push that went out never stops the email that follows it.
 *
 * Native clients also wake on the AccountChange feed, which is fed by Postgres
 * triggers rather than by this file. Those triggers are written and are
 * deliberately NOT applied yet: they sit in
 * `prisma/migrations-pending/20260815141000_work_change_capture_triggers`,
 * held back until the build that understands the Work entity types is the
 * oldest client in the field. The precondition, and the instruction not to
 * move the file merely because the strings are in `main`, are in that
 * directory's README.
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { prismaUnguarded } from "@/lib/db";
import { isEmailEnabled, sendEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { markRunNotificationsRead, notifyUser } from "@/lib/notifications";
import { planWorkRunNotification } from "@/lib/notify/work-run";
import { answeredQuestionWhere } from "@/lib/work/answer-lookup";
import {
  WORK_SENSITIVITIES,
  isTerminalStatus,
  isWorkStatus,
  maxSensitivity,
  type WorkSensitivity,
  type WorkStatus,
  type WorkTerminalReason,
} from "@/lib/work/domain";
import {
  decideNotification,
  describeNotification,
  effectiveNotifyStatus,
  isAttendedOrigin,
  notificationKey,
  runNotifyPolicy,
  type WorkNotifyMessage,
  type WorkNotifyUrgency,
} from "@/lib/work/notifications";
import { agentNotifyLevel } from "@/lib/agents/domain";
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
  /**
   * How long a waiting run may take to show what it waits on. The runner
   * queues its event writes behind one another, so its own call the moment a
   * run asks can arrive before the `question_asked` it has just emitted; this
   * looks again for up to that long instead of leaving the notice to the park
   * four minutes later. Zero (the default) looks once.
   */
  settleMs?: number;
}

/** Between looks while a waiting run's question lands. */
const SETTLE_POLL_MS = 400;

/** Where a notification went: the inbox row, a push service, the mail provider. */
export type RunNotifyChannel = "in_app" | "push" | "email";

export type DeliverRunNotificationResult =
  | { delivered: false; reason: string }
  | { delivered: true; channels: RunNotifyChannel[]; urgency: WorkNotifyUrgency; reason: string };

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
      session: { select: { title: true, conversationId: true, agentId: true } },
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

  const terminalReason = asTerminalReason(run.terminalReason);

  // A run that has ended is asking nobody anything, whatever this call goes on
  // to decide: its "needs you" rows are answered or moot, and an inbox that
  // kept them unread would hold the dot up for a question nobody can answer.
  if (isTerminalStatus(run.status)) {
    await markRunNotificationsRead(run.userId, run.id, now);
  }

  // A parked run is still waiting on whatever it parked for, and that is what
  // the notification is about. See `effectiveNotifyStatus`.
  const status: WorkStatus =
    run.status === "paused" ? await parkedStatus(run.id, run.userId, now) : run.status;

  // What "this exact thing" is, for both the decision and the deduplication.
  // Keyed on the approval or the question rather than the status, because a run
  // legitimately blocks several times and a status-keyed notification would fire
  // once and then go quiet for the rest of the task.
  let occasion = await resolveOccasion(run.id, run.userId, status, terminalReason, now);
  const settleUntil = Date.now() + Math.max(0, input.settleMs ?? 0);
  while (occasion === null && Date.now() < settleUntil) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    occasion = await resolveOccasion(run.id, run.userId, status, terminalReason, new Date());
  }
  if (occasion === null) {
    // Waiting, with nothing open to show for it: the approval expired, the
    // question was answered, or — the case worth naming — the runner's event
    // write has not landed inside `settleMs`. The run's next stop (the park
    // after the attended wait) asks again, and keying this one on the status
    // instead would send it twice.
    return { delivered: false, reason: "The run has no open approval or question to tell anyone about." };
  }
  const key = notificationKey(run.id, occasion.subject);

  const decision = decideNotification({
    status,
    terminalReason,
    policy: runNotifyPolicy({
      schedulePolicy: run.schedule?.notifyPolicy ?? null,
      agentOwned: run.session.agentId !== null,
    }),
    // The decision only consults this for non-terminal transitions under the
    // `all` policy, where over-reading it costs a suppressed notification
    // rather than a duplicate one.
    attended: isAttendedOrigin(run.origin),
    // Each channel keeps its own record below; this call is about whether the
    // transition is worth saying at all.
    alreadyNotified: false,
  });

  if (!decision.notify) return { delivered: false, reason: decision.reason };

  // The agent whose task this is speaks for it: named in the copy, drawn in
  // the inbox, and the thread its pushes group under. A deleted agent is not
  // found and the task speaks as Juno.
  const agent = run.session.agentId
    ? await prismaUnguarded.agent.findFirst({
        where: { id: run.session.agentId, userId: run.userId, deletedAt: null },
        select: { id: true, name: true, avatar: true, notify: true },
      })
    : null;
  if (
    agent &&
    agentNotifyLevel((agent as { notify?: string | null }).notify) === "needs_you" &&
    (status === "completed" || status === "cancelled")
  ) {
    return {
      delivered: false,
      reason: "This agent only notifies when it needs your input or hits an error.",
    };
  }

  const mayQuote = mayIncludeRunDetail(run.inputSensitivity, run.outputSensitivity);
  const quoted = {
    question: mayQuote ? occasion.question : null,
    approvalSummary: mayQuote ? occasion.approvalSummary : null,
  };
  const message = describeNotification({
    title: run.session.title,
    status,
    terminalReason,
    hostName: run.host?.displayName ?? null,
    actorName: agent?.name ?? null,
    ...quoted,
  });

  const channels: RunNotifyChannel[] = [];

  // The inbox and the pushes first, and not behind any email gate. The claim
  // is the last thing before the send and the first thing that is
  // irreversible: two runners racing — the executor's own terminal path and a
  // lease sweeper that decided the run was abandoned — both reach here, and
  // exactly one of them wins the row.
  if (!(await alreadyDelivered("app", key)) && (await claimDelivery("app", key, now))) {
    // A run waits on one thing at a time, so whatever it asked before this is
    // answered: that row stops asking before this one starts.
    await markRunNotificationsRead(run.userId, run.id, now);
    const sent = await notifyUser({
      userId: run.userId,
      ...planWorkRunNotification({
        runId: run.id,
        sessionId: run.sessionId,
        conversationId: run.session.conversationId,
        status,
        urgency: decision.urgency,
        message,
        agent,
        approval: occasion.approval,
        questionId: occasion.questionId,
        quoted,
      }),
    });
    if (sent.notificationId) channels.push("in_app");
    if (sent.pushed > 0) channels.push("push");
    if (!sent.notificationId && sent.pushed === 0) {
      // Nothing left the building — the row write failed and no device took a
      // push — so the claim goes back and the run's next call tries again.
      await releaseDelivery("app", key);
    }
  }

  if (await sendRunEmail(run, key, decision.urgency, message, now)) channels.push("email");

  if (channels.length === 0) {
    return { delivered: false, reason: "Everything worth saying about this was already sent." };
  }
  return { delivered: true, channels, urgency: decision.urgency, reason: decision.reason };
}

/**
 * The email, when this deployment can send one and the account has an
 * address. Unchanged in what it says and when; it only no longer stands in
 * front of the inbox.
 */
async function sendRunEmail(
  run: { id: string; userId: string; sessionId: string; session: { conversationId: string | null } },
  key: string,
  urgency: WorkNotifyUrgency,
  message: WorkNotifyMessage,
  now: Date
): Promise<boolean> {
  // Nothing is claimed while email is unconfigured. That is an operator state,
  // not a delivery, and burning the key here would silence the run for good
  // the moment the key was added.
  if (!isEmailEnabled()) return false;

  const user = await prismaUnguarded.user.findUnique({
    where: { id: run.userId },
    select: { email: true },
  });
  if (!user?.email) return false;

  if ((await alreadyDelivered("email", key)) || !(await claimDelivery("email", key, now))) return false;

  const template = workNotificationEmail({
    message,
    urgency,
    taskUrl: taskUrl(run.sessionId, run.session.conversationId),
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
    // only email on a moment of misconfiguration and stay quiet for ever
    // afterwards, which is the failure this whole file exists to prevent.
    await releaseDelivery("email", key);
    return false;
  }

  if (!result.ok) {
    // Here the claim is deliberately NOT released. A send that failed and a send
    // whose acknowledgement was lost look identical from here, and Resend
    // accepting a message it never told us about is the exact case that turns a
    // retry into a second email. Under-notifying is recoverable — the inbox row
    // still says what happened; notifying twice trains the reader to ignore the
    // channel.
    console.error("[work-notify] the mail provider refused the message", { runId: run.id, key });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// What the run is trying to say
// ---------------------------------------------------------------------------

interface NotifyOccasion {
  /** The `subject` half of `notificationKey` — what makes this event distinct. */
  subject: string;
  question: string | null;
  approvalSummary: string | null;
  /** The approval being waited on; its expiry is the push's. */
  approval: { id: string; expiresAt: Date } | null;
  questionId: string | null;
}

/**
 * The specific thing that happened, and the words the run itself used for it.
 *
 * A blocked run's own sentence is far better than the generic fallback — "Move
 * 14 files from Downloads to Archive" tells the reader whether it is worth
 * getting out of bed for, and "Juno is waiting for you to approve one action"
 * does not — so it is fetched when there is one.
 *
 * Null when the run is waiting and the thing it waits on is not there: an
 * approval that has expired, a question already answered, or one whose event
 * the runner has not finished writing. There is nothing to say about those
 * that would still be true when it arrived.
 */
async function resolveOccasion(
  runId: string,
  userId: string,
  status: WorkStatus,
  terminalReason: WorkTerminalReason | null,
  now: Date
): Promise<NotifyOccasion | null> {
  if (status === "waiting_approval") {
    const approval = await pendingApproval(runId, userId, now);
    if (approval === null) return null;
    return {
      subject: `approval:${approval.id}`,
      question: null,
      approvalSummary: approval.summary,
      approval: { id: approval.id, expiresAt: approval.expiresAt },
      questionId: null,
    };
  }

  if (status === "waiting_input") {
    const asked = await openQuestion(runId, userId);
    if (asked === null) return null;
    return {
      subject: `question:${asked.questionId ?? asked.eventId}`,
      question: asked.text,
      approvalSummary: null,
      approval: null,
      questionId: asked.questionId,
    };
  }

  // Everything else happens once per run: `terminalReason` is a write-once
  // column, so a terminal run has exactly one of these no matter how many times
  // this function is called.
  return {
    subject: `terminal:${terminalReason ?? status}`,
    question: null,
    approvalSummary: null,
    approval: null,
    questionId: null,
  };
}

/** The run's newest approval that can still be answered. */
async function pendingApproval(runId: string, userId: string, now: Date) {
  return prismaUnguarded.workApproval.findFirst({
    where: { runId, userId, decision: "pending", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select: { id: true, summary: true, expiresAt: true, createdAt: true },
  });
}

/**
 * The run's newest question, when nobody has answered it. The newest is the
 * only candidate: a run asks one thing at a time and cannot ask the next until
 * the last is answered.
 */
async function openQuestion(
  runId: string,
  userId: string
): Promise<{ eventId: string; questionId: string | null; text: string | null; askedAt: Date } | null> {
  const asked = await prismaUnguarded.workEvent.findFirst({
    where: { runId, userId, kind: "question_asked" },
    orderBy: { seq: "desc" },
    select: { id: true, payload: true, createdAt: true },
  });
  if (asked === null) return null;
  const question = readQuestion(asked.payload);
  if (question.id !== null) {
    const answered = await prismaUnguarded.workEvent.findFirst({
      where: { ...answeredQuestionWhere(runId, question.id), userId },
      select: { id: true },
    });
    if (answered !== null) return null;
  }
  return { eventId: asked.id, questionId: question.id, text: question.text, askedAt: asked.createdAt };
}

/**
 * What a `paused` run is paused on, from the rows. A question counts only
 * when it carries an id, because only then can "unanswered" be checked — a
 * run paused by hand must not be announced as asking something.
 */
async function parkedStatus(runId: string, userId: string, now: Date): Promise<WorkStatus> {
  const [approval, question] = await Promise.all([pendingApproval(runId, userId, now), openQuestion(runId, userId)]);
  return effectiveNotifyStatus({
    status: "paused",
    pendingApprovalAt: approval?.createdAt ?? null,
    openQuestionAt: question?.questionId ? question.askedAt : null,
  });
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

/** The two things that are sent at most once per occasion, each on its own record. */
type DeliveryChannel = "app" | "email";

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
function deliveryRecordKey(channel: DeliveryChannel, key: string): string {
  // Email keeps the key it has always used, so a run emailed before the inbox
  // had a record of its own is not emailed a second time.
  return channel === "email" ? `work:notify:${key}` : `work:notify:${channel}:${key}`;
}

async function alreadyDelivered(channel: DeliveryChannel, key: string): Promise<boolean> {
  const row = await prismaUnguarded.rateLimit.findUnique({
    where: { key: deliveryRecordKey(channel, key) },
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
async function claimDelivery(channel: DeliveryChannel, key: string, now: Date): Promise<boolean> {
  try {
    await prismaUnguarded.rateLimit.create({
      data: {
        key: deliveryRecordKey(channel, key),
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
async function releaseDelivery(channel: DeliveryChannel, key: string): Promise<void> {
  await prismaUnguarded.rateLimit.deleteMany({ where: { key: deliveryRecordKey(channel, key) } });
}

// ---------------------------------------------------------------------------
// Reading columns that are strings in the database
// ---------------------------------------------------------------------------

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
 *
 * One answer for every channel. The message it shapes is the email, the inbox
 * row and the lock-screen text all at once, and the row's `actionData` keeps
 * the run's words only when this allows it — the push is built from the same
 * row, and a sentence stored there is one refactor away from a lock screen.
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

/**
 * Where the email points. The inbox and the pushes carry a relative path
 * instead (`workRunPath`), which is this without the origin — or the agent,
 * for an agent's task.
 *
 * `/work/<sessionId>` used to be a page. It is not one any more: a run is read
 * in the conversation that asked for it (docs/design/TWO_PRODUCTS.md §2), so
 * the link is that conversation.
 *
 * WHEN THERE IS NO CONVERSATION, this hands out `/work/<sessionId>` rather than
 * `/chat`, and the difference matters precisely because an email is the
 * longest-lived link Juno emits. That path is the account-scoped resolver
 * (src/lib/work-url-migration.ts): it answers "the chat index" today and "the
 * conversation" the moment one is attached, whereas a `/chat` baked in now
 * would still say "the chat index" a month later. The direct link is preferred
 * when it can be built because it costs the reader one fewer round trip, not
 * because the resolver would be wrong.
 */
function taskUrl(sessionId: string, conversationId: string | null): string {
  const base = env.appUrl.replace(/\/$/, "");
  return conversationId ? `${base}/chat/${conversationId}` : `${base}/work/${sessionId}`;
}
