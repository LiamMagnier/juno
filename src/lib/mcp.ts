import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prisma } from "@/lib/prisma";
import { DEFAULT_TOKEN_TTL_MS, getConnector, isConnectorConfigured, refreshTokens, type ConnectorDef } from "@/lib/connectors";
import { mintConnectorToken } from "@/lib/connector-token";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { composioSlugFromId, isComposioAppId } from "@/lib/composio";
import { env, isComposioConfigured } from "@/lib/env";
import { wrapUntrusted } from "@/lib/untrusted-content";
import { truncateConnectorResult, type TruncatedForModel } from "@/lib/work/connectors";
import { classifyToolAccess, type ToolAccess, type ToolAccessHints } from "@/lib/tool-access";
import { recordToolInvocation, settleToolInvocation } from "@/lib/tool-audit";
import { authorizeExternalAction, completeExternalAction } from "@/lib/action-approval-store";
import type { ClientActionApproval } from "@/lib/action-approval";
import {
  connectFailureOf,
  connectorFailureFor,
  flattenToolResult,
  refusalStatusFields,
  sortConnectorTools,
  type ConnectorResolution,
  type ConnectorToolRoute,
} from "@/lib/tools/connector-tools";
import type { ClientSource } from "@/types/chat";
import type { ConnectorFailure, ToolErrorCode, ToolFigure, ToolWebDetail } from "@/types/run";
import type { Connection } from "@prisma/client";

/*
 * Bridges linked connectors (see connectors.ts) to the model at generation time.
 *
 * Every provider now takes the same route: Juno connects to the MCP servers
 * here, exposes their tools as OpenAI-style function tools, and runs the tool
 * loop itself. Anthropic used to be the exception — its connectors were passed
 * as native `mcp_servers` and Claude called them server-side, holding a
 * Juno-minted bearer token. That path was fast and gave Juno no seam: the call
 * happened between Anthropic and the connector, so no permission check, no
 * approval receipt, and no audit row could sit in front of it. One provider
 * being able to act on a user's accounts without passing the broker makes the
 * broker advisory, so the native path is gone. `scripts/check-approval-dispatch.mjs`
 * fails the build if any part of it returns.
 */

export interface ActiveConnector {
  id: string;
  label: string;
  mcpUrl: string;
  headers: Record<string, string>;
}

// Refresh a few minutes before expiry so MCP tokens don't die mid-request.
const EXPIRY_SKEW_MS = 5 * 60_000;

/** Refresh an expiring token, persist the new one, and return it (null on failure). */
async function refreshConnection(def: ConnectorDef, row: Connection): Promise<string | null> {
  if (!row.refreshToken) return null;
  // oauth_app connectors need a static refresh endpoint; mcp_oauth refreshes via
  // its discovered token endpoint + the client we registered at link time.
  if (def.kind !== "mcp_oauth" && !def.refreshUrl) return null;
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(row.refreshToken);
  } catch {
    return null;
  }
  let oauthClientSecret: string | null = null;
  if (row.oauthClientSecret) {
    try {
      oauthClientSecret = decryptSecret(row.oauthClientSecret);
    } catch {
      return null;
    }
  }
  try {
    const t = await refreshTokens(def, refreshToken, { clientId: row.oauthClientId, clientSecret: oauthClientSecret });
    await prisma.connection.update({
      where: { id: row.id, userId: row.userId },
      data: {
        accessToken: encryptSecret(t.accessToken),
        // Providers may or may not rotate the refresh token — keep the old one if not.
        refreshToken: t.refreshToken ? encryptSecret(t.refreshToken) : row.refreshToken,
        scope: t.scope ?? row.scope,
        // We just refreshed a refreshable token, so it IS expiring — never write
        // null (that would disable all future proactive refreshes). Fall back to
        // a default TTL when the provider omits expires_in.
        expiresAt: new Date(Date.now() + (t.expiresInSec ? t.expiresInSec * 1000 : DEFAULT_TOKEN_TTL_MS)),
      },
    });
    return t.accessToken;
  } catch {
    return null;
  }
}

