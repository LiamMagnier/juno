import test from "node:test";
import assert from "node:assert/strict";
import {
  ALWAYS_CONFIRM_ACTIONS,
  DEFAULT_WORK_PERMISSION_POLICY,
  WORK_APPROVAL_MODE_LABEL,
  WORK_APPROVAL_MODE_SUMMARY,
  WORK_PERMISSION_POLICIES,
  WORK_RISK_LEVELS,
  approvalRuling,
  mayBeCoveredByStandingAllowance,
  narrowestPolicy,
  requiresExplicitApproval,
  resolveApprovalMode,
  type WorkPermissionPolicy,
  type WorkRiskLevel,
} from "@/lib/work/domain";
import { createSessionSchema, startRunSchema } from "@/app/api/work/protocol";
import { startCommandPayload } from "@/lib/work/relay";

/*
 * The three approval modes, and the two things that must stay true of them.
 *
 * Manual, Auto and Skip are `conservative`, `balanced` and `permissive` on the
 * wire. Until `approvalRuling` existed they were the same mode wearing three
 * names: the executor gated on `requiresExplicitApproval(action, risk)`, which
 * takes no policy, so a task set to Manual and a task set to Skip stopped for
 * exactly the same actions. The setting was stored, narrowed correctly and
 * enforced nowhere, which is worse than not having it — a person who picks
 * Manual and is not asked has been told something false by a control.
 *
 * So two properties, one section each:
 *
 *   1. the modes genuinely differ, and they differ in the one direction the
 *      lattice permits: strictly more is asked about as the mode narrows;
 *   2. Skip cannot go below the floor — not by being chosen, not by being
 *      chosen on a Mac, and not by a standing "always allow" on top of it.
 *
 * Pure functions only. No database, no host, no run.
 */

const POLICY_RANK = (policy: WorkPermissionPolicy) => WORK_PERMISSION_POLICIES.indexOf(policy);
const RISK_RANK = (risk: WorkRiskLevel) => WORK_RISK_LEVELS.indexOf(risk);

/** An action on nobody's list, so the answer is about the risk and the mode. */
const PLAIN = "work.file.write";

// ---------------------------------------------------------------------------
// 1. The three modes actually differ
// ---------------------------------------------------------------------------

test("each mode asks about a strictly different set of reversible work", () => {
  const asks = (policy: WorkPermissionPolicy) =>
    WORK_RISK_LEVELS.filter((risk) => approvalRuling({ action: PLAIN, risk, policy }).ask);

  assert.deepEqual(asks("conservative"), ["edit", "command", "sensitive", "irreversible"]);
  assert.deepEqual(asks("balanced"), ["command", "sensitive", "irreversible"]);
  assert.deepEqual(asks("permissive"), ["sensitive", "irreversible"]);
});

test("narrowing the mode only ever adds to what is asked about", () => {
  // The monotonicity that makes "at least as strict" a meaningful phrase. If a
  // narrower mode could let something through that a wider one stopped, then
  // `narrowestPolicy` would not be a `min` over anything a user cares about,
  // and the host ceiling below would be enforcing an ordering that does not
  // correspond to how much Juno actually does on its own.
  for (const action of [PLAIN, ...ALWAYS_CONFIRM_ACTIONS]) {
    for (const risk of WORK_RISK_LEVELS) {
      for (const wider of WORK_PERMISSION_POLICIES) {
        for (const narrower of WORK_PERMISSION_POLICIES) {
          if (POLICY_RANK(narrower) > POLICY_RANK(wider)) continue;
          if (!approvalRuling({ action, risk, policy: wider }).ask) continue;
          assert.ok(
            approvalRuling({ action, risk, policy: narrower }).ask,
            `${narrower} let ${action}/${risk} through while ${wider} stopped it`
          );
        }
      }
    }
  }
});

