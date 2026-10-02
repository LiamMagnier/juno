import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/*
 * THE HOSTED EXECUTION RUNTIME AGAINST A REAL juno-exec AND POSTGRES.
 *
 * Every run here executes in the real sandbox image on Docker Desktop through
 * the real broker (deploy/exec-host/local/run-local.sh), and every record is
 * read back from a throwaway database. Nothing is mocked: the runtime's own
 * client, store, capture, sweep and metering run as they would in production.
 *
 * Covers V1 (CSV → numbers + a PNG attachment), V4 (Node and bash exiting 3
 * with both streams), V5 (replay, 5 MB of output, Stop, a backend killed
 * mid-run, a run the host lost), V6 (missing module, private, lockdown, sandbox
 * down) and the check_run hand-over.
 *
 * Skipped unless all three are set (never falls back to DATABASE_URL):
 *   EXEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/<throwaway db> (migrated)
 *   EXEC_TEST_URL=http://127.0.0.1:3178
 *   EXEC_TEST_TOKEN_FILE=<the local profile's token file>
 * Run with:
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test tests/exec-runtime.integration.test.ts
 */

const DB_URL = process.env.EXEC_TEST_DATABASE_URL;
const HOST = process.env.EXEC_TEST_URL;
const TOKEN_FILE = process.env.EXEC_TEST_TOKEN_FILE;

