import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptField, encryptField } from "@/lib/field-crypto";
import { decryptMessageText } from "@/lib/message-crypto";
import { activeGenerationForConversation } from "@/lib/generation-cancel";
import { linkHub } from "@/lib/code-v2/env-link-select";
import { peerHrefForRef } from "./links";
import type { ClientCommand, ConversationDelivery, ConversationExcerptMessage, ServerResponse } from "@/lib/code-v2/contracts";
import {
  CROSS_MESSAGE_LIMITS,
  CROSS_MESSAGES_DEFAULT,
  checkSend,
  clampReadCount,
  clip,
  crossMessagesEnabled,
  dedupeKey,
  formatConversationRef,
  nextHop,
  parseConversationRef,
  productOfRef,
  sameConversation,
  type ConversationRef,
  type CrossConversationState,
  type CrossProduct,
  type SendRefusal,
} from "./policy";

/*
 * Conversations messaging each other: the backend hub (policy.ts has the rules).
 *
 * Every send that crosses the backend lands here: from a Chat turn's tools,
 * from the Mac's Alevr engine (JunoCodeBridge) and from an env server on a
 * Mac (its Chat-bound sends). Every read and write is scoped to the caller's
 * own account (the ownership guard, src/lib/db.ts): a ref that names another
 * account's conversation is simply not found.
 *
 * Delivery by target:
 * - Chat: the message waits as `queued` until a client of the account claims
 *   it and runs the reply turn (POST /api/chat with crossReply), the way room
 *   turns are run. A conversation that is mid-generation is not claimable, so
 *   the message waits for its turn.
 * - Code on the Mac's Alevr engine (code:<remoteSessionId>): a
 *   `cross_message` CodeSessionCommand the Mac host picks up.
 * - Code on an env server (env:<device>/<session>): conversation.deliver
 *   over the device link, when the Mac is online.
 */

export interface CrossConversationRow {
  id: string;
  title: string;
  product: CrossProduct;
  project?: string;
  state: CrossConversationState;
  lastActivity: string;
}

export interface CrossSender {
  ref: ConversationRef;
  title: string;
  enabled: boolean;
}

export interface CrossTarget {
  ref: ConversationRef;
  title: string;
  enabled: boolean;
  state: CrossConversationState;
  code?: { id: string; deviceId: string; sessionId: string };
}

export type SendOutcome =
  | { ok: true; linkId: string; status: "queued" | "delivered" | "failed"; target: { ref: string; title: string; state: CrossConversationState } }
  | { ok: false; reason: SendRefusal | "offline"; message: string };

const HOUR = 60 * 60_000;
const ENV_RPC_TIMEOUT_MS = 4_000;

export async function crossMessageSettings(userId: string): Promise<{ chat: boolean; code: boolean }> {
  const settings = await prisma.settings.findFirst({
    where: { userId },
    select: { crossMessagesChat: true, crossMessagesCode: true },
  });
  return {
    chat: settings?.crossMessagesChat ?? CROSS_MESSAGES_DEFAULT.chat,
    code: settings?.crossMessagesCode ?? CROSS_MESSAGES_DEFAULT.code,
  };
}

/** Whether a Chat conversation may message and be messaged. */
export async function chatConversationEnabled(userId: string, conversationId: string): Promise<boolean> {
  const [settings, conversation] = await Promise.all([
    crossMessageSettings(userId),
    prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { crossMessages: true } }),
  ]);
  if (!conversation) return false;
  return crossMessagesEnabled(settings.chat, "chat", toggleOf(conversation.crossMessages));
}

function toggleOf(value: string | null | undefined): "on" | "off" | null {
  return value === "on" || value === "off" ? value : null;
}

