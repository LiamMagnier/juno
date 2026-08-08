import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSandboxDoc } from "../src/components/canvas/sandbox-frame";

test("artifact previews enforce an opaque, no-egress document policy", () => {
  const html = buildSandboxDoc("HTML", `<img src="https://attacker.example/track.gif"><form action="https://attacker.example"></form>`);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src https:\/\/cdn\.jsdelivr\.net/);
  assert.match(html, /img-src data: blob:/);

  const source = readFileSync(new URL("../src/components/canvas/sandbox-frame.tsx", import.meta.url), "utf8");
  assert.match(source, /sandbox="allow-scripts"/);
  assert.doesNotMatch(source, /sandbox="[^"]*allow-(?:popups|forms|modals)/);
});
