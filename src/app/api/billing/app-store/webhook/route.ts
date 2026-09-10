import { NextResponse } from "next/server";
import { z } from "zod";
import { handleAppStoreServerNotification } from "@/lib/billing/app-store";

export const runtime = "nodejs";

const notificationSchema = z.object({
  signedPayload: z.string().min(1, "signedPayload is required"),
});

/**
 * POST /api/billing/app-store/webhook
 * Webhook handler for App Store Server Notifications v2.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { signedPayload } = notificationSchema.parse(body);

    const result = await handleAppStoreServerNotification(signedPayload);

    return NextResponse.json({
      received: true,
      processed: result.processed,
      notificationType: result.notificationType,
    });
  } catch (error) {
    console.error("[app-store-webhook] failed to process notification:", error);
    // Logged above in full; the body is a fixed sentence. A verification
    // failure's message describes Juno's own key configuration, which is not
    // something to hand to whoever is posting to this URL.
    return NextResponse.json({ error: "Failed to process App Store notification" }, { status: 400 });
  }
}
