import "server-only";
import { env } from "@/lib/env";
import {
  buildMcpAuthorizeUrl,
  createPkce,
  discoverEndpoints,
  exchangeMcpCode,
  refreshMcpToken,
  registerClient,
} from "@/lib/mcp-oauth";

/*
 * Registry of external tool connectors the user can link. Three shapes exist:
 *
 *  - "oauth_app"    — a classic OAuth 2.0 app you register once with the provider
 *    (GitHub, Figma). Its Connect button appears only when a client id + secret
 *    are configured in the environment.
 *  - "mcp_oauth"    — a hosted remote MCP server that self-registers via OAuth 2.1
 *    + PKCE + Dynamic Client Registration (Notion). Nothing to pre-register:
 *    it's "available" as soon as its MCP URL is known. See lib/mcp-oauth.ts.
 *  - "credentials"  — no OAuth at all (Apple Calendar/Mail/Music). The user hands
 *    us a credential (an app-specific password or a MusicKit user token) which is
 *    stored encrypted; tools are served by our own MCP route (app/api/mcp/[connector])
 *    and the model authenticates to it with a short-lived signed token
 *    (lib/connector-token.ts) — the raw credential never leaves the server.
 *
 * Once linked, the stored access token is handed to the model as a remote MCP
 * server (see lib/mcp.ts) so it can call the provider's tools as the user.
 */

export type ConnectorId = "github" | "figma" | "notion" | "apple-calendar" | "apple-mail" | "apple-music";
export type ConnectorKind = "oauth_app" | "mcp_oauth" | "credentials";

export interface ConnectorTokens {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiresInSec?: number;
}

/**
 * Fallback access-token lifetime for a refreshable connector whose provider
 * omits `expires_in` (RFC 6749 allows this, especially on the refresh grant).
 * Without a concrete expiry we still want proactive refresh armed, so we assume
 * a short life rather than treating the token as non-expiring (~Notion's 1h).
 */
export const DEFAULT_TOKEN_TTL_MS = 60 * 60_000;

export interface ConnectorDef {
  id: ConnectorId;
  kind: ConnectorKind;
  label: string;
  description: string;
  /** One-liner about what the model can do once connected. */
  capability: string;
  /** Provider OAuth endpoints (unused for mcp_oauth — discovered at run time). */
  authorizeUrl: string;
  tokenUrl: string;
  /** OAuth2 refresh endpoint, when the provider issues expiring tokens (Figma). */
  refreshUrl?: string;
  scope: string;
  /** How client credentials are sent on token/refresh calls. Figma requires HTTP
   *  Basic auth; GitHub accepts them in the form body. */
  authStyle: "body" | "basic";
  /** Registered OAuth app credentials plus the remote MCP endpoint to expose. */
  cfg: { apiKey?: string; clientId?: string; clientSecret?: string; scope?: string; mcpUrl?: string };
  /** Best-effort account handle fetched right after linking (for display only). */
  fetchAccountLabel(accessToken: string): Promise<string | null>;
}

/**
 * Transient per-flow secrets for an mcp_oauth handshake, carried from the
 * connect redirect to the callback in a short-lived, encrypted cookie. The
 * dynamically-registered client is also persisted on the Connection so tokens
 * can be refreshed after the flow ends.
 */
export interface ConnectorOAuthSession {
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  resource: string;
}

