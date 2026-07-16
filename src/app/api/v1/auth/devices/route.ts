import { apiV1Error, apiV1Json } from "@/lib/api-v1";
import { authenticateNativeBearer, NativeAuthError } from "@/lib/native-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization) throw new NativeAuthError("unauthenticated", 401, "A bearer token is required.");
    const current = await authenticateNativeBearer(authorization);
    const devices = await prisma.nativeDeviceSession.findMany({
      where: { userId: current.user.id },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, name: true, platform: true, appVersion: true, createdAt: true, lastSeenAt: true, revokedAt: true },
    });
    return apiV1Json({ devices: devices.map((device) => ({
      ...device,
      createdAt: device.createdAt.toISOString(),
      lastSeenAt: device.lastSeenAt.toISOString(),
      revokedAt: device.revokedAt?.toISOString() ?? null,
      current: device.id === current.deviceSession.id,
    })) });
  } catch (error) {
    return apiV1Error(error);
  }
}
