/**
 * Opening the toolset a chat turn runs with (SPEC §3.7): Juno's specs in
 * registry order, then the ready connectors' tools (sorted), then the route's
 * native tools, cut at `MAX_CHAT_FUNCTION_TOOLS`. A connector that fails to
 * open fails alone; it never takes Juno's or the native tools with it (RC-3).
 *
 * WS0 lands the signature; WS1 implements it.
 */

import type { ActiveConnector, McpToolsetContext } from "@/lib/mcp";
import type { ChatToolPlan } from "@/lib/tools/entitlements";
import type { ChatToolset, NativeChatTool, ToolContext } from "@/lib/tools/types";
import type { ConnectorFailure } from "@/types/run";

/** The most function tools one chat turn offers, Juno's first (SPEC §3.4 item 3). */
export const MAX_CHAT_FUNCTION_TOOLS = 64;

export async function openChatToolset(_input: {
  plan: ChatToolPlan;
  connectors: ActiveConnector[];     // resolved; empty when plan.connectors is false
  skipped: Array<{ id: string; label: string; reason: ConnectorFailure }>;
  context: Omit<ToolContext, "callId" | "round" | "signal" | "onApprovalRequest">;
  mcpContext: McpToolsetContext | null;   // null in private chats
  nativeTools: readonly NativeChatTool[]; // start_task
}): Promise<ChatToolset> {
  throw new Error("not implemented: WS1");
}
