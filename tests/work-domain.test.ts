import test from "node:test";
import assert from "node:assert/strict";
import {
  ALWAYS_CONFIRM_ACTIONS,
  CLOUD_CAPABILITIES,
  LOCAL_ONLY_CAPABILITIES,
  NO_BUDGET,
  WORK_ACCESS_MODES,
  WORK_CAPABILITIES,
  WORK_LIVE_STATUSES,
  WORK_PERMISSION_POLICIES,
  WORK_RISK_LEVELS,
  WORK_SENSITIVITIES,
  WORK_STATUSES,
  WORK_TERMINAL_REASONS,
  WORK_TERMINAL_STATUSES,
  WORK_TOOL_TIERS,
  allowsPermanentDelete,
  allowsScreenshotRelay,
  allowsTrash,
  allowsWrite,
  budgetExceeded,
  isLiveStatus,
  isTerminalStatus,
  isWorkStatus,
  maxSensitivity,
  narrowestBudget,
  narrowestPolicy,
  permitsTier,
  requiresExplicitApproval,
  requiresLocalHost,
  selectTarget,
  statusForTerminalReason,
  statusNeedsAttention,
  toolTier,
  type BudgetUsage,
  type HostCapabilityView,
  type WorkBudget,
  type WorkCapability,
  type WorkPermissionPolicy,
  type WorkSensitivity,
  type WorkTarget,
} from "@/lib/work/domain";

/*
 * The Work vocabulary is the only thing standing between a user and a task
 * that quietly does not happen.
 *
 * Every failure this file pins is one where the wrong answer is invisible
 * from the outside: a run "queued" against a Mac that is asleep looks exactly
 * like a run about to start, a session budget nobody set looks exactly like a
 * budget of zero, and a screen click that a connector could have served looks
 * exactly like a screen click that had to happen. So the tests are written
 * against the awkward inputs — the asleep Mac, the revoked one, the account
 * with two Macs where only the second has the grant — rather than the path
 * that already works.
 */

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

function mac(overrides: Partial<HostCapabilityView> = {}): HostCapabilityView {
  return {
    hostId: "host_studio",
    displayName: "Mac Studio",
    state: "online",
    enabled: true,
    revoked: false,
    capabilities: [
      "local_files",
      "local_apps",
      "local_browser",
      "local_computer_use",
      "local_shell",
    ],
    ...overrides,
  };
}

function select(
  requested: WorkTarget,
  required: readonly WorkCapability[],
  hosts: readonly HostCapabilityView[],
  cloudAvailable = true
) {
  return selectTarget({ requested, required, hosts, cloudAvailable });
}

test("a granted, reachable Mac runs the task with nothing taken away", () => {
  const selection = select("local", ["local_files"], [mac()]);

  assert.equal(selection.target, "local");
  assert.equal(selection.hostId, "host_studio");
  assert.deepEqual(selection.available, ["local_files"]);
  assert.deepEqual(selection.missing, []);
  assert.deepEqual(selection.degradation, [], "a run that lost nothing must report nothing");
  assert.match(selection.explanation, /Mac Studio/);
});

test("a local run still counts the cloud capabilities it needs as available", () => {
  // The Mac never advertises `deliverables`; a selection that called it missing
  // would tell the user their document is not going to be written.
  const selection = select("local", ["local_files", "deliverables"], [mac()]);

  assert.equal(selection.target, "local");
  assert.deepEqual(selection.available, ["local_files", "deliverables"]);
  assert.deepEqual(selection.missing, []);
});

test("an idle Mac is a usable Mac", () => {
  // hostStateFor reports `idle` for a host with no active runs, which is the
  // state every first run of the day starts from. Treating only `online` as
  // usable would make Work unusable until something else was already running.
  const selection = select("local", ["local_files"], [mac({ state: "idle" })]);

  assert.equal(selection.target, "local");
  assert.equal(selection.hostId, "host_studio");
});

