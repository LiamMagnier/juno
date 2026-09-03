import { ApiV1Error, apiV1Error, apiV1Json } from "@/lib/api-v1";
import { authenticateNativeBearer, NativeAuthError } from "@/lib/native-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Revokes one Juno Code host pairing for the calling account.
 *
 * The row was created by heartbeat upserts to `POST /api/code/devices`, so
 * deleting it is what "revoke this computer" means: the phone stops listing
 * the Mac, and every device-scoped relay row (remote sessions, commands,
 * events, device-addressed tasks) cascades away with it. Queued device tasks
 * addressed to the Mac go with the row rather than sitting `queued` forever
 * for a host that will never claim them.
 *
 * Ownership is the whole authorization story: the delete is scoped to
 * `(id, userId)` in a single statement, so a device id from another account
 * reads back as not-found rather than as someone else's computer.
 */
export async function DELETE(request: Request, context: { params: Promise<{ deviceId: string }> }) {
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization) throw new NativeAuthError("unauthenticated", 401, "A bearer token is required.");
    const current = await authenticateNativeBearer(authorization);
    const { deviceId } = await context.params;
    if (!deviceId) throw new ApiV1Error("invalid_request", 400, "A device id is required.");
    const removed = await prisma.codeDevice.deleteMany({
      where: { id: deviceId, userId: current.user.id },
    });
    if (removed.count === 0) throw new ApiV1Error("not_found", 404, "The paired computer was not found.");
    return apiV1Json({ revoked: true, deviceId });
  } catch (error) {
    return apiV1Error(error);
  }
}