const CONNECTORS: Record<ConnectorId, ConnectorDef> = {
  github: {
    id: "github",
    kind: "oauth_app",
    label: "GitHub",
    description: "Read your repositories, issues, and pull requests.",
    capability: "Let the model browse your code, issues, and PRs.",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "repo read:user",
    authStyle: "body",
    cfg: env.connectors.github,
    async fetchAccountLabel(accessToken) {
      try {
        const r = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "Juno" },
        });
        if (!r.ok) return null;
        const d = (await r.json()) as { login?: string };
        return d.login ?? null;
      } catch {
        return null;
      }
    },
  },
  figma: {
    id: "figma",
    kind: "oauth_app",
    label: "Figma",
    description: "Read your design files, frames, and components.",
    capability: "Let the model read your Figma designs and components.",
    authorizeUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    refreshUrl: "https://api.figma.com/v1/oauth/refresh",
    // New Figma OAuth: granular, colon-namespaced scopes (old "file_read" is gone).
    // Must match what's enabled in the app's "OAuth scopes" tab; override via env.
    scope: env.connectors.figma.scope || "file_content:read",
    authStyle: "basic",
    cfg: env.connectors.figma,
    async fetchAccountLabel(accessToken) {
      try {
        const r = await fetch("https://api.figma.com/v1/me", { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!r.ok) return null;
        const d = (await r.json()) as { handle?: string; email?: string };
        return d.handle ?? d.email ?? null;
      } catch {
        return null;
      }
    },
  },
  notion: {
    id: "notion",
    kind: "mcp_oauth",
    label: "Notion",
    description: "Search, read, and update pages, docs, and databases.",
    capability: "Let the model work with your Notion pages, tasks, and databases through the Notion MCP server.",
    // Endpoints are discovered from the MCP server at run time — no fixed URLs.
    authorizeUrl: "",
    tokenUrl: "",
    scope: "",
    authStyle: "body",
    cfg: env.connectors.notion,
    async fetchAccountLabel() {
      // Notion MCP tokens are scoped to the MCP server, not the public REST
      // /users/me endpoint, so there's no reliable handle to show here.
      return null;
    },
  },
  "apple-calendar": {
    id: "apple-calendar",
    kind: "credentials",
    label: "Apple Calendar",
    description: "Read and manage events on your iCloud calendars.",
    capability: "Let the model check your schedule and add events to your iCloud calendars.",
    // No OAuth — the user provides an app-specific password; tools are served
    // by our own MCP route.
    authorizeUrl: "",
    tokenUrl: "",
    scope: "",
    authStyle: "body",
    cfg: { mcpUrl: `${env.appUrl.replace(/\/$/, "")}/api/mcp/apple-calendar` },
    async fetchAccountLabel() {
      return null;
    },
  },
  "apple-mail": {
    id: "apple-mail",
    kind: "credentials",
    label: "Apple Mail",
    description: "Search and read mail in your iCloud mailboxes.",
    capability: "Let the model find messages, read them, and check unread counts in iCloud Mail.",
    authorizeUrl: "",
    tokenUrl: "",
    scope: "",
    authStyle: "body",
    cfg: { mcpUrl: `${env.appUrl.replace(/\/$/, "")}/api/mcp/apple-mail` },
    async fetchAccountLabel() {
      return null;
    },
  },
  "apple-music": {
    id: "apple-music",
    kind: "credentials",
    label: "Apple Music",
    description: "Search the catalog and work with your playlists.",
    capability: "Let the model search Apple Music, browse your playlists, and add songs to them.",
    authorizeUrl: "",
    tokenUrl: "",
    scope: "",
    authStyle: "body",
    cfg: { mcpUrl: `${env.appUrl.replace(/\/$/, "")}/api/mcp/apple-music` },
    async fetchAccountLabel() {
      return null;
    },
  },
};

export function getConnector(id: string): ConnectorDef | undefined {
  return (CONNECTORS as Record<string, ConnectorDef>)[id];
}

export function listConnectors(): ConnectorDef[] {
  return Object.values(CONNECTORS);
}

/**
 * A connector is "configured" (a Connect button appears) when it can start a
 * flow: an oauth_app needs its client credentials; an mcp_oauth connector only
 * needs to know its MCP URL — it registers itself on the fly. Credentials
 * connectors have nothing to pre-register, except Apple Music, which needs
 * MusicKit developer keys to mint tokens.
 */
export function isConnectorConfigured(def: ConnectorDef): boolean {
  if (def.kind === "credentials") {
    if (def.id === "apple-music") {
      const m = env.connectors.appleMusic;
      return Boolean(m.teamId && m.keyId && m.privateKey);
    }
    return true;
  }
  if (def.kind === "mcp_oauth") return Boolean(def.cfg.mcpUrl);
  return Boolean(def.cfg.clientId && def.cfg.clientSecret);
}

export function connectorRedirectUri(id: ConnectorId): string {
  return `${env.appUrl.replace(/\/$/, "")}/api/connectors/${id}/callback`;
}

/**
 * Build the provider's authorize URL for the OAuth redirect. For mcp_oauth this
 * also discovers + registers a client and returns the per-flow session secrets
 * the callback needs to complete the exchange.
 */
