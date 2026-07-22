import { ApiV1Error, apiV1Error, apiV1Json } from "@/lib/api-v1";
import { requireNativeRequest } from "@/lib/native-request";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { isStorageAvailable } from "@/lib/env";
import { buildObjectKey, putObject } from "@/lib/storage";
import { planAttachmentUpload } from "@/lib/attachment-upload";
import { serializeAttachment } from "@/lib/serializers";
import { isOwnerEmail } from "@/lib/owner";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Native attachment upload.
 *
 * The web already had `/api/upload`, but it authenticates from a session
 * cookie, which a native client does not have. Rather than loosen that route to
 * accept both, this is a separate bearer-authenticated entry point that reuses
 * the same validation helpers — `isAcceptedMime`, `sniffImageMime`,
 * `sanitizeFileName`, the plan size ceiling — so the two paths cannot drift
 * into having different ideas about what is safe to store.
 *
 * Three properties are deliberate and load-bearing:
 *
 * - The declared MIME is never trusted. Images are identified by their magic
 *   bytes and stored under the *sniffed* type; anything else is stored as
 *   `application/octet-stream` with an attachment disposition, so an uploaded
 *   HTML or SVG payload can never be served back inline. That is what stops a
 *   stored-XSS through the attachment host.
 * - HEIC/HEIF is not in the accepted set and is not added here. Apple clients
 *   transcode to JPEG before uploading. Accepting HEIC server-side would mean
 *   either shipping a decoder or storing something the web cannot render.
 * - `Idempotency-Key` makes a retried upload return the first attachment
 *   instead of creating a second one. A native client retries on a flaky
 *   network by design, and without this every retry would leave a duplicate.
 */
export async function POST(request: Request) {
  try {
    const current = await requireNativeRequest(request);
    const user = current.user;

    if (!isStorageAvailable()) {
      throw new ApiV1Error(
        "storage_unavailable",
        503,
        "File uploads are not available — configure a storage bucket.",
        true,
      );
    }

    if (!isOwnerEmail(user.email)) {
      const limit = await rateLimit({ key: `upload:${user.id}`, limit: 60, windowSec: 3600 });
      if (!limit.success) {
        throw new ApiV1Error("rate_limited", 429, "Upload limit reached. Try again later.", true);
      }
    }

    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;
    if (idempotencyKey) {
      if (idempotencyKey.length > 200) {
        throw new ApiV1Error("invalid_request", 400, "The idempotency key is too long.");
      }
      // Scoped to the user, so one account's key can never surface another's
      // attachment.
      const prior = await prisma.attachment.findFirst({
        where: { userId: user.id, idempotencyKey },
      });
      if (prior) {
        return apiV1Json({ attachment: await serializeAttachment(prior) }, { status: 200 });
      }
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    const conversationId = (form?.get("conversationId") as string) || undefined;
    const projectId = (form?.get("projectId") as string) || undefined;

    if (!(file instanceof File)) {
      throw new ApiV1Error("invalid_request", 400, "No file provided.");
    }

    const plan = await getUserPlan(user.id);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const planned = planAttachmentUpload({
      declaredMime: file.type || "application/octet-stream",
      fileName: file.name || "file",
      size: file.size,
      bytes,
      maxUploadMb: PLANS[plan].maxUploadMb,
    });
    if (!planned.ok) {
      throw new ApiV1Error(planned.error.code, planned.error.status, planned.error.message);
    }
    const { fileName, kind, storedMime, storedContentType, contentDisposition, extractedText } =
      planned.plan;

    // Owner scoping. A missing row and a row belonging to someone else are the
    // same 404 on purpose: distinguishing them would confirm that an id exists
    // in another account.
    if (conversationId) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: user.id },
        select: { id: true },
      });
      if (!conversation) throw new ApiV1Error("not_found", 404, "Conversation not found.");
    }
    if (projectId) {
      const project = await prisma.project.findFirst({
        where: { id: projectId, userId: user.id },
        select: { id: true },
      });
      if (!project) throw new ApiV1Error("not_found", 404, "Project not found.");
    }

    const key = buildObjectKey(user.id, fileName);
    await putObject(key, bytes, storedContentType, contentDisposition);

    const attachment = await prisma.attachment.create({
      data: {
        userId: user.id,
        conversationId: conversationId ?? null,
        projectId: projectId ?? null,
        kind,
        fileName,
        mimeType: storedMime,
        size: file.size,
        storageKey: key,
        extractedText,
        idempotencyKey,
      },
    });

    return apiV1Json({ attachment: await serializeAttachment(attachment) }, { status: 201 });
  } catch (error) {
    return apiV1Error(error);
  }
}
