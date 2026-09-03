import { z } from "zod";
import { apiV1Error, apiV1Json, ApiV1Error } from "@/lib/api-v1";
import { authenticateNativeBearer } from "@/lib/native-auth";
import { getCurrentUser } from "@/lib/session";
import {
  registerDevicePushToken,
  deactivateDevicePushToken,
} from "@/lib/apns";

export const runtime = "nodejs";

const registerTokenSchema = z.object({
  token: z.string().min(10, "A valid device push token is required"),
  platform: z.enum(["ios", "macos"]).default("ios"),
  bundleId: z.string().optional(),
  environment: z.enum(["production", "sandbox"]).default("production"),
});

const unregisterTokenSchema = z.object({
  token: z.string().min(10, "A valid device push token is required"),
});

async function resolveAuthUser(request: Request): Promise<{ id: string }> {
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    try {
      const native = await authenticateNativeBearer(authHeader);
      return { id: native.user.id };
    } catch {
      // Fall through to session check
    }
  }

  const sessionUser = await getCurrentUser();
  if (sessionUser?.id) {
    return { id: sessionUser.id };
  }

  throw new ApiV1Error("unauthenticated", 401, "Sign in to register APNs push tokens.");
}

/**
 * POST /api/v1/devices/apns
 * Registers an Apple Push Notification service (APNs) device token for the user.
 */
export async function POST(request: Request) {
  try {
    const user = await resolveAuthUser(request);
    const body = await request.json();
    const data = registerTokenSchema.parse(body);

    const record = await registerDevicePushToken({
      userId: user.id,
      token: data.token,
      platform: data.platform,
      bundleId: data.bundleId,
      environment: data.environment,
    });

    return apiV1Json({
      registered: true,
      devicePushToken: {
        id: record.id,
        platform: record.platform,
        environment: record.environment,
        active: record.active,
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
