/**
 * The two chat tools of rooms (src/lib/agents/rooms.ts).
 *
 * - `create_room`: from any saved chat, put two to six existing agents
 *   together ("put Mira and Scout together on the Acme renewal"). It creates
 *   nothing but the room, so it needs no approval: every agent keeps its own
 *   autonomy, apps and approval floor inside it.
 * - `ask_room_member`: inside a room, the answering agent asks one other
 *   member to pick something up. The member answers right after, in the room,
 *   under the cap and the loop guard the store enforces.
 *
 * The declarations and the parsing are pure (rooms.ts). The factories reach
 * Prisma and the stores through `await import()`, so nothing `server-only`
 * sits in this module's static graph (tests/chat-tool-imports pins this).
 */

import type { NativeChatTool } from "@/lib/llm";
import type { ToolExecution } from "@/lib/mcp";
import type { ClientAgentChange } from "@/types/chat";
import {
  ASK_REFUSAL_MESSAGE,
  ASK_ROOM_MEMBER_TOOL,
  CREATE_ROOM_TOOL,
  memberByName,
  parseAskArgs,
  parseRoomAgentNames,
  resolveRoomMembers,
  roomNamesTitle,
  roomTitle,
  type RoomMemberInfo,
} from "@/lib/agents/rooms";

export const ROOM_TOOL_LABELS = {
  create_room: "Opening a room",
  ask_room_member: "Asking another agent",
} as const;

/** Rooms one account may open from chat in an hour. */
export const CREATE_ROOM_RATE_LIMIT = { limit: 10, windowSec: 60 * 60 } as const;

const CREATE_ROOM_REFUSAL_COPY = {
  too_few: "A room needs at least two of your agents. Name them.",
  too_many: "A room holds at most six agents.",
  unknown: "You do not have an agent by that name.",
  ambiguous: "More than one of your agents has that name. Rename one first.",
  rate_limited: "Too many rooms were opened this hour. Try again later.",
  untrusted: "I can't open a room while reading outside content in the same turn. Ask me in a clean message.",
};

function result(payload: Record<string, unknown>, extra?: Partial<ToolExecution>): ToolExecution {
  const ok = payload.status !== "refused";
  const body = typeof payload.message === "string" ? payload.message : ok ? "Done." : "Refused.";
  return { text: JSON.stringify(payload), body, ok, ...extra };
}

export function createCreateRoomTool(ctx: {
  user: { id: string; email?: string | null; name?: string | null };
  untrustedContent: boolean;
  onReceipt?: (change: ClientAgentChange, url: string) => void;
}): NativeChatTool {
  return {
    tool: CREATE_ROOM_TOOL,
    label: ROOM_TOOL_LABELS.create_room,
    access: "write",
    execute: async (rawArgs, signal) => {
      if (signal?.aborted) return result({ status: "refused", reason: "stopped", message: "The reply was stopped." });
      if (ctx.untrustedContent) {
        return result({ status: "refused", reason: "untrusted_content_in_turn", message: CREATE_ROOM_REFUSAL_COPY.untrusted });
      }
      const [{ prisma }, rooms, { rateLimit }] = await Promise.all([
        import("@/lib/prisma"),
        import("@/lib/agents/room-store"),
        import("@/lib/rate-limit"),
      ]);
      const names = parseRoomAgentNames(rawArgs.agents);
      const roster = await prisma.agent.findMany({
        where: { userId: ctx.user.id, deletedAt: null },
        select: { id: true, name: true, role: true, status: true },
      });
      const resolved = resolveRoomMembers(
        names,
        roster.map((agent) => ({ agentId: agent.id, name: agent.name, role: agent.role, paused: agent.status !== "active" }))
      );
      if (!resolved.ok) {
        return result({
          status: "refused",
          reason: resolved.reason,
          ...(resolved.name ? { name: resolved.name } : {}),
          message: CREATE_ROOM_REFUSAL_COPY[resolved.reason],
          agents: roster.map((agent) => agent.name),
        });
      }
      const limit = await rateLimit({ key: `agents:rooms:${ctx.user.id}`, ...CREATE_ROOM_RATE_LIMIT });
      if (!limit.success) {
        return result({ status: "refused", reason: "rate_limited", message: CREATE_ROOM_REFUSAL_COPY.rate_limited });
      }
      const topic = typeof rawArgs.topic === "string" ? rawArgs.topic : null;
      const created = await rooms.createRoomForUser(ctx.user, {
        agentIds: resolved.members.map((member) => member.agentId),
        title: topic,
      });
      if (!created.ok) return result({ status: "refused", reason: created.error, message: created.message });
      const url = `/chat/${created.room.conversationId}`;
      const namesTitle = roomNamesTitle(resolved.members.map((member) => member.name));
      const change: ClientAgentChange = {
        agentId: resolved.members[0]!.agentId,
        agentName: resolved.members[0]!.name,
        summary: `Opened a room with ${namesTitle}`,
        changes: [{ label: "Room", to: roomTitle(resolved.members.map((member) => member.name), topic) }],
      };
      ctx.onReceipt?.(change, url);
      return result(
        {
          status: "created",
          room: { title: created.room.title, url, members: resolved.members.map((member) => member.name) },
          message: `Opened the room ${created.room.title}. Tell the user they can open it at ${url} and address a member with @Name.`,
        },
        { agentChange: change }
      );
    },
  };
}

export function createAskRoomMemberTool(ctx: {
  user: { id: string };
  conversationId: string;
  userMessageId: string;
  self: { agentId: string; name: string };
  members: readonly RoomMemberInfo[];
  untrustedContent: boolean;
  onAsked?: (sentence: string) => void;
}): NativeChatTool {
  let asked = false;
  return {
    tool: ASK_ROOM_MEMBER_TOOL,
    label: ROOM_TOOL_LABELS.ask_room_member,
    access: "write",
    execute: async (rawArgs, signal) => {
      if (signal?.aborted) return result({ status: "refused", reason: "stopped", message: "The reply was stopped." });
      if (asked) {
        return result({ status: "refused", reason: "one_per_turn", message: "You already asked a member this turn." });
      }
      if (ctx.untrustedContent) {
        return result({
          status: "refused",
          reason: "untrusted_content_in_turn",
          message: "You read outside content this turn, so you cannot pass work on. Answer yourself.",
        });
      }
      const args = parseAskArgs(rawArgs);
      if (!args) return result({ status: "refused", reason: "invalid_arguments", message: "Name the member and say what you want." });
      const target = memberByName(args.member, ctx.members);
      if (!target) return result({ status: "refused", reason: "not_member", message: ASK_REFUSAL_MESSAGE.not_member });
      const rooms = await import("@/lib/agents/room-store");
      const outcome = await rooms.askRoomMember({
        userId: ctx.user.id,
        conversationId: ctx.conversationId,
        userMessageId: ctx.userMessageId,
        fromAgentId: ctx.self.agentId,
        fromName: ctx.self.name,
        targetAgentId: target.agentId,
        request: args.request,
        members: ctx.members,
      });
      if (!outcome.ok) {
        return result({
          status: "refused",
          reason: outcome.reason,
          message: outcome.reason === "stopped" ? "The reply was stopped." : ASK_REFUSAL_MESSAGE[outcome.reason],
        });
      }
      asked = true;
      ctx.onAsked?.(outcome.sentence);
      return result({
        status: "asked",
        member: outcome.toName,
        message: `${outcome.toName} will answer right after you. Do not answer their part yourself; finish your own part briefly.`,
      });
    },
  };
}
