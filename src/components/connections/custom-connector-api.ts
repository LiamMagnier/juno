/**
 * The browser's side of custom MCP servers (`/api/connectors/custom/*`).
 * Shapes mirror `CustomConnectorView` in src/lib/custom-connectors.ts.
 */

export type ToolAccess = "read" | "write" | "unknown";

export interface CustomConnectorTool {
  name: string;
  title?: string;
  description?: string;
  access: ToolAccess;
}

export interface CustomConnector {
  id: string;
  name: string;
  url: string;
  host: string;
  description: string | null;
  serverName: string | null;
  connected: boolean;
  connectedAt: string | null;
  disabledTools: string[];
  tools: CustomConnectorTool[] | null;
  toolsCheckedAt: string | null;
  createdAt: string;
}

export type ProbeResponse =
  | {
      ok: true;
      url: string;
      host: string;
      authHost: string;
      suggestedName: string;
      existing: { id: string; name: string } | null;
    }
  | { ok: false; url?: string; reason: string; message: string };

export class CustomConnectorError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

async function call<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new CustomConnectorError(data.message ?? "Something went wrong. Try again.", data.error ?? `http_${res.status}`);
  }
  return data;
}

export const customConnectorPath = (id: string) => `/api/connectors/custom/${encodeURIComponent(id)}`;

export function probeCustomConnector(url: string, signal?: AbortSignal) {
  return call<ProbeResponse>("/api/connectors/custom/probe", { method: "POST", body: JSON.stringify({ url }), signal });
}

export function createCustomConnector(url: string, name: string) {
  return call<{ connector: CustomConnector; connectUrl: string; existing?: boolean }>("/api/connectors/custom", {
    method: "POST",
    body: JSON.stringify({ url, name }),
  });
}

export function getCustomConnector(id: string) {
  return call<{ connector: CustomConnector }>(customConnectorPath(id));
}

export function updateCustomConnector(id: string, patch: { name?: string; disabledTools?: string[] }) {
  return call<{ connector: CustomConnector }>(customConnectorPath(id), { method: "PATCH", body: JSON.stringify(patch) });
}

export function removeCustomConnector(id: string) {
  return call<{ ok: true }>(customConnectorPath(id), { method: "DELETE" });
}

export function refreshCustomConnectorTools(id: string) {
  return call<{ connector: CustomConnector }>(`${customConnectorPath(id)}/tools`, { method: "POST" });
}

/** Full navigation: sign-in leaves Juno for the server's consent page and comes back. */
export function beginCustomConnectorSignIn(id: string) {
  window.location.href = `${customConnectorPath(id)}/connect`;
}

/** A server's monogram: the first letter or digit of its name. */
export function monogram(name: string): string {
  const match = name.trim().match(/[\p{L}\p{N}]/u);
  return (match?.[0] ?? "M").toUpperCase();
}
