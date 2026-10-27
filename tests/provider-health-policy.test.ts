import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIVE_FAULT_TUNABLES,
  HEALTHY_TTL_MS,
  UNHEALTHY_TTL_MS,
  classForWorkFailure,
  defaultModelProviders,
  healthTransition,
  isAccountFault,
  isHealthStale,
  liveFaultTunables,
  liveFaultVerdict,
  nextHealthState,
  seedSuspects,
  seededState,
  type LiveFaultTunables,
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

// ---------------------------------------------------------------------------
// Live faults: real turns feed health (liveFaultVerdict)
// ---------------------------------------------------------------------------

const T: LiveFaultTunables = { ...DEFAULT_LIVE_FAULT_TUNABLES };

test("a live account fault marks a healthy lab down at once, unconfirmed and soon re-probed", () => {
  const verdict = liveFaultVerdict({
    provider: "qwen",
    previous: state({ provider: "qwen", healthy: true }),
    fault: { class: "billing", status: 400, raw: "Arrearage: account in arrears" },
    recentCapacity: [],
    now: NOW,
    tunables: T,
  });
  assert.ok(verdict.next);
  assert.equal(verdict.next.healthy, false);
  assert.equal(verdict.next.failure, "billing");
  assert.equal(verdict.next.source, "live");
  assert.equal(verdict.next.recheckAt, NOW + T.recheckMs);
  // Down for the next turn, and the probe looks again after the short recheck,
  // not after the 30-minute unhealthy TTL.
  assert.equal(healthTransition(state({ provider: "qwen" }), verdict.next), "down");
  assert.equal(isHealthStale(verdict.next, NOW + T.recheckMs - 1), false);
  assert.equal(isHealthStale(verdict.next, NOW + T.recheckMs), true);
});

test("a live fault with no HTTP status proves nothing about the lab's account", () => {
  // A tool failure or an internal error that reached the same catch.
  const verdict = liveFaultVerdict({
    provider: "openai",
    previous: undefined,
    fault: { class: "auth", status: null, raw: "Unauthorized: connector token expired" },
    recentCapacity: [],
    now: NOW,
    tunables: T,
  });
  assert.equal(verdict.next, null);
});

test("a lab already down for the same reason is not re-recorded", () => {
  const verdict = liveFaultVerdict({
    provider: "qwen",
    previous: state({ provider: "qwen", healthy: false, failure: "billing", source: "probe" }),
    fault: { class: "billing", status: 402, raw: "Insufficient Balance" },
    recentCapacity: [],
    now: NOW,
    tunables: T,
  });
  assert.equal(verdict.next, null, "a confirmed verdict must not be pushed back to unconfirmed");
});

test("one server error is weather; repeated ones on real traffic mark the lab down until the probe", () => {
  let recent: number[] = [];
  let previous: ProviderHealthState | undefined = state({ provider: "google", healthy: true });
  for (let i = 0; i < T.capacityFaults - 1; i += 1) {
    const verdict = liveFaultVerdict({
      provider: "google",
      previous,
      fault: { class: "capacity", status: 503, raw: "overloaded" },
      recentCapacity: recent,
      now: NOW + i * 1000,
      tunables: T,
    });
    assert.equal(verdict.next, null, `fault ${i + 1} of ${T.capacityFaults} must not mark the lab down`);
    recent = verdict.recentCapacity;
  }
  const tripped = liveFaultVerdict({
    provider: "google",
    previous,
    fault: { class: "capacity", status: 503, raw: "overloaded" },
    recentCapacity: recent,
    now: NOW + 5000,
    tunables: T,
  });
  assert.ok(tripped.next);
  assert.equal(tripped.next.healthy, false);
  assert.equal(tripped.next.failure, "capacity");
  assert.equal(tripped.next.recheckAt, NOW + 5000 + T.recheckMs);
  assert.deepEqual(tripped.recentCapacity, [], "the window starts again once it trips");
  previous = tripped.next;

  // The probe owns recovery: a probe that still meets server errors keeps it
  // down with another short recheck; a probe that answers clears it.
  const stillBad = nextHealthState("google", previous, { ok: false, class: "capacity", status: 503, raw: "x" }, NOW + 200_000, T.recheckMs);
  assert.equal(stillBad.healthy, false);
  assert.equal(stillBad.recheckAt, NOW + 200_000 + T.recheckMs);
  const cleared = nextHealthState("google", previous, { ok: true }, NOW + 200_000, T.recheckMs);
  assert.equal(cleared.healthy, true);
  assert.equal(healthTransition(previous, cleared), "recovered");
});

