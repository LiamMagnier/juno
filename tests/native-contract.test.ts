import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CONTRACT_VERSION } from "../src/lib/api-v1";

const canonicalRedirect = "com.liammagnier.juno://auth/callback";
const legacyRedirect = "juno://auth/callback";

test("native OpenAPI and backend expose the same version and exact callback allowlist", async () => {
  const contract = await readFile("contracts/openapi/juno-native-v1.yaml", "utf8");
  assert.match(contract, new RegExp(`^  version: ${CONTRACT_VERSION.replaceAll(".", "\\.")}$`, "m"));
  assert.match(contract, new RegExp(`enum: \\['${canonicalRedirect}', '${legacyRedirect}'\\]`));
  assert.match(contract, new RegExp(`default: '${canonicalRedirect}'`));
  assert.doesNotMatch(contract, /redirectUri:\s*\{[^\n]*const:/);
});

test("native OpenAPI publishes the existing bearer chat flow", async () => {
  const contract = await readFile("contracts/openapi/juno-native-v1.yaml", "utf8");
  for (const operation of [
    "appendNativeConversationMessages",
    "streamNativeChat",
    "cancelNativeChatGeneration",
    "getNativeChatReceipt",
  ]) {
    assert.match(contract, new RegExp(`operationId: ${operation}`));
  }
  assert.match(contract, /servers: \[\{ url: \/api \}\]/);
  assert.match(contract, /regenerate: \{ const: true \}/);
  assert.match(contract, /x-juno-event-schema: '#\/components\/schemas\/ChatSSEEvent'/);
  assert.match(contract, /must not\n\s+automatically repeat this POST/);
});

test("native Swift contract generation is deterministic and self-contained", async () => {
  const directory = await mkdtemp(join(tmpdir(), "juno-native-contract-"));
  const firstOutput = join(directory, "First.swift");
  const secondOutput = join(directory, "Second.swift");
  try {
    for (const output of [firstOutput, secondOutput]) {
      const result = spawnSync(process.execPath, [
        "scripts/generate-native-swift-contract.mjs",
        `--output=${output}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    const first = await readFile(firstOutput, "utf8");
    const second = await readFile(secondOutput, "utf8");
    assert.equal(first, second);
    assert.match(first, new RegExp(`version = "${CONTRACT_VERSION.replaceAll(".", "\\.")}"`));
    assert.match(first, new RegExp(`canonicalRedirectURI = "${canonicalRedirect}"`));
    assert.match(first, new RegExp(`"${legacyRedirect}"`));
    assert.doesNotMatch(first, /BackendUser/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
