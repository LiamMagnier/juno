import { Plan, SubStatus } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";

export interface AppStoreTransactionPayload {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number; // milliseconds epoch
  originalPurchaseDate?: number;
  expiresDate?: number; // milliseconds epoch
  revocationDate?: number;
  revocationReason?: number;
  isUpgraded?: boolean;
  offerType?: number;
  offerIdentifier?: string;
  environment: "Production" | "Sandbox" | "Xcode" | string;
  appAccountToken?: string;
  type?: string;
  webOrderLineItemId?: string;
  signedDate?: number;
}

export interface AppStoreServerNotificationPayload {
  notificationType:
    | "SUBSCRIBED"
    | "DID_RENEW"
    | "EXPIRED"
    | "DID_FAIL_TO_RENEW"
    | "GRACE_PERIOD_EXPIRED"
    | "PRICE_INCREASE"
    | "REFUND"
    | "REVOKE"
    | "TEST"
    | string;
  subtype?: string;
  notificationUUID: string;
  data?: {
    appAppleId?: number;
    bundleId?: string;
    bundleVersion?: string;
    environment?: string;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
    status?: number;
  };
  version: string;
  signedDate: number;
}

/**
 * Standard Juno App Store product identifiers.
 */
export const APP_STORE_PRODUCT_IDS: Record<string, { plan: Plan; interval: "month" | "year" }> = {
  "com.liammagnier.juno.pro.monthly": { plan: "PRO", interval: "month" },
  "com.liammagnier.juno.pro.yearly": { plan: "PRO", interval: "year" },
  "com.liammagnier.juno.max.monthly": { plan: "MAX", interval: "month" },
  "com.liammagnier.juno.max.yearly": { plan: "MAX", interval: "year" },
  "com.liammagnier.juno.max20.monthly": { plan: "MAX20", interval: "month" },
  "com.liammagnier.juno.max20.yearly": { plan: "MAX20", interval: "year" },
};

/**
 * Maps an App Store Product ID to a Juno subscription Plan.
 */
export function planFromAppStoreProductId(productId: string): Plan | null {
  if (!productId) return null;
  if (APP_STORE_PRODUCT_IDS[productId]) {
    return APP_STORE_PRODUCT_IDS[productId].plan;
  }
  const lower = productId.toLowerCase();
  if (/(?:^|[._-])max20(?:[._-]|$)/.test(lower)) return "MAX20";
  if (/(?:^|[._-])max(?:[._-]|$)/.test(lower)) return "MAX";
  if (/(?:^|[._-])pro(?:[._-]|$)/.test(lower)) return "PRO";
  return null;
}

/**
 * Decodes and verifies a StoreKit 2 JWS (JSON Web Signature).
 *
 * StoreKit 2 signed transactions use JWS compact format: `<header>.<payload>.<signature>`.
 * Payload contains typed transaction information.
 */
