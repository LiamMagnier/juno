import { NextResponse } from "next/server";
import { prismaUnguarded } from "@/lib/prisma";
import { ipFromHeaders, rateLimit } from "@/lib/rate-limit";
import { serializeRun } from "@/lib/work/serializers";
import { fireTokenFromHeader, fireTokenMatches } from "@/lib/work/fire-token";
import { fireRefusalStatus, fireScheduleNow } from "@/lib/work/fire-now";
import { MAX_FIRE_TEXT_CHARS } from "@/lib/work/code-routine";
import { parseTriggerConfig } from "@/lib/work/triggers";

export const runtime = "nodejs";

/**
 * Starting one automation from outside Juno.
 *
 *   POST /api/work/schedules/<id>/fire
 *   Authorization: Bearer <token issued by .../token>
 *   { "text": "optional", "idempotencyKey": "optional" }
 *
 *   → 201 { run } | { codeRun }   started
 *     200 { …, replay: true }     this exact key already started one
 *     401                         no token, or not this automation's token
 *     409                         paused, no API trigger, already running, no Mac
 *     413                         the text is longer than a fire may carry
 *     422                         text sent to an automation that does not take text
 *     429                         too many fires, or the account is out of window
 *
 * ── THE TEXT IS DATA, AND IT IS NEVER AN INSTRUCTION ───────────────────────
 *
 * Anyone holding the token can call this, and a token in a CI job is a token in
 * a log, in a shell history and in whatever the CI vendor keeps. So `text` is
 * treated exactly as a connector result or a fetched web page is: wrapped in
 * the untrusted envelope (`src/lib/untrusted-content.ts`), introduced by a
 * sentence saying where it came from, and placed AFTER the automation's own
 * prompt — see `codeRoutinePrompt`. Nothing here parses it, matches on it or
 * lets it choose a repository, a branch or a model. The most a caller can do is
 * put words in front of a prompt that was written to expect them.
 *
 * And it must have been written to expect them: the `api` trigger's
 * `acceptsText` is off until somebody turns it on, and a fire carrying text at
 * an automation that has not is refused rather than quietly stripped. Stripping
 * would be worse than refusing — the caller would believe the run had read
 * something it never saw.
 *
 * ── AUTHENTICATION ─────────────────────────────────────────────────────────
 *
 * The id in the URL is a claim and the token is the proof; the lookup is
 * therefore unguarded (a credential-keyed read, which is what `prismaUnguarded`
 * is for) and every decision after it is scoped by the row's own `userId`,
 * never by anything in the request. A wrong token and a missing automation
 * answer alike, so this cannot be used to discover which ids exist.
 */

/** Max fires per automation per minute. A fire starts a cloud run or claims an
 *  executor, so an unbounded caller is not a wasted request. */
const FIRE_RATE_LIMIT = 30;
/**
 * Max ATTEMPTS per caller per minute, counted before the token is checked.
 *
 * The limit below it only ever ran on requests that had already authenticated,
 * so a caller presenting a wrong token — or no token for this routine — was
 * never throttled at all, and every attempt still cost a `workSchedule`
 * lookup with two relations included, on a URL that is public by design. That
 * is not a credential risk (32 random bytes, a constant-time compare and one
 * uniform 401), but it is an unmetered database query per unauthenticated
 * request.
 *
 * Keyed by caller rather than by routine, because the routine id is the part an
 * attacker varies freely. Set well above `FIRE_RATE_LIMIT` so a legitimate CI
 * job firing several routines from one host never meets this one first.
 */
