import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The agent-computer docs said dangerous things (docs/design/agents-v2/
 * COMPUTERS_2026-10.md fact 15, fact 16, S2.8): a kill switch that filtered a
 * label no container carries, so in an incident it removed nothing; volume
 * names that do not exist; and a 30-day retention "default" that, copied into
 * a production env file, would have started deleting people's files and
 * sign-ins with no owner decision. These hold the corrections in place.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = {
  operations: "docs/design/agents-v2/OPERATIONS.md",
  rules: "docs/design/agents-v2/RULES.md",
  brief: "docs/design/agents-v2/BRIEF.md",
  infra: "docs/design/agents-v2/INFRA.md",
  progress: "docs/design/agents-v2/PROGRESS.md",
  agents: "docs/design/AGENTS.md",
} as const;
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

test("the kill switch filters label=app=juno, the label the provider and the broker use", () => {
  const operations = read(DOCS.operations);
  assert.match(operations, /docker ps -aq --filter label=app=juno --filter name=juno-agent- \| xargs -r docker rm -f/);
  for (const [name, file] of Object.entries(DOCS)) {
    assert.doesNotMatch(read(file), /label=juno\.computer=1/, `${name} still filters a label no container carries`);
  }
  // The label in the doc is the one the code applies and the broker lists by.
  assert.match(read("src/lib/computer/docker.ts"), /"--label",\s*"app=juno"/);
  assert.match(read("deploy/agent-computers/docker-broker.py"), /label=app=juno/);
});

test("operations names the volumes juno-agent-<id> and juno-agent-<id>-browser", () => {
  const operations = read(DOCS.operations);
  assert.match(operations, /juno-agent-<agentId>`/);
  assert.match(operations, /juno-agent-<agentId>-browser/);
  for (const [name, file] of Object.entries(DOCS)) {
    if (name === "brief" || name === "progress" || name === "infra") continue; // records, annotated where wrong
    assert.doesNotMatch(read(file), /juno-comp-/, `${name} names a volume that does not exist`);
  }
});

test("no doc presents a 30-day retention default as current", () => {
  const superseded = /Superseded|Never shipped|ignored|never read/i;
  for (const [name, file] of Object.entries(DOCS)) {
    read(file)
      .split("\n")
      .forEach((line, index) => {
        const thirtyDayRetention =
          /COMPUTER_RETENTION_DAYS[^\n]*\b30\b/.test(line) ||
          (/\b30[- ]days?\b/i.test(line) && /retention|asleep|destroy|cleared|deleted/i.test(line));
        if (thirtyDayRetention) {
          assert.match(line, superseded, `${name}:${index + 1} presents a 30-day retention as current: ${line.trim()}`);
        }
      });
  }
  const operations = read(DOCS.operations);
  assert.match(operations, /Computers are never deleted for age\s+unless the owner turns\s+retention on/);
  assert.match(operations, /AGENT_COMPUTER_RETENTION_ENFORCE=1/);
  assert.match(operations, /The old `COMPUTER_RETENTION_DAYS` is\s+ignored, even if set/);
  assert.match(read(DOCS.rules), /\| `AGENT_COMPUTER_RETENTION_ENFORCE` \| empty \(off\) \|/);
});

test("the docs name the computer tools and chat tools that exist, and no desktop session", () => {
  const agents = read(DOCS.agents);
  for (const gone of ["manage_agent_computer", "computer_bash", "computer_open_url", "computer_move", "XFCE"]) {
    assert.ok(!agents.includes(gone), `AGENTS.md still names ${gone}`);
  }
  const tools = read("runner/agent-core/src/work/computer-tools.ts");
  for (const named of agents.match(/`computer_[a-z]+`/g) ?? []) {
    assert.ok(tools.includes(`'${named.slice(1, -1)}'`), `AGENTS.md names ${named}, which computer-tools.ts does not define`);
  }
  assert.match(read(DOCS.infra).slice(0, 1200), /Historical \(superseded October 2026\)/);
  const progress = read(DOCS.progress);
  for (const line of progress.split("\n").filter((l) => /computer-docker-smoke|computer-loop\.test/.test(l))) {
    assert.match(line, /Correction/, `PROGRESS.md cites a test that does not exist without saying so: ${line.slice(0, 120)}`);
  }
});

test("operations says computers are off in production and gives the image label the code requires", () => {
  const operations = read(DOCS.operations);
  assert.match(operations, /\*\*Status \(October 2026\): off in production\.\*\*/);
  const label = /COMPUTER_IMAGE_SECURITY_LABEL = "([^"]+)"/.exec(read("src/lib/computer/docker.ts"))?.[1];
  assert.ok(label);
  assert.ok(operations.includes(`juno.security=${label}`), `OPERATIONS.md names another image label than ${label}`);
  assert.ok(read("deploy/agent-computers/Dockerfile").includes(`LABEL juno.security="${label}"`));
});
