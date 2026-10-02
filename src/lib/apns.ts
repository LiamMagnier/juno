import http2 from "node:http2";
import { SignJWT, importPKCS8 } from "jose";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { safeAppPath } from "@/lib/notify/paths";
import { clampPushText, pushRouteIds, pushSwitchFilter, type NotifyPush } from "@/lib/notify/push";
import type { NotifyChannel } from "@/lib/notify/types";
import { PRODUCT_NAME } from "@/lib/brand/names";

export interface ApnsPayload {
  aps: {
    alert?: {
      title?: string;
      subtitle?: string;
      body?: string;
    } | string;
    badge?: number;
    sound?: string;
    "thread-id"?: string;
    category?: string;
    "content-available"?: number;
    "mutable-content"?: number;
    "target-content-id"?: string;
    "interruption-level"?: "passive" | "active" | "time-sensitive" | "critical";
    relevance_score?: number;
  };
  [key: string]: unknown;
}

export interface SendApnsOptions {
  token: string;
  payload: ApnsPayload;
  topic?: string;
  environment?: "production" | "sandbox";
  priority?: 5 | 10;
  expiration?: number;
  collapseId?: string;
  pushType?: "alert" | "background" | "voip" | "liveactivity";
}

export interface SendApnsResult {
  success: boolean;
  simulated?: boolean;
  apnsId?: string;
  statusCode?: number;
  error?: string;
  reason?: string;
}

export interface RegisterDevicePushTokenParams {
  userId: string;
  token: string;
  platform?: "ios" | "macos" | string;
  /** The app's own bundle id. Absent means "the platform's app" at send time. */
  bundleId?: string | null;
  environment?: "production" | "sandbox";
  /** The native sign-in that registered it, so revoking that sign-in stops its pushes. */
  deviceSessionId?: string | null;
  /** Omitted keeps what the device already chose (a re-registration is not a reset). */
  notifyNeedsYou?: boolean;
  notifyUpdates?: boolean;
}

/**
 * The apps' bundle ids, which are the APNs topics. The Debug and Next builds
 * append `.debug` / `.next` and always say so at registration; these are the
 * fallback for a row that never did.
 */
export const APNS_IOS_BUNDLE_ID = "com.liammagnier.JunoMobile";
export const APNS_MACOS_BUNDLE_ID = "com.liammagnier.JunoDesktop";

type ApnsEnvironment = "production" | "sandbox";

/**
 * The topic a device is pushed on: its own bundle id, else what the caller
 * named, else the deployment's `APNS_BUNDLE_ID`, else its platform's app.
 * Read lazily — the tsx workers pick `.env` up when Prisma is constructed,
 * which can be after this module is evaluated.
 */
export function apnsTopicFor(device: { platform: string; bundleId: string | null }, fallback?: string | null): string {
  return (
    device.bundleId?.trim() ||
    fallback?.trim() ||
    process.env.APNS_BUNDLE_ID?.trim() ||
    (device.platform === "macos" ? APNS_MACOS_BUNDLE_ID : APNS_IOS_BUNDLE_ID)
  );
}

/** A token as the apps print it (`<abcd 1234>`) or as it is stored (`abcd1234`). */
export function cleanDeviceToken(token: string): string {
  return token.trim().replace(/[<\s>]/g, "").toLowerCase();
}

function isApnsEnvironment(value: unknown): value is ApnsEnvironment {
  return value === "production" || value === "sandbox";
}

let cachedAuthToken: { token: string; expiresAt: number } | null = null;

/**
 * Returns a signed JWT for APNs authentication (ES256, valid for 50 minutes).
 */
export async function getApnsJwt(): Promise<string | null> {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const p8Key = process.env.APNS_PRIVATE_KEY || process.env.APNS_P8;

  if (!keyId || !teamId || !p8Key) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedAuthToken && cachedAuthToken.expiresAt > now + 300) {
    return cachedAuthToken.token;
  }

  try {
    const formattedKey = p8Key.includes("-----BEGIN")
      ? p8Key
      : `-----BEGIN PRIVATE KEY-----\n${p8Key}\n-----END PRIVATE KEY-----`;

    const privateKey = await importPKCS8(formattedKey, "ES256");

    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: keyId })
      .setIssuer(teamId)
      .setIssuedAt(now)
      .sign(privateKey);

    cachedAuthToken = {
      token: jwt,
      expiresAt: now + 50 * 60,
    };

    return jwt;
  } catch (err) {
    console.error("[apns] failed to sign APNs JWT:", err);
    return null;
  }
}

/**
 * Registers or updates an APNs device token for a user.
 *
 * Upserted by token, which is globally unique: a phone signed into a second
 * account moves to it, and its switches start over rather than carrying the
 * last account's choices across.
 */