test("server errors spread wider than the window never add up", () => {
  let recent: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const verdict = liveFaultVerdict({
      provider: "google",
      previous: undefined,
      fault: { class: "capacity", status: 500, raw: "x" },
      recentCapacity: recent,
      now: NOW + i * (T.capacityWindowMs / 2 + 1),
      tunables: T,
    });
    assert.equal(verdict.next, null);
    recent = verdict.recentCapacity;
  }
});

test("rate limits and request-level failures leave health alone", () => {
  for (const klass of ["rate_limit", "context", "content_filter", "invalid_request", "not_found", "network", "unknown"] as const) {
    const verdict = liveFaultVerdict({
      provider: "openai",
      previous: undefined,
      fault: { class: klass, status: 429, raw: "x" },
      recentCapacity: [],
      now: NOW,
      tunables: T,
    });
    assert.equal(verdict.next, null, `${klass} must not change health`);
  }
});

test("nothing a live turn reports ever marks a lab healthy", () => {
  const down = state({ provider: "qwen", healthy: false, failure: "auth" });
  for (const klass of ["capacity", "rate_limit", "network"] as const) {
    const verdict = liveFaultVerdict({
      provider: "qwen",
      previous: down,
      fault: { class: klass, status: 503, raw: "x" },
      recentCapacity: [NOW - 1, NOW - 2],
      now: NOW,
      tunables: T,
    });
    assert.ok(verdict.next === null || verdict.next.healthy === false);
  }
});

test("a live fault the probe cannot confirm either way stays unconfirmed with a short recheck", () => {
  const live = { ...state({ provider: "qwen", healthy: false, failure: "billing" as const }), source: "live" as const, recheckAt: NOW + 1 };
  const timedOut = nextHealthState("qwen", live, { ok: false, class: "network", status: null, raw: "timeout" }, NOW + 10, T.recheckMs);
  assert.equal(timedOut.healthy, false);
  assert.equal(timedOut.source, "live");
  assert.equal(timedOut.recheckAt, NOW + 10 + T.recheckMs);
  const confirmed = nextHealthState("qwen", live, { ok: false, class: "billing", status: 402, raw: "x" }, NOW + 10, T.recheckMs);
  assert.equal(confirmed.source, "probe");
  assert.equal(confirmed.recheckAt, null, "a confirmed account fault waits out the unhealthy TTL");
  assert.equal(healthTransition(live, confirmed), null, "confirmation is not a second alert");
});

test("Work's failure kinds map onto the classes conservatively", () => {
  assert.equal(classForWorkFailure("auth", 401), "auth");
  assert.equal(classForWorkFailure("insufficient_balance", 402), "billing");
  assert.equal(classForWorkFailure("overloaded", 529), "capacity");
  assert.equal(classForWorkFailure("transient", 502), "capacity");
  assert.equal(classForWorkFailure("transient", null), null, "a socket that never opened is not the lab's server");
  assert.equal(classForWorkFailure("forbidden", 403), null, "one model this key may not use is not the account");
  assert.equal(classForWorkFailure("plan_limit", 402), null, "Juno's own wall says nothing about the lab");
  assert.equal(classForWorkFailure("context_overflow", 400), null);
});

test("the tunables are read from the environment, clamped, and never let one 5xx take a lab down", () => {
  assert.deepEqual(liveFaultTunables({}), DEFAULT_LIVE_FAULT_TUNABLES);
  const tuned = liveFaultTunables({
    PROVIDER_CAPACITY_FAULTS_TO_MARK_DOWN: "1",
    PROVIDER_CAPACITY_FAULT_WINDOW_SECONDS: "60",
    PROVIDER_LIVE_FAULT_RECHECK_SECONDS: "5",
    PROVIDER_HEALTH_SEED_WINDOW_MINUTES: "nonsense",
    PROVIDER_HEALTH_SEED_MIN_FAILURES: "4",
  });
  assert.equal(tuned.capacityFaults, 2, "never fewer than two");
  assert.equal(tuned.capacityWindowMs, 60_000);
  assert.equal(tuned.recheckMs, 30_000, "clamped to the floor");
  assert.equal(tuned.seedWindowMs, DEFAULT_LIVE_FAULT_TUNABLES.seedWindowMs, "garbage falls back to the default");
  assert.equal(tuned.seedMinFailures, 4);
});

test("the default labs are the providers of the default models", () => {
  assert.deepEqual([...defaultModelProviders(["qwen:qwen3.8-flash", "openai:gpt-6-luna"])].sort(), ["openai", "qwen"]);
  assert.deepEqual([...defaultModelProviders(["auto", ""])], []);
});

// ---------------------------------------------------------------------------
// The boot seed (seedSuspects / seededState)
// ---------------------------------------------------------------------------

