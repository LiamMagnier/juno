import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_DECISION_REFUSALS,
  CLIENT_APPROVAL_DECISIONS,
  CLIENT_RUN_ORIGINS,
  SESSION_LIST_DEFAULT_LIMIT,
  SESSION_LIST_MAX_LIMIT,
  answerSchema,
  approvalDecisionSchema,
  classifyApprovalDecision,
  createSessionSchema,
  effectiveHostState,
  parseSessionListQuery,
  patchSessionSchema,
  refusalForSelection,
  runControlSchema,
  startRunSchema,
  type ApprovalDecisionInput,
} from "@/app/api/work/protocol";
import { actionDigest, policyDigest } from "@/lib/work/digests";
import {
  HOST_OFFLINE_AFTER_MS,
  HOST_STALE_AFTER_MS,
  selectTarget,
  type HostCapabilityView,
} from "@/lib/work/domain";

/*
 * The Work HTTP surface, minus the database.
 *
 * Every case here is one where the wrong answer is invisible from the outside.
 * A run queued against a Mac that is asleep looks exactly like a run about to
 * start. An approval spent on an action nobody was shown looks exactly like an
 * approval. A filter that quietly dropped the parameter it could not parse
 * returns a plausible list of the wrong sessions. So these tests are written
 * against the awkward inputs — the expired card answered twice, the offline
 * host, the limit of one hundred thousand — rather than the path that already
 * works.
 *
 * Nothing in this file opens a connection. The point of `protocol.ts` being
 * free of Prisma is that these checks run on every commit rather than once, by
 * hand, on the day they were written.
 */

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

test("createSessionSchema requires a goal and an explicit target", () => {
  const ok = createSessionSchema.safeParse({ goal: "  Tidy the Q3 folder  ", requestedTarget: "local" });
  assert.equal(ok.success, true);
  assert.equal(ok.data?.goal, "Tidy the Q3 folder");

  // A target is not defaulted: `automatic` is what lets work move off the
  // user's Mac, and inheriting that from a schema default means nobody chose it.
  assert.equal(createSessionSchema.safeParse({ goal: "Do a thing" }).success, false);
  assert.equal(createSessionSchema.safeParse({ goal: "   ", requestedTarget: "cloud" }).success, false);
  assert.equal(
    createSessionSchema.safeParse({ goal: "Do a thing", requestedTarget: "quantum" }).success,
    false
  );
});

test("createSessionSchema rejects an idempotency key too short to be unique", () => {
  // Eight characters is the same floor /api/code/tasks uses. A three-character
  // key from a client that generates them badly collides across requests, and a
  // collision on an idempotency key returns somebody else's earlier session.
  assert.equal(
    createSessionSchema.safeParse({ goal: "g", requestedTarget: "cloud", idempotencyKey: "abc" }).success,
    false
  );
  assert.equal(
    createSessionSchema.safeParse({ goal: "g", requestedTarget: "cloud", idempotencyKey: "abcdefgh" })
      .success,
    true
  );
});

test("patchSessionSchema refuses a patch that changes nothing", () => {
  assert.equal(patchSessionSchema.safeParse({ pinned: true }).success, true);
  assert.equal(patchSessionSchema.safeParse({}).success, false);
  // Unknown keys are stripped before the refine sees them, so a client that
  // sends `{ name }` instead of `{ title }` is told, rather than getting a 200
  // and a session that was never renamed.
  assert.equal(patchSessionSchema.safeParse({ name: "Renamed" }).success, false);
});

test("startRunSchema will not let a client claim a scheduled origin", () => {
  assert.deepEqual([...CLIENT_RUN_ORIGINS], ["manual", "retry", "resume", "fork"]);
  assert.equal(startRunSchema.safeParse({ origin: "retry" }).success, true);
  // `schedule` and `trigger` mean "nobody was there", which decides what an
  // unattended policy allows the run to do. A browser choosing that label would
  // be choosing the rules it is judged by.
  assert.equal(startRunSchema.safeParse({ origin: "schedule" }).success, false);
  assert.equal(startRunSchema.safeParse({ origin: "trigger" }).success, false);
});

