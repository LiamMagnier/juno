import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export type SessionUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

/** Returns the signed-in user or null (use in pages/route handlers). */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  const sessionUser = (session?.user as SessionUser | undefined) ?? null;
  if (!sessionUser) return null;

  const account =
    sessionUser.id
      ? await prisma.user.findUnique({
          where: { id: sessionUser.id },
          select: { id: true, name: true, email: true, image: true, bannedAt: true },
        })
      : sessionUser.email
        ? await prisma.user.findUnique({
            where: { email: sessionUser.email },
            select: { id: true, name: true, email: true, image: true, bannedAt: true },
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
  const session = await auth();
  const sessionUser = (session?.user as SessionUser | undefined) ?? null;
  if (!sessionUser?.id) return null;
  const account = await prisma.user.findUnique({
    where: { id: sessionUser.id },
    select: { bannedAt: true, banReason: true },
  });
  if (!account?.bannedAt) return null;
  return { reason: account.banReason };
}
