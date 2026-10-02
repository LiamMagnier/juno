/**
 * Skills as executable workflows against a real database (design §6.8, V3 and
 * V6): quarterly-summary.zip is imported through the package route, kept,
 * scanned and held for consent; unconsented it is explained and never mounted;
 * consented through the route (audited with its digest) it is found through an
 * explicit /slug and, once the person opts it in, through use_skill, in chat and
 * in a Work run; its reference is read, its folder is mounted read-only for the
 * turn's sandbox session, and its script runs in a no-network container and
 * writes out.xlsx with the expected sheet and values. A socket fails there.
 *
 * Opt-in, like every suite that writes:
 *
 *   JUNO_SKILLS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:65437/juno_skills_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/skill-workflows.integration.test.ts
 *
 * THE SANDBOX STAND-IN. The execution runtime (`src/lib/exec`, the execution
 * lane) owns `run_code`, the ToolRun row and output attachments. Until it is on
 * the trunk, `runInSandbox` below runs the turn's mounts the way the design's
 * container profile does (juno-exec image, --network none, read-only root,
 * no capabilities, uid 1000, /skills/<slug> read-only, /work writable) so the
 * skill half is proven end to end. The cases skip without Docker or the
 * `juno-exec:dev` image (`bash deploy/exec-host/local/run-local.sh` builds it).
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrismaClient } from "@prisma/client";
import JSZip from "jszip";
import * as serverNavigation from "next/dist/client/components/navigation.react-server";

const URL = process.env.JUNO_SKILLS_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const SANDBOX_IMAGE = process.env.JUNO_SKILLS_TEST_SANDBOX_IMAGE ?? "juno-exec:dev";

function sandboxAvailable(): boolean {
  const probe = spawnSync("docker", ["image", "inspect", SANDBOX_IMAGE], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

/**
 * One run in the design's container profile (§6.3) with the turn's mounts.
 * Returns stdout, stderr, the exit code and the /work directory on the host.
 */