test("startRunSchema only accepts capabilities the vocabulary owns", () => {
  const ok = startRunSchema.safeParse({ requiredCapabilities: ["local_files", "web_research"] });
  assert.equal(ok.success, true);
  assert.equal(startRunSchema.safeParse({ requiredCapabilities: ["read_the_users_mind"] }).success, false);
  // An empty body is a complete request: nothing local required, which the
  // target selector resolves to the cloud.
  assert.equal(startRunSchema.safeParse({}).success, true);
});

test("runControlSchema and answerSchema bound what a client may send", () => {
  assert.equal(runControlSchema.safeParse({ action: "pause" }).success, true);
  assert.equal(runControlSchema.safeParse({ action: "delete" }).success, false);

  assert.equal(answerSchema.safeParse({ questionId: "q1", text: "Yes, the second one." }).success, true);
  // Without the question id a late answer is applied to whatever the run is
  // asking now.
  assert.equal(answerSchema.safeParse({ text: "Yes" }).success, false);
  assert.equal(answerSchema.safeParse({ questionId: "q1", text: "   " }).success, false);
});

test("approvalDecisionSchema accepts only answers a person can give", () => {
  const digest = actionDigest("work.file.move", { count: 2 });
  for (const decision of CLIENT_APPROVAL_DECISIONS) {
    assert.equal(approvalDecisionSchema.safeParse({ decision, actionDigest: digest }).success, true);
  }
  // `expired` and `superseded` are the server's words about the passage of time
  // and about newer requests. A client able to submit them could make its own
  // refusal look like a timeout in the audit log.
  assert.equal(approvalDecisionSchema.safeParse({ decision: "expired", actionDigest: digest }).success, false);
  assert.equal(approvalDecisionSchema.safeParse({ decision: "pending", actionDigest: digest }).success, false);
  // A malformed digest is a 400 about the request, never a 409 about a replay.
  assert.equal(approvalDecisionSchema.safeParse({ decision: "allowed", actionDigest: "nope" }).success, false);
  assert.equal(
    approvalDecisionSchema.safeParse({ decision: "allowed", actionDigest: digest.toUpperCase() }).success,
    false
  );
});

// ---------------------------------------------------------------------------
// Session list filters
// ---------------------------------------------------------------------------

function query(search: string) {
  return parseSessionListQuery(new URLSearchParams(search));
}

test("the session list limit is clamped in both directions", () => {
  const absent = query("");
  assert.equal(absent.ok && absent.query.limit, SESSION_LIST_DEFAULT_LIMIT);

  // The clamp is what stops one misplaced zero in a client's pagination from
  // turning a list view into a full-table read.
  const huge = query("limit=100000");
  assert.equal(huge.ok && huge.query.limit, SESSION_LIST_MAX_LIMIT);

  const zero = query("limit=0");
  assert.equal(zero.ok && zero.query.limit, 1);

  const negative = query("limit=-5");
  assert.equal(negative.ok && negative.query.limit, 1);

  const fractional = query("limit=7.9");
  assert.equal(fractional.ok && fractional.query.limit, 7);

  // Unparseable falls back rather than 400ing, which is the repo's query-param
  // idiom: a bad `limit` is a client bug that should still return a page.
  const rubbish = query("limit=abc");
  assert.equal(rubbish.ok && rubbish.query.limit, SESSION_LIST_DEFAULT_LIMIT);
});

test("the session list hides archived and soft-deleted work by default", () => {
  const plain = query("");
  assert.equal(plain.ok && plain.query.archived, false);
  assert.equal(plain.ok && plain.query.status, undefined);
  assert.equal(plain.ok && plain.query.needsAttention, undefined);

  const archive = query("archived=true");
  assert.equal(archive.ok && archive.query.archived, true);
});

test("an unreadable filter is refused by name rather than dropped", () => {
  // Silently ignoring a filter it could not parse returns a plausible list of
  // the wrong sessions, and nothing in the response says the filter was lost.
  const status = query("status=nearly_done");
  assert.equal(status.ok, false);
  assert.equal(status.ok === false && status.parameter, "status");

  const attention = query("needsAttention=maybe");
  assert.equal(attention.ok === false && attention.parameter, "needsAttention");

  const project = query("projectId=");
  assert.equal(project.ok === false && project.parameter, "projectId");

  const good = query("status=waiting_approval&needsAttention=1&pinned=false&projectId=p_1");
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.query.status, "waiting_approval");
  assert.equal(good.ok && good.query.needsAttention, true);
  assert.equal(good.ok && good.query.pinned, false);
  assert.equal(good.ok && good.query.projectId, "p_1");
});

