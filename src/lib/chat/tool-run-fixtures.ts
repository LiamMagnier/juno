/**
 * Run rows in every phase, as the wire carries them: the fixtures the surfaces
 * are built and tested against until the tool-contract and execution lanes
 * produce the real frames (TOOL_RUNTIME_DESIGN.md §7, L4 "builds against
 * fixtures").
 *
 * Each is one `kind: "tool"` activity row in the shape the design specifies:
 * the legacy fields every client already reads (`title: "Using …"`, `detail`
 * the tool id, `tool` the redacted ClientToolDetail) plus the typed record
 * `call` (chat-rework SPEC §2.4) with the design's `run` and `progress`
 * additions (§6.4). The Swift tests decode the same shapes
 * (NativeToolRunTests.swift), so a change here is a change to both.
 *
 * Dev and test only: nothing in the product imports this module.
 */

import type { ClientActivityEvent } from "@/types/chat";

const T0 = "2026-10-02T09:00:00.000Z";

const CODE_SALES = `import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv("inputs/sales.csv")
by_region = df.groupby("region")["revenue"].mean().sort_values()
print(by_region.round(2).to_string())
by_region.plot.bar(title="Average revenue by region")
plt.tight_layout()
plt.savefig("chart.png", dpi=144)
by_region.to_csv("summary.csv")`;

const CODE_KEYERROR = `import pandas as pd
df = pd.read_csv("inputs/sales.csv")
print(df.groupby("Region")["Revenue"].mean())`;

const CODE_NODE = `const lines = require("fs").readFileSync("inputs/orders.ndjson", "utf8").trim().split("\\n");
console.log(\`parsed \${lines.length} orders\`);
console.error("2 rows had no customer id");
process.exit(3);`;

const CODE_BASH = `python /skills/quarterly-summary/scripts/build.py inputs/sales.csv out.xlsx`;

type Extra = Record<string, unknown>;

function row(id: string, call: Extra, extra: Partial<ClientActivityEvent> & Extra = {}): ClientActivityEvent {
  return {
    id,
    kind: "tool",
    title: "Using Code",
    detail: String(call.tool ?? "run_code"),
    createdAt: T0,
    call: { callId: `toolu_${id}`, origin: "juno", round: 1, index: 0, startedAt: T0, ...call },
    ...extra,
  } as ClientActivityEvent;
}

const SANDBOX = { context: "hosted_sandbox" };

