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
  liveFaultOrigin,
  liveFaultTunables,
  liveFaultVerdict,
  MAX_INCONCLUSIVE_LIVE_PROBES,
  nextHealthState,
  outageMailDue,
  scrubHealthDetail,
  seedSuspects,
  seededState,
  toldAfterMail,
  type CapacityFault,
  type LiveFaultTunables,
  type ProbeOutcome,
  type ProviderHealthState,
} from "@/lib/provider-health-policy";
import { classifyProviderError } from "@/lib/provider-error";

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

test("a credential a provider echoes never reaches a verdict's detail", () => {
  const raw = "Incorrect API key provided: sk-proj-abc1****************wxyz. You can find your API key at platform.example.";
  const probed = nextHealthState("openai", undefined, { ok: false, class: "auth", status: 401, raw }, NOW);
  assert.doesNotMatch(probed.detail ?? "", /sk-proj|wxyz/);
  assert.match(probed.detail ?? "", /401 Incorrect API key provided: \[redacted key\]/);
  assert.equal(scrubHealthDetail("key=AIzaSyA-1234567890abcdef rejected"), "key=[redacted key] rejected");
  assert.equal(scrubHealthDetail("Authorization: Bearer abc.def.ghi-123 was refused"), "Authorization: Bearer [redacted] was refused");
  // Ordinary words with the same letters survive.
  assert.equal(scrubHealthDetail("a risk-free task-runner retry"), "a risk-free task-runner retry");

  let recent: CapacityFault[] = [];
  let held: ProviderHealthState | null = null;
  for (let i = 0; i < DEFAULT_LIVE_FAULT_TUNABLES.capacityFaults; i += 1) {
    const verdict = liveFaultVerdict({
      provider: "openai",
      previous: undefined,
      fault: { class: "capacity", status: 502, raw: "upstream refused Bearer sk-live-abcdef123456" },
      origin: liveFaultOrigin(`user-${i}`, "openai:gpt-6-luna"),
      recentCapacity: recent,
      now: NOW + i,
      tunables: DEFAULT_LIVE_FAULT_TUNABLES,
    });
    recent = verdict.recentCapacity;
    held = verdict.next ?? held;
  }
  assert.ok(held);
  assert.doesNotMatch(held.detail ?? "", /abcdef123456/);
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
  assert.equal(isHealthStale(verdict.next, NOW + T.recheckMs - 1), false);
  assert.equal(isHealthStale(verdict.next, NOW + T.recheckMs), true);
  // Not news yet: one turn's error, which may not have been the lab's.
  assert.equal(healthTransition(state({ provider: "qwen" }), verdict.next), null, "a live verdict alone never alerts");
  assert.equal(healthTransition(undefined, verdict.next), null);
});