// ---------------------------------------------------------------------------
// Host state
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-05T12:00:00.000Z");

function host(overrides: Partial<{ state: string; lastSeenAt: Date; activeRunCount: number }> = {}) {
  return {
    state: "online",
    lastSeenAt: NOW,
    activeRunCount: 1,
    ...overrides,
  };
}

test("a host that stopped heartbeating is not online, whatever its row says", () => {
  // The concrete failure: a Mac closed at lunchtime leaves `online` in its
  // column until something updates it, and `online` is exactly what makes the
  // target selector hand it a run nobody will ever claim.
  assert.equal(
    effectiveHostState(host({ lastSeenAt: new Date(NOW.getTime() - HOST_OFFLINE_AFTER_MS - 1) }), NOW),
    "offline"
  );
  assert.equal(
    effectiveHostState(host({ lastSeenAt: new Date(NOW.getTime() - HOST_STALE_AFTER_MS - 1) }), NOW),
    "stale"
  );
});

test("a heartbeating host keeps the state it advertised", () => {
  assert.equal(effectiveHostState(host(), NOW), "online");
  // Including when what it advertised is worse than the heartbeat implies: the
  // host knows it is declining work and the backend must not talk it up.
  assert.equal(effectiveHostState(host({ state: "offline" }), NOW), "offline");
  assert.equal(effectiveHostState(host({ state: "stale" }), NOW), "stale");
  // A value this build cannot read resolves to offline. Being wrong that way
  // costs a user who waits; the other way queues work at a machine that will
  // never claim it.
  assert.equal(effectiveHostState(host({ state: "warming_up" }), NOW), "offline");
});

// ---------------------------------------------------------------------------
// Run admission
// ---------------------------------------------------------------------------

function macbook(overrides: Partial<HostCapabilityView> = {}): HostCapabilityView {
  return {
    hostId: "host_1",
    displayName: "Liam's MacBook",
    state: "idle",
    enabled: true,
    revoked: false,
    capabilities: ["local_files", "local_shell"],
    ...overrides,
  };
}

