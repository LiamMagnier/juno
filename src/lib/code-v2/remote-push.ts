/**
 * Pushes for remote control (docs/code-v2/REMOTE-CONTROL.md §Approvals, §Sync):
 *
 * - an approval a session on the Mac is waiting on goes to the PAIRED phones
 *   as an actionable notification (Allow once / Deny, category
 *   `ALEVR_CODE_APPROVAL`); the action answers through the device link like the
 *   in-app card does;
 * - once the approval is answered anywhere, a background push withdraws that
 *   notification on every phone, and the thread's needs-you flag clears in the
 *   shared thread state;
 * - "Continue on iPhone / Mac" sends the open thread to the other app.
 *
 * The host route calls `noteHostEvents` with every batch the Mac pushes.
 * Notifications are deduplicated per request id here, and APNs collapses by
 * the same id, so a replayed snapshot never rings twice.
 */
import { prisma } from "@/lib/prisma";
import { apnsTopicFor, sendApnsNotification, type ApnsPayload, type SendApnsResult } from "@/lib/apns";
import type { ServerEventEnvelope, TurnItem } from "@/lib/code-v2/contracts";
import { codeThreadKey, writeThreadSync, type ThreadSyncStore } from "@/lib/sync/thread-sync";

export const APNS_CATEGORY_CODE_APPROVAL = "ALEVR_CODE_APPROVAL";
export const APNS_CATEGORY_HANDOFF = "ALEVR_HANDOFF";
/** The action identifiers the apps register on `ALEVR_CODE_APPROVAL`. */
export const APPROVAL_ACTION_ALLOW_ONCE = "alevr.approval.allow-once";
export const APPROVAL_ACTION_DENY = "alevr.approval.deny";

type ApprovalItem = Extract<TurnItem, { kind: "approval_request" }>;

export interface ApprovalFact {
  sessionId: string;
  requestId: string;
  summary: string;
  detail?: string;
  action: ApprovalItem["action"];
  pending: boolean;
}

/** The approval facts in a batch of link events, in order (a snapshot's pending ones included). */
export function approvalFacts(events: readonly ServerEventEnvelope[]): ApprovalFact[] {
  const out: ApprovalFact[] = [];
  const fromItem = (sessionId: string, item: TurnItem | undefined) => {
    // What the Mac pushes is not re-validated on the way in: read defensively.
    if (!item || item.kind !== "approval_request" || typeof item.requestId !== "string") return;
    out.push({
      sessionId,
      requestId: item.requestId,
      summary: item.summary,
      ...(item.detail ? { detail: item.detail } : {}),
      action: item.action,
      pending: item.status === "pending",
    });
  };
  for (const envelope of events) {
    if (envelope?.stream !== "session" || !envelope.sessionId || !envelope.event) continue;
    const event = envelope.event;
    if (event.type === "item.added" || event.type === "item.updated") fromItem(envelope.sessionId, event.item);
    else if (event.type === "session.snapshot" && Array.isArray(event.session?.items)) for (const item of event.session.items) fromItem(envelope.sessionId, item);
  }
  return out;
}

/** Session state changes: "waiting" means it needs the person. */
export function waitingFacts(events: readonly ServerEventEnvelope[]): Array<{ sessionId: string; waiting: boolean }> {
  const out: Array<{ sessionId: string; waiting: boolean }> = [];
  for (const envelope of events) {
    if (envelope?.stream !== "session" || !envelope.sessionId || !envelope.event) continue;
    const event = envelope.event;
    if (event.type === "session.state") out.push({ sessionId: envelope.sessionId, waiting: event.state === "waiting" });
    else if (event.type === "session.snapshot" && event.session) out.push({ sessionId: envelope.sessionId, waiting: event.session.state === "waiting" });
  }
  return out;
}

const clamp = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function buildLinkApprovalPayload(input: { deviceId: string; deviceName: string; fact: ApprovalFact; title?: string }): ApnsPayload {
  const verb = input.fact.action === "command" ? "run a command" : input.fact.action === "file_change" ? "change files" : "continue";
  return {
    aps: {
      alert: {
        title: `Alevr on ${clamp(input.deviceName, 60)} wants to ${verb}`,
        ...(input.title ? { subtitle: clamp(input.title, 80) } : {}),
        body: clamp(input.fact.summary || input.fact.detail || "Open it to decide.", 300),
      },
      sound: "default",
      category: APNS_CATEGORY_CODE_APPROVAL,
      "thread-id": `code-${input.deviceId}-${input.fact.sessionId}`,
      "interruption-level": "time-sensitive",
    },
    link: "v2",
    deviceID: input.deviceId,
    sessionID: input.fact.sessionId,
    requestID: input.fact.requestId,
  };
}

/** A background push: remove the delivered approval notification with this request id. */
export function buildApprovalClearedPayload(input: { deviceId: string; sessionId: string; requestId: string }): ApnsPayload {
  return {
    aps: { "content-available": 1 },
    clearApproval: input.requestId,
    deviceID: input.deviceId,
    sessionID: input.sessionId,
  };
}

export type HandoffTarget = "ios" | "macos";

export interface HandoffInput {
  target: HandoffTarget;
  kind: "chat" | "code";
  /** chat: the conversation id. code: the session id on the Mac. */
  id: string;
  deviceId?: string;
  title?: string;
}

