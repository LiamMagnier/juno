import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND_LEASE_MS, COMMAND_TTL_MS } from "@/lib/work/domain";
import {
  COMMAND_KIND_PROTOCOL,
  HOST_POLL_INTERVAL_MS,
  HOST_POLL_WINDOW_MS,
  RELAY_PROTOCOL_VERSION,
  WORK_RELAY_REFUSALS,
  advertisedCapabilityKeys,
  commandClaimability,
  commandExpiresAt,
  commandLeaseUntil,
  hostUnderstands,
  isClaimable,
  narrowHostToggles,
  negotiatedProtocolVersion,
  parseAdvertisement,
  planHostOutbox,
  pollDeadline,
  reconcilePolicy,
  reconcileToggles,
  refusalBody,
  refuseEnqueue,
  refuseHostPlane,
  shouldPollAgain,
  supportedCommandKinds,
  type ClaimableCommandView,
  type HostToggles,
} from "@/lib/work/relay";

/*
 * The relay is where a phone causes something to happen on somebody's Mac.
 * Everything that goes wrong there is a decision under a clock — a revocation
 * landing mid-poll, two Macs racing one command, a lease lapsing while the work
 * is still running, a build that cannot parse an instruction, a batch
 * re-delivered because the acknowledgement was lost. None of those are
 * reachable by driving a live relay on purpose, so they are pinned here.
 */

const AT = (iso: string) => new Date(iso);
const NOW = AT("2026-08-05T12:00:00.000Z");

const command = (over: Partial<ClaimableCommandView> = {}): ClaimableCommandView => ({
  kind: "stop",
  status: "pending",
  expiresAt: AT("2026-08-05T12:05:00.000Z"),
  leaseExpiresAt: null,
  ...over,
});

const toggles = (over: Partial<HostToggles> = {}): HostToggles => ({
  enabled: true,
  allowsFileWork: true,
  allowsBrowser: false,
  allowsComputerUse: false,
  allowsShell: false,
  allowsBackground: false,
  ...over,
});

// ---------------------------------------------------------------------------
// Lease and expiry arithmetic
// ---------------------------------------------------------------------------

test("a command's TTL and lease come from the domain constants, not the routes", () => {
  assert.equal(commandExpiresAt(NOW).getTime() - NOW.getTime(), COMMAND_TTL_MS);
  assert.equal(commandLeaseUntil(NOW).getTime() - NOW.getTime(), COMMAND_LEASE_MS);
  // The lease has to be shorter than the TTL. A lease outliving the command it
  // holds would keep a crashed host's claim alive past the point where the
  // command could be re-delivered at all, so it could never be retried once.
  assert.ok(COMMAND_LEASE_MS < COMMAND_TTL_MS);
});

test("the long poll answers before the interval would carry it past its deadline", () => {
  const deadline = pollDeadline(NOW);
  assert.equal(deadline.getTime() - NOW.getTime(), HOST_POLL_WINDOW_MS);

  const roomForOneMore = new Date(deadline.getTime() - HOST_POLL_INTERVAL_MS - 1);
  assert.equal(shouldPollAgain(deadline, roomForOneMore), true);

  // Exactly one interval left is NOT enough: sleeping it lands on the deadline
  // and the response then travels after it. A poll sized to fit under a proxy
  // timeout stops fitting the moment the loop is allowed to answer late.
  const exactlyOneInterval = new Date(deadline.getTime() - HOST_POLL_INTERVAL_MS);
  assert.equal(shouldPollAgain(deadline, exactlyOneInterval), false);
  assert.equal(shouldPollAgain(deadline, deadline), false);
});

// ---------------------------------------------------------------------------
// Claimability
// ---------------------------------------------------------------------------

test("a pending, unexpired command is claimable", () => {
  assert.equal(commandClaimability(command(), NOW, RELAY_PROTOCOL_VERSION), "claimable");
  assert.equal(isClaimable(command(), NOW, RELAY_PROTOCOL_VERSION), true);
});

