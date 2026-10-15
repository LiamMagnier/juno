import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Linter, RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import noCodename from "../eslint-rules/no-codename.js";
import { detectFormat, findConversationsEntry } from "@/lib/history-import";
import { PANEL_COPY } from "@/components/chat/panel/copy";
import { PANEL_COPY_DE } from "@/components/chat/panel/copy-de";
import { FINAL_ROUND_NOTE } from "@/lib/llm/loop.prompt";

/**
 * G44: nobody reads the codename. The product is Alevr; "Juno" stays in
 * identifiers, storage keys, routes and the User-Agent, and never in a
 * sentence. The rule is pinned by example below, and then swept over every
 * tree whose strings a person (or the model, which repeats them) can read:
 * the web app, the three runner scripts whose errors and pull requests users
 * see, and the cloud agent runtime.
 */

RuleTester.describe = (_text: string, fn: () => void) => fn();
RuleTester.it = (text: string, fn: () => void) => {
  test(`no-codename: ${text}`, fn);
};
RuleTester.itOnly = RuleTester.it;

/** A fresh object each time: RuleTester normalises the one it is handed in place. */
const languageOptions = () => ({
  parser: tsParser as never,
  parserOptions: { ecmaVersion: 2022, sourceType: "module", ecmaFeatures: { jsx: true } },
});

new RuleTester({ languageOptions: languageOptions() }).run("brand/no-codename", noCodename as never, {
  valid: [
    // Identifiers and stable lower-case spellings are not prose.
    'const JunoVoiceGlow = 1; window.dispatchEvent(new CustomEvent("juno:composer-seed"));',
    'import { x } from "@/components/ui/juno-icons";',
    'const key = "juno:sidebar-collapsed";',
    // Protocol: User-Agent values and X-Juno- header names keep their spelling.
    'fetch(u, { headers: { "User-Agent": "Juno" } });',
    'fetch(u, { headers: { "User-Agent": `Juno-Skill-Import/${v}` } });',
    'const USER_AGENT = "Juno Work (+https://example.test)";',
    'headers.set("X-Juno-Request-Id", id);',
    // A property key spelled as a string is an identifier.
    'const m = { "Juno": 1 };',
    // The product's name, written the right way.
    'const message = `${PRODUCT_NAME} could not reach the server.`;',
    "const el = <p>{`${PRODUCT_NAME} can make mistakes.`}</p>;",
    // TypeScript syntax parses (the sweep below depends on it).
    'const key: string = "juno:draft"; type T = { name: "x" };',
  ],
  invalid: [
    { code: 'toast.error("Juno could not save that.");', errors: [{ messageId: "codename" }] },
    { code: "const t = `Steps appear here as Juno works.`;", errors: [{ messageId: "codename" }] },
    { code: "const t = `${n} files is more than Juno will download.`;", errors: [{ messageId: "codename" }] },
    { code: "const el = <p>Ask Juno anything</p>;", errors: [{ messageId: "codename" }] },
    { code: 'const el = <input placeholder="Message Juno" />;', errors: [{ messageId: "codename" }] },
    { code: 'const label = { title: "Juno Code" };', errors: [{ messageId: "codename" }] },
    { code: 'const note: string = "Juno saved it";', errors: [{ messageId: "codename" }] },
  ],
});

test("no-codename: the shared predicate matches the word, not the identifier spelling", () => {
  const { namesCodename } = noCodename as unknown as { namesCodename: (text: string) => boolean };
  assert.equal(namesCodename("Juno could not"), true);
  assert.equal(namesCodename("Ask Juno."), true);
  assert.equal(namesCodename("juno:composer-seed"), false);
  assert.equal(namesCodename("JunoVoiceGlow"), false);
  assert.equal(namesCodename("X-Juno-Request-Id"), false);
  assert.equal(namesCodename("Alevr"), false);
});

/* ——— The sweep ——————————————————————————————————————————————————————— */