export async function buildAuthorizeUrl(
  def: ConnectorDef,
  state: string
): Promise<{ url: string; session?: ConnectorOAuthSession }> {
  if (def.kind === "credentials") throw new Error(`${def.label} links with credentials, not OAuth`);
  if (def.kind === "mcp_oauth") {
    if (!def.cfg.mcpUrl) throw new Error(`${def.label} is missing an MCP URL`);
    const redirectUri = connectorRedirectUri(def.id);
    const endpoints = await discoverEndpoints(def.cfg.mcpUrl);
    const client = await registerClient(endpoints, { clientName: "Juno", clientUri: env.appUrl, redirectUri });
    const pkce = createPkce();
    const url = buildMcpAuthorizeUrl({ endpoints, client, redirectUri, state, codeChallenge: pkce.challenge });
    return {
      url,
      session: {
        codeVerifier: pkce.verifier,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        tokenEndpoint: endpoints.tokenEndpoint,
        resource: endpoints.resource,
      },
    };
  }

  const u = new URL(def.authorizeUrl);
  u.searchParams.set("client_id", def.cfg.clientId!);
  u.searchParams.set("redirect_uri", connectorRedirectUri(def.id));
  u.searchParams.set("scope", def.scope);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  return { url: u.toString() };
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

/** Normalize a provider's token response, throwing a useful error when it fails. */
function toTokens(data: TokenResponse): ConnectorTokens {
  if (!data.access_token) throw new Error(data.error_description || data.error || "No access token returned");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // may be absent on refresh — caller keeps the old one
    scope: data.scope,
    expiresInSec: data.expires_in,
  };
}

/** Build token-request headers, putting client creds where the provider wants
 *  them (Basic auth header for Figma, form body for GitHub). */
function tokenRequestHeaders(def: ConnectorDef, body: URLSearchParams): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (def.authStyle === "basic") {
    headers.Authorization = "Basic " + Buffer.from(`${def.cfg.clientId}:${def.cfg.clientSecret}`).toString("base64");
  } else {
    body.set("client_id", def.cfg.clientId!);
    body.set("client_secret", def.cfg.clientSecret!);
  }
  return headers;
}

/** Exchange an authorization code for tokens. mcp_oauth uses the per-flow
 *  session; oauth_app uses the standard auth-code exchange. */
export async function exchangeCodeForTokens(
  def: ConnectorDef,
  code: string,
  session?: ConnectorOAuthSession
): Promise<ConnectorTokens> {
  if (def.kind === "credentials") throw new Error(`${def.label} links with credentials, not OAuth`);
  if (def.kind === "mcp_oauth") {
    if (!session?.codeVerifier || !session.clientId || !session.tokenEndpoint) throw new Error("Missing MCP OAuth session");
    return exchangeMcpCode({
      tokenEndpoint: session.tokenEndpoint,
      client: { clientId: session.clientId, clientSecret: session.clientSecret },
      code,
      codeVerifier: session.codeVerifier,
      redirectUri: connectorRedirectUri(def.id),
      resource: session.resource,
    });
  }

  const body = new URLSearchParams({
    code,
    redirect_uri: connectorRedirectUri(def.id),
    grant_type: "authorization_code",
  });
  const res = await fetch(def.tokenUrl, { method: "POST", headers: tokenRequestHeaders(def, body), body });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  return toTokens((await res.json()) as TokenResponse);
}

/** Exchange a refresh token for a fresh access token. mcp_oauth re-discovers its
 *  token endpoint and refreshes with the client stored at link time; oauth_app
 *  uses its static refresh endpoint. */
export async function refreshTokens(
  def: ConnectorDef,
  refreshToken: string,
  oauthClient?: { clientId?: string | null; clientSecret?: string | null }
): Promise<ConnectorTokens> {
  if (def.kind === "credentials") throw new Error(`${def.label} does not use OAuth tokens`);
  if (def.kind === "mcp_oauth") {
    if (!def.cfg.mcpUrl) throw new Error(`${def.label} is missing an MCP URL`);
    if (!oauthClient?.clientId) throw new Error(`${def.label} is missing its registered OAuth client`);
    const endpoints = await discoverEndpoints(def.cfg.mcpUrl);
    return refreshMcpToken({
      tokenEndpoint: endpoints.tokenEndpoint,
      client: { clientId: oauthClient.clientId, clientSecret: oauthClient.clientSecret ?? undefined },
      refreshToken,
      resource: endpoints.resource,
    });
  }

  if (!def.refreshUrl) throw new Error(`${def.label} does not support token refresh`);
  const body = new URLSearchParams({ refresh_token: refreshToken, grant_type: "refresh_token" });
  const res = await fetch(def.refreshUrl, { method: "POST", headers: tokenRequestHeaders(def, body), body });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status})`);
  return toTokens((await res.json()) as TokenResponse);
}
