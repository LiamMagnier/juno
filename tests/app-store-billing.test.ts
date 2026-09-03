import test from "node:test";
import assert from "node:assert/strict";
import {
  planFromAppStoreProductId,
  parseAppStoreJws,
  verifyStoreKitTransaction,
} from "@/lib/billing/app-store";

function createMockJws(payload: Record<string, unknown>, header = { alg: "ES256", typ: "JWT" }) {
  const b64 = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64(header)}.${b64(payload)}.mock_signature`;
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

test("parseAppStoreJws successfully decodes header and payload", () => {
  const mockPayload = {
    transactionId: "10001",
    originalTransactionId: "10000",
    productId: "com.liammagnier.juno.pro.monthly",
    environment: "Sandbox",
  };
  const token = createMockJws(mockPayload);
  const result = parseAppStoreJws<typeof mockPayload>(token);

  assert.equal(result.header.alg, "ES256");
  assert.equal(result.payload.transactionId, "10001");
  assert.equal(result.payload.productId, "com.liammagnier.juno.pro.monthly");
});

test("parseAppStoreJws throws on invalid formats", () => {
  assert.throws(() => parseAppStoreJws("invalid.token"), /Invalid JWS format/);
  assert.throws(() => parseAppStoreJws(""), /Invalid JWS/);
});

test("verifyStoreKitTransaction validates required fields", async () => {
  const validPayload = {
    transactionId: "tx_123",
    originalTransactionId: "orig_123",
    bundleId: "com.liammagnier.juno",
    productId: "com.liammagnier.juno.pro.monthly",
    purchaseDate: Date.now(),
    environment: "Production",
  };
  const token = createMockJws(validPayload);
  const parsed = await verifyStoreKitTransaction(token);
  assert.equal(parsed.transactionId, "tx_123");
  assert.equal(parsed.originalTransactionId, "orig_123");
  assert.equal(parsed.productId, "com.liammagnier.juno.pro.monthly");

  const invalidToken = createMockJws({ transactionId: "only_this" });
  await assert.rejects(
    async () => verifyStoreKitTransaction(invalidToken),
    /missing required fields/
  );
});

test("handleAppStoreServerNotification handles TEST notification gracefully", async () => {
  const { handleAppStoreServerNotification } = await import("@/lib/billing/app-store");
  const testPayload = {
    notificationType: "TEST",
    notificationUUID: "test-uuid-1234",
    version: "2.0",
    signedDate: Date.now(),
  };
  const token = createMockJws(testPayload);
  const result = await handleAppStoreServerNotification(token);
  assert.equal(result.processed, true);
  assert.equal(result.notificationType, "TEST");
});

test("handleAppStoreServerNotification handles unassociated transactions without throwing", async () => {
  const { handleAppStoreServerNotification } = await import("@/lib/billing/app-store");
  const txPayload = {
    transactionId: "tx_unknown",
    originalTransactionId: "orig_unknown",
    productId: "com.liammagnier.juno.pro.monthly",
    purchaseDate: Date.now(),
  };
  const signedTx = createMockJws(txPayload);
  const notifPayload = {
    notificationType: "SUBSCRIBED",
    notificationUUID: "uuid-sub",
    version: "2.0",
    signedDate: Date.now(),
    data: {
      signedTransactionInfo: signedTx,
    },
  };
  const token = createMockJws(notifPayload);
  const result = await handleAppStoreServerNotification(token);
  assert.equal(result.processed, false);
  assert.equal(result.notificationType, "SUBSCRIBED");
  assert.ok(result.warning, "Expected a warning describing failure to associate transaction");
});