const ROOT = path.resolve(__dirname, "..");
const SOURCE = /\.(?:ts|tsx|mjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Where the codename is still deliberate, and why. Each entry is a protocol
 * string, not prose, and is mirrored byte-for-byte by the Swift engine, which
 * persists it in compacted transcripts; renaming one side would break the
 * other's parser.
 */
const SWEEP_EXEMPT = new Set([
  "runner/agent-core/src/compaction.ts",
]);

const SWEPT_TREES = ["src", "runner/agent-core/src", "runner/env-server/src"];
const SWEPT_FILES = ["scripts/work-runner.ts", "scripts/work-trigger-poller.ts", "scripts/cloud-code-runner.mjs"];

function sweptFiles(): string[] {
  const files = SWEPT_TREES.flatMap((tree) => walk(path.join(ROOT, tree)));
  files.push(...SWEPT_FILES.map((file) => path.join(ROOT, file)));
  return files.filter((file) => {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (rel.startsWith("src/app/dev/")) return false; // dev galleries 404 in production
    if (rel.includes("/test/") || rel.endsWith(".test.ts")) return false; // fixtures, not product copy
    if (SWEEP_EXEMPT.has(rel)) return false;
    return true;
  });
}

test("no user-visible string in the product names the codename", () => {
  const linter = new Linter({ configType: "flat" });
  const config = [
    {
      files: ["**/*.{ts,tsx,mjs}"],
      languageOptions: languageOptions(),
      plugins: { brand: { rules: { "no-codename": noCodename as never } } },
      rules: { "brand/no-codename": "error" as const },
    },
  ];
  const offenders: string[] = [];
  for (const file of sweptFiles()) {
    const text = readFileSync(file, "utf8");
    if (!/\bJuno\b/.test(text)) continue; // most files cannot match; skip the parse
    const rel = path.relative(ROOT, file);
    for (const message of linter.verify(text, config as never, { filename: rel })) {
      if (message.ruleId === "brand/no-codename") offenders.push(`${rel}:${message.line}`);
      else if (message.fatal) offenders.push(`${rel}:${message.line} (parse error: ${message.message})`);
    }
  }
  assert.deepEqual(offenders, [], `the codename reaches a reader at:\n  ${offenders.join("\n  ")}`);
});

/* ——— What changed for readers ————————————————————————————————————————— */

test("the Activity panel's copy names Alevr, and its German fixture still covers every phrase", () => {
  assert.equal(PANEL_COPY.timeline.emptyDetail, "Steps appear here as Alevr works.");
  assert.equal(PANEL_COPY.approval.risk.external_write, "Leaves Alevr");
  assert.ok(PANEL_COPY_DE[PANEL_COPY.timeline.emptyDetail], "the German fixture is keyed by the new English");
  assert.ok(!Object.values(PANEL_COPY_DE).some((value) => /\bJuno\b/.test(value)));
});

test("the model is never told it is anything but Alevr", () => {
  assert.match(FINAL_ROUND_NOTE, /^\[Alevr: /);
});

test("an account export is named for Alevr, and an archive from before the rename still imports", () => {
  assert.equal(findConversationsEntry(["alevr-export.json", "attachments/a.png"]), "alevr-export.json");
  assert.equal(detectFormat(["alevr-export.json"]), "juno");
  assert.equal(findConversationsEntry(["juno-export.json"]), "juno-export.json");
  assert.equal(detectFormat(["nested/juno-export.json"]), "juno");
});

test("downloads a person saves carry the product's name, not the codename", () => {
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
  assert.match(read("src/components/memory/use-memory.ts"), /`alevr-memory-\$\{/);
  assert.match(read("src/app/api/account/export/route.ts"), /filename="alevr-export-\$\{date\}\.zip"/);
  assert.match(read("src/app/api/design/[artifactId]/export/route.ts"), /\.alevr\.design\.json`/);
  assert.match(read("src/components/design/design-editor.tsx"), /\.alevr-handoff\.json`/);
  assert.match(read("scripts/cloud-code-runner.mjs"), /"user\.name", "Alevr Code"/);
});
