import test from "node:test";
import assert from "node:assert/strict";
import { relayedResponseHeaders } from "@/lib/agent-proxy";

/*
 * What the agent proxy hands back beside a provider's body. The Mac's retry
 * policy waits as long as a provider's `retry-after` asks; a proxy that dropped
 * the header left it guessing, and one that passed everything would hand the
 * app the provider's request ids and rate-limit ledgers.
 */

test("a provider's retry-after and retry-after-ms reach the client", () => {
  const upstream = new Headers({
    "content-type": "application/json",
    "retry-after": "7",
    "retry-after-ms": "6500",
  });
  const relayed = relayedResponseHeaders(upstream);
  assert.equal(relayed.get("content-type"), "application/json");
  assert.equal(relayed.get("retry-after"), "7");
  assert.equal(relayed.get("retry-after-ms"), "6500");
  assert.equal(relayed.get("cache-control"), "no-store");
});

test("nothing else the provider sent crosses, and absent headers stay absent", () => {
  const upstream = new Headers({
    "content-type": "text/event-stream",
    "request-id": "req_123",
    "anthropic-organization-id": "org_456",
    "x-ratelimit-remaining-requests": "12",
    "set-cookie": "a=b",
  });
  const relayed = relayedResponseHeaders(upstream);
  assert.deepEqual(
    [...relayed.keys()].sort(),
    ["cache-control", "content-type"],
  );
});
