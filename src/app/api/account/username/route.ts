import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { checkUsername, displayHandle, usernameSchema, type UsernameProblem } from "@/lib/username";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };
const TAKEN = "That username is taken.";

/** Changes that reach the database, per account per day. Taken and invalid tries do not count. */
const CHANGE_LIMIT = { limit: 10, windowSec: 24 * 60 * 60 };
/** Availability checks, per account per minute: generous for typing, too slow to sweep the namespace. */
const CHECK_LIMIT = { limit: 90, windowSec: 60 };

const patchSchema = z.object({ username: usernameSchema });

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

function problemOf(error: z.ZodError): UsernameProblem | undefined {
  const issue = error.issues[0] as { params?: { problem?: UsernameProblem } } | undefined;
  return issue?.params?.problem;
}

/**
 * The signed-in account's username.
 *
 *   GET                 { username, handle }: the chosen name (null until one
 *                       is picked) and the @handle the profile shows.
 *   GET ?check=<name>   { username, available, problem?, message? }: live
 *                       feedback for the Settings field. `username` is the
 *                       normalised form ("@Liam" → "liam"); your own current
 *                       name reads as available.
 *   PATCH { username }  sets it. 400 with { error, problem } for a name the
 *                       rules refuse, 409 { problem: "taken" } when someone
 *                       has it, 429 past the daily change limit.
 *
 * The write is a single UPDATE against the unique index, so two accounts
 * racing for one name cannot both win: the loser's P2002 is answered as
 * "taken", the same as the availability check would have said.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const check = new URL(request.url).searchParams.get("check");
  if (check === null) {
    const account = await prisma.user.findUnique({
      where: { id: user.id },
      select: { username: true, name: true, email: true },
    });
    if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ username: account.username, handle: displayHandle(account) }, { headers: NO_STORE });
  }

  const limit = await rateLimit({ key: `username-check:${user.id}`, ...CHECK_LIMIT });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many checks. Wait a moment and try again." }, { status: 429, headers: NO_STORE });
  }

  const result = checkUsername(check.slice(0, 200));
  if (!result.ok) {
    return NextResponse.json(
      { username: check.trim().replace(/^@+/, "").toLowerCase(), available: false, problem: result.problem, message: result.message },
      { headers: NO_STORE }
    );
  }
  const holder = await prisma.user.findUnique({ where: { username: result.username }, select: { id: true } });
  const available = !holder || holder.id === user.id;
  return NextResponse.json(
    available
      ? { username: result.username, available: true }
      : { username: result.username, available: false, problem: "taken", message: TAKEN },
    { headers: NO_STORE }
  );
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Choose a username.",
        problem: problemOf(parsed.error) ?? "invalid",
        field: "username",
      },
      { status: 400, headers: NO_STORE }
    );
  }
  const { username } = parsed.data;

  const current = await prisma.user.findUnique({ where: { id: user.id }, select: { username: true } });
  if (!current) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (current.username === username) {
    return NextResponse.json({ ok: true, username, handle: username }, { headers: NO_STORE });
  }

  // Cheap refusal first, so a taken name never spends one of the day's changes.
  const holder = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (holder && holder.id !== user.id) {
    return NextResponse.json({ error: TAKEN, problem: "taken", field: "username" }, { status: 409, headers: NO_STORE });
  }

  const limit = await rateLimit({ key: `username-change:${user.id}`, ...CHANGE_LIMIT });
  if (!limit.success) {
    return NextResponse.json(
      { error: "You’ve changed your username a lot today. Try again tomorrow." },
      { status: 429, headers: NO_STORE }
    );
  }

  try {
    await prisma.user.update({ where: { id: user.id }, data: { username }, select: { id: true } });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: TAKEN, problem: "taken", field: "username" }, { status: 409, headers: NO_STORE });
    }
    throw error;
  }
  return NextResponse.json({ ok: true, username, handle: username }, { headers: NO_STORE });
}
