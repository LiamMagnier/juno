import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { canonicalToolNames, narrowRuntimeToolsForSkill, type ChatSkillApplication } from "@/lib/chat/skills";
import { partitionTools } from "@/lib/skills/sources";
import { TOOL_ID_ALIASES, canonicalToolId, toolIdAliasesOf } from "@/lib/tools/aliases";
import { junoToolSpec } from "@/lib/tools/registry";

/*
 * Old tool ids stay valid forever (INV-23, SPEC §3.5): `code_interpreter` is
 * `run_code` and `browser_agent` is `web_fetch` wherever a person stored one —
 * a skill's requested tools, a standing approval, a persisted activity row, a
 * history note. Readers map through `canonicalToolId`; stored values are never
 * rewritten.
 */

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

test("the alias map: two renames, both to registry tools", () => {
  assert.deepEqual({ ...TOOL_ID_ALIASES }, { code_interpreter: "run_code", browser_agent: "web_fetch" });
  for (const target of Object.values(TOOL_ID_ALIASES)) assert.ok(junoToolSpec(target), target);
  assert.equal(canonicalToolId("code_interpreter"), "run_code");
  assert.equal(canonicalToolId("browser_agent"), "web_fetch");
  assert.equal(canonicalToolId("read_document"), "read_document", "an unaliased id is unchanged");
  assert.equal(canonicalToolId("python_interpreter"), "python_interpreter", "an unknown id is left alone");
  assert.equal(canonicalToolId("constructor"), "constructor", "no prototype lookups");
  assert.equal(canonicalToolId("__proto__"), "__proto__");
});

test("skills: a stored old name narrows and resolves as the new one", () => {
  assert.deepEqual(canonicalToolNames(["browser_agent", "web_fetch", "code_interpreter", "canvas"]), ["web_fetch", "run_code", "canvas"]);
  const application = {
    resolved: { tools: ["browser_agent"], withheld: { tools: ["code_interpreter"], connectors: [], apps: [], domains: [] } },
  } as unknown as ChatSkillApplication;
  assert.deepEqual(narrowRuntimeToolsForSkill(["read_document", "run_code", "web_fetch"], application), ["run_code", "web_fetch"]);
  // An import writes the new name; a skill already stored keeps its old one.
  assert.deepEqual(partitionTools(["code_interpreter", "run_code", "Bash(git add *)"]), {
    carried: ["run_code"],
    dropped: ["Bash(git add *)"],
  });
  const sources = read("src/lib/skills/sources.ts");
  assert.match(sources, /canonicalTools\(installed\.requestedTools\)/, "an old stored name is not an upstream change");
});

test("standing grants: a grant under the old name still covers the new one", () => {
  assert.deepEqual(toolIdAliasesOf("run_code"), ["run_code", "code_interpreter"]);
  assert.deepEqual(toolIdAliasesOf("web_fetch"), ["web_fetch", "browser_agent"]);
  assert.deepEqual(toolIdAliasesOf("calculate"), ["calculate"]);
  const store = read("src/lib/action-approval-store.ts");
  assert.match(store, /connectorId === "juno_runtime" \? toolIdAliasesOf\(canonicalToolId\(toolName\)\) : \[toolName\]/);
  assert.match(store, /toolName: names\.length === 1 \? names\[0\] : \{ in: names \}/);
});

test("legacy rows and notes: a stored activity detail reads as the new tool", () => {
  // The legacy adapter (§7.7) and the T7 notes (§4.9) present `detail` through this.
  for (const [stored, current] of [["code_interpreter", "run_code"], ["browser_agent", "web_fetch"]] as const) {
    const spec = junoToolSpec(canonicalToolId(stored));
    assert.equal(spec?.id, current);
  }
});

test("prompt copy names the new tool", () => {
  for (const file of ["src/lib/chat/prompt-sections.ts", "src/lib/chat/context-assembly.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /code_interpreter/, file);
    assert.match(source, /run_code/, file);
  }
});
