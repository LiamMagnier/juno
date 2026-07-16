import { apiV1Error, apiV1Json } from "@/lib/api-v1";
import { authenticateNativeBearer, NativeAuthError, revokeNativeDevice } from "@/lib/native-auth";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization) throw new NativeAuthError("unauthenticated", 401, "A bearer token is required.");
    const current = await authenticateNativeBearer(authorization);
    const { id } = await context.params;
    const revoked = await revokeNativeDevice(current.user.id, id);
    if (!revoked) throw new NativeAuthError("not_found", 404, "The device session was not found.");
    return apiV1Json({ revoked: true, deviceSessionId: id });
  } catch (error) {
    return apiV1Error(error);
  }
}