test("an expired command is never handed out, whatever its status still says", () => {
  const stale = command({ expiresAt: AT("2026-08-05T11:59:59.999Z") });
  assert.equal(commandClaimability(stale, NOW, RELAY_PROTOCOL_VERSION), "expired");

  // The boundary is inclusive. A command expiring exactly now is one the user
  // may already have acted around: a "stop" issued five minutes ago, claimed by
  // a Mac that has just woken, stops the run they restarted in the meantime.
  const onTheBoundary = command({ expiresAt: NOW });
  assert.equal(commandClaimability(onTheBoundary, NOW, RELAY_PROTOCOL_VERSION), "expired");
});

test("a live lease blocks a second host, and an expired one releases it", () => {
  const held = command({
    status: "claimed",
    leaseExpiresAt: AT("2026-08-05T12:00:30.000Z"),
  });
  assert.equal(commandClaimability(held, NOW, RELAY_PROTOCOL_VERSION), "leased");

  // The host that held it crashed. Refusing to re-hand the command would strand
  // the session behind a lease nobody is ever going to release.
  const lapsed = command({
    status: "claimed",
    leaseExpiresAt: AT("2026-08-05T11:59:30.000Z"),
  });
  assert.equal(commandClaimability(lapsed, NOW, RELAY_PROTOCOL_VERSION), "claimable");
});

test("expiry beats a still-running lease", () => {
  // Both conditions hold. The command must read as expired, because re-leasing
  // it after its TTL would deliver an instruction the user has outlived.
  const both = command({
    status: "claimed",
    leaseExpiresAt: AT("2026-08-05T12:00:30.000Z"),
    expiresAt: AT("2026-08-05T11:59:00.000Z"),
  });
  assert.equal(commandClaimability(both, NOW, RELAY_PROTOCOL_VERSION), "expired");
});

test("a settled command is not re-delivered", () => {
  for (const status of ["succeeded", "failed", "expired", "cancelled"]) {
    assert.equal(
      commandClaimability(command({ status }), NOW, RELAY_PROTOCOL_VERSION),
      "settled",
      `${status} must not be claimable`
    );
  }
});

// ---------------------------------------------------------------------------
// Protocol version negotiation
// ---------------------------------------------------------------------------

test("every command kind declares the generation that can parse it", () => {
  for (const [kind, version] of Object.entries(COMMAND_KIND_PROTOCOL)) {
    assert.ok(version >= 1, `${kind} must name a real generation`);
    assert.ok(
      version <= RELAY_PROTOCOL_VERSION,
      `${kind} requires a generation this relay does not speak`
    );
  }
});

test("a first-generation host is offered the control plane and nothing else", () => {
  const kinds = supportedCommandKinds(1);
  assert.deepEqual(
    [...kinds].sort(),
    ["answer", "approve", "deny", "pause", "ping", "refresh_capabilities", "resume", "start", "stop"]
  );
  // The instructions whose payloads a v1 parser has no case for. Sending one
  // and hoping is what this table exists to prevent.
  assert.equal(hostUnderstands("undo", 1), false);
  assert.equal(hostUnderstands("grant_folder", 1), false);
  assert.equal(hostUnderstands("revoke_grant", 1), false);
});

test("a kind this relay has never heard of is understood by nobody", () => {
  assert.equal(hostUnderstands("format_disk", RELAY_PROTOCOL_VERSION), false);
  assert.equal(hostUnderstands("", 99), false);
});

test("a claimable command a host cannot parse is reported as unsupported, not claimable", () => {
  const undo = command({ kind: "undo" });
  assert.equal(commandClaimability(undo, NOW, 1), "unsupported");
  assert.equal(commandClaimability(undo, NOW, 2), "claimable");
});