test("a run under Auto proceeds through the edits a run under Manual stops for", () => {
  // The concrete difference, stated as the thing a user would notice: Auto is
  // the mode that writes the file and tells you afterwards.
  const edit = { action: PLAIN, risk: "edit" as const };
  assert.equal(approvalRuling({ ...edit, policy: "conservative" }).ask, true);
  assert.equal(approvalRuling({ ...edit, policy: "balanced" }).ask, false);

  // And the difference between Auto and Skip is the command, which is the only
  // place they part company. It is graded neither sensitive nor irreversible
  // because Juno cannot know what the program does — which is the argument for
  // Auto asking, not against it.
  const command = { action: PLAIN, risk: "command" as const };
  assert.equal(approvalRuling({ ...command, policy: "balanced" }).ask, true);
  assert.equal(approvalRuling({ ...command, policy: "permissive" }).ask, false);
});

test("reading is never gated, under any mode", () => {
  for (const policy of WORK_PERMISSION_POLICIES) {
    const ruling = approvalRuling({ action: "work.file.read", risk: "safe", policy });
    assert.equal(ruling.ask, false, policy);
    assert.equal(ruling.reason, "nothing_to_decide");
  }
});

test("Auto is the default, and every mode has words a person can be shown", () => {
  assert.equal(DEFAULT_WORK_PERMISSION_POLICY, "balanced");
  for (const policy of WORK_PERMISSION_POLICIES) {
    assert.ok(WORK_APPROVAL_MODE_LABEL[policy].length > 0, policy);
    assert.ok(WORK_APPROVAL_MODE_SUMMARY[policy].length > 0, policy);
  }
  // Skip's own sentence has to carry the exception, because it is the only mode
  // whose name promises something the product does not do. Finding out from a
  // prompt you were told would not come is how a person decides the setting is
  // broken.
  assert.match(WORK_APPROVAL_MODE_SUMMARY.permissive, /cannot take back/);
});

// ---------------------------------------------------------------------------
// 2. Skip cannot go below the floor
// ---------------------------------------------------------------------------

test("the never-silent four still ask under Skip", () => {
  // The canonical four, named the way the approval copy already names them: a
  // permanent delete, a message sent, a purchase, a security setting. Written
  // out here rather than looped over `ALWAYS_CONFIRM_ACTIONS` so that removing
  // one from that list fails this test by name instead of quietly shrinking the
  // loop.
  const four = [
    "work.file.permanent_delete",
    "work.connector.send_message",
    "work.connector.payment",
    "work.system.change_security_setting",
  ] as const;

  for (const action of four) {
    assert.ok((ALWAYS_CONFIRM_ACTIONS as readonly string[]).includes(action), action);
    const ruling = approvalRuling({ action, risk: "safe", policy: "permissive" });
    assert.ok(ruling.ask, `${action} went ahead silently under Skip`);
    assert.equal(
      ruling.reason,
      "never_silent",
      "the reason has to be distinguishable from an ordinary mode prompt, or a client cannot tell somebody why the mode they chose was overruled"
    );
  }
});

test("every always-confirm action asks under Skip, at every risk grade it could be given", () => {
  // Deliberately including `safe`. The risk grade comes from the tool, and the
  // enumerated list exists precisely because that grade is the thing not to
  // trust: a tool that mislabels its own send as safe must not be able to send.
  for (const action of ALWAYS_CONFIRM_ACTIONS) {
    for (const risk of WORK_RISK_LEVELS) {
      assert.ok(
        approvalRuling({ action, risk, policy: "permissive" }).ask,
        `${action} graded ${risk} skipped the prompt under Skip`
      );
    }
  }
});

test("sensitive and irreversible work asks under Skip whatever the action is called", () => {
  for (const action of [PLAIN, "work.browser.click", "work.app.control"]) {
    assert.ok(approvalRuling({ action, risk: "sensitive", policy: "permissive" }).ask, action);
    assert.ok(approvalRuling({ action, risk: "irreversible", policy: "permissive" }).ask, action);
  }
});

