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
          select: { id: true, name: true, email: true, image: true },
        })
      : sessionUser.email
        ? await prisma.user.findUnique({
            where: { email: sessionUser.email },
            select: { id: true, name: true, email: true, image: true },
          })
        : null;

  if (!account) return null;
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