test("a Mac whose heartbeat has gone stale is not treated as present", () => {
  const selection = select("local", ["local_files"], [mac({ state: "stale" })]);

  assert.equal(selection.target, null, "a stale heartbeat means nobody is listening for the command");
});

test("an offline Mac produces no target at all, not a silent cloud run", () => {
  const selection = select("local", ["local_files"], [mac({ state: "offline" })]);

  assert.equal(
    selection.target,
    null,
    "the caller must not queue this: a queued run with no possible executor renders as a spinner that never resolves"
  );
  assert.notEqual(selection.target, "cloud", "the cloud cannot read a folder on the user's Mac");
  assert.equal(selection.hostId, null);
  assert.deepEqual(selection.available, []);
  assert.deepEqual(selection.missing, ["local_files"], "the whole request is unserved, not part of it");
  assert.deepEqual(
    selection.degradation.map((d) => d.kind),
    ["host_offline"]
  );
  assert.match(selection.explanation, /Mac Studio is offline\./);
  assert.match(
    selection.explanation,
    /only a Mac can do/,
    "the sentence has to say why, or the user reads it as a transient error and waits"
  );
});

test("an offline Mac with a cloud-servable remainder runs the cloud part and says the rest will not", () => {
  const selection = select("automatic", ["local_files", "web_research"], [mac({ state: "offline" })]);

  assert.equal(selection.target, "cloud");
  assert.equal(selection.hostId, null);
  assert.deepEqual(selection.available, ["web_research"]);
  assert.deepEqual(selection.missing, ["local_files"], "the local half is not merely deferred, it is missing");
  assert.deepEqual(
    selection.degradation.map((d) => d.kind),
    ["host_offline", "local_portion_skipped"],
    "one degradation naming the absent host and one naming the work that will not happen"
  );

  const skipped = selection.degradation.find((d) => d.kind === "local_portion_skipped");
  assert.match(String(skipped?.explanation), /access to a folder on your Mac/);
  assert.match(String(skipped?.explanation), /will not run/);

  assert.match(selection.explanation, /Mac Studio is offline\./);
  assert.match(selection.explanation, /leave the rest undone/);
  assert.doesNotMatch(
    selection.explanation,
    /\bwill run\b|\bqueued\b|\bwaiting for\b|\blater\b|\bresume\b/,
    "any hint that the local part is still coming makes the user stop watching for it"
  );
});

test("a Mac switched off for Work is not a host, however online it is", () => {
  const selection = select("local", ["local_files"], [mac({ enabled: false })]);

  assert.equal(selection.target, null);
  assert.equal(selection.hostId, null);
  assert.match(selection.explanation, /No Mac is both switched on for Juno Work and reachable\./);
  assert.doesNotMatch(selection.explanation, /Mac Studio is online/, "an opted-out Mac is not named as if it were nearly usable");
});

test("a revoked Mac is not a host, however online and enabled it is", () => {
  const selection = select("local", ["local_files"], [mac({ revoked: true })]);

  assert.equal(
    selection.target,
    null,
    "revocation is the user withdrawing consent; an online flag must never outvote it"
  );
  assert.equal(selection.hostId, null);
  assert.match(selection.explanation, /No Mac is both switched on for Juno Work and reachable\./);
});

test("capability beats preference order when only the second Mac can serve the task", () => {
  const air = mac({
    hostId: "host_air",
    displayName: "MacBook Air",
    capabilities: ["local_files"],
  });
  const studio = mac({
    hostId: "host_studio",
    displayName: "Mac Studio",
    capabilities: ["local_files", "local_shell"],
  });

  const selection = select("local", ["local_files", "local_shell"], [air, studio]);

  assert.equal(selection.target, "local");
  assert.equal(
    selection.hostId,
    "host_studio",
    "the preferred host is listed first, but a host that cannot run the task is not a candidate"
  );
  assert.deepEqual(selection.missing, []);
});