/**
 * One linked connector resolved to an endpoint, or the reason it cannot be.
 * Shared by `getActiveConnectors` (Work's array, unchanged) and
 * `resolveConnectorsWithStatus` (chat's verdicts), so the two can never
 * disagree about which connectors work.
 */
async function resolveConnection(
  userId: string,
  row: Connection
): Promise<{ active: ActiveConnector } | { label: string; resolution: ConnectorResolution }> {
  if (isComposioAppId(row.provider)) {
    const slug = composioSlugFromId(row.provider);
    const label = row.accountLabel ?? slug ?? row.provider;
    if (!slug || !isComposioConfigured()) {
      return { label, resolution: { linked: true, configured: false, credential: "usable" } };
    }
    // A Composio link that is not active is one the user has not finished (or undid).
    if (row.scope !== "composio:active") {
      return { label, resolution: { linked: false, configured: true, credential: "usable" } };
    }
    return {
      active: {
        id: row.provider,
        label,
        mcpUrl: `${env.appUrl.replace(/\/$/, "")}/api/mcp/composio/${encodeURIComponent(slug)}`,
        headers: { Authorization: `Bearer ${mintConnectorToken(userId, row.provider)}` },
      },
    };
  }

  const def = getConnector(row.provider);
  if (!def || !isConnectorConfigured(def) || !def.cfg.mcpUrl) {
    return { label: def?.label ?? row.provider, resolution: { linked: true, configured: false, credential: "usable" } };
  }

  // Credentials connectors point at our own MCP route: hand out a short-lived
  // signed token instead of the stored credential (which never leaves the server).
  if (def.kind === "credentials") {
    return {
      active: { id: def.id, label: def.label, mcpUrl: def.cfg.mcpUrl, headers: { Authorization: `Bearer ${mintConnectorToken(userId, def.id)}` } },
    };
  }

  const nearExpiry = !!row.expiresAt && row.expiresAt.getTime() < Date.now() + EXPIRY_SKEW_MS;
  if (nearExpiry) {
    // Expiring (e.g. Figma) — refresh it so the connector keeps working; skip if we can't.
    const token = await refreshConnection(def, row);
    if (!token) return { label: def.label, resolution: { linked: true, configured: true, credential: "refresh_failed" } };
    return { active: { id: def.id, label: def.label, mcpUrl: def.cfg.mcpUrl, headers: { Authorization: `Bearer ${token}` } } };
  }
  let token: string;
  try {
    token = decryptSecret(row.accessToken);
  } catch {
    // Key rotated / corrupt: nothing the user can fix by reconnecting alone.
    return { label: def.label, resolution: { linked: true, configured: true, credential: "unreadable" } };
  }
  return { active: { id: def.id, label: def.label, mcpUrl: def.cfg.mcpUrl, headers: { Authorization: `Bearer ${token}` } } };
}

/** Resolve the connectors the user asked for into usable (configured, linked) endpoints. */
export async function getActiveConnectors(userId: string, requestedIds?: string[]): Promise<ActiveConnector[]> {
  if (!requestedIds || requestedIds.length === 0) return [];
  const ids = [...new Set(requestedIds)];
  const rows = await prisma.connection.findMany({ where: { userId, provider: { in: ids } } });
  const out: ActiveConnector[] = [];
  for (const row of rows) {
    const resolved = await resolveConnection(userId, row);
    if ("active" in resolved) out.push(resolved.active);
  }
  return out;
}

/**
 * `getActiveConnectors` with the connectors it had to skip, and why (RC-3).
 *
 * Beside it rather than instead of it: Work calls `getActiveConnectors` and
 * keeps its array return. Chat reads `skipped` to say which linked connector is
 * unavailable this turn instead of dropping it silently (SPEC §3.4 item 1).
 * Both lists follow the request's order. `skipped` covers a connector with no
 * link (`not_linked`), one this deployment cannot offer or whose credential it
 * cannot read (`misconfigured`), and one whose refresh failed (`auth_expired`);
 * a connector that resolves but then fails to connect is reported by
 * `openMcpToolset`'s `onConnectorStatus` instead.
 */