test("a rolled-back host narrows itself, and cannot widen past its registration", () => {
  // The row still records the generation the newer build registered with; the
  // binary that replaced it cannot parse half of it. Routing on the stored
  // number re-leases the same unreadable command until it expires.
  assert.equal(negotiatedProtocolVersion(2, 1), 1);
  // The other direction is refused: the registration is the claim the account's
  // owner can actually see, so a poll cannot quietly exceed it.
  assert.equal(negotiatedProtocolVersion(1, 2), 1);
  assert.equal(negotiatedProtocolVersion(2, null), 2);
  assert.equal(negotiatedProtocolVersion(2, undefined), 2);
  // Nonsense from the wire falls back to the registered generation rather than
  // to zero, which would make every kind unsupported and idle the host forever.
  assert.equal(negotiatedProtocolVersion(2, 0), 2);
  assert.equal(negotiatedProtocolVersion(2, Number.NaN), 2);
  assert.equal(negotiatedProtocolVersion(0, 2), 1);
});

// ---------------------------------------------------------------------------
// Refusal classification
// ---------------------------------------------------------------------------

test("a revoked host is refused non-retryably, so its loop stops instead of backing off", () => {
  const refusal = refuseHostPlane({ enabled: true, revokedAt: AT("2026-08-05T11:00:00.000Z") });
  assert.equal(refusal?.code, "work_host_revoked");
  assert.equal(refusal?.retryable, false);
  assert.equal(refusal?.status, 403);
  // `WorkRemoteHost.run` moves to `.stopped` only on a non-retryable error. A
  // retryable revocation is a decommissioned Mac polling forever.
  assert.equal(refusal?.audit, "host_revoked");
  assert.equal(refusal?.severity, "refusal");
});

test("revocation outranks enablement, so a revoked host is never told it is merely off", () => {
  const refusal = refuseHostPlane({ enabled: false, revokedAt: AT("2026-08-05T11:00:00.000Z") });
  assert.equal(refusal?.code, "work_host_revoked");
});

test("a disabled host is refused claims but may still acknowledge what it holds", () => {
  const gate = { enabled: false, revokedAt: null };
  assert.equal(refuseHostPlane(gate)?.code, "work_host_not_enabled");
  // Switching Work off must not strand an in-flight instruction with no
  // outcome; that presents to the user as a task that is stopping forever.
  assert.equal(refuseHostPlane(gate, { allowDisabled: true }), null);
  // Revocation is a security action and is refused even here.
  assert.equal(
    refuseHostPlane({ enabled: false, revokedAt: NOW }, { allowDisabled: true })?.code,
    "work_host_revoked"
  );
});

test("an enabled, unrevoked host passes the gate", () => {
  assert.equal(refuseHostPlane({ enabled: true, revokedAt: null }), null);
});

test("enqueue refuses a kind the target Mac cannot parse, rather than queueing it", () => {
  const host = { enabled: true, revokedAt: null };
  assert.equal(refuseEnqueue(host, "stop", 1), null);
  const refusal = refuseEnqueue(host, "undo", 1);
  assert.equal(refusal?.code, "work_host_unknown_command");
  assert.equal(refusal?.retryable, false);
  assert.equal(refusal?.audit, "command_refused");
  // Host state is checked before capability: a revoked Mac is revoked whatever
  // was asked of it, and answering "unknown instruction" would be a lie that
  // sends the client looking for an app update.
  assert.equal(refuseEnqueue({ enabled: true, revokedAt: NOW }, "undo", 1)?.code, "work_host_revoked");
});

test("every refusal is retried by nobody and files an audit row", () => {
  for (const refusal of Object.values(WORK_RELAY_REFUSALS)) {
    assert.equal(refusal.retryable, false, `${refusal.code} must not invite a retry`);
    assert.ok(refusal.message.length > 0, `${refusal.code} must say something to a person`);
    assert.ok(
      refusal.audit === "command_refused" || refusal.audit === "host_revoked",
      `${refusal.code} must file under a kind the audit log knows`
    );
  }
});

test("the refusal body is the shape the native client decodes", () => {
  // `NativeWorkClient.workError` reads code/message/retryable from a NESTED
  // `error` object. A flat `{ error: "..." }` comes back as an unclassified
  // server error and is retried, which is exactly what a revocation must not be.
  const body = refusalBody(WORK_RELAY_REFUSALS.revoked);
  assert.equal(body.error.code, "work_host_revoked");
  assert.equal(body.error.retryable, false);
  assert.equal(typeof body.error.message, "string");
});

