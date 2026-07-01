import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getConnector, isConnectorConfigured, exchangeCodeForTokens } from "@/lib/connectors";
import { encryptSecret, verifyState } from "@/lib/crypto";

export const runtime = "nodejs";

function back(req: Request, status: "connected" | string, provider: string) {
  const url = new URL("/connections", req.url);
  if (status === "connected") url.searchParams.set("connected", provider);
  else url.searchParams.set("error", status);
  return NextResponse.redirect(url);
}

// OAuth callback: verify the signed state + nonce cookie, exchange the code for
// tokens, and store them (encrypted) as a Connection for the user.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const def = getConnector(id);
  if (!def || !isConnectorConfigured(def)) return back(req, "not_configured", id);

  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", req.url));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error") || !code || !state) return back(req, "denied", id);

  // Validate the signed state and match it to this user + connector + nonce cookie.
  const decoded = verifyState(state);
  if (!decoded) return back(req, "bad_state", id);
  let parsed: { u?: string; c?: string; n?: string };
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return back(req, "bad_state", id);
  }
  const jar = await cookies();
  const nonceCookie = jar.get(`oauth_nonce_${def.id}`)?.value;
  jar.delete(`oauth_nonce_${def.id}`);
  if (parsed.u !== user.id || parsed.c !== def.id || !parsed.n || parsed.n !== nonceCookie) {
    return back(req, "bad_state", id);
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(def, code);
  } catch {
    return back(req, "exchange_failed", id);
  }

  const accountLabel = await def.fetchAccountLabel(tokens.accessToken).catch(() => null);
  const expiresAt = tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000) : null;

  await prisma.connection.upsert({
    where: { userId_provider: { userId: user.id, provider: def.id } },
    create: {
      userId: user.id,
      provider: def.id,
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      scope: tokens.scope ?? def.scope,
      accountLabel,
      expiresAt,
    },
    update: {
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      scope: tokens.scope ?? def.scope,
      accountLabel,
      expiresAt,
    },
  });

  return back(req, "connected", def.id);
}
