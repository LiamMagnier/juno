import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { env } from "@/lib/env";
import { mintFireToken } from "@/lib/work/fire-token";

export const runtime = "nodejs";

/**
 * The token something else fires this automation with.
 *
 *   POST   → 201 { token, issuedAt, url }   a NEW token; the old one stops working
 *            409 { error: "no_api_trigger" } nothing on this automation reads it
 *            404 no such automation
 *   DELETE → 200 { ok: true }                the token stops working; nothing else changes
 *
 * THE TOKEN IS RETURNED ONCE AND NEVER AGAIN. Only its SHA-256 is stored
 * (`src/lib/work/fire-token.ts`), so there is no read path that could return
 * it, and "show it to me again" is answered by issuing a new one — which is the
 * honest answer, because a credential a server can re-display is a credential a
 * server is holding.
 *
 * POST is a ROLL, not an add: one automation has one fire URL, so a second
 * token would have to mean either two live credentials with one revocation
 * button or a second URL nothing else knows about. Rolling says what it does —
 * the caller holding the previous token starts failing, which is the entire
 * point of rolling one.
 *
 * Refusing when no `api` trigger exists is the rule this package is written
 * around: a token that starts nothing is a control implying a capability the
 * automation does not have, and somebody would put it in a CI job and wait.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const schedule = await prisma.workSchedule.findFirst({
    where: { id, userId: user.id },
    // The whole trigger set, filtered here rather than in the query. A routine
    // holds at most a handful, and a nested relation filter is one more `where`
    // for a reader — human or `tests/work-security.test.ts` — to have to prove
    // is reached through an owned row.
    select: { id: true, triggers: { select: { kind: true } } },
  });
  if (!schedule) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const apiTriggers = schedule.triggers.filter((trigger) => trigger.kind === "api");

  // The trigger has to exist; it does not have to be ON. Issuing a token for a
  // trigger somebody has switched off for the afternoon is reasonable, and the
  // fire route is what refuses while it is off — with a sentence that says so,
  // rather than one about a missing token.
  if (apiTriggers.length === 0) {
    return NextResponse.json(
      {
        error: "no_api_trigger",
        message:
          "Add the “Something calls it” trigger to this automation first — without it, nothing would read the token.",
      },
      { status: 409 }
    );
  }

  const { token, hash } = mintFireToken();
  const issuedAt = new Date();
  await prisma.workSchedule.updateMany({
    where: { id, userId: user.id },
    data: { fireSecretHash: hash, fireSecretIssuedAt: issuedAt },
  });

  return NextResponse.json(
    {
      token,
      issuedAt: issuedAt.toISOString(),
      // Handed back whole so nobody has to assemble it from a base URL and a
      // path they read in a docs page that has since moved.
      url: `${env.appUrl.replace(/\/$/, "")}/api/work/schedules/${id}/fire`,
    },
    { status: 201 }
  );
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const schedule = await prisma.workSchedule.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!schedule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The trigger is left alone on purpose. Revoking a credential and deleting
  // the thing it starts are two decisions, and doing the second because
  // somebody asked for the first would quietly change when this automation
  // runs.
  await prisma.workSchedule.updateMany({
    where: { id, userId: user.id },
    data: { fireSecretHash: null, fireSecretIssuedAt: null },
  });

  return NextResponse.json({ ok: true });
}
