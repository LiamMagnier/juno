import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_CAPABILITY_REGISTRY,
  isFeatureAvailable,
  getCapabilitiesForPlatform,
} from "../src/lib/capabilities.js";

test("Canonical Capability Registry: Queries platform feature availability accurately", () => {
  assert.ok(Object.keys(CANONICAL_CAPABILITY_REGISTRY).length >= 10);
  assert.equal(isFeatureAvailable("chat_streaming", "web"), true);
  assert.equal(isFeatureAvailable("chat_streaming", "macos"), true);
  assert.equal(isFeatureAvailable("chat_streaming", "ios"), true);

  assert.equal(isFeatureAvailable("juno_code_local", "macos"), true);
  assert.equal(isFeatureAvailable("juno_code_local", "web"), false);

  const macCapabilities = getCapabilitiesForPlatform("macos");
  assert.ok(macCapabilities.length >= 10);
  assert.ok(macCapabilities.some((c) => c.id === "juno_code_local"));

  const webCapabilities = getCapabilitiesForPlatform("web");
  assert.ok(webCapabilities.some((c) => c.id === "enterprise_sso_oidc"));
});