// ---------------------------------------------------------------------------
// Capability advertisement
// ---------------------------------------------------------------------------

test("a capability is never inferred from a toggle the host set", () => {
  // The host has file work switched on but advertised no capability keys. The
  // relay must not conclude `local_files`: routing file work to a Mac whose
  // build has no file tool queues it at a machine that refuses every command.
  assert.deepEqual(advertisedCapabilityKeys({ capabilities: [], toggles: toggles() }), []);
  assert.deepEqual(advertisedCapabilityKeys({}), []);
  assert.deepEqual(advertisedCapabilityKeys(null), []);
  assert.deepEqual(advertisedCapabilityKeys("local_files"), []);
});

test("advertised keys are taken verbatim, minus names this build cannot route on", () => {
  assert.deepEqual(
    advertisedCapabilityKeys(["local_files", "local_browser", "quantum_tunnelling"]),
    ["local_files", "local_browser"]
  );
  // Order is the host's, and a repeat does not double the entry.
  assert.deepEqual(
    advertisedCapabilityKeys({ capabilities: ["local_shell", "local_files", "local_shell"] }),
    ["local_shell", "local_files"]
  );
});

test("an unreadable stored advertisement reads as the strictest policy, not the loosest", () => {
  const parsed = parseAdvertisement({ toggles: {}, capabilities: ["local_files"] });
  // `narrowestPolicy()` over nothing returns `permissive`, which is right for a
  // meet and catastrophic here: a truncated manifest would widen what the Mac
  // may do without anybody being asked.
  assert.equal(parsed?.approvalPolicy, "conservative");
  assert.deepEqual(parsed?.toggles, {
    enabled: false,
    allowsFileWork: false,
    allowsBrowser: false,
    allowsComputerUse: false,
    allowsShell: false,
    allowsBackground: false,
  });
  assert.equal(parseAdvertisement(null), null);
  assert.equal(parseAdvertisement([]), null);
  assert.equal(parseAdvertisement({ capabilities: [] }), null);
});

test("a stored advertisement round-trips its toggles and policy", () => {
  const parsed = parseAdvertisement({
    toggles: toggles({ allowsShell: true }),
    capabilities: ["local_files", "local_shell"],
    approvalPolicy: "balanced",
  });
  assert.equal(parsed?.approvalPolicy, "balanced");
  assert.equal(parsed?.toggles.allowsShell, true);
  assert.deepEqual(parsed?.capabilities, ["local_files", "local_shell"]);
});

// ---------------------------------------------------------------------------
// Owner narrowing versus host advertisement
// ---------------------------------------------------------------------------

test("a heartbeat does not undo a switch the owner turned off", () => {
  // The Mac still claims file work; the owner switched it off from their phone.
  // Without the previous advertisement to compare against, the next heartbeat —
  // under a minute away — flips it back on and the user watches the switch move
  // by itself.
  const next = reconcileToggles(
    { advertised: toggles({ allowsFileWork: true }), effective: toggles({ allowsFileWork: false }) },
    toggles({ allowsFileWork: true })
  );
  assert.equal(next.allowsFileWork, false);
});

test("a capability the Mac has newly switched on does come back", () => {
  // Off last time because the Mac did not offer it, not because anybody refused
  // it. The owner's narrowing is the only thing that survives a heartbeat.
  const next = reconcileToggles(
    { advertised: toggles({ allowsShell: false }), effective: toggles({ allowsShell: false }) },
    toggles({ allowsShell: true })
  );
  assert.equal(next.allowsShell, true);
});

test("a capability the Mac withdrew goes off however it was set before", () => {
  const next = reconcileToggles(
    { advertised: toggles({ allowsFileWork: true }), effective: toggles({ allowsFileWork: true }) },
    toggles({ allowsFileWork: false })
  );
  assert.equal(next.allowsFileWork, false);
});