async function chatIsBusy(userId: string, conversationId: string): Promise<boolean> {
  if (activeGenerationForConversation(conversationId, userId)) return true;
  const receipt = await prisma.chatFirstSubmissionReceipt.findFirst({
    where: { userId, conversationId, state: "running", leaseExpiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return !!receipt;
}

function codeState(row: { isRunning: boolean; isAwaitingApproval: boolean }): CrossConversationState {
  if (row.isAwaitingApproval) return "needs-you";
  return row.isRunning ? "working" : "idle";
}

function envState(state: string | undefined): CrossConversationState {
  if (state === "running") return "working";
  if (state === "waiting") return "needs-you";
  return "idle";
}

async function envRpc<T>(userId: string, deviceId: string, command: Omit<ClientCommand, "id">): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const hub = linkHub();
  if (!(await hub.isOnline(userId, deviceId))) return { ok: false, error: "That Mac is offline. Open Alevr on it and try again." };
  const id = `cross_${crypto.randomUUID()}`;
  const reply = await Promise.race([
    hub.link(userId, deviceId).rpc({ ...command, id } as ClientCommand),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ENV_RPC_TIMEOUT_MS)),
  ]);
  if (!reply) return { ok: false, error: "That Mac did not answer in time." };
  if (reply.offline) return { ok: false, error: reply.message ?? "That Mac is offline." };
  const response = reply.responses?.[0] as ServerResponse | undefined;
  if (!response) return { ok: false, error: "That Mac did not answer." };
  if (!response.ok) return { ok: false, error: response.error.message };
  return { ok: true, result: response.result as T };
}

// ── Listing ─────────────────────────────────────────────────────────────────

export async function listCrossConversations(
  userId: string,
  filter: { exclude?: string | null; product?: string | null; project?: string | null; query?: string | null; includeEnv?: boolean },
): Promise<CrossConversationRow[]> {
  const product = filter.product === "chat" || filter.product === "code" ? filter.product : "any";
  const project = filter.project?.trim().toLowerCase() || "";
  const query = filter.query?.trim() || "";
  const exclude = filter.exclude ? parseConversationRef(filter.exclude) : null;
  const rows: CrossConversationRow[] = [];

  if (product !== "code") {
    const chats = await prisma.conversation.findMany({
      where: {
        userId,
        kind: "chat",
        archivedAt: null,
        ...(query ? { title: { contains: query, mode: "insensitive" as const } } : {}),
      },
      orderBy: { lastMessageAt: "desc" },
      take: CROSS_MESSAGE_LIMITS.listMax,
      select: { id: true, title: true, lastMessageAt: true, projectId: true, project: { select: { name: true } } },
    });
    const ids = chats.map((c) => c.id);
    const running = ids.length
      ? await prisma.chatFirstSubmissionReceipt.findMany({
          where: { userId, conversationId: { in: ids }, state: "running", leaseExpiresAt: { gt: new Date() } },
          select: { conversationId: true },
        })
      : [];
    const busy = new Set(running.map((r) => r.conversationId));
    for (const chat of chats) {
      const projectName = chat.project?.name ?? undefined;
      if (project && !(projectName?.toLowerCase().includes(project) || chat.projectId === filter.project)) continue;
      rows.push({
        id: formatConversationRef({ kind: "chat", id: chat.id }),
        title: chat.title,
        product: "chat",
        ...(projectName ? { project: projectName } : {}),
        state: busy.has(chat.id) || activeGenerationForConversation(chat.id, userId) ? "working" : "idle",
        lastActivity: chat.lastMessageAt.toISOString(),
      });
    }
  }

  if (product !== "chat") {
    const sessions = await prisma.codeRemoteSession.findMany({
      where: {
        userId,
        deletedAt: null,
        archived: false,
        ...(query ? { title: { contains: query, mode: "insensitive" as const } } : {}),
      },
      orderBy: { lastMessageAt: "desc" },
      take: CROSS_MESSAGE_LIMITS.listMax,
      select: {
        id: true,
        title: true,
        projectName: true,
        workspaceName: true,
        lastMessageAt: true,
        isRunning: true,
        isAwaitingApproval: true,
      },
    });
    for (const s of sessions) {
      const projectName = s.projectName ?? s.workspaceName ?? undefined;
      if (project && !projectName?.toLowerCase().includes(project)) continue;
      rows.push({
        id: formatConversationRef({ kind: "code", id: s.id }),
        title: s.title,
        product: "code",
        ...(projectName ? { project: projectName } : {}),
        state: codeState(s),
        lastActivity: s.lastMessageAt.toISOString(),
      });
    }
    if (filter.includeEnv !== false) rows.push(...(await listEnvThreads(userId, { project, query })));
  }

  const filtered = exclude
    ? rows.filter((row) => {
        const ref = parseConversationRef(row.id);
        return !ref || !sameConversation(ref, exclude);
      })
    : rows;
  filtered.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return filtered.slice(0, CROSS_MESSAGE_LIMITS.listMax);
}

