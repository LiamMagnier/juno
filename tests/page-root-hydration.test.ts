import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * No server-rendered client component sits in a list where React's replay
 * can lose its place.
 *
 * React bug facebook/react#35518, in the React that Next 15.5 bundles: a
 * client component rendered by a server component reaches the browser as a
 * lazy reference. When its chunk is still loading as hydration reaches it,
 * React replays that fiber, and the replay drops the flag that says "this
 * child is an item of a list", so every `useId` below it differs from the
 * server's — the intermittent hydration warning on /dev/thread and
 * /dev/transcript (sidebar Radix ids, SVG mask ids). Only an item of a list
 * is exposed; an only child has no list position to lose. The workaround is
 * `<PageRoot>` (src/components/app/page-root.tsx): a host element that takes
 * the list position, with the client component as its only child.
 *
 * Next itself puts every page and layout in a list: the page in
 * `[SegmentTrieNode, page]` (development) or `[page, layerAssets,
 * OutletBoundary]` (production), a layout in `[layerAssets, layout]`
 * (next/dist/server/app-render/create-component-tree.js). So:
 *
 *  - ROOTS. Every page.tsx and layout.tsx that is not itself "use client" and
 *    whose root (after expanding server components and key-less fragments,
 *    which Flight erases) is a client component wraps it in `<PageRoot>`. A
 *    conditional or early return is a root too, and so is each child of a
 *    multi-child root fragment. Hard failure, with no exceptions:
 *    `(app)/layout.tsx`, whose root `<AppProvider>` sits above every
 *    signed-in route, is wrapped too.
 *  - LIST ITEMS. Below the root, a client component that is one of several
 *    children of a host element or fragment, an item of an array or `.map`, or
 *    one of several children passed to a client component, is in a list too.
 *    Each one found in page.tsx and layout.tsx files (and the server
 *    components they render, followed into src/components) must be wrapped
 *    or listed in `ITEMS_REVIEWED` with the reason it is left: most carry no
 *    `useId` below them, so the replay has no id to get wrong. A new one fails
 *    until someone looks at it.
 *  - `PageRoot` stays a server component that renders one host element with
 *    `display: contents` around exactly one child.
 *
 * Not followed: what a client component does with a single child it is
 * given, JSX passed in other props, and components built by a factory (the
 * glyphs in src/components/ui/icons.tsx, which render juno-icons' client
 * `Icon`). Those show up only in the browser: walk the hydrated fiber tree
 * for fibers whose `elementType` is a `React.lazy` with siblings, and count
 * the `useId` values below each that reached the HTML.
 *
 * A "use client" page.tsx is not flagged. Next renders it as
 * `<ClientPageRoot Component={Page}>`, which is blocked on the module, not
 * lazily typed: React resolves it while reconciling `SegmentViewNode`'s
 * children (a function component, whose replay keeps its flags) or the keyed
 * segment fragment (an only child, with no list flag to lose).
 */

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "src/app");

/** A client component found in a list. `root`: at the page's or layout's own position. */
type Finding = { root: boolean; file: string; line: number; component: string; reason: string };

/** Where an element lands: an item of a list (which `useId` forks on), or an only child. */
type Position = { inList: boolean; root: boolean; where: string };

const sourceCache = new Map<string, ts.SourceFile>();

function parseFile(file: string, text?: string): ts.SourceFile {
  if (text === undefined) {
    const cached = sourceCache.get(file);
    if (cached) return cached;
  }
  const sf = ts.createSourceFile(
    file,
    text ?? fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  if (text === undefined) sourceCache.set(file, sf);
  return sf;
}

function isUseClient(sf: ts.SourceFile): boolean {
  for (const st of sf.statements) {
    if (ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)) {
      if (st.expression.text === "use client") return true;
      continue;
    }
    return false;
  }
  return false;
}

