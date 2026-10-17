import "server-only";
import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PLANS } from "@/lib/plans";
import { rateLimit } from "@/lib/rate-limit";
import { consumeRefusalBody, getQuota } from "@/lib/usage";
import { currentPeriod } from "@/lib/utils";
import { CODE_TURN_RETRY_WINDOW_SEC, codeTurnKey } from "@/lib/metering/code-turn";

/*
 * A CODE TURN, ADMITTED AND COUNTED LIKE A CHAT TURN.
 *
 * The provider proxy (`/api/agent/[...path]`) is the one door every Code call
 * on Alevr's keys passes through — the Mac's engine, the env-server and the
 * cloud runner alike — so it is where a Code turn meets the same two rules a
 * web turn meets in `consumeMessage`:
 *
 *  - ADMISSION. An account whose address is unconfirmed cannot spend: chat
 *    refuses its turn with `EMAIL_UNVERIFIED` before a model is called, and the
 *    proxy now refuses its Code calls the same way. Checked on every call, not
 *    only the opening one, because a continuation is no cheaper than an opening
 *    and the classifier is not what should stand between an unconfirmed account
 *    and a provider bill. A plan with a monthly message cap is refused at the
 *    opening once the cap is reached; no plan has one today, and the check is
 *    there so adding one does not silently skip Code.
 *
 *  - COUNTING. One message on the month's counter per turn, when the turn's
 *    opening call was actually billed — the proxy calls `countCodeTurn` from
 *    the same place it writes the call's spend. Counting on the bill rather
 *    than reserving and refunding means an opening the provider refused (an
 *    error, nothing streamed) is never counted, which is the web's refund rule
 *    reached without a second request.
 *
 * NO DOUBLE COUNTING. Three things could count one turn twice, and each is
 * closed:
 *   1. An engine's retry of the same opening: held off by the retry window
 *      below (`codeTurnKey`, on the shared fixed-window table).
 *   2. The reporter route (`/api/agent/usage`), which used to move the counter
 *      itself at `phase: "start"`: it now hands out a handle without counting,
 *      because the proxy counts the opening it is about to see.
 *   3. A call on the user's own key: never counted here, exactly as it is
 *      never billed here — the proxy returns before either.
 */

export type CodeCallAdmission =
  | { allowed: true }
  | { allowed: false; status: 402; body: Record<string, unknown> };

/**
 * Whether this account may spend on a Code call now. The budget and the
 * windows are the proxy's own checks beside this; this is the part of chat's
 * admission the proxy did not have.
 */
export async function admitCodeCall(input: {
  userId: string;
  plan: Plan;
  /** This call opens a turn (`codeTurnOpening`). Only an opening meets a message cap. */
  opensTurn: boolean;
}): Promise<CodeCallAdmission> {
  const account = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { emailVerified: true },
  });
  if (!account?.emailVerified) {
    const quota = await getQuota(input.userId, input.plan);
    return {
      allowed: false,
      status: 402,
      body: consumeRefusalBody({ allowed: false, reason: "email_unverified", quota }, "coding"),
    };
  }
  if (input.opensTurn && PLANS[input.plan].monthlyMessages != null) {
    const quota = await getQuota(input.userId, input.plan);
    if (quota.remaining !== null && quota.remaining <= 0) {
      return {
        allowed: false,
        status: 402,
        body: consumeRefusalBody({ allowed: false, reason: "quota_exceeded", quota }, "coding"),
      };
    }
  }
  return { allowed: true };
}

export type CodeTurnCount = "counted" | "repeat";

/**
 * Count one Code turn on the month's message counter, once per opening.
 *
 * The opening's key is claimed on the fixed-window table first: the first
 * claim inside the window counts, a retried opening finds the key taken and
 * counts nothing. The counter itself is the same row and the same column
 * `consumeMessage` increments, so a month of Code and a month of chat are one
 * number on the account, as they are one budget.
 */
export async function countCodeTurn(input: {
  userId: string;
  fingerprint: string;
  now?: Date;
}): Promise<CodeTurnCount> {
  const claim = await rateLimit({
    key: codeTurnKey(input.userId, input.fingerprint),
    limit: 1,
    windowSec: CODE_TURN_RETRY_WINDOW_SEC,
  });
  if (!claim.success) return "repeat";
  const period = currentPeriod(input.now);
  await prisma.usage.upsert({
    where: { userId_period: { userId: input.userId, period } },
    create: { userId: input.userId, period, messageCount: 1 },
    update: { messageCount: { increment: 1 } },
  });
  return "counted";
}