test("Skip is exactly the floor: it asks about what always asks, and nothing else", () => {
  // The relationship between the two functions, as an executable statement.
  // `requiresExplicitApproval` is the policy-free floor the whole permission
  // system rests on, and Skip is defined to sit on it — not below it, which
  // would be a hole, and not above it, which would make Skip and Auto the same
  // mode again.
  for (const action of [PLAIN, ...ALWAYS_CONFIRM_ACTIONS]) {
    for (const risk of WORK_RISK_LEVELS) {
      assert.equal(
        approvalRuling({ action, risk, policy: "permissive" }).ask,
        requiresExplicitApproval(action, risk),
        `${action}/${risk}`
      );
    }
  }
});

test("a standing always-allow cannot be stacked on Skip to clear the floor", () => {
  // The allowance is the last way in: it is consulted per action, so an entry
  // for a send would make every later send silent under any mode. It is checked
  // below the floor, never above it.
  for (const action of ALWAYS_CONFIRM_ACTIONS) {
    assert.equal(mayBeCoveredByStandingAllowance(action, "edit"), false, action);
    assert.ok(
      approvalRuling({ action, risk: "edit", policy: "permissive", standingAllowance: "command" })
        .ask,
      `${action} was cleared by a standing allowance`
    );
  }
  for (const risk of ["sensitive", "irreversible"] as const) {
    assert.equal(mayBeCoveredByStandingAllowance(PLAIN, risk), false, risk);
    assert.ok(
      approvalRuling({ action: PLAIN, risk, policy: "permissive", standingAllowance: risk }).ask,
      risk
    );
  }
});