test("the probe that confirms a live verdict is the alert; the probe that clears it means it never was", () => {
  const live = liveFaultVerdict({
    provider: "qwen",
    previous: undefined,
    fault: { class: "billing", status: 402, raw: "Insufficient Balance" },
    recentCapacity: [],
    now: NOW,
    tunables: T,
  }).next!;
  const confirmed = nextHealthState("qwen", live, { ok: false, class: "billing", status: 402, raw: "Insufficient Balance" }, NOW + 900, T.recheckMs);
  assert.equal(confirmed.source, "probe");
  assert.equal(healthTransition(live, confirmed), "down", "confirmed: now it is news, and mailed for a default lab");
  // Once confirmed, the lab staying down is not news again.
  assert.equal(healthTransition(confirmed, nextHealthState("qwen", confirmed, { ok: false, class: "billing", status: 402, raw: "x" }, NOW + UNHEALTHY_TTL_MS + 1000)), null);

  // A tool's 401 that reached the turn's catch: the probe finds the lab fine.
  const misattributed = liveFaultVerdict({
    provider: "openai",
    previous: state({ provider: "openai" }),
    fault: { class: "auth", status: 401, raw: "Unauthorized: connector token expired" },
    recentCapacity: [],
    now: NOW,
    tunables: T,
  }).next!;
  const cleared = nextHealthState("openai", misattributed, { ok: true }, NOW + 500, T.recheckMs);
  assert.equal(cleared.healthy, true);
  assert.equal(healthTransition(misattributed, cleared), null, "never confirmed, so no down mail and no recovered line");
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

test("one server error is weather; repeated ones from several sources mark the lab down until the probe", () => {
  let recent: CapacityFault[] = [];
  let previous: ProviderHealthState | undefined = state({ provider: "google", healthy: true });
  for (let i = 0; i < T.capacityFaults - 1; i += 1) {
    const verdict = liveFaultVerdict({
      provider: "google",
      previous,
      fault: { class: "capacity", status: 503, raw: "overloaded" },
      origin: liveFaultOrigin(`user-${i}`, "google:gemini-3.5-flash"),
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
    origin: liveFaultOrigin("user-last", "google:gemini-3.5-flash"),
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
  assert.equal(healthTransition(previous, stillBad), "down", "the probe meeting the same trouble confirms the hold");
  const cleared = nextHealthState("google", previous, { ok: true }, NOW + 200_000, T.recheckMs);
  assert.equal(cleared.healthy, true);
  assert.equal(healthTransition(previous, cleared), null, "an unconfirmed hold the probe cleared was never news");
  // A confirmed hold that clears later is a recovery.
  const later = nextHealthState("google", stillBad, { ok: true }, NOW + 400_000, T.recheckMs);
  assert.equal(healthTransition(stillBad, later), "recovered");
});

test("server errors spread wider than the window never add up", () => {
  let recent: CapacityFault[] = [];
  for (let i = 0; i < 6; i += 1) {
    const verdict = liveFaultVerdict({
      provider: "google",
      previous: undefined,
      fault: { class: "capacity", status: 500, raw: "x" },
      origin: liveFaultOrigin(`user-${i}`, "google:gemini-3.5-flash"),
      recentCapacity: recent,
      now: NOW + i * (T.capacityWindowMs / 2 + 1),
      tunables: T,
    });
    assert.equal(verdict.next, null);
    recent = verdict.recentCapacity;
  }
});

test("one source meeting the same server error again and again never holds the lab down", () => {
  // One person pressing Try again on one model whose 500 is specific to
  // their input, or one Work run's retries and later steps.
  let recent: CapacityFault[] = [];
  const origin = liveFaultOrigin("user-1", "openai:gpt-6-luna");
  for (let i = 0; i < 10; i += 1) {
    const verdict = liveFaultVerdict({
      provider: "openai",
      previous: undefined,
      fault: { class: "capacity", status: 500, raw: "The server had an error processing your request." },
      origin,
      recentCapacity: recent,
      now: NOW + i * 1000,
      tunables: T,
    });
    assert.equal(verdict.next, null, `repeat ${i + 1} from one source`);
    recent = verdict.recentCapacity;
  }
  // The same person on other models of the lab is evidence about the lab.
  let tripped: ProviderHealthState | null = null;
  for (const model of ["openai:gpt-6", "openai:gpt-6-mini"]) {
    const verdict = liveFaultVerdict({
      provider: "openai",
      previous: undefined,
      fault: { class: "capacity", status: 500, raw: "x" },
      origin: liveFaultOrigin("user-1", model),
      recentCapacity: recent,
      now: NOW + 11_000,
      tunables: T,
    });
    recent = verdict.recentCapacity;
    tripped = verdict.next ?? tripped;
  }
  assert.equal(tripped?.healthy, false, "three distinct sources: the lab is held");
  assert.match(tripped?.detail ?? "", /from 3 live sources/);
  // An unattributed fault is one shared source, never one per call.
  let anonymous: CapacityFault[] = [];
  for (let i = 0; i < 5; i += 1) {
    const verdict = liveFaultVerdict({
      provider: "google",
      previous: undefined,
      fault: { class: "capacity", status: 503, raw: "x" },
      recentCapacity: anonymous,
      now: NOW + i,
      tunables: T,
    });
    assert.equal(verdict.next, null);
    anonymous = verdict.recentCapacity;
  }
});

test("a confirmed hold for server errors is released at the second probe in a row that gets no answer", () => {
  const held: ProviderHealthState = { ...state({ provider: "openai", healthy: false, failure: "capacity" }), source: "live", recheckAt: NOW + 1 };
  const confirmed = nextHealthState("openai", held, { ok: false, class: "capacity", status: 500, raw: "internal" }, NOW + 10, T.recheckMs);
  assert.equal(confirmed.source, "probe");
  const timeout: ProbeOutcome = { ok: false, class: "network", status: null, raw: "The operation was aborted" };
  const first = nextHealthState("openai", confirmed, timeout, NOW + 200_000, T.recheckMs);
  assert.equal(first.healthy, false, "held through one timeout");
  assert.equal(first.inconclusiveProbes, 1);
  const second = nextHealthState("openai", first, timeout, NOW + 400_000, T.recheckMs);
  assert.equal(second.healthy, true, "released at the second: unknown stays healthy");
  assert.equal(healthTransition(first, second), "recovered");
  // A server error in between confirms it again and restarts the count.
  const again = nextHealthState("openai", first, { ok: false, class: "capacity", status: 503, raw: "x" }, NOW + 400_000, T.recheckMs);
  assert.equal(again.healthy, false);
  assert.equal(again.inconclusiveProbes, 0);
  assert.equal(nextHealthState("openai", again, timeout, NOW + 600_000, T.recheckMs).healthy, false, "one timeout after a fresh confirmation is held");
});

// ---------------------------------------------------------------------------
// Operator mail for a default lab (outageMailDue / toldAfterMail)
// ---------------------------------------------------------------------------

test("a default lab's mail follows what the operator was last told, so the last mail stays true while it flaps", () => {
  const up = state({ provider: "qwen", healthy: true, source: "probe" });
  const live = { ...state({ provider: "qwen", healthy: false, failure: "capacity" as const }), source: "live" as const };
  const confirmed = { ...live, source: "probe" as const };
  const recovered = nextHealthState("qwen", confirmed, { ok: true }, NOW + 1);

  // Live and seeded verdicts are never mailed.
  assert.deepEqual(outageMailDue(undefined, up, live), { mail: null });
  assert.deepEqual(outageMailDue(undefined, undefined, seededState("qwen", { failures: 3, since: NOW - 60_000 }, NOW)), { mail: null });
  // The first confirmed outage is mailed under the hourly dedupe.
  assert.deepEqual(outageMailDue(undefined, live, confirmed), { mail: "down", bypassDedupe: false });
  // Told down: staying down, or a live verdict of another class laid over it, is not news.
  assert.deepEqual(outageMailDue("down", confirmed, confirmed), { mail: null });
  const billingLive = { ...confirmed, failure: "billing" as const, source: "live" as const };
  assert.deepEqual(outageMailDue("down", confirmed, billingLive), { mail: null });
  // ...and the probe that clears that live verdict owes the all-clear,
  // which `healthTransition` (live -> healthy) cannot see.
  assert.equal(healthTransition(billingLive, recovered), null);
  assert.deepEqual(outageMailDue("down", billingLive, recovered), { mail: "recovered" });
  // Told recovered: the next outage must reach the operator even inside the
  // hour, or "recovered" stays their last word while the lab is down.
  assert.deepEqual(outageMailDue("recovered", live, confirmed), { mail: "down", bypassDedupe: true });
  // Never told down: an all-clear is not news.
  assert.deepEqual(outageMailDue(undefined, confirmed, recovered), { mail: null });
  assert.deepEqual(outageMailDue("recovered", confirmed, recovered), { mail: null });
  // A probe that confirms a boot seed: the process before this one mailed it.
  const seeded = seededState("qwen", { failures: 3, since: NOW - 60_000 }, NOW);
  const seedConfirmed = nextHealthState("qwen", seeded, { ok: false, class: "billing", status: 402, raw: "x" }, NOW + 1);
  assert.deepEqual(outageMailDue(undefined, seeded, seedConfirmed), { mail: null, adopt: "down" });
});

test("what the operator was told after each mail attempt", () => {
  for (const outcome of ["queued", "deduped", "muted", undefined] as const) {
    assert.equal(toldAfterMail("down", outcome, undefined), "down", `down ${outcome}`);
  }
  assert.equal(toldAfterMail("recovered", "queued", "down"), "recovered");
  assert.equal(toldAfterMail("recovered", undefined, "down"), "recovered", "a stub that returns nothing reads as queued");
  assert.equal(toldAfterMail("recovered", "deduped", "down"), "down", "a dropped all-clear stays owed");
  assert.equal(toldAfterMail("recovered", "muted", "down"), undefined, "a muted all-clear owes nothing, and the next outage keeps the dedupe");
});

test("a flapping default lab mails at most one all-clear and two outages an hour, and the last mail is true", () => {
  // Drive the two pure rules with an hourly dedupe like alerts.ts's.
  const lastMailed = new Map<string, number>();
  const mailbox: string[] = [];
  const send = (kind: "down" | "recovered", at: number, bypass: boolean): "queued" | "deduped" => {
    const key = kind;
    const previous = lastMailed.get(key);
    if (!bypass && previous !== undefined && at - previous < 60 * 60_000) return "deduped";
    lastMailed.set(key, at);
    mailbox.push(kind);
    return "queued";
  };
  let told: "down" | "recovered" | undefined;
  let state_: ProviderHealthState = state({ provider: "qwen", healthy: true, source: "probe" });
  const step = (next: ProviderHealthState, at: number) => {
    const due = outageMailDue(told, state_, next);
    if (due.mail === "down") told = toldAfterMail("down", send("down", at, due.bypassDedupe), told);
    else if (due.mail === "recovered") told = toldAfterMail("recovered", send("recovered", at, false), told);
    state_ = next;
  };
  const down = (at: number): ProviderHealthState => ({ ...state({ provider: "qwen", healthy: false, failure: "capacity" }), source: "probe", checkedAt: at });
  const up = (at: number): ProviderHealthState => state({ provider: "qwen", healthy: true, source: "probe", checkedAt: at });
  // Six down/up cycles four minutes apart, ending down.
  let at = NOW;
  for (let cycle = 0; cycle < 6; cycle += 1) {
    step(down(at), at);
    at += 2 * 60_000;
    step(up(at), at);
    at += 2 * 60_000;
  }
  step(down(at), at);
  assert.deepEqual(mailbox, ["down", "recovered", "down"], "the lab flaps; the operator hears down, up, and down again");
  assert.equal(mailbox.at(-1), "down", "and the last mail is true: it is down");
  // An hour on, it settles: the owed all-clear goes out on the next healthy probe.
  at += 60 * 60_000;
  step(up(at), at);
  assert.equal(mailbox.at(-1), "recovered");
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
      recentCapacity: [
        { at: NOW - 1, origin: "a|m" },
        { at: NOW - 2, origin: "b|m" },
      ],
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
  assert.equal(healthTransition(live, timedOut), null, "still unconfirmed: not news");
  assert.equal(healthTransition(live, confirmed), "down", "the confirmation is the one alert");
});

test("an unconfirmed live verdict is released after one inconclusive recheck, not held for as long as probes stay inconclusive", () => {
  assert.equal(MAX_INCONCLUSIVE_LIVE_PROBES, 1);
  for (const failure of ["auth", "billing", "capacity"] as const) {
    const live: ProviderHealthState = { ...state({ provider: "qwen", healthy: false, failure }), source: "live", recheckAt: NOW + 1 };
    // Each inconclusive kind of probe: a timeout, a rate limit, and (for an
    // account fault) a server error, which says nothing about the account.
    const inconclusive: ProbeOutcome[] = [
      { ok: false, class: "network", status: null, raw: "The operation was aborted" },
      { ok: false, class: "rate_limit", status: 429, raw: "Too Many Requests" },
      ...(failure === "capacity" ? [] : [{ ok: false as const, class: "capacity" as const, status: 503, raw: "unavailable" }]),
    ];
    for (const outcome of inconclusive) {
      const first = nextHealthState("qwen", live, outcome, NOW + 10, T.recheckMs);
      assert.equal(first.healthy, false, `${failure}/${outcome.ok ? "ok" : outcome.class}: held through the first`);
      assert.equal(first.source, "live");
      assert.equal(first.inconclusiveProbes, 1);
      assert.equal(first.recheckAt, NOW + 10 + T.recheckMs);
      assert.equal(healthTransition(live, first), null, "no alert");

      const second = nextHealthState("qwen", first, outcome, NOW + 10 + T.recheckMs, T.recheckMs);
      assert.equal(second.healthy, true, `${failure}/${outcome.ok ? "ok" : outcome.class}: released at the second (unknown stays healthy)`);
      assert.equal(second.source, "probe");
      assert.equal(healthTransition(first, second), null, "never confirmed: no recovered line either");
    }
  }
});

test("a live hold for server errors is confirmed only by a probe that meets a server error itself", () => {
  const held: ProviderHealthState = { ...state({ provider: "qwen", healthy: false, failure: "capacity" }), source: "live", recheckAt: NOW + 1 };
  for (const outcome of [
    { ok: false, class: "network", status: null, raw: "The operation was aborted" },
    { ok: false, class: "rate_limit", status: 429, raw: "Too Many Requests" },
  ] as const) {
    const next = nextHealthState("qwen", held, outcome, NOW + 10, T.recheckMs);
    assert.equal(next.source, "live", `${outcome.class} is inconclusive`);
    assert.equal(healthTransition(held, next), null, `${outcome.class}: no down alert, and no critical mail for a default lab`);
  }
  const confirmed = nextHealthState("qwen", held, { ok: false, class: "capacity", status: 502, raw: "Bad Gateway" }, NOW + 10, T.recheckMs);
  assert.equal(confirmed.source, "probe");
  assert.equal(confirmed.healthy, false);
  assert.equal(healthTransition(held, confirmed), "down");

  // Once confirmed, it stays held while the lab still errors or does not
  // answer, and clears when the lab answers at all, even with a rate limit.
  const stillErroring = nextHealthState("qwen", confirmed, { ok: false, class: "capacity", status: 503, raw: "x" }, NOW + 200_000, T.recheckMs);
  assert.equal(stillErroring.healthy, false);
  const silent = nextHealthState("qwen", confirmed, { ok: false, class: "network", status: null, raw: "timeout" }, NOW + 200_000, T.recheckMs);
  assert.equal(silent.healthy, false);
  assert.equal(silent.recheckAt, NOW + 200_000 + T.recheckMs);
  const answering = nextHealthState("qwen", confirmed, { ok: false, class: "rate_limit", status: 429, raw: "slow down" }, NOW + 200_000, T.recheckMs);
  assert.equal(answering.healthy, true);
  assert.equal(healthTransition(confirmed, answering), "recovered");
});

test("a bare 403 from a live turn asks the probe and changes nothing by itself; an account-shaped one still marks the lab down", () => {
  // Shapes of a 403 that can concern one model rather than the account
  // (OpenAI organisation verification, DashScope's unpurchased-model code,
  // Google's gRPC status), and a 403 with no words at all.
  const oneModel = [
    { status: 403, error: { message: "Your organization must be verified to use the model `o3`. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization." } },
    { status: 403, error: { message: "Access denied.", code: "AccessDenied.Unpurchased" } },
    { status: 403, error: { message: "The caller does not have permission", status: "PERMISSION_DENIED" } },
    Object.assign(new Error("403 Forbidden"), { status: 403 }),
  ];
  for (const err of oneModel) {
    const fault = classifyProviderError(err);
    assert.equal(fault.class, "auth", "the chat classifier still calls every 403 auth (its copy is unchanged)");
    const verdict = liveFaultVerdict({ provider: "openai", previous: state({ provider: "openai" }), fault, recentCapacity: [], now: NOW, tunables: T });
    assert.equal(verdict.next, null, `${fault.raw.slice(0, 40)}: not marked down on one turn's 403`);
    assert.equal(verdict.probe, true, "the probe asks the lab's cheapest model and decides");
  }
  // Already down: nothing to ask.
  const down = state({ provider: "openai", healthy: false, failure: "billing", source: "probe" });
  assert.equal(
    liveFaultVerdict({ provider: "openai", previous: down, fault: classifyProviderError(oneModel[3]), recentCapacity: [], now: NOW, tunables: T }).probe,
    false,
  );

  // A 403 whose words name the key or the funding is the account.
  for (const err of [
    { status: 403, error: { message: "The team does not have any credits or licenses" } },
    { status: 403, error: { message: "Invalid API key provided" } },
  ]) {
    const fault = classifyProviderError(err);
    const verdict = liveFaultVerdict({ provider: "xai", previous: state({ provider: "xai" }), fault, recentCapacity: [], now: NOW, tunables: T });
    assert.equal(verdict.next?.healthy, false, `${fault.raw}: marked down at once`);
    assert.equal(verdict.next?.source, "live");
  }
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