/** Threads on the user's online Macs' env servers, asked over the device link (best effort, bounded). */
async function listEnvThreads(userId: string, filter: { project: string; query: string }): Promise<CrossConversationRow[]> {
  const devices = await prisma.codeDevice.findMany({ where: { userId }, select: { id: true }, take: 10 });
  const out: CrossConversationRow[] = [];
  await Promise.all(
    devices.map(async (device) => {
      const listed = await envRpc<{ sessions: { id: string; cwd: string; title?: string; state: string; updatedAt: string; parentSessionId?: string }[] }>(
        userId,
        device.id,
        { type: "session.list", params: { limit: CROSS_MESSAGE_LIMITS.listMax, ...(filter.query ? { query: filter.query } : {}) } } as Omit<ClientCommand, "id">,
      );
      if (!listed.ok) return;
      for (const s of listed.result.sessions) {
        if (s.parentSessionId) continue;
        const projectName = s.cwd.split("/").filter(Boolean).pop();
        if (filter.project && !projectName?.toLowerCase().includes(filter.project)) continue;
        out.push({
          id: formatConversationRef({ kind: "env", deviceId: device.id, sessionId: s.id }),
          title: s.title ?? "Untitled thread",
          product: "code",
          ...(projectName ? { project: projectName } : {}),
          state: envState(s.state),
          lastActivity: s.updatedAt,
        });
      }
    }),
  );
  return out;
}

// ── Resolving the two ends ──────────────────────────────────────────────────

/**
 * The sender as the caller names it. A Mac's Alevr engine knows its device and
 * session, not the mirror's row id, so `code` may be given that way.
 */
export async function resolveSender(
  userId: string,
  from: { ref?: string; title?: string; code?: { deviceId: string; sessionId: string } },
): Promise<CrossSender | null> {
  const settings = await crossMessageSettings(userId);
  if (from.code) {
    const row = await prisma.codeRemoteSession.findFirst({
      where: { userId, deviceId: from.code.deviceId, sessionId: from.code.sessionId, deletedAt: null },
      select: { id: true, title: true },
    });
    if (!row) return null;
    return { ref: { kind: "code", id: row.id }, title: row.title, enabled: settings.code };
  }
  const ref = parseConversationRef(from.ref);
  if (!ref) return null;
  if (ref.kind === "chat") {
    const chat = await prisma.conversation.findFirst({ where: { id: ref.id, userId, kind: "chat" }, select: { title: true, crossMessages: true } });
    if (!chat) return null;
    return { ref, title: chat.title, enabled: crossMessagesEnabled(settings.chat, "chat", toggleOf(chat.crossMessages)) };
  }
  if (ref.kind === "code") {
    const row = await prisma.codeRemoteSession.findFirst({ where: { id: ref.id, userId, deletedAt: null }, select: { title: true } });
    if (!row) return null;
    return { ref, title: row.title, enabled: settings.code };
  }
  if (ref.deviceId) {
    const device = await prisma.codeDevice.findFirst({ where: { id: ref.deviceId, userId }, select: { id: true } });
    if (!device) return null;
  }
  // An env thread's own toggle is enforced by its env server before it calls here.
  return { ref, title: clip(from.title ?? "Code thread", 200), enabled: settings.code };
}

