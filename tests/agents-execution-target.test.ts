import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGENT_EVENT_KINDS,
  AGENT_EXECUTION_TARGETS,
  agentDispatchTarget,
  agentExecutionTarget,
  agentRoutineHost,
  agentWorkTarget,
  createAgentSchema,
  patchAgentSchema,
} from "@/lib/agents/domain";
import { WORK_TARGETS } from "@/lib/work/domain";
import {
  CLOUD_WORKER_DOWN_MESSAGE,
  RUNS_ON_HOST_LABELS,
  macChoiceSaves,
  preferredHostGone,
  runsOnHostLabel,
  threadWorkNotice,
} from "@/components/agents/thread-agent-state";

/*
 * Where an agent's work runs (`Agent.executionTarget`): the cloud, or the
 * person's Mac through the Work relay. Every place that used to hardcode
 * `requestedTarget: "cloud"` for an agent now maps the agent's setting into
 * Work's vocabulary, and a Mac that is offline is refused, never swapped for
 * the cloud.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("an agent's setting maps to Work's targets, never to automatic", () => {
  assert.deepEqual([...AGENT_EXECUTION_TARGETS], ["cloud", "mac"]);
  assert.equal(agentWorkTarget("cloud"), "cloud");
  assert.equal(agentWorkTarget("mac"), "local");
  assert.equal(agentWorkTarget(null), "cloud", "unset is the default");
  assert.equal(agentWorkTarget("automatic"), "cloud", "an unknown stored value is the default");
  assert.equal(agentExecutionTarget("laptop"), "cloud");
  for (const target of AGENT_EXECUTION_TARGETS) {
    const mapped = agentWorkTarget(target);
    assert.ok((WORK_TARGETS as readonly string[]).includes(mapped));
    assert.notEqual(mapped, "automatic");
  }
});

test("a Mac agent carries its preferred Mac; a cloud agent never carries a host", () => {
  assert.deepEqual(agentDispatchTarget({ executionTarget: "mac", preferredHostId: "host_1" }), {
    requestedTarget: "local",
    preferredHostId: "host_1",
  });
  assert.deepEqual(agentDispatchTarget({ executionTarget: "mac", preferredHostId: null }), { requestedTarget: "local" });
  assert.deepEqual(agentDispatchTarget({ executionTarget: "cloud", preferredHostId: "host_1" }), { requestedTarget: "cloud" });
  assert.deepEqual(agentDispatchTarget({}), { requestedTarget: "cloud" });
});

test("create defaults to cloud and patch takes the target and the Mac, additively", () => {
  const created = createAgentSchema.parse({ name: "Mira" });
  assert.equal(created.executionTarget, "cloud");
  assert.equal(createAgentSchema.parse({ name: "Mira", executionTarget: "mac", preferredHostId: "h1" }).executionTarget, "mac");
  assert.equal(createAgentSchema.safeParse({ name: "Mira", executionTarget: "local" }).success, false);

  assert.deepEqual(patchAgentSchema.parse({ executionTarget: "mac" }), { executionTarget: "mac" });
  assert.deepEqual(patchAgentSchema.parse({ preferredHostId: null }), { preferredHostId: null });
  assert.equal(patchAgentSchema.safeParse({ executionTarget: "automatic" }).success, false);
  // Not strict: an old client's patch still parses.
  assert.equal(patchAgentSchema.safeParse({ name: "Mira" }).success, true);
});

test("no agent dispatch path hardcodes the cloud any more", () => {
  const store = read("src/lib/agents/store.ts");
  const start = store.slice(store.indexOf("export async function startAgentTask("), store.indexOf("async function discardDraft("));
  assert.doesNotMatch(start, /requestedTarget: "cloud"/);
  assert.match(start, /const target = await resolveAgentDispatchTarget\(user\.id, agent\);/);
  assert.match(start, /requestedTarget: target\.requestedTarget,/);
  const routine = store.slice(store.indexOf("export async function createAgentRoutine("));
  assert.doesNotMatch(routine.slice(0, 4000), /target: "cloud"|requestedTarget: "cloud"/);
  assert.match(routine, /target: target\.requestedTarget,/);

  const task = read("src/lib/chat/task-tool.ts");
  assert.doesNotMatch(task, /ctx\.agent \? "cloud" : "automatic"/);
  assert.match(task, /\.resolveAgentDispatchTarget\(user\.id, agentPlacement\)/);
  // Read fresh from the agent row, not from the turn's context.
  assert.match(task, /select: \{ status: true, executionTarget: true, preferredHostId: true \}/);
  // A team is cloud-coordinated, so a Mac agent is refused one rather than moved.
  assert.match(task, /if \(args\.team && requestedTarget === "local"\) return taskRefusal\("team_needs_cloud"\);/);

  const goals = read("src/lib/agents/goal-runner.ts");
  assert.doesNotMatch(goals, /requestedTarget: "cloud"/);
  assert.match(goals, /agentWorkTarget\(agent\.executionTarget\)/);
});

test("a preferred Mac that was removed is dropped to any Mac, never a Host not found refusal", () => {
  // Agent.preferredHostId is a plain string, and revoking a Mac keeps its
  // WorkHost row (revokedAt set, enabled false). A revoked Mac is gone for
  // every agent path, so the lookup asks for one that is not revoked.
  const shared = read("src/lib/agents/run-context.ts");
  const resolver = shared.slice(shared.indexOf("export async function resolveAgentDispatchTarget("));
  assert.match(resolver, /where: \{ id: target\.preferredHostId, userId, revokedAt: null \}/);
  assert.match(resolver, /return host \? target : \{ requestedTarget: target\.requestedTarget \};/);
  // Switched off is not revoked: the person's own switch keeps the choice.
  assert.doesNotMatch(resolver.slice(0, 600), /enabled: true/);
  // Choosing a Mac, and Undo restoring one, read the same rule.
  const owned = read("src/lib/agents/store.ts");
  const ownedHost = owned.slice(owned.indexOf("async function ownedHostId("), owned.indexOf("const HOST_NOT_FOUND ="));
  assert.match(ownedHost, /where: \{ id: hostId, userId, revokedAt: null \}/);
  // The revoke route soft-revokes, which is why the filter is needed at all.
  assert.match(read("src/app/api/work/hosts/[id]/route.ts"), /revokedAt: now,[\s\S]{0,400}enabled: false,/);
  const store = read("src/lib/agents/store.ts");
  assert.doesNotMatch(store, /agentDispatchTarget\(agent\)/);
  const routine = store.slice(store.indexOf("export async function createAgentRoutine("));
  assert.match(routine.slice(0, 4000), /const target = await resolveAgentDispatchTarget\(user\.id, agent\);/);
});

test("a routine is placed where its agent runs, and a Mac is never picked for the person", () => {
  assert.deepEqual(agentRoutineHost({ target: "cloud", preferredHostId: "a", enabledHostIds: ["a"] }), { ok: true, hostId: null });
  // The preferred Mac, when it takes Work.
  assert.deepEqual(agentRoutineHost({ target: "local", preferredHostId: "b", enabledHostIds: ["a", "b"] }), { ok: true, hostId: "b" });
  // A preferred Mac switched off is refused, not swapped for another, and the
  // refusal says that Mac is off rather than that no Mac is on.
  assert.deepEqual(agentRoutineHost({ target: "local", preferredHostId: "b", enabledHostIds: ["a"] }), { ok: false, reason: "preferred_off" });
  assert.deepEqual(agentRoutineHost({ target: "local", preferredHostId: "b", enabledHostIds: [] }), { ok: false, reason: "no_mac" });
  // No preference: the Mac it is already on, else the only one.
  assert.deepEqual(agentRoutineHost({ target: "local", enabledHostIds: ["a", "b"], currentHostId: "b" }), { ok: true, hostId: "b" });
  assert.deepEqual(agentRoutineHost({ target: "local", enabledHostIds: ["a"], currentHostId: "gone" }), { ok: true, hostId: "a" });
  assert.deepEqual(agentRoutineHost({ target: "local", enabledHostIds: ["a", "b"] }), { ok: false, reason: "pick_mac" });
  assert.deepEqual(agentRoutineHost({ target: "local", enabledHostIds: [] }), { ok: false, reason: "no_mac" });

  // Both refusal sites have a sentence for the switched-off preferred Mac.
  const store = read("src/lib/agents/store.ts");
  const plan = store.slice(store.indexOf("async function planAgentRoutineMoves("), store.indexOf("async function applyRoutineMoves("));
  assert.match(plan, /placed\.reason === "preferred_off"\s*\? `\$\{agent\.name\} has \$\{routinesWord\}, and the Mac picked for \$\{agent\.name\} is switched off/);
  const routine = store.slice(store.indexOf("export async function createAgentRoutine("));
  assert.match(routine.slice(0, 3000), /placed\.reason === "preferred_off"\s*\? `\$\{agent\.name\} runs on a Mac that is switched off/);
});

test("Any of your Macs clears a stored Mac that is gone, though it shows as current", () => {
  // The gone Mac reads as "Any of your Macs", and choosing that row saves.
  assert.equal(macChoiceSaves({ target: "mac", storedPreferredHostId: "host_gone", choice: null }), true);
  assert.equal(macChoiceSaves({ target: "mac", storedPreferredHostId: null, choice: null }), false, "already any Mac");
  assert.equal(macChoiceSaves({ target: "mac", storedPreferredHostId: "host_a", choice: "host_a" }), false);
  assert.equal(macChoiceSaves({ target: "mac", storedPreferredHostId: "host_a", choice: "host_b" }), true);
  // Not on a Mac yet: any pick moves it there.
  assert.equal(macChoiceSaves({ target: "cloud", storedPreferredHostId: null, choice: null }), true);

  const panel = read("src/components/agents/agent-panel.tsx");
  const section = panel.slice(panel.indexOf("function RunsOnSection("), panel.indexOf("function Section({ title, children }"));
  assert.match(section, /if \(macChoiceSaves\(\{ target, storedPreferredHostId: preferredHostId, choice: id \}\)\) chooseMac\(id\);/);
  assert.doesNotMatch(section, /if \(!current\) chooseMac\(id\);/);
  // chooseMac compares against the stored id, so null is sent for a gone Mac.
  assert.match(section, /if \(id !== preferredHostId\) void onSave\(\{ preferredHostId: id \}\);/);
  assert.match(section, /const preferredHostId = agent\.preferredHostId \?\? null;/);
});

test("changing where an agent runs moves its routines with it, and Undo moves them back", () => {
  const store = read("src/lib/agents/store.ts");
  const update = store.slice(
    store.indexOf("export async function updateAgentForUser("),
    store.indexOf("function routinesMovedBy(")
  );
  // Planned before anything is written; a refusal returns before the update.
  const planAt = update.indexOf("const planned = await planAgentRoutineMoves(user.id, agent, nextPlacement);");
  assert.ok(planAt > 0);
  assert.ok(planAt < update.indexOf("prisma.agent.update("), "planned before the agent row is written");
  assert.match(update, /if \(!planned\.ok\) return planned\.refusal;/);
  // Written in the same transaction as the agent row.
  assert.match(update, /prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?client\.agent\.update\([\s\S]*?applyRoutineMoves\(client, user\.id, routineMoves\)/);
  assert.match(update, /routinesMoved: routineMoves\.map/);

  const plan = store.slice(store.indexOf("async function planAgentRoutineMoves("), store.indexOf("async function applyRoutineMoves("));
  assert.match(plan, /where: \{ userId, runKind: "work", session: \{ agentId: agent\.id, userId, deletedAt: null \} \}/);
  assert.match(plan, /agentRoutineHost\(\{/);
  const apply = store.slice(store.indexOf("async function applyRoutineMoves("));
  assert.match(apply.slice(0, 800), /tx\.workSchedule\.updateMany\(\{\s*where: \{ id: move\.scheduleId, userId \},\s*data: \{ target: move\.target, hostId: move\.hostId \}/);

  const undo = store.slice(store.indexOf("export async function undoAgentEventForUser("), store.indexOf("export async function duplicateAgentForUser("));
  assert.match(undo, /"executionTarget" in before/);
  assert.match(undo, /"preferredHostId" in before/);
  // The Mac is re-checked against the account before it is restored.
  assert.match(undo, /agentUpdate\.preferredHostId = \(await ownedHostId\(user\.id, previous\)\) \?\? null;/);
  assert.match(undo, /planAgentRoutineMoves\(user\.id, agent, restored, routinesMovedBy\(detail\)\)/);
  assert.ok(undo.indexOf("if (!planned.ok) return planned.refusal;") < undo.indexOf("const undoneAt = new Date()"), "refused before it is stamped undone");
});

test("a refused routine or goal step is recorded on the agent, never moved to the cloud", () => {
  assert.ok((AGENT_EVENT_KINDS as readonly string[]).includes("task_refused"));
  const goals = read("src/lib/agents/goal-runner.ts");
  assert.equal((goals.match(/kind: "task_refused"/g) ?? []).length, 2, "the start and the retry");
  const scheduler = read("scripts/work-scheduler.ts");
  // A Mac that could not be reached, or (for a cloud routine) no cloud worker.
  assert.match(scheduler, /const unreachable = decision\.cause === "host_offline" \|\| decision\.cause === "executor_unavailable";/);
  assert.match(scheduler, /if \(unreachable && schedule\.session\.agentId\) \{\s*await recordAgentEvent\(\{/);
  assert.match(scheduler, /kind: "task_refused",/);
});

test("the agent's own tools cannot move where it runs, in its thread or anywhere else", async () => {
  // patchAgentSchema accepts both keys for the person's own edits, so a model
  // passing them undeclared to update_agent would move the member with no
  // approval and no line on the change card.
  assert.equal(patchAgentSchema.safeParse({ executionTarget: "mac", preferredHostId: "host_abc" }).success, true);
  const { createAgentConfigTools, AGENT_PLACEMENT_ARGS, UPDATE_AGENT_PATCH_ARGS } = await import(
    "@/lib/chat/agent-config-tools"
  );
  assert.deepEqual([...AGENT_PLACEMENT_ARGS], ["executionTarget", "preferredHostId"]);
  const snapshot = {
    id: "agent_mira",
    name: "Mira",
    role: "Research",
    style: "warm",
    instructions: "",
    approvalMode: "balanced",
    notify: "results",
    proactive: false,
    status: "active",
    model: null,
    reasoningEffort: null,
    connectorIds: [],
    computerEnabled: false,
  };
  for (const agent of [snapshot, null]) {
    const tools = createAgentConfigTools({
      user: { id: "u1" },
      conversation: { id: "c1", projectId: null },
      agent,
      userMessageId: "m1",
      untrustedContent: false,
      generationId: "g1",
    });
    const update = tools.find((tool) => tool.tool.function.name === "update_agent")!;
    const props = (update.tool.function.parameters as { properties: Record<string, unknown> }).properties;
    for (const args of [
      { role: "Researcher", executionTarget: "mac", preferredHostId: "host_own" },
      { executionTarget: "cloud" },
      { preferredHostId: null },
    ]) {
      const res = await update.execute({ agent: "Mira", ...args });
      assert.equal(res.ok, false, JSON.stringify(args));
      const parsed = JSON.parse(res.text);
      assert.equal(parsed.status, "refused");
      assert.equal(parsed.reason, "placement_not_editable_here");
      assert.match(parsed.message, /Nothing was changed/);
    }
    for (const name of AGENT_PLACEMENT_ARGS) assert.equal(name in props, false, name);
    const create = tools.find((tool) => tool.tool.function.name === "create_agent")!;
    const createProps = (create.tool.function.parameters as { properties: Record<string, unknown> }).properties;
    for (const name of AGENT_PLACEMENT_ARGS) assert.equal(name in createProps, false, name);
  }
  // The patch is built from a named list, never by spreading the raw arguments.
  for (const name of [...AGENT_PLACEMENT_ARGS, "budgetMicroUsd", "sortOrder", "projectId"]) {
    assert.equal((UPDATE_AGENT_PATCH_ARGS as readonly string[]).includes(name), false, name);
  }
  const source = read("src/lib/chat/agent-config-tools.ts");
  assert.doesNotMatch(source, /\.\.\.restPatch/);
  assert.match(source, /for \(const name of UPDATE_AGENT_PATCH_ARGS\)/);
});

test("the thread says when cloud work cannot start, and only for a cloud agent", () => {
  const cloudDown = { executionTarget: "cloud" as const, cloudWorkAvailable: false, status: "active" as const };
  assert.equal(threadWorkNotice(cloudDown, "idle"), CLOUD_WORKER_DOWN_MESSAGE);
  assert.doesNotMatch(CLOUD_WORKER_DOWN_MESSAGE, /[—–]/);
  assert.equal(threadWorkNotice({ ...cloudDown, cloudWorkAvailable: true }, "idle"), null);
  assert.equal(threadWorkNotice({ ...cloudDown, cloudWorkAvailable: undefined }, "idle"), null, "unknown is not down");
  assert.equal(threadWorkNotice({ ...cloudDown, executionTarget: "mac" }, "idle"), null);
  assert.equal(threadWorkNotice({ ...cloudDown, status: "paused" }, "sleeping"), null);
  assert.equal(threadWorkNotice(cloudDown, "working"), null, "a task in hand says what it is doing");
  // Older roster rows carry no target: they are cloud agents.
  assert.equal(threadWorkNotice({ cloudWorkAvailable: false, status: "active" }, "idle"), CLOUD_WORKER_DOWN_MESSAGE);
});

test("Runs on labels a Mac the way a refused task does, and says when its Mac is gone", () => {
  const host = { enabled: true, revokedAt: null, state: "online" };
  assert.equal(runsOnHostLabel(host), RUNS_ON_HOST_LABELS.online);
  assert.equal(runsOnHostLabel({ ...host, state: "idle" }), RUNS_ON_HOST_LABELS.online);
  assert.equal(runsOnHostLabel({ ...host, state: "stale" }), "Not responding");
  assert.equal(runsOnHostLabel({ ...host, state: "offline" }), "Offline");
  assert.equal(runsOnHostLabel({ ...host, enabled: false }), RUNS_ON_HOST_LABELS.switchedOff);
  for (const label of Object.values(RUNS_ON_HOST_LABELS)) assert.doesNotMatch(label, /stale/i);

  assert.equal(preferredHostGone("host_a", [{ id: "host_b" }]), true);
  assert.equal(preferredHostGone("host_a", [{ id: "host_a" }]), false);
  assert.equal(preferredHostGone(null, []), false, "no preference is not a missing Mac");
});

test("the Runs on Mac list says when it is loading or failed, and keeps itself fresh", () => {
  const panel = read("src/components/agents/agent-panel.tsx");
  const section = panel.slice(panel.indexOf("const RUNS_ON_MESSAGE = {"), panel.indexOf("function Section({ title, children }"));
  assert.match(section, /hostsState\.kind === "loading"/);
  assert.match(section, /hostsState\.kind === "failed"/);
  assert.match(section, /onClick=\{retry\}/);
  // Refetched on the shared poll, the Work sync event and tab return.
  assert.match(section, /window\.setInterval\(tick, WORK_POLL_MS\)/);
  assert.match(section, /window\.addEventListener\(WORK_SYNC_EVENT, tick\)/);
  assert.match(section, /document\.addEventListener\("visibilitychange", tick\)/);
  // A dropped poll after a good read keeps the list.
  assert.match(section, /prev\.kind === "ok" \? prev :/);
  assert.match(section, /preferredHostGone\(preferredHostId, hostsState\.hosts\)/);
  assert.match(section, /runsOnHostLabel\(host\)/);
  // A move refused for want of a named Mac opens the list; a pick sends both.
  assert.match(section, /setChoosingMac\(!saved && option === "mac"\)/);
  assert.match(section, /onSave\(\{ executionTarget: "mac", preferredHostId: id \}\)/);
});

test("the Mac's Runs on reads the agent's preferred Mac, not just 'a Mac'", () => {
  const profile = read("native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentProfile.swift");
  // Placement from preferredHostID against this Mac's host id.
  assert.match(profile, /guard let preferredHostID else \{ return \.anyMac \}\s*return preferredHostID == thisMacHostID \? \.thisMac : \.anotherMac/);
  assert.match(profile, /NativeAgentMacPlacement\.of\(\s*preferredHostID: agent\.preferredHostID,\s*thisMacHostID: thisMac\?\.hostID\s*\)/);
  // "This Mac" only for this Mac; another Mac and none are named as such.
  const title = profile.slice(profile.indexOf("static func macSegmentTitle("));
  assert.match(title.slice(0, 900), /case \.thisMac: return "This Mac"\s*case \.anotherMac: return "Another Mac"\s*case \.anyMac: return "Your Mac"/);
  assert.doesNotMatch(profile, /Text\(thisMac == nil \? "Your Mac" : "This Mac"\)/);
  // The work-off warning is for a Mac its tasks would run on; pinned to another
  // Mac it offers to move to this one, sending only the preferred Mac.
  const runsOn = profile.slice(profile.indexOf("private func runsOn("), profile.indexOf("private func footer("));
  assert.match(runsOn, /if placement == \.anotherMac \{[\s\S]*?Use this Mac instead[\s\S]*?\} else if !thisMac\.workAllowed \{[\s\S]*?Work is switched off on this Mac/);
  assert.match(runsOn, /NativeAgentPatch\(preferredHostID: hostID\)/);
  assert.match(runsOn, /if saved, target == \.mac, runsHere, let thisMac, !thisMac\.workAllowed \{/);
});

test("the native agent decodes the new fields as optional, defaulting to cloud", () => {
  const client = read("native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/NativeAgentsClient.swift");
  assert.match(client, /optionalString\(root\["executionTarget"\]\)\s*\.flatMap\(NativeAgentExecutionTarget\.init\(rawValue:\)\) \?\? \.cloud/);
  assert.match(client, /preferredHostID: optionalString\(root\["preferredHostId"\]\)/);
  const models = read("native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/NativeAgentModels.swift");
  const cases = models.slice(models.indexOf("public enum NativeAgentExecutionTarget"));
  assert.match(cases.slice(0, cases.indexOf("\n}")), /case cloud\n\s+case mac/);
});

const SHARED_SWIFT = "native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentsShared.swift";
const HEADER_SWIFT = "native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentThreadHeader.swift";
const PROFILE_SWIFT = "native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentProfile.swift";
const AGENTS_MODEL_SWIFT = "native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/NativeAgentsModel.swift";

test("the Mac and iPhone thread header says cloud work cannot start, in the web's words", () => {
  const shared = read(SHARED_SWIFT);
  // One native constant, the web's sentence verbatim.
  assert.ok(
    shared.includes(`public static let cloudWorkerDownMessage = "${CLOUD_WORKER_DOWN_MESSAGE}"`),
    "NativeAgentFormat.cloudWorkerDownMessage is not CLOUD_WORKER_DOWN_MESSAGE word for word"
  );
  // The profile's line is the same sentence.
  assert.ok(read(PROFILE_SWIFT).includes(`Text("${CLOUD_WORKER_DOWN_MESSAGE}")`));
  // threadWorkNotice's rules, in its order: paused, busy, target, heartbeat.
  const notice = shared.slice(shared.indexOf("public static func workNotice(for agent: NativeAgent, state: JunoAgentState) -> String? {"));
  assert.ok(notice.length > 0, "the native threadWorkNotice exists");
  assert.match(
    notice.slice(0, 500),
    /guard !agent\.isPaused else \{ return nil \}\s*guard state != \.working, state != \.thinking, state != \.listening else \{ return nil \}\s*guard agent\.executionTarget == \.cloud else \{ return nil \}\s*return agent\.cloudWorkAvailable == false \? cloudWorkerDownMessage : nil/
  );

  const header = read(HEADER_SWIFT);
  // Never over "needs you", like the web's `attention ? null : threadWorkNotice(...)`.
  assert.match(header, /attention \? nil : NativeAgentFormat\.workNotice\(for: agent, state: shownState\)/);
  // In place of the state sentence, in the attention ink...
  assert.match(
    header,
    /\} else if let workNotice \{\s*Text\(verbatim: workNotice\)\s*\.junoType\(JunoType\.caption\.weight\(\.medium\)\)\s*\.foregroundStyle\(Color\.junoWarningInk\)/
  );
  // ...and in what VoiceOver reads and announces.
  assert.match(header, /private var shownLine: String \{ workNotice \?\? sentence \}/);
  assert.match(header, /\.accessibilityLabel\(Text\(verbatim: "\\\(agent\.name\)\. \\\(shownLine\)\. Open profile"\)\)/);
  assert.match(header, /\.onChange\(of: shownLine\)/);
});

test("the iPhone can pick which Mac, so Your Mac is never a dead-end Pick which Mac", () => {
  const panel = read("src/components/agents/agent-panel.tsx");
  const profile = read(PROFILE_SWIFT);
  const choice = profile.slice(profile.indexOf("enum NativeAgentMacChoice {"));
  assert.ok(choice.length > 0, "the native Mac list rules exist");
  // The list's words are the web's RUNS_ON_MESSAGE, word for word.
  for (const [key, swiftName] of [
    ["anyMac", "anyMac"],
    ["pickMac", "pickMac"],
    ["checking", "checking"],
    ["noMac", "noMac"],
  ] as const) {
    const web = panel.match(new RegExp(`\\n  ${key}: ["\`]([^"\`]+)["\`],`))?.[1];
    assert.ok(web, `RUNS_ON_MESSAGE.${key} on the web`);
    const native = web.replace(/\$\{PRODUCT_NAME\}/g, "Alevr");
    assert.ok(choice.includes(`static let ${swiftName} = "${native}"`), `${swiftName} is not RUNS_ON_MESSAGE.${key}`);
  }
  // Each Mac's line is RUNS_ON_HOST_LABELS.
  for (const label of Object.values(RUNS_ON_HOST_LABELS)) {
    assert.ok(choice.includes(`"${label}"`), label);
  }
  // Where the choice can be made when nothing can be listed: not a dead end.
  assert.match(choice, /static let elsewhere = "Pick which Mac it uses in the Alevr Mac app or on the web\."/);

  // Shown on a device that is not a Mac, while it runs on a Mac or once "Your
  // Mac" is chosen there; picking sends the target and the Mac together.
  assert.match(profile, /if thisMac == nil && \(agent\.executionTarget == \.mac \|\| choosingMac\) \{\s*macList\(agent\)\s*\}/);
  assert.match(profile, /if thisMac == nil \{ choosingMac = target == \.mac \}/);
  assert.match(choice, /return NativeAgentPatch\(executionTarget: \.mac, preferredHostID: hostID\)/);
  assert.match(profile, /act\("runs-on"\) \{ await model\.update\(id: agent\.id, patch\) \}/);
  assert.match(profile, /\.task\(id: agent\.id\) \{ await model\.loadWorkHosts\(\) \}/);

  // The list is the account's Macs from the Work client, revoked ones left out.
  const model = read(AGENTS_MODEL_SWIFT);
  const load = model.slice(model.indexOf("public func loadWorkHosts() async {"));
  assert.match(load.slice(0, 600), /let hosts = try await workClient\.hosts\(for: accountID\)/);
  assert.match(load, /hosts\.filter \{ \$0\.revokedAt == nil \}/);
  assert.match(model, /workHosts = \[\]\s*workHostsLoaded = false\s*workHostsLoadFailed = false/);
});
