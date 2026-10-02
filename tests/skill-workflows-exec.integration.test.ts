/**
 * V3 and V6 with the REAL execution runtime (design §6.8 with §6.3–§6.5):
 * quarterly-summary.zip is imported and consented through the routes; in chat
 * it is armed by /slug, and separately found by the model through use_skill;
 * its reference is read through read_skill_file; its script runs through the
 * execution lane's run_code spec in a real juno-exec container; the ToolRun
 * row records the skill version and bundle digest; out.xlsx comes back as a
 * `tool_output` attachment that opens with the Summary sheet and the expected
 * values; an audit row records the skill applied with its digest. The same
 * through a Work run (skillToolsFor + the runtime's Work deps). Unconsented, a
 * run that names the skill's script finds nothing mounted; a skill asking for
 * the network still has none.
 *
 * `tests/skill-workflows.integration.test.ts` proves the skill half against a
 * stand-in container; this suite proves the two lanes together. It needs the
 * execution lane's runtime in the tree (`src/lib/exec/runtime.ts`), with the
 * skill mounts registered in that lane's registry (`src/lib/skills/mount.ts`
 * re-exporting `src/lib/exec/mounts.ts`), a local juno-exec
 * (`deploy/exec-host/local/run-local.sh`) and a throwaway database migrated
 * with both lanes' migrations:
 *
 *   JUNO_SKILLS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/juno_skills_exec_test \
 *   EXEC_TEST_URL=http://127.0.0.1:3176 EXEC_TEST_TOKEN_FILE=<the local profile's token file> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/skill-workflows-exec.integration.test.ts
 *
 * The execution lane's modules are imported by a computed specifier, so this
 * file typechecks in a tree that does not have them yet.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import JSZip from "jszip";
import * as serverNavigation from "next/dist/client/components/navigation.react-server";

const DB_URL = process.env.JUNO_SKILLS_TEST_DATABASE_URL;
const HOST = process.env.EXEC_TEST_URL;
const TOKEN_FILE = process.env.EXEC_TEST_TOKEN_FILE;
const RUNTIME_PRESENT = existsSync("src/lib/exec/runtime.ts") && existsSync("src/lib/exec/mounts.ts");
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

/** The execution lane's modules, untyped here on purpose (see the header). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const execModule = (name: "runtime" | "provider" | "work" | "mounts"): Promise<any> => import(`@/lib/exec/${name}`);

const EXPECTED_ROWS: (string | number)[][] = [
  ["Region", "Q1", "Q2", "Q3", "Q4", "Total"],
  ["West", 2100, 1980.4, 2250.1, 2400, 8730.5],
  ["North", 1200.5, 1340, 1100.25, 1500, 5140.75],
  ["South", 800, 950.75, 1020, 990, 3760.75],
  ["East", 600, 700, 650.5, 720, 2670.5],
  ["All regions", 4700.5, 4971.15, 5020.85, 5610, 20302.5],
];

/** The first sheet of an xlsx, as rows of cell values (shared strings resolved). */
async function readSheet(bytes: Uint8Array): Promise<{ sheetNames: string[]; rows: (string | number)[][] }> {
  const zip = await JSZip.loadAsync(bytes);
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  const sheetNames = [...workbook.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((match) => match[1]);
  const sharedXml = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => match[1].replace(/<[^>]+>/g, ""));
  const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const rows = [...sheet.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
    [...row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell) => {
      const inner = cell[2] ?? "";
      const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? "";
      if (/t="s"/.test(cell[1])) return shared[Number(value)];
      if (/t="(?:inlineStr|str)"/.test(cell[1])) return value;
      return Number(value);
    })
  );
  return { sheetNames, rows };
}

const skipReason = !DB_URL || !HOST || !TOKEN_FILE
  ? "needs JUNO_SKILLS_TEST_DATABASE_URL, EXEC_TEST_URL and EXEC_TEST_TOKEN_FILE"
  : !RUNTIME_PRESENT
    ? "needs the execution lane's runtime (src/lib/exec) in this tree"
    : !canMockModules
      ? "needs --experimental-test-module-mocks"
      : null;