test("a standing always-allow covers no more than it was granted for", () => {
  // What it does do, so the test above is refusing something rather than
  // everything: an allowance up to `edit` covers an edit and does not cover the
  // command that comes after it.
  const under = (risk: WorkRiskLevel, allowance: WorkRiskLevel) =>
    approvalRuling({ action: PLAIN, risk, policy: "conservative", standingAllowance: allowance });

  assert.equal(under("edit", "edit").ask, false);
  assert.equal(under("edit", "edit").reason, "standing_allowance");
  assert.equal(under("command", "edit").ask, true);
  assert.equal(under("command", "command").ask, false);
  for (const risk of WORK_RISK_LEVELS) {
    for (const allowance of WORK_RISK_LEVELS) {
      if (RISK_RANK(risk) <= RISK_RANK(allowance) && mayBeCoveredByStandingAllowance(PLAIN, risk)) {
        continue;
      }
      assert.ok(under(risk, allowance).ask, `${risk} under an allowance of ${allowance}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. The host ceiling
// ---------------------------------------------------------------------------

test("Skip on a Mac advertising something stricter resolves to the Mac's", () => {
  const onManualMac = resolveApprovalMode({
    requested: "permissive",
    host: "conservative",
    hostName: "Robin’s MacBook",
  });
  assert.equal(onManualMac.policy, "conservative");
  assert.ok(onManualMac.narrowedByHost);
  // And the sentence names the machine, because "your setting was ignored" with
  // no subject sends the reader looking for a bug.
  assert.match(onManualMac.explanation, /Robin’s MacBook/);
  assert.match(onManualMac.explanation, /Manual/);

  const onAutoMac = resolveApprovalMode({ requested: "permissive", host: "balanced" });
  assert.equal(onAutoMac.policy, "balanced");
  assert.ok(onAutoMac.narrowedByHost);
});

test("the resolved mode is never wider than any layer that declared one", () => {
  const layers: readonly (WorkPermissionPolicy | null)[] = [...WORK_PERMISSION_POLICIES, null];
  for (const requested of WORK_PERMISSION_POLICIES) {
    for (const host of layers) {
      const resolved = resolveApprovalMode({ requested, host });
      assert.equal(resolved.policy, narrowestPolicy(requested, host));
      assert.ok(POLICY_RANK(resolved.policy) <= POLICY_RANK(requested));
      if (host) assert.ok(POLICY_RANK(resolved.policy) <= POLICY_RANK(host));
      assert.equal(resolved.narrowedByHost, resolved.policy !== requested);
      assert.ok(resolved.explanation.length > 0);
    }
  }
});

test("a cloud run declares no host and is not treated as narrowed", () => {
  // `narrowestPolicy` over nothing returns `permissive`, so a missing host has
  // to mean "no ceiling" rather than "the widest ceiling" — otherwise a cloud
  // run would report itself as narrowed by a Mac that is not involved.
  const cloud = resolveApprovalMode({ requested: "conservative", host: null });
  assert.equal(cloud.policy, "conservative");
  assert.equal(cloud.narrowedByHost, false);
  assert.equal(cloud.explanation, WORK_APPROVAL_MODE_SUMMARY.conservative);
});

test("the mode a Mac is told to enforce is the narrowed one, never the request", () => {
  // The gap this closes: the Mac used to gate on its own `approvalPolicy` and
  // never learn what the task asked for, so a task composed as Manual that
  // landed on a Mac set to Skip ran as Skip. The narrowing was computed, stored
  // and digested — and not sent to the machine that enforces it.
  const resolved = resolveApprovalMode({ requested: "conservative", host: "permissive" });
  assert.equal(resolved.policy, "conservative");
  assert.deepEqual(startCommandPayload({ goal: "Tidy Downloads", permissionPolicy: resolved.policy }), {
    goal: "Tidy Downloads",
    permissionPolicy: "conservative",
  });
});

test("a start command with no mode omits the key rather than sending a null", () => {
  // The Mac falls back to its own policy on a missing key, which is what every
  // build before this did. A null would decode as a value and leave it gating
  // on nothing.
  assert.deepEqual(startCommandPayload({ goal: "Tidy Downloads" }), { goal: "Tidy Downloads" });
  assert.deepEqual(startCommandPayload({ goal: "Tidy Downloads", permissionPolicy: null }), {
    goal: "Tidy Downloads",
  });
});

// ---------------------------------------------------------------------------
// 4. The wire
// ---------------------------------------------------------------------------

test("a task may name its mode, and a client that says nothing changes nothing", () => {
  for (const policy of WORK_PERMISSION_POLICIES) {
    const parsed = createSessionSchema.safeParse({
      goal: "Tidy my Downloads folder",
      requestedTarget: "automatic",
      permissionPolicy: policy,
    });
    assert.ok(parsed.success, policy);
    assert.equal(parsed.data.permissionPolicy, policy);
  }

  const silent = createSessionSchema.safeParse({
    goal: "Tidy my Downloads folder",
    requestedTarget: "automatic",
  });
  assert.ok(silent.success);
  assert.equal(
    silent.data.permissionPolicy,
    undefined,
    "absent must stay absent through the schema; the route is the one place that decides what no answer means"
  );
});

test("a mode this build has never heard of is refused rather than narrowed", () => {
  for (const body of [
    { goal: "g", requestedTarget: "automatic", permissionPolicy: "yolo" },
    { goal: "g", requestedTarget: "automatic", permissionPolicy: "" },
    { goal: "g", requestedTarget: "automatic", permissionPolicy: null },
  ]) {
    assert.equal(createSessionSchema.safeParse(body).success, false, JSON.stringify(body));
  }
});

test("a retry may be dispatched under a different mode from the session's", () => {
  // The move this exists for: "it stopped to ask me nine times, run it again and
  // stop asking" — the approval-mode twin of retrying a failed local run in the
  // cloud, which `requestedTarget` has always allowed on the same body.
  const parsed = startRunSchema.safeParse({ origin: "retry", permissionPolicy: "permissive" });
  assert.ok(parsed.success);
  assert.equal(parsed.data.permissionPolicy, "permissive");
  assert.equal(startRunSchema.safeParse({ origin: "retry" }).data?.permissionPolicy, undefined);
  assert.equal(startRunSchema.safeParse({ permissionPolicy: "yolo" }).success, false);
});
