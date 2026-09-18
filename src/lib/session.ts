import { redirect } from "next/navigation";
import { cache } from "react";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { authenticateNativeBearer } from "@/lib/native-auth";

export type SessionUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

/**
 * The session cookie, decoded ONCE per request.
 *
 * `auth()` verifies and decrypts a JWT. The app layout called `getSessionBan()`
 * and then `requireUser()`, so it did that twice, in series, before the first
 * bootstrap query was even issued.
 */
const sessionOnce = cache(async () => auth());

/**
 * The account row, read ONCE per request, carrying what both readers below
 * want.
 *
 * `getCurrentUser` needs id/name/email/image and the ban flag; `getSessionBan`
 * needs the ban flag and its reason. They were two `findUnique` calls on the
 * same row, awaited one after the other — two round trips to a hosted database
 * for one row, on every page render of a `force-dynamic` layout.
 *
 * `cache()` is per-REQUEST: two users never share an entry, and a ban applied
 * mid-session still takes effect on the reader's next request, which is the
 * guarantee the ban check is written around.
 */
const accountById = cache(async (id: string) =>
  prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, image: true, bannedAt: true, banReason: true },
  })
);

/** Returns the signed-in user or null (use in pages/route handlers). */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const authorization = (await headers()).get("authorization");
  // A presented bearer credential is authoritative. Invalid native credentials
  // never fall back to a browser cookie attached to the same request.
  if (authorization) {
    try {
      const native = await authenticateNativeBearer(authorization);
      return {
        id: native.user.id,
        name: native.user.name,
        email: native.user.email,
        image: native.user.image,
      };
    } catch {
      return null;
    }
  }
  const session = await sessionOnce();
  const sessionUser = (session?.user as SessionUser | undefined) ?? null;
  if (!sessionUser) return null;

  const account =
    sessionUser.id
      ? await accountById(sessionUser.id)
      : sessionUser.email
        ? await prisma.user.findUnique({
            where: { email: sessionUser.email },
            select: { id: true, name: true, email: true, image: true, bannedAt: true, banReason: true },
          })
        : null;

  // A ban applied mid-session takes effect on the next request: treating a
  // banned account as signed-out kills every active session immediately.
  if (!account || account.bannedAt) return null;
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    image: account.image,
  };
});

/** Pages: returns the user or redirects to sign-in. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}

/**
 * Ban state for the CURRENT session, read independently of getCurrentUser
 * (which reports a banned account as signed-out). Lets the app shell send a
 * suspended user to a page that explains why, instead of a silent sign-in loop.
 */
export async function getSessionBan(): Promise<{ reason: string | null } | null> {
  // Both reads are the cached ones, so calling this immediately before
  // `requireUser()` — which the app layout does — costs one session decode and
  // one row, not two of each.
  const session = await sessionOnce();
  const sessionUser = (session?.user as SessionUser | undefined) ?? null;
  if (!sessionUser?.id) return null;
  const account = await accountById(sessionUser.id);
  if (!account?.bannedAt) return null;
  return { reason: account.banReason };
}
