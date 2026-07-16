import { apiV1Error, apiV1Json } from "@/lib/api-v1";
import { authenticateNativeBearer, NativeAuthError, revokeNativeDevice } from "@/lib/native-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization) throw new NativeAuthError("unauthenticated", 401, "A bearer token is required.");
    const current = await authenticateNativeBearer(authorization);
    await revokeNativeDevice(current.user.id, current.deviceSession.id, "logout");
    return apiV1Json({ revoked: true });
  } catch (error) {
    return apiV1Error(error);
  }
}