export async function resolveConnectorsWithStatus(
  userId: string,
  ids: string[]
): Promise<{ active: ActiveConnector[]; skipped: Array<{ id: string; label: string; reason: ConnectorFailure }> }> {
  const requested = [...new Set(ids ?? [])];
  if (requested.length === 0) return { active: [], skipped: [] };
  const rows = await prisma.connection.findMany({ where: { userId, provider: { in: requested } } });
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  const active: ActiveConnector[] = [];
  const skipped: Array<{ id: string; label: string; reason: ConnectorFailure }> = [];
  for (const id of requested) {
    const row = byProvider.get(id);
    if (!row) {
      const def = getConnector(id);
      const reason =
        connectorFailureFor({
          linked: false,
          configured: isComposioAppId(id) ? isComposioConfigured() : !!def && isConnectorConfigured(def) && !!def.cfg.mcpUrl,
          credential: "usable",
        }) ?? "not_linked";
      skipped.push({ id, label: def?.label ?? (isComposioAppId(id) ? composioSlugFromId(id) ?? id : id), reason });
      continue;
    }
    const resolved = await resolveConnection(userId, row);
    if ("active" in resolved) {
      active.push(resolved.active);
      continue;
    }
    skipped.push({ id, label: resolved.label, reason: connectorFailureFor(resolved.resolution) ?? "misconfigured" });
  }
  return { active, skipped };
}

/**
 * Read/write metadata a server declares on its tools, carried on our own tool
 * objects so callers can tell a read from a write.
 *
 * MCP's spec is explicit that these are HINTS, supplied by the connector — the
 * party we are least willing to trust. A hostile server can claim
 * readOnlyHint:true on a tool that deletes everything. They are consequently an
 * INPUT to classifyToolAccess, not the decision itself, and the decision is
 * never the only thing standing between a connector and a destructive call.
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  /**
   * Set by the chat toolset on Juno's own tools: the canonical id, so an
   * adapter can recognise one without a lookup (SPEC §3.7). Never on a
   * connector's tool.
   */
  junoCanonical?: string;
}

export interface McpFunctionTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
  /** Juno-side metadata — stripped by toWireTools before it reaches a provider. */
  annotations?: McpToolAnnotations;
}

/**
 * One dispatch, described twice — once for the model and once for the person.
 *
 * `text` is what it always was: the envelope-wrapped string appended to the
 * conversation. `body` is the same content without the envelope, for the
 * thought-process panel, where the markers would be noise.
 *
 * `ok` and `durationMs` exist because they cannot be recovered downstream.
 * Every one of the five outcomes returns prose, and a caller holding only the
 * string would have to sniff it — so a GitHub issue titled "Tool error: build
 * fails" would read as a failed call. And only this function is on both sides
 * of the await that the duration measures.
 */
/**
 * A picture a tool produced, to be shown to the model rather than described.
 *
 * THE ONLY REASON THIS EXISTS. `inspect_image` crops and magnifies a region of
 * a picture the model has already been shown — the licence plate, the axis
 * label, the fifth row of the table in a screenshot. Every model downsamples a
 * large image before it reaches the transformer, so "look closer" is not
 * something it can do by trying harder, and a tool that answered with a
 * *description* of the crop would just be a second model's guess laundered
 * through a tool call. The crop has to come back as pixels.
 *
 * Every adapter that can carry an image back into a tool round does so; the
 * ones talking to a model without vision drop the pixels and keep the note, so
 * the tool degrades to a sentence rather than to an error.
 */