if (!DB_URL || !HOST || !TOKEN_FILE) {
  test("exec runtime integration suite is skipped without EXEC_TEST_DATABASE_URL, EXEC_TEST_URL and EXEC_TEST_TOKEN_FILE", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "exec-runtime-test-secret";
  process.env.TOOL_RUNTIME = "1";
  process.env.CODE_INTERPRETER_URL = HOST;
  process.env.CODE_INTERPRETER_TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const SALES = "region,revenue\nNorth,120\nSouth,80\nNorth,180\nEast,50\nSouth,100\nEast,70\n";
  const expected = { East: 60, North: 150, South: 90 };

  async function seed() {
    const { putObject } = await import("@/lib/storage");
    const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const user = await prisma.user.create({
      data: { email: `exec-${suffix}@example.invalid`, name: "Exec tester", emailVerified: new Date() },
    });
    const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Sales" } });
    const key = `test/${suffix}/sales.csv`;
    await putObject(key, Buffer.from(SALES), "text/csv");
    await prisma.attachment.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        kind: "FILE",
        fileName: "sales.csv",
        mimeType: "text/csv",
        size: Buffer.byteLength(SALES),
        storageKey: key,
        parserState: "ready",
      },
    });
    return { user, conversation };
  }

  function ctx(f: Awaited<ReturnType<typeof seed>>, overrides: Record<string, unknown> = {}) {
    return {
      surface: "chat" as const,
      userId: f.user.id,
      sessionId: `gen-${randomBytes(6).toString("hex")}`,
      callId: `call_${randomBytes(6).toString("hex")}`,
      conversationId: f.conversation.id,
      projectId: null,
      vision: true,
      lockdown: false,
      ...overrides,
    };
  }

  async function hostRunsStarted(): Promise<number> {
    const { JunoExecClient } = await import("@/lib/exec/client");
    const { execEndpoint } = await import("@/lib/exec/config");
    const health = await new JunoExecClient(execEndpoint()!).health();
    return health.runsStarted ?? -1;
  }

  test("V1: a CSV becomes computed numbers and a PNG attachment the model is shown", async () => {
    const { executeRunCode } = await import("@/lib/exec/runtime");
    const f = await seed();
    const outcome = await executeRunCode(
      {
        code: [
          "import json, pandas as pd, matplotlib.pyplot as plt",
          "df = pd.read_csv('inputs/sales.csv')",
          "avg = df.groupby('region')['revenue'].mean().sort_index()",
          "print(json.dumps({k: float(v) for k, v in avg.items()}))",
          "avg.plot.bar(title='Average revenue by region'); plt.tight_layout(); plt.savefig('revenue_by_region.png')",
        ].join("\n"),
        reason: "average revenue by region",
      },
      ctx(f),
    );
    assert.equal(outcome.status, "succeeded", outcome.text);
    assert.equal(outcome.run?.exitCode, 0);
    assert.equal(outcome.run?.context, "hosted_sandbox");
    const printed = JSON.parse(/\{.*\}/.exec(outcome.text)![0]) as Record<string, number>;
    assert.deepEqual(printed, expected, "the numbers are the test's own computation");
    const rows = await prisma.toolRun.findMany({ where: { userId: f.user.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "succeeded");
    assert.equal(rows[0].exitCode, 0);
    const png = await prisma.attachment.findFirst({ where: { userId: f.user.id, origin: "tool_output" } });
    assert.ok(png, "the chart is an attachment");
    assert.equal(png.mimeType, "image/png");
    assert.equal(png.kind, "IMAGE");
    assert.equal(png.conversationId, f.conversation.id);
    const { getObjectBytes } = await import("@/lib/storage");
    const sharp = (await import("sharp")).default;
    const meta = await sharp(Buffer.from((await getObjectBytes(png.storageKey)).bytes)).metadata();
    assert.ok((meta.width ?? 0) > 0 && (meta.height ?? 0) > 0, "the PNG decodes to real dimensions");
    assert.equal(png.width, meta.width);
    assert.equal(outcome.images?.length, 1, "the image goes back to the model in the tool round");
    assert.equal(outcome.images![0].mimeType, "image/png");
    assert.match(outcome.text, /revenue_by_region\.png \(image\/png/);
    assert.match(outcome.text, /no internet access and no access to the user's computer/);
    const spend = await prisma.apiSpend.findFirst({ where: { userId: f.user.id, model: "juno-tool:run_code" } });
    assert.ok(spend && spend.costMicroUsd > 0, "the run is metered once");
  });

  test("V4: Node and bash programs that write both streams and exit 3 are recorded as failed with exit 3", async () => {
    const { executeRunCode } = await import("@/lib/exec/runtime");
    const { readTail } = await import("@/lib/exec/store");
    const f = await seed();
    for (const [language, code] of [
      ["javascript", "console.log('to stdout from node'); console.error('to stderr from node'); process.exit(3);"],
      ["bash", "echo 'to stdout from bash'; echo 'to stderr from bash' >&2; exit 3"],
    ] as const) {
      const outcome = await executeRunCode({ language, code }, ctx(f));
      assert.equal(outcome.status, "failed", outcome.text);
      assert.equal(outcome.run?.exitCode, 3);
      assert.equal(outcome.run?.status, "failed");
      assert.match(outcome.text, /FAILED: exit code 3/);
      assert.match(outcome.text, new RegExp(`stdout:\\nto stdout from ${language === "bash" ? "bash" : "node"}`));
      assert.match(outcome.text, new RegExp(`stderr:\\nto stderr from ${language === "bash" ? "bash" : "node"}`));
      assert.match(outcome.text, /Alevr's sandbox/);
      const row = await prisma.toolRun.findUniqueOrThrow({ where: { id: outcome.run!.toolRunId } });
      assert.equal(row.exitCode, 3);
      assert.equal(row.status, "failed");
      assert.equal(row.context, "hosted_sandbox");
      assert.equal(row.language, language);
      assert.match(readTail(row.stdoutTail).head, /to stdout/);
      assert.match(readTail(row.stderrTail).head, /to stderr/);
      assert.ok(row.stdoutTail?.startsWith("enc:"), "the tails are encrypted at rest");
      assert.ok(row.code.startsWith("enc:"), "the code is encrypted at rest");
    }
  });

  test("V5: re-dispatching the same session and call returns the stored result; the host counts one run", async () => {
    const { executeRunCode } = await import("@/lib/exec/runtime");
    const f = await seed();
    const context = ctx(f);
    const before = await hostRunsStarted();
    const first = await executeRunCode({ code: "print(6 * 7)" }, context);
    const second = await executeRunCode({ code: "print(6 * 7)" }, context);
    assert.equal(first.status, "succeeded");
    assert.equal(second.status, "succeeded");
    assert.equal(second.replayed, true);
    assert.match(second.text, /was not run again/);
    assert.equal(first.run?.toolRunId, second.run?.toolRunId);
    assert.equal(await hostRunsStarted(), before + 1, "one container for two dispatches");
    assert.equal(await prisma.toolRun.count({ where: { sessionId: context.sessionId } }), 1);
    // The host's event feed for the same run: the output, then the end.
    const { JunoExecClient } = await import("@/lib/exec/client");
    const { execEndpoint } = await import("@/lib/exec/config");
    const events = [];
    for await (const event of new JunoExecClient(execEndpoint()!).events(first.run!.runId!)) events.push(event);
    assert.ok(events.some((event) => "text" in event && event.text.includes("42")));
    assert.deepEqual(events.at(-1), { end: true, status: "succeeded", exitCode: 0 });
  });

  test("V5: 5 MB of output gives the model head, tail and a paging note, and the full log is stored", async () => {
    const { executeRunCode, executeCheckRun } = await import("@/lib/exec/runtime");
    const f = await seed();
    const context = ctx(f);
    const outcome = await executeRunCode(
      { code: "import sys\nfor i in range(100000):\n    print(f'line {i:06d} ' + 'x' * 40)\nprint('Traceback-like tail marker', file=sys.stderr)\n" },
      context,
    );
    assert.equal(outcome.status, "succeeded", outcome.text.slice(0, 500));
    assert.ok((outcome.run?.stdoutBytes ?? 0) > 4_900_000);
    assert.match(outcome.text, /line 000000/, "head");
    assert.match(outcome.text, /line 099999/, "tail");
    assert.match(outcome.text, /omitted here/);
    assert.match(outcome.text, /call check_run with run_id "[a-z0-9]+", stream "stdout" and offset \d+/);
    assert.ok(outcome.text.length < 40_000, "the model is not handed five megabytes");
    const row = await prisma.toolRun.findUniqueOrThrow({ where: { id: outcome.run!.toolRunId } });
    assert.ok(row.logKey, "the full log is stored");
    const { getObjectBytes } = await import("@/lib/storage");
    const log = Buffer.from((await getObjectBytes(`${row.logKey}stdout.log`)).bytes);
    assert.equal(log.byteLength, row.stdoutBytes);
    const page = await executeCheckRun({ run_id: row.id, stream: "stdout", offset: 2_500_000 }, context);
    assert.equal(page.status, "succeeded");
    assert.match(page.text, /line 0\d{5}/);
    assert.match(page.text, /Next page: check_run/);
  });

  test("V5: Stop kills the container and leaves no success claim", async () => {
    const { executeRunCode } = await import("@/lib/exec/runtime");
    const { JunoExecClient } = await import("@/lib/exec/client");
    const { execEndpoint } = await import("@/lib/exec/config");
    const f = await seed();
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 4000);
    const outcome = await executeRunCode(
      { code: "import time\nfor i in range(60):\n    print('tick', i, flush=True)\n    time.sleep(1)\nopen('never.txt','w').write('x')\n" },
      ctx(f, { signal: controller.signal }),
    );
    assert.ok(Date.now() - started < 30_000, "Stop does not wait for the program");
    assert.equal(outcome.status, "cancelled", outcome.text);
    assert.doesNotMatch(outcome.text, /^Ran /);
    assert.match(outcome.text, /did not succeed/);
    const row = await prisma.toolRun.findUniqueOrThrow({ where: { id: outcome.run!.toolRunId } });
    assert.equal(row.status, "cancelled");
    const host = await new JunoExecClient(execEndpoint()!).getRun(row.remoteRunId!, 0);
    assert.equal(host.status, "cancelled", "the host reports the container killed");
    assert.equal(await prisma.attachment.count({ where: { userId: f.user.id, origin: "tool_output" } }), 0, "nothing from a stopped run is kept");
  });

  test("V5: a backend killed mid-run ends in 'finished later' through the sweep, never a re-run", async () => {
    const { sweepToolRuns } = await import("@/lib/exec/runtime");
    const f = await seed();
    const sessionId = `gen-${randomBytes(6).toString("hex")}`;
    const callId = `call_${randomBytes(6).toString("hex")}`;
    const before = await hostRunsStarted();
    const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/exec-kill-child.ts", f.user.id, f.conversation.id, sessionId, callId], {
      env: process.env,
      stdio: "ignore",
    });
    let row = null;
    for (let i = 0; i < 120 && !row?.remoteRunId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      row = await prisma.toolRun.findFirst({ where: { sessionId } });
    }
    assert.ok(row?.remoteRunId, "the child started the run");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 7000));
    // The lease the dead process held runs out; the scheduler's sweep takes it.
    const result = await sweepToolRuns({ now: new Date(Date.now() + 5 * 60_000), limit: 50 });
    assert.ok(result.finishedLate >= 1, JSON.stringify(result));
    const settled = await prisma.toolRun.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(settled.status, "succeeded");
    assert.equal(settled.finishedLate, true);
    const late = await prisma.attachment.findFirst({ where: { userId: f.user.id, origin: "tool_output", fileName: "late.txt" } });
    assert.ok(late, "what it wrote is attached to the conversation");
    assert.equal(await hostRunsStarted(), before + 1, "the sweep collected it; nothing ran twice");
  });

  test("V5: a run the host no longer has becomes outcome_unknown, and nothing is re-run", async () => {
    const { sweepToolRuns, outcomeFromRow } = await import("@/lib/exec/runtime");
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const f = await seed();
    const before = await hostRunsStarted();
    const row = await prisma.toolRun.create({
      data: {
        userId: f.user.id,
        surface: "chat",
        sessionId: `gen-${randomBytes(6).toString("hex")}`,
        callId: "call_lost",
        argsDigest: "0".repeat(64),
        conversationId: f.conversation.id,
        language: "python",
        codeDigest: "0".repeat(64),
        code: encryptMessageText("print('x')"),
        status: "running",
        remoteRunId: `r_${randomBytes(12).toString("hex")}`,
        startedAt: new Date(Date.now() - 60_000),
        leaseUntil: new Date(Date.now() - 120_000),
      },
    });
    await sweepToolRuns({ now: new Date(), limit: 50 });
    const settled = await prisma.toolRun.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(settled.status, "outcome_unknown");
    const outcome = await outcomeFromRow(settled);
    assert.equal(outcome.status, "outcome_unknown");
    assert.match(outcome.text, /outcome of this Python run is unknown/);
    assert.match(outcome.text, /Do not say it succeeded; it was not run again/);
    assert.equal(await hostRunsStarted(), before);
  });

  test("check_run takes over a run that outlived the inline wait", async () => {
    const { executeRunCode, executeCheckRun } = await import("@/lib/exec/runtime");
    const f = await seed();
    const context = ctx(f);
    process.env.EXEC_INLINE_WAIT_MS = "1500";
    let first;
    try {
      first = await executeRunCode({ code: "import time\ntime.sleep(5)\nopen('slow.csv','w').write('a,b\\n1,2\\n')\nprint('slow done')" }, context);
    } finally {
      delete process.env.EXEC_INLINE_WAIT_MS;
    }
    assert.equal(first.status, "running", first.text);
    assert.equal(first.run?.status, "running");
    assert.match(first.text, /Call check_run with run_id/);
    assert.doesNotMatch(first.text, /^Ran /);
    const checked = await executeCheckRun({ run_id: first.run!.toolRunId, wait_seconds: 30 }, context);
    assert.equal(checked.status, "succeeded", checked.text);
    assert.match(checked.text, /slow done/);
    assert.equal(checked.run?.files[0]?.name, "slow.csv");
    // A run id from another conversation is not found.
    const other = await seed();
    const foreign = await executeCheckRun({ run_id: first.run!.toolRunId }, ctx(other));
    assert.equal(foreign.error?.code, "not_found");
  });

  test("V6: a missing module gives ModuleNotFoundError and the installed-packages line", async () => {
    const { executeRunCode } = await import("@/lib/exec/runtime");
    const f = await seed();
    const outcome = await executeRunCode({ code: "import polars as pl\nprint(pl.__version__)" }, ctx(f));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.run?.exitCode, 1);
    assert.match(outcome.text, /ModuleNotFoundError: No module named 'polars'/);
    assert.match(outcome.text, /"polars" is not installed\. This sandbox has no internet, so packages cannot be installed\./);
    assert.match(outcome.text, /Installed Python packages: .*pandas 2\.2\.3/);
  });

  test("V6: private turns and lockdown never execute; invalid arguments are never run", async () => {
    const { executeRunCode } = await import("@/lib/exec/runtime");
    const f = await seed();
    const privateOutcome = await executeRunCode({ code: "print(1)" }, ctx(f, { private: true }));
    assert.equal(privateOutcome.error?.code, "capability_unavailable");
    await prisma.settings.create({ data: { userId: f.user.id, lockdownMode: true } });
    const locked = await executeRunCode({ code: "print(1)" }, ctx(f, { lockdown: undefined }));
    assert.equal(locked.error?.code, "capability_unavailable");
    assert.match(locked.text, /lockdown/);
    const invalid = await executeRunCode({ code: "", language: "ruby" }, ctx(f));
    assert.equal(invalid.error?.code, "invalid_arguments");
    assert.match(invalid.text, /Nothing was run/);
    assert.equal(await prisma.toolRun.count({ where: { userId: f.user.id } }), 0, "no record, because nothing ran");
  });

  test("V6: a configured sandbox that is down is capability_unavailable and nothing ran", async () => {
    const { executeRunCode } = await import("@/lib/exec/runtime");
    const f = await seed();
    const saved = process.env.CODE_INTERPRETER_URL;
    process.env.CODE_INTERPRETER_URL = "http://127.0.0.1:3179";
    try {
      const outcome = await executeRunCode({ code: "print(1)" }, ctx(f));
      assert.equal(outcome.error?.code, "capability_unavailable", outcome.text);
      assert.match(outcome.text, /not reachable right now, so nothing was run/);
    } finally {
      process.env.CODE_INTERPRETER_URL = saved;
    }
    const row = await prisma.toolRun.findFirstOrThrow({ where: { userId: f.user.id } });
    assert.equal(row.status, "refused");
    assert.equal(row.remoteRunId, null);
  });

  test("Work runs: the run's files are inputs, outputs get a WorkRunIO row, and the call id keys the record", async () => {
    const { workExecDeps } = await import("@/lib/exec/work");
    const f = await seed();
    const session = await prisma.workSession.create({ data: { userId: f.user.id, title: "Quarterly numbers", goal: "Sum the sales" } });
    const run = await prisma.workRun.create({ data: { sessionId: session.id, userId: f.user.id } });
    const input = await prisma.attachment.findFirstOrThrow({ where: { userId: f.user.id, fileName: "sales.csv" } });
    await prisma.workRunIO.create({ data: { runId: run.id, direction: "input", refKind: "attachment", refId: input.id, label: "sales.csv" } });
    const deps = workExecDeps({ runId: run.id, userId: f.user.id, sessionId: session.id, projectId: null, vision: false });
    assert.ok(deps, "configured");
    const result = await deps.runCode(
      { code: "rows = open('inputs/sales.csv').read().splitlines()[1:]\ntotal = sum(int(r.split(',')[1]) for r in rows)\nopen('total.txt','w').write(str(total))\nprint(total)" },
      { callId: "toolu_work_1" },
    );
    assert.equal(result.isError, false, result.output);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /\b600\b/);
    const row = await prisma.toolRun.findFirstOrThrow({ where: { userId: f.user.id, workRunId: run.id } });
    assert.equal(row.surface, "work");
    assert.equal(row.callId, "toolu_work_1");
    assert.equal(row.conversationId, null);
    const output = await prisma.workRunIO.findFirstOrThrow({ where: { runId: run.id, direction: "output", refKind: "attachment" } });
    assert.equal(output.label, "total.txt");
    const again = await deps.runCode(
      { code: "rows = open('inputs/sales.csv').read().splitlines()[1:]\ntotal = sum(int(r.split(',')[1]) for r in rows)\nopen('total.txt','w').write(str(total))\nprint(total)" },
      { callId: "toolu_work_1" },
    );
    assert.match(again.output, /was not run again/, "a resumed run replays the call instead of running it twice");
    const failed = await deps.runCode({ code: "raise SystemExit(4)" }, { callId: "toolu_work_2" });
    assert.equal(failed.isError, true);
    assert.equal(failed.exitCode, 4);
  });

  test("close the database", async () => {
    await prisma.$disconnect();
  });
}
