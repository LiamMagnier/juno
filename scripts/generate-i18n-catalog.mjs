import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(projectRoot, "src");
const outputPath = join(sourceRoot, "lib", "i18n-catalog.generated.ts");

const COPY_PROPERTIES = new Set([
  "alt",
  "aria-label",
  "body",
  "caption",
  "description",
  "detail",
  "emptyLabel",
  "error",
  "eyebrow",
  "heading",
  "helpText",
  "label",
  "lede",
  "message",
  // The composer's armed marks (`ComposerArmedMark`) name two actions that a
  // pointer user never reads: what pressing the mark does and what its ✕ does.
  // They were `aria-label` attributes on two hand-written pills and were
  // extracted as such; consolidating the marks into one ordered list moved the
  // same sentences into object properties, where the attribute branch below
  // cannot see them. A prop that holds a sentence a screen reader will read out
  // is copy wherever it is written down.
  "openLabel",
  "removeLabel",
  // The time-of-day greeting phrases in chat/empty-state.tsx. They are the
  // first words a signed-in user reads and were the only UI copy on that screen
  // the extractor could not see — an array of strings under an object property,
  // which matches neither a COPY_PROPERTY nor the copy-variable naming rule.
  "phrases",
  "placeholder",
  "subject",
  "term",
  "title",
  "tooltip",
]);

/*
 * MODEL-FACING TEXT NEVER REACHES THE CATALOG (SPEC §10.5, INV-29).
 *
 * A tool's description, its parameter docs and the prompts around it are
 * English written for a model, not UI copy: translating them would only spend
 * a translation budget on strings no reader sees, and a translated prompt
 * would be a bug. They live in exactly two places so this file can skip them
 * by shape rather than by guesswork:
 *
 *   - `*.prompt.ts` files, skipped whole;
 *   - the argument subtree of a `defineTool(...)` call, whose `description`
 *     and `title` keys would otherwise match COPY_PROPERTIES below.
 */
function isPromptFile(path) {
  return /\.prompt\.ts$/.test(path);
}

function isDefineToolCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (ts.isIdentifier(callee) && callee.text === "defineTool")
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === "defineTool");
}

function add(strings, raw) {
  const value = raw
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length < 2 || value.length > 300 || !/\p{L}/u.test(value)) return;
  strings.add(value);
}

/**
 * The display-name registry (src/lib/brand/names.ts), evaluated. Its exports
 * flatten to "PRODUCT_NAME" → "Alevr", "BRAND.orbit.label" → "Orbit" and so
 * on. Copy built from those names — `${PRODUCT_NAME} could not reach the
 * server.` — resolves through this map to the sentence as it renders, so the
 * catalog holds it whole and renaming the product is still one edit. The
 * registry imports nothing, which is what lets it be evaluated here.
 */
