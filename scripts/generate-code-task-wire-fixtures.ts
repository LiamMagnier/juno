/**
 * Emit the Code task wire fixtures the Swift decoder is tested against.
 *
 * The fixtures are produced by the SERVER's own `serializeTask`
 * (src/lib/code-task-wire.ts) on purpose: the Swift test then proves that what
 * this server actually hands a Mac decodes into the fields the Mac runs with. A
 * hand-written Swift fixture only proves Swift agrees with itself — and that is
 * exactly how a device task's model went missing: the fixture carried
 * `modelId`, the decoder read `modelId`, and the server sent no model at all.
 *
 *   npx tsx scripts/generate-code-task-wire-fixtures.ts           # write
 *   npx tsx scripts/generate-code-task-wire-fixtures.ts --check   # exit 1 on drift
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CodeTask } from "@prisma/client";

import { serializeTask } from "../src/lib/code-task-wire";

export const TASK_WIRE_FIXTURE_PATH =
  "native/Packages/JunoNativeKit/Tests/JunoCodeKitTests/Fixtures/code-task-wire.json";

const at = new Date("2026-09-30T10:00:00.000Z");

/** Every column of a CodeTask row, at the values a new device task has. */
function row(overrides: Partial<CodeTask>): CodeTask {
  return {
    id: "task-device",
    userId: "user-1",
    deviceId: "device-1",
    workspacePath: "/Users/me/juno",
    workspaceName: "juno",
    workspaceKey: "workspace-key",
    title: "Fix the login bug",
    prompt: "Fix the login bug in the sign-in form.",
    status: "queued",
    lastSeq: 0,
    conversationId: "conversation-1",
    parentSessionId: null,
    createsNewSession: true,
    origin: "web",
    idempotencyKey: null,
    target: "device",
    repoOwner: null,
    repoName: null,
    baseRef: null,
    prUrl: null,
    branch: null,
    prNumber: null,
    model: null,
    reasoningEffort: null,
    roleRouting: null,
    environmentId: null,
    permissionMode: null,
    skills: null,
    runnerClaimedAt: null,
    scheduleId: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/**
 * The shapes a host meets, named for what each one proves on the Swift side.
 * Keys are stable: the Swift test looks fixtures up by them.
 */
export function taskWireFixtures(): Record<string, unknown> {
  return {
    // The web composer's model picker and thinking slider, on a Mac run.
    deviceTaskWithModel: serializeTask(
      row({ model: "claude-sonnet-5", reasoningEffort: "high" }),
    ),
    // Alevr Code v2 role routing: the orchestrator on the user's own Claude
    // subscription, a worker on Alevr's engine. `model` mirrors nothing here
    // (the orchestrator is not an Alevr-engine model), so a pre-v2 host falls
    // back as for "no preference".
    deviceTaskWithRouting: serializeTask(
      row({
        id: "task-routed",
        roleRouting: {
          preset: "lead-workers",
          orchestrator: { instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: "high" },
          workers: [{ instanceId: "alevr", model: "openai:gpt-6.1-sol", effort: "medium", contextTokens: 272000 }],
          budget: { maxUsd: 5 },
        },
      }),
    ),
    // No preference: the host keeps its own first-available fallback.
    deviceTaskWithoutPreferences: serializeTask(row({ id: "task-plain", origin: "phone" })),
    // A cloud run, which carries a mode and an environment and no device.
    cloudTask: serializeTask(
      row({
        id: "task-cloud",
        deviceId: null,
        workspacePath: "",
        workspaceKey: null,
        target: "cloud",
        repoOwner: "liam",
        repoName: "juno",
        baseRef: "main",
        branch: "juno/cloud-task",
        prUrl: "https://github.com/liam/juno/pull/7",
        prNumber: 7,
        status: "done",
        model: "gpt-5.2",
        reasoningEffort: "medium",
        environmentId: "env-1",
        permissionMode: "auto-edit",
      }),
    ),
    // The run list's shape: no prompt, plus the read-time file count.
    listRow: serializeTask(row({ id: "task-list", status: "running" }), {
      includePrompt: false,
      changedFileCount: 3,
    }),
  };
}

export function renderTaskWireFixtures(): string {
  return `${JSON.stringify(taskWireFixtures(), null, 2)}\n`;
}

// Run only as a script, never when a test imports the fixtures.
if (process.argv[1] && resolve(process.argv[1]).endsWith("generate-code-task-wire-fixtures.ts")) {
  const target = resolve(process.cwd(), TASK_WIRE_FIXTURE_PATH);
  const next = renderTaskWireFixtures();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = "";
    }
    if (current !== next) {
      console.error(
        `[code-task-wire] ${TASK_WIRE_FIXTURE_PATH} is stale: serializeTask changed without it. ` +
          "Run: npx tsx scripts/generate-code-task-wire-fixtures.ts",
      );
      process.exit(1);
    }
    console.log("[code-task-wire] Swift fixtures match serializeTask.");
  } else {
    writeFileSync(target, next, "utf8");
    console.log(`Wrote ${TASK_WIRE_FIXTURE_PATH}`);
  }
}
