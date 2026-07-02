import "server-only";
import { createHash, randomBytes } from "crypto";

/*
 * OAuth 2.1 client for hosted remote MCP servers (e.g. Notion at
 * https://mcp.notion.com/mcp).
 *
 * A hosted MCP server is not an OAuth app you register by hand — it advertises
 * its own authorization server and lets clients register themselves on the fly.
 * The full handshake:
 *
 *   1. Protected Resource Metadata (RFC 9728) — the MCP URL points at the
 *      authorization server(s) that protect it.
 *   2. Authorization Server Metadata (RFC 8414) — that server's authorize /
 *      token / registration endpoints.
 *   3. Dynamic Client Registration (RFC 7591) — register a public PKCE client
 *      and get a client_id (no developer dashboard, no pre-shared secret).
 *   4. Authorization Code + PKCE, sending the MCP URL as the `resource`
 *      parameter (RFC 8707) so the issued token is bound to this server.
 *
 * This module is pure transport: it knows nothing about connectors or the DB.
 * The caller persists the registered client so tokens can be refreshed later
 * (access tokens are short-lived — Notion's expire after one hour).
 */

export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
}

export interface McpOAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** Canonical MCP resource URL the token is bound to (RFC 8707). */
  resource: string;
}

export interface McpTokens {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiresInSec?: number;
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

type ProtectedResourceMetadata = { authorization_servers?: string[] };
type AuthServerMetadata = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
};
type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Fresh PKCE verifier + S256 challenge (RFC 7636). */
export function createPkce(): Pkce {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Well-known metadata URLs for an issuer/resource, most-specific first: the
 * RFC 8414 / RFC 9728 path-insertion form (…/.well-known/<name>/<path>) for
 * issuers that live under a path, then the origin-root form (…/.well-known/<name>)
 * that many servers actually serve (e.g. Notion). Trying both keeps us
 * spec-conformant for path-based authorization servers without breaking the
 * common root-hosted case.
 */
function wellKnownCandidates(base: string, name: string): URL[] {
  const u = new URL(base);
  const path = u.pathname.replace(/\/+$/, "");
  const urls: URL[] = [];
  if (path) urls.push(new URL(`/.well-known/${name}${path}`, u.origin));
  urls.push(new URL(`/.well-known/${name}`, u.origin));
  return urls;
}

/** Fetch JSON metadata, trying each well-known candidate until one responds. */
async function fetchMetadata<T>(base: string, name: string, what: string): Promise<T> {
  let lastError: unknown;
  for (const url of wellKnownCandidates(base, name)) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.ok) return (await res.json()) as T;
      lastError = new Error(`${what} at ${url.href} returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${what}`);
}

/** Canonical MCP URL used as the OAuth `resource` (RFC 8707): no fragment. */
function canonicalResource(mcpUrl: string): string {
  const u = new URL(mcpUrl);
  u.hash = "";
  return u.toString();
}

/**
 * Discover the authorization server behind an MCP URL (RFC 9728 → RFC 8414).
 * Falls back to treating the MCP origin itself as the issuer when the server
 * doesn't advertise a separate authorization server.
 */
export async function discoverEndpoints(mcpUrl: string): Promise<McpOAuthEndpoints> {
  let issuer = new URL(mcpUrl).origin;
  try {
    const prm = await fetchMetadata<ProtectedResourceMetadata>(mcpUrl, "oauth-protected-resource", "protected resource metadata");
    if (prm.authorization_servers?.[0]) issuer = prm.authorization_servers[0];
  } catch {
    // No protected-resource metadata — assume the MCP origin is its own issuer.
  }

  const meta = await fetchMetadata<AuthServerMetadata>(issuer, "oauth-authorization-server", "authorization server metadata");
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error("MCP authorization server metadata is missing required endpoints");
  }
  return {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
    resource: canonicalResource(mcpUrl),
  };
}

/** Register a public PKCE client via Dynamic Client Registration (RFC 7591). */
export async function registerClient(
  endpoints: McpOAuthEndpoints,
  opts: { clientName: string; clientUri: string; redirectUri: string }
): Promise<McpOAuthClient> {
  if (!endpoints.registrationEndpoint) {
    throw new Error("MCP authorization server does not support Dynamic Client Registration");
  }
  const res = await fetch(endpoints.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: opts.clientName,
      client_uri: opts.clientUri,
      redirect_uris: [opts.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`MCP client registration failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as { client_id?: string; client_secret?: string };
  if (!data.client_id) throw new Error("MCP client registration returned no client_id");
  return { clientId: data.client_id, clientSecret: data.client_secret };
}

/** Build the authorization-request URL (auth code + PKCE + resource binding). */
export function buildMcpAuthorizeUrl(opts: {
  endpoints: McpOAuthEndpoints;
  client: McpOAuthClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const u = new URL(opts.endpoints.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.client.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", opts.endpoints.resource);
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

function parseTokens(data: TokenResponse): McpTokens {
  if (!data.access_token) throw new Error(data.error_description || data.error || "MCP server returned no access token");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope,
    expiresInSec: data.expires_in,
  };
}

async function postToken(tokenEndpoint: string, body: URLSearchParams, what: string): Promise<McpTokens> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Juno-MCP-Client/1.0",
    },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`MCP ${what} failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  return parseTokens((await res.json()) as TokenResponse);
}

/** Exchange an authorization code for tokens (auth-code + PKCE). */
export function exchangeMcpCode(opts: {
  tokenEndpoint: string;
  client: McpOAuthClient;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
}): Promise<McpTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.client.clientId,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    resource: opts.resource,
  });
  if (opts.client.clientSecret) body.set("client_secret", opts.client.clientSecret);
  return postToken(opts.tokenEndpoint, body, "token exchange");
}

/** Exchange a refresh token for a fresh access token. */
export function refreshMcpToken(opts: {
  tokenEndpoint: string;
  client: McpOAuthClient;
  refreshToken: string;
  resource: string;
}): Promise<McpTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.client.clientId,
    resource: opts.resource,
  });
  if (opts.client.clientSecret) body.set("client_secret", opts.client.clientSecret);
  return postToken(opts.tokenEndpoint, body, "token refresh");
}
