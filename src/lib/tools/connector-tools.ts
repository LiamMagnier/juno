/**
 * Connector (MCP) tools, mapped into the chat tool contract (SPEC §3.4).
 *
 * `src/lib/mcp.ts` opens the connections and runs the calls; it is
 * `server-only` and shared with Work, which is why every rule it needs that
 * can be decided without a network — which connector is unavailable and why,
 * what a connect failure means, the order tools are named in, how an MCP
 * result becomes text and pixels, and what a connector tool looks like to the
 * dispatcher — lives here, pure, and is tested offline.
 */

import { classifyExternalAction, isSecretArgKey } from "@/lib/action-approval";
import { connectorImageLabel, connectorImagesDroppedText } from "@/lib/tools/connector-tools.prompt";
import type { ToolAccessHints } from "@/lib/tool-access";
import { fromActionRiskClass } from "@/lib/tools/risk";
import type { ResolvedTool } from "@/lib/tools/types";
import { evaluateConnector, type WorkConnectorUnavailableReason } from "@/lib/work/connectors";
import type { ConnectorFailure, ToolPresentArgs } from "@/types/run";

/** One connector tool call's bound, also the SDK request timeout (SPEC §4.4). */
export const CONNECTOR_TOOL_TIMEOUT_MS = 60_000;
/** Chat's budget for one connector's connect + listTools (SPEC §3.4 item 1). */
export const CHAT_CONNECT_TIMEOUT_MS = 10_000;
/** Pictures kept from one connector result (SPEC §3.4 item 4). */
export const MAX_CONNECTOR_RESULT_IMAGES = 2;

// ── Per-connector status (RC-3) ─────────────────────────────────────────────

/** What resolving one requested connector found, before any connection is tried. */
export interface ConnectorResolution {
  /** A Connection row exists for it. */
  linked: boolean;
  /** This deployment can offer it: known, configured, with an MCP endpoint. */
  configured: boolean;
  /** The stored credential: usable, unreadable (a key rotation) or expired past refreshing. */
  credential: "usable" | "unreadable" | "refresh_failed";
}

/**
 * Why a requested connector is skipped this turn, or null when it can be
 * opened. The verdict is Work's (`evaluateConnector`, the same ordering and
 * the same reasons); this narrows it to the chat vocabulary. A credential that
 * could not be decrypted is a deployment problem (`misconfigured`); one whose
 * refresh failed is the user's to fix by reconnecting (`auth_expired`).
 */
export function connectorFailureFor(resolution: ConnectorResolution): ConnectorFailure | null {
  const verdict = evaluateConnector(
    {
      id: "connector",
      label: "connector",
      locality: "cloud",
      configured: resolution.configured,
      intents: [],
      scope: { reads: [], writes: [], sensitivity: "internal", egress: "third_party" },
    },
    { linked: resolution.linked, credentialUsable: resolution.credential === "usable" },
  );
  return chatFailureOf(verdict.reason, resolution);
}

function chatFailureOf(reason: WorkConnectorUnavailableReason | null, resolution: ConnectorResolution): ConnectorFailure | null {
  switch (reason) {
    case null:
      return null;
    case "not_linked":
      return "not_linked";
    case "credential_unusable":
      return resolution.credential === "refresh_failed" ? "auth_expired" : "misconfigured";
    case "provider_unreachable":
    case "host_offline":
      return "unreachable";
    default:
      return "misconfigured";
  }
}

/**
 * What a failed connect + `listTools` means: a 401/403 is an expired or
 * revoked authorisation, a fired budget is a timeout, anything else is the
 * server not answering.
 */
export function connectFailureOf(error: unknown, budget?: AbortSignal | null): ConnectorFailure {
  if (budget?.aborted) return "timeout";
  const record = (error ?? {}) as { name?: unknown; code?: unknown; status?: unknown; message?: unknown };
  const name = typeof record.name === "string" ? record.name : "";
  if (name === "TimeoutError" || record.code === -32001) return "timeout";
  const status = typeof record.status === "number" ? record.status : typeof record.code === "number" ? record.code : null;
  if (status === 401 || status === 403) return "auth_expired";
  const message = typeof record.message === "string" ? record.message : String(error ?? "");
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]token/i.test(message)) return "auth_expired";
  if (/timed? ?out|timeout/i.test(message)) return "timeout";
  return "unreachable";
}

// ── Order (H7) ──────────────────────────────────────────────────────────────

/**
 * Tools in the order they are named and offered: by connector id, then by the
 * connector's own tool name. Connections settle in any order, so naming them
 * as they arrived gave a collision's `_1` suffix to whichever server answered
 * second, and the same turn could offer different names on a retry.
 */
export function sortConnectorTools<T extends { connectorId: string; toolName: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) =>
    a.connectorId === b.connectorId
      ? a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0
      : a.connectorId < b.connectorId ? -1 : 1,
  );
}

// ── Results (M6) ────────────────────────────────────────────────────────────

export interface FlattenedToolResult {
  /** The text the model reads, before the connector result cap is applied. */
  text: string;
  images: Array<{ mimeType: string; base64: string; label?: string }>;
  /** The server said the call failed (`isError: true`), whatever its text says. */
  isError: boolean;
}