export async function registerDevicePushToken({
  userId,
  token,
  platform = "ios",
  bundleId = null,
  environment = "production",
  deviceSessionId = null,
  notifyNeedsYou,
  notifyUpdates,
}: RegisterDevicePushTokenParams) {
  const cleanToken = cleanDeviceToken(token);
  // Cross-account on purpose: the token is the key, whoever held it before.
  const existing = await prismaUnguarded.devicePushToken.findUnique({
    where: { token: cleanToken },
    select: { userId: true },
  });
  const sameOwner = existing?.userId === userId;

  return await prismaUnguarded.devicePushToken.upsert({
    where: { token: cleanToken },
    update: {
      userId,
      platform,
      bundleId,
      environment,
      deviceSessionId,
      active: true,
      lastUsedAt: new Date(),
      notifyNeedsYou: notifyNeedsYou ?? (sameOwner ? undefined : true),
      notifyUpdates: notifyUpdates ?? (sameOwner ? undefined : true),
    },
    create: {
      userId,
      token: cleanToken,
      platform,
      bundleId,
      environment,
      deviceSessionId,
      active: true,
      notifyNeedsYou: notifyNeedsYou ?? true,
      notifyUpdates: notifyUpdates ?? true,
    },
  });
}

/**
 * Dispatches an APNs request using Node.js native HTTP/2 client.
 */
function sendApnsHttp2Request(
  host: string,
  path: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = 10_000
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    let client: http2.ClientHttp2Session;
    try {
      client = http2.connect(`https://${host}:443`);
    } catch (err) {
      return reject(err);
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      client.destroy(new Error("APNs request timed out"));
      reject(new Error("APNs request timed out"));
    }, timeoutMs);

    client.on("error", (err) => {
      clearTimeout(timer);
      if (!timedOut) reject(err);
    });

    const req = client.request({
      ":method": "POST",
      ":path": path,
      ...headers,
    });

    let resBody = "";
    let statusCode = 0;
    let resHeaders: Record<string, string | string[] | undefined> = {};

    req.on("response", (hdrs) => {
      statusCode = Number(hdrs[":status"]) || 0;
      resHeaders = hdrs;
    });

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      resBody += chunk;
    });

    req.on("end", () => {
      clearTimeout(timer);
      client.close();
      resolve({ statusCode, headers: resHeaders, body: resBody });
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      client.destroy();
      if (!timedOut) reject(err);
    });

    req.write(body);
    req.end();
  });
}

/**
 * Deactivates or unregisters a device push token.
 * If userId is provided, ensures only the authenticated user's token is deactivated.
 */
export async function deactivateDevicePushToken(token: string, userId?: string) {
  const cleanToken = cleanDeviceToken(token);
  return await prismaUnguarded.devicePushToken.updateMany({
    where: {
      token: cleanToken,
      ...(userId ? { userId } : {}),
    },
    data: { active: false },
  });
}

/**
 * One POST to one APNs host: whether Apple took it, the status, Apple's id for
 * it and its refusal reason. `ok` is the status alone — a refusal whose body
 * is empty or not Apple's JSON (a proxy's 502) has no reason to read, and must
 * still count as a refusal.
 */
async function postToApns(
  environment: ApnsEnvironment,
  token: string,
  headers: Record<string, string>,
  body: string
): Promise<{ ok: boolean; statusCode: number; apnsId: string | undefined; reason: string | undefined }> {
  const host = environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const res = await sendApnsHttp2Request(host, `/3/device/${token}`, headers, body);
  const apnsId = typeof res.headers["apns-id"] === "string" ? res.headers["apns-id"] : undefined;
  if (res.statusCode >= 200 && res.statusCode < 300) {
    return { ok: true, statusCode: res.statusCode, apnsId, reason: undefined };
  }
  let reason: string | undefined;
  try {
    reason = (JSON.parse(res.body) as { reason?: string }).reason;
  } catch {
    reason = res.body || undefined;
  }
  return { ok: false, statusCode: res.statusCode, apnsId, reason };
}

/** Apple's answer for a token that will never take a push again. */
function isDeadToken(statusCode: number, reason: string | undefined): boolean {
  return statusCode === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
}

/**
 * Dispatches an APNs push notification over HTTP/2.
 * Falls back to simulation mode if APNs credentials are not configured.
 *
 * A `BadDeviceToken` is tried once more against the other environment before
 * the token is given up on. A development-signed build of the app gets a
 * sandbox token whatever channel it thinks it is, and says "production" at
 * registration often enough that deactivating on the first refusal silently
 * switched pushes off for exactly the builds they were being tested on. When
 * the other side takes it, the row learns its real environment.
 */
