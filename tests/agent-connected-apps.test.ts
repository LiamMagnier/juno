import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isInternalConnectionProvider,
  summarizeConnectors,
  taskConnectorAllowance,
  type WorkConnectorCandidate,
} from "@/lib/work/connectors";
import { taskToolConnectorIds } from "@/lib/chat/task-tool";

/*
 * Connected apps, Composio's included, as an Orbit agent may use them.
 *
 * A connected Composio app is a `Connection` row `composio:<slug>`, served to
 * chat and to Work runs alike by `getActiveConnectors` (src/lib/mcp.ts) through
 * Juno's own MCP proxy with a short-lived signed token. In a run it goes
 * through the token broker, the data-scope write gate and the admission gate
 * like any connector (scripts/work-runner.ts `openConnectors`), and the run's
 * approval policy decides its writes.
 *
 * `Agent.connectorIds` ("Connected apps it may use") is the per-agent scope.
 * It was honoured where an agent's task is dispatched (`startAgentTask`,
 * routines, a hand-over), and missed in two places that are closed here:
 *  - `start_task` in the agent's own thread handed its task the turn's apps,
 *    which the composer lets the person set to any linked app;
 *  - a run of an agent's session that never chose its apps reached every app
 *    on the account.
 * And one inventory bug: Composio's hidden directory row was evaluated as a
 * linked connector with a dead credential on every such run.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const gmail = "composio:gmail";
const slack = "composio:slack";
const github = "github";

test("a task started in an agent's thread reaches only the turn's apps the agent may use", () => {
  assert.deepEqual(taskToolConnectorIds([gmail, slack, github, gmail], [gmail, github]), [gmail, github]);
  // Intersected: an agent's app the turn did not carry is not added.
  assert.deepEqual(taskToolConnectorIds([gmail], [gmail, slack]), [gmail]);
  // An agent with no apps hands its task none.
  assert.deepEqual(taskToolConnectorIds([gmail, slack], []), []);
  // Outside an agent's thread: the turn's apps, deduplicated and bounded.
  assert.deepEqual(taskToolConnectorIds([gmail, slack, gmail], null), [gmail, slack]);
  const many = Array.from({ length: 40 }, (_, i) => `composio:app${i}`);
  assert.equal(taskToolConnectorIds(many, null).length, 32);
  assert.equal(taskToolConnectorIds(many, many).length, 32);
});

test("start_task reads the agent's apps fresh and narrows the task to them", () => {
  const source = read("src/lib/chat/task-tool.ts");
  const start = source.slice(source.indexOf("async function startTask("));
  const body = start.slice(0, start.indexOf("\n}\n"));
  assert.match(body, /select: \{ status: true, executionTarget: true, preferredHostId: true, connectorIds: true \}/);
  assert.match(body, /agentConnectorIds = agentRow\.connectorIds;/);
  assert.match(body, /connectorIds: taskToolConnectorIds\(ctx\.connectorIds, agentConnectorIds\),/);
});

test("a run's task layer: the session's own choice, else its agent's apps, else unrestricted", () => {
  // Chosen is read as chosen: a task the person approved keeps what it was
  // approved with (updateAgentForUser leaves non-routine sessions alone).
  assert.deepEqual(taskConnectorAllowance({ chosen: [gmail], agentConnectorIds: [github] }), [gmail]);
  assert.deepEqual(taskConnectorAllowance({ chosen: [], agentConnectorIds: [github] }), []);
  // Never chose, and an agent's: the agent's apps.
  assert.deepEqual(taskConnectorAllowance({ chosen: null, agentConnectorIds: [gmail, gmail] }), [gmail]);
  assert.deepEqual(taskConnectorAllowance({ chosen: null, agentConnectorIds: [] }), []);
  // Never chose, nobody's: unrestricted, as before.
  assert.equal(taskConnectorAllowance({ chosen: null, agentConnectorIds: null }), null);
});

test("an agent's unchosen run reaches its own Composio app and nothing else on the account", () => {
  const scope = { reads: ["anything"], writes: ["anything"], sensitivity: "confidential" as const, egress: "third_party" as const };
  const candidates: WorkConnectorCandidate[] = [gmail, slack, github].map((id) => ({
    descriptor: { id, label: id, locality: "cloud", configured: true, intents: [], scope },
    state: { linked: true, credentialUsable: true },
  }));
  const verdicts = summarizeConnectors(candidates, {
    taskAllowed: taskConnectorAllowance({ chosen: null, agentConnectorIds: [gmail] }),
  });
  assert.deepEqual(verdicts.filter((v) => v.available).map((v) => v.connectorId), [gmail]);
  // A policy narrowing, so it is recorded, and named as the narrowest one.
  for (const refused of verdicts.filter((v) => !v.available)) {
    assert.equal(refused.reason, "not_selected_for_task");
    assert.equal(refused.audit?.kind, "policy_narrowed");
  }
});

test("the runner applies the agent's apps to a session that never chose", () => {
  const runner = read("scripts/work-runner.ts");
  const open = runner.slice(runner.indexOf("async function openConnectors("));
  const body = open.slice(0, open.indexOf("\n}\n"));
  assert.match(body, /select: \{ agentId: true, connectorsChosen: true, connectors: \{ select: \{ connectorId: true \} \} \}/);
  // Scoped to the person and to a live agent; read only when it can matter.
  assert.match(
    body,
    /session\?\.agentId && !session\.connectorsChosen\s*\?\s*await prisma\.agent\.findFirst\(\{\s*where: \{ id: session\.agentId, userId: input\.userId, deletedAt: null \},\s*select: \{ connectorIds: true \},/
  );
  assert.match(body, /taskAllowed: taskConnectorAllowance\(\{/);
  // Everything after the verdicts is unchanged: the broker, the write gate and
  // the admission gate still stand between a run and any connector.
  assert.ok(body.indexOf("taskConnectorAllowance(") < body.indexOf("summarizeConnectors(candidates, allowlist)"));
  assert.match(body, /new WorkTokenBroker\(\)/);
  assert.match(body, /if \(access !== "read" && !owner\.mayWrite\)/);
  assert.match(body, /admitConnectorResult\(/);
});

test("Composio's hidden directory row is not an app, so a run never reports it", () => {
  const composio = read("src/lib/composio.ts");
  const provider = /const DIRECTORY_PROVIDER = "([^"]+)";/.exec(composio)?.[1];
  assert.ok(provider);
  assert.equal(isInternalConnectionProvider(provider), true);
  // No id a person links is internal.
  for (const id of [gmail, "composio:_1password", github, "google-calendar", "mcp:abcdefghij", "user_mcp:row1"]) {
    assert.equal(isInternalConnectionProvider(id), false, id);
  }
  const runner = read("scripts/work-runner.ts");
  assert.match(runner, /\.filter\(\(row\) => !isInternalConnectionProvider\(row\.provider\)\);/);
});

test("connected Composio apps reach chat and runs through Juno's proxy, never with Composio's key", () => {
  const mcp = read("src/lib/mcp.ts");
  assert.match(mcp, /if \(!slug \|\| row\.scope !== "composio:active" \|\| !isComposioConfigured\(\)\) continue;/);
  assert.match(mcp, /mcpUrl: `\$\{env\.appUrl\.replace\(\/\\\/\$\/, ""\)\}\/api\/mcp\/composio\/\$\{encodeURIComponent\(slug\)\}`/);
  assert.match(mcp, /headers: \{ Authorization: `Bearer \$\{mintConnectorToken\(userId, row\.provider\)\}` \}/);
  const proxy = read("src/app/api/mcp/composio/[slug]/route.ts");
  // The token names the app and the person; the session is that person's.
  assert.match(proxy, /payload\.connectorId !== composioAppId\(slug\)/);
  assert.match(proxy, /getComposioExecutionSession\(payload\.userId, slug\)/);
  assert.match(proxy, /redirect: "manual"/);
});
