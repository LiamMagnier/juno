import { apiV1Error, apiV1Json, CONTRACT_VERSION } from "@/lib/api-v1";
import { authenticateNativeBearer, NativeAuthError } from "@/lib/native-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization) throw new NativeAuthError("unauthenticated", 401, "A bearer token is required.");
    const session = await authenticateNativeBearer(authorization);
    return apiV1Json({
      profile: { id: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image },
      deviceSession: {
        id: session.deviceSession.id,
        name: session.deviceSession.name,
        platform: session.deviceSession.platform,
        appVersion: session.deviceSession.appVersion,
        createdAt: session.deviceSession.createdAt.toISOString(),
        lastSeenAt: session.deviceSession.lastSeenAt.toISOString(),
      },
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      contractVersion: CONTRACT_VERSION,
      minimumSupportedAppVersion: "3.0.0",
    });
  } catch (error) {
    return apiV1Error(error);
  }
}