if (skipReason) {
  test(`skills with the real execution runtime: skipped (${skipReason})`, { skip: true }, () => {});
} else {
  assert.match(DB_URL!, /^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/juno_skills(?:_exec)?_test$/, "only a local throwaway database");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.AUTH_SECRET ??= "juno-skills-exec-integration-test-key-0123456789";
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.TOOL_RUNTIME = "1";
  process.env.CODE_INTERPRETER_URL = HOST;
  process.env.CODE_INTERPRETER_TOKEN = readFileSync(TOKEN_FILE!, "utf8").trim();

  const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  // The execution lane's model, absent from this lane's generated client.
  const toolRuns = (db as unknown as {
    toolRun: { findMany(args: unknown): Promise<Array<Record<string, unknown>>> };
  }).toolRun;
  const owner = `skills-exec-${randomUUID()}`;
  let signedIn: { id: string; email: string } | null = null;
  const zipBytes = new Uint8Array(readFileSync("tests/fixtures/skills/quarterly-summary.zip"));
  const salesCsv = readFileSync("tests/fixtures/skills/sales.csv");
  const RUN_SCRIPT = "python3 /skills/quarterly-summary/scripts/build.py /work/inputs/sales.csv /work/out.xlsx";
  const storedKeys: string[] = [];

  let conversationId = "";
  let salesAttachmentId = "";
  let skillId = "";
  let digest = "";
  let versionId = "";

  test.before(async () => {
    mock.module("next/navigation", { namedExports: { ...serverNavigation } });
    mock.module("@/lib/session", {
      namedExports: {
        getCurrentUser: async () => signedIn,
        getCurrentDeviceSessionId: async () => null,
        getSessionBan: async () => null,
        requireUser: async () => {
          if (!signedIn) throw new Error("signed out");
          return signedIn;
        },
      },
    });
    await db.user.create({ data: { id: owner, email: `${owner}@example.invalid`, emailVerified: new Date() } });
    signedIn = { id: owner, email: `${owner}@example.invalid` };
    const conversation = await db.conversation.create({ data: { userId: owner, title: "Quarterly numbers" } });
    conversationId = conversation.id;
    const { putObject } = await import("@/lib/storage");
    const key = `test/skills-exec/${randomUUID()}/sales.csv`;
    await putObject(key, salesCsv, "text/csv");
    storedKeys.push(key);
    const attachment = await db.attachment.create({
      data: {
        userId: owner, conversationId, kind: "FILE", fileName: "sales.csv", mimeType: "text/csv",
        size: salesCsv.byteLength, storageKey: key, parserState: "ready",
      },
    });
    salesAttachmentId = attachment.id;
  });

  test.after(async () => {
    const { deleteObject } = await import("@/lib/storage");
    const versions = await db.workSkillVersion.findMany({ where: { skill: { userId: owner } }, select: { bundleKey: true } });
    const outputs = await db.attachment.findMany({ where: { userId: owner }, select: { storageKey: true } });
    for (const key of [...storedKeys, ...versions.map((row) => row.bundleKey), ...outputs.map((row) => row.storageKey)]) {
      if (key) await deleteObject(key).catch(() => {});
    }
    await db.user.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  const chatTurn = (sessionId: string, skillSlug: string | null) => ({
    userId: owner, surface: "chat" as const, sessionId, conversationId, projectId: null,
    plan: "PRO", modelId: "test-model", vision: false, skillSlug,
  });
  const toolContext = (sessionId: string, callId: string) => ({
    userId: owner, surface: "chat" as const, sessionId, conversationId, projectId: null, callId, round: 0,
    signal: new AbortController().signal, reportProgress() {},
  });

  /** The ToolRun and the out.xlsx attachment a successful script run left, checked against the fixture. */
  async function assertWorkbookRun(where: Record<string, unknown>, outcome: { status: string; text: string }) {
    assert.equal(outcome.status, "succeeded", outcome.text);
    const runs = await toolRuns.findMany({ where: { userId: owner, ...where } });
    assert.equal(runs.length, 1, "one run");
    const [run] = runs;
    assert.equal(run.status, "succeeded");
    assert.equal(run.exitCode, 0);
    assert.equal(run.context, "hosted_sandbox");
    assert.equal(run.skillVersionId, versionId, "the run records the skill version");
    assert.equal(run.skillBundleDigest, digest, "and the exact bundle it mounted");
    const workbook = await db.attachment.findFirstOrThrow({
      where: { userId: owner, origin: "tool_output", fileName: "out.xlsx", createdAt: { gte: run.createdAt as Date } },
      orderBy: { createdAt: "desc" },
    });
    const { getObjectBytes } = await import("@/lib/storage");
    const sheet = await readSheet((await getObjectBytes(workbook.storageKey)).bytes);
    assert.deepEqual(sheet.sheetNames, ["Summary"]);
    assert.deepEqual(sheet.rows, EXPECTED_ROWS);
    assert.match(outcome.text, /"grand_total": 20302\.5/);
    assert.match(outcome.text, /out\.xlsx/);
    return { run, workbook };
  }

  test("import, scan and hold for consent through the package route", async () => {
    const { POST } = await import("@/app/api/skills/import/package/route");
    const post = async (fields: Record<string, string>) => {
      const form = new FormData();
      form.set("file", new File([zipBytes], "quarterly-summary.zip", { type: "application/zip" }));
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      const response = await POST(new Request("http://localhost/api/skills/import/package", { method: "POST", body: form }));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const preview = await post({});
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const [candidate] = preview.body.skills as Array<{ path: string }>;
    const imported = await post({ paths: JSON.stringify([candidate.path]), digest: preview.body.digest as string });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const [skill] = imported.body.imported as Array<{ id: string; requiresConsent: boolean }>;
    assert.equal(skill.requiresConsent, true);
    skillId = skill.id;
    const version = await db.workSkillVersion.findFirstOrThrow({ where: { skillId } });
    digest = version.bundleDigest!;
    versionId = version.id;
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  test("V6: unconsented, nothing is mounted, so a run naming the script finds nothing and records no skill", async () => {
    const { createSkillsToolProvider } = await import("@/lib/skills/tool-provider");
    const { execToolProvider } = await execModule("provider");
    const sessionId = `gen_${randomUUID()}`;
    const turn = chatTurn(sessionId, "quarterly-summary");
    const skills = await createSkillsToolProvider({ codeExecution: () => true }).open(turn, ["use_skill", "read_skill_file"]);
    const exec = await execToolProvider.open(turn, ["run_code"]);
    try {
      assert.deepEqual(skills.specs.map((spec) => spec.id), [], "an armed skill waiting on review is not loaded");
      const runCode = exec.specs.find((spec: { id: string }) => spec.id === "run_code");
      const outcome = await runCode.execute({ language: "bash", code: RUN_SCRIPT }, toolContext(sessionId, "call_unconsented"));
      assert.equal(outcome.status, "failed", outcome.text);
      assert.match(outcome.text, /No such file or directory|can't open file/);
      const [run] = await toolRuns.findMany({ where: { userId: owner, sessionId } });
      assert.equal(run.skillVersionId, null);
      assert.equal(run.skillBundleDigest, null);
    } finally {
      await skills.close?.();
    }
  });

  test("consent through the route", async () => {
    const { POST } = await import("@/app/api/work/skills/[id]/versions/[version]/consent/route");
    const response = await POST(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: skillId, version: "1" }) });
    assert.equal(response.status, 200);
    const consent = await db.workAuditEvent.findFirstOrThrow({ where: { userId: owner, kind: "skill_permission_consent" }, orderBy: { createdAt: "desc" } });
    assert.equal((consent.detail as Record<string, unknown>).contentHash, digest);
  });

  test("V3 /slug in chat: armed, its reference read, its script run by run_code, the run and the workbook recorded", async () => {
    const { loadChatSkill } = await import("@/lib/chat/skill-runtime");
    const { createSkillsToolProvider } = await import("@/lib/skills/tool-provider");
    const { execToolProvider } = await execModule("provider");
    const outcome = await loadChatSkill({
      userId: owner,
      slug: "quarterly-summary",
      capabilities: { webSearch: false, canvas: false, documents: true, images: false, connectors: [], code: true, skillFiles: true },
    });
    assert.ok(outcome.applied, JSON.stringify(outcome));
    if (!outcome.applied) return;
    assert.equal(outcome.application.bundle?.digest, digest);

    const sessionId = `gen_${randomUUID()}`;
    const turn = chatTurn(sessionId, "quarterly-summary");
    assert.deepEqual(await execToolProvider.availability(turn), { available: true }, "the local juno-exec is healthy and isolated");
    const skills = await createSkillsToolProvider({ codeExecution: () => true }).open(turn, ["use_skill", "read_skill_file"]);
    const exec = await execToolProvider.open(turn, ["run_code"]);
    try {
      const readSkillFile = skills.specs.find((spec) => spec.id === "read_skill_file")!;
      const style = await readSkillFile.execute({ skill: "quarterly-summary", path: "reference/style.md" }, toolContext(sessionId, "call_style"));
      assert.equal(style.status, "succeeded");
      assert.match(style.body, /named \*\*Summary\*\*/);

      const runCode = exec.specs.find((spec: { id: string }) => spec.id === "run_code");
      const ran = await runCode.execute(
        { language: "bash", code: RUN_SCRIPT, reason: "build the quarterly summary" },
        toolContext(sessionId, "call_build")
      );
      const { run, workbook } = await assertWorkbookRun({ sessionId }, ran);
      assert.equal(ran.run?.skillVersionId ?? run.skillVersionId, versionId);
      assert.equal(workbook.conversationId, conversationId, "attached to the conversation");
      assert.notEqual(workbook.id, salesAttachmentId);
    } finally {
      await skills.close?.();
    }
  });

  test("V3 use_skill in chat: found by the model, audited with its digest, its script run by run_code", async () => {
    await db.workSkill.update({ where: { id: skillId }, data: { trust: "user_authored", autoSelect: true } });
    const { createSkillsToolProvider } = await import("@/lib/skills/tool-provider");
    const { execToolProvider } = await execModule("provider");
    const sessionId = `gen_${randomUUID()}`;
    const turn = chatTurn(sessionId, null);
    const skills = await createSkillsToolProvider({ codeExecution: () => true }).open(turn, ["use_skill", "read_skill_file"]);
    const exec = await execToolProvider.open(turn, ["run_code"]);
    try {
      const [useSkill, readSkillFile] = skills.specs;
      assert.equal(useSkill.id, "use_skill");
      const loaded = await useSkill.execute({ name: "quarterly-summary" }, toolContext(sessionId, "call_use"));
      assert.equal(loaded.status, "succeeded", loaded.text);
      const audit = await db.workAuditEvent.findFirstOrThrow({ where: { userId: owner, kind: "skill_applied" }, orderBy: { createdAt: "desc" } });
      const detail = audit.detail as Record<string, unknown>;
      assert.equal(detail.action, "use_skill");
      assert.equal(detail.contentHash, digest);
      assert.equal(detail.generationId, sessionId);
      const style = await readSkillFile.execute({ skill: "quarterly-summary", path: "reference/style.md" }, toolContext(sessionId, "call_style"));
      assert.match(style.text, /Freeze the header row/);

      const runCode = exec.specs.find((spec: { id: string }) => spec.id === "run_code");
      const ran = await runCode.execute({ language: "bash", code: RUN_SCRIPT }, toolContext(sessionId, "call_build"));
      await assertWorkbookRun({ sessionId }, ran);
    } finally {
      await skills.close?.();
    }
  });

  test("V3 in a Work run: skillToolsFor loads and reads, the runtime's Work deps run the script under the run id", async () => {
    const { skillToolsFor } = await import("@/lib/skills/run-tools");
    const { workExecDeps } = await execModule("work");
    const session = await db.workSession.create({ data: { userId: owner, title: "Quarterly numbers", goal: "Build the quarterly summary" } });
    const workRun = await db.workRun.create({ data: { sessionId: session.id, userId: owner } });
    await db.workRunIO.create({ data: { runId: workRun.id, direction: "input", refKind: "attachment", refId: salesAttachmentId, label: "sales.csv" } });
    const tools = await skillToolsFor({ userId: owner, runId: workRun.id, projectId: null, codeExecution: true });
    try {
      const [useSkill, readSkillFile] = tools.tools;
      const loaded = await useSkill.execute({ name: "quarterly-summary" });
      assert.equal(loaded.isError, undefined, loaded.output);
      const style = await readSkillFile.execute({ skill: "quarterly-summary", path: "reference/style.md" });
      assert.match(style.output, /Freeze the header row/);
      const deps = workExecDeps({ runId: workRun.id, userId: owner, sessionId: session.id, projectId: null, vision: false });
      assert.ok(deps, "hosted execution is configured");
      const result = await deps.runCode({ language: "bash", code: RUN_SCRIPT }, { callId: "toolu_work_build" });
      assert.equal(result.isError, false, result.output);
      const { workbook } = await assertWorkbookRun({ workRunId: workRun.id }, { status: "succeeded", text: result.output });
      const output = await db.workRunIO.findFirstOrThrow({ where: { runId: workRun.id, direction: "output", refKind: "attachment", refId: workbook.id } });
      assert.equal(output.refId, workbook.id, "the workbook is the run's output");
    } finally {
      await tools.close();
    }
  });

  test("V6: a skill asking for the network and connectors still runs with none: a socket fails in the real sandbox", async () => {
    const { createSkillWithFirstVersion } = await import("@/lib/skills/store");
    const { buildSkillBundle } = await import("@/lib/skills/bundle");
    const { emptySkillContract } = await import("@/lib/work/skills");
    const { createSkillsToolProvider } = await import("@/lib/skills/tool-provider");
    const { execToolProvider } = await execModule("provider");
    const built = buildSkillBundle([
      { path: "SKILL.md", bytes: new TextEncoder().encode("---\nname: phone-home\ndescription: Calls out.\n---\nRun scripts/call.py.") },
      {
        path: "scripts/call.py",
        bytes: new TextEncoder().encode(
          "import socket, sys\n" +
            "for target in [('1.1.1.1', 80), ('example.com', 443)]:\n" +
            "    try:\n" +
            "        socket.create_connection(target, timeout=3).close()\n" +
            "        print('connected', target)\n" +
            "        sys.exit(0)\n" +
            "    except OSError as error:\n" +
            "        print('refused', target, type(error).__name__, file=sys.stderr)\n" +
            "sys.exit(7)\n"
        ),
      },
    ]);
    assert.ok(built.ok);
    if (!built.ok) return;
    const created = await createSkillWithFirstVersion({
      userId: owner, slug: "phone-home", name: "Phone home", description: "Calls out.", instructions: "Run scripts/call.py.",
      requestedTools: ["web_search", "Bash"],
      contract: { ...emptySkillContract(), requestedConnectors: ["gmail"], requestedDomains: ["example.com"] },
      origin: "authored", bundle: built.bundle,
    });
    assert.ok(created.ok);
    const sessionId = `gen_${randomUUID()}`;
    const turn = chatTurn(sessionId, "phone-home");
    const skills = await createSkillsToolProvider({ codeExecution: () => true }).open(turn, ["use_skill", "read_skill_file"]);
    const exec = await execToolProvider.open(turn, ["run_code"]);
    try {
      const runCode = exec.specs.find((spec: { id: string }) => spec.id === "run_code");
      const ran = await runCode.execute({ language: "bash", code: "python3 /skills/phone-home/scripts/call.py" }, toolContext(sessionId, "call_phone"));
      assert.equal(ran.status, "failed", ran.text);
      assert.match(ran.text, /exit code 7/);
      assert.match(ran.text, /refused \('1\.1\.1\.1', 80\)/);
      assert.doesNotMatch(ran.text, /connected/);
      const [run] = await toolRuns.findMany({ where: { userId: owner, sessionId } });
      assert.equal(run.exitCode, 7);
      assert.equal(run.skillBundleDigest, built.bundle.digest, "the run is attributed to the skill whose script it ran");
    } finally {
      await skills.close?.();
    }
  });
}