/** A module specifier to a file, the way tsconfig's `@/*` and relative paths resolve. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // a package: Next's own client components ship in its main chunk
  for (const ext of ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"]) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importOf(sf: ts.SourceFile, local: string): { spec: string; imported: string } | null {
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly) continue;
    const spec = (st.moduleSpecifier as ts.StringLiteral).text;
    const clause = st.importClause;
    if (clause.name?.text === local) return { spec, imported: "default" };
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        if (el.name.text === local) return { spec, imported: (el.propertyName ?? el.name).text };
      }
    }
  }
  return null;
}

type FnLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function localFunction(sf: ts.SourceFile, name: string): FnLike | null {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
        const init = unwrap(d.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
        // React.forwardRef((props, ref) => …) / memo(…): the render function.
        if (ts.isCallExpression(init)) {
          const arg = init.arguments[0];
          if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return arg;
        }
      }
    }
  }
  return null;
}

/** The component a module exports under `name`, following one `export { x } from` hop. */
function exportedFunction(file: string, name: string, hops = 0): { sf: ts.SourceFile; fn: FnLike | null; client: boolean } | null {
  const sf = parseFile(file);
  if (isUseClient(sf)) return { sf, fn: null, client: true };
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : [];
    const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (name === "default") {
      if (ts.isFunctionDeclaration(st) && exported && isDefault) return { sf, fn: st, client: false };
      if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) {
        return { sf, fn: localFunction(sf, st.expression.text), client: false };
      }
    } else {
      if (ts.isFunctionDeclaration(st) && exported && st.name?.text === name) return { sf, fn: st, client: false };
      if (ts.isVariableStatement(st) && exported) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return { sf, fn: localFunction(sf, name), client: false };
        }
      }
    }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text !== name) continue;
        const local = (el.propertyName ?? el.name).text;
        if (!st.moduleSpecifier) return { sf, fn: localFunction(sf, local), client: false };
        if (hops > 3) return null;
        const next = resolveSpecifier(file, (st.moduleSpecifier as ts.StringLiteral).text);
        return next ? exportedFunction(next, local, hops + 1) : null;
      }
    }
  }
  return null;
}

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAwaitExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** Every expression the function returns at its own level (not from nested callbacks). */
function returnedExpressions(fn: FnLike): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return out;
}

/** `const chat = (<ChatView … />); return chat;` — the JSX a returned identifier names. */
function localInitializer(fn: FnLike, name: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

function meaningfulChildren(children: ts.NodeArray<ts.JsxChild>): ts.JsxChild[] {
  return children.filter(
    (c) => !(ts.isJsxText(c) && !c.text.trim()) && !(ts.isJsxExpression(c) && !c.expression)
  );
}

type Kind = "client" | "server" | "host" | "safe" | "unknown";

const GLYPH_MODULE = "src/components/ui/icons.tsx";

/** What a JSX tag is: a host element, a client component, a server component to expand. */
function classifyTag(sf: ts.SourceFile, tag: string): { kind: Kind; fn?: FnLike | null; sf?: ts.SourceFile } {
  if (/^[a-z]/.test(tag)) return { kind: "host" };
  if (tag === "PageRoot" || tag === "Suspense" || tag === "React.Suspense") return { kind: "safe" };
  if (tag === "Fragment" || tag === "React.Fragment") return { kind: "host" };
  const imp = importOf(sf, tag.split(".")[0]);
  if (!imp) {
    const fn = localFunction(sf, tag);
    if (!fn) return { kind: "unknown" };
    return isUseClient(sf) ? { kind: "client" } : { kind: "server", fn, sf };
  }
  const file = resolveSpecifier(sf.fileName, imp.spec);
  if (!file) return { kind: "unknown" };
  // Each glyph is built by a factory (`glyph(...)`) whose component renders
  // juno-icons' client `Icon`: rendered by a server component, it lands where
  // the glyph is, as a lazy reference, with mask ids from useId below it.
  if (path.relative(ROOT, file) === GLYPH_MODULE) return { kind: "client" };
  const target = exportedFunction(file, imp.imported);
  if (!target) return { kind: "unknown" };
  if (target.client) return { kind: "client" };
  return { kind: "server", fn: target.fn, sf: target.sf };
}

const MAX_DEPTH = 6;

/**
 * Walk what an expression renders, the way Flight sends it: server components
 * and key-less fragments are erased (what they return takes their place),
 * host elements, keyed fragments, Suspense and client components stay.
 */
function visit(sf: ts.SourceFile, fn: FnLike, expr: ts.Expression, pos: Position, depth: number, out: Finding[]): void {
  const e = unwrap(expr);
  if (ts.isConditionalExpression(e)) {
    visit(sf, fn, e.whenTrue, pos, depth, out);
    visit(sf, fn, e.whenFalse, pos, depth, out);
    return;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return visit(sf, fn, e.right, pos, depth, out);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      visit(sf, fn, e.left, pos, depth, out);
      visit(sf, fn, e.right, pos, depth, out);
      return;
    }
  }
  if (ts.isIdentifier(e)) {
    const init = localInitializer(fn, e.text);
    if (init) visit(sf, fn, init, pos, depth, out);
    return;
  }
  // An array is a list wherever it lands, even an array of one.
  if (ts.isArrayLiteralExpression(e)) {
    for (const item of e.elements) visit(sf, fn, item, { inList: true, root: pos.root, where: "an item of an array" }, depth, out);
    return;
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "map") {
    const cb = e.arguments[0];
    if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
      for (const r of returnedExpressions(cb)) visit(sf, cb, r, { inList: true, root: pos.root, where: "an item of a mapped list" }, depth, out);
    }
    return;
  }
  if (ts.isJsxFragment(e)) return visitChildren(sf, fn, e.children, pos, true, "fragment", depth, out);
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) visitElement(sf, fn, e, pos, depth, out);
}

