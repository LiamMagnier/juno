/**
 * The cross-conversation tools for vendor agents (Claude, Codex, ACP) over the
 * Alevr MCP server: list_conversations, read_conversation and
 * send_to_conversation, scoped to the calling thread by its MCP token. The
 * Alevr engine gets the same tools natively (conversationEngineTools).
 *
 * send_to_conversation carries no readOnlyHint, so each vendor's own approval
 * gate asks for it in its ask/plan modes (Claude's canUseTool routes it to an
 * approval_request) and lets it through in full access.
 */
import type { ConversationHub } from "../conversations/hub.js";
import { CROSS_TOOL_DESCRIPTIONS, CROSS_TOOL_SCHEMAS } from "../conversations/policy.js";
import { text, type AlevrMcpServer, type McpScope, type McpToolResult } from "./alevr-mcp.js";

export function registerConversationTools(mcp: AlevrMcpServer, hub: ConversationHub): () => void {
  // Subagents (depth 1) work for their parent thread; only top-level threads talk to other conversations.
  const available = (scope: McpScope) => scope.depth === 0 && hub.enabledFor(scope.sessionId);
  const wrap = async (run: Promise<{ ok: boolean; text: string; data?: unknown }>): Promise<McpToolResult> => {
    const outcome = await run;
    return outcome.data && outcome.ok
      ? { content: [{ type: "text", text: outcome.text }], structuredContent: outcome.data as Record<string, unknown> }
      : text(outcome.text, !outcome.ok);
  };
  const removers = [
    mcp.registerTool({
      name: "list_conversations",
      title: "List the user's conversations",
      description: CROSS_TOOL_DESCRIPTIONS.list_conversations,
      inputSchema: CROSS_TOOL_SCHEMAS.list_conversations as unknown as Record<string, unknown>,
      annotations: { readOnlyHint: true },
      availableTo: available,
      handler: (args, scope) => wrap(hub.list(scope.sessionId, args)),
    }),
    mcp.registerTool({
      name: "read_conversation",
      title: "Read another conversation",
      description: CROSS_TOOL_DESCRIPTIONS.read_conversation,
      inputSchema: CROSS_TOOL_SCHEMAS.read_conversation as unknown as Record<string, unknown>,
      annotations: { readOnlyHint: true },
      availableTo: available,
      handler: (args, scope) => wrap(hub.read(scope.sessionId, args)),
    }),
    mcp.registerTool({
      name: "send_to_conversation",
      title: "Message another conversation",
      description: CROSS_TOOL_DESCRIPTIONS.send_to_conversation,
      inputSchema: CROSS_TOOL_SCHEMAS.send_to_conversation as unknown as Record<string, unknown>,
      availableTo: available,
      handler: (args, scope) => wrap(hub.send(scope.sessionId, args)),
    }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