test("a Mac that serves some but not all of the local capabilities is not fully capable", () => {
  const selection = select("local", ["local_files", "local_shell"], [mac({ capabilities: ["local_files"] })]);

  assert.equal(
    selection.target,
    null,
    "a partial match dispatched as a whole run fails halfway through, after it has already touched the user's files"
  );
  assert.equal(selection.hostId, null);
  assert.deepEqual(selection.missing, ["local_files", "local_shell"]);
  assert.doesNotMatch(selection.explanation, /Runs on/, "nothing runs, so the sentence must not open by naming a host");
});

test("no Mac at all is a different sentence from a Mac that is asleep", () => {
  const selection = select("local", ["local_apps"], []);

  assert.equal(selection.target, null);
  assert.match(selection.explanation, /No Mac has been switched on for Juno Work\./);
});

test("a cloud-only task with the cloud closed returns no target and says so", () => {
  const selection = select("cloud", ["web_research", "deliverables"], [], false);

  assert.equal(selection.target, null, "there is no local fallback for a task nothing local was asked to do");
  assert.equal(selection.hostId, null);
  assert.deepEqual(selection.available, []);
  assert.deepEqual(selection.missing, ["web_research", "deliverables"]);
  assert.deepEqual(
    selection.degradation.map((d) => d.kind),
    ["capability_unavailable"]
  );
  assert.match(selection.explanation, /not accepting tasks right now/);
});

test("an automatic local task cannot fall back to a cloud that is closed", () => {
  const selection = select(
    "automatic",
    ["local_files", "web_research"],
    [mac({ state: "offline" })],
    false
  );

  assert.equal(selection.target, null, "the fallback path must check that the fallback exists");
  assert.deepEqual(selection.missing, ["local_files", "web_research"]);
});

test("an explicit cloud request is honoured and the local capability is named as missing", () => {
  // The Mac here is online, enabled and granted. The user asked for cloud
  // anyway, and quietly moving the run onto the Mac would put screen control
  // on a machine the user deliberately left out of it.
  const selection = select("cloud", ["local_computer_use", "web_research"], [mac()]);

  assert.equal(selection.target, "cloud");
  assert.equal(selection.hostId, null);
  assert.deepEqual(selection.available, ["web_research"]);
  assert.deepEqual(selection.missing, ["local_computer_use"]);

  const degradation = selection.degradation.find((d) => d.subject === "local_computer_use");
  assert.equal(degradation?.kind, "capability_unavailable");
  assert.match(String(degradation?.explanation), /screen control on your Mac needs a Mac/);
  assert.match(selection.explanation, /Some steps need a Mac and will not run\./);
});

test("an automatic task needing nothing local goes to the cloud undegraded", () => {
  const selection = select("automatic", ["web_research", "deliverables"], [mac()]);

  assert.equal(selection.target, "cloud", "an available Mac is not a reason to occupy it");
  assert.deepEqual(selection.missing, []);
  assert.deepEqual(selection.degradation, []);
  assert.match(selection.explanation, /keeps going when your devices are offline/);
});

test("a capability requested twice is served once", () => {
  // The planner unions capability lists per step, so duplicates arrive
  // routinely; a duplicated entry in `missing` becomes a duplicated warning.
  const selection = select("cloud", ["web_research", "web_research", "local_shell", "local_shell"], []);

  assert.deepEqual(selection.available, ["web_research"]);
  assert.deepEqual(selection.missing, ["local_shell"]);
  assert.equal(selection.degradation.length, 1);
});

test("every declared capability is claimed by exactly one of the local and cloud lists", () => {
  // A capability in neither list requires no host and is served by no target,
  // so a task asking for it is accepted and then does nothing.
  for (const capability of WORK_CAPABILITIES) {
    const local = LOCAL_ONLY_CAPABILITIES.includes(capability);
    const cloud = CLOUD_CAPABILITIES.includes(capability);
    assert.notEqual(local, cloud, `${capability} must be local-only or cloud-servable, not both and not neither`);
  }
});

