import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getCurrentUser } from "@/lib/session";
import { DEFAULT_TOKEN_TTL_MS } from "@/lib/connectors";
import { customRedirectUri, refreshCustomConnectorTools } from "@/lib/custom-connectors";
import { decryptSecret, encryptSecret, verifyState } from "@/lib/crypto";
import { env } from "@/lib/env";
import { exchangeMcpCode } from "@/lib/mcp-oauth";
import { safeMcpFetch } from "@/lib/mcp-safe-fetch";
import { prisma } from "@/lib/prisma";
import { CUSTOM_NONCE_COOKIE, CUSTOM_SESSION_COOKIE, type CustomOAuthSession } from "../shared";

export const runtime = "nodejs";
export const maxDuration = 30;

function back(status: "connected" | string, id?: string) {
  const url = new URL("/connections", env.appUrl);
  if (status === "connected" && id) url.searchParams.set("connected", id);
  else {
    url.searchParams.set("error", status);
    if (id) url.searchParams.set("connector", id);
  }
  return NextResponse.redirect(url);
}

/**
 * One callback for every custom server (the redirect URI Juno registered with
 * each). The signed state names the user and connector; the nonce cookie ties
 * it to this browser; the encrypted session cookie carries the PKCE verifier
 * and the client Juno registered, which never reach the browser in the clear.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", env.appUrl));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const jar = await cookies();
  const nonceCookie = jar.get(CUSTOM_NONCE_COOKIE)?.value;
  const sessionCookie = jar.get(CUSTOM_SESSION_COOKIE)?.value;
  jar.delete(CUSTOM_NONCE_COOKIE);
  jar.delete(CUSTOM_SESSION_COOKIE);

  const decoded = state ? verifyState(state) : null;
  let parsed: { u?: string; c?: string; n?: string } = {};
  try {
    parsed = decoded ? JSON.parse(decoded) : {};
  } catch {
    parsed = {};
  }
  if (url.searchParams.get("error")) return back("denied", parsed.c);
  if (!code || !decoded || parsed.u !== user.id || !parsed.n || parsed.n !== nonceCookie || !sessionCookie) {
    return back("bad_state", parsed.c);
  }

  let session: CustomOAuthSession;
  try {
    session = JSON.parse(decryptSecret(sessionCookie)) as CustomOAuthSession;
  } catch {
    return back("bad_state", parsed.c);
  }
  if (session.connectorId !== parsed.c) return back("bad_state", parsed.c);
  const connector = await prisma.customConnector.findFirst({ where: { id: session.connectorId, userId: user.id } });
  if (!connector) return back("unknown");

  let tokens;
  try {
    tokens = await exchangeMcpCode(
      {
        tokenEndpoint: session.tokenEndpoint,
        client: { clientId: session.clientId, clientSecret: session.clientSecret },
        code,
        codeVerifier: session.verifier,
        redirectUri: customRedirectUri(),
        resource: session.resource,
      },
      safeMcpFetch
    );
  } catch (err) {
    console.error("[custom-mcp] token exchange failed", connector.id, err instanceof Error ? err.message : err);
    return back("exchange_failed", connector.id);
  }

  const expiresAt = tokens.expiresInSec
    ? new Date(Date.now() + tokens.expiresInSec * 1000)
    : tokens.refreshToken
      ? new Date(Date.now() + DEFAULT_TOKEN_TTL_MS)
      : null;
  const data = {
    accessToken: encryptSecret(tokens.accessToken),
    refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
    oauthClientId: session.clientId,
    oauthClientSecret: session.clientSecret ? encryptSecret(session.clientSecret) : null,
    scope: tokens.scope ?? null,
    accountLabel: connector.name,
    expiresAt,
  };
  await prisma.connection.upsert({
    where: { userId_provider: { userId: user.id, provider: connector.id } },
    create: { userId: user.id, provider: connector.id, ...data },
    update: data,
  });

  // Best effort: the page can show what it can do the moment it lands. A slow
  // server just means the list fills in on the connector's own page.
  await refreshCustomConnectorTools(connector, tokens.accessToken).catch((err) => {
    console.warn("[custom-mcp] first tools/list failed", connector.id, err instanceof Error ? err.message : err);
  });
  return back("connected", connector.id);
}