/**
 * An MCP `CallToolResult` as text and pixels: text parts in order, resources
 * as JSON, image parts as images (at most two) rather than base64 in the text,
 * and `structuredContent` appended as pretty JSON after the text parts.
 */
export function flattenToolResult(res: unknown): FlattenedToolResult {
  const record = (res ?? {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  const images: FlattenedToolResult["images"] = [];
  const parts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const raw of record.content) {
      const part = (raw ?? {}) as { type?: unknown; text?: unknown; resource?: unknown; data?: unknown; mimeType?: unknown };
      if (part.type === "text") {
        parts.push(typeof part.text === "string" ? part.text : "");
      } else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
        if (images.length < MAX_CONNECTOR_RESULT_IMAGES) {
          images.push({ mimeType: part.mimeType, base64: part.data, label: connectorImageLabel(images.length + 1) });
        } else {
          parts.push(connectorImagesDroppedText(MAX_CONNECTOR_RESULT_IMAGES));
        }
      } else if (part.type === "resource") {
        parts.push(JSON.stringify(part.resource));
      } else {
        parts.push(JSON.stringify(raw));
      }
    }
  } else if (record.structuredContent === undefined) {
    parts.push(JSON.stringify(res));
  }
  if (record.structuredContent !== undefined && record.structuredContent !== null) {
    parts.push(JSON.stringify(record.structuredContent, null, 2));
  }
  return { text: parts.join("\n"), images, isError: record.isError === true };
}

// ── The contract shape (SPEC §3.4 item 7) ───────────────────────────────────

/** What `openMcpToolset` knows about one routed tool. */
export interface ConnectorToolRoute {
  functionName: string;
  connectorId: string;
  connectorLabel: string;
  /** The server's own name for it. */
  toolName: string;
  /** The server's own title (`title` or `annotations.title`), when it gave one. */
  title?: string;
  annotations?: ToolAccessHints;
  inputSchema?: Record<string, unknown>;
}

/** `list_calendar_events` → "List calendar events". */
export function humaniseToolName(bare: string): string {
  const words = bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.\s]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : bare;
}

const PRESENT_KEYS = 3;
const PRESENT_CHARS = 120;

/**
 * The row's display args for a connector call: at most three primitive
 * top-level arguments whose keys are not credential-shaped, each one line and
 * at most 120 characters. The values are the connector's arguments as the
 * model wrote them, shown to the person who owns the account.
 */
export function connectorPresentArgs(args: Record<string, unknown>): ToolPresentArgs {
  const out: ToolPresentArgs = {};
  let kept = 0;
  for (const [key, value] of Object.entries(args ?? {})) {
    if (kept >= PRESENT_KEYS) break;
    if (isSecretArgKey(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") {
      // eslint-disable-next-line no-control-regex
      const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, " ").trim();
      if (!flat) continue;
      out[key] = flat.length <= PRESENT_CHARS ? flat : `${flat.slice(0, PRESENT_CHARS - 1)}…`;
    } else continue;
    kept += 1;
  }
  return out;
}

/**
 * A connector tool as the dispatcher sees it. Its risk is the broker's
 * classification (an unannotated tool is `unknown`, read as `external`, which
 * asks), and it runs beside others only when that is a read — which needs the
 * server's hint and a read-shaped name to agree.
 */
export function resolvedConnectorTool(route: ConnectorToolRoute): ResolvedTool {
  const { riskClass } = classifyExternalAction({
    connectorId: route.connectorId,
    toolName: route.toolName,
    annotations: route.annotations,
  });
  const risk = fromActionRiskClass(riskClass);
  const title = route.title?.trim() || humaniseToolName(route.toolName);
  return {
    name: route.functionName,
    canonical: "mcp",
    origin: "connector",
    title,
    risk,
    parallelSafe: risk === "read",
    timeoutMs: CONNECTOR_TOOL_TIMEOUT_MS,
    dedupe: true,
    connectorId: route.connectorId,
    connectorLabel: route.connectorLabel,
    toolTitle: title,
    present: connectorPresentArgs,
    ...(route.inputSchema ? { inputSchema: route.inputSchema } : {}),
  };
}

/**
 * A broker refusal as a connector execution's typed outcome (SPEC §2.5):
 * denied and expired keep their names, a policy block is a failure coded
 * `blocked`, a Stop during the wait is a cancellation, and a refusal with no
 * receipt status (a conflict, a spent approval) is `not_permitted`.
 */
export function refusalStatusFields(
  status: string | undefined,
): { status: "failed" | "denied" | "expired" | "cancelled"; error: { code: "denied" | "expired" | "blocked" | "cancelled" | "not_permitted" } } {
  switch (status) {
    case "denied":
      return { status: "denied", error: { code: "denied" } };
    case "expired":
      return { status: "expired", error: { code: "expired" } };
    case "blocked":
      return { status: "failed", error: { code: "blocked" } };
    case "superseded":
      return { status: "cancelled", error: { code: "cancelled" } };
    default:
      return { status: "failed", error: { code: "not_permitted" } };
  }
}