function visitChild(sf: ts.SourceFile, fn: FnLike, kid: ts.JsxChild, pos: Position, depth: number, out: Finding[]): void {
  if (ts.isJsxText(kid)) return;
  if (ts.isJsxExpression(kid)) {
    if (kid.expression) visit(sf, fn, kid.expression, pos, depth, out);
    return;
  }
  visit(sf, fn, kid as ts.Expression, pos, depth, out);
}

/**
 * Children of an element or fragment. An only child is not in a list, except
 * that an erased fragment's only child takes the fragment's own place; several
 * children are a list, and each is an item of it.
 */
function visitChildren(
  sf: ts.SourceFile,
  fn: FnLike,
  children: ts.NodeArray<ts.JsxChild>,
  pos: Position,
  erased: boolean,
  owner: string,
  depth: number,
  out: Finding[]
): void {
  const kids = meaningfulChildren(children);
  if (kids.length === 1) {
    visitChild(sf, fn, kids[0], erased ? pos : { inList: false, root: false, where: "" }, depth, out);
    return;
  }
  const root = erased && pos.root;
  const where = root ? "a child of the root fragment" : `one of several children of ${owner}`;
  for (const kid of kids) visitChild(sf, fn, kid, { inList: true, root, where }, depth, out);
}

function hasKey(el: ts.JsxElement): boolean {
  return el.openingElement.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === "key");
}

function visitElement(
  sf: ts.SourceFile,
  fn: FnLike,
  el: ts.JsxElement | ts.JsxSelfClosingElement,
  pos: Position,
  depth: number,
  out: Finding[]
): void {
  const tagNode = ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName;
  const tag = tagNode.getText(sf);
  const line = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1;
  const file = path.relative(ROOT, sf.fileName);
  const c = classifyTag(sf, tag);
  if (c.kind === "client") {
    if (pos.inList) out.push({ root: pos.root, file, line, component: tag, reason: `client component <${tag}> is ${pos.where} (${file}:${line})` });
    // Where it puts its children is its own business, but several children
    // are one array wherever they land.
    if (ts.isJsxElement(el) && meaningfulChildren(el.children).length > 1) {
      visitChildren(sf, fn, el.children, { inList: true, root: false, where: "" }, false, `<${tag}>`, depth, out);
    }
    return;
  }
  if (tag === "PageRoot" && ts.isJsxElement(el) && meaningfulChildren(el.children).length !== 1) {
    out.push({ root: true, file, line, component: tag, reason: `<PageRoot> must wrap exactly one element (${file}:${line})` });
    return;
  }
  if (c.kind === "server") {
    if (c.fn && c.sf && depth < MAX_DEPTH) {
      for (const r of returnedExpressions(c.fn)) visit(c.sf, c.fn, r, pos, depth + 1, out);
    }
    return;
  }
  if (c.kind === "unknown" || !ts.isJsxElement(el)) return;
  const erased = (tag === "Fragment" || tag === "React.Fragment") && !hasKey(el);
  visitChildren(sf, fn, el.children, pos, erased, erased ? "a fragment" : `<${tag}>`, depth, out);
}

