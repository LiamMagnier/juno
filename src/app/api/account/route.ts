import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { deleteAccountPermanently } from "./delete-account";

export const runtime = "nodejs";

/** Permanently delete the user's account and all associated data. */
export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await deleteAccountPermanently(user);
  return NextResponse.json({ ok: true });
}
