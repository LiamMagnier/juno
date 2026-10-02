/*
 * Skill packages: SKILL.md files and zips read the way the importer reads
 * them, and a skill written back out (export) reads back in unchanged.
 * `server-only` modules, hence --conditions=react-server (npm run test:skill-package).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import JSZip from "jszip";

async function main() {
  const { readSkillPackage, readSkillMarkdown, formatSkillMd, packageSkillContract, originLabel } = await import(
    "../../src/lib/skills/package"
  );
  const { parseSkillMd } = await import("../../src/lib/skills/skill-md");

  let passed = 0;
  const check = async (name: string, run: () => Promise<void> | void) => {
    await run();
    passed += 1;
    console.log(`ok - ${name}`);
  };

  const skill = (name: string, description = "Writes the weekly report. Use when asked for a status update.") =>
    `---\nname: ${name}\ndescription: ${description}\nallowed-tools: web_search\nlicense: MIT\n---\n\n# ${name}\n\nDo the thing, carefully.\n`;
  const enc = (text: string) => new TextEncoder().encode(text);

  await check("a single SKILL.md is one candidate", async () => {
    const read = await readSkillPackage(enc(skill("weekly-report")));
    assert.ok(read.ok);
    assert.equal(read.ok && read.candidates.length, 1);
    assert.equal(read.ok && read.candidates[0].skill.name, "weekly-report");
  });

  await check("a byte-order mark doesn't hide the frontmatter", async () => {
    const read = await readSkillPackage(enc(`﻿${skill("bom-skill")}`));
    assert.equal(read.ok && read.candidates[0]?.skill.name, "bom-skill");
  });

  await check("markdown that isn't a skill is refused, not guessed at", async () => {
    const read = await readSkillPackage(enc("# Just notes\n\nNothing here."));
    assert.equal(!read.ok && read.reason, "not_a_package");
    const noName = readSkillMarkdown("---\ndescription: x\n---\nbody");
    assert.equal(noName.ok && noName.problems[0].reason, "missing_name");
  });

  await check("a zip of several skill folders: each skill, its own files, no junk", async () => {
    const zip = new JSZip();
    zip.file("report/SKILL.md", skill("report"));
    zip.file("report/templates/weekly.md", "template");
    zip.file("report/scripts/build.py", "print(1)");
    zip.file("report/nested/SKILL.md", skill("nested-one"));
    zip.file("report/nested/notes.txt", "mine");
    zip.file("pdf/SKILL.md", skill("pdf"));
    zip.file("pdf/.DS_Store", "junk");
    zip.file("__MACOSX/report/._SKILL.md", "junk");
    zip.file("broken/SKILL.md", "no frontmatter at all");
    const read = await readSkillPackage(await zip.generateAsync({ type: "uint8array" }));
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.deepEqual(read.candidates.map((c) => c.skill.name).sort(), ["nested-one", "pdf", "report"]);
    const report = read.candidates.find((c) => c.skill.name === "report")!;
    assert.deepEqual(report.companionFiles.sort(), ["scripts/build.py", "templates/weekly.md"]);
    assert.deepEqual(read.candidates.find((c) => c.skill.name === "nested-one")!.companionFiles, ["notes.txt"]);
    assert.deepEqual(read.candidates.find((c) => c.skill.name === "pdf")!.companionFiles, []);
    assert.equal(read.problems.length, 1);
    assert.equal(read.problems[0].path, "broken/SKILL.md");
    assert.equal(read.total, 4);
  });

  await check("a zip with no SKILL.md says so", async () => {
    const zip = new JSZip();
    zip.file("readme.md", "hi");
    const read = await readSkillPackage(await zip.generateAsync({ type: "uint8array" }));
    assert.equal(!read.ok && read.reason, "no_skills");
  });

  await check("a corrupt archive is refused", async () => {
    const read = await readSkillPackage(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]));
    assert.equal(!read.ok && read.reason, "corrupt_zip");
  });

  await check("dishonest ZIP sizes cannot inflate an oversized skill", async () => {
    const zip = new JSZip();
    zip.file("SKILL.md", skill("oversized") + "x".repeat(2_000_000));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.length - 30; i++) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 10, true);
      if (view.getUint32(i, true) === 0x04034b50) view.setUint32(i + 22, 10, true);
    }
    const read = await readSkillPackage(bytes);
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.equal(read.candidates.length, 0);
    assert.equal(read.problems[0]?.reason, "too_large");
  });

  await check("provenance names where it came from", async () => {
    const read = await readSkillPackage(enc(skill("weekly-report")));
    assert.ok(read.ok);
    if (!read.ok) return;
    const { contract, requestedTools } = packageSkillContract(read.candidates[0], { kind: "file", filename: "weekly.zip" });
    assert.equal(contract.provenance["source.kind"], "file");
    assert.equal(contract.provenance["source.file"], "weekly.zip");
    assert.equal(contract.provenance["skill.license"], "MIT");
    assert.deepEqual(requestedTools, ["web_search"]);
    assert.equal(originLabel({ kind: "url", url: "https://example.com/skills/pdf/SKILL.md" }), "example.com/…/SKILL.md");
  });

  await check("export → import round-trips, including a description with colons and quotes", () => {
    const description = 'Summarise a meeting: decisions, owners and "next steps". Use after any call.';
    const text = formatSkillMd({
      slug: "meeting-notes",
      description,
      instructions: "# Notes\n\nList decisions first.",
      requestedTools: ["web_search", "canvas"],
      provenance: { "skill.license": "Apache-2.0" },
    });
    const parsed = parseSkillMd(text);
    assert.ok(parsed.ok, text);
    if (!parsed.ok) return;
    assert.equal(parsed.skill.name, "meeting-notes");
    assert.equal(parsed.skill.description, description);
    assert.equal(parsed.skill.instructions, "# Notes\n\nList decisions first.");
    assert.deepEqual(parsed.skill.allowedTools, ["web_search", "canvas"]);
    assert.equal(parsed.skill.license, "Apache-2.0");
  });

  // ── The folder, kept (docs/rework/TOOL_RUNTIME_DESIGN.md §6.8) ──────────

  await check("quarterly-summary.zip imports with its folder kept: instructions, a reference and a script", async () => {
    const read = await readSkillPackage(new Uint8Array(readFileSync("tests/fixtures/skills/quarterly-summary.zip")));
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.equal(read.candidates.length, 1);
    const [candidate] = read.candidates;
    assert.equal(candidate.skill.name, "quarterly-summary");
    assert.ok(candidate.bundle, "the folder is kept");
    assert.deepEqual(
      candidate.bundle!.manifest.files.map((file) => [file.path, file.kind]),
      [["SKILL.md", "instructions"], ["reference/style.md", "reference"], ["scripts/build.py", "script"]]
    );
    assert.deepEqual(candidate.companionFiles.sort(), ["reference/style.md", "scripts/build.py"]);
  });

  await check("a lone SKILL.md, and a folder with nothing beside it, keep no bundle", async () => {
    const single = await readSkillPackage(enc(skill("weekly-report")));
    assert.equal(single.ok && single.candidates[0].bundle, null);
    const zip = new JSZip();
    zip.file("solo/SKILL.md", skill("solo"));
    const read = await readSkillPackage(await zip.generateAsync({ type: "uint8array" }));
    assert.equal(read.ok && read.candidates[0].bundle, null);
  });

  await check("a symlink in a skill's folder refuses that skill with a readable reason, and only that skill", async () => {
    const zip = new JSZip();
    zip.file("good/SKILL.md", skill("good"));
    zip.file("good/notes.md", "fine");
    zip.file("linked/SKILL.md", skill("linked"));
    zip.file("linked/secrets", "/home/someone/.ssh/id_rsa", { unixPermissions: 0o120777 });
    const read = await readSkillPackage(await zip.generateAsync({ type: "uint8array", platform: "UNIX" }));
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.deepEqual(read.candidates.map((c) => c.skill.name), ["good"]);
    assert.equal(read.problems.length, 1);
    assert.equal(read.problems[0].path, "linked/SKILL.md");
    assert.equal(read.problems[0].reason, "bundle");
    assert.deepEqual(read.problems[0].bundle, { reason: "symlink", path: "secrets" });
  });

  await check("a path that leaves the archive refuses the whole archive, naming the entry", async () => {
    for (const evil of ["report/../../evil.py", "/etc/cron.d/evil"]) {
      const zip = new JSZip();
      zip.file("report/SKILL.md", skill("report"));
      zip.file(evil, "print('pwned')");
      const read = await readSkillPackage(await zip.generateAsync({ type: "uint8array" }));
      assert.ok(!read.ok, evil);
      if (read.ok) return;
      assert.equal(read.reason, "unsafe_path");
      assert.equal(read.path, evil);
    }
  });

  await check("an oversized file or too many files in a folder refuse that skill", async () => {
    const big = new JSZip();
    big.file("data/SKILL.md", skill("data"));
    big.file("data/reference/huge.txt", "z".repeat(2 * 1024 * 1024 + 1));
    const read = await readSkillPackage(await big.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
    assert.ok(read.ok);
    if (read.ok) assert.deepEqual(read.problems[0]?.bundle, { reason: "file_too_large", path: "reference/huge.txt" });

    const many = new JSZip();
    many.file("lots/SKILL.md", skill("lots"));
    for (let i = 0; i < 200; i++) many.file(`lots/reference/${i}.md`, "x");
    const crowded = await readSkillPackage(await many.generateAsync({ type: "uint8array" }));
    assert.ok(crowded.ok);
    if (crowded.ok) assert.deepEqual(crowded.problems[0]?.bundle, { reason: "too_many_files" });
  });

  console.log(`\n${passed} skill package checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
