import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

/*
 * The capability registry against the switches the code really reads.
 *
 * Teach by demonstration, iMessage, saved logins, payment cards and agent
 * computers are built and off until the owner sets their variables. The
 * registry used to call two of them "disabled" with no evidence and leave the
 * others' switches unnamed, so anything reading it under-reported what had
 * shipped. Here every `featureFlags` list is held to the predicate that gates
 * the feature: none set is off, the registry's names set is on, and taking
 * away any one of them is off again. A switch renamed in src/lib/env.ts, or a
 * gate added without naming it here, fails this file.
 */

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
const capabilities = require("../src/lib/capabilities") as typeof import("@/lib/capabilities");
const envModule = require("../src/lib/env") as typeof import("@/lib/env");
const { computerProvider } = require("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const { isConnectorConfigured } = require("../src/lib/connectors") as typeof import("@/lib/connectors");
const { firstPartyDefinitions } = require("../src/lib/first-party-connectors/providers") as typeof import("@/lib/first-party-connectors/providers");
loader._load = originalLoad;

const { CANONICAL_CAPABILITY_REGISTRY, isFeatureAvailable, isCapabilityProductionAccepted } = capabilities;
const ROOT = path.resolve(__dirname, "..");

/** A value each switch accepts as "on" (the shapes the parsers check). */
const ON: Record<string, string> = {
  AGENT_TEACH_ENABLED: "1",
  AGENT_VAULT_ENABLED: "1",
  COMPUTER_PROVIDER: "docker",
  CHANNEL_SENDBLUE_API_KEY_ID: "key-id",
  CHANNEL_SENDBLUE_API_SECRET_KEY: "key-secret",
  CHANNEL_SENDBLUE_FROM_NUMBER: "+14155550100",
  CHANNEL_SENDBLUE_WEBHOOK_SECRET: "webhook-secret",
  STRIPE_ISSUING_SECRET_KEY: "sk_test_registry",
  STRIPE_ISSUING_CARDHOLDER_ID: "ich_registry",
  STRIPE_ISSUING_WEBHOOK_SECRET: "whsec_registry",
  CONNECTOR_GOOGLE_CLIENT_ID: "google-client",
  CONNECTOR_GOOGLE_CLIENT_SECRET: "google-secret",
  CONNECTOR_MICROSOFT_CLIENT_ID: "microsoft-client",
  CONNECTOR_MICROSOFT_CLIENT_SECRET: "microsoft-secret",
};

/** Aliases and side doors that would turn a gate on behind the test's back. */
const ALSO_CLEARED = ["AGENT_COMPUTER_PROVIDER", "AGENT_PAYMENTS_TEST_PROVIDER"];

const firstParty = (id: string) => () => {
  const def = firstPartyDefinitions("https://alevr.example", process.env).find((d) => d.id === id);
  assert.ok(def, id);
  return isConnectorConfigured(def);
};

/** The predicate each gated capability's code path asks. */
const GATES: Record<string, () => boolean> = {
  teach_alevr: envModule.isAgentTeachConfigured,
  agent_vault: envModule.isAgentVaultConfigured,
  external_channels: envModule.isIMessageConfigured,
  agent_payments: envModule.isAgentPaymentsConfigured,
  computer_cloud: () => computerProvider() !== null,
  cloud_connector_google_drive: firstParty("google-drive"),
  cloud_connector_microsoft_365: firstParty("microsoft-365"),
};

function withEnv<T>(values: Record<string, string>, run: () => T): T {
  const names = [...Object.keys(ON), ...ALSO_CLEARED];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const gated = Object.values(CANONICAL_CAPABILITY_REGISTRY).filter((cap) => cap.featureFlags?.length);

test("every gated capability has its predicate here, and every predicate's capability names its switch", () => {
  assert.deepEqual(gated.map((cap) => cap.id).sort(), Object.keys(GATES).sort());
  for (const cap of gated) {
    for (const name of cap.featureFlags!) assert.ok(name in ON, `${cap.id}: no test value for ${name}`);
  }
});

for (const [id, gate] of Object.entries(GATES)) {
  test(`${id}: off with none of its switches, on with exactly the registry's, off without any one`, () => {
    const flags = CANONICAL_CAPABILITY_REGISTRY[id].featureFlags!;
    const all = Object.fromEntries(flags.map((name) => [name, ON[name]]));
    assert.equal(withEnv({}, gate), false, "off by default");
    assert.equal(withEnv(all, gate), true, `on with ${flags.join(" + ")}`);
    for (const missing of flags) {
      const rest = Object.fromEntries(flags.filter((name) => name !== missing).map((name) => [name, ON[name]]));
      assert.equal(withEnv(rest, gate), false, `still on without ${missing}`);
    }
  });
}

test("a switch the registry names is one the code reads", () => {
  const readers = ["src/lib/env.ts", "src/lib/payments/config.ts", "src/lib/first-party-connectors/providers.ts"]
    .map((file) => readFileSync(path.join(ROOT, file), "utf8"))
    .join("\n");
  for (const cap of gated) {
    for (const name of cap.featureFlags!) assert.ok(readers.includes(name), `${cap.id}: ${name} is read nowhere`);
  }
});

test("a gated capability is never stable (off is what ships) and never disabled (the code is there)", () => {
  for (const cap of gated) {
    assert.notEqual(cap.status, "stable", cap.id);
    assert.notEqual(cap.status, "disabled", cap.id);
    assert.ok(cap.platforms.length > 0, `${cap.id} names a client`);
    assert.ok(cap.production.blockers.length > 0, cap.id);
  }
});

test("teach, iMessage, saved logins, payment cards and computers are built behind a switch, on the web, unaccepted", () => {
  for (const id of ["teach_alevr", "external_channels", "agent_vault", "agent_payments", "computer_cloud"]) {
    const cap = CANONICAL_CAPABILITY_REGISTRY[id];
    assert.ok(cap, id);
    assert.ok(cap.featureFlags?.length, `${id} names its switch`);
    assert.ok(["implemented", "verified", "blocked"].includes(cap.maturity.backend.state), `${id} backend`);
    assert.ok(cap.maturity.backend.evidence.length > 0, `${id} backend evidence`);
    assert.ok(cap.platforms.includes("web"), `${id} on the web`);
    assert.equal(isFeatureAvailable(id, "web"), true, `${id} is implemented on the web`);
    assert.equal(isCapabilityProductionAccepted(id, "web"), false, `${id} is not accepted`);
    // No native surface exists for any of them, and the registry says so.
    assert.equal(isFeatureAvailable(id, "ios"), false, `${id} on iOS`);
  }
});

test("a disabled capability has no code to point at, and an unwired library claims no client", () => {
  for (const cap of Object.values(CANONICAL_CAPABILITY_REGISTRY)) {
    if (cap.status === "disabled") {
      assert.deepEqual(cap.platforms, [], cap.id);
      for (const surface of Object.values(cap.maturity)) assert.equal(surface.evidence.length, 0, cap.id);
    }
  }
  for (const id of ["canvas_crdt_sync", "enterprise_sso_oidc"]) {
    const cap = CANONICAL_CAPABILITY_REGISTRY[id];
    assert.notEqual(cap.status, "stable", id);
    assert.deepEqual(cap.platforms, [], id);
  }
});

test("a stable capability is not one whose evidence is a module nothing imports", () => {
  // The two libraries the registry used to sell as stable, and the earlier
  // Drive and OneDrive clients the first-party connectors replaced.
  const unwired = [
    "src/lib/collaboration/crdt.ts",
    "src/lib/auth/enterprise-sso.ts",
    "src/lib/connectors/google-drive.ts",
    "src/lib/connectors/microsoft-365.ts",
  ];
  for (const cap of Object.values(CANONICAL_CAPABILITY_REGISTRY)) {
    if (cap.status !== "stable") continue;
    for (const surface of Object.values(cap.maturity)) {
      for (const evidence of surface.evidence) assert.ok(!unwired.includes(evidence), `${cap.id} cites ${evidence}`);
    }
  }
});
