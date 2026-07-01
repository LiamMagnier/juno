import "server-only";
import { env } from "@/lib/env";

/*
 * Registry of external tool connectors the user can link via OAuth. A connector
 * becomes "available" (a Connect button appears) only when its OAuth client id +
 * secret are configured. Once linked, the stored token is exposed to the model
 * as a remote MCP server (see Phase 2 chat wiring).
 */

export type ConnectorId = "github" | "figma";

export interface ConnectorTokens {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiresInSec?: number;
}

export interface ConnectorDef {
  id: ConnectorId;
  label: string;
  description: string;
  /** Marketing-y one-liner about what the model can do once connected. */
  capability: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  cfg: { clientId?: string; clientSecret?: string; mcpUrl?: string };
  /** Best-effort human label (account handle) fetched after linking. */
  fetchAccountLabel(accessToken: string): Promise<string | null>;
}

const CONNECTORS: Record<ConnectorId, ConnectorDef> = {
  github: {
    id: "github",
    label: "GitHub",
    description: "Read your repositories, issues, and pull requests.",
    capability: "Let the model browse your code, issues, and PRs.",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "repo read:user",
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
    label: "Figma",
    description: "Read your design files, frames, and components.",
    capability: "Let the model read your Figma designs and components.",
    authorizeUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    scope: "file_read",
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
};

export function getConnector(id: string): ConnectorDef | undefined {
  return (CONNECTORS as Record<string, ConnectorDef>)[id];
}

export function listConnectors(): ConnectorDef[] {
  return Object.values(CONNECTORS);
}

/** A connector is configured when its OAuth app credentials are present. */
export function isConnectorConfigured(def: ConnectorDef): boolean {
  return Boolean(def.cfg.clientId && def.cfg.clientSecret);
}

export function connectorRedirectUri(id: ConnectorId): string {
  return `${env.appUrl.replace(/\/$/, "")}/api/connectors/${id}/callback`;
}

/** Build the provider's authorize URL for the OAuth redirect. */
export function buildAuthorizeUrl(def: ConnectorDef, state: string): string {
  const u = new URL(def.authorizeUrl);
  u.searchParams.set("client_id", def.cfg.clientId!);
  u.searchParams.set("redirect_uri", connectorRedirectUri(def.id));
  u.searchParams.set("scope", def.scope);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  return u.toString();
}

/** Exchange an authorization code for tokens (generic OAuth2 auth-code flow). */
export async function exchangeCodeForTokens(def: ConnectorDef, code: string): Promise<ConnectorTokens> {
  const body = new URLSearchParams({
    client_id: def.cfg.clientId!,
    client_secret: def.cfg.clientSecret!,
    code,
    redirect_uri: connectorRedirectUri(def.id),
    grant_type: "authorization_code",
  });
  const res = await fetch(def.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!data.access_token) throw new Error(data.error_description || data.error || "No access token returned");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope,
    expiresInSec: data.expires_in,
  };
}
