import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { clientIdempotencyKeySchema } from "@/lib/chat-origin";
import {
  firstSubmissionReceiptStatusPayload,
} from "@/lib/chat-first-submission";
import { findFirstSubmissionReceipt } from "@/lib/chat-first-submission-receipt";

export const runtime = "nodejs";

const querySchema = z
  .object({
    clientRequestId: clientIdempotencyKeySchema.optional(),
    generationId: clientIdempotencyKeySchema.optional(),
  })
  .refine((query) => Number(!!query.clientRequestId) + Number(!!query.generationId) === 1);

/** Least-privilege, account-scoped status refresh for native recovery. */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    clientRequestId: url.searchParams.get("clientRequestId") ?? undefined,
    generationId: url.searchParams.get("generationId") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "Invalid receipt lookup." }, { status: 400 });

  const receipt = parsed.data.clientRequestId
    ? await findFirstSubmissionReceipt(user.id, { clientRequestId: parsed.data.clientRequestId })
    : await findFirstSubmissionReceipt(user.id, { generationId: parsed.data.generationId! });
  if (!receipt) {
    return NextResponse.json(
      { error: "receipt_not_found", code: "RECEIPT_NOT_FOUND", retryable: false },
      { status: 404 }
    );
  }
  return NextResponse.json(firstSubmissionReceiptStatusPayload(receipt));
}