function defaultExport(sf: ts.SourceFile): FnLike | null {
  let fn: FnLike | null = null;
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : [];
    if (
      ts.isFunctionDeclaration(st) &&
      mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      fn = st;
    }
    if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) fn = localFunction(sf, st.expression.text);
  }
  return fn;
}

/** Every client component in a list, in one page.tsx or layout.tsx (source text may be passed in for fixtures). */
export function findings(file: string, text?: string): Finding[] {
  const sf = parseFile(file, text);
  if (isUseClient(sf)) return [];
  const fn = defaultExport(sf);
  if (!fn) return [];
  const where = path.basename(file) === "layout.tsx" ? "the layout root" : "the page root";
  const out: Finding[] = [];
  for (const r of returnedExpressions(fn)) visit(sf, fn, r, { inList: true, root: true, where }, 0, out);
  return out;
}

/** Root problems in one page.tsx or layout.tsx. */
export function pageRootProblems(file: string, text?: string): string[] {
  return findings(file, text).filter((f) => f.root).map((f) => f.reason);
}

/** Client components in a list below the root. */
export function listItemProblems(file: string, text?: string): string[] {
  return findings(file, text).filter((f) => !f.root).map((f) => f.reason);
}

function routeFiles(dir: string, name: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(p, name, out);
    else if (entry.name === name) out.push(p);
  }
  return out;
}

function pageFiles(dir: string): string[] {
  return routeFiles(dir, "page.tsx");
}

// ── Fixtures: the checker itself ────────────────────────────────────────────
// They live beside real modules so imports resolve: `@/components/app/page-root`
// is a server component, `@/app/dev/thread/thread-scene` a client one.
const FIXTURE = path.join(APP, "dev/thread/__fixture__/page.tsx");
const CLIENT = `import { ThreadScene } from "../thread-scene";`;
const WRAP = `import { PageRoot } from "@/components/app/page-root";`;

test("page root: a client component returned as the page root is flagged", () => {
  const problems = pageRootProblems(FIXTURE, `${CLIENT}\nexport default function P() { return <ThreadScene scene="thread" />; }`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /<ThreadScene> is the page root/);
});

test("page root: the same component inside <PageRoot> passes", () => {
  const src = `${CLIENT}\n${WRAP}\nexport default function P() { return (<PageRoot><ThreadScene scene="thread" /></PageRoot>); }`;
  assert.deepEqual(pageRootProblems(FIXTURE, src), []);
});

test("page root: <PageRoot> around two children is flagged — that is a list again", () => {
  const src = `${CLIENT}\n${WRAP}\nexport default function P() { return (<PageRoot><ThreadScene scene="thread" /><ThreadScene scene="settled" /></PageRoot>); }`;
  assert.match(pageRootProblems(FIXTURE, src).join("\n"), /exactly one element/);
});

test("page root: every return is a root — an early or conditional client return is flagged", () => {
  const src = `${CLIENT}\n${WRAP}\nexport default async function P({ a }: { a: boolean }) {
    if (a) return <ThreadScene scene="thread" />;
    return a ? <PageRoot><ThreadScene scene="settled" /></PageRoot> : <ThreadScene scene="thinking" />;
  }`;
  assert.equal(pageRootProblems(FIXTURE, src).length, 2);
});

test("page root: a returned variable is followed to its JSX", () => {
  const src = `${CLIENT}\nexport default async function P() { const view = (<ThreadScene scene="thread" />); return view; }`;
  assert.equal(pageRootProblems(FIXTURE, src).length, 1);
});

