/**
 * The Alevr MCP server (SPEC §3.11): injected into Claude, Codex and ACP
 * sessions so a vendor agent gets Alevr's subagents on any connected
 * provider, thread search, and (from the computer lane) computer use.
 *
 * Transport: MCP streamable HTTP on the env server's own 127.0.0.1 listener,
 * path /mcp. Every POST carries `Authorization: Bearer <scoped token>`; a
 * token names one session and a depth, so a subagent's tools can never act
 * on another thread and a child cannot spawn grandchildren (depth 1).
 * Responses are plain JSON (the spec allows that for request/response
 * servers); GET (server-initiated stream) answers 405.
 *
 * Registration hook: `registerTool()` — the computer lane adds its tools
 * here without touching this file.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { newToken, describeError, type Logger } from "../util.js";

export const MCP_SERVER_NAME = "alevr";
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpScope {
  sessionId: string;
  /** 0 for a top-level session, 1 for a subagent. */
  depth: number;
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** Whether a scope sees this tool (default: everyone). */
  availableTo?(scope: McpScope): boolean;
  handler(args: Record<string, unknown>, scope: McpScope, signal: AbortSignal): Promise<McpToolResult>;
}

export const text = (t: string, isError = false): McpToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const MAX_BODY = 4 * 1024 * 1024;

export class AlevrMcpServer {
  #tools = new Map<string, McpToolDefinition>();
  #tokens = new Map<string, McpScope>();

  constructor(private readonly logger: Logger) {}

  /** Adds (or replaces) a tool. Returns a function that removes it. */
  registerTool(tool: McpToolDefinition): () => void {
    this.#tools.set(tool.name, tool);
    return () => {
      if (this.#tools.get(tool.name) === tool) this.#tools.delete(tool.name);
    };
  }

  tools(scope: McpScope): McpToolDefinition[] {
    return [...this.#tools.values()].filter((t) => !t.availableTo || t.availableTo(scope));
  }

  /** A bearer token scoped to one session. Revoke it when the session closes. */
  issueToken(scope: McpScope): string {
    const token = `amcp_${newToken(24)}`;
    this.#tokens.set(token, scope);
    return token;
  }

  revokeSession(sessionId: string): void {
    for (const [token, scope] of this.#tokens) if (scope.sessionId === sessionId) this.#tokens.delete(token);
  }

  scopeFor(authorization: string | undefined): McpScope | undefined {
    const m = authorization?.match(/^Bearer\s+(\S+)$/i);
    return m ? this.#tokens.get(m[1]) : undefined;
  }

  /** HTTP entry point for /mcp. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const scope = this.scopeFor(req.headers.authorization);
    if (!scope) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const messages = Array.isArray(body) ? body : [body];
    const replies: unknown[] = [];
    let sessionHeader: string | undefined;
    for (const msg of messages) {
      const reply = await this.dispatch(msg as Record<string, unknown>, scope, abort.signal);
      if (reply) {
        replies.push(reply);
        if ((msg as { method?: string }).method === "initialize") sessionHeader = `mcp_${scope.sessionId}`;
      }
    }
    if (replies.length === 0) {
      res.writeHead(202).end();
      return;
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sessionHeader) headers["mcp-session-id"] = sessionHeader;
    res.writeHead(200, headers).end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
  }

  /** One JSON-RPC message → reply (undefined for notifications). Exposed for the stdio bridge and tests. */
  async dispatch(msg: Record<string, unknown>, scope: McpScope, signal: AbortSignal): Promise<unknown> {
    const id = msg.id;
    const isRequest = id !== undefined && id !== null;
    const method = typeof msg.method === "string" ? msg.method : "";
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!isRequest) return undefined;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSIONS[0];
        return reply({
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: "Alevr", version: "1.0.0" },
          instructions:
            "Alevr tools: start subagents on any model the user connected (spawn_subagent, then wait_subagent for its closing text), list or cancel them, message a running one, and search the user's earlier Alevr Code threads.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: this.tools(scope).map((t) => ({
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const tool = this.tools(scope).find((t) => t.name === name);
        if (!tool) return fail(-32602, `Unknown tool: ${name}`);
        const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
        try {
          return reply(await tool.handler(args, scope, signal));
        } catch (error) {
          this.logger.warn(`mcp tool ${name}: ${describeError(error)}`);
          return reply(text(describeError(error), true));
        }
      }
      case "resources/list":
        return reply({ resources: [] });
      case "prompts/list":
        return reply({ prompts: [] });
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