/** Every phase, keyed by a name the gallery and the tests share. */
export const TOOL_RUN_FIXTURES = {
  queued: row("queued", { tool: "run_code", status: "queued", args: { language: "python" }, run: { ...SANDBOX, language: "python", code: CODE_SALES } }),
  running: row("running", {
    tool: "run_code",
    status: "running",
    timeoutMs: 600_000,
    args: { language: "python", reason: "Average revenue by region, with a bar chart" },
    run: { ...SANDBOX, runId: "run_01", language: "python", code: CODE_SALES },
    progress: { seq: 3, lines: ["region", "North    18240.50", "South    21877.10"], stdoutBytes: 512, stderrBytes: 0 },
  }),
  awaitingApproval: row("approval", {
    tool: "run_code",
    status: "awaiting_approval",
    args: { language: "bash" },
    run: { ...SANDBOX, language: "bash", code: "tar -czf archive.tgz inputs/" },
    approval: { id: "rcpt_1", status: "pending", riskClass: "unknown" },
  }),
  succeeded: row("succeeded", {
    tool: "run_code",
    status: "succeeded",
    durationMs: 2_412,
    args: { language: "python", reason: "Average revenue by region, with a bar chart" },
    run: {
      ...SANDBOX,
      runId: "run_02",
      status: "succeeded",
      language: "python",
      exitCode: 0,
      durationMs: 2_412,
      code: CODE_SALES,
      stdout: { head: "region\nEast     15002.00\nNorth    18240.50\nSouth    21877.10\nWest     24410.75", omittedBytes: 0 },
      stdoutBytes: 74,
      stderrBytes: 0,
      files: [
        { attachmentId: "att_chart", name: "chart.png", mime: "image/png", bytes: 48_211, url: "/dev/tool-runs/sample/chart.png", width: 864, height: 576 },
        { attachmentId: "att_summary", name: "summary.csv", mime: "text/csv", bytes: 96, url: "/dev/tool-runs/sample/summary.csv" },
      ],
    },
  }),
  failedKeyError: row("failed", {
    tool: "run_code",
    status: "failed",
    durationMs: 1_108,
    error: { code: "tool_error", detail: "KeyError: 'Region'" },
    args: { language: "python" },
    run: {
      ...SANDBOX,
      runId: "run_03",
      status: "failed",
      language: "python",
      exitCode: 1,
      durationMs: 1_108,
      code: CODE_KEYERROR,
      stderr: {
        head: "Traceback (most recent call last):\n  File \"/work/main.py\", line 3, in <module>\n    print(df.groupby(\"Region\")[\"Revenue\"].mean())\n",
        tail: "KeyError: 'Region'",
        omittedBytes: 2_310,
        totalBytes: 2_480,
      },
      logUrl: "/dev/tool-runs/sample/log.txt",
    },
  }),
  nodeExit3: row("node", {
    tool: "run_code",
    status: "failed",
    durationMs: 640,
    args: { language: "javascript" },
    run: {
      ...SANDBOX,
      runId: "run_04",
      status: "failed",
      language: "javascript",
      exitCode: 3,
      durationMs: 640,
      code: CODE_NODE,
      stdout: { head: "parsed 1204 orders", omittedBytes: 0 },
      stderr: { head: "2 rows had no customer id", omittedBytes: 0 },
    },
  }),
  timedOut: row("timeout", {
    tool: "run_code",
    status: "failed",
    error: { code: "timeout" },
    timeoutMs: 120_000,
    durationMs: 120_000,
    args: { language: "python" },
    run: { ...SANDBOX, runId: "run_05", status: "timed_out", language: "python", durationMs: 120_000, code: "while True:\n    pass" },
  }),
  stopped: row("stopped", {
    tool: "run_code",
    status: "cancelled",
    error: { code: "cancelled" },
    durationMs: 14_020,
    args: { language: "python" },
    run: { ...SANDBOX, runId: "run_06", status: "cancelled", language: "python", durationMs: 14_020, filesDiscarded: 1, code: "import time\nfor i in range(60):\n    time.sleep(1)" },
  }),
  outcomeUnknown: row("unknown", {
    tool: "run_code",
    status: "outcome_unknown",
    args: { language: "python" },
    run: { ...SANDBOX, runId: "run_07", status: "outcome_unknown", language: "python", code: CODE_SALES },
  }),
  unavailable: row("unavailable", {
    tool: "run_code",
    status: "failed",
    error: { code: "unavailable", detail: "The sandbox isn't available right now, so nothing ran." },
    args: { language: "python" },
  }),
  missingDependency: row("polars", {
    tool: "run_code",
    status: "failed",
    durationMs: 380,
    args: { language: "python" },
    run: {
      ...SANDBOX,
      runId: "run_08",
      status: "failed",
      language: "python",
      exitCode: 1,
      durationMs: 380,
      code: "import polars as pl",
      stderr: {
        head: "ModuleNotFoundError: No module named 'polars'\nThis sandbox has no internet, so packages cannot be installed. Installed: pandas, numpy, matplotlib, openpyxl, python-docx, pypdf.",
        omittedBytes: 0,
      },
    },
  }),
  skillRead: row("skill", { tool: "use_skill", status: "running", args: { name: "quarterly-summary" } }, { title: "Using Skills", detail: "use_skill" }),
  skillFile: row(
    "skill-file",
    { tool: "read_skill_file", status: "succeeded", durationMs: 40, args: { skill: "quarterly-summary", path: "reference/style.md" } },
    { title: "Using Skills", detail: "read_skill_file" },
  ),
  skillScript: row("skill-script", {
    tool: "run_code",
    status: "succeeded",
    durationMs: 3_920,
    args: { language: "bash" },
    run: {
      ...SANDBOX,
      runId: "run_09",
      status: "succeeded",
      language: "bash",
      exitCode: 0,
      durationMs: 3_920,
      code: CODE_BASH,
      skill: { name: "quarterly-summary", slug: "quarterly-summary" },
      stdout: { head: "Wrote out.xlsx (sheet Summary, 4 regions)", omittedBytes: 0 },
      files: [{ attachmentId: "att_xlsx", name: "out.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: 6_120, url: "/dev/tool-runs/sample/out.xlsx" }],
    },
  }),
  longOutput: row("long", {
    tool: "run_code",
    status: "succeeded",
    durationMs: 8_800,
    args: { language: "python" },
    run: {
      ...SANDBOX,
      runId: "run_10",
      status: "succeeded",
      language: "python",
      exitCode: 0,
      durationMs: 8_800,
      code: "for i in range(200000):\n    print(i)",
      stdout: { head: "0\n1\n2\n3\n4", tail: "199995\n199996\n199997\n199998\n199999", omittedBytes: 5_240_000, totalBytes: 5_240_020 },
      logUrl: "/dev/tool-runs/sample/log.txt",
    },
  }),
  /** A pre-rework row: the old tool name, the legacy detail, no typed record. */
  legacyCodeInterpreter: {
    id: "legacy",
    kind: "tool",
    title: "Using Code",
    detail: "code_interpreter",
    createdAt: T0,
    tool: {
      server: "Code",
      name: "code_interpreter",
      args: JSON.stringify({ code: "print(6 * 7)" }, null, 2),
      result: "42",
      status: "ok",
      durationMs: 900,
    },
  } as ClientActivityEvent,
} satisfies Record<string, ClientActivityEvent>;

export type ToolRunFixtureName = keyof typeof TOOL_RUN_FIXTURES;
