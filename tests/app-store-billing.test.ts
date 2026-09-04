import test from "node:test";
import assert from "node:assert/strict";
import { Environment } from "@apple/app-store-server-library";
import {
  planFromAppStoreProductId,
  verifyStoreKitTransaction,
  type AppStoreSignedDataVerifier,
  type AppStoreVerificationConfiguration,
} from "@/lib/billing/app-store";

const configuration: AppStoreVerificationConfiguration = {
  bundleId: "com.liammagnier.JunoMobile",
  appAppleId: 123456789,
  environment: Environment.PRODUCTION,
  rootCertificates: [Buffer.from("test")],
  enableOnlineChecks: true,
};

function verifier(
  transaction: Record<string, unknown>,
  notification: Record<string, unknown> = {}
): AppStoreSignedDataVerifier {
  return {
    async verifyTransaction() { return transaction as never; },
    async verifyNotification() { return notification as never; },
  };
}

test("planFromAppStoreProductId correctly maps standard product IDs", () => {
  assert.equal(planFromAppStoreProductId("com.liammagnier.juno.pro.monthly"), "PRO");
  assert.equal(planFromAppStoreProductId("com.liammagnier.juno.pro.yearly"), "PRO");
  assert.equal(planFromAppStoreProductId("com.liammagnier.juno.max.monthly"), "MAX");
  assert.equal(planFromAppStoreProductId("com.liammagnier.juno.max.yearly"), "MAX");
  assert.equal(planFromAppStoreProductId("com.liammagnier.juno.max20.monthly"), "MAX20");
  assert.equal(planFromAppStoreProductId("com.liammagnier.juno.max20.yearly"), "MAX20");
  assert.equal(planFromAppStoreProductId("unknown.product.id"), null);
});

test("verifyStoreKitTransaction accepts only a verifier-decoded, policy-valid transaction", async () => {
  const validPayload = {
    transactionId: "tx_123",
    originalTransactionId: "orig_123",
    bundleId: configuration.bundleId,
    productId: "com.liammagnier.juno.pro.monthly",
    purchaseDate: Date.now(),
    environment: "Production",
    expiresDate: Date.now() + 60_000,
  };
  const parsed = await verifyStoreKitTransaction("signed-by-apple", {
    configuration,
    verifier: verifier(validPayload),
  });
  assert.equal(parsed.transactionId, "tx_123");
  assert.equal(parsed.originalTransactionId, "orig_123");
  assert.equal(parsed.productId, "com.liammagnier.juno.pro.monthly");

  await assert.rejects(
    async () => verifyStoreKitTransaction("signed-by-apple", {
      configuration,
      verifier: verifier({ transactionId: "only_this" }),
    }),
    /missing required fields/
  );
});

test("a forged compact JWS cannot bypass the production verifier", async () => {
  await assert.rejects(
    () => verifyStoreKitTransaction("eyJhbGciOiJFUzI1NiJ9.eyJ0cmFuc2FjdGlvbklkIjoidHgifQ.forged"),
    /signed verification is not configured/
  );
});

test("handleAppStoreServerNotification handles a verified TEST notification gracefully", async () => {
  const { handleAppStoreServerNotification } = await import("@/lib/billing/app-store");
  const testPayload = {
    notificationType: "TEST",
    notificationUUID: "test-uuid-1234",
    version: "2.0",
    signedDate: Date.now(),
  };
  const result = await handleAppStoreServerNotification("signed-by-apple", {
    configuration,
    verifier: verifier({}, testPayload),
  });
  assert.equal(result.processed, true);
  assert.equal(result.notificationType, "TEST");
});

test("notification verification rejects an invalid outer payload before database access", async () => {
  const { handleAppStoreServerNotification } = await import("@/lib/billing/app-store");
  await assert.rejects(
    () => handleAppStoreServerNotification("signed-by-apple", {
      configuration,
      verifier: verifier({}, { notificationType: "SUBSCRIBED" }),
    }),
    /Invalid App Store notification payload/
  );
});