export async function resolveTarget(userId: string, ref: ConversationRef): Promise<CrossTarget | { offline: string } | null> {
  const settings = await crossMessageSettings(userId);
  if (ref.kind === "chat") {
    const chat = await prisma.conversation.findFirst({ where: { id: ref.id, userId, kind: "chat" }, select: { title: true, crossMessages: true } });
    if (!chat) return null;
    return {
      ref,
      title: chat.title,
      enabled: crossMessagesEnabled(settings.chat, "chat", toggleOf(chat.crossMessages)),
      state: (await chatIsBusy(userId, ref.id)) ? "working" : "idle",
    };
  }
  if (ref.kind === "code") {
    const row = await prisma.codeRemoteSession.findFirst({
      where: { id: ref.id, userId, deletedAt: null },
      select: { id: true, title: true, deviceId: true, sessionId: true, isRunning: true, isAwaitingApproval: true },
    });
    if (!row) return null;
    return { ref, title: row.title, enabled: settings.code, state: codeState(row), code: { id: row.id, deviceId: row.deviceId, sessionId: row.sessionId } };
  }
  if (!ref.deviceId) return null;
  const device = await prisma.codeDevice.findFirst({ where: { id: ref.deviceId, userId }, select: { id: true } });
  if (!device) return null;
  const read = await envRpc<{ title?: string; state: string }>(userId, device.id, {
    type: "conversation.read",
    params: { sessionId: ref.sessionId, lastN: 1 },
  } as Omit<ClientCommand, "id">);
  if (!read.ok) return { offline: read.error };
  return { ref, title: read.result.title ?? "Untitled thread", enabled: settings.code, state: envState(read.result.state) };
}

// ── Sending ─────────────────────────────────────────────────────────────────

export interface SendInput {
  from: { ref?: string; title?: string; code?: { deviceId: string; sessionId: string } };
  to: string;
  message: string;
  notifyWhenIdle?: boolean;
  /**
   * The chain the send continues, from the engine that ran the turn. A Chat
   * turn names the message it answers instead (trigger), which is checked here.
   */
  chain?: { chainId: string; hop: number } | null;
  trigger?: { linkId: string } | null;
  sentThisTurn?: number;
}

export async function sendCrossMessage(userId: string, input: SendInput): Promise<SendOutcome> {
  const refuse = (reason: SendRefusal | "offline", message: string): SendOutcome => ({ ok: false, reason, message });
  const sender = await resolveSender(userId, input.from);
  if (!sender) return refuse("not_found", "The sending conversation is not one of yours.");
  const toRef = parseConversationRef(input.to);
  if (!toRef) return refuse("not_found", "No conversation of the user's has that id. Call list_conversations for the ids.");
  if (sameConversation(sender.ref, toRef)) return refuse("self", "That is this conversation. Pick another one.");

  let chain = input.chain && Number.isInteger(input.chain.hop) && input.chain.hop >= 0 ? input.chain : null;
  if (input.trigger?.linkId) {
    const trigger = await prisma.conversationMessageLink.findFirst({
      where: { id: input.trigger.linkId, userId },
      select: { chainId: true, hop: true, toRef: true },
    });
    const triggerTo = trigger ? parseConversationRef(trigger.toRef) : null;
    if (!trigger || !triggerTo || !sameConversation(triggerTo, sender.ref)) return refuse("not_found", "That message was not sent to this conversation.");
    chain = { chainId: trigger.chainId, hop: trigger.hop };
  }
  const next = input.trigger ? nextHop(chain, crypto.randomUUID()) : chain ?? { chainId: crypto.randomUUID(), hop: 0 };

  const resolved = await resolveTarget(userId, toRef);
  if (!resolved) return refuse("not_found", "No conversation of the user's has that id. Call list_conversations for the ids.");
  if ("offline" in resolved) return refuse("offline", resolved.offline);

  const fromRef = formatConversationRef(sender.ref);
  const text = input.message.trim();
  const key = dedupeKey(sender.ref, toRef, text);
  const now = new Date();
  const hourAgo = new Date(now.getTime() - HOUR);
  const [byConversation, byAccount, duplicate] = await Promise.all([
    prisma.conversationMessageLink.count({ where: { userId, fromRef, createdAt: { gte: hourAgo } } }),
    prisma.conversationMessageLink.count({ where: { userId, createdAt: { gte: hourAgo } } }),
    prisma.conversationMessageLink.findFirst({
      where: { userId, dedupeKey: key, createdAt: { gte: new Date(now.getTime() - CROSS_MESSAGE_LIMITS.dedupeWindowMs) } },
      select: { id: true },
    }),
  ]);
  const verdict = checkSend({
    enabled: sender.enabled,
    targetEnabled: resolved.enabled,
    from: sender.ref,
    to: toRef,
    text,
    hop: next.hop,
    sentThisTurn: input.sentThisTurn ?? 0,
    sentByConversationLastHour: byConversation,
    sentByAccountLastHour: byAccount,
    duplicate: !!duplicate,
  });
  if (!verdict.ok) return refuse(verdict.reason, verdict.message);

  const link = await prisma.conversationMessageLink.create({
    data: {
      userId,
      fromRef,
      fromTitle: clip(sender.title, 200),
      toRef: formatConversationRef(toRef),
      toTitle: clip(resolved.title, 200),
      text: encryptField(text),
      chainId: next.chainId,
      hop: next.hop,
      status: "queued",
      notifyWhenIdle: input.notifyWhenIdle === true,
      dedupeKey: key,
    },
  });
  const delivery: ConversationDelivery = {
    fromRef,
    fromTitle: clip(sender.title, 200),
    fromProduct: productOfRef(sender.ref),
    text,
    hop: next.hop,
    chainId: next.chainId,
    linkId: link.id,
    ...(input.notifyWhenIdle ? { notifyWhenIdle: true } : {}),
  };
  const status = await deliver(userId, link.id, toRef, resolved, delivery);
  return { ok: true, linkId: link.id, status, target: { ref: formatConversationRef(toRef), title: resolved.title, state: resolved.state } };
}