test("requiresLocalHost is true for any list touching the Mac and false otherwise", () => {
  assert.equal(requiresLocalHost([]), false);
  assert.equal(requiresLocalHost(["web_research", "connectors", "deliverables"]), false);
  assert.equal(requiresLocalHost(["web_research", "local_browser"]), true);
  assert.equal(
    requiresLocalHost(["local_files_v2"]),
    false,
    "an unrecognised capability must not be read as a demand for a Mac"
  );
});

// ---------------------------------------------------------------------------
// Policy and budget narrowing
// ---------------------------------------------------------------------------

const policyRank = (policy: WorkPermissionPolicy) => WORK_PERMISSION_POLICIES.indexOf(policy);

test("narrowing a policy can only ever narrow, for every combination and order", () => {
  const layers: readonly (WorkPermissionPolicy | null | undefined)[] = [
    ...WORK_PERMISSION_POLICIES,
    null,
    undefined,
  ];

  for (const a of layers) {
    for (const b of layers) {
      for (const c of layers) {
        const result = narrowestPolicy(a, b, c);
        const declared = [a, b, c].filter((p): p is WorkPermissionPolicy => Boolean(p));
        const expected = declared.reduce<WorkPermissionPolicy>(
          (lowest, p) => (policyRank(p) < policyRank(lowest) ? p : lowest),
          "permissive"
        );

        assert.equal(result, expected, `narrowestPolicy(${a}, ${b}, ${c}) should be ${expected}`);
        for (const declaredPolicy of declared) {
          assert.ok(
            policyRank(result) <= policyRank(declaredPolicy),
            `narrowestPolicy(${a}, ${b}, ${c}) returned ${result}, which is wider than the ${declaredPolicy} layer`
          );
        }
      }
    }
  }
});

test("a layer that declares no policy does not widen the layers that did", () => {
  assert.equal(narrowestPolicy("conservative", undefined), "conservative");
  assert.equal(narrowestPolicy(undefined, "conservative"), "conservative");
  assert.equal(narrowestPolicy(null, "balanced", null), "balanced");
  assert.equal(narrowestPolicy("permissive", "conservative", "balanced"), "conservative");
  assert.equal(narrowestPolicy(), "permissive", "with nothing declared there is nothing to intersect");
});

const SCHEDULE_BUDGET: WorkBudget = {
  maxCostMicroUsd: 2_000_000,
  maxTokens: 400_000,
  maxRuntimeMs: 900_000,
};

test("an unset session budget does not clamp a real schedule budget to zero", () => {
  const narrowed = narrowestBudget(NO_BUDGET, SCHEDULE_BUDGET);

  assert.deepEqual(
    narrowed,
    SCHEDULE_BUDGET,
    "Math.min(0, x) is 0, and a zero ceiling read as a real one stops every run on its first token"
  );
  assert.equal(
    budgetExceeded(narrowed, { costMicroUsd: 1, tokens: 1, runtimeMs: 1 }).exceeded,
    false,
    "the narrowed budget has to survive contact with budgetExceeded, not just look right"
  );
});

test("narrowing takes the smallest declared ceiling per field, independently", () => {
  const session: WorkBudget = { maxCostMicroUsd: 5_000_000, maxTokens: 0, maxRuntimeMs: 600_000 };
  const skill: WorkBudget = { maxCostMicroUsd: 0, maxTokens: 100_000, maxRuntimeMs: 300_000 };

  assert.deepEqual(narrowestBudget(session, skill, null, undefined), {
    maxCostMicroUsd: 5_000_000,
    maxTokens: 100_000,
    maxRuntimeMs: 300_000,
  });
});

