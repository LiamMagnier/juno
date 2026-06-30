import "server-only";
import { notFound } from "next/navigation";
import { isOwnerEmail } from "@/lib/owner";
import { getCurrentUser, requireUser, type SessionUser } from "@/lib/session";

export async function getOwnerUser(): Promise<SessionUser | null> {
  const user = await getCurrentUser();
  return isOwnerEmail(user?.email) ? user : null;
}

export async function requireOwnerPage(): Promise<SessionUser> {
  const user = await requireUser();
  if (!isOwnerEmail(user.email)) notFound();
  return user;
}