async function deliver(
  userId: string,
  linkId: string,
  toRef: ConversationRef,
  target: CrossTarget,
  delivery: ConversationDelivery,
): Promise<"queued" | "delivered" | "failed"> {
  if (toRef.kind === "chat") return "queued"; // a client runs the reply (claimCrossReply)
  if (toRef.kind === "code" && target.code) {
    await prisma.codeSessionCommand.create({
      data: {
        userId,
        deviceId: target.code.deviceId,
        remoteSessionId: target.code.id,
        sessionId: target.code.sessionId,
        kind: "cross_message",
        payload: delivery as unknown as Prisma.InputJsonValue,
        idempotencyKey: `cross:${linkId}`,
      },
    });
    return "queued";
  }
  if (toRef.kind === "env" && toRef.deviceId) {
    const sent = await envRpc<{ outcome: string; reason?: string }>(userId, toRef.deviceId, {
      type: "conversation.deliver",
      params: { sessionId: toRef.sessionId, message: delivery },
    } as Omit<ClientCommand, "id">);
    const failed = !sent.ok || sent.result.outcome === "refused";
    await prisma.conversationMessageLink.updateMany({
      where: { id: linkId, userId },
      data: failed
        ? { status: "failed", error: clip(sent.ok ? sent.result.reason ?? "Refused." : sent.error, 300) }
        : { status: "delivered", deliveredAt: new Date() },
    });
    return failed ? "failed" : sent.result.outcome === "queued" ? "queued" : "delivered";
  }
  return "failed";
}

// ── State reports, idle notices ────────────────────────────────────────────

/**
 * An engine reports what became of a message it was handed. "answered" is the
 * target's turn ending; a sender that asked for it then gets its one-shot
 * idle notice.
 */
export async function reportCrossState(userId: string, linkId: string, status: "delivered" | "answered" | "failed", error?: string): Promise<boolean> {
  const now = new Date();
  const updated = await prisma.conversationMessageLink.updateMany({
    where: { id: linkId, userId, status: { not: "answered" } },
    data:
      status === "delivered"
        ? { status, deliveredAt: now }
        : status === "answered"
          ? { status, answeredAt: now }
          : { status, error: clip(error ?? "Failed.", 300) },
  });
  if (updated.count === 0) return false;
  if (status === "answered") await sendIdleNotice(userId, linkId);
  return true;
}