test("narrowing nothing at all leaves every ceiling unset", () => {
  assert.deepEqual(narrowestBudget(), NO_BUDGET);
  assert.deepEqual(narrowestBudget(null, undefined, NO_BUDGET), NO_BUDGET);
});

function limitHit(budget: WorkBudget, usage: BudgetUsage): "cost" | "tokens" | "runtime" | null {
  const verdict = budgetExceeded(budget, usage);
  return verdict.exceeded ? verdict.limit : null;
}

test("each ceiling reports its own name, so the terminal reason says which one stopped the run", () => {
  const spent: BudgetUsage = { costMicroUsd: 3_000_000, tokens: 10, runtimeMs: 10 };
  const talked: BudgetUsage = { costMicroUsd: 10, tokens: 500_000, runtimeMs: 10 };
  const ran: BudgetUsage = { costMicroUsd: 10, tokens: 10, runtimeMs: 1_000_000 };

  assert.equal(limitHit(SCHEDULE_BUDGET, spent), "cost");
  assert.equal(limitHit(SCHEDULE_BUDGET, talked), "tokens");
  assert.equal(limitHit(SCHEDULE_BUDGET, ran), "runtime");
});

test("usage exactly at a ceiling has reached it", () => {
  const verdict = budgetExceeded(SCHEDULE_BUDGET, {
    costMicroUsd: SCHEDULE_BUDGET.maxCostMicroUsd,
    tokens: 0,
    runtimeMs: 0,
  });

  if (!verdict.exceeded) assert.fail("a run standing exactly on its cost ceiling must not take another step");
  assert.equal(verdict.limit, "cost");
  assert.match(verdict.detail, /2\.00 of a 2\.00 USD ceiling/, "the detail carries both numbers, not just the verdict");
});

test("a ceiling of zero is no ceiling, however large the usage", () => {
  const enormous: BudgetUsage = {
    costMicroUsd: 999_000_000,
    tokens: 50_000_000,
    runtimeMs: 86_400_000,
  };

  assert.equal(limitHit(NO_BUDGET, enormous), null, "zero means the plan default applies, not that nothing may be spent");
  assert.equal(
    limitHit({ maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 60_000 }, enormous),
    "runtime",
    "the one ceiling that was set is still enforced"
  );
});

test("cost is reported ahead of the other ceilings when several are past", () => {
  // The reason lands on the run row verbatim, so the ordering has to be a
  // decision rather than whatever the branches happened to be written in.
  assert.equal(
    limitHit(SCHEDULE_BUDGET, { costMicroUsd: 9_000_000, tokens: 900_000, runtimeMs: 9_000_000 }),
    "cost"
  );
});

