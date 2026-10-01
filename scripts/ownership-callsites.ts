/**
 * Static audit of ownership-guarded Prisma call sites.
 *
 * The ownership guard in src/lib/db.ts throws, in every environment, when a
 * read or mutation on a user-owned model reaches it without an owner filter.
 * That makes an unscoped call site an outage rather than a log line, so the
 * gate has to find those call sites before production does.
 *
 * This walks the TypeScript sources, finds every `<client>.<model>.<op>(...)`
 * call on a guarded model and a guarded operation, works out whether the
 * client is the guarded one (`prisma`, or a `tx` from `prisma.$transaction`),
 * and evaluates the `where` clause the same way `whereHasOwner` does, as far
 * as the source allows:
 *
 *  - "unscoped"  the where is a literal with no owner column: it WILL throw.
 *  - "dynamic"   the where is built elsewhere (a helper, a parameter) and
 *                cannot be judged statically; these are listed by the test
 *                with a reason, so a new one is a decision rather than a slip.
 *  - "scoped"    the owner column is present.
 *
 * Calls on `prismaUnguarded` (and its transactions) are skipped: that client
 * is the explicit escape hatch and saying so at the call site is the point.
 * Calls on a client the scanner cannot classify (a `db` parameter, a client
 * built elsewhere) are reported as "indirect" with the same where verdict.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type Verdict = "scoped" | "unscoped" | "dynamic";
export type Receiver = "guarded" | "indirect";

export interface CallSite {
  file: string;
  line: number;
  model: string;
  operation: string;
  receiver: Receiver;
  verdict: Verdict;
  /** Stable key for allowlists: file, model.op and the where text, whitespace-normalised. */
  key: string;
  snippet: string;
}

const GUARDED_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert",
  "count",
  "aggregate",
  "groupBy",
]);

const NEGATIVE_KEYS = new Set(["NOT", "none", "every", "isNot"]);

function accessorName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function walkFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
}

/** Find the initializer a local identifier was declared with, searching the
 * enclosing scopes lexically. Returns null for parameters and anything else. */
function resolveIdentifier(id: ts.Identifier): ts.Expression | null {
  const name = id.text;
  let node: ts.Node | undefined = id.parent;
  while (node) {
    const statements: readonly ts.Statement[] | undefined =
      ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)
        ? node.statements
        : ts.isCaseClause(node) || ts.isDefaultClause(node)
          ? node.statements
          : undefined;
    if (statements) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
            if (declaration.getStart() < id.getStart()) return declaration.initializer;
          }
        }
      }
    }
    node = node.parent;
  }
  return null;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isEmptyValue(expression: ts.Expression): boolean {
  const value = unwrap(expression);
  if (value.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(value) && value.text === "undefined") return true;
  if (ts.isStringLiteral(value) && value.text.length === 0) return true;
  return false;
}

function ownerValue(expression: ts.Expression, depth: number): Verdict {
  const value = unwrap(expression);
  if (isEmptyValue(value)) return "unscoped";
  if (ts.isObjectLiteralExpression(value)) {
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        return "dynamic";
      }
      const key = property.name && ts.isIdentifier(property.name) ? property.name.text : property.name?.getText();
      if (key === "equals") return ts.isPropertyAssignment(property) && isEmptyValue(property.initializer) ? "unscoped" : "scoped";
      if (key === "in") {
        if (!ts.isPropertyAssignment(property)) return "dynamic";
        const list = unwrap(property.initializer);
        if (ts.isArrayLiteralExpression(list)) return list.elements.length > 0 ? "scoped" : "unscoped";
        // A computed list may be empty at runtime, and the guard refuses an empty `in`.
        return "dynamic";
      }
    }
    return "unscoped";
  }
  if (ts.isIdentifier(value) && depth < 6) {
    const initializer = resolveIdentifier(value);
    if (initializer && ts.isObjectLiteralExpression(unwrap(initializer))) return ownerValue(initializer, depth + 1);
  }
  // A string-valued expression: an id in hand. Nullable values are the caller's
  // problem at runtime; the static gate treats a named value as an owner.
  return "scoped";
}

function combineAny(verdicts: Verdict[]): Verdict {
  if (verdicts.includes("scoped")) return "scoped";
  if (verdicts.includes("dynamic")) return "dynamic";
  return "unscoped";
}

