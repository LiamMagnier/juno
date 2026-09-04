import { Plan, SubStatus } from "@prisma/client";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import { env } from "@/lib/env";
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

export interface AppStoreVerificationConfiguration {
  bundleId: string;
  appAppleId: number;
  environment: Environment;
  rootCertificates: Buffer[];
  enableOnlineChecks: boolean;
}

/** Narrow test seam; production callers always use Apple's certificate-chain verifier. */
export interface AppStoreSignedDataVerifier {
  verifyTransaction(signedTransactionInfo: string): Promise<AppStoreTransactionPayload>;
  verifyNotification(signedPayload: string): Promise<AppStoreServerNotificationPayload>;
}

interface AppStoreVerificationOptions {
  verifier?: AppStoreSignedDataVerifier;
  configuration?: AppStoreVerificationConfiguration;
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
  return APP_STORE_PRODUCT_IDS[productId]?.plan ?? null;
}

function appStoreConfiguration(): AppStoreVerificationConfiguration {
  const { bundleId, appAppleId, environment, rootCertificates, enableOnlineChecks } = env.appStore;
  if (!bundleId || !appAppleId || !rootCertificates) {
    throw new Error("App Store billing is unavailable: signed verification is not configured.");
  }
  const numericAppAppleId = Number(appAppleId);
  if (!Number.isSafeInteger(numericAppAppleId) || numericAppAppleId <= 0) {
    throw new Error("App Store billing is unavailable: APP_STORE_APPLE_ID must be a positive integer.");
  }
  if (environment !== Environment.PRODUCTION) {
    throw new Error("App Store billing is unavailable: only the Production verifier is enabled.");
  }
  const certificates = rootCertificates.split(",").map((value) => value.trim()).filter(Boolean);
  if (certificates.length === 0) {
    throw new Error("App Store billing is unavailable: no Apple root certificates are configured.");
  }
  const decodedCertificates = certificates.map((certificate) => Buffer.from(certificate, "base64"));
  if (decodedCertificates.some((certificate) => certificate.length === 0)) {
    throw new Error("App Store billing is unavailable: an Apple root certificate is invalid.");
  }
  return { bundleId, appAppleId: numericAppAppleId, environment: Environment.PRODUCTION, rootCertificates: decodedCertificates, enableOnlineChecks };
}

function appleVerifier(configuration: AppStoreVerificationConfiguration): AppStoreSignedDataVerifier {
  const verifier = new SignedDataVerifier(
    configuration.rootCertificates,
    configuration.enableOnlineChecks,
    configuration.environment,
    configuration.bundleId,
    configuration.appAppleId
  );
  return {
    async verifyTransaction(signedTransactionInfo) {
      return await verifier.verifyAndDecodeTransaction(signedTransactionInfo) as AppStoreTransactionPayload;
    },
    async verifyNotification(signedPayload) {
      return await verifier.verifyAndDecodeNotification(signedPayload) as AppStoreServerNotificationPayload;
    },
  };
}

function validTimestamp(timestamp: unknown): timestamp is number {
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0;
}

function validateTransactionPayload(
  payload: AppStoreTransactionPayload,
  configuration: AppStoreVerificationConfiguration
): AppStoreTransactionPayload {
  if (!payload.transactionId || !payload.originalTransactionId || !payload.productId) {
    throw new Error("Invalid transaction payload: missing required fields.");
  }
  if (payload.bundleId !== configuration.bundleId) {
    throw new Error("Invalid transaction payload: unexpected bundle identifier.");
  }
  if (payload.environment !== configuration.environment) {
    throw new Error("Invalid transaction payload: unexpected App Store environment.");
  }
  if (!APP_STORE_PRODUCT_IDS[payload.productId]) {
    throw new Error("Invalid transaction payload: unknown App Store product.");
  }
  if (!validTimestamp(payload.purchaseDate) || !validTimestamp(payload.expiresDate)) {
    throw new Error("Invalid transaction payload: active subscription timestamps are required.");
  }
  if (payload.expiresDate < payload.purchaseDate) {
    throw new Error("Invalid transaction payload: expiry precedes purchase.");
  }
  if (payload.revocationDate != null && !validTimestamp(payload.revocationDate)) {
    throw new Error("Invalid transaction payload: invalid revocation timestamp.");
  }
  return payload;
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
  signedTransactionInfo: string,
  options: AppStoreVerificationOptions = {}
): Promise<AppStoreTransactionPayload> {
  const configuration = options.configuration ?? appStoreConfiguration();
  const verifier = options.verifier ?? appleVerifier(configuration);
  const payload = await verifier.verifyTransaction(signedTransactionInfo);
  return validateTransactionPayload(payload, configuration);
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

  // A verified App Store transaction can only ever belong to one Juno account.
  // Do this before the upsert so a copied, genuine receipt cannot reassign an
  // existing subscriber when submitted through another authenticated session.
  if (targetUserId) {
    const existingOwner = await prismaUnguarded.subscription.findFirst({
      where: { appStoreOriginalTransactionId: transaction.originalTransactionId },
      select: { userId: true },
    });
    if (existingOwner && existingOwner.userId !== targetUserId) {
      throw new Error("This App Store subscription is already linked to another Juno account.");
    }
  }

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
  signedPayload: string,
  options: AppStoreVerificationOptions = {}
): Promise<{ processed: boolean; notificationType: string; originalTransactionId?: string; warning?: string }> {
  const configuration = options.configuration ?? appStoreConfiguration();
  const verifier = options.verifier ?? appleVerifier(configuration);
  const payload = await verifier.verifyNotification(signedPayload);

  if (!payload.notificationType || !payload.notificationUUID || !validTimestamp(payload.signedDate)) {
    throw new Error("Invalid App Store notification payload.");
  }
  if (payload.data?.bundleId && payload.data.bundleId !== configuration.bundleId) {
    throw new Error("Invalid App Store notification payload: unexpected bundle identifier.");
  }
  if (payload.data?.environment && payload.data.environment !== configuration.environment) {
    throw new Error("Invalid App Store notification payload: unexpected App Store environment.");
  }

  if (payload.data?.signedTransactionInfo) {
    const tx = await verifyStoreKitTransaction(payload.data.signedTransactionInfo, { verifier, configuration });

    // Notification names describe billing events, not entitlement truth. A
    // verified transaction carries the authoritative expiry/revocation dates;
    // applying a bare, possibly delayed DID_FAIL_TO_RENEW/EXPIRED name would
    // incorrectly cancel an entitlement still covered by the signed record.
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
