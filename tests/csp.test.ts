import test from "node:test";
import assert from "node:assert/strict";
import { buildCsp } from "@/lib/csp";

const NONCE = "0f3b2c11-0000-4000-8000-000000000000";
const directives = (csp: string) =>
  new Map(
    csp.split(";").map((d) => {
      const [name, ...rest] = d.trim().split(/\s+/);
      return [name, rest.join(" ")];
    })
  );

test("the request nonce reaches script-src", () => {
  const d = directives(buildCsp({ nonce: NONCE }));
  assert.match(d.get("script-src") ?? "", new RegExp(`'nonce-${NONCE}'`));
});

test("strict-dynamic is present, so host allowlists cannot be leaned on", () => {
  const d = directives(buildCsp({ nonce: NONCE }));
  assert.match(d.get("script-src") ?? "", /'strict-dynamic'/);
});

test("the dangerous sinks are closed", () => {
  const d = directives(buildCsp({ nonce: NONCE }));
  assert.equal(d.get("object-src"), "'none'", "no plugins");
  assert.equal(d.get("base-uri"), "'self'", "a injected <base> must not repoint relative URLs");
  assert.equal(d.get("form-action"), "'self'", "no exfiltration by form post");
  assert.equal(d.get("frame-ancestors"), "'self'", "no clickjacking");
});

test("script-src never allows unsafe-eval", () => {
  // 'unsafe-inline' IS present as a fallback for browsers without
  // strict-dynamic support, which nonce-aware browsers discard. 'unsafe-eval'
  // would be a real hole and nothing in the app needs it.
  const d = directives(buildCsp({ nonce: NONCE }));
  assert.doesNotMatch(d.get("script-src") ?? "", /'unsafe-eval'/);
});

test("the voice relay is allowed to connect only when configured", () => {
  const without = directives(buildCsp({ nonce: NONCE }));
  assert.equal(without.get("connect-src"), "'self'");

  const withRelay = directives(buildCsp({ nonce: NONCE, relayUrl: "wss://relay.example.test" }));
  assert.equal(withRelay.get("connect-src"), "'self' wss://relay.example.test");
});

test("an empty relay URL does not produce a dangling connect-src", () => {
  for (const relayUrl of ["", undefined]) {
    const d = directives(buildCsp({ nonce: NONCE, relayUrl }));
    assert.equal(d.get("connect-src"), "'self'");
  }
});

test("violations have somewhere to go", () => {
  // Report-Only without a report endpoint is theatre: nothing would ever be
  // learned and the policy could never be promoted to enforcing.
  const d = directives(buildCsp({ nonce: NONCE }));
  assert.equal(d.get("report-uri"), "/api/csp-report");
});

test("every directive is well formed", () => {
  const csp = buildCsp({ nonce: NONCE, relayUrl: "wss://relay.example.test" });
  assert.doesNotMatch(csp, /;;/, "no empty directive");
  assert.doesNotMatch(csp, /\s;/, "no trailing space before a separator");
  for (const [name, value] of directives(csp)) {
    assert.ok(name.length > 0, "unnamed directive");
    assert.ok(value.length > 0, `${name} has no value`);
  }
});

test("a default-src fallback exists for anything not named", () => {
  const d = directives(buildCsp({ nonce: NONCE }));
  assert.equal(d.get("default-src"), "'self'");
});
