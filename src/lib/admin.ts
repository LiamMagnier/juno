import "server-only";
import { notFound } from "next/navigation";
import { isOwnerEmail } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, requireUser, type SessionUser } from "@/lib/session";

/*
 * The owner gate.
 *
 * An owner account can read and delete every user's conversations, ban
 * accounts, and spend without a ceiling. That is the largest blast radius in
 * the product, and until now the only thing standing in front of it was a
 * password — so two-step verification is not optional for it. An owner who has
 * not enrolled is refused with `mfa_required` rather than quietly downgraded:
 * the enrol prompt has to be reachable, and "Admin vanished" is a worse
 * support call than "Admin says turn on two-step".
 */

export type OwnerRefusal = "not_owner" | "mfa_required";

export type OwnerAccess =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: OwnerRefusal; user: SessionUser | null };

/**
 * The full answer, with the reason. Use this where the refusal needs to be
 * told apart from "you are not an owner" — the Admin layout, and any route
 * that wants to answer 403 `mfa_required` instead of 404.
 */
export async function getOwnerAccess(): Promise<OwnerAccess> {
  const user = await getCurrentUser();
  if (!isOwnerEmail(user?.email) || !user) return { ok: false, reason: "not_owner", user: user ?? null };
  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { totpEnabledAt: true },
  });
  if (!account?.totpEnabledAt) return { ok: false, reason: "mfa_required", user };
  return { ok: true, user };
}

/**
 * The owner, or null.
 *
 * Signature deliberately unchanged: every route under /api/admin answers 404
 * on null, and an un-enrolled owner failing closed there is the correct
 * outcome — the API surface must not be usable from a session that has only a
 * password behind it. `getOwnerAccess()` is what a caller uses when it wants to
 * say WHY (see `requireOwnerApi`).
 */
export async function getOwnerUser(): Promise<SessionUser | null> {
  const access = await getOwnerAccess();
  return access.ok ? access.user : null;
}

/**
 * Route-handler guard that names the refusal.
 *
 * Returns the owner, or the response to send. 404 for a non-owner (the Admin
 * surface does not admit it exists); 403 `mfa_required` for an owner who has
 * not enrolled, so the client can send them to Settings instead of showing a
 * dead end.
 */
export async function requireOwnerApi(): Promise<
  { ok: true; owner: SessionUser } | { ok: false; status: 403 | 404; body: { error: string } }
> {
  const access = await getOwnerAccess();
  if (access.ok) return { ok: true, owner: access.user };
  if (access.reason === "mfa_required") {
    return { ok: false, status: 403, body: { error: "mfa_required" } };
  }
  return { ok: false, status: 404, body: { error: "Not found" } };
}

/**
 * Page guard. Non-owners get a 404; an owner without two-step also fails
 * closed here, because the Admin layout renders the enrol prompt INSTEAD of
 * its children and so no page below it should ever run in that state. This is
 * the belt to that layout's braces.
 */
export async function requireOwnerPage(): Promise<SessionUser> {
  const user = await requireUser();
  if (!isOwnerEmail(user.email)) notFound();
  const access = await getOwnerAccess();
  if (!access.ok) notFound();
  return access.user;
}

/**
 * Page guard for the Admin layout alone: it needs to tell the two refusals
 * apart so it can draw the prompt. Non-owners still get a 404.
 */
export async function requireOwnerPageAccess(): Promise<{ user: SessionUser; mfaRequired: boolean }> {
  const user = await requireUser();
  if (!isOwnerEmail(user.email)) notFound();
  const access = await getOwnerAccess();
  return { user, mfaRequired: !access.ok };
}
