import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/*
 * The cloud Work runner must never hand a model a tool that runs on the host.
 *
 * `ToolContext.containerSandbox` says of itself: "Absent means the command runs
 * directly on the host, which is correct for a local developer session and not
 * for the cloud runner." `WorkSessionOptions` has no field for it, so the
 * `ToolContext` a Work session builds can never set one — there is no way to
 * sandbox a host tool in a cloud run, and no per-run container to point at yet.
 *
 * What stands between that and a shell running unsandboxed on the worker is a
 * single call to `withoutHostWorkspaceTools` at the end of `buildTools`. That
 * is a good guard and an invisible one: nothing fails if a later change appends
 * a tool after the filter, returns early, or drops the call while adding a
 * capability. The type system cannot express "this array contains no host
 * tool", so it is expressed here instead.
 *
 * This is deliberately a *source* check rather than a unit test. `buildTools`
 * lives in `scripts/work-runner.ts`, which ends in `void main()` and would
 * start a queue worker if a test imported it.
 *
 * If Work ever gains a real per-run container, the fix is to plumb
 * `containerSandbox` through `WorkSessionOptions` and relax this — not to
 * delete it.
 */

const root = process.cwd();

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`missing required file: ${relativePath}`);
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const runner = read("scripts/work-runner.ts");

// 1. `buildTools` must return through the filter, not merely mention it.
const buildTools = runner.slice(runner.indexOf("function buildTools"));
if (!buildTools.startsWith("function buildTools")) {
  fail("scripts/work-runner.ts no longer defines buildTools; this check needs updating.");
}
const body = buildTools.slice(0, buildTools.indexOf("\n}\n") + 3);
if (!/return\s+runtime\.withoutHostWorkspaceTools\(/.test(body)) {
  fail(
    "buildTools no longer *returns through* runtime.withoutHostWorkspaceTools(...).\n" +
      "     A cloud Work run has no container to sandbox a host tool in — see\n" +
      "     ToolContext.containerSandbox — so the filter is the only thing keeping\n" +
      "     read_file/write_file/bash off a worker that holds provider credentials."
  );
}

// 2. Nothing may be appended to the toolset after the filter has run.
const afterFilter = body.slice(body.indexOf("withoutHostWorkspaceTools"));
if (/\]\s*\)\s*[,.]?\s*concat\(|\.push\(/.test(afterFilter)) {
  fail("buildTools appends to the toolset after filtering; the filter must be last.");
}

// 3. The filter itself must still strip every host workspace tool.
const tools = read("runner/agent-core/src/work/tools.ts");
if (!/hostWorkspaceNames\.has\(tool\.spec\.name\)/.test(tools)) {
  fail(
    "withoutHostWorkspaceTools no longer filters by workspaceTools() names, so it\n" +
      "     may no longer remove what it claims to."
  );
}

// 4. And the sandbox field must still be absent from the session options — the
//    day it is present, this check should be revisited rather than trusted.
const session = read("runner/agent-core/src/work/session.ts");
if (/containerSandbox/.test(session)) {
  fail(
    "WorkSessionOptions now mentions containerSandbox. If Work has gained a real\n" +
      "     per-run container, plumb it through and relax this check deliberately."
  );
}

// 5. `computer-tools.ts` and `src/lib/computer/**` must not import `tools/bash`,
//    `bashTool`, `node:child_process` or `container-sandbox`, and must not
//    reference `ctx.cwd` or `ctx.env`.
const computerDir = path.join(root, "src/lib/computer");
const computerFiles = [
  "runner/agent-core/src/work/computer-tools.ts",
  ...(fs.existsSync(computerDir)
    ? fs
        .readdirSync(computerDir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => path.join("src/lib/computer", f))
    : []),
];
for (const rel of computerFiles) {
  const src = read(rel);
  if (/tools\/bash|\bbashTool\b|node:child_process|container-sandbox/.test(src)) {
    fail(`${rel} imports or references a host shell/sandbox module (tools/bash, bashTool, node:child_process, or container-sandbox).`);
  }
  if (/\bctx\.cwd\b|\bctx\.env\b/.test(src)) {
    fail(`${rel} references ctx.cwd or ctx.env, which point at the worker host rather than the agent container.`);
  }
}

// 6. Every tool named `computer_*` in the Work runtime is built by `computerTools(`.
const computerToolsSrc = read("runner/agent-core/src/work/computer-tools.ts");
const computerFnIdx = computerToolsSrc.indexOf("export function computerTools(");
if (computerFnIdx === -1) {
  fail("runner/agent-core/src/work/computer-tools.ts must define export function computerTools(...).");
}
const computerFnBody = computerToolsSrc.slice(computerFnIdx);
const declaredRemoteNames = [
  ...computerToolsSrc
    .slice(0, computerFnIdx)
    .matchAll(/'(computer_[a-z_]+)'/g),
].map((m) => m[1]);
if (declaredRemoteNames.length === 0) {
  fail("REMOTE_TOOL_NAMES in computer-tools.ts is empty.");
}
for (const toolName of declaredRemoteNames) {
  if (!new RegExp(`name:\\s*['"]${toolName}['"]`).test(computerFnBody)) {
    fail(`Tool ${toolName} is not built inside computerTools(...).`);
  }
}
if (/name:\s*['"]computer_[a-z_]+['"]/.test(tools)) {
  fail("runner/agent-core/src/work/tools.ts must not define any computer_* tool; all computer_* tools must be built by computerTools(.");
}
if (!/runtime\.computerTools\(/.test(body)) {
  fail("buildTools in scripts/work-runner.ts must build computer_* tools via runtime.computerTools(...).");
}

// 7. The `REMOTE_TOOL_NAMES` list is disjoint from the `workspaceTools()` names.
const workspaceFnIdx = tools.indexOf("export function workspaceTools(");
const workspaceSection = workspaceFnIdx >= 0 ? tools.slice(workspaceFnIdx) : tools;
const hostWorkspaceToolNames = new Set(
  [...workspaceSection.matchAll(/name:\s*['"]([a-z_]+)['"]/g)].map((m) => m[1])
);
// Also include defaultTools() names from runner/agent-core/src/tools/
for (const hostName of ["bash", "read_file", "write_file", "edit_file", "glob", "grep", "list_dir"]) {
  hostWorkspaceToolNames.add(hostName);
}
for (const remoteName of declaredRemoteNames) {
  if (hostWorkspaceToolNames.has(remoteName)) {
    fail(`REMOTE_TOOL_NAMES entry "${remoteName}" collides with a workspaceTools() name.`);
  }
}

console.log(
  "[work-sandbox] the cloud Work toolset admits no host tool, and computer_* tools are isolated from host workspace tools"
);