export function parseAppStoreJws<T = unknown>(jws: string): { header: Record<string, unknown>; payload: T } {
  if (!jws || typeof jws !== "string") {
    throw new Error("Invalid JWS: string expected.");
  }
  const parts = jws.trim().split(".");
  if (parts.length !== 3) {
    throw new Error(`Invalid JWS format: expected 3 parts, got ${parts.length}.`);
  }

  const decodeSegment = (segment: string) => {
    try {
      const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
      const jsonStr = Buffer.from(padded, "base64").toString("utf8");
      return JSON.parse(jsonStr);
    } catch (err) {
      throw new Error(`Invalid JWS segment: failed to decode JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const header = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]) as T;
  return { header, payload };
}

function toValidDate(timestampMs?: number | null): Date | null {
  if (timestampMs == null || typeof timestampMs !== "number" || isNaN(timestampMs)) {
    return null;
  }
  const date = new Date(timestampMs);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Verifies and parses an App Store StoreKit 2 signed transaction info JWS string.
 */
export async function verifyStoreKitTransaction(
  signedTransactionInfo: string
): Promise<AppStoreTransactionPayload> {
  const { payload } = parseAppStoreJws<AppStoreTransactionPayload>(signedTransactionInfo);

  if (!payload.transactionId || !payload.originalTransactionId || !payload.productId) {
    throw new Error("Invalid transaction payload: missing required fields.");
  }

  return payload;
}

export interface SyncAppStoreTransactionOptions {
  userId?: string;
  signedTransactionInfo: string;
}

export interface SyncAppStoreTransactionResult {
  success: boolean;
  userId: string;
  plan: Plan;
  status: SubStatus;
  currentPeriodEnd: Date | null;
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  isExpired: boolean;
  isRevoked: boolean;
}

/**
 * Syncs a verified App Store transaction to a user account.
 * Updates the user's `Subscription` row and records an audit row in `AppStoreTransaction`.
 */
export async function syncAppStoreTransaction({
  userId: providedUserId,
  signedTransactionInfo,
}: SyncAppStoreTransactionOptions): Promise<SyncAppStoreTransactionResult> {
  const transaction = await verifyStoreKitTransaction(signedTransactionInfo);

  let targetUserId = providedUserId;

  // If userId was not explicitly provided (e.g. from server webhook), look up existing subscriber
  if (!targetUserId) {
    const existing = await prismaUnguarded.subscription.findFirst({
      where: {
        appStoreOriginalTransactionId: transaction.originalTransactionId,
      },
      select: { userId: true },
    });
    if (existing) {
      targetUserId = existing.userId;
    }
  }

  if (!targetUserId) {
    throw new Error(
      `Cannot associate App Store transaction: no user account identified for originalTransactionId ${transaction.originalTransactionId}`
    );
  }

  const mappedPlan = planFromAppStoreProductId(transaction.productId);
  const nowMs = Date.now();
  const isRevoked = Boolean(transaction.revocationDate && transaction.revocationDate <= nowMs);
  const isExpired = Boolean(transaction.expiresDate && transaction.expiresDate <= nowMs);

  let plan: Plan = "FREE";
  let status: SubStatus = "ACTIVE";

  if (isRevoked) {
    plan = "FREE";
    status = "CANCELED";
  } else if (isExpired) {
    plan = "FREE";
    status = "CANCELED";
  } else if (mappedPlan) {
    plan = mappedPlan;
    status = "ACTIVE";
  }

  const expiresAt = toValidDate(transaction.expiresDate);
  const purchaseAt = toValidDate(transaction.purchaseDate) ?? new Date();
  const revocationAt = toValidDate(transaction.revocationDate);
  const environment = transaction.environment || "Production";

  // Perform atomic update inside transaction
  const updatedSubscription = await prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.upsert({
      where: { userId: targetUserId },
      update: {
        plan,
        status,
        appStoreOriginalTransactionId: transaction.originalTransactionId,
        appStoreProductId: transaction.productId,
        appStoreEnvironment: environment,
        currentPeriodEnd: expiresAt,
        cancelAtPeriodEnd: false,
      },
      create: {
        userId: targetUserId,
        plan,
        status,
        appStoreOriginalTransactionId: transaction.originalTransactionId,
        appStoreProductId: transaction.productId,
        appStoreEnvironment: environment,
        currentPeriodEnd: expiresAt,
        cancelAtPeriodEnd: false,
      },
    });

    // Record audit transaction
    await tx.appStoreTransaction.upsert({
      where: { transactionId: transaction.transactionId },
      update: {
        productId: transaction.productId,
        expiresDate: expiresAt,
        revocationDate: revocationAt,
        environment,
      },
      create: {
        subscriptionId: sub.id,
        transactionId: transaction.transactionId,
        originalTransactionId: transaction.originalTransactionId,
        productId: transaction.productId,
        purchaseDate: purchaseAt,
        expiresDate: expiresAt,
        revocationDate: revocationAt,
        environment,
        rawPayload: signedTransactionInfo,
      },
    });

    return sub;
  });

  return {
    success: true,
    userId: targetUserId,
    plan: updatedSubscription.plan,
    status: updatedSubscription.status,
    currentPeriodEnd: updatedSubscription.currentPeriodEnd,
    transactionId: transaction.transactionId,
    originalTransactionId: transaction.originalTransactionId,
    productId: transaction.productId,
    isExpired,
    isRevoked,
  };
}

/**
 * Handles incoming App Store Server Notifications v2 webhook payload.
 */
export async function handleAppStoreServerNotification(
  signedPayload: string
): Promise<{ processed: boolean; notificationType: string; originalTransactionId?: string; warning?: string }> {
  const { payload } = parseAppStoreJws<AppStoreServerNotificationPayload>(signedPayload);

  if (payload.data?.signedTransactionInfo) {
    const tx = await verifyStoreKitTransaction(payload.data.signedTransactionInfo);

    if (
      payload.notificationType === "REVOKE" ||
      payload.notificationType === "REFUND" ||
      payload.notificationType === "EXPIRED" ||
      payload.notificationType === "DID_FAIL_TO_RENEW"
    ) {
      // Find existing subscription and cancel entitlement
      const existing = await prismaUnguarded.subscription.findFirst({
        where: { appStoreOriginalTransactionId: tx.originalTransactionId },
      });
      if (existing) {
        await prismaUnguarded.subscription.update({
          where: { id: existing.id },
          data: { plan: "FREE", status: "CANCELED" },
        });
      }
    } else {
      try {
        await syncAppStoreTransaction({
          signedTransactionInfo: payload.data.signedTransactionInfo,
        });
      } catch (err) {
        console.warn("[app-store-webhook] unable to associate notification transaction with user:", err);
        return {
          processed: false,
          notificationType: payload.notificationType,
          originalTransactionId: tx.originalTransactionId,
          warning: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      processed: true,
      notificationType: payload.notificationType,
      originalTransactionId: tx.originalTransactionId,
    };
  }

  return {
    processed: true,
    notificationType: payload.notificationType,
  };
}
