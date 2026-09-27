import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";

import { getCurrentUser } from "@/lib/session";
import { customRedirectUri } from "@/lib/custom-connectors";
import { encryptSecret, signState } from "@/lib/crypto";
import { env } from "@/lib/env";
import { buildMcpAuthorizeUrl, createPkce, discoverEndpoints, registerClient } from "@/lib/mcp-oauth";
import { customMcpUrlProblem, safeMcpFetch } from "@/lib/mcp-safe-fetch";
import { CUSTOM_NONCE_COOKIE, CUSTOM_SESSION_COOKIE, ownedConnector, type CustomOAuthSession } from "../../shared";

export const runtime = "nodejs";
export const maxDuration = 30;

function back(error: string, id?: string) {
  const url = new URL("/connections", env.appUrl);
  url.searchParams.set("error", error);
  if (id) url.searchParams.set("connector", id);
  return NextResponse.redirect(url);
}

/**
 * Starts signing in to a custom server: discover its authorization server,
 * register Juno as a client there, and send the browser to consent. Every
 * hop goes through the SSRF-safe fetcher; the authorize URL itself is only
 * ever a redirect for the person's browser, never fetched by Juno.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", env.appUrl));
  const connector = await ownedConnector(user.id, (await params).id);
  if (!connector) return back("unknown");

  let flow: { url: string; session: CustomOAuthSession };
  const nonce = randomBytes(16).toString("hex");
  try {
    const endpoints = await discoverEndpoints(connector.url, safeMcpFetch);
    if (customMcpUrlProblem(endpoints.authorizationEndpoint)) throw new Error("authorize endpoint is not public https");
    const redirectUri = customRedirectUri();
    const client = await registerClient(
      endpoints,
      { clientName: "Juno", clientUri: env.appUrl, redirectUri },
      safeMcpFetch
    );
    const pkce = createPkce();
    const state = signState(JSON.stringify({ u: user.id, c: connector.id, n: nonce }));
    flow = {
      url: buildMcpAuthorizeUrl({ endpoints, client, redirectUri, state, codeChallenge: pkce.challenge }),
      session: {
        connectorId: connector.id,
        verifier: pkce.verifier,
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        tokenEndpoint: endpoints.tokenEndpoint,
        resource: endpoints.resource,
      },
    };
  } catch (err) {
    console.error("[custom-mcp] sign-in could not start", connector.id, err instanceof Error ? err.message : err);
    return back("custom_unreachable", connector.id);
  }

  const jar = await cookies();
  const cookie = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  jar.set(CUSTOM_NONCE_COOKIE, nonce, cookie);
  jar.set(CUSTOM_SESSION_COOKIE, encryptSecret(JSON.stringify(flow.session)), cookie);
  return NextResponse.redirect(flow.url);
}