async function sendIdleNotice(userId: string, linkId: string): Promise<void> {
  const claimed = await prisma.conversationMessageLink.updateMany({
    where: { id: linkId, userId, notifyWhenIdle: true, notifiedAt: null },
    data: { notifiedAt: new Date() },
  });
  if (claimed.count === 0) return;
  const link = await prisma.conversationMessageLink.findFirst({ where: { id: linkId, userId } });
  if (!link) return;
  const senderRef = parseConversationRef(link.fromRef);
  if (!senderRef) return;
  const notice: ConversationDelivery = {
    fromRef: link.toRef,
    fromTitle: link.toTitle,
    fromProduct: productOfRef(parseConversationRef(link.toRef) ?? { kind: "chat", id: "x" }),
    text: "Idle again.",
    hop: link.hop + 1,
    chainId: link.chainId,
    linkId: link.id,
    notice: true,
  };
  // A Chat sender shows the notice as a row (notifiedAt) and reads it on its next turn.
  if (senderRef.kind === "code") {
    const row = await prisma.codeRemoteSession.findFirst({ where: { id: senderRef.id, userId }, select: { id: true, deviceId: true, sessionId: true } });
    if (!row) return;
    await prisma.codeSessionCommand.create({
      data: {
        userId,
        deviceId: row.deviceId,
        remoteSessionId: row.id,
        sessionId: row.sessionId,
        kind: "cross_message",
        payload: notice as unknown as Prisma.InputJsonValue,
        idempotencyKey: `cross-notice:${link.id}`,
      },
    });
  } else if (senderRef.kind === "env" && senderRef.deviceId) {
    await envRpc(userId, senderRef.deviceId, {
      type: "conversation.deliver",
      params: { sessionId: senderRef.sessionId, message: notice },
    } as Omit<ClientCommand, "id">);
  }
}

// ── Chat: the reply turn ───────────────────────────────────────────────────

/** Messages waiting for a Chat reply, for an open client to run (oldest first). */
export async function pendingChatReplies(userId: string): Promise<{ linkId: string; conversationId: string }[]> {
  const rows = await prisma.conversationMessageLink.findMany({
    where: {
      userId,
      toRef: { startsWith: "chat:" },
      status: "queued",
      replyClaimedAt: null,
      createdAt: { gte: new Date(Date.now() - 24 * HOUR) },
    },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true, toRef: true },
  });
  return rows.map((row) => ({ linkId: row.id, conversationId: row.toRef.slice("chat:".length) }));
}

export type ClaimOutcome =
  | { ok: true; link: { id: string; chainId: string; hop: number; fromRef: string } }
  | { ok: false; reason: "not_found" | "busy" | "taken" };

/**
 * Claims a queued message for a Chat reply turn. Atomic: two clients (or a
 * retry) never both answer it. A conversation mid-generation is busy, so the
 * message waits for its turn.
 */