test("page root: host and Suspense roots pass; a client child of a multi-child fragment does not", () => {
  const host = `${CLIENT}\nexport default function P() { return <main><ThreadScene scene="thread" /></main>; }`;
  assert.deepEqual(pageRootProblems(FIXTURE, host), []);
  const suspense = `${CLIENT}\nimport { Suspense } from "react";\nexport default function P() { return <Suspense><ThreadScene scene="thread" /></Suspense>; }`;
  assert.deepEqual(pageRootProblems(FIXTURE, suspense), []);
  const fragment = `${CLIENT}\nexport default function P() { return <><script /><ThreadScene scene="thread" /></>; }`;
  assert.match(pageRootProblems(FIXTURE, fragment).join("\n"), /child of the root fragment/);
});

test("page root: a local server component is expanded to what it returns", () => {
  const src = `${CLIENT}\nfunction Shell() { return <ThreadScene scene="thread" />; }\nexport default function P() { return <Shell />; }`;
  assert.equal(pageRootProblems(FIXTURE, src).length, 1);
});

test("page root: a \"use client\" page.tsx is not flagged (Next wraps it in ClientPageRoot)", () => {
  const src = `"use client";\n${CLIENT}\nexport default function P() { return <ThreadScene scene="thread" />; }`;
  assert.deepEqual(pageRootProblems(FIXTURE, src), []);
});

test("page root: a client component in a conditional child of the root fragment is flagged", () => {
  // /dev/pricing's shape: `<><nav/>{a ? <div/> : <Client/>}</>` — Flight erases
  // the fragment, so the page's place holds the list `[nav, Client]`.
  const src = `${CLIENT}\nexport default function P({ a }: { a: boolean }) { return <><nav />{a ? <div /> : <ThreadScene scene="thread" />}</>; }`;
  assert.match(pageRootProblems(FIXTURE, src).join("\n"), /<ThreadScene> is a child of the root fragment/);
});

test("layout root: a client component returned by a layout is flagged; `return children` is not", () => {
  const LAYOUT = path.join(APP, "dev/thread/__fixture__/layout.tsx");
  const bad = `${CLIENT}\nexport default function L({ children }: { children: React.ReactNode }) { return <ThreadScene scene="thread">{children}</ThreadScene>; }`;
  assert.match(pageRootProblems(LAYOUT, bad).join("\n"), /<ThreadScene> is the layout root/);
  const passthrough = `export default function L({ children }: { children: React.ReactNode }) { return children; }`;
  assert.deepEqual(findings(LAYOUT, passthrough), []);
  const wrapped = `${CLIENT}\n${WRAP}\nexport default function L({ children }: { children: React.ReactNode }) { return <PageRoot><ThreadScene scene="thread">{children}</ThreadScene></PageRoot>; }`;
  assert.deepEqual(findings(LAYOUT, wrapped), []);
});

// ── Fixtures: list items below the root ─────────────────────────────────────

test("list items: one of several children of a host element is flagged; an only child is not", () => {
  const several = `${CLIENT}\nexport default function P() { return <main><h1>Title</h1><ThreadScene scene="thread" /></main>; }`;
  assert.match(listItemProblems(FIXTURE, several).join("\n"), /<ThreadScene> is one of several children of <main>/);
  const only = `${CLIENT}\nexport default function P() { return <main><section><ThreadScene scene="thread" /></section><h1>Title</h1></main>; }`;
  assert.deepEqual(findings(FIXTURE, only), []);
  const wrapped = `${CLIENT}\n${WRAP}\nexport default function P() { return <main><h1>Title</h1><PageRoot><ThreadScene scene="thread" /></PageRoot></main>; }`;
  assert.deepEqual(findings(FIXTURE, wrapped), []);
});

test("list items: arrays and .map are lists even with one item; text siblings count", () => {
  const mapped = `${CLIENT}\nexport default function P({ xs }: { xs: string[] }) { return <main>{xs.map((x) => <ThreadScene key={x} scene="thread" />)}</main>; }`;
  assert.match(listItemProblems(FIXTURE, mapped).join("\n"), /an item of a mapped list/);
  const array = `${CLIENT}\nexport default function P() { return <main>{[<ThreadScene key="a" scene="thread" />]}</main>; }`;
  assert.match(listItemProblems(FIXTURE, array).join("\n"), /an item of an array/);
  const text = `${CLIENT}\nexport default function P() { return <p>Hello <ThreadScene scene="thread" /></p>; }`;
  assert.equal(listItemProblems(FIXTURE, text).length, 1);
});