function combineAll(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return "unscoped";
  if (verdicts.includes("unscoped")) return "unscoped";
  if (verdicts.includes("dynamic")) return "dynamic";
  return "scoped";
}

/**
 * Functions that build an owner-scoped where from the owner they are handed.
 * Each one is checked by tests/ownership-guard-callsites.test.ts: its result
 * must satisfy `whereHasOwner`, so trusting its name here is not trusting a
 * comment.
 */
export const SCOPING_HELPERS = new Set(["ownedArtifactWhere", "pendingApprovalWhere"]);

export function evaluateWhere(expression: ts.Expression | undefined, column: string, depth = 0): Verdict {
  if (!expression) return "unscoped";
  if (depth > 12) return "dynamic";
  const value = unwrap(expression);
  if (isEmptyValue(value)) return "unscoped";
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && SCOPING_HELPERS.has(value.expression.text)) {
    return "scoped";
  }
  if (ts.isConditionalExpression(value)) {
    return combineAll([evaluateWhere(value.whenTrue, column, depth + 1), evaluateWhere(value.whenFalse, column, depth + 1)]);
  }
  if (ts.isIdentifier(value)) {
    const initializer = resolveIdentifier(value);
    return initializer ? evaluateWhere(initializer, column, depth + 1) : "dynamic";
  }
  if (!ts.isObjectLiteralExpression(value)) return "dynamic";
  const verdicts: Verdict[] = [];
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) {
      verdicts.push(evaluateWhere(property.expression, column, depth + 1) === "scoped" ? "scoped" : "dynamic");
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === column) verdicts.push("scoped");
      else {
        const initializer = resolveIdentifier(property.name);
        if (initializer && ts.isObjectLiteralExpression(unwrap(initializer))) {
          verdicts.push(evaluateWhere(initializer, column, depth + 1));
        }
      }
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
    if (key === null) {
      verdicts.push("dynamic");
      continue;
    }
    if (NEGATIVE_KEYS.has(key)) continue;
    if (key === column) {
      verdicts.push(ownerValue(property.initializer, depth + 1));
      continue;
    }
    const inner = unwrap(property.initializer);
    if (key === "AND") {
      const parts = ts.isArrayLiteralExpression(inner) ? [...inner.elements] : [inner];
      verdicts.push(combineAny(parts.map((part) => evaluateWhere(part as ts.Expression, column, depth + 1))));
    } else if (key === "OR") {
      if (ts.isArrayLiteralExpression(inner)) {
        verdicts.push(combineAll(inner.elements.map((part) => evaluateWhere(part as ts.Expression, column, depth + 1))));
      } else {
        verdicts.push("dynamic");
      }
    } else if (ts.isObjectLiteralExpression(inner)) {
      const nested = evaluateWhere(inner, column, depth + 1);
      if (nested !== "unscoped") verdicts.push(nested);
    } else if (ts.isIdentifier(inner)) {
      const initializer = resolveIdentifier(inner);
      if (initializer && ts.isObjectLiteralExpression(unwrap(initializer))) {
        const nested = evaluateWhere(initializer, column, depth + 1);
        if (nested !== "unscoped") verdicts.push(nested);
      } else if (key.includes(column)) {
        // A compound unique such as `userId_period: key` built elsewhere.
        verdicts.push("dynamic");
      }
    } else if (key.includes(column)) {
      verdicts.push("dynamic");
    }
  }
  return combineAny(verdicts);
}

const PRINTER = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** Source text without comments, so a reworded comment is not a new decision. */
function printed(node: ts.Node): string {
  return PRINTER.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()).replace(/\s+/g, " ").trim();
}

function whereOf(args: ts.Expression | undefined, column: string): { verdict: Verdict; text: string } {
  if (!args) return { verdict: "unscoped", text: "" };
  let value = unwrap(args);
  if (ts.isIdentifier(value)) {
    const initializer = resolveIdentifier(value);
    if (!initializer) return { verdict: "dynamic", text: printed(value) };
    value = unwrap(initializer);
  }
  if (!ts.isObjectLiteralExpression(value)) return { verdict: "dynamic", text: printed(value) };
  let sawSpread = false;
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) sawSpread = true;
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
    if (name !== "where") continue;
    if (ts.isShorthandPropertyAssignment(property)) {
      const initializer = resolveIdentifier(property.name);
      return {
        verdict: initializer ? evaluateWhere(initializer, column) : "dynamic",
        text: initializer ? printed(initializer) : "where",
      };
    }
    if (ts.isPropertyAssignment(property)) {
      return { verdict: evaluateWhere(property.initializer, column), text: printed(property.initializer) };
    }
  }
  return { verdict: sawSpread ? "dynamic" : "unscoped", text: "" };
}

