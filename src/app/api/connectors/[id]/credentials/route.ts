import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getConnector, isConnectorConfigured } from "@/lib/connectors";
import { encryptSecret } from "@/lib/crypto";
import { CalDavAuthError, validateCalDavCredentials } from "@/lib/apple/caldav";
import { MailAuthError, validateMailCredentials } from "@/lib/apple/mail";
import { MusicAuthError, getStorefront } from "@/lib/apple/music";

export const runtime = "nodejs";
export const maxDuration = 60;

// Link a credentials-kind connector: validate the submitted credential live
// against Apple, then store it as an encrypted JSON blob on the Connection row.
// The credential is only ever decrypted inside our MCP route — never sent out.

/** Apple Music user tokens live ~180 days; re-prompt a bit before that. */
const MUSIC_TOKEN_TTL_MS = 150 * 86_400_000;

const APP_PASSWORD_HINT =
  "Apple rejected that sign-in. Use an app-specific password (account.apple.com → Sign-In & Security → App-Specific Passwords, requires two-factor authentication), not your Apple ID password.";

function invalid(message: string) {
  return NextResponse.json({ error: "invalid_credentials", message }, { status: 401 });
}

async function upsertConnection(
  userId: string,
  provider: string,
  blob: object,
  accountLabel: string | null,
  expiresAt: Date | null
) {
  const accessToken = encryptSecret(JSON.stringify(blob));
  await prisma.connection.upsert({
    where: { userId_provider: { userId, provider } },
    create: { userId, provider, accessToken, refreshToken: null, scope: null, accountLabel, expiresAt },
    update: { accessToken, refreshToken: null, oauthClientId: null, oauthClientSecret: null, scope: null, accountLabel, expiresAt },
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const def = getConnector(id);
  if (!def || def.kind !== "credentials") return NextResponse.json({ error: "Unknown connector." }, { status: 404 });
  if (!isConnectorConfigured(def)) {
    return NextResponse.json({ error: "not_configured", message: `${def.label} isn’t set up on this server yet.` }, { status: 400 });
  }

  let body: { appleId?: unknown; appPassword?: unknown; musicUserToken?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON body." }, { status: 400 });
  }

  if (def.id === "apple-music") {
    const musicUserToken = typeof body.musicUserToken === "string" ? body.musicUserToken.trim() : "";
    if (!musicUserToken) {
      return NextResponse.json({ error: "bad_request", message: "A Music-User-Token is required." }, { status: 400 });
    }
    let storefront: string;
    try {
      storefront = await getStorefront(musicUserToken);
    } catch (err) {
      if (err instanceof MusicAuthError) return invalid("Apple Music didn’t accept that authorization. Please try signing in again.");
      console.error("[connectors] apple-music validation failed", err instanceof Error ? err.message : err);
      return NextResponse.json(
        { error: "validation_failed", message: "Couldn’t reach Apple Music to verify the authorization. Please try again." },
        { status: 502 }
      );
    }
    const accountLabel = `Apple Music · ${storefront.toUpperCase()}`;
    await upsertConnection(user.id, def.id, { musicUserToken }, accountLabel, new Date(Date.now() + MUSIC_TOKEN_TTL_MS));
    return NextResponse.json({ ok: true, accountLabel });
  }

  const appleId = typeof body.appleId === "string" ? body.appleId.trim() : "";
  const appPassword = typeof body.appPassword === "string" ? body.appPassword.trim() : "";
  if (!appleId || !appPassword) {
    return NextResponse.json({ error: "bad_request", message: "An Apple ID and app-specific password are required." }, { status: 400 });
  }

  try {
    if (def.id === "apple-calendar") await validateCalDavCredentials({ appleId, appPassword });
    else await validateMailCredentials({ appleId, appPassword });
  } catch (err) {
    if (err instanceof CalDavAuthError || err instanceof MailAuthError) return invalid(APP_PASSWORD_HINT);
    console.error("[connectors] credential validation failed", def.id, err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "validation_failed", message: "Couldn’t reach iCloud to verify the credentials. Please try again." },
      { status: 502 }
    );
  }

  await upsertConnection(user.id, def.id, { appleId, appPassword }, appleId, null);
  return NextResponse.json({ ok: true, accountLabel: appleId });
}