test("list items: a glyph from the icon module counts as a client component", () => {
  const src = `import { Check } from "@/components/ui/icons";\nexport default function P() { return <p><Check className="size-4" /> Saved</p>; }`;
  assert.match(listItemProblems(FIXTURE, src).join("\n"), /<Check> is one of several children of <p>/);
});

test("list items: several children handed to a client component are a list wherever it puts them", () => {
  const src = `${CLIENT}\n${WRAP}\nexport default function P() { return <PageRoot><ThreadScene scene="thread"><h1 /><ThreadScene scene="settled" /></ThreadScene></PageRoot>; }`;
  assert.match(listItemProblems(FIXTURE, src).join("\n"), /one of several children of <ThreadScene>/);
});

test("list items: a key-less fragment is erased, a keyed one stays; server components are followed", () => {
  // `<main><><A/></></main>`: the fragment is erased, A is main's only child.
  const erased = `${CLIENT}\nexport default function P() { return <main><><ThreadScene scene="thread" /></></main>; }`;
  assert.deepEqual(findings(FIXTURE, erased), []);
  // `<main><Fragment key><A/></Fragment><h1/></main>`: the keyed fragment is the item, A its only child.
  const keyed = `${CLIENT}\nimport { Fragment } from "react";\nexport default function P() { return <main><Fragment key="k"><ThreadScene scene="thread" /></Fragment><h1 /></main>; }`;
  assert.deepEqual(findings(FIXTURE, keyed), []);
  // Without a key the same fragment is erased, and A lands in main's list.
  const unkeyed = `${CLIENT}\nimport { Fragment } from "react";\nexport default function P() { return <main><Fragment><ThreadScene scene="thread" /></Fragment><h1 /></main>; }`;
  assert.equal(listItemProblems(FIXTURE, unkeyed).length, 1);
  // A local server component returning `<div><h1/><Client/></div>` puts Client in a list.
  const server = `${CLIENT}\nfunction Block() { return <div><h1 /><ThreadScene scene="thread" /></div>; }\nexport default function P() { return <main><Block /></main>; }`;
  assert.match(listItemProblems(FIXTURE, server).join("\n"), /one of several children of <div>/);
});

// ── PageRoot itself ─────────────────────────────────────────────────────────