interface Bindings {
  guarded: Set<string>;
  unguarded: Set<string>;
}

function importBindings(source: ts.SourceFile): Bindings {
  const guarded = new Set<string>();
  const unguarded = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    if (!/(^|\/)(lib\/)?(prisma|db)$/.test(from) || !/(@\/lib\/|\.\/|\.\.\/)/.test(from)) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === "prisma") guarded.add(element.name.text);
      if (imported === "prismaUnguarded") unguarded.add(element.name.text);
    }
  }
  // Lazy imports: `const { prisma } = await import("@/lib/prisma")`, including
  // when it is one entry of a destructured Promise.all.
  const lazy = /import\(\s*["'](?:@\/lib\/|\.{1,2}\/(?:\.\.\/)*(?:lib\/)?)(?:prisma|db)["']\s*\)/;
  if (lazy.test(source.text)) {
    const visit = (node: ts.Node): void => {
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
        const imported = node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName.text : node.name.text;
        if (imported === "prisma") guarded.add(node.name.text);
        if (imported === "prismaUnguarded") unguarded.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { guarded, unguarded };
}

function classifyReceiver(expression: ts.Expression, bindings: Bindings, depth = 0): Receiver | "unguarded" {
  const value = unwrap(expression);
  if (!ts.isIdentifier(value) || depth > 4) return "indirect";
  if (bindings.unguarded.has(value.text)) return "unguarded";
  if (bindings.guarded.has(value.text)) return "guarded";
  // A transaction callback parameter: classify by the client that opened it.
  let node: ts.Node | undefined = value.parent;
  while (node) {
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === value.text)) {
      const call = node.parent;
      if (
        call &&
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "$transaction"
      ) {
        return classifyReceiver(call.expression.expression, bindings, depth + 1);
      }
      return "indirect";
    }
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      if (node.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === value.text)) return "indirect";
    }
    node = node.parent;
  }
  const initializer = resolveIdentifier(value);
  if (initializer) {
    const created = unwrap(initializer);
    // A script's own `new PrismaClient()` has no extension: the raw client.
    if (ts.isNewExpression(created) && ts.isIdentifier(created.expression) && created.expression.text === "PrismaClient") {
      return "unguarded";
    }
    return classifyReceiver(initializer, bindings, depth + 1);
  }
  return "indirect";
}

export function scanOwnershipCallSites(
  root: string,
  owners: ReadonlyMap<string, string>,
  directories: string[] = ["src", "scripts"],
): CallSite[] {
  const byAccessor = new Map<string, { model: string; column: string }>();
  for (const [model, column] of owners) byAccessor.set(accessorName(model), { model, column });
  const files: string[] = [];
  for (const directory of directories) {
    const full = path.join(root, directory);
    if (fs.existsSync(full)) walkFiles(full, files);
  }
  const sites: CallSite[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (!/prisma|\$transaction/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const bindings = importBindings(source);
    const relative = path.relative(root, file).split(path.sep).join("/");
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        GUARDED_OPERATIONS.has(node.expression.name.text) &&
        ts.isPropertyAccessExpression(node.expression.expression)
      ) {
        const modelAccess = node.expression.expression;
        const owner = byAccessor.get(modelAccess.name.text);
        if (owner) {
          const receiver = classifyReceiver(modelAccess.expression, bindings);
          if (receiver !== "unguarded") {
            const { verdict, text: whereText } = whereOf(node.arguments[0], owner.column);
            const operation = node.expression.name.text;
            const normalised = whereText.replace(/\s+/g, " ").trim();
            sites.push({
              file: relative,
              line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              model: owner.model,
              operation,
              receiver,
              verdict,
              key: `${relative}|${owner.model}.${operation}|${normalised}`,
              snippet: printed(node).replace(/\s+/g, " ").slice(0, 200),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}