export interface ToolResultImage {
  mimeType: string;
  /** Raw base64, no data: prefix — each adapter wraps it its own way. */
  base64: string;
  /** One line for the panel and for a model that cannot see it. */
  label?: string;
}

export interface ToolExecution {
  /** What goes back to the MODEL: envelope-wrapped, exactly as before. */
  text: string;
  /** The same content WITHOUT the untrusted envelope — for the panel. */
  body: string;
  /** False for the four refusal/failure paths. Stated, never inferred. */
  ok: boolean;
  /** Set only when `client.callTool` was actually reached. Absent — never zero
   *  — for a call that never left Juno. */
  durationMs?: number;
  /** Pixels to hand back with the text. Empty and absent mean the same thing. */
  images?: readonly ToolResultImage[];
  // Added by the chat rework (SPEC §3.1); every one optional, so Work's
  // executions keep compiling and meaning what they meant.
  /** Absent → `ok ? "succeeded" : "failed"`. */
  status?: "succeeded" | "failed" | "denied" | "expired" | "cancelled";
  error?: { code: ToolErrorCode };
  figure?: ToolFigure;
  web?: ToolWebDetail;
  sources?: ClientSource[];
  feeMicroUsd?: number;
}

/** Per-call options the chat dispatcher passes to `execute` (SPEC §3.1, §4.2). Absent (Work) → today's behaviour. */
export interface ToolExecuteOptions {
  /** Per-call approval callback; overrides the toolset-level one. */
  onApprovalRequest?: (approval: ClientActionApproval) => void;
  /** The per-tool bound. The executor starts `AbortSignal.timeout(timeoutMs)` only AFTER
   *  authorisation, around the network sink (`client.callTool`, the task dispatch). The `signal`
   *  passed to `execute` is the TURN signal, which is what authorisation waits on, so an approval
   *  is never cut short by the tool timer. */
  timeoutMs?: number;
  /** Called once, right after a successful authorisation and before the sink runs. The dispatcher
   *  yields `status: "running"` from it. */
  onAuthorized?: () => void;
}

export interface McpToolset {
  tools: McpFunctionTool[];
  labelFor(toolName: string): string;
  /** Whether a namespaced tool name reads, writes, or can't be told apart. */
  accessFor(toolName: string): ToolAccess;
  /**
   * @param callId the provider's own id for this tool call. It is half of the
   *        broker's idempotency key, so a stream that reconnects and replays the
   *        same call reuses the receipt instead of asking a second time — and,
   *        more importantly, cannot execute the action twice. A caller with no
   *        id from the provider must synthesise a stable one; a random value per
   *        attempt would defeat replay protection rather than merely skip it.
   */
  execute(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    callId?: string,
    opts?: ToolExecuteOptions
  ): Promise<ToolExecution>;
  close(): Promise<void>;
  /**
   * What the toolset knows about a routed connector tool, for the chat
   * toolset's contract mapping (SPEC §3.4 item 7). Optional: only
   * `openMcpToolset` has routes, and Work never reads them.
   */
  route?(toolName: string): ConnectorToolRoute | undefined;
}

/** Opt-in behaviour for chat; Work passes none and keeps today's (SPEC §3.4 item 1). */
export interface OpenMcpToolsetOptions {
  /** Bound on each connector's connect + `listTools`. Unset (Work): no bound, as before. */
  connectTimeoutMs?: number;
  /** Called once per connector with `"ready"` or why it could not be opened. */
  onConnectorStatus?: (id: string, state: "ready" | ConnectorFailure) => void;
}

/**
 * Provider wire shape: the tool minus Juno-side metadata.
 *
 * The compat adapter assigns `params.tools` straight through, so without this
 * the new `annotations` key would ride along to every OpenAI-compatible
 * provider — a field none of them define, and which the stricter ones reject
 * outright. (The Responses adapter already rebuilds tools into its own flat
 * shape and so never carried the extra key.)
 */
