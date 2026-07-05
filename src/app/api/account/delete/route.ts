import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { deleteAccountPermanently } from "../delete-account";

export const runtime = "nodejs";

const bodySchema = z.object({ confirmEmail: z.string().min(1) });

/** Permanently delete the account. Requires typing the account email back. */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `account-delete:${user.id}`, limit: 3, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "confirmEmail is required." }, { status: 400 });
  }

  const email = user.email ?? "";
  if (!email || parsed.data.confirmEmail.trim().toLowerCase() !== email.toLowerCase()) {
    return NextResponse.json({ error: "The email you typed doesn't match this account." }, { status: 400 });
  }

  await deleteAccountPermanently(user);
  return NextResponse.json({ ok: true });
}
