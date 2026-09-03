import http2 from "node:http2";
import { SignJWT, importPKCS8 } from "jose";
import { prisma, prismaUnguarded } from "@/lib/prisma";

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
  bundleId?: string;
  environment?: "production" | "sandbox";
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
 */
export async function registerDevicePushToken({
  userId,
  token,
  platform = "ios",
  bundleId = "com.liammagnier.juno",
  environment = "production",
}: RegisterDevicePushTokenParams) {
  const cleanToken = token.trim().replace(/[<\s>]/g, "");

  return await prisma.devicePushToken.upsert({
    where: { token: cleanToken },
    update: {
      userId,
      platform,
      bundleId,
      environment,
      active: true,
      lastUsedAt: new Date(),
    },
    create: {
      userId,
      token: cleanToken,
      platform,
      bundleId,
      environment,
      active: true,
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
  const cleanToken = token.trim().replace(/[<\s>]/g, "");
  return await prismaUnguarded.devicePushToken.updateMany({
    where: {
      token: cleanToken,
      ...(userId ? { userId } : {}),
    },
    data: { active: false },
  });
}

/**
 * Dispatches an APNs push notification over HTTP/2.
 * Falls back to simulation mode if APNs credentials are not configured.
 */
export async function sendApnsNotification(options: SendApnsOptions): Promise<SendApnsResult> {
  const cleanToken = options.token.trim().replace(/[<\s>]/g, "");
  const defaultBundleId = process.env.APNS_BUNDLE_ID || "com.liammagnier.juno";
  const topic = options.topic || defaultBundleId;
  const environment = options.environment || (process.env.NODE_ENV === "production" ? "production" : "sandbox");

  const jwt = await getApnsJwt();

  // If APNs is not configured in local development/CI, return clean simulated success
  if (!jwt) {
    return {
      success: true,
      simulated: true,
      apnsId: `sim_${Date.now()}_${cleanToken.slice(0, 8)}`,
    };
  }

  const host = environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const path = `/3/device/${cleanToken}`;

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

  try {
    const res = await sendApnsHttp2Request(host, path, headers, JSON.stringify(options.payload));
    const apnsId = typeof res.headers["apns-id"] === "string" ? res.headers["apns-id"] : undefined;

    if (res.statusCode >= 200 && res.statusCode < 300) {
      return {
        success: true,
        apnsId,
        statusCode: res.statusCode,
      };
    }

    let reason: string | undefined;
    try {
      const errJson = JSON.parse(res.body) as { reason?: string };
      reason = errJson.reason;
    } catch {
      reason = res.body;
    }

    // Token is unregistered or invalid: deactivate it
    if (res.statusCode === 410 || reason === "BadDeviceToken" || reason === "Unregistered") {
      await deactivateDevicePushToken(cleanToken);
    }

    return {
      success: false,
      statusCode: res.statusCode,
      apnsId,
      reason,
      error: `APNs returned HTTP ${res.statusCode}: ${reason || "Unknown error"}`,
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
 */
export async function sendPushToUser(
  userId: string,
  payload: ApnsPayload,
  options?: Partial<Omit<SendApnsOptions, "token" | "payload">>
): Promise<SendApnsResult[]> {
  try {
    const devices = await prismaUnguarded.devicePushToken.findMany({
      where: { userId, active: true },
    });

    if (!devices || devices.length === 0) return [];

    const results: SendApnsResult[] = [];
    for (const device of devices) {
      const res = await sendApnsNotification({
        token: device.token,
        payload,
        topic: device.bundleId || options?.topic,
        environment: (device.environment as "production" | "sandbox") || options?.environment,
        ...options,
      });
      results.push(res);
    }

    return results;
  } catch (err) {
    console.warn("[apns] unable to query registered devices for user:", userId, err instanceof Error ? err.message : String(err));
    return [];
  }
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
        title: "Juno Code: Approval Required",
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
 * Push notification helper for Juno Code tool approval requests.
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
  return await sendPushToUser(params.userId, payload);
}

/**
 * Push notification helper for background research or work task completions.
 */
export async function sendTaskCompletionPushNotification(params: {
  userId: string;
  taskId: string;
  title: string;
  status: "completed" | "failed";
  summary?: string;
}): Promise<SendApnsResult[]> {
  const payload = buildTaskCompletionPayload(params);
  return await sendPushToUser(params.userId, payload);
}
