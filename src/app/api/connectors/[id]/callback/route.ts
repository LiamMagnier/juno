import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getConnector, isConnectorConfigured, exchangeCodeForTokens, DEFAULT_TOKEN_TTL_MS, type ConnectorOAuthSession } from "@/lib/connectors";
import { decryptSecret, encryptSecret, verifyState } from "@/lib/crypto";

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
  const providerError = url.searchParams.get("error");
  if (providerError || !code || !state) {
    if (providerError) console.error("[connectors] provider returned error", def.id, providerError, url.searchParams.get("error_description"));
    return back(req, "denied", id);
  }

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

  // mcp_oauth flows stashed their PKCE verifier + registered client here.
  let session: ConnectorOAuthSession | undefined;
  const sessionCookie = jar.get(`oauth_session_${def.id}`)?.value;
  jar.delete(`oauth_session_${def.id}`);
  if (sessionCookie) {
    try {
      session = JSON.parse(decryptSecret(sessionCookie)) as ConnectorOAuthSession;
    } catch {
      return back(req, "bad_state", id);
    }
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(def, code, session);
  } catch (err) {
    console.error("[connectors] token exchange failed", def.id, err instanceof Error ? err.message : err);
    return back(req, "exchange_failed", id);
  }

  const accountLabel = await def.fetchAccountLabel(tokens.accessToken).catch(() => null);
  // A refreshable token (one that came with a refresh token) must carry a future
  // expiry so proactive refresh stays armed; fall back to a default TTL when the
  // provider omits expires_in. Non-refreshable tokens (e.g. GitHub) stay null so
  // they're never treated as expiring.
  const expiresAt = tokens.expiresInSec
    ? new Date(Date.now() + tokens.expiresInSec * 1000)
    : tokens.refreshToken
      ? new Date(Date.now() + DEFAULT_TOKEN_TTL_MS)
      : null;
  // Persist the dynamically-registered client so mcp_oauth tokens can be
  // refreshed later (the same client that obtained them must refresh them).
  const oauthClientId = session?.clientId ?? null;
  const oauthClientSecret = session?.clientSecret ? encryptSecret(session.clientSecret) : null;

  await prisma.connection.upsert({
    where: { userId_provider: { userId: user.id, provider: def.id } },
    create: {
      userId: user.id,
      provider: def.id,
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      oauthClientId,
      oauthClientSecret,
      scope: tokens.scope ?? def.scope,
      accountLabel,
      expiresAt,
    },
    update: {
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      oauthClientId,
      oauthClientSecret,
      scope: tokens.scope ?? def.scope,
      accountLabel,
      expiresAt,
    },
  });

  return back(req, "connected", def.id);
}
