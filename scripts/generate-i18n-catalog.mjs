import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(projectRoot, "src");
const outputPath = join(sourceRoot, "lib", "i18n-catalog.generated.ts");
const strings = new Set();

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

function add(raw) {
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
      add(value);
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

function visit(node) {
  if (ts.isJsxText(node)) add(node.text);

  if (ts.isJsxAttribute(node) && COPY_PROPERTIES.has(node.name.text)) {
    if (node.initializer && ts.isStringLiteral(node.initializer)) add(node.initializer.text);
    if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      const value = staticText(node.initializer.expression);
      if (value) add(value);
    }
  }

  if (ts.isPropertyAssignment(node)) {
    const name = propertyName(node.name);
    if (name && COPY_PROPERTIES.has(name)) {
      const value = staticText(node.initializer);
      if (value) add(value);
      // A copy property can hold a LIST of strings — e.g. the time-of-day
      // greeting variants — not only one. Without this, a property whose value
      // is an array is silently skipped and its copy never reaches the catalog.
      else if (ts.isArrayLiteralExpression(node.initializer)) {
        for (const element of node.initializer.elements) {
          const item = staticText(element);
          if (item) add(item);
        }
      }
    }
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const isCopyVariable = /(?:Label|Title|Heading|Description|Message|Note|Placeholder|Copy|Tooltip)$/i.test(node.name.text)
      || /_(?:LABEL|TITLE|HEADING|DESCRIPTION|MESSAGE|NOTE|PLACEHOLDER|ERROR)$/.test(node.name.text);
    if (isCopyVariable) {
      const collectInitializer = (child) => {
        const value = staticText(child);
        if (value) add(value);
        ts.forEachChild(child, collectInitializer);
      };
      collectInitializer(node.initializer);
    }
  }

  if (ts.isCallExpression(node)) {
    const expression = node.expression.getText();
    if (/^(?:toast\.(?:success|error|message|info|warning)|Error)$/.test(expression)) {
      const value = node.arguments[0] ? staticText(node.arguments[0]) : null;
      if (value) add(value);
    }
  }

  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && isDirectJsxChildExpression(node)) {
    add(node.text);
  }

  // A sentence that names the product renders as one text node, so it is
  // catalogued as one: {`${PRODUCT_NAME} can make mistakes.`}.
  if (ts.isTemplateExpression(node) && isDirectJsxChildExpression(node)) {
    const value = staticText(node);
    if (value) add(value);
  }

  ts.forEachChild(node, visit);
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (![".ts", ".tsx"].includes(extname(path)) || path === outputPath) continue;
    const content = readFileSync(path, "utf8");
    const kind = extname(path) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
    visit(source);
  }
}

walk(sourceRoot);

const catalog = [...strings]
  .map((source) => ({
    id: createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16),
    source,
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

const generated = `// Generated by scripts/generate-i18n-catalog.mjs — do not edit by hand.\n` +
  `// It contains static interface copy only; user content is never included.\n` +
  `export const UI_TRANSLATION_CATALOG = ${JSON.stringify(catalog, null, 2)} as const;\n`;

writeFileSync(outputPath, generated, "utf8");
console.log(`Wrote ${catalog.length} UI strings to ${relative(projectRoot, outputPath)}`);
