/**
 * The chat tools' computer arguments (src/lib/chat/agent-config-tools.ts;
 * docs/design/agents-v2/COMPUTERS_2026-10.md §S1.4, fact 3): a computer that
 * could not be set up is never reported as "Enabled", raising the agent's
 * computer policy is put to the person on the card while lowering it is not,
 * and nothing about computers is declared to an account that cannot have one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { beforeEach, describe, it } from "node:test";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const errors = req("../src/lib/computer/errors") as typeof import("@/lib/computer/errors");

/** What the stubs saw. */
const seen = { approvals: [] as Array<{ toolName: string; headline: string }>, policies: [] as string[], enables: 0 };
let enableBehaviour: () => Promise<unknown> = async () => ({});
let currentPolicy = "ask";
let computerRow: { status: string } | null = null;

const AGENT_ROW = {
  id: "agent_mira",
  userId: "u1",
  name: "Mira",
  role: "Research",
  style: "warm",
  instructions: "Brief.",
  approvalMode: "balanced",
  notify: "results",
  proactive: false,
  status: "active",
  model: null,
  reasoningEffort: null,
  connectorIds: [],
  avatar: {},
  get computerPolicy() {
    return currentPolicy;
  },
  updatedAt: new Date("2026-10-28T00:00:00Z"),
};

const tools = req("../src/lib/chat/agent-config-tools") as typeof import("@/lib/chat/agent-config-tools");

// Stand-ins for the modules the create and update tools reach (a database,
// the approval broker, the computer layer), through the tools' own seam.
tools.setAgentConfigToolModulesForTest({
  prisma: {
    prisma: {
      agent: { findMany: async () => [AGENT_ROW] },
      agentComputer: { findUnique: () => ({ catch: async () => computerRow }) },
    },
  } as never,
  rateLimit: { rateLimit: async () => ({ success: true, remaining: 10, resetAt: new Date() }) } as never,
  approvals: {
    requestActionApproval: async (input: { toolName: string; args: { preview: { headline: string } } }) => {
      seen.approvals.push({ toolName: input.toolName, headline: input.args.preview.headline });
      return { approved: true, reason: "Approved." };
    },
  } as never,
  agents: {
    findAgent: async () => AGENT_ROW,
    createAgentForUser: async () => ({
      status: 201,
      body: {},
      value: { id: "agent_new", name: "Mira", role: "Research", conversationId: "conv_1" },
    }),
    createAgentRoutine: async () => ({ status: 201, value: null }),
    updateAgentForUser: async () => ({ status: 200, body: {}, value: AGENT_ROW }),
  } as never,
  computerStore: {
    enableComputer: async () => {
      seen.enables += 1;
      return enableBehaviour();
    },
    disableComputer: async () => undefined,
    resetComputer: async () => ({}),
  } as never,
  computerPolicy: {
    setComputerPolicy: async (_u: string, _a: string, policy: string) => {
      seen.policies.push(policy);
      const from = currentPolicy;
      currentPolicy = policy;
      return { from, to: policy };
    },
  } as never,
});


const base = {
  user: { id: "u1" },
  conversation: { id: "c1", projectId: null },
  userMessageId: "m1",
  untrustedContent: false,
  generationId: "g1",
};
const SNAPSHOT = {
  id: "agent_mira",
  name: "Mira",
  role: "Research",
  style: "warm",
  instructions: "Brief.",
  approvalMode: "balanced",
  notify: "results",
  proactive: false,
  status: "active",
  model: null,
  reasoningEffort: null,
  connectorIds: [] as string[],
  computerEnabled: false,
  computerPolicy: "ask",
};

beforeEach(() => {
  seen.approvals = [];
  seen.policies = [];
  seen.enables = 0;
  enableBehaviour = async () => ({});
  currentPolicy = "ask";
  computerRow = null;
});