export function toWireTools(tools: McpFunctionTool[]): { type: "function"; function: McpFunctionTool["function"] }[] {
  return tools.map(({ type, function: fn }) => ({ type, function: fn }));
}

const SEP = "__";
const MAX_TOOL_NAME = 64;

function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME);
}

/** Unique, ≤64-char function name; disambiguates collisions with a bounded suffix. */
function uniqueToolName(base: string, taken: (name: string) => boolean): string {
  let name = sanitizeToolName(base);
  let n = 1;
  while (taken(name)) {
    const suffix = `_${n++}`;
    name = sanitizeToolName(base).slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
  }
  return name;
}

/**
 * Flatten an MCP tool result into the text the model reads, cut to the cap,
 * plus the pictures it carried and whether the server called it a failure.
 *
 * The cut is `truncateConnectorResult`'s rather than a bare slice, so that a
 * result the model only half-received says so in the result itself. This used to
 * be a bare 30,000-character slice on both branches and nothing else, which is
 * how a run came to narrate a third of a connector's answer as the whole of it.
 *
 * Whole-result length is measured after the parts are joined, not per part: what
 * the model is missing is measured in the text it was actually going to read.
 * Image parts are pixels, not base64 in the text (`flattenToolResult`, M6).
 */
function readToolResult(res: unknown): {
  result: TruncatedForModel;
  images: readonly ToolResultImage[];
  isError: boolean;
} {
  const flattened = flattenToolResult(res);
  return { result: truncateConnectorResult(flattened.text), images: flattened.images, isError: flattened.isError };
}

/**
 * Both projections of one outcome, built from a single body so the model-facing
 * string and the panel-facing one can never describe different text.
 *
 * `body` is the text BEFORE `defang`. Defanging exists to stop hostile content
 * closing its own envelope in the model's context; the panel has no envelope
 * and no instruction position, so showing the connector's characters exactly as
 * they arrived is both safe and more truthful.
 */
