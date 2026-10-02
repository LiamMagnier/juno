import { z } from "zod";
import { apiV1Error, apiV1Json, ApiV1Error } from "@/lib/api-v1";
import { authenticateNativeBearer } from "@/lib/native-auth";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session";
import {
  cleanDeviceToken,
  registerDevicePushToken,
  deactivateDevicePushToken,
} from "@/lib/apns";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const runtime = "nodejs";

/**
 * Only Juno's own apps. The bundle id is the APNs topic the server signs
 * pushes for, so a registration naming any other app is either a mistake or
 * an attempt to borrow this deployment's push key for it.
 */
const BUNDLE_ID = /^com\.liammagnier\.[A-Za-z0-9][A-Za-z0-9.-]{0,120}$/;

/** An APNs device token: hex, 32 bytes today, and Apple says not to rely on the length. */
const DEVICE_TOKEN = /^[0-9a-f]{32,400}$/;

/** Registrations per account per hour: a launch, a sign-in and a few switch changes, with room. */
const REGISTRATIONS_PER_HOUR = 30;

const registerTokenSchema = z.object({
  token: z.string().min(10, "A valid device push token is required").max(512),
  platform: z.enum(["ios", "macos"]).default("ios"),
  bundleId: z.string().trim().regex(BUNDLE_ID, `This is not a ${PRODUCT_NAME} app.`).optional(),
  environment: z.enum(["production", "sandbox"]).default("production"),
  // Omitted keeps the device's current choice, so re-registering on launch
  // never turns a switch back on.
  notifyNeedsYou: z.boolean().optional(),
  notifyUpdates: z.boolean().optional(),
});

const unregisterTokenSchema = z.object({
  token: z.string().min(10, "A valid device push token is required"),
});

/**
 * Who is asking, and from which native sign-in.
 *
 * A presented bearer is authoritative, the same rule `getCurrentUser` keeps:
 * an invalid one fails rather than falling back to a browser cookie that
 * happens to ride on the same request. The device session is what lets a sign
 * out or a revocation stop this token's pushes later (src/lib/native-auth.ts).
 */
async function resolveAuthUser(request: Request): Promise<{ id: string; deviceSessionId: string | null }> {
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const native = await authenticateNativeBearer(authHeader);
    return { id: native.user.id, deviceSessionId: native.deviceSession.id };
  }

  const sessionUser = await getCurrentUser();
  if (sessionUser?.id) {
    return { id: sessionUser.id, deviceSessionId: null };
  }

  throw new ApiV1Error("unauthenticated", 401, "Sign in to register APNs push tokens.");
}

/**
 * POST /api/v1/devices/apns
 * Registers an Apple Push Notification service (APNs) device token for the
 * user, or updates its switches: re-POST with `notifyNeedsYou` / `notifyUpdates`.
 */
export async function POST(request: Request) {
  try {
    const user = await resolveAuthUser(request);
    const limit = await rateLimit({ key: `apns-register:${user.id}`, limit: REGISTRATIONS_PER_HOUR, windowSec: 3600 });
    if (!limit.success) {
      throw new ApiV1Error("rate_limited", 429, "Too many device registrations. Try again later.", true);
    }

    const body = await request.json().catch(() => null);
    const data = registerTokenSchema.parse(body);
    const token = cleanDeviceToken(data.token);
    if (!DEVICE_TOKEN.test(token)) {
      throw new ApiV1Error("invalid_request", 400, "That is not an APNs device token.");
    }

    const record = await registerDevicePushToken({
      userId: user.id,
      token,
      platform: data.platform,
      bundleId: data.bundleId ?? null,
      environment: data.environment,
      deviceSessionId: user.deviceSessionId,
      notifyNeedsYou: data.notifyNeedsYou,
      notifyUpdates: data.notifyUpdates,
    });

    return apiV1Json({
      registered: true,
      devicePushToken: {
        id: record.id,
        platform: record.platform,
        environment: record.environment,
        active: record.active,
        notifyNeedsYou: record.notifyNeedsYou,
        notifyUpdates: record.notifyUpdates,
        updatedAt: record.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    return apiV1Error(error);
  }
}

/**
 * DELETE /api/v1/devices/apns
 * Unregisters / deactivates an APNs device token.
 */
export async function DELETE(request: Request) {
  try {
    const user = await resolveAuthUser(request);
    const url = new URL(request.url);
    const tokenFromQuery = url.searchParams.get("token");

    let token = tokenFromQuery;
    if (!token) {
      const body = await request.json().catch(() => ({}));
      const parsed = unregisterTokenSchema.safeParse(body);
      if (parsed.success) {
        token = parsed.data.token;
      }
    }

    if (!token) {
      throw new ApiV1Error("invalid_request", 400, "Device push token is required.");
    }

    await deactivateDevicePushToken(token, user.id);

    return apiV1Json({
      unregistered: true,
    });
  } catch (error) {
    return apiV1Error(error);
  }
}