test("first registration writes the host's claim as it stands", () => {
  const advertised = toggles({ allowsBrowser: true });
  assert.deepEqual(reconcileToggles(null, advertised), advertised);
});

test("an owner-chosen stricter policy survives a heartbeat; the host's own does not stick", () => {
  // The owner narrowed to conservative while the Mac asked for permissive.
  assert.equal(
    reconcilePolicy({ advertised: "permissive", effective: "conservative" }, "permissive"),
    "conservative"
  );
  // Nobody narrowed anything, so the Mac relaxing its own default takes effect.
  // Taking the meet unconditionally would hold it down at last time's value
  // forever, which is the bug this branch exists to avoid.
  assert.equal(reconcilePolicy({ advertised: "conservative", effective: "conservative" }, "permissive"), "permissive");
  assert.equal(reconcilePolicy(null, "permissive"), "permissive");
  // The owner's choice is still a ceiling, not a floor: a Mac that tightens
  // below what the owner picked is followed down.
  assert.equal(reconcilePolicy({ advertised: "permissive", effective: "balanced" }, "conservative"), "conservative");
});

test("a phone may switch a capability off from anywhere, immediately", () => {
  const outcome = narrowHostToggles(
    toggles({ allowsFileWork: true }),
    toggles({ allowsFileWork: true }),
    { allowsFileWork: false }
  );
  assert.equal(outcome.applied.allowsFileWork, false);
  assert.deepEqual(outcome.refused, []);
});

test("a phone may not switch on a capability the Mac never offered", () => {
  // The escalation boundary of the whole relay: a stolen web session must not
  // be able to grant shell access to a machine whose owner never offered it.
  const outcome = narrowHostToggles(
    toggles({ allowsShell: false }),
    toggles({ allowsShell: false }),
    { allowsShell: true, allowsComputerUse: true }
  );
  assert.equal(outcome.applied.allowsShell, false);
  assert.equal(outcome.applied.allowsComputerUse, false);
  assert.deepEqual([...outcome.refused].sort(), ["allowsComputerUse", "allowsShell"]);
});

test("a phone may switch back on what the Mac still advertises", () => {
  const outcome = narrowHostToggles(
    toggles({ allowsFileWork: true }),
    toggles({ allowsFileWork: false }),
    { allowsFileWork: true }
  );
  assert.equal(outcome.applied.allowsFileWork, true);
  assert.deepEqual(outcome.refused, []);
});

test("an omitted toggle is left exactly as it was", () => {
  // PATCH is a partial update, and the difference is load-bearing: a body that
  // filled in every field would switch Work off for the whole Mac every time
  // somebody changed the browser toggle.
  const outcome = narrowHostToggles(toggles(), toggles({ allowsBrowser: true }), {});
  assert.deepEqual(outcome.applied, toggles({ allowsBrowser: true }));
  assert.deepEqual(outcome.refused, []);
});

// ---------------------------------------------------------------------------
// The host outbox
// ---------------------------------------------------------------------------

const outboxEvent = (seq: number, eventKey?: string | null) => ({
  seq,
  kind: "progress",
  eventKey: eventKey === undefined ? `run-1:${seq}` : eventKey,
});

test("a complete batch is accepted in order and moves the mark", () => {
  const plan = planHostOutbox({
    acknowledgedSeq: 0,
    // Hosts batch out of order; the relay orders before it decides.
    events: [outboxEvent(3), outboxEvent(1), outboxEvent(2)],
  });
  assert.deepEqual(plan.accepted.map((event) => event.seq), [1, 2, 3]);
  assert.equal(plan.acceptedThrough, 3);
  assert.equal(plan.firstGap, null);
  assert.deepEqual(plan.duplicates, []);
});

