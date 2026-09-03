import { z } from "zod";
import { apiV1Error, apiV1Json, ApiV1Error } from "@/lib/api-v1";
import { authenticateNativeBearer } from "@/lib/native-auth";
import { getCurrentUser } from "@/lib/session";
import {
  APP_STORE_PRODUCT_IDS,
  syncAppStoreTransaction,
} from "@/lib/billing/app-store";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const syncTransactionSchema = z.object({
  signedTransactionInfo: z.string().min(1, "signedTransactionInfo is required"),
});

/**
 * Authenticates user from either Authorization header (Bearer native token)
 * or active NextAuth session.
 */
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

  throw new ApiV1Error("unauthenticated", 401, "Sign in to verify and sync App Store purchases.");
}

/**
 * POST /api/v1/billing/app-store
 * Receives signed StoreKit 2 transaction info, verifies it, and activates the user's subscription.
 */
export async function POST(request: Request) {
  try {
    const user = await resolveAuthUser(request);
    const body = await request.json();
    const { signedTransactionInfo } = syncTransactionSchema.parse(body);

    const result = await syncAppStoreTransaction({
      userId: user.id,
      signedTransactionInfo,
    });

    return apiV1Json({
      success: true,
      subscription: {
        plan: result.plan,
        status: result.status,
        currentPeriodEnd: result.currentPeriodEnd?.toISOString() ?? null,
        transactionId: result.transactionId,
        originalTransactionId: result.originalTransactionId,
        productId: result.productId,
        isExpired: result.isExpired,
        isRevoked: result.isRevoked,
      },
    });
  } catch (error) {
    return apiV1Error(error);
  }
}

/**
 * GET /api/v1/billing/app-store
 * Returns subscription status and products.
 */
export async function GET(request: Request) {
  try {
    const user = await resolveAuthUser(request);
    const subscription = await prisma.subscription.findUnique({
      where: { userId: user.id },
      select: {
        plan: true,
        status: true,
        appStoreProductId: true,
        currentPeriodEnd: true,
      },
    });

    return apiV1Json({
      subscription: subscription ?? {
        plan: "FREE",
        status: "ACTIVE",
        appStoreProductId: null,
        currentPeriodEnd: null,
      },
      products: APP_STORE_PRODUCT_IDS,
    });
  } catch (error) {
    return apiV1Error(error);
  }
}