const registryPath = join(sourceRoot, "lib", "brand", "names.ts");
const registry = new Map();
{
  const { outputText } = ts.transpileModule(readFileSync(registryPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const names = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
  const flatten = (path, value) => {
    if (typeof value === "string") {
      registry.set(path, value);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) flatten(`${path}.${key}`, child);
    }
  };
  for (const [name, value] of Object.entries(names)) flatten(name, value);
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression;
  return current;
}

/**
 * The text an expression always renders: a literal, a registry name, or a
 * template or `+` concatenation made only of those. Anything that depends on
 * runtime data is null, so it never reaches the catalog.
 */
function staticText(node) {
  const bare = unwrapExpression(node);
  if (ts.isStringLiteral(bare) || ts.isNoSubstitutionTemplateLiteral(bare)) return bare.text;
  if (ts.isIdentifier(bare) || ts.isPropertyAccessExpression(bare)) {
    return registry.get(bare.getText().replace(/\s+/g, "").replace(/\?\./g, ".")) ?? null;
  }
  if (ts.isTemplateExpression(bare)) {
    let text = bare.head.text;
    for (const span of bare.templateSpans) {
      const value = staticText(span.expression);
      if (value === null) return null;
      text += value + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(bare) && bare.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(bare.left);
    const right = left === null ? null : staticText(bare.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function isDirectJsxChildExpression(node) {
  let current = node.parent;
  while (current) {
    if (ts.isJsxExpression(current)) {
      return ts.isJsxElement(current.parent) || ts.isJsxFragment(current.parent);
    }
    // Permit static branches rendered directly as children, but stop before
    // calls/objects such as className={cn("...")} and style={{ ... }}.
    if (
      !ts.isConditionalExpression(current)
      && !ts.isParenthesizedExpression(current)
      && !ts.isBinaryExpression(current)
      && !ts.isAsExpression(current)
      && !ts.isSatisfiesExpression(current)
    ) return false;
    current = current.parent;
  }
  return false;
}

function collectNode(strings, root) {
  const add1 = (raw) => add(strings, raw);
  const visit = (node) => {
  // Model-facing: never harvested (see isDefineToolCall).
  if (isDefineToolCall(node)) return;
  if (ts.isJsxText(node)) add1(node.text);

  if (ts.isJsxAttribute(node) && COPY_PROPERTIES.has(node.name.text)) {
    if (node.initializer && ts.isStringLiteral(node.initializer)) add1(node.initializer.text);
    if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      const value = staticText(node.initializer.expression);
      if (value) add1(value);
    }
  }

  if (ts.isPropertyAssignment(node)) {
    const name = propertyName(node.name);
    if (name && COPY_PROPERTIES.has(name)) {
      const value = staticText(node.initializer);
      if (value) add1(value);
      // A copy property can hold a LIST of strings — e.g. the time-of-day
      // greeting variants — not only one. Without this, a property whose value
      // is an array is silently skipped and its copy never reaches the catalog.
      else if (ts.isArrayLiteralExpression(node.initializer)) {
        for (const element of node.initializer.elements) {
          const item = staticText(element);
          if (item) add1(item);
        }
      }
    }
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const isCopyVariable = /(?:Label|Title|Heading|Description|Message|Note|Placeholder|Copy|Tooltip)$/i.test(node.name.text)
      || /_(?:LABEL|TITLE|HEADING|DESCRIPTION|MESSAGE|NOTE|PLACEHOLDER|ERROR)$/.test(node.name.text);
    if (isCopyVariable) {
      const collectInitializer = (child) => {
        if (isDefineToolCall(child)) return;
        const value = staticText(child);
        if (value) add1(value);
        ts.forEachChild(child, collectInitializer);
      };
      collectInitializer(node.initializer);
    }
  }

  if (ts.isCallExpression(node)) {
    const expression = node.expression.getText();
    if (/^(?:toast\.(?:success|error|message|info|warning)|Error)$/.test(expression)) {
      const value = node.arguments[0] ? staticText(node.arguments[0]) : null;
      if (value) add1(value);
    }
  }

  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && isDirectJsxChildExpression(node)) {
    add1(node.text);
  }

  // A sentence that names the product renders as one text node, so it is
  // catalogued as one: {`${PRODUCT_NAME} can make mistakes.`}.
  if (ts.isTemplateExpression(node) && isDirectJsxChildExpression(node)) {
    const value = staticText(node);
    if (value) add1(value);
  }

  ts.forEachChild(node, visit);
  };
  visit(root);
}

/** The UI strings in one source file's text. Pure: no I/O. `*.prompt.ts` yields nothing. */
export function collectFromSource(content, path, strings = new Set()) {
  if (isPromptFile(path)) return strings;
  const kind = extname(path) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  collectNode(strings, source);
  return strings;
}

/** Every UI string under `dir` (`.ts`/`.tsx`, recursively), skipping `skip` paths. */
export function collectCatalogStrings(dir, { skip = [] } = {}) {
  const strings = new Set();
  if (dir === sourceRoot) {
    for (const value of registry.values()) {
      add(strings, value);
    }
  }
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (![".ts", ".tsx"].includes(extname(path)) || skip.includes(path)) continue;
      collectFromSource(readFileSync(path, "utf8"), path, strings);
    }
  };
  walk(dir);
  return strings;
}

/** The catalog entry of a source string: its id is what the browser sends, never the text. */
export function catalogEntry(source) {
  return { id: createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16), source };
}

function main() {
  const strings = collectCatalogStrings(sourceRoot, { skip: [outputPath] });
  const catalog = [...strings].map(catalogEntry).sort((a, b) => a.id.localeCompare(b.id));

  const generated = `// Generated by scripts/generate-i18n-catalog.mjs — do not edit by hand.\n` +
    `// It contains static interface copy only; user content is never included.\n` +
    `export const UI_TRANSLATION_CATALOG = ${JSON.stringify(catalog, null, 2)} as const;\n`;

  writeFileSync(outputPath, generated, "utf8");
  console.log(`Wrote ${catalog.length} UI strings to ${relative(projectRoot, outputPath)}`);
}

// Run as a script (`npm run i18n:extract`); imported (the extractor test), it only exports.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
