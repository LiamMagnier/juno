import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { appleMusicDeveloperToken, isAppleMusicConfigured } from "@/lib/apple/music-token";

export const runtime = "nodejs";

// Short-lived MusicKit developer token for the browser: MusicKit JS needs it to
// run music.authorize() and mint the Music-User-Token we actually store.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAppleMusicConfigured()) {
    return NextResponse.json({ error: "not_configured", message: "Apple Music isn’t set up on this server yet." }, { status: 400 });
  }
  try {
    return NextResponse.json({ token: await appleMusicDeveloperToken() });
  } catch (err) {
    console.error("[connectors] apple-music dev token failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "token_failed", message: "Couldn’t mint an Apple Music developer token." }, { status: 500 });
  }
}