describe("the chat tools and an agent's computer", () => {
  it("create_agent never reports Computer: Enabled after a failure", async () => {
    const plan = "Agent computers come with Pro and above. Upgrade to give Mira a computer.";
    enableBehaviour = async () => {
      throw new errors.ComputerAccessError("plan", plan, { upgradePlan: "PRO" });
    };
    const create = tools.createAgentConfigTools({ ...base, agent: null, computerConfigured: true })[0]!;
    const res = await create.execute({ name: "Mira", role: "Research", computer: true });
    const parsed = JSON.parse(res.text) as { status: string };
    assert.equal(parsed.status, "partial", "the agent was hired; its computer was not");
    const changes = res.agentChange?.changes ?? [];
    assert.deepEqual(changes.find((c) => c.label === "Computer"), { label: "Computer", to: `Not set up (${plan})` });
    assert.equal(changes.some((c) => c.label === "Computer" && c.to === "Enabled"), false);
    assert.equal(seen.enables, 1);
    assert.deepEqual(seen.policies, [], "nothing set to allowed for a computer that does not exist");

    // An unexpected failure is the fixed sentence, never the error's own words.
    enableBehaviour = async () => {
      throw new Error("connect ECONNREFUSED /var/run/docker.sock at 172.30.0.1");
    };
    const second = await create.execute({ name: "Mira", role: "Research", computer: true });
    const item = second.agentChange?.changes.find((c) => c.label === "Computer");
    assert.equal(item?.to, `Not set up (${errors.COMPUTER_NOT_RESPONDING})`);
    assert.doesNotMatch(JSON.stringify(second), /ECONNREFUSED|docker\.sock|172\.30/);

    // And when it works, it says so, and its tasks may use it.
    enableBehaviour = async () => ({});
    const ok = await create.execute({ name: "Mira", role: "Research", computer: true });
    assert.equal(JSON.parse(ok.text).status, "created");
    assert.ok(ok.agentChange?.changes.some((c) => c.label === "Computer" && c.to === "Enabled"));
    assert.deepEqual(seen.policies, ["allowed"]);
  });

  it("update_agent reports a failed enable as not set up, and says partial", async () => {
    enableBehaviour = async () => {
      throw new errors.ComputerAccessError("enabled_cap", "Your plan includes 1 agent computer, and all of them are in use. Delete one to give Mira a computer.");
    };
    const update = tools.createAgentConfigTools({ ...base, agent: SNAPSHOT, computerConfigured: true }).find((t) => t.tool.function.name === "update_agent")!;
    const res = await update.execute({ computer: "on" });
    assert.equal(JSON.parse(res.text).status, "partial");
    const computer = res.agentChange?.changes.filter((c) => c.label === "Computer") ?? [];
    assert.equal(computer.length, 1);
    assert.match(String(computer[0]!.to), /^Not set up \(Your plan includes 1 agent computer/);
  });

  it("raising the policy asks with the card, lowering does not", async () => {
    // The classification, for update_agent.
    const raise = tools.classifyAgentConfigApproval("update_agent", { computerPolicy: "allowed" }, SNAPSHOT);
    assert.equal(raise.requiresApproval, true);
    assert.equal(raise.headline, "Let Mira start its computer without asking?");
    assert.deepEqual(raise.changes, [{ label: "Computer", from: "Asks before starting", to: "Starts on its own" }]);
    const fromOff = tools.classifyAgentConfigApproval("update_agent", { computerPolicy: "ask" }, { ...SNAPSHOT, computerPolicy: "off" });
    assert.equal(fromOff.requiresApproval, true);
    assert.equal(fromOff.headline, "Let Mira ask to use a computer?");
    for (const lower of ["ask", "off"]) {
      const c = tools.classifyAgentConfigApproval("update_agent", { computerPolicy: lower }, { ...SNAPSHOT, computerPolicy: "allowed" });
      assert.equal(c.requiresApproval, false, lower);
    }
    // `computer: on` for an agent that has one is a raise to allowed, on the card.
    const on = tools.classifyAgentConfigApproval("update_agent", { computer: "on" }, { ...SNAPSHOT, computerEnabled: true, computerPolicy: "ask" });
    assert.equal(on.requiresApproval, true);
    // For create_agent: allowed is above the default and asks; ask and off do not.
    const create = tools.classifyAgentConfigApproval("create_agent", { name: "Mira", role: "R", computerPolicy: "allowed" }, null);
    assert.equal(create.requiresApproval, true);
    assert.equal(create.headline, "Let Mira start its computer without asking?");
    assert.equal(tools.classifyAgentConfigApproval("create_agent", { name: "Mira", role: "R", computerPolicy: "off" }, null).requiresApproval, false);
    // Another card for a create still shows the computer it would get.
    const routineAndComputer = tools.classifyAgentConfigApproval(
      "create_agent",
      { name: "Mira", role: "R", computer: true, routine: { name: "Daily", cadence: "daily" } },
      null,
    );
    assert.ok(routineAndComputer.changes.some((c) => c.label === "Computer" && c.to === "Enabled"));

    // Through the tool: a raise goes through requestActionApproval, a lowering does not.
    const update = tools.createAgentConfigTools({ ...base, agent: SNAPSHOT, computerConfigured: true }).find((t) => t.tool.function.name === "update_agent")!;
    const raised = await update.execute({ computerPolicy: "allowed" });
    assert.equal(JSON.parse(raised.text).status, "updated");
    assert.deepEqual(seen.approvals.map((a) => a.headline), ["Let Mira start its computer without asking?"]);
    assert.deepEqual(seen.policies, ["allowed"]);
    const lowered = await update.execute({ computerPolicy: "off" });
    assert.equal(JSON.parse(lowered.text).status, "updated");
    assert.equal(seen.approvals.length, 1, "lowering asked nothing");
    assert.deepEqual(seen.policies, ["allowed", "off"]);
    assert.ok(lowered.agentChange?.changes.some((c) => c.label === "Computer" && c.from === "Starts on its own" && c.to === "Off"));
  });

  it("computer parameters are not declared when access is not ok", async () => {
    for (const inThread of [true, false]) {
      const closed = tools.agentConfigDeclarations({ inThread, computerConfigured: false });
      for (const decl of [closed.create, closed.update]) {
        const props = (decl.function.parameters as { properties: Record<string, unknown> }).properties;
        assert.equal("computer" in props, false);
        assert.equal("computerPolicy" in props, false);
      }
      const open = tools.agentConfigDeclarations({ inThread, computerConfigured: true });
      for (const decl of [open.create, open.update]) {
        const props = (decl.function.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
        assert.deepEqual(props.computerPolicy?.enum, ["off", "ask", "allowed"]);
      }
    }
    // A model reaching past its declarations is refused with the account's own sentence.
    const [create] = tools.createAgentConfigTools({
      ...base,
      agent: null,
      computerConfigured: false,
      computerAccessMessage: "Computers are in early access and aren’t open to your account.",
    });
    const res = await create!.execute({ name: "Mira", role: "R", computerPolicy: "allowed" });
    const parsed = JSON.parse(res.text) as { status: string; reason: string; message: string };
    assert.equal(parsed.status, "refused");
    assert.equal(parsed.reason, "computers_unavailable");
    assert.equal(parsed.message, "Computers are in early access and aren’t open to your account.");
    assert.equal(seen.enables, 0);
    // The chat turn declares them from the account's access, not the provider alone.
    const turnTools = readFileSync(new URL("../src/lib/chat/turn/tools.ts", import.meta.url), "utf8");
    assert.match(turnTools, /computerAccessFor\(user\.id\)/);
    assert.match(turnTools, /computerConfigured: access\.ok/);
    assert.doesNotMatch(turnTools, /isAgentComputerConfigured/);
  });
});