export async function sendApnsNotification(options: SendApnsOptions): Promise<SendApnsResult> {
  const cleanToken = cleanDeviceToken(options.token);
  const topic = options.topic || process.env.APNS_BUNDLE_ID || APNS_IOS_BUNDLE_ID;
  const environment: ApnsEnvironment =
    options.environment || (process.env.NODE_ENV === "production" ? "production" : "sandbox");

  const jwt = await getApnsJwt();

  // If APNs is not configured in local development/CI, return clean simulated success
  if (!jwt) {
    return {
      success: true,
      simulated: true,
      apnsId: `sim_${Date.now()}_${cleanToken.slice(0, 8)}`,
    };
  }

  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": topic,
    "apns-push-type": options.pushType || "alert",
    "apns-priority": String(options.priority ?? 10),
  };

  if (options.expiration !== undefined) {
    headers["apns-expiration"] = String(options.expiration);
  }
  if (options.collapseId) {
    headers["apns-collapse-id"] = options.collapseId;
  }

  const body = JSON.stringify(options.payload);
  try {
    let res = await postToApns(environment, cleanToken, headers, body);

    if (res.reason === "BadDeviceToken") {
      const other: ApnsEnvironment = environment === "production" ? "sandbox" : "production";
      const retried = await postToApns(other, cleanToken, headers, body);
      if (retried.ok) {
        await prismaUnguarded.devicePushToken
          .updateMany({ where: { token: cleanToken }, data: { environment: other } })
          .catch((error: unknown) => {
            console.warn("[apns] could not record a token's environment", error instanceof Error ? error.message : String(error));
          });
      }
      res = retried;
    }

    if (res.ok) {
      return {
        success: true,
        apnsId: res.apnsId,
        statusCode: res.statusCode,
      };
    }

    // Token is unregistered or invalid in both environments: deactivate it
    if (isDeadToken(res.statusCode, res.reason)) {
      await deactivateDevicePushToken(cleanToken);
    }

    return {
      success: false,
      statusCode: res.statusCode,
      apnsId: res.apnsId,
      reason: res.reason,
      error: `APNs returned HTTP ${res.statusCode}: ${res.reason || "Unknown error"}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Sends an APNs push notification to all active devices registered to a user.
 *
 * Each device's own topic and environment win over `options`: they are facts
 * about that install, and one caller's default must not redirect every phone
 * on the account to the wrong app or the wrong APNs host. With a `channel`,
 * only devices whose switch for it is on are sent to.
 */
export async function sendPushToUser(
  userId: string,
  payload: ApnsPayload,
  options?: Partial<Omit<SendApnsOptions, "token" | "payload">>,
  filter?: { channel?: NotifyChannel }
): Promise<SendApnsResult[]> {
  try {
    const devices = await prisma.devicePushToken.findMany({
      where: { userId, active: true, ...(filter?.channel ? pushSwitchFilter(filter.channel) : {}) },
      select: { id: true, token: true, platform: true, bundleId: true, environment: true },
    });

    if (!devices || devices.length === 0) return [];

    const results: SendApnsResult[] = [];
    for (const device of devices) {
      const res = await sendApnsNotification({
        ...options,
        token: device.token,
        payload,
        topic: apnsTopicFor(device, options?.topic),
        environment: isApnsEnvironment(device.environment) ? device.environment : options?.environment,
      });
      if (res.success && !res.simulated) {
        await prisma.devicePushToken
          .updateMany({ where: { id: device.id, userId }, data: { lastUsedAt: new Date() } })
          .catch(() => undefined);
      }
      results.push(res);
    }

    return results;
  } catch (err) {
    console.warn("[apns] unable to query registered devices for user:", userId, err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Notifications (docs/design/AGENTS.md §8)
// ---------------------------------------------------------------------------

/** `aps.category` per channel. The apps register both, with their actions. */
export const APNS_CATEGORY_NEEDS_YOU = "JUNO_NEEDS_YOU";
export const APNS_CATEGORY_UPDATE = "JUNO_UPDATE";

export interface NotifyApnsInput {
  /** The in-app row, so opening the push can mark it read. */
  notificationId: string | null;
  /** Relative in-app path; revalidated here and dropped when it is not one. */
  path: string | null;
  channel: NotifyChannel;
  /** The agent it is about, when there is one. */
  agentId?: string | null;
  push: NotifyPush;
}

/**
 * The payload for one `notifyUser` push, as the apps read it: `aps` for the
 * system, and beside it flat string keys to route on — `notificationId`,
 * `path`, `kind` ("agent" when an agent is speaking, else "work"), and the ids
 * that are known of `agentId`, `conversationId`, `sessionId`, `runId`.
 *
 * No badge. The apps keep no badge state of their own, so a number set from
 * here would stay on the icon after the inbox was read.
 */
export function buildNotifyApnsPayload(input: NotifyApnsInput): ApnsPayload {
  const { push } = input;
  // The named agent goes through the same id check as the rest, so every
  // routing key the apps read has passed it.
  const ids = pushRouteIds(input.agentId ? { ...push.data, agentId: input.agentId } : push.data);
  const agentId = ids.agentId ?? null;
  const path = safeAppPath(input.path);
  const subtitle = push.subtitle?.trim() ? clampPushText(push.subtitle, 120) : undefined;

  const payload: ApnsPayload = {
    aps: {
      alert: {
        title: clampPushText(push.title, 120),
        ...(subtitle ? { subtitle } : {}),
        body: clampPushText(push.body, 300),
      },
      // A passive notification arrives in the list without a sound; that is
      // what passive means.
      ...(push.interruption === "passive" ? {} : { sound: "default" }),
      category: input.channel === "needs_you" ? APNS_CATEGORY_NEEDS_YOU : APNS_CATEGORY_UPDATE,
      "thread-id": push.threadId,
      "interruption-level": push.interruption,
    },
    kind: agentId ? "agent" : "work",
  };
  if (input.notificationId) payload.notificationId = input.notificationId;
  if (path) payload.path = path;
  if (agentId) payload.agentId = agentId;
  if (ids.conversationId) payload.conversationId = ids.conversationId;
  if (ids.sessionId) payload.sessionId = ids.sessionId;
  if (ids.runId) payload.runId = ids.runId;
  return payload;
}

const MAX_COLLAPSE_ID_BYTES = 64;

/**
 * The request headers a `notifyUser` push goes out with: priority 5 for a
 * passive one (Apple may batch it for battery) and 10 otherwise, the collapse
 * id when it fits APNs's 64 bytes, and the expiry in epoch seconds.
 */
export function notifyApnsOptions(
  push: Pick<NotifyPush, "collapseId" | "expiresAt" | "interruption">
): Pick<SendApnsOptions, "priority" | "collapseId" | "expiration"> {
  const options: Pick<SendApnsOptions, "priority" | "collapseId" | "expiration"> = {
    priority: push.interruption === "passive" ? 5 : 10,
  };
  const collapseId = push.collapseId?.trim();
  if (collapseId && new TextEncoder().encode(collapseId).length <= MAX_COLLAPSE_ID_BYTES) {
    options.collapseId = collapseId;
  }
  if (push.expiresAt) options.expiration = Math.max(0, Math.floor(push.expiresAt.getTime() / 1000));
  return options;
}

/**
 * Builds the APNs payload for a Juno Code tool approval request.
 */
export function buildCodeApprovalPayload({
  sessionId,
  approvalId,
  toolName,
  prompt,
  workspace,
}: {
  sessionId: string;
  approvalId: string;
  toolName: string;
  prompt: string;
  workspace?: string;
}): ApnsPayload {
  return {
    aps: {
      alert: {
        title: `${PRODUCT_NAME} Code: Approval Required`,
        subtitle: workspace ? `Workspace: ${workspace}` : undefined,
        body: `Action "${toolName}" requires your review: ${prompt.slice(0, 120)}`,
      },
      sound: "default",
      category: "CODE_APPROVAL",
      "thread-id": `code-session-${sessionId}`,
      "interruption-level": "time-sensitive",
    },
    sessionId,
    approvalId,
    toolName,
    action: "approve_or_reject",
  };
}

/**
 * Builds the APNs payload for a task completion or failure.
 */
export function buildTaskCompletionPayload({
  taskId,
  title,
  status,
  summary,
}: {
  taskId: string;
  title: string;
  status: "completed" | "failed";
  summary?: string;
}): ApnsPayload {
  const isCompleted = status === "completed";
  return {
    aps: {
      alert: {
        title: isCompleted ? "Task Completed" : "Task Failed",
        subtitle: title.slice(0, 60),
        body: summary
          ? summary.slice(0, 160)
          : isCompleted
          ? "Your task has finished successfully."
          : "The task encountered an error.",
      },
      sound: "default",
      category: "TASK_COMPLETION",
      "thread-id": `task-${taskId}`,
      "interruption-level": "active",
    },
    taskId,
    status,
  };
}

/**
 * Push notification helper for Juno Code tool approval requests. Blocking, so
 * it follows each device's "needs you" switch like every other ask.
 */
export async function sendCodeApprovalPushNotification(params: {
  userId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  prompt: string;
  workspace?: string;
}): Promise<SendApnsResult[]> {
  const payload = buildCodeApprovalPayload(params);
  return await sendPushToUser(params.userId, payload, undefined, { channel: "needs_you" });
}

/**
 * Push notification helper for background research or work task completions,
 * on each device's "updates" switch.
 */
export async function sendTaskCompletionPushNotification(params: {
  userId: string;
  taskId: string;
  title: string;
  status: "completed" | "failed";
  summary?: string;
}): Promise<SendApnsResult[]> {
  const payload = buildTaskCompletionPayload(params);
  return await sendPushToUser(params.userId, payload, undefined, { channel: "updates" });
}
