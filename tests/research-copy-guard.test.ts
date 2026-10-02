import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

/*
 * No "deep research" and no depth labels in web strings (SPEC §9.9,
 * DECISIONS R1): Research is one feature, sized by its plan, and the web UI
 * names no level — no Quick, Standard, Deep or Max.
 *
 * The guard reads, as text, every string the web shows: string literals,
 * template text and JSX text in `src/components/**`, `src/app/(app)/**`,
 * `src/app/dev/**`, `src/lib/chat/request.ts`, the model descriptions in
 * `src/lib/models.ts`, and every `*_COPY` object anywhere in `src/`. It fails
 * on /deep[ -]research/i anywhere, and on a depth label inside a string about
 * research. Module specifiers (`@/lib/deep-research`), comments and
 * identifiers are not copy and are not read. Allowed: the thinking rung
 * "Max", plan names ("Max ×5") and the native path's server strings, which
 * live outside these paths.
 *
 * SWITCHED ON IN FINAL. Until integration (WS9c) deletes the old research
 * components and renames the composer's strings, the whole-tree sweep is
 * skipped; the Research UI's own new files are held to it now, and the
 * detector itself is tested below.
 */

const FINAL = false;

const root = path.resolve(__dirname, "..");
const SOURCE_EXT = /\.(ts|tsx)$/;

const DEEP_RESEARCH = /deep[ -]research/i;
const LEVEL = /\b(Quick|Standard|Deep|Max)\b/;
const RESEARCH_CONTEXT = /research/i;
/** Plan names and the thinking rung say "Max" in their own right. */
const ALLOWED = [/\bMax ×\s?\d+/, /\bMax\s*\(thinking\)/i];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return parent.moduleSpecifier === node;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && parent.parent && ts.isImportTypeNode(parent.parent)) return true;
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    return callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
  }
  return false;
}

export interface CopyString {
  file: string;
  line: number;
  text: string;
}

/** Every piece of copy in a source: literals, template text and JSX text. `only` narrows to a subtree. */
export function copyStrings(file: string, source: string, only?: (node: ts.Node) => boolean): CopyString[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: CopyString[] = [];
  const push = (node: ts.Node, text: string) => {
    const value = text.replace(/\s+/g, " ").trim();
    if (value) out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: value });
  };
  const visit = (node: ts.Node, inside: boolean) => {
    const now = inside || (only ? only(node) : true);
    if (now) {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isModuleSpecifier(node)) push(node, node.text);
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) push(node, node.text);
      else if (ts.isJsxText(node)) push(node, node.text);
    }
    ts.forEachChild(node, (child) => visit(child, now));
  };
  visit(sf, false);
  return out;
}

/** Why a string breaks the rule, or null. */
export function violation(text: string): string | null {
  if (DEEP_RESEARCH.test(text)) return "says \"deep research\"";
  if (RESEARCH_CONTEXT.test(text) && LEVEL.test(text) && !ALLOWED.some((re) => re.test(text))) return "names a research level";
  return null;
}

const isCopyObject = (node: ts.Node) =>
  ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /_COPY$/.test(node.name.text);

const isModelDescription = (node: ts.Node) =>
  ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "description";

function sweep(files: string[], only?: (node: ts.Node) => boolean): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    for (const item of copyStrings(rel, readFileSync(file, "utf8"), only)) {
      const why = violation(item.text);
      if (why) problems.push(`${item.file}:${item.line} ${why}: ${JSON.stringify(item.text)}`);
    }
  }
  return problems;
}

test("the detector: what counts as a breach and what does not", () => {
  assert.equal(violation("Deep research"), 'says "deep research"');
  assert.equal(violation("Turn off deep-research"), 'says "deep research"');
  assert.equal(violation("Research on, Deep depth"), "names a research level");
  assert.equal(violation("Quick research"), "names a research level");
  assert.equal(violation("Research"), null);
  assert.equal(violation("Max ×5 includes Research"), null);
  // A level word outside a research string is someone else's business (the thinking rung).
  assert.equal(violation("Max"), null);
  assert.equal(violation("Deep dive"), null);
  const found = copyStrings(
    "x.tsx",
    'import { a } from "@/lib/deep-research";\n// deep research in a comment\nconst deepResearch = 1;\nexport const X = () => <p title="Standard research">Deep research</p>;',
  ).map((s) => s.text);
  assert.deepEqual(found, ["Standard research", "Deep research"]);
});

test("the Research UI's own files already pass", () => {
  const ours = walk(path.join(root, "src/components/research")).filter((file) =>
    [
      "copy.ts",
      "scope-card.tsx",
      "research-row.tsx",
      "research-panel.tsx",
      "research-progress.tsx",
      "research-sources.tsx",
      "research-plan.tsx",
      "research-details.tsx",
      "report-view.tsx",
      "report-document.tsx",
      "report-fullscreen.tsx",
      "report-export.tsx",
      "report-card.tsx",
      "citation-card.tsx",
      "keep-researching.tsx",
      "completion-watcher.tsx",
      "guide-mode-switch.tsx",
      "research-view.ts",
      "report-structure.ts",
      "scope-draft.ts",
      "steer.ts",
    ].includes(path.basename(file)),
  );
  assert.ok(ours.length >= 20);
  assert.deepEqual(sweep([...ours, ...walk(path.join(root, "src/app/dev/research"))]), []);
});

test(
  "no web string says deep research or names a research level",
  { skip: FINAL ? false : "switched on in Final, after WS9c removes the old research components (SPEC §9.9)" },
  () => {
    const everywhere = [
      ...walk(path.join(root, "src/components")),
      ...walk(path.join(root, "src/app/(app)")),
      ...walk(path.join(root, "src/app/dev")),
      path.join(root, "src/lib/chat/request.ts"),
    ];
    const problems = [
      ...sweep(everywhere),
      ...sweep([path.join(root, "src/lib/models.ts")], isModelDescription),
      ...sweep(walk(path.join(root, "src")).filter((f) => !everywhere.includes(f)), isCopyObject),
    ];
    assert.deepEqual(problems, []);
  },
);
