import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DESIGN_BRIDGE_HANDLER,
  DESIGN_BRIDGE_PROTOCOL_VERSION,
} from "../src/components/design/host/bridge";

/**
 * The design bridge is written twice — once in Swift (`DesignBridge.swift`) and
 * once in TypeScript (`host/bridge.ts`) — because it is fifteen lines and a
 * generator for it would be more machinery than contract. These tests are what
 * make that safe: they read the Swift source and assert the two agree, so a
 * change to one that is not mirrored in the other fails here rather than as a
 * silently dead pane on someone's Mac.
 */

const swiftBridge = readFileSync(
  resolve(process.cwd(), "native/Packages/JunoNativeKit/Sources/JunoDesignKit/DesignBridge.swift"),
  "utf8"
);

function swiftConstant(name: string): string {
  const match = new RegExp(`static let ${name}\\s*=\\s*("?)([^"\\n]+)\\1`).exec(swiftBridge);
  assert.ok(match, `could not find DesignBridge.${name} in the Swift source`);
  return match![2].trim();
}

test("the protocol version matches the Swift host", () => {
  assert.equal(String(DESIGN_BRIDGE_PROTOCOL_VERSION), swiftConstant("protocolVersion"));
});

test("the message handler name matches the Swift host", () => {
  assert.equal(DESIGN_BRIDGE_HANDLER, swiftConstant("messageHandlerName"));
});

test("every message type the editor sends is one the Swift validator accepts", () => {
  const editorSource = readFileSync(resolve(process.cwd(), "src/components/design/host/bridge.ts"), "utf8");
  // `post({ type: "…" })` call sites.
  const sent = [...editorSource.matchAll(/post\(\{\s*type:\s*"([a-zA-Z-]+)"/g)].map((m) => m[1]);
  assert.ok(sent.length >= 3, "expected the editor to send several message types");

  // `case "…":` arms of the Swift validator's switch.
  const accepted = [...swiftBridge.matchAll(/^\s*case "([a-zA-Z-]+)":$/gm)].map((m) => m[1]);
  for (const type of sent) {
    assert.ok(accepted.includes(type), `Swift's validator has no arm for the "${type}" message the editor sends`);
  }
});

test("every host command the Swift side emits is one the editor handles", () => {
  const mainSource = readFileSync(resolve(process.cwd(), "src/components/design/host/main.tsx"), "utf8");
  const bridgeSource = readFileSync(resolve(process.cwd(), "src/components/design/host/bridge.ts"), "utf8");
  const editorSource = `${mainSource}\n${bridgeSource}`;

  // `payload = ["type": "…"` in DesignHostCommand.javaScript().
  const emitted = [...swiftBridge.matchAll(/"type":\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 3, "expected several host commands");

  for (const command of new Set(emitted)) {
    assert.ok(
      editorSource.includes(`"${command}"`),
      `the editor bundle does not handle the "${command}" command the host sends`
    );
  }
});

test("the editor announces itself before it will accept a document", () => {
  const source = readFileSync(resolve(process.cwd(), "src/components/design/host/bridge.ts"), "utf8");
  // The `ready` post carries the protocol version; the Swift side refuses a
  // mismatch, which is what stops a stale bundle half-speaking to a new host.
  assert.match(source, /type:\s*"ready"[\s\S]{0,200}protocolVersion/);
  assert.match(swiftBridge, /case "ready":[\s\S]{0,400}unsupportedProtocol/);
});

test("the bundled editor is present, self-contained and current", () => {
  const dir = resolve(process.cwd(), "native/macOS/JunoDesktop/Resources/DesignEditor");
  const html = readFileSync(resolve(dir, "index.html"), "utf8");
  const js = readFileSync(resolve(dir, "editor.js"), "utf8");

  // Local only: the Mac must never fetch its editor.
  assert.match(html, /<script src="editor\.js"><\/script>/);
  assert.ok(!/<script[^>]+src="https?:/.test(html), "the editor must not load remote script");
  assert.ok(!/<link[^>]+href="https?:/.test(html), "the editor must not load a remote stylesheet");

  // A restrictive policy on the trusted page itself.
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /default-src 'none'/);

  // No fetchable remote origin survived bundling. XML namespaces and the React
  // error-decoder URL are identifiers in strings, not requests.
  const allowed = /^https?:\/\/(www\.)?(w3\.org|json-schema\.org|react\.dev)/;
  const origins = [...js.matchAll(/https?:\/\/[a-zA-Z0-9./-]+/g)].map((m) => m[0]);
  const unexpected = [...new Set(origins)].filter((origin) => !allowed.test(origin));
  assert.deepEqual(unexpected, [], "the bundle references a remote origin");
});