function toolExecution(label: string, body: string, ok: boolean, durationMs?: number): ToolExecution {
  return {
    text: wrapUntrusted(label, body),
    body,
    ok,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

/** Who a toolset's calls belong to. Every dispatch is logged and brokered
 *  against this. */
export interface McpToolsetContext {
  userId: string;
  conversationId?: string | null;
  /** Which product surface is acting: `chat`, `work`, `trigger`, `schedule`.
   *  Recorded on the receipt so an approval names the thing that asked. */
  surface?: string;
  /** Stable id for this generation/run. With `callId` it forms the broker's
   *  idempotency key; defaulting it per-toolset (rather than per-call) is what
   *  makes a mid-stream reconnect replay rather than re-execute. */
  sessionId?: string;
  projectId?: string | null;
  /**
   * Called once, synchronously, when an action starts waiting on a person.
   * The adapter forwards it to the client so the approval card can render while
   * the tool loop is blocked. Never called for an auto-allowed action.
   */
  onApprovalRequest?: (approval: ClientActionApproval) => void;
  /** No person is attached — a trigger poll or background sweep. Actions that
   *  would need an approval are refused immediately rather than waiting for one
   *  that can never arrive. */
  unattended?: boolean;
}

/**
 * Open MCP connections for the given connectors and expose their tools as
 * OpenAI-style function tools. Tool names are namespaced `<connector>__<tool>`.
 * Always `close()` when the generation ends (best-effort in a finally).
 */
export async function openMcpToolset(
  active: ActiveConnector[],
  ctx: McpToolsetContext,
  opts: OpenMcpToolsetOptions = {}
): Promise<McpToolset> {
  const clients = new Map<string, Client>();
  const tools: McpFunctionTool[] = [];
  const routing = new Map<
    string,
    {
      connectorId: string;
      toolName: string;
      label: string;
      access: ToolAccess;
      annotations?: ToolAccessHints;
      title?: string;
      inputSchema: Record<string, unknown>;
    }
  >();
  // Fallback identity for the broker's idempotency key. Per-toolset rather than
  // per-call so that repeated calls within one generation stay distinguishable
  // while a caller that supplies no provider call id still gets a stable pair.
  const brokerSessionId = ctx.sessionId ?? `toolset-${crypto.randomUUID()}`;
  let callOrdinal = 0;
  const nextCallOrdinal = () => ++callOrdinal;

  type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
  const listed: Array<{ connectorId: string; toolName: string; connector: ActiveConnector; tool: ListedTool }> = [];

  await Promise.all(
    active.map(async (c) => {
      // Chat bounds each connector's connect + listTools (SPEC §3.4 item 1);
      // Work passes no budget and keeps waiting as long as it always has.
      const budget = opts.connectTimeoutMs ? AbortSignal.timeout(opts.connectTimeoutMs) : null;
      const requestOptions = budget ? { signal: budget, timeout: opts.connectTimeoutMs } : undefined;
      let client: Client | null = null;
      try {
        const transport = new StreamableHTTPClientTransport(new URL(c.mcpUrl), {
          requestInit: { headers: c.headers },
        });
        client = new Client({ name: "juno", version: "1.0.0" });
        await client.connect(transport, requestOptions);
        const result = await client.listTools(undefined, requestOptions);
        clients.set(c.id, client);
        for (const tool of result.tools) listed.push({ connectorId: c.id, toolName: tool.name, connector: c, tool });
        opts.onConnectorStatus?.(c.id, "ready");
      } catch (error) {
        // Connector unreachable/unauthorized — skip it; the chat proceeds
        // without it, and says so when the caller asked to be told.
        if (client) await client.close().catch(() => {});
        opts.onConnectorStatus?.(c.id, connectFailureOf(error, budget));
      }
    })
  );

  // Named after every connection settled, in (connector, tool) order, so a
  // collision's suffix does not depend on which server answered first (H7).
  for (const { connector: c, tool: t } of sortConnectorTools(listed)) {
    const fnName = uniqueToolName(`${c.id}${SEP}${t.name}`, (n) => routing.has(n));
    // A server may send annotations, some of them, or none at all. Keep
    // only the two booleans we act on, and only when they really are
    // booleans — `readOnlyHint: "false"` must not read as truthy.
    const raw = t.annotations as ToolAccessHints | undefined;
    const annotations: McpToolAnnotations = {};
    if (typeof raw?.readOnlyHint === "boolean") annotations.readOnlyHint = raw.readOnlyHint;
    if (typeof raw?.destructiveHint === "boolean") annotations.destructiveHint = raw.destructiveHint;
    const hasAnnotations = Object.keys(annotations).length > 0;
    // The server's own title for the row, verbatim third-party text (SPEC §3.4 item 7).
    const annotatedTitle = (t.annotations as { title?: unknown } | undefined)?.title;
    const serverTitle =
      (typeof t.title === "string" && t.title.trim()) ||
      (typeof annotatedTitle === "string" && annotatedTitle.trim()) ||
      undefined;
    // Classify from the BARE tool name: fnName is prefixed with the
    // connector id, whose first token would otherwise be what the verb
    // heuristic reads ("github", "notion" — never a verb).
    routing.set(fnName, {
      connectorId: c.id,
      toolName: t.name,
      label: c.label,
      access: classifyToolAccess(t.name, hasAnnotations ? annotations : undefined),
      // Kept alongside the coarse read/write verdict: the broker's risk
      // classifier reads the raw hints itself, and needs to be able to
      // tell "server said nothing" from "server said read-only".
      ...(hasAnnotations ? { annotations } : {}),
      ...(serverTitle ? { title: serverTitle } : {}),
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    });
    tools.push({
      type: "function",
      function: {
        name: fnName,
        description: (t.description ? `[${c.label}] ${t.description}` : `[${c.label}] ${t.name}`).slice(0, 1024),
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      },
      ...(hasAnnotations ? { annotations } : {}),
    });
  }

  return {
    tools,
    labelFor: (toolName) => routing.get(toolName)?.label ?? "tool",
    // An unroutable name is "unknown", not "read": the only caller that can ask
    // about one is asking in order to decide how much to trust it.
    accessFor: (toolName) => routing.get(toolName)?.access ?? "unknown",
    /*
     * The single chokepoint for tool results on both OpenAI paths
     * (openai-compat.ts and openai-responses.ts both append what this returns),
     * which is why the untrusted-content envelope goes here rather than at the
     * two append sites.
     *
     * EVERY return path is wrapped, including the error strings: a hostile MCP
     * server controls its own error messages just as much as its successes.
     *
     * The wrapper is applied AFTER readToolResult's truncation, so content
     * can never grow large enough to push the closing marker out of the window
     * and leave the envelope unterminated. The truncation notice is paid for out
     * of that same budget, so it cannot reopen the gap it closes — and it lands
     * inside the envelope, describing the block it belongs to.
     */
    route(toolName) {
      const route = routing.get(toolName);
      if (!route) return undefined;
      return {
        functionName: toolName,
        connectorId: route.connectorId,
        connectorLabel: route.label,
        toolName: route.toolName,
        ...(route.title ? { title: route.title } : {}),
        ...(route.annotations ? { annotations: route.annotations } : {}),
        inputSchema: route.inputSchema,
      };
    },
    async execute(toolName, args, signal, callId, opts) {
      const route = routing.get(toolName);
      // An unroutable name never reached a connector, so there is nothing to
      // audit: this is the model hallucinating a tool, not a call happening.
      // Never dispatched, so there is no duration and the outcome is a refusal.
      if (!route) return toolExecution(toolName, `Unknown tool: ${toolName}`, false);
      const client = clients.get(route.connectorId);
      const label = `${route.label} · ${route.toolName}`;

      const auditId = await recordToolInvocation({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        connectorId: route.connectorId,
        toolName: route.toolName,
        functionName: toolName,
        access: route.access,
        args,
        derivedFromUntrusted: false,
        status: "executed",
      });

      if (!client) {
        await settleToolInvocation(auditId, { status: "failed", error: "connector unavailable" });
        return toolExecution(label, `Connector ${route.connectorId} is not available.`, false);
      }

      /*
       * The permission and receipt gate, in front of the network sink.
       *
       * It runs AFTER the audit row so a refused call is still a call that was
       * attempted and is still visible in the trail — the refusals are the rows
       * most worth having. It runs BEFORE `client.callTool` because everything
       * after that point has already left Juno.
       *
       * `authorizeExternalAction` blocks here while the person decides. That is
       * the intended shape: the tool loop cannot proceed without a result, and a
       * fabricated "pending" result handed back to the model would be a lie the
       * model then reasons from. Stop aborts the signal, which resolves the wait
       * as a refusal.
       */
      const authorization = await authorizeExternalAction({
        userId: ctx.userId,
        surface: ctx.surface ?? "chat",
        sessionId: ctx.sessionId ?? brokerSessionId,
        conversationId: ctx.conversationId ?? null,
        projectId: ctx.projectId ?? null,
        connectorId: route.connectorId,
        connectorLabel: route.label,
        toolName: route.toolName,
        functionName: toolName,
        annotations: route.annotations,
        args,
        callId: callId ?? `${toolName}:${nextCallOrdinal()}`,
        provenance: {
          source: ctx.conversationId ? `conversation:${ctx.conversationId}` : `session:${ctx.sessionId ?? brokerSessionId}`,
          sourceKind: "model_tool_call",
          // The model composed these arguments, and by this point in a tool loop
          // it has already read connector output — untrusted text that can try
          // to steer the next call. Treat every model-authored argument as
          // untrusted rather than only the ones we can prove tainted.
          derivedFromUntrusted: true,
        },
        // The TURN signal: an approval may wait the receipt's full lifetime and
        // is never cut short by the tool's own timer, which starts below.
        signal,
        // The dispatcher's per-call card wins, so the card maps to its call.
        onApprovalRequest: opts?.onApprovalRequest ?? ctx.onApprovalRequest,
        unattended: ctx.unattended,
      });

      if (authorization.kind === "refused") {
        await settleToolInvocation(auditId, {
          status: authorization.status === "denied" ? "denied" : "failed",
          error: authorization.reason,
        });
        return {
          ...toolExecution(label, `Action not permitted: ${authorization.reason}`, false),
          ...refusalStatusFields(authorization.status),
        };
      }
      if (authorization.kind === "replay") {
        await settleToolInvocation(auditId, {
          status: authorization.failed ? "failed" : "executed",
          error: authorization.failed ? authorization.result : undefined,
        });
        // A replay hands back the stored result of the ORIGINAL dispatch, whose
        // duration belonged to that attempt and is not re-measured here.
        return toolExecution(label, authorization.result, !authorization.failed);
      }

      // Authorised: the chat dispatcher shows the row as running from here, and
      // the tool's own timer starts now, around the network sink only (SPEC
      // §3.4 item 8). Without options (Work) the call is bounded by `signal`
      // alone, as it always was.
      opts?.onAuthorized?.();
      const timer = opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : null;
      const callSignal = timer ? (signal ? AbortSignal.any([signal, timer]) : timer) : signal;
      const requestOptions = callSignal
        ? { signal: callSignal, ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}) }
        : undefined;
      const startedAt = Date.now();
      try {
        const res = await client.callTool({ name: route.toolName, arguments: args }, undefined, requestOptions);
        const { result, images: pictures, isError } = readToolResult(res);
        // One reading of the clock, used by the audit row and by the panel, so
        // the trail and the thought process cannot report different numbers for
        // the same call.
        const durationMs = Date.now() - startedAt;
        const images = pictures.length ? { images: pictures } : {};
        if (isError) {
          // The server ran the call and said it failed (`isError`, M6): a failure
          // whatever its text says, and settled as one.
          await settleToolInvocation(auditId, { status: "failed", error: result.text.slice(0, 2_000), durationMs });
          await completeExternalAction({ userId: ctx.userId, receiptId: authorization.receiptId, ok: false, result: result.text });
          return {
            ...toolExecution(label, result.text, false, durationMs),
            ...images,
            status: "failed",
            error: { code: "tool_error" },
          };
        }
        await settleToolInvocation(auditId, { status: "executed", durationMs });
        // The receipt stores what the model was actually given, notice included:
        // a replay of this call returns the stored string verbatim, so a receipt
        // holding the untruncated text would hand a replayed call more than the
        // first attempt got — and one holding the prefix without the notice
        // would hand it the silent version.
        await completeExternalAction({ userId: ctx.userId, receiptId: authorization.receiptId, ok: true, result: result.text });
        return { ...toolExecution(label, result.text, true, durationMs), ...images };
      } catch (err) {
        // An error message is the connector's text too, and nothing bounds it:
        // a server that answers a failed call with a megabyte of prose gets the
        // same cap and the same sentence as one that succeeds with it.
        const detail = truncateConnectorResult(err instanceof Error ? err.message : String(err)).text;
        const durationMs = Date.now() - startedAt;
        const timedOut = !!timer?.aborted && !signal?.aborted;
        await settleToolInvocation(auditId, { status: "failed", error: detail, durationMs });
        await completeExternalAction({ userId: ctx.userId, receiptId: authorization.receiptId, ok: false, result: detail });
        return {
          ...toolExecution(label, `Tool error: ${detail}`, false, durationMs),
          ...(opts ? { status: signal?.aborted ? "cancelled" : "failed", error: { code: timedOut ? "timeout" : signal?.aborted ? "cancelled" : "tool_error" } } : {}),
        };
      }
    },
    async close() {
      await Promise.all([...clients.values()].map((c) => c.close().catch(() => {})));
    },
  };
}