export function buildHandoffPayload(input: HandoffInput): ApnsPayload {
  const place = input.target === "ios" ? "iPhone" : "Mac";
  const payload: ApnsPayload = {
    aps: {
      alert: { title: `Continue on this ${place}`, body: clamp(input.title?.trim() || (input.kind === "chat" ? "A chat" : "An Alevr Code session"), 200) },
      sound: "default",
      category: APNS_CATEGORY_HANDOFF,
      "thread-id": "handoff",
      "interruption-level": "active",
    },
    handoff: input.kind,
  };
  if (input.kind === "chat") {
    payload.conversationId = input.id;
    payload.path = `/chat/${encodeURIComponent(input.id)}`;
  } else {
    payload.sessionID = input.id;
    if (input.deviceId) payload.deviceID = input.deviceId;
  }
  return payload;
}

// ── Delivery ────────────────────────────────────────────────────────────────

export interface PushDelivery {
  /** Only these native sign-ins (the paired phones). */
  deviceSessionIds?: string[];
  platform?: "ios" | "macos";
  /** Never this sign-in (the device that asked). */
  excludeDeviceSessionId?: string | null;
  /** Follow each device's "needs you" switch. */
  needsYou?: boolean;
}

export type PushSender = (userId: string, delivery: PushDelivery, payload: ApnsPayload, options?: { collapseId?: string; pushType?: "alert" | "background"; priority?: 5 | 10 }) => Promise<SendApnsResult[]>;

export const sendPushToDevices: PushSender = async (userId, delivery, payload, options) => {
  if (delivery.deviceSessionIds && delivery.deviceSessionIds.length === 0) return [];
  const devices = await prisma.devicePushToken.findMany({
    where: {
      userId,
      active: true,
      ...(delivery.platform ? { platform: delivery.platform } : {}),
      ...(delivery.needsYou ? { notifyNeedsYou: true } : {}),
      ...(delivery.deviceSessionIds ? { deviceSessionId: { in: delivery.deviceSessionIds } } : {}),
    },
    select: { token: true, platform: true, bundleId: true, environment: true, deviceSessionId: true },
  });
  const results: SendApnsResult[] = [];
  for (const device of devices) {
    if (delivery.excludeDeviceSessionId && device.deviceSessionId === delivery.excludeDeviceSessionId) continue;
    results.push(
      await sendApnsNotification({
        token: device.token,
        payload,
        topic: apnsTopicFor(device),
        environment: device.environment === "sandbox" ? "sandbox" : device.environment === "production" ? "production" : undefined,
        ...(options?.collapseId ? { collapseId: options.collapseId.slice(0, 64) } : {}),
        pushType: options?.pushType ?? "alert",
        priority: options?.priority ?? (options?.pushType === "background" ? 5 : 10),
      }),
    );
  }
  return results;
};

/** Remembers what was already announced, so a replay or a repeat never rings twice. Bounded. */
class Seen {
  #keys = new Map<string, true>();
  constructor(private readonly limit = 5000) {}
  /** True the first time `key` is seen. */
  first(key: string): boolean {
    if (this.#keys.has(key)) return false;
    this.#keys.set(key, true);
    if (this.#keys.size > this.limit) this.#keys.delete(this.#keys.keys().next().value as string);
    return true;
  }
  has(key: string): boolean {
    return this.#keys.has(key);
  }
}

export interface HostEventDeps {
  /** The live phone pairs of this Mac: their native sign-ins. */
  pairedPhones(userId: string, deviceId: string): Promise<string[]>;
  deviceName(userId: string, deviceId: string): Promise<string>;
  push: PushSender;
  threads: ThreadSyncStore;
}

let announced = new Seen();
let cleared = new Seen();

/** Test hook: a fresh memory of what was announced. */
export function resetRemotePushMemory(): void {
  announced = new Seen();
  cleared = new Seen();
}

/**
 * Called with every batch the Mac pushes through the device link. Rings the
 * paired phones for a new pending approval, withdraws it once answered, and
 * keeps the thread's needs-you flag in the shared state.
 */
export async function noteHostEvents(deps: HostEventDeps, userId: string, deviceId: string, events: readonly ServerEventEnvelope[]): Promise<{ announced: number; cleared: number }> {
  const approvals = approvalFacts(events);
  const waiting = waitingFacts(events);
  let rang = 0;
  let withdrawn = 0;
  if (approvals.length === 0 && waiting.length === 0) return { announced: 0, cleared: 0 };

  let phones: string[] | null = null;
  let name: string | null = null;
  for (const fact of approvals) {
    const key = `${userId}:${deviceId}:${fact.requestId}`;
    if (fact.pending) {
      if (cleared.has(key) || !announced.first(key)) continue;
      phones ??= await deps.pairedPhones(userId, deviceId);
      if (phones.length === 0) continue;
      name ??= await deps.deviceName(userId, deviceId);
      await deps.push(userId, { deviceSessionIds: phones, platform: "ios", needsYou: true }, buildLinkApprovalPayload({ deviceId, deviceName: name, fact }), {
        collapseId: fact.requestId,
      });
      rang++;
    } else if (cleared.first(key)) {
      // Withdrawn only where it was announced (or might have been, before a
      // restart): every paired phone, as a silent background push.
      phones ??= await deps.pairedPhones(userId, deviceId);
      if (phones.length > 0) {
        await deps.push(userId, { deviceSessionIds: phones, platform: "ios" }, buildApprovalClearedPayload({ deviceId, sessionId: fact.sessionId, requestId: fact.requestId }), {
          pushType: "background",
        });
      }
      withdrawn++;
    }
  }
  // The last word per session wins within a batch.
  const latest = new Map<string, boolean>();
  for (const w of waiting) latest.set(w.sessionId, w.waiting);
  for (const fact of approvals) if (fact.pending) latest.set(fact.sessionId, true);
  for (const [sessionId, needsYou] of latest) {
    await writeThreadSync(deps.threads, userId, codeThreadKey(deviceId, sessionId), { needsYou });
  }
  return { announced: rang, cleared: withdrawn };
}