test("a re-delivered batch is dropped by key, not by cursor", () => {
  // The POST committed and the response was lost, so the host sends it again.
  // Dropping by key rather than by "sequence above the cursor" is what makes a
  // legitimate lower-sequence re-delivery distinguishable from a duplicate.
  const plan = planHostOutbox({
    acknowledgedSeq: 3,
    events: [outboxEvent(1), outboxEvent(2), outboxEvent(3)],
    seenKeys: new Set(["run-1:1", "run-1:2", "run-1:3"]),
  });
  assert.deepEqual(plan.accepted, []);
  assert.equal(plan.duplicates.length, 3);
  assert.equal(plan.acceptedThrough, 3);
  assert.equal(plan.firstGap, null);
});

test("events at or below the mark are re-deliveries even with no key to match", () => {
  const plan = planHostOutbox({
    acknowledgedSeq: 2,
    events: [outboxEvent(1, null), outboxEvent(2, null), outboxEvent(3, null)],
  });
  assert.deepEqual(plan.accepted.map((event) => event.seq), [3]);
  assert.deepEqual(plan.duplicates.map((event) => event.seq), [1, 2]);
  assert.equal(plan.acceptedThrough, 3);
});

test("a hole truncates the batch and names the missing sequence", () => {
  // Rejecting the whole batch — the Code relay's rule — throws away everything
  // that did arrive and asks for it again, and the re-send has the same hole in
  // it. Naming the gap is the only request that can make progress.
  const plan = planHostOutbox({
    acknowledgedSeq: 0,
    events: [outboxEvent(1), outboxEvent(2), outboxEvent(4), outboxEvent(5)],
  });
  assert.deepEqual(plan.accepted.map((event) => event.seq), [1, 2]);
  assert.equal(plan.firstGap, 3);
  assert.equal(plan.acceptedThrough, 2);
});

test("a gap at the very front of a batch accepts nothing", () => {
  const plan = planHostOutbox({ acknowledgedSeq: 10, events: [outboxEvent(12), outboxEvent(13)] });
  assert.deepEqual(plan.accepted, []);
  assert.equal(plan.firstGap, 11);
  assert.equal(plan.acceptedThrough, 10);
});

test("two events claiming the same slot do not both consume a sequence", () => {
  const plan = planHostOutbox({
    acknowledgedSeq: 0,
    events: [outboxEvent(1, "a"), outboxEvent(1, "b"), outboxEvent(2, "c")],
  });
  assert.deepEqual(plan.accepted.map((event) => event.eventKey), ["a", "c"]);
  assert.deepEqual(plan.duplicates.map((event) => event.eventKey), ["b"]);
  assert.equal(plan.acceptedThrough, 2);
  assert.equal(plan.firstGap, null);
});

test("a key repeated inside one batch is accepted once", () => {
  const plan = planHostOutbox({
    acknowledgedSeq: 0,
    events: [outboxEvent(1, "same"), outboxEvent(2, "same")],
  });
  assert.deepEqual(plan.accepted.map((event) => event.seq), [1]);
  assert.deepEqual(plan.duplicates.map((event) => event.seq), [2]);
  // The duplicate did not consume sequence 2, so the host is told the relay is
  // still waiting for it rather than being handed a hole it cannot see.
  assert.equal(plan.acceptedThrough, 1);
});

test("an empty batch is a no-op that does not move the mark", () => {
  const plan = planHostOutbox({ acknowledgedSeq: 7, events: [] });
  assert.deepEqual(plan.accepted, []);
  assert.equal(plan.acceptedThrough, 7);
  assert.equal(plan.firstGap, null);
});

test("a partially-acknowledged retry resumes exactly where the relay stopped", () => {
  // The relay accepted 1 and 2 and reported the gap at 3; the host re-sends
  // from 3 and includes the two it already had answered for.
  const plan = planHostOutbox({
    acknowledgedSeq: 2,
    events: [outboxEvent(1), outboxEvent(2), outboxEvent(3), outboxEvent(4)],
    seenKeys: new Set(["run-1:1", "run-1:2"]),
  });
  assert.deepEqual(plan.accepted.map((event) => event.seq), [3, 4]);
  assert.deepEqual(plan.duplicates.map((event) => event.seq), [1, 2]);
  assert.equal(plan.acceptedThrough, 4);
  assert.equal(plan.firstGap, null);
});