test("PageRoot: a server component rendering one display:contents host element around one child", () => {
  const file = path.join(ROOT, "src/components/app/page-root.tsx");
  const sf = parseFile(file);
  assert.equal(isUseClient(sf), false, "PageRoot must not be a client component: Flight has to erase it");
  const text = sf.getFullText();
  assert.doesNotMatch(text, /\buse(State|Effect|LayoutEffect|Ref|Context|Id|Memo|Callback|Reducer|SyncExternalStore|Transition)\s*\(/);
  const target = exportedFunction(file, "PageRoot");
  assert.ok(target?.fn, "PageRoot is exported as a function");
  const returned = returnedExpressions(target.fn!).map(unwrap);
  assert.equal(returned.length, 1);
  const el = returned[0];
  assert.ok(ts.isJsxElement(el), "PageRoot returns one element");
  assert.equal(el.openingElement.tagName.getText(sf), "div");
  assert.match(el.openingElement.attributes.getText(sf), /className="contents"/);
  assert.equal(meaningfulChildren(el.children).length, 1, "PageRoot renders its children as an only child");
  assert.match(text, /children: ReactElement\b/, "the type admits one element, not a list");
});

// ── The app ─────────────────────────────────────────────────────────────────

const keyOf = (f: Finding) => `${f.file}#${f.component}`;

function appFindings(): Finding[] {
  const files = [...pageFiles(APP), ...routeFiles(APP, "layout.tsx")].sort();
  const seen = new Set<string>();
  // A server component rendered by several routes is reported once.
  return files.flatMap((f) => findings(f)).filter((f) => {
    const k = `${keyOf(f)}:${f.line}:${f.root}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/*
 * Why a list item can stay as it is. Two reasons hold up:
 *  - NO_HTML_IDS: no `useId` value below it reaches the HTML, so a replay has
 *    nothing to mismatch (checked in the browser where the route opens
 *    without a session, by reading the component where it does not).
 *  - SAME_CHUNK: every client component a segment renders comes from that
 *    segment's chunk, and React suspends only on the first one it reaches
 *    while the chunk is loading. Once it resolves the rest resolve without
 *    suspending, so they are never replayed. Seen directly with /dev/pricing's
 *    chunk held back: only the first client reference (a nav link) replayed,
 *    never the gallery after it in the same chunk.
 */
const NO_HTML_IDS = "no useId value below it reaches the HTML";
const SAME_CHUNK = (first: string) =>
  `same chunk as ${first}, which React reaches first: once that chunk has loaded this resolves without suspending, so it is never replayed`;

const ITEMS_REVIEWED: Record<string, string> = {
  "src/app/(app)/layout.tsx#AppShell": SAME_CHUNK("<AppProvider>"),
  "src/app/(app)/layout.tsx#SettingsModalLazy": `${NO_HTML_IDS} (it renders null until opened)`,
  "src/app/(auth)/forgot-password/page.tsx#ForgotPasswordForm": `${NO_HTML_IDS} (fixed ids; and a wrapper would drop its space-y-6 gap)`,
  "src/app/(auth)/reset-password/page.tsx#ResetPasswordForm": `${NO_HTML_IDS} (fixed ids; and a wrapper would drop its space-y-6 gap)`,
  "src/app/(legal)/layout.tsx#PublicDocumentNav": NO_HTML_IDS,
  "src/app/suspended/page.tsx#SuspendedActions": `${NO_HTML_IDS} (one Button)`,
  "src/components/app/app-page-header.tsx#Tooltip": `${NO_HTML_IDS} (a closed Radix tooltip writes no aria-describedby)`,
  "src/components/app/app-page-header.tsx#TooltipTrigger": `${NO_HTML_IDS} (a closed Radix tooltip writes no aria-describedby)`,
  "src/components/app/app-page-header.tsx#TooltipContent": `${NO_HTML_IDS} (not rendered while closed)`,
  "src/components/code/code-landing.tsx#HomeField": `${NO_HTML_IDS} (the dot construction uses no useId)`,
  "src/components/code/code-landing.tsx#CodeComposer": SAME_CHUNK("<HomeField>"),
  "src/components/compare-public/vs-parts.tsx#PublicAction": NO_HTML_IDS,
  "src/components/home/aleph.tsx#InView": NO_HTML_IDS,
  "src/components/home/bento.tsx#InView": NO_HTML_IDS,
  "src/components/home/code-scene.tsx#InView": NO_HTML_IDS,
  "src/components/home/home-page.tsx#Hero": NO_HTML_IDS,
  "src/components/home/home-page.tsx#Showcase": NO_HTML_IDS,
  "src/components/home/home-page.tsx#OrbitScene": NO_HTML_IDS,
  "src/components/home/home-page.tsx#PublicAction": NO_HTML_IDS,
  "src/components/home/home-page.tsx#HomeReveal": NO_HTML_IDS,
  "src/components/landing/site-chrome.tsx#LandingHeader": NO_HTML_IDS,
  // The home page's glyphs: some draw a knockout <mask> whose id comes from
  // useId, so these do put ids in the HTML. They are safe only by order.
  ...Object.fromEntries(
    [
      "bento.tsx#BookOpen",
      "bento.tsx#EyeOff",
      "bento.tsx#MessageSquareText",
      "bento.tsx#Plug",
      "bento.tsx#Sparkles",
      "bento.tsx#UserPen",
      "code-scene.tsx#Check",
      "code-scene.tsx#FileCode",
      "code-scene.tsx#GitBranch",
      "code-scene.tsx#Terminal",
      "home-page.tsx#DownloadIcon",
      "home-page.tsx#EyeOff",
      "home-page.tsx#Lock",
      "home-page.tsx#ShieldCheck",
    ].map((k) => [`src/components/home/${k}`, SAME_CHUNK("<LandingHeader>, the home page's first client component")])
  ),
};

test("page root: no page.tsx in src/app hands Next a client component as its root", () => {
  const files = pageFiles(APP).sort();
  assert.ok(files.length > 50, `found ${files.length} page.tsx files`);
  const problems = files.flatMap((f) => pageRootProblems(f));
  assert.deepEqual(problems, [], `Wrap each in <PageRoot> (src/components/app/page-root.tsx):\n${problems.join("\n")}`);
});

test("layout root: no layout.tsx hands Next a client component as its root", () => {
  const files = routeFiles(APP, "layout.tsx");
  assert.ok(files.length >= 5, `found ${files.length} layout.tsx files`);
  const roots = files.flatMap((f) => findings(f)).filter((f) => f.root).map((f) => f.reason);
  assert.deepEqual(roots, [], `Wrap each in <PageRoot> (src/components/app/page-root.tsx):\n${roots.join("\n")}`);
});

test("layout root: the signed-in layout wraps AppProvider, the root of every signed-in route", () => {
  const text = fs.readFileSync(path.join(APP, "(app)/layout.tsx"), "utf8");
  assert.match(text, /import \{ PageRoot \} from "@\/components\/app\/page-root";/);
  assert.match(text, /<PageRoot>\s*<AppProvider bootstrap=\{bootstrap\}>[\s\S]*<\/AppProvider>\s*<\/PageRoot>/);
});

test("list items: every client component in a list below a root is wrapped or reviewed", () => {
  const items = appFindings().filter((f) => !f.root);
  const unreviewed = items.filter((f) => !(keyOf(f) in ITEMS_REVIEWED)).map((f) => f.reason);
  assert.deepEqual(
    unreviewed,
    [],
    "Wrap each in <PageRoot> if useId values below it reach the HTML (Radix aria-controls, <mask id>), " +
      `or add it to ITEMS_REVIEWED with the reason it can stay:\n${unreviewed.join("\n")}`
  );
});

test("list items: no stale entries", () => {
  const all = new Set(appFindings().map(keyOf));
  const stale = Object.keys(ITEMS_REVIEWED).filter((k) => !all.has(k));
  assert.deepEqual(stale, [], "these are no longer found (wrapped, moved or renamed): delete their entries");
});

// ── Nonce'd inline scripts ──────────────────────────────────────────────────

/**
 * An inline `<script nonce>` in a page or layout: the browser hides a checked
 * nonce from the DOM (it reads back as ""), so hydration reports a mismatch on
 * every load unless the element says to expect one. /engineering/file-understanding
 * did, on 6 of 6 loads.
 */
export function nonceScriptProblems(file: string, text?: string): string[] {
  const sf = parseFile(file, text);
  const out: string[] = [];
  const visitNode = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      if (node.tagName.getText(sf) === "script") {
        const names = node.attributes.properties.flatMap((p) => (ts.isJsxAttribute(p) ? [p.name.getText(sf)] : []));
        if (names.includes("nonce") && !names.includes("suppressHydrationWarning")) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          out.push(`<script nonce> without suppressHydrationWarning (${path.relative(ROOT, file)}:${line})`);
        }
      }
    }
    ts.forEachChild(node, visitNode);
  };
  visitNode(sf);
  return out;
}

test("nonce scripts: a nonce'd inline script without suppressHydrationWarning is flagged", () => {
  assert.equal(nonceScriptProblems(FIXTURE, `export default function P() { return <script nonce="n" type="application/ld+json" />; }`).length, 1);
  assert.deepEqual(nonceScriptProblems(FIXTURE, `export default function P() { return <script nonce="n" suppressHydrationWarning type="application/ld+json" />; }`), []);
});

test("nonce scripts: every one in src/app expects the hidden nonce", () => {
  const files = [...pageFiles(APP), ...routeFiles(APP, "layout.tsx")];
  const problems = files.flatMap((f) => nonceScriptProblems(f));
  assert.deepEqual(problems, [], problems.join("\n"));
});