const minutesAgo = (m: number) => NOW - m * 60_000;

test("a lab whose newest turns all failed, with no answer since, is a suspect at boot", () => {
  const suspects = seedSuspects(
    [
      { provider: "qwen", completionState: "failed", finishReason: "error", createdAt: new Date(minutesAgo(1)) },
      { provider: "qwen", completionState: "stopped", finishReason: "user_stopped", createdAt: new Date(minutesAgo(2)) },
      { provider: "qwen", completionState: "failed", finishReason: "error", createdAt: new Date(minutesAgo(3)) },
      { provider: "qwen", completionState: "failed", finishReason: "error", createdAt: new Date(minutesAgo(4)) },
      { provider: "qwen", completionState: "completed", finishReason: "stop", createdAt: new Date(minutesAgo(9)) },
      { provider: "openai", completionState: "failed", finishReason: "error", createdAt: new Date(minutesAgo(1)) },
      { provider: "openai", completionState: "completed", finishReason: "stop", createdAt: new Date(minutesAgo(2)) },
    ],
    NOW,
    T,
  );
  assert.deepEqual(suspects.map((s) => s.provider), ["qwen"], "a Stop says nothing; an answer since clears a lab");
  assert.equal(suspects[0].failures, 3);
  assert.equal(suspects[0].since, minutesAgo(4));
});

test("an answer after the failures, a short streak, or old rows make no suspect", () => {
  const rows = [
    { provider: "qwen", completionState: "completed", finishReason: "stop", createdAt: minutesAgo(1) },
    { provider: "qwen", completionState: "failed", finishReason: "error", createdAt: minutesAgo(2) },
    { provider: "qwen", completionState: "failed", finishReason: "error", createdAt: minutesAgo(3) },
    { provider: "qwen", completionState: "failed", finishReason: "error", createdAt: minutesAgo(4) },
    { provider: "google", completionState: "failed", finishReason: "error", createdAt: minutesAgo(1) },
    { provider: "google", completionState: "failed", finishReason: "error", createdAt: minutesAgo(2) },
    { provider: "mistral", completionState: "failed", finishReason: "error", createdAt: minutesAgo(30) },
    { provider: "mistral", completionState: "failed", finishReason: "error", createdAt: minutesAgo(31) },
    { provider: "mistral", completionState: "failed", finishReason: "error", createdAt: minutesAgo(32) },
    // A turn that ran out of room is the model's length, not the lab's account.
    { provider: "xai", completionState: "failed", finishReason: "length", createdAt: minutesAgo(1) },
    { provider: "xai", completionState: "failed", finishReason: "length", createdAt: minutesAgo(2) },
    { provider: "xai", completionState: "failed", finishReason: "length", createdAt: minutesAgo(3) },
  ];
  assert.deepEqual(seedSuspects(rows, NOW, T), []);
});

test("a seed holds the lab down until its first probe, never alerts, and a probe without an account fault clears it", () => {
  const seeded = seededState("qwen", { failures: 4, since: minutesAgo(6) }, NOW);
  assert.equal(seeded.healthy, false);
  assert.equal(seeded.source, "seed");
  assert.equal(isHealthStale(seeded, NOW), true, "probed at once");
  assert.match(seeded.detail ?? "", /4 turns failed in the 6 minute/);
  assert.equal(healthTransition(undefined, seeded), null, "a restart must not repeat the outage alert");

  const confirmed = nextHealthState("qwen", seeded, { ok: false, class: "billing", status: 402, raw: "x" }, NOW + 1);
  assert.equal(confirmed.healthy, false);
  assert.equal(healthTransition(seeded, confirmed), null);

  for (const outcome of [{ ok: true } as const, { ok: false, class: "rate_limit", status: 429, raw: "x" } as const]) {
    const cleared = nextHealthState("qwen", seeded, outcome, NOW + 1);
    assert.equal(cleared.healthy, true, "a suspicion the probe does not confirm is dropped");
    assert.equal(healthTransition(seeded, cleared), null, "and was never news");
  }
});

test("a live fault confirms a seed", () => {
  const seeded = seededState("qwen", { failures: 3, since: minutesAgo(5) }, NOW);
  const verdict = liveFaultVerdict({
    provider: "qwen",
    previous: seeded,
    fault: { class: "billing", status: 400, raw: "Arrearage" },
    recentCapacity: [],
    now: NOW + 1,
    tunables: T,
  });
  assert.ok(verdict.next);
  assert.equal(verdict.next.source, "live");
  assert.equal(healthTransition(seeded, verdict.next), null, "already held down: no second alert");
});
