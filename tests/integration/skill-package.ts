/*
 * Skill packages: SKILL.md files and zips read the way the importer reads
 * them, and a skill written back out (export) reads back in unchanged.
 * `server-only` modules, hence --conditions=react-server (npm run test:skill-package).
 */
import assert from "node:assert/strict";
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

  console.log(`\n${passed} skill package checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