export async function claimCrossReply(userId: string, linkId: string, conversationId: string): Promise<ClaimOutcome> {
  const link = await prisma.conversationMessageLink.findFirst({
    where: { id: linkId, userId, toRef: `chat:${conversationId}` },
    select: { id: true, chainId: true, hop: true, status: true, fromRef: true },
  });
  if (!link) return { ok: false, reason: "not_found" };
  if (await chatIsBusy(userId, conversationId)) return { ok: false, reason: "busy" };
  const claimed = await prisma.conversationMessageLink.updateMany({
    where: { id: linkId, userId, status: "queued", replyClaimedAt: null },
    data: { replyClaimedAt: new Date(), status: "delivered", deliveredAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, reason: "taken" };
  return { ok: true, link: { id: link.id, chainId: link.chainId, hop: link.hop, fromRef: link.fromRef } };
}

/**
 * A person's own turn in a Chat reads every message waiting there, so they
 * are handled by it rather than answered again in a turn of their own.
 */
export async function claimQueuedForUserTurn(userId: string, conversationId: string): Promise<string[]> {
  const rows = await prisma.conversationMessageLink.findMany({
    where: { userId, toRef: `chat:${conversationId}`, status: "queued", replyClaimedAt: null },
    select: { id: true },
  });
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  await prisma.conversationMessageLink.updateMany({
    where: { userId, id: { in: ids }, status: "queued", replyClaimedAt: null },
    data: { replyClaimedAt: new Date(), status: "delivered", deliveredAt: new Date() },
  });
  return ids;
}

/** A claimed turn that never started (quota refused it): the messages wait again. */
export async function releaseCrossClaims(userId: string, linkIds: readonly string[]): Promise<void> {
  if (linkIds.length === 0) return;
  await prisma.conversationMessageLink.updateMany({
    where: { userId, id: { in: [...linkIds] }, status: "delivered", answeredAt: null },
    data: { status: "queued", replyClaimedAt: null, deliveredAt: null },
  });
}

/** The turn that handled these messages finished. */
export async function markCrossAnswered(userId: string, linkIds: readonly string[]): Promise<void> {
  for (const id of linkIds) await reportCrossState(userId, id, "answered");
}

// ── Chat: what the transcript and the model see ───────────────────────────

export interface ClientCrossMessage {
  id: string;
  direction: "received" | "sent" | "notice";
  peerRef: string;
  peerTitle: string;
  peerProduct: CrossProduct;
  /** Where the other conversation opens on the web, when it has a page there. */
  peerHref: string | null;
  text: string;
  status: string;
  hop: number;
  createdAt: string;
  read: boolean;
}

export const peerHref = peerHrefForRef;

/** Every message to and from one Chat conversation, oldest first, plus idle notices it asked for. */
export async function crossMessagesForChat(userId: string, conversationId: string): Promise<ClientCrossMessage[]> {
  const ref = `chat:${conversationId}`;
  const rows = await prisma.conversationMessageLink.findMany({
    where: { userId, OR: [{ toRef: ref }, { fromRef: ref }] },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const out: ClientCrossMessage[] = [];
  for (const row of rows) {
    const received = row.toRef === ref;
    const peer = received ? row.fromRef : row.toRef;
    const peerParsed = parseConversationRef(peer);
    const base = {
      peerRef: peer,
      peerTitle: received ? row.fromTitle : row.toTitle,
      peerProduct: peerParsed ? productOfRef(peerParsed) : ("chat" as const),
      peerHref: peerHref(peer),
      status: row.status,
      hop: row.hop,
    };
    out.push({
      id: row.id,
      direction: received ? "received" : "sent",
      ...base,
      text: decryptField(row.text) ?? "",
      createdAt: row.createdAt.toISOString(),
      read: !received || !!row.readAt,
    });
    if (!received && row.notifyWhenIdle && row.notifiedAt) {
      out.push({ id: `${row.id}:notice`, direction: "notice", ...base, text: "Idle again.", createdAt: row.notifiedAt.toISOString(), read: true });
    }
  }
  return out;
}

/** Entries the model reads in a Chat's history, as framed user-side turns. */
export async function crossHistoryEntries(userId: string, conversationId: string): Promise<{ id: string; createdAt: Date; content: string }[]> {
  const { frameCrossMessage, idleNoticeText } = await import("./policy");
  const messages = await crossMessagesForChat(userId, conversationId);
  return messages
    .filter((m) => m.direction !== "sent")
    .map((m) => ({
      id: `cross_${m.id}`,
      createdAt: new Date(m.createdAt),
      content:
        m.direction === "notice"
          ? idleNoticeText({ targetTitle: m.peerTitle, targetRef: m.peerRef })
          : frameCrossMessage({ fromTitle: m.peerTitle, fromRef: m.peerRef, fromProduct: m.peerProduct, hop: m.hop, text: m.text }),
    }));
}

export async function markCrossRead(userId: string, conversationId: string): Promise<number> {
  const updated = await prisma.conversationMessageLink.updateMany({
    where: { userId, toRef: `chat:${conversationId}`, readAt: null },
    data: { readAt: new Date() },
  });
  return updated.count;
}

/** Chat conversations with a message from another conversation the reader has not opened yet. */
export async function unreadCrossConversationIds(userId: string): Promise<string[]> {
  const rows = await prisma.conversationMessageLink.findMany({
    where: { userId, toRef: { startsWith: "chat:" }, readAt: null, createdAt: { gte: new Date(Date.now() - 14 * 24 * HOUR) } },
    select: { toRef: true },
    take: 200,
  });
  return [...new Set(rows.map((row) => row.toRef.slice("chat:".length)))];
}

// ── Reading another conversation ────────────────────────────────────────────

export async function readCrossConversation(
  userId: string,
  reader: ConversationRef | null,
  id: string,
  lastN: unknown,
): Promise<{ ok: true; title: string; messages: ConversationExcerptMessage[] } | { ok: false; message: string }> {
  const ref = parseConversationRef(id);
  if (!ref) return { ok: false, message: "No conversation of the user's has that id." };
  if (reader && sameConversation(reader, ref)) return { ok: false, message: "That is this conversation." };
  const count = clampReadCount(lastN);
  const max = CROSS_MESSAGE_LIMITS.readMessageChars;
  if (ref.kind === "chat") {
    const chat = await prisma.conversation.findFirst({ where: { id: ref.id, userId, kind: "chat" }, select: { id: true, title: true } });
    if (!chat) return { ok: false, message: "No conversation of the user's has that id." };
    const [rows, cross] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId: chat.id, conversation: { userId }, role: { in: ["USER", "ASSISTANT"] } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: count,
        select: { role: true, content: true, createdAt: true },
      }),
      crossMessagesForChat(userId, chat.id),
    ]);
    const messages: ConversationExcerptMessage[] = [
      ...rows.map((row) => ({
        role: row.role === "USER" ? ("user" as const) : ("assistant" as const),
        text: clip(decryptMessageText(row.content) ?? "", max),
        at: row.createdAt.toISOString(),
      })),
      ...cross
        .filter((m) => m.direction !== "notice")
        .map((m) => ({ role: "conversation" as const, text: clip(m.text, max), at: m.createdAt, peerTitle: m.peerTitle })),
    ]
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-count);
    return { ok: true, title: chat.title, messages };
  }
  if (ref.kind === "code") {
    const row = await prisma.codeRemoteSession.findFirst({ where: { id: ref.id, userId, deletedAt: null }, select: { title: true, transcript: true } });
    if (!row) return { ok: false, message: "No conversation of the user's has that id." };
    return { ok: true, title: row.title, messages: excerptFromTranscript(row.transcript, count, max) };
  }
  if (!ref.deviceId) return { ok: false, message: "Name the Mac this thread is on (env:<device>/<thread>)." };
  const device = await prisma.codeDevice.findFirst({ where: { id: ref.deviceId, userId }, select: { id: true } });
  if (!device) return { ok: false, message: "No conversation of the user's has that id." };
  const read = await envRpc<{ title?: string; messages: ConversationExcerptMessage[] }>(userId, device.id, {
    type: "conversation.read",
    params: { sessionId: ref.sessionId, lastN: count },
  } as Omit<ClientCommand, "id">);
  if (!read.ok) return { ok: false, message: read.error };
  return { ok: true, title: read.result.title ?? "Untitled thread", messages: read.result.messages.slice(-count) };
}

/**
 * The Mac's synced transcript is whatever its policy kept: entries with a role
 * (or kind) and text (or content). Anything else is skipped, and a
 * metadata-only session reads as empty.
 */
export function excerptFromTranscript(transcript: Prisma.JsonValue | null, count: number, max: number): ConversationExcerptMessage[] {
  const entries = Array.isArray(transcript)
    ? transcript
    : transcript && typeof transcript === "object" && Array.isArray((transcript as Record<string, unknown>).entries)
      ? ((transcript as Record<string, unknown>).entries as Prisma.JsonValue[])
      : [];
  const out: ConversationExcerptMessage[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const role = String(e.role ?? e.kind ?? "").toLowerCase();
    const text = typeof e.text === "string" ? e.text : typeof e.content === "string" ? e.content : "";
    if (!text.trim()) continue;
    const at = typeof e.createdAt === "string" ? e.createdAt : typeof e.at === "string" ? e.at : "";
    if (role === "user" || role === "user_message") out.push({ role: "user", text: clip(text, max), at });
    else if (role === "assistant" || role === "assistant_message") out.push({ role: "assistant", text: clip(text, max), at });
  }
  return out.slice(-count);
}
