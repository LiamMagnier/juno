import test from "node:test";
import assert from "node:assert/strict";
import {
  HEALTHY_TTL_MS,
  UNHEALTHY_TTL_MS,
  healthTransition,
  isAccountFault,
  isHealthStale,
  nextHealthState,
  type ProviderHealthState,
} from "@/lib/provider-health-policy";

const NOW = 1_800_000_000_000;

function state(over: Partial<ProviderHealthState> = {}): ProviderHealthState {
  return {
    provider: "anthropic",
    healthy: true,
    checkedAt: NOW,
    failure: null,
    detail: null,
    ...over,
  };
}

test("a provider that has never been probed is stale, and counts as healthy", () => {
  assert.equal(isHealthStale(undefined, NOW), true);
  assert.equal(isHealthStale(state({ checkedAt: null }), NOW), true);
  // Fail open: the catalog may only shrink on positive evidence.
  const next = nextHealthState("anthropic", undefined, { ok: true }, NOW);
  assert.equal(next.healthy, true);
});

test("a healthy verdict goes stale after the healthy TTL", () => {
  const entry = state({ healthy: true, checkedAt: NOW });
  assert.equal(isHealthStale(entry, NOW + HEALTHY_TTL_MS - 1), false);
  assert.equal(isHealthStale(entry, NOW + HEALTHY_TTL_MS + 1), true);
});

test("a down provider is re-probed less often than a healthy one", () => {
  const down = state({ healthy: false, checkedAt: NOW, failure: "billing" });
  assert.equal(isHealthStale(down, NOW + HEALTHY_TTL_MS + 1), false);
  assert.equal(isHealthStale(down, NOW + UNHEALTHY_TTL_MS + 1), true);
  assert.ok(UNHEALTHY_TTL_MS > HEALTHY_TTL_MS);
});

test("only auth and billing count as the operator's problem", () => {
  assert.equal(isAccountFault("auth"), true);
  assert.equal(isAccountFault("billing"), true);
  for (const klass of [
    "rate_limit",
    "capacity",
    "context",
    "content_filter",
    "not_found",
    "network",
    "unknown",
  ] as const) {
    assert.equal(isAccountFault(klass), false, `${klass} must not mark a provider down`);
  }
});

test("a dead key marks the provider down with its reason", () => {
  const next = nextHealthState(
    "anthropic",
    state({ healthy: true }),
    { ok: false, class: "billing", status: 400, raw: "credit balance is too low" },
    NOW + 1
  );
  assert.equal(next.healthy, false);
  assert.equal(next.failure, "billing");
  assert.match(next.detail ?? "", /400 credit balance is too low/);
  assert.equal(next.checkedAt, NOW + 1);
});

test("a busy provider does not flap out of the catalog", () => {
  // The failure mode this prevents: pulling models from the picker every time a
  // provider has a busy minute, i.e. exactly under peak load.
  for (const klass of ["rate_limit", "capacity", "network"] as const) {
    const next = nextHealthState(
      "openai",
      state({ provider: "openai", healthy: true }),
      { ok: false, class: klass, status: 429, raw: "slow down" },
      NOW + 5
    );
    assert.equal(next.healthy, true, `${klass} must not mark the provider down`);
    // ...but the clock still moves, or it would be re-probed on every request.
    assert.equal(next.checkedAt, NOW + 5, `${klass} must still advance the clock`);
  }
});

test("a transient failure does not resurrect a provider that is down", () => {
  const down = state({ healthy: false, failure: "billing", detail: "402 Insufficient Balance" });
  const next = nextHealthState("deepseek", down, { ok: false, class: "capacity", status: 503, raw: "oops" }, NOW + 5);
  assert.equal(next.healthy, false);
  assert.equal(next.failure, "billing", "the original reason must survive");
  assert.equal(next.detail, "402 Insufficient Balance");
});

test("a successful probe clears a previous failure", () => {
  const down = state({ healthy: false, failure: "billing", detail: "402" });
  const next = nextHealthState("deepseek", down, { ok: true }, NOW + 5);
  assert.equal(next.healthy, true);
  assert.equal(next.failure, null);
  assert.equal(next.detail, null);
});

test("only real transitions alert, and a first healthy sighting is not news", () => {
  const up = state({ healthy: true });
  const down = state({ healthy: false, failure: "auth" });

  assert.equal(healthTransition(undefined, up), null, "first healthy probe is not an alert");
  assert.equal(healthTransition(undefined, down), "down", "first failing probe IS an alert");
  assert.equal(healthTransition(up, down), "down");
  assert.equal(healthTransition(down, up), "recovered");
  assert.equal(healthTransition(up, up), null);
  assert.equal(healthTransition(down, down), null, "a provider down for a day alerts once");
});

test("detail is bounded so a chatty provider cannot flood the log", () => {
  const next = nextHealthState(
    "zhipu",
    undefined,
    { ok: false, class: "auth", status: 401, raw: "x".repeat(5000) },
    NOW
  );
  assert.ok((next.detail ?? "").length <= 300);
});