test("usage below every ceiling is not exceeded", () => {
  assert.equal(limitHit(SCHEDULE_BUDGET, { costMicroUsd: 1_999_999, tokens: 399_999, runtimeMs: 899_999 }), null);
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test("every status is exactly one of live and terminal", () => {
  for (const status of WORK_STATUSES) {
    assert.notEqual(
      isLiveStatus(status),
      isTerminalStatus(status),
      `${status} is either in both halves or in neither, and a status in neither is one no client can classify`
    );
    assert.ok(isWorkStatus(status), `${status} is in the list but not recognised by the guard`);
  }

  assert.equal(
    new Set(WORK_STATUSES).size,
    WORK_STATUSES.length,
    "a status listed twice would pass the exactly-one check while being live and terminal at once"
  );
  assert.equal(WORK_STATUSES.length, WORK_LIVE_STATUSES.length + WORK_TERMINAL_STATUSES.length);
  assert.equal(isWorkStatus("finished"), false, "a plausible status from another system is still not one of ours");
  assert.equal(isWorkStatus(""), false);
});

test("every terminal reason resolves to a terminal status", () => {
  for (const reason of WORK_TERMINAL_REASONS) {
    const status = statusForTerminalReason(reason);
    assert.ok(
      isTerminalStatus(status),
      `${reason} resolved to ${status}, which is live — a finished run would stay on screen as a spinner`
    );
    assert.equal(isLiveStatus(status), false);
  }
});

test("a run replaced by a newer one is cancelled, not failed", () => {
  assert.equal(
    statusForTerminalReason("superseded"),
    "cancelled",
    "superseded is the only reason with no status of its own, and failed is the wrong place to put it"
  );

  for (const reason of WORK_TERMINAL_REASONS) {
    if (reason === "superseded") continue;
    assert.equal(
      statusForTerminalReason(reason),
      reason,
      `${reason} is both a reason and a status; the two must not drift apart`
    );
  }
});

test("host_offline is terminal and still needs the user", () => {
  assert.ok(isTerminalStatus("host_offline"));
  assert.ok(
    statusNeedsAttention("host_offline"),
    "the run is over but the decision is not made; filed under failed, it never gets made"
  );

  const attention = new Set(["waiting_input", "waiting_approval", "host_offline"]);
  for (const status of WORK_STATUSES) {
    assert.equal(
      statusNeedsAttention(status),
      attention.has(status),
      `${status} must ${attention.has(status) ? "" : "not "}be raised to the user as needing an answer`
    );
  }
});

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

const sensitivityRank = (value: WorkSensitivity) => WORK_SENSITIVITIES.indexOf(value);

test("combining classifications only ever raises sensitivity", () => {
  const values: readonly (WorkSensitivity | null | undefined)[] = [
    ...WORK_SENSITIVITIES,
    null,
    undefined,
  ];

  for (const a of values) {
    for (const b of values) {
      for (const c of values) {
        const result = maxSensitivity(a, b, c);
        const declared = [a, b, c].filter((v): v is WorkSensitivity => Boolean(v));
        const expected = declared.reduce<WorkSensitivity>(
          (highest, v) => (sensitivityRank(v) > sensitivityRank(highest) ? v : highest),
          "public"
        );

        assert.equal(result, expected, `maxSensitivity(${a}, ${b}, ${c}) should be ${expected}`);
        for (const declaredValue of declared) {
          assert.ok(
            sensitivityRank(result) >= sensitivityRank(declaredValue),
            `maxSensitivity(${a}, ${b}, ${c}) returned ${result}, below the ${declaredValue} input`
          );
        }
      }
    }
  }
});

test("restricted content never reaches a screenshot, everything else may", () => {
  for (const sensitivity of WORK_SENSITIVITIES) {
    assert.equal(
      allowsScreenshotRelay(sensitivity),
      sensitivity !== "restricted",
      `${sensitivity} was decided the wrong way; this is checked before the image is stored, so a wrong answer has already left the Mac`
    );
  }

  assert.equal(
    allowsScreenshotRelay(maxSensitivity("public", "restricted")),
    false,
    "one restricted input in a mixed capture is enough to block the whole frame"
  );
});

// ---------------------------------------------------------------------------
// Access modes and approvals
// ---------------------------------------------------------------------------

test("no access mode permits a permanent delete", () => {
  for (const mode of WORK_ACCESS_MODES) {
    assert.equal(
      allowsPermanentDelete(),
      false,
      `granting ${mode} must not be a route to an unrecoverable delete`
    );
  }
  assert.equal(
    allowsPermanentDelete.length,
    0,
    "the function takes no argument, so there is no mode a caller could pass to unlock it"
  );
});

test("read_write_no_delete allows writing and refuses the Trash", () => {
  assert.equal(allowsWrite("read_write_no_delete"), true);
  assert.equal(
    allowsTrash("read_write_no_delete"),
    false,
    "a Trash move under a no-delete grant still removes the file from where the user left it, which is not what they agreed to"
  );
});

test("write and Trash are decided per mode, with read granting neither", () => {
  assert.equal(allowsWrite("read"), false);
  assert.equal(allowsTrash("read"), false);
  assert.equal(allowsWrite("read_write"), true);
  assert.equal(allowsTrash("read_write"), true);
});

test("an always-confirm action asks whatever risk level it is handed", () => {
  for (const action of ALWAYS_CONFIRM_ACTIONS) {
    for (const risk of WORK_RISK_LEVELS) {
      assert.ok(
        requiresExplicitApproval(action, risk),
        `${action} classified as ${risk} skipped the prompt; the classifier is exactly what must not be trusted here`
      );
    }
  }
});

test("sensitive and irreversible risk always ask, on any action", () => {
  for (const action of ["work.file.read", "work.connector.list", "work.browser.open"]) {
    assert.equal(requiresExplicitApproval(action, "sensitive"), true, action);
    assert.equal(requiresExplicitApproval(action, "irreversible"), true, action);
    assert.equal(requiresExplicitApproval(action, "safe"), false, action);
    assert.equal(requiresExplicitApproval(action, "edit"), false, action);
    assert.equal(requiresExplicitApproval(action, "command"), false, action);
  }
});

test("the always-confirm list is matched exactly, not by resemblance", () => {
  // The list is enumerated precisely so a name that merely looks like one of
  // them is not caught by a pattern, and — more importantly — so a genuinely
  // dangerous name is never missed because a pattern nearly matched it.
  assert.equal(requiresExplicitApproval("work.file.permanent_delete_preview", "safe"), false);
  assert.equal(requiresExplicitApproval("work.connector.send_message_draft", "safe"), false);
  assert.equal(requiresExplicitApproval("work.file.permanent_delete", "safe"), true);
  assert.equal(
    requiresExplicitApproval("WORK.FILE.PERMANENT_DELETE", "safe"),
    false,
    "action ids are compared exactly, so a differently-cased id is a different action and has to be added to the list rather than assumed covered"
  );
});

// ---------------------------------------------------------------------------
// Tool tiers
// ---------------------------------------------------------------------------

test("a screen click is refused while a connector can serve the same intent", () => {
  assert.equal(
    permitsTier("visual", ["connector", "visual"]),
    false,
    "this is a refusal, not a preference: clicking through the UI needs far more permission and puts the user's data on a screenshot"
  );
  assert.equal(permitsTier("connector", ["connector", "visual"]), true);
});

test("a lower tier is permitted once nothing better declared the intent", () => {
  assert.equal(permitsTier("visual", ["visual", "shell"]), true, "the best available candidate is the visual tool itself");
  assert.equal(permitsTier("shell", ["visual", "shell"]), false, "shell is below visual and something better exists");
  assert.equal(
    permitsTier("visual", []),
    true,
    "with no candidate declared there is no better tool to refuse in favour of"
  );
});

test("an unknown tool sorts last and is refused against any known one", () => {
  assert.equal(toolTier("teleport"), Number.MAX_SAFE_INTEGER, "an unrecognised tool must never sort ahead of a real one");
  assert.equal(permitsTier("teleport", ["connector"]), false);
  assert.equal(permitsTier("teleport", ["shell"]), false, "even the lowest declared tier outranks a tool nobody declared");
  assert.equal(permitsTier("connector", ["teleport"]), true);
});

test("the tier table is a strict ordering with unique ids", () => {
  const ids = WORK_TOOL_TIERS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "two tools sharing an id would make toolTier ambiguous");

  for (let i = 1; i < WORK_TOOL_TIERS.length; i += 1) {
    assert.ok(
      WORK_TOOL_TIERS[i].tier > WORK_TOOL_TIERS[i - 1].tier,
      `${WORK_TOOL_TIERS[i].id} does not sort strictly below ${WORK_TOOL_TIERS[i - 1].id}, so the refusal between them is undefined`
    );
  }

  for (const entry of WORK_TOOL_TIERS) {
    assert.equal(toolTier(entry.id), entry.tier, `${entry.id} is in the table but toolTier disagrees with it`);
  }
});
