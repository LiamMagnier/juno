import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { mintRelayCallbackToken, verifyRelayToken } from "../src/auth.js";
import { isAllowedRelayOrigin, parseAllowedOrigins } from "../src/origin.js";

process.env.AUTH_SECRET = "relay-test-secret";

function inboundToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", process.env.AUTH_SECRET!).update(body).digest("base64url");
  return `${body}.${mac}`;
}

test("browser origins fail closed while native clients without Origin remain supported", () => {
  const allowed = parseAllowedOrigins(" https://chat.liams.dev/,https://app.liams.dev,https://chat.liams.dev ");
  assert.deepEqual(allowed, ["https://chat.liams.dev", "https://app.liams.dev"]);
  assert.equal(isAllowedRelayOrigin(undefined, []), true);
  assert.equal(isAllowedRelayOrigin("https://chat.liams.dev", []), false);
  assert.equal(isAllowedRelayOrigin("https://chat.liams.dev", allowed), true);
  assert.equal(isAllowedRelayOrigin("https://evil.example", allowed), false);
});

test("relay callback tokens cannot authenticate an inbound voice session", () => {
  const callback = mintRelayCallbackToken("user-1");
  assert.equal(verifyRelayToken(callback), null);
  assert.deepEqual(
    verifyRelayToken(inboundToken({ uid: "user-1", exp: Math.floor(Date.now() / 1000) + 60 })),
    { userId: "user-1" },
  );
  assert.equal(verifyRelayToken(inboundToken({ uid: "user-1", exp: Math.floor(Date.now() / 1000) - 1 })), null);
});
