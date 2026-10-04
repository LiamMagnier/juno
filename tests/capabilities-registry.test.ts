import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CANONICAL_CAPABILITY_REGISTRY,
  isFeatureAvailable,
  getCapabilitiesForPlatform,
  CAPABILITY_MATURITY_STATES,
  CAPABILITY_SURFACES,
  capabilityReleaseBlockers,
  isCapabilityProductionAccepted,
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

test("every capability records each surface and resolvable implementation evidence", () => {
  for (const [id, cap] of Object.entries(CANONICAL_CAPABILITY_REGISTRY)) {
    assert.equal(cap.id, id);
    assert.deepEqual(Object.keys(cap.maturity), CAPABILITY_SURFACES);
    for (const surface of CAPABILITY_SURFACES) {
      const maturity = cap.maturity[surface];
      assert.ok(CAPABILITY_MATURITY_STATES.includes(maturity.state), `${id}/${surface}`);
      for (const evidence of maturity.evidence) assert.ok(existsSync(resolve(evidence)), evidence);
      if (["implemented", "verified", "enabled", "production_accepted"].includes(maturity.state)) {
        assert.ok(maturity.evidence.length, `${id}/${surface} has a claim without evidence`);
      }
      if (maturity.state === "verified") assert.ok(maturity.verification?.command, `${id}/${surface}`);
      if (["planned", "blocked"].includes(maturity.state)) assert.ok(maturity.blockers?.length, `${id}/${surface}`);
    }
    if (cap.production.accepted) {
      assert.ok(cap.platforms.length, `${id} has no supported production client`);
      for (const platform of cap.platforms) assert.deepEqual(capabilityReleaseBlockers(id, platform), []);
    } else {
      assert.ok(cap.production.blockers.length, `${id} needs a remaining acceptance milestone`);
    }
  }
});

test("legacy stable labels and source code cannot imply enabled or production accepted", () => {
  assert.equal(CANONICAL_CAPABILITY_REGISTRY.chat_streaming.status, "stable");
  assert.equal(isFeatureAvailable("chat_streaming", "web"), true);
  assert.equal(isCapabilityProductionAccepted("chat_streaming", "web"), false);
  assert.match(capabilityReleaseBlockers("chat_streaming", "web").join(" "), /acceptance/i);
  assert.equal(isFeatureAvailable("enterprise_sso_saml", "web"), false);
  assert.equal(isFeatureAvailable("canvas_crdt_sync", "web"), false);
  assert.equal(isFeatureAvailable("computer_cloud", "web"), true);
  assert.equal(isCapabilityProductionAccepted("computer_cloud", "web"), false);
  assert.match(capabilityReleaseBlockers("computer_cloud", "web").join(" "), /security acceptance/);
  assert.equal(isCapabilityProductionAccepted("juno_code_local", "web"), false);
  assert.equal(isFeatureAvailable("missing", "web"), false);
  assert.deepEqual(capabilityReleaseBlockers("missing", "web"), ["Unknown capability."]);
});

test("release gate requires acceptance evidence on both backend and client", () => {
  const cap = CANONICAL_CAPABILITY_REGISTRY.chat_streaming;
  const previous = structuredClone(cap);
  try {
    cap.production = { accepted: true, evidence: ["release-receipt"], blockers: [] };
    assert.equal(isCapabilityProductionAccepted(cap.id, "web"), false);
    cap.maturity.backend = { state: "production_accepted", evidence: ["backend-receipt"] };
    assert.equal(isCapabilityProductionAccepted(cap.id, "web"), false);
    cap.maturity.web = { state: "production_accepted", evidence: ["web-receipt"] };
    assert.equal(isCapabilityProductionAccepted(cap.id, "web"), true);
    assert.equal(isCapabilityProductionAccepted(cap.id, "ios"), false);
    cap.maturity.web.evidence = [];
    assert.equal(isCapabilityProductionAccepted(cap.id, "web"), false);
  } finally {
    Object.assign(cap, previous);
  }
});