async function runInSandbox(input: {
  mounts: readonly { slug: string; openBundle(): Promise<Uint8Array> }[];
  inputs: Record<string, Uint8Array>;
  language: "bash" | "python";
  code: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string; work: string; cleanup(): void }> {
  const root = mkdtempSync(join(tmpdir(), "skill-sandbox-"));
  const work = join(root, "work");
  mkdirSync(join(work, "inputs"), { recursive: true });
  for (const [name, bytes] of Object.entries(input.inputs)) writeFileSync(join(work, "inputs", name), bytes);
  chmodSync(work, 0o777);
  const args = [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "1000:1000", "--pids-limit", "256", "--memory", "1536m", "--memory-swap", "1536m", "--cpus", "1",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "-v", `${work}:/work`, "-w", "/work",
  ];
  for (const mount of input.mounts) {
    const dir = join(root, "skills", mount.slug);
    mkdirSync(dir, { recursive: true });
    const tarPath = join(root, `${mount.slug}.tar`);
    writeFileSync(tarPath, await mount.openBundle());
    const extracted = spawnSync("tar", ["-xf", tarPath, "-C", dir], { encoding: "utf8" });
    assert.equal(extracted.status, 0, extracted.stderr);
    args.push("-v", `${dir}:/skills/${mount.slug}:ro`);
  }
  args.push(SANDBOX_IMAGE, ...(input.language === "bash" ? ["bash", "-c", input.code] : ["python3", "-c", input.code]));
  const run = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
  return {
    exitCode: run.status ?? -1,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    work,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The Summary sheet of an xlsx, as rows of cell values (shared strings resolved). */
async function readSummarySheet(bytes: Uint8Array): Promise<{ sheetNames: string[]; rows: (string | number)[][] }> {
  const zip = await JSZip.loadAsync(bytes);
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  const sheetNames = [...workbook.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((match) => match[1]);
  const sharedXml = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => match[1].replace(/<[^>]+>/g, ""));
  const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const rows = [...sheet.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
    [...row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell) => {
      const attrs = cell[1];
      const inner = cell[2] ?? "";
      const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? "";
      if (/t="s"/.test(attrs)) return shared[Number(value)];
      if (/t="(?:inlineStr|str)"/.test(attrs)) return value;
      return Number(value);
    })
  );
  return { sheetNames, rows };
}

const EXPECTED_ROWS: (string | number)[][] = [
  ["Region", "Q1", "Q2", "Q3", "Q4", "Total"],
  ["West", 2100, 1980.4, 2250.1, 2400, 8730.5],
  ["North", 1200.5, 1340, 1100.25, 1500, 5140.75],
  ["South", 800, 950.75, 1020, 990, 3760.75],
  ["East", 600, 700, 650.5, 720, 2670.5],
  ["All regions", 4700.5, 4971.15, 5020.85, 5610, 20302.5],
];

if (!URL) {
  test("skill workflows database suite is skipped without JUNO_SKILLS_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(URL, /^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/juno_skills_test$/, "only a local throwaway database");
  process.env.DATABASE_URL = URL;
  process.env.DIRECT_URL = URL;
  process.env.AUTH_SECRET ??= "juno-skills-isolated-integration-test-key-0123456789";
  process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");

  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  const owner = `skills-test-${randomUUID()}`;
  const stranger = `skills-test-${randomUUID()}`;
  let signedIn: { id: string; email: string } | null = null;
  const zipBytes = new Uint8Array(readFileSync("tests/fixtures/skills/quarterly-summary.zip"));
  const salesCsv = new Uint8Array(readFileSync("tests/fixtures/skills/sales.csv"));
  const docker = sandboxAvailable();
  const wrap = (label: string, content: string) => `<<untrusted ${label}>>\n${content}\n<</untrusted>>`;
  const RUN_SCRIPT = "python3 /skills/quarterly-summary/scripts/build.py /work/inputs/sales.csv /work/out.xlsx";

  let skillId = "";
  let digest = "";

  test.before(async () => {
    if (!canMockModules) return;
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
    for (const id of [owner, stranger]) {
      await db.user.create({ data: { id, email: `${id}@example.invalid`, emailVerified: new Date() } });
    }
    signedIn = { id: owner, email: `${owner}@example.invalid` };
  });

  test.after(async () => {
    if (canMockModules) {
      const versions = await db.workSkillVersion.findMany({ where: { skill: { userId: { in: [owner, stranger] } } }, select: { bundleKey: true } });
      const { deleteObject } = await import("@/lib/storage");
      for (const { bundleKey } of versions) if (bundleKey) await deleteObject(bundleKey).catch(() => {});
      await db.user.deleteMany({ where: { id: { in: [owner, stranger] } } });
    }
    await db.$disconnect();
  });

  const routeTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !canMockModules && "needs --experimental-test-module-mocks" }, fn);
  const sandboxTest = (name: string, fn: () => Promise<void>) =>
    test(name, { skip: !canMockModules ? "needs --experimental-test-module-mocks" : !docker ? `needs Docker and ${SANDBOX_IMAGE}` : false }, fn);

  async function postPackage(fields: Record<string, string>) {
    const { POST } = await import("@/app/api/skills/import/package/route");
    const form = new FormData();
    form.set("file", new File([zipBytes], "quarterly-summary.zip", { type: "application/zip" }));
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const response = await POST(new Request("http://localhost/api/skills/import/package", { method: "POST", body: form }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  routeTest("quarterly-summary.zip is imported through the package route: folder kept, scanned, held for consent", async () => {
    const preview = await postPackage({});
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const skills = preview.body.skills as Array<Record<string, unknown>>;
    assert.equal(skills.length, 1);
    assert.equal(skills[0].securityStatus, "clear");
    assert.deepEqual(skills[0].bundle && { files: (skills[0].bundle as { files: number }).files, scripts: (skills[0].bundle as { scripts: number }).scripts }, { files: 2, scripts: 1 });

    const imported = await postPackage({ paths: JSON.stringify([skills[0].path]), digest: preview.body.digest as string });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const [skill] = imported.body.imported as Array<{ id: string; slug: string; requiresConsent: boolean; trust: string }>;
    assert.equal(skill.slug, "quarterly-summary");
    assert.equal(skill.trust, "untrusted");
    assert.equal(skill.requiresConsent, true, "imported scripts wait for review");
    skillId = skill.id;

    const version = await db.workSkillVersion.findFirstOrThrow({ where: { skillId } });
    assert.ok(version.bundleKey && version.bundleDigest);
    digest = version.bundleDigest!;
    assert.equal(version.securityStatus, "clear");
    assert.equal(version.requiresConsent, true);
    assert.deepEqual((version.securityScan as { consentFor?: string[] }).consentFor, ["scripts"]);
    const manifest = version.bundleManifest as { files: Array<{ path: string; kind: string }> };
    assert.deepEqual(manifest.files.map((file) => file.path), ["SKILL.md", "reference/style.md", "scripts/build.py"]);

    const { loadSkillBundleTar } = await import("@/lib/skills/bundle-store");
    const tar = await loadSkillBundleTar({ bundleKey: version.bundleKey!, bundleDigest: digest });
    assert.equal(createHash("sha256").update(tar).digest("hex"), digest, "the stored object is the scanned bytes");

    const scanned = await db.workAuditEvent.findFirstOrThrow({ where: { userId: owner, kind: "skill_security_scanned" }, orderBy: { createdAt: "desc" } });
    assert.equal((scanned.detail as Record<string, unknown>).contentHash, digest);
    assert.equal((scanned.detail as Record<string, unknown>).requiresConsent, true);
  });

  routeTest("unconsented, it is explained and never mounted: /slug, use_skill and a Work run alike", async () => {
    const { loadChatSkill } = await import("@/lib/chat/skill-runtime");
    const { openSkillToolSession } = await import("@/lib/skills/session");
    const { skillMountsFor } = await import("@/lib/skills/mount");
    const outcome = await loadChatSkill({
      userId: owner,
      slug: "quarterly-summary",
      capabilities: { webSearch: false, canvas: false, documents: true, images: false, connectors: [], code: true, skillFiles: true },
    });
    assert.deepEqual(outcome, { applied: false, reason: "scripts_unreviewed" });

    const sessionId = `gen_${randomUUID()}`;
    const armed = await openSkillToolSession({
      userId: owner, surface: "chat", sessionId, projectId: null, armedSlug: "quarterly-summary",
      code: true, skillFiles: true, wrapUntrusted: wrap, actor: "web",
    });
    assert.equal(armed.armed, null);
    assert.deepEqual(skillMountsFor(sessionId), []);

    // Even vouched for and opted in, the version still waits on its scripts.
    await db.workSkill.update({ where: { id: skillId }, data: { trust: "user_authored", autoSelect: true } });
    try {
      const discovered = await openSkillToolSession({
        userId: owner, surface: "chat", sessionId, projectId: null, code: true, skillFiles: true, wrapUntrusted: wrap, actor: "web",
      });
      assert.deepEqual(discovered.offered.map((row) => row.slug), ["quarterly-summary"]);
      const loaded = await discovered.loadSkill("quarterly-summary");
      assert.equal(loaded.status, "failed");
      assert.equal(loaded.error?.code, "not_permitted");
      assert.match(loaded.text, /none of its scripts ran/);
      assert.deepEqual(skillMountsFor(sessionId), [], "nothing mounted");
      const read = await discovered.readSkillFile({ skill: "quarterly-summary", path: "scripts/build.py" });
      assert.equal(read.status, "failed", "an unloaded skill's files are not readable");
      await discovered.close();
    } finally {
      await db.workSkill.update({ where: { id: skillId }, data: { trust: "untrusted", autoSelect: false } });
    }
    const audit = await db.workAuditEvent.findFirstOrThrow({ where: { userId: owner, kind: "skill_applied" }, orderBy: { createdAt: "desc" } });
    assert.equal((audit.detail as Record<string, unknown>).outcome, "scripts_unreviewed");
  });

  routeTest("an edit made while the scripts wait for review keeps them waiting, whatever the trust says", async () => {
    const { POST } = await import("@/app/api/work/skills/[id]/versions/route");
    await db.workSkill.update({ where: { id: skillId }, data: { trust: "user_authored" } });
    try {
      const response = await POST(
        new Request("http://localhost", { method: "POST", body: JSON.stringify({ instructions: "Edited before review.\n\nRead reference/style.md, then run scripts/build.py." }) }),
        { params: Promise.resolve({ id: skillId }) }
      );
      assert.equal(response.status, 201);
      const body = (await response.json()) as { version: { version: number; requiresConsent: boolean; bundle: { digest: string } | null } };
      assert.equal(body.version.bundle?.digest, digest, "the edit carried the folder over");
      assert.equal(body.version.requiresConsent, true, "the pending review travelled with the bytes");
    } finally {
      await db.workSkill.update({ where: { id: skillId }, data: { trust: "untrusted" } });
    }
  });

  routeTest("consent through the route clears the wait and audits the exact digest approved", async () => {
    const { POST } = await import("@/app/api/work/skills/[id]/versions/[version]/consent/route");
    const head = await db.workSkill.findUniqueOrThrow({ where: { id: skillId } });
    for (const version of [1, head.currentVersion]) {
      const response = await POST(new Request("http://localhost", { method: "POST" }), {
        params: Promise.resolve({ id: skillId, version: String(version) }),
      });
      assert.equal(response.status, 200);
    }
    const versions = await db.workSkillVersion.findMany({ where: { skillId } });
    assert.ok(versions.every((version) => !version.requiresConsent));
    const consent = await db.workAuditEvent.findFirstOrThrow({ where: { userId: owner, kind: "skill_permission_consent" }, orderBy: { createdAt: "desc" } });
    assert.equal((consent.detail as Record<string, unknown>).contentHash, digest);

    // Another account cannot consent to it, or even find it.
    signedIn = { id: stranger, email: `${stranger}@example.invalid` };
    try {
      const response = await POST(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: skillId, version: "1" }) });
      assert.equal(response.status, 404);
    } finally {
      signedIn = { id: owner, email: `${owner}@example.invalid` };
    }
  });

  sandboxTest("the /slug path: armed, mounted read-only, its reference read, its script run, out.xlsx as specified", async () => {
    const { loadChatSkill } = await import("@/lib/chat/skill-runtime");
    const { createSkillsToolProvider } = await import("@/lib/skills/tool-provider");
    const { skillMountsFor } = await import("@/lib/skills/mount");
    const outcome = await loadChatSkill({
      userId: owner,
      slug: "quarterly-summary",
      capabilities: { webSearch: false, canvas: false, documents: true, images: false, connectors: [], code: true, skillFiles: true },
    });
    assert.ok(outcome.applied, JSON.stringify(outcome));
    if (!outcome.applied) return;
    assert.equal(outcome.application.bundle?.digest, digest);
    assert.equal(outcome.application.untrusted, true, "an imported skill's instructions stay enveloped after consent");

    const sessionId = `gen_${randomUUID()}`;
    const turn = {
      userId: owner, surface: "chat" as const, sessionId, conversationId: null, projectId: null,
      plan: "PRO", modelId: "test-model", vision: false, skillSlug: "quarterly-summary",
    };
    const provider = createSkillsToolProvider({ codeExecution: () => true });
    assert.deepEqual(await provider.availability(turn), { available: true });
    const opened = await provider.open(turn, ["use_skill", "read_skill_file"]);
    try {
      assert.deepEqual(opened.specs.map((spec) => spec.id), ["read_skill_file"], "nothing is offered by name; the armed skill's files are readable");
      assert.match(opened.promptSection ?? "", /mounted read-only at \/skills\/quarterly-summary\//);
      const ctx = { userId: owner, surface: "chat", sessionId, conversationId: null, projectId: null, callId: "c1", round: 0, signal: new AbortController().signal, reportProgress() {} } as const;
      const style = await opened.specs[0].execute({ skill: "quarterly-summary", path: "reference/style.md" }, ctx);
      assert.equal(style.status, "succeeded");
      const { UNTRUSTED_OPEN } = await import("@/lib/untrusted-content");
      assert.ok(style.text.includes(UNTRUSTED_OPEN), "an imported skill's file is enveloped");
      assert.match(style.body, /named \*\*Summary\*\*/);

      const mounts = skillMountsFor(sessionId);
      assert.equal(mounts.length, 1);
      assert.equal(mounts[0].bundleDigest, digest);
      const version = await db.workSkillVersion.findFirstOrThrow({ where: { skillId, bundleDigest: digest }, orderBy: { version: "desc" } });
      assert.equal(mounts[0].skillVersionId, version.id);

      const run = await runInSandbox({ mounts, inputs: { "sales.csv": salesCsv }, language: "bash", code: RUN_SCRIPT });
      try {
        assert.equal(run.exitCode, 0, run.stderr);
        const printed = JSON.parse(run.stdout.trim());
        assert.equal(printed.grand_total, 20302.5);
        assert.equal(printed.top_region, "West");
        assert.ok(existsSync(join(run.work, "out.xlsx")));
        const sheet = await readSummarySheet(new Uint8Array(readFileSync(join(run.work, "out.xlsx"))));
        assert.deepEqual(sheet.sheetNames, ["Summary"]);
        assert.deepEqual(sheet.rows, EXPECTED_ROWS);
      } finally {
        run.cleanup();
      }

      const readOnly = await runInSandbox({ mounts, inputs: {}, language: "bash", code: "echo x > /skills/quarterly-summary/scripts/build.py" });
      readOnly.cleanup();
      assert.notEqual(readOnly.exitCode, 0, "the mount is read-only");
    } finally {
      await opened.close?.();
    }
    assert.deepEqual(skillMountsFor(sessionId), [], "closing the turn drops its mounts");
  });

  sandboxTest("use_skill: opted in, the model finds it by name, loads it, it is audited with its digest, and its script runs", async () => {
    const { PATCH } = await import("@/app/api/work/skills/[id]/route");
    const patched = await PATCH(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ trust: "user_authored", autoSelect: true }) }),
      { params: Promise.resolve({ id: skillId }) }
    );
    assert.equal(patched.status, 200);
    const { createSkillsToolProvider } = await import("@/lib/skills/tool-provider");
    const { skillMountsFor } = await import("@/lib/skills/mount");
    const sessionId = `gen_${randomUUID()}`;
    const turn = { userId: owner, surface: "chat" as const, sessionId, conversationId: null, projectId: null, plan: "PRO", modelId: "test-model", vision: false, skillSlug: null };
    const provider = createSkillsToolProvider({ codeExecution: () => true });
    assert.deepEqual(await provider.availability(turn), { available: true });
    const opened = await provider.open(turn, ["use_skill", "read_skill_file"]);
    try {
      const [useSkill, readSkillFile] = opened.specs;
      assert.equal(useSkill.id, "use_skill");
      assert.match(useSkill.description, /- quarterly-summary: Turns a CSV of sales/);
      const ctx = { userId: owner, surface: "chat", sessionId, conversationId: null, projectId: null, callId: "c1", round: 0, signal: new AbortController().signal, reportProgress() {} } as const;
      const loaded = await useSkill.execute({ name: "quarterly-summary" }, ctx);
      assert.equal(loaded.status, "succeeded", loaded.text);
      assert.match(loaded.text, /did not name it/);
      assert.match(loaded.text, /scripts\/build\.py \(script/);
      const script = await readSkillFile.execute({ skill: "quarterly-summary", path: "scripts/build.py" }, ctx);
      assert.match(script.text, /def main\(source: str, target: str\)/);
      assert.doesNotMatch(script.text, /<<untrusted/, "a vouched-for skill's files are not enveloped");

      const audit = await db.workAuditEvent.findFirstOrThrow({ where: { userId: owner, kind: "skill_applied" }, orderBy: { createdAt: "desc" } });
      const detail = audit.detail as Record<string, unknown>;
      assert.equal(detail.action, "use_skill");
      assert.equal(detail.contentHash, digest);
      assert.equal(detail.skillSlug, "quarterly-summary");
      assert.equal(detail.generationId, sessionId);

      const run = await runInSandbox({ mounts: skillMountsFor(sessionId), inputs: { "sales.csv": salesCsv }, language: "bash", code: RUN_SCRIPT });
      try {
        assert.equal(run.exitCode, 0, run.stderr);
        assert.deepEqual((await readSummarySheet(new Uint8Array(readFileSync(join(run.work, "out.xlsx"))))).rows, EXPECTED_ROWS);
      } finally {
        run.cleanup();
      }
    } finally {
      await opened.close?.();
    }
  });

  sandboxTest("the same scenario in a Work run: skillToolsFor loads, reads and mounts under the run id", async () => {
    const { skillToolsFor } = await import("@/lib/skills/run-tools");
    const { skillMountsFor } = await import("@/lib/skills/mount");
    const runId = `run_${randomUUID()}`;
    const tools = await skillToolsFor({ userId: owner, runId, projectId: null, codeExecution: true });
    try {
      assert.deepEqual(tools.tools.map((tool) => tool.spec.name), ["use_skill", "read_skill_file"]);
      const [useSkill, readSkillFile] = tools.tools;
      assert.equal(useSkill.provenanceFor({ name: "quarterly-summary" }).trust, "trusted");
      const loaded = await useSkill.execute({ name: "quarterly-summary" });
      assert.equal(loaded.isError, undefined, loaded.output);
      assert.doesNotMatch(loaded.output, /<<untrusted/, "the Work session envelopes by provenance; the tool does not");
      const style = await readSkillFile.execute({ skill: "quarterly-summary", path: "reference/style.md" });
      assert.match(style.output, /Freeze the header row/);
      const mounts = skillMountsFor(runId);
      assert.equal(mounts.length, 1);
      const run = await runInSandbox({ mounts, inputs: { "sales.csv": salesCsv }, language: "bash", code: RUN_SCRIPT });
      try {
        assert.equal(run.exitCode, 0, run.stderr);
        assert.deepEqual((await readSummarySheet(new Uint8Array(readFileSync(join(run.work, "out.xlsx"))))).rows, EXPECTED_ROWS);
      } finally {
        run.cleanup();
      }
    } finally {
      await tools.close();
    }
    assert.deepEqual(skillMountsFor(runId), []);
  });

  sandboxTest("a skill asking for network and connectors gets neither: the grant is the turn's and a socket fails in the sandbox", async () => {
    const { createSkillWithFirstVersion } = await import("@/lib/skills/store");
    const { buildSkillBundle } = await import("@/lib/skills/bundle");
    const { emptySkillContract } = await import("@/lib/work/skills");
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
      userId: owner,
      slug: "phone-home",
      name: "Phone home",
      description: "Calls out.",
      instructions: "Run scripts/call.py.",
      requestedTools: ["web_search", "Bash"],
      contract: { ...emptySkillContract(), requestedConnectors: ["gmail"], requestedDomains: ["example.com"] },
      origin: "authored",
      bundle: built.bundle,
    });
    assert.ok(created.ok);
    if (!created.ok) return;
    assert.equal(created.version.requiresConsent, false, "a skill the person wrote does not ask them to approve their own script");
    const scan = created.version.securityScan as { findings: Array<{ code: string; path?: string }> };
    assert.ok(scan.findings.some((finding) => finding.code === "bundle_network_call" && finding.path === "scripts/call.py"));

    const { loadChatSkill } = await import("@/lib/chat/skill-runtime");
    const outcome = await loadChatSkill({
      userId: owner,
      slug: "phone-home",
      capabilities: { webSearch: false, canvas: false, documents: false, images: false, connectors: [], code: true, skillFiles: true },
    });
    assert.ok(outcome.applied);
    if (!outcome.applied) return;
    assert.deepEqual(outcome.application.resolved.tools, ["run_code"], "the shell request reads as run_code, which the turn has");
    assert.deepEqual(outcome.application.resolved.withheld.tools, ["web_search"]);
    assert.deepEqual(outcome.application.resolved.withheld.connectors, ["gmail"]);
    assert.deepEqual(outcome.application.resolved.withheld.domains, ["example.com"]);

    const { openSkillToolSession } = await import("@/lib/skills/session");
    const { skillMountsFor } = await import("@/lib/skills/mount");
    const sessionId = `gen_${randomUUID()}`;
    const session = await openSkillToolSession({
      userId: owner, surface: "chat", sessionId, projectId: null, armedSlug: "phone-home", code: true, skillFiles: true, wrapUntrusted: wrap, actor: "web",
    });
    try {
      const run = await runInSandbox({ mounts: skillMountsFor(sessionId), inputs: {}, language: "bash", code: "python3 /skills/phone-home/scripts/call.py" });
      run.cleanup();
      assert.equal(run.exitCode, 7, `${run.stdout}\n${run.stderr}`);
      assert.match(run.stderr, /refused \('1\.1\.1\.1', 80\)/);
      assert.match(run.stderr, /refused \('example\.com', 443\) gaierror/, "no DNS either");
    } finally {
      await session.close();
    }
  });

  routeTest("a GitHub import keeps the folder too: fetched at the commit the preview read, scanned, held for consent", async () => {
    const commit = "d".repeat(40);
    const files: Record<string, { text: string; mode?: string }> = Object.fromEntries(
      ["SKILL.md", "reference/style.md", "scripts/build.py"].map((path) => [
        `skills/quarterly-summary/${path}`,
        { text: readFileSync(`tests/fixtures/skills/quarterly-summary/${path}`, "utf8").replace("name: quarterly-summary", "name: gh-quarterly-summary") },
      ])
    );
    files["skills/linked/SKILL.md"] = { text: "---\nname: linked\ndescription: Has a link.\n---\nBody." };
    files["skills/linked/secrets"] = { text: "../../../.ssh/id_rsa", mode: "120000" };
    const realFetch = globalThis.fetch;
    const contentReads: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (!url.startsWith("https://api.github.com/")) throw new Error(`unexpected fetch ${url}`);
      if (url.endsWith("/repos/acme/skills")) return json({ default_branch: "main", name: "skills", owner: { login: "acme" } });
      if (url.includes("/commits/")) return json({ sha: commit, html_url: `https://github.com/acme/skills/commit/${commit}` });
      if (url.includes("/git/trees/")) {
        return json({
          truncated: false,
          tree: Object.entries(files).map(([path, file]) => ({
            path, type: "blob", mode: file.mode ?? "100644", size: Buffer.byteLength(file.text), sha: createHash("sha1").update(file.text).digest("hex"),
          })),
        });
      }
      const match = /\/contents\/(.+)\?ref=([0-9a-f]+)/.exec(url);
      if (match) {
        const path = match[1].split("/").map(decodeURIComponent).join("/");
        contentReads.push(`${path}@${match[2]}`);
        return files[path] ? new Response(files[path].text, { status: 200 }) : new Response("", { status: 404 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const { POST } = await import("@/app/api/skills/import/github/route");
      const preview = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ source: "acme/skills" }) }));
      assert.equal(preview.status, 200);
      const previewBody = (await preview.json()) as { skills: Array<{ path: string; bundle: Record<string, unknown> | null }>; repository: { commit: string } };
      const byPath = Object.fromEntries(previewBody.skills.map((skill) => [skill.path, skill.bundle]));
      assert.deepEqual(byPath["skills/quarterly-summary/SKILL.md"], { files: 2, scripts: 1, totalBytes: byPath["skills/quarterly-summary/SKILL.md"]?.totalBytes });
      assert.equal(byPath["skills/linked/SKILL.md"]?.refused, "symlink", "the preview already says the linked folder is refused");
      assert.ok(contentReads.every((read) => read.endsWith("SKILL.md@" + commit)), "the preview reads only SKILL.md files");

      const imported = await POST(new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ source: "acme/skills", commit: previewBody.repository.commit, paths: ["skills/quarterly-summary/SKILL.md", "skills/linked/SKILL.md"] }),
      }));
      assert.equal(imported.status, 201);
      const body = (await imported.json()) as { imported: Array<{ id: string; slug: string; requiresConsent: boolean }>; skipped: Array<{ path: string; reason: string; message: string }> };
      assert.deepEqual(body.imported.map((skill) => [skill.slug, skill.requiresConsent]), [["gh-quarterly-summary", true]]);
      assert.equal(body.skipped[0]?.reason, "bundle_refused");
      assert.match(body.skipped[0]?.message ?? "", /symbolic link/);
      const version = await db.workSkillVersion.findFirstOrThrow({ where: { skillId: body.imported[0].id } });
      const { buildSkillBundle } = await import("@/lib/skills/bundle");
      const upstream = buildSkillBundle(
        Object.entries(files)
          .filter(([path]) => path.startsWith("skills/quarterly-summary/"))
          .map(([path, file]) => ({ path: path.slice("skills/quarterly-summary/".length), bytes: new TextEncoder().encode(file.text) }))
      );
      assert.ok(upstream.ok);
      assert.equal(version.bundleDigest, upstream.ok ? upstream.bundle.digest : null, "the stored folder is exactly the upstream folder at that commit");
      assert.ok(contentReads.filter((read) => !read.endsWith("SKILL.md@" + commit)).every((read) => read.endsWith("@" + commit)));
      const provenance = (version.contract as { provenance: Record<string, string> }).provenance;
      assert.match(provenance["source.files"] ?? "", /^2:[a-f0-9]{16}$/, "the folder's identity is recorded for update checks");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  routeTest("export carries the folder; a restore restores the files that version kept", async () => {
    const { GET } = await import("@/app/api/work/skills/[id]/export/route");
    const exported = await GET(new Request(`http://localhost/api/work/skills/${skillId}/export?format=zip`), { params: Promise.resolve({ id: skillId }) });
    assert.equal(exported.status, 200);
    const zip = await JSZip.loadAsync(new Uint8Array(await exported.arrayBuffer()));
    assert.deepEqual(Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort(), [
      "quarterly-summary/SKILL.md",
      "quarterly-summary/reference/style.md",
      "quarterly-summary/scripts/build.py",
    ]);
    assert.equal(await zip.file("quarterly-summary/scripts/build.py")!.async("string"), readFileSync("tests/fixtures/skills/quarterly-summary/scripts/build.py", "utf8"));

    const { POST } = await import("@/app/api/work/skills/[id]/versions/route");
    const restored = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ restoreVersion: 1 }) }), {
      params: Promise.resolve({ id: skillId }),
    });
    assert.equal(restored.status, 201);
    const body = (await restored.json()) as { version: { bundle: { digest: string } | null; requiresConsent: boolean } };
    assert.equal(body.version.bundle?.digest, digest);
    assert.equal(body.version.requiresConsent, false, "these bytes were approved already");
  });
}