const FIRE_ATTEMPT_LIMIT = 120;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const presented = fireTokenFromHeader(req.headers.get("authorization"));
  const unauthorized = NextResponse.json(
    {
      error: "unauthorized",
      message: "This automation's fire URL needs the bearer token issued for it.",
    },
    { status: 401 }
  );
  const tooMany = NextResponse.json(
    { error: "rate_limited", message: "Too many fires for this automation. Try again shortly." },
    { status: 429 }
  );
  if (!presented) return unauthorized;

  // Before the lookup, and that ordering is the whole point of this call.
  const attempts = await rateLimit({
    key: `work-fire-attempt:${ipFromHeaders(req.headers)}`,
    limit: FIRE_ATTEMPT_LIMIT,
    windowSec: 60,
  });
  if (!attempts.success) return tooMany;

  const body = (await req.json().catch(() => null)) as {
    text?: unknown;
    idempotencyKey?: unknown;
  } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : null;
  const key = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : null;
  if (text && text.length > MAX_FIRE_TEXT_CHARS) {
    return NextResponse.json(
      {
        error: "text_too_long",
        message: `A fire may carry up to ${MAX_FIRE_TEXT_CHARS} characters of text.`,
      },
      { status: 413 }
    );
  }

  // Keyed by a credential the caller presents, which is the case
  // `prismaUnguarded` exists for. Everything below is scoped by the row's own
  // userId.
  const schedule = await prismaUnguarded.workSchedule.findFirst({
    where: { id },
    // The whole trigger set, filtered below. A nested relation filter would be
    // a second `where` in a route that deliberately has only one.
    include: { session: true, triggers: true },
  });
  if (!schedule) return unauthorized;
  if (!fireTokenMatches(presented, schedule.fireSecretHash)) return unauthorized;

  // Per automation rather than per account: one noisy CI job must not spend
  // another automation's share of the limit, and the token names exactly one.
  const limited = await rateLimit({ key: `work-fire:${id}`, limit: FIRE_RATE_LIMIT, windowSec: 60 });
  if (!limited.success) return tooMany;

  // A token outlives the trigger it was issued for — revoking one and removing
  // the other are separate actions — so the trigger is what decides whether a
  // fire does anything, and both of its states get their own sentence.
  const trigger = schedule.triggers.find((entry) => entry.kind === "api");
  if (!trigger) {
    return NextResponse.json(
      {
        error: "no_api_trigger",
        message:
          "This automation no longer has an API trigger, so nothing here starts it. The token can be revoked.",
      },
      { status: 409 }
    );
  }
  if (!trigger.enabled) {
    return NextResponse.json(
      { error: "trigger_disabled", message: "This automation's API trigger is switched off." },
      { status: 409 }
    );
  }

  if (text) {
    // Two reasons a fire's text is refused, and they are refusals rather than a
    // silent strip because the failure is the same either way: a caller that
    // sent text and got a 201 believes the run read it.
    //
    // The first is about the product. A Work routine re-runs a TASK, and a
    // task's goal is fixed at dispatch (docs/JUNO.md §9b.4) — the run is
    // validated against it, and nothing here may edit it. There is nowhere for a
    // caller's paragraph to go that the run would actually read, so it is
    // refused by kind rather than appended somewhere hopeful.
    if (schedule.runKind !== "code") {
      return NextResponse.json(
        {
          error: "text_not_accepted",
          message:
            "This automation runs a task, and a task's goal is fixed when it starts — so a fire cannot add to it. Only a Code automation reads text sent with a fire.",
        },
        { status: 422 }
      );
    }
    // The second is the opt-in. Anyone holding the token can send text, so the
    // prompt has to have been written to use it.
    const parsed = parseTriggerConfig("api", trigger.config);
    const accepts = parsed.ok && parsed.parsed.kind === "api" && parsed.parsed.config.acceptsText;
    if (!accepts) {
      return NextResponse.json(
        {
          error: "text_not_accepted",
          message:
            "This automation does not take text with a fire. Its own instructions decide what it does, and it has not been set up to read anything a caller sends.",
        },
        { status: 422 }
      );
    }
  }

  const fired = await fireScheduleNow({
    schedule,
    userId: schedule.userId,
    // `trigger`, not `manual`: something happened, and nobody pressed anything.
    origin: "trigger",
    // False. Whoever holds the token is not sitting in front of the run, so the
    // executor checkpoints on the first question instead of waiting for an
    // answer that is not coming.
    attended: false,
    fireText: text,
    now: new Date(),
    // Prefixed so a caller's key can never collide with the key a scheduled or
    // a manual fire of the same automation mints.
    idempotencyKey: key ? `wapi:${id}:${key.slice(0, 160)}` : null,
  });

  if (fired.outcome === "refused") {
    return NextResponse.json(
      {
        error: fired.reason,
        message: fired.message,
        ...(fired.window ? { window: fired.window, resetsAtMs: fired.resetsAtMs ?? null } : {}),
      },
      // 409 for a conflict of state, 429 for a spent window — a caller that
      // reads the status rather than the body backs off on the one it should.
      { status: fireRefusalStatus(fired.reason) }
    );
  }
  if (fired.outcome === "code_run") {
    return NextResponse.json(
      {
        codeRun: { taskId: fired.taskId, conversationId: fired.conversationId },
        ...(fired.replay ? { replay: true } : {}),
      },
      { status: fired.replay ? 200 : 201 }
    );
  }
  return NextResponse.json(
    { run: serializeRun(fired.run), ...(fired.replay ? { replay: true } : {}) },
    { status: fired.replay ? 200 : 201 }
  );
}
