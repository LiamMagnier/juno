import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { channelProvider } from "@/lib/channels/config";
import { channelLinkFor, unlinkChannel } from "@/lib/channels/store";

export const runtime = "nodejs";

/**
 * Settings' iMessage row: whether the server offers it, and the account's
 * link (its status and last four digits, never the number). Off, it answers
 * `{ configured: false, link: null }` and the row is not drawn.
 */
export async function GET() {
  const { user, error } = await requireUser();
  if (!user) return error;
  const provider = channelProvider();
  if (!provider) return NextResponse.json({ configured: false, link: null });
  try {
    return NextResponse.json({ configured: true, link: await channelLinkFor(user.id, provider.id) });
  } catch {
    console.error("[channels] link read failed");
    return NextResponse.json({ error: "read_failed", message: "Your iMessage link could not be loaded. Try again." }, { status: 500 });
  }
}

/** Unlinks the account's number (and any code still waiting). Texts to it reach nobody after this. */
export async function DELETE() {
  const { user, error } = await requireUser();
  if (!user) return error;
  const provider = channelProvider();
  if (!provider) return NextResponse.json({ error: "not_configured", message: "iMessage is not set up on this server." }, { status: 404 });
  try {
    await unlinkChannel(user.id, provider.id);
    return NextResponse.json({ configured: true, link: null });
  } catch {
    console.error("[channels] unlink failed");
    return NextResponse.json({ error: "unlink_failed", message: "The number could not be unlinked. Try again." }, { status: 500 });
  }
}