test("a run that only a sleeping Mac could do is refused, never queued", () => {
  const selection = selectTarget({
    requested: "local",
    required: ["local_files"],
    hosts: [macbook({ state: "offline" })],
    cloudAvailable: true,
  });
  const refusal = refusalForSelection(selection);

  assert.ok(refusal, "a null target must produce a refusal");
  assert.equal(refusal.error, "no_executor_available");
  // Verbatim: the selector's sentence already names the Mac and its state, and
  // this 409 is the only moment anything in the system can tell the user that
  // nothing is going to happen.
  assert.equal(refusal.message, selection.explanation);
  assert.match(refusal.message, /Liam's MacBook is offline\./);
  assert.deepEqual(refusal.missing, ["local_files"]);
});

test("cloud work that will do less than was asked still runs", () => {
  const selection = selectTarget({
    requested: "automatic",
    required: ["local_files", "web_research"],
    hosts: [macbook({ state: "offline" })],
    cloudAvailable: true,
  });

  // The refusal is for "nothing can run this", not for "this will be degraded".
  // Turning a degraded cloud run into a 409 would refuse work the user could
  // have had; hiding the degradation would let them find out from the summary.
  assert.equal(selection.target, "cloud");
  assert.equal(refusalForSelection(selection), null);
  assert.ok(selection.degradation.some((entry) => entry.kind === "local_portion_skipped"));
});

test("a capable, awake Mac is not refused", () => {
  const selection = selectTarget({
    requested: "local",
    required: ["local_files"],
    hosts: [macbook()],
    cloudAvailable: true,
  });
  assert.equal(selection.target, "local");
  assert.equal(selection.hostId, "host_1");
  assert.equal(refusalForSelection(selection), null);
});

test("cloud work is refused when the cloud is not accepting it", () => {
  const selection = selectTarget({
    requested: "cloud",
    required: ["web_research"],
    hosts: [],
    cloudAvailable: false,
  });
  const refusal = refusalForSelection(selection);
  assert.ok(refusal);
  assert.equal(refusal.message, selection.explanation);
});

// ---------------------------------------------------------------------------
// Approval decisions
// ---------------------------------------------------------------------------

const ACTION = "work.file.batch_move";
/** On `ALWAYS_CONFIRM_ACTIONS`: the card no standing allowance may ever cover. */
const SEND = "work.connector.send_message";
const DETAIL = { from: "Downloads", to: "Archive", count: 14 };
const POLICY = { policy: "balanced", session: "balanced", host: "conservative" };
const EXPIRES = new Date(NOW.getTime() + 60_000);

function decisionInput(overrides: Partial<ApprovalDecisionInput> = {}): ApprovalDecisionInput {
  return {
    submittedDecision: "allowed",
    submittedDigest: actionDigest(ACTION, DETAIL),
    approval: {
      action: ACTION,
      detail: DETAIL,
      // A batch move: reversible, off the always-confirm list, and therefore the
      // one shape of card a standing "always allow" may legitimately cover.
      risk: "edit",
      actionDigest: actionDigest(ACTION, DETAIL),
      policyDigest: policyDigest(POLICY),
      decision: "pending",
      expiresAt: EXPIRES,
      ...overrides.approval,
    },
    policy: POLICY,
    now: NOW,
    ...overrides,
  };
}

test("an answer to the card that was shown is recorded", () => {
  assert.deepEqual(classifyApprovalDecision(decisionInput()), { outcome: "record", decision: "allowed" });
  assert.deepEqual(classifyApprovalDecision(decisionInput({ submittedDecision: "denied" })), {
    outcome: "record",
    decision: "denied",
  });
  assert.deepEqual(classifyApprovalDecision(decisionInput({ submittedDecision: "allowed_always" })), {
    outcome: "record",
    decision: "allowed_always",
  });
});

test("\"always allow\" is refused for a send, and the plain yes on the same card is not", () => {
  // The one answer that authorises actions the user has not seen yet. A UI that
  // offers the button on a send is a UI bug; a server that records it is a
  // standing permission to send every future message, which is the exact thing
  // `ALWAYS_CONFIRM_ACTIONS` exists to make impossible. The card still works —
  // this refuses the standing half of the answer, not the answer.
  const always = classifyApprovalDecision(
    decisionInput({
      submittedDecision: "allowed_always",
      submittedDigest: actionDigest(SEND, DETAIL),
      approval: {
        ...decisionInput().approval,
        action: SEND,
        risk: "irreversible",
        actionDigest: actionDigest(SEND, DETAIL),
      },
    })
  );
  assert.deepEqual(always, { outcome: "refuse", reason: "not_standing_allowable" });

  const once = classifyApprovalDecision(
    decisionInput({
      submittedDigest: actionDigest(SEND, DETAIL),
      approval: {
        ...decisionInput().approval,
        action: SEND,
        risk: "irreversible",
        actionDigest: actionDigest(SEND, DETAIL),
      },
    })
  );
  assert.deepEqual(once, { outcome: "record", decision: "allowed" });
});

test("\"always allow\" is refused on risk alone, even for an action nobody listed", () => {
  // The action allowlist is not the only ceiling, because it cannot be: a tool
  // added next quarter that touches somebody's inbox will not be on it. A
  // `sensitive` grade is enough on its own.
  const outcome = classifyApprovalDecision(
    decisionInput({
      submittedDecision: "allowed_always",
      approval: { ...decisionInput().approval, risk: "sensitive" },
    })
  );
  assert.deepEqual(outcome, { outcome: "refuse", reason: "not_standing_allowable" });
});

test("an answer carrying another action's digest is refused as a mismatch", () => {
  // The substitution case the digest exists for: the user is shown a move and
  // the client answers with the digest of the delete it was refused a moment
  // earlier.
  const outcome = classifyApprovalDecision(
    decisionInput({ submittedDigest: actionDigest("work.file.permanent_delete", DETAIL) })
  );
  assert.deepEqual(outcome, { outcome: "refuse", reason: "digest_mismatch" });
});

test("the mismatch is reported ahead of expiry and ahead of a second answer", () => {
  // Order matters because the reason is what an investigator gets. Filing a
  // substitution attempt as a timeout buries the more serious finding.
  const stale = classifyApprovalDecision(
    decisionInput({
      submittedDigest: actionDigest("work.connector.send_message", DETAIL),
      now: new Date(EXPIRES.getTime() + 1),
      approval: { ...decisionInput().approval, decision: "denied" },
    })
  );
  assert.deepEqual(stale, { outcome: "refuse", reason: "digest_mismatch" });
});

test("a stored row whose digest does not describe its own action is refused", () => {
  // The row itself is inconsistent — the action or the detail changed after the
  // user was asked — so `verifyApproval` refuses even though the client sent
  // exactly what the row says.
  const tampered = actionDigest(ACTION, { ...DETAIL, count: 900 });
  const outcome = classifyApprovalDecision(
    decisionInput({
      submittedDigest: tampered,
      approval: { ...decisionInput().approval, actionDigest: tampered },
    })
  );
  assert.deepEqual(outcome, { outcome: "refuse", reason: "digest_mismatch" });
});

test("an approval granted under a policy that has since narrowed is re-asked", () => {
  // The user approved a send while the session was permissive, then narrowed
  // the session. Narrowing it was aimed at exactly this action, so the answer
  // cannot carry over.
  const outcome = classifyApprovalDecision(
    decisionInput({ policy: { policy: "conservative", session: "conservative", host: "conservative" } })
  );
  assert.deepEqual(outcome, { outcome: "refuse", reason: "policy_changed" });
});

test("the answering window closes for allowances and refusals alike", () => {
  const late = new Date(EXPIRES.getTime() + 1);
  assert.deepEqual(classifyApprovalDecision(decisionInput({ now: late })), {
    outcome: "refuse",
    reason: "expired",
  });
  // A denial reaches `verifyApproval`'s `not_allowed` branch, which returns
  // before it checks the clock — so the expiry check after it is the one that
  // catches a late no. Without it, an expired card could still be answered as
  // long as the answer was a refusal.
  assert.deepEqual(
    classifyApprovalDecision(decisionInput({ submittedDecision: "denied", now: late })),
    { outcome: "refuse", reason: "expired" }
  );
});

test("the same answer arriving twice is a replay, not a conflict", () => {
  const outcome = classifyApprovalDecision(
    decisionInput({ approval: { ...decisionInput().approval, decision: "allowed" } })
  );
  assert.deepEqual(outcome, { outcome: "replay" });
});

test("a different answer to an answered card is refused", () => {
  // Two clients, or two people: the phone that raised the notification and the
  // browser it was raised on. The first answer stands.
  const outcome = classifyApprovalDecision(
    decisionInput({ approval: { ...decisionInput().approval, decision: "denied" } })
  );
  assert.deepEqual(outcome, { outcome: "refuse", reason: "already_decided" });
});

test("a card the sweeper already expired is reported as expired, not as answered", () => {
  // The sweeper writing `expired` is not somebody else's answer. Telling the
  // user "already answered" for a request that simply timed out sends them
  // looking for a colleague who made a decision nobody made.
  const outcome = classifyApprovalDecision(
    decisionInput({ approval: { ...decisionInput().approval, decision: "expired" } })
  );
  assert.deepEqual(outcome, { outcome: "refuse", reason: "expired" });

  // A row replaced by a newer request has genuinely been resolved.
  const superseded = classifyApprovalDecision(
    decisionInput({ approval: { ...decisionInput().approval, decision: "superseded" } })
  );
  assert.deepEqual(superseded, { outcome: "refuse", reason: "already_decided" });
});

test("every refusal reason the branch table can produce has a name", () => {
  // The client does something different for each — re-render, re-ask, or tell
  // the user the moment passed — so a reason that is not in this list is a
  // reason no client can act on.
  const produced = new Set<string>();
  const inputs: ApprovalDecisionInput[] = [
    decisionInput({ submittedDigest: actionDigest("other", {}) }),
    decisionInput({ policy: { policy: "conservative" } }),
    decisionInput({ now: new Date(EXPIRES.getTime() + 1) }),
    decisionInput({ approval: { ...decisionInput().approval, decision: "denied" } }),
    decisionInput({
      submittedDecision: "allowed_always",
      submittedDigest: actionDigest(SEND, DETAIL),
      approval: {
        ...decisionInput().approval,
        action: SEND,
        risk: "irreversible",
        actionDigest: actionDigest(SEND, DETAIL),
      },
    }),
  ];
  for (const input of inputs) {
    const outcome = classifyApprovalDecision(input);
    if (outcome.outcome === "refuse") produced.add(outcome.reason);
  }
  assert.deepEqual([...produced].sort(), [...APPROVAL_DECISION_REFUSALS].sort());
});
