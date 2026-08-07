import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

/*
 * Static approval-dispatch gate.
 *
 * Tool execution is deliberately concentrated in a handful of production
 * chokepoints. This check inventories those sinks and proves that the policy /
 * receipt call stays in front of each one. It uses the TypeScript parser (and
 * a small Swift lexer) so a comment, string, test fixture, or formatting change
 * cannot make a missing gate look present.
 *
 * When a new production dispatch path is intentional, route it through an
 * existing gated registry/broker first, then extend the inventory here. Never
 * add an unqualified allow-list entry: the order assertions are the safety
 * property this script exists to preserve.
 */

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`missing required production file: ${relativePath}`);
    return "";
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function isTestPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const base = segments.at(-1) ?? "";
  return (
    segments.some((part) => part === "test" || part === "tests" || part === "__tests__" || part === "fixtures") ||
    /(?:^|\.)test\.[^.]+$/.test(base) ||
    /(?:^|\.)spec\.[^.]+$/.test(base)
  );
}

function walk(relativeDirectory, extensions) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  if (!fs.existsSync(absoluteDirectory)) return [];
  const found = [];
  const visit = (absolutePath) => {
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      if (["node_modules", "dist", "build", ".build", ".next", "DerivedData"].includes(entry.name)) continue;
      const child = path.join(absolutePath, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (extensions.has(path.extname(entry.name))) {
        const relativePath = path.relative(root, child).replaceAll("\\", "/");
        if (!isTestPath(relativePath)) found.push(relativePath);
      }
    }
  };
  visit(absoluteDirectory);
  return found.sort();
}

function parse(relativePath) {
  const source = read(relativePath);
  const kind = relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : relativePath.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, kind);
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function memberName(expression) {
  if (ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) || ts.isElementAccessChain(expression)) {
    const argument = expression.argumentExpression;
    return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
      ? argument.text
      : null;
  }
  return ts.isIdentifier(expression) ? expression.text : null;
}

function receiverName(expression) {
  if (!(ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression))) return null;
  const receiver = expression.expression;
  return ts.isIdentifier(receiver) ? receiver.text : null;
}

function callRecords(sourceFile) {
  const records = [];
  visit(sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      records.push({
        node,
        name: memberName(node.expression),
        receiver: receiverName(node.expression),
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      });
    }
  });
  return records;
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (node.parent && ts.isPropertyAssignment(node.parent)) return node.parent.name.getText();
  return "<anonymous>";
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return current;
    }
  }
  return null;
}

function importBindings(sourceFile, moduleName) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== moduleName) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const specifier of named.elements) {
      bindings.set((specifier.propertyName ?? specifier.name).text, specifier.name.text);
    }
  }
  return bindings;
}

function unwrapAwaited(call) {
  let current = call.parent;
  let awaited = false;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current))
  ) {
    if (ts.isAwaitExpression(current)) awaited = true;
    current = current.parent;
  }
  return { awaited, container: current };
}

function variableReceiving(call) {
  let current = call.parent;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current))
  ) {
    current = current.parent;
  }
  return current && ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) ? current.name.text : null;
}

function findFunction(sourceFile, wantedName) {
  let result = null;
  visit(sourceFile, (node) => {
    if (result || !node.body) return;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      if (functionName(node) === wantedName) result = node;
    }
  });
  return result;
}

function callsInside(functionNode, sourceFile) {
  if (!functionNode?.body) return [];
  return callRecords(sourceFile).filter(
    (record) => record.start >= functionNode.body.getStart(sourceFile) && record.end <= functionNode.body.getEnd()
  );
}

function propertyBoolean(call, propertyName) {
  const argument = call.node.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) return null;
  for (const property of argument.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
    if (name !== propertyName) continue;
    return property.initializer.kind === ts.SyntaxKind.TrueKeyword
      ? true
      : property.initializer.kind === ts.SyntaxKind.FalseKeyword
        ? false
        : null;
  }
  return null;
}

function requireOrderedCalls(relativePath, functionNode, sourceFile, steps) {
  if (!functionNode) {
    fail(`${relativePath} is missing the production function guarded by this check`);
    return;
  }
  const calls = callsInside(functionNode, sourceFile);
  let cursor = -1;
  for (const step of steps) {
    const match = calls.find((record) => record.start > cursor && step.matches(record));
    if (!match) {
      fail(`${relativePath} ${functionName(functionNode)}() is missing ${step.description} in dispatch order`);
      return;
    }
    cursor = match.start;
  }
}

// -------------------------------------------------------------------------
// Chat / scheduled / Work connector dispatch: one server-side MCP chokepoint.
// -------------------------------------------------------------------------

const mcpPath = "src/lib/mcp.ts";
const mcpSource = parse(mcpPath);
const mcpImports = importBindings(mcpSource, "@/lib/action-approval-store");
const authorizeLocal = mcpImports.get("authorizeExternalAction");
const completeLocal = mcpImports.get("completeExternalAction");
if (!authorizeLocal || !completeLocal) {
  fail(`${mcpPath} must import authorizeExternalAction and completeExternalAction from @/lib/action-approval-store`);
}

const productionTypeScript = [
  ...walk("src", new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"])),
  ...walk("scripts", new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"])),
  ...walk("runner/agent-core/src", new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"])),
];

const parsedProduction = new Map(productionTypeScript.map((relativePath) => [relativePath, parse(relativePath)]));
const directMcpSinks = [];
for (const [relativePath, sourceFile] of parsedProduction) {
  for (const record of callRecords(sourceFile)) {
    if (record.name === "callTool" && record.receiver === "client") {
      directMcpSinks.push({ relativePath, sourceFile, record });
    }
  }
}
if (directMcpSinks.length !== 1 || directMcpSinks[0]?.relativePath !== mcpPath) {
  const inventory = directMcpSinks.map(({ relativePath, sourceFile, record }) => `${relativePath}:${sourceFile.getLineAndCharacterOfPosition(record.start).line + 1}`);
  fail(`production client.callTool inventory changed; expected only ${mcpPath}, found ${inventory.join(", ") || "none"}`);
}

for (const { relativePath, sourceFile, record: sink } of directMcpSinks) {
  const owner = enclosingFunction(sink.node);
  const ownerCalls = owner ? callsInside(owner, sourceFile) : [];
  const authorization = authorizeLocal
    ? ownerCalls.find((record) => record.name === authorizeLocal && record.start < sink.start)
    : null;
  if (!owner || functionName(owner) !== "execute") {
    fail(`${relativePath} client.callTool must remain inside the McpToolset execute() chokepoint`);
    continue;
  }
  if (!authorization) {
    fail(`${relativePath} execute() reaches client.callTool without authorizeExternalAction first`);
    continue;
  }
  if (!unwrapAwaited(authorization.node).awaited) {
    fail(`${relativePath} execute() must await authorizeExternalAction before client.callTool`);
  }
  const authorizationName = variableReceiving(authorization.node);
  if (!authorizationName) {
    fail(`${relativePath} execute() must inspect the ActionAuthorization returned by authorizeExternalAction`);
  } else {
    const beforeSinkStart = authorization.end;
    let readsKind = false;
    const handledKinds = new Set();
    visit(owner.body, (node) => {
      const start = node.getStart(sourceFile);
      if (start < beforeSinkStart || start >= sink.start) return;
      if (
        (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === authorizationName &&
        node.name.text === "kind"
      ) {
        readsKind = true;
      }
      if (ts.isStringLiteral(node) && (node.text === "refused" || node.text === "replay")) handledKinds.add(node.text);
    });
    if (!readsKind || !handledKinds.has("refused") || !handledKinds.has("replay")) {
      fail(`${relativePath} execute() must return on refused/replayed authorization before client.callTool`);
    }
  }

  const completions = completeLocal
    ? ownerCalls.filter((call) => call.name === completeLocal && call.start > sink.start)
    : [];
  const completionOutcomes = new Set(completions.map((call) => propertyBoolean(call, "ok")));
  if (!completionOutcomes.has(true) || !completionOutcomes.has(false)) {
    fail(`${relativePath} execute() must settle the receipt with completeExternalAction on both success and failure`);
  }
}

// The receipt store must keep using the shared classification, argument digest,
// and policy domain. A local look-alike broker would otherwise satisfy the MCP
// import while silently implementing a different permission system.
const storePath = "src/lib/action-approval-store.ts";
const storeSource = parse(storePath);
const domainBindings = importBindings(storeSource, "@/lib/action-approval");
for (const symbol of [
  "classifyExternalAction",
  "decideActionPolicy",
  "actionArgsHash",
  "actionReceiptDigest",
]) {
  if (!domainBindings.has(symbol)) fail(`${storePath} must import ${symbol} from @/lib/action-approval`);
}
const storeCalls = callRecords(storeSource);
for (const symbol of ["classifyExternalAction", "decideActionPolicy", "actionArgsHash", "actionReceiptDigest"]) {
  const local = domainBindings.get(symbol);
  if (local && !storeCalls.some((record) => record.name === local)) {
    fail(`${storePath} imports ${symbol} but no production broker path calls it`);
  }
}
const authorizeFunction = findFunction(storeSource, "authorizeExternalAction");
const completeFunction = findFunction(storeSource, "completeExternalAction");
if (!authorizeFunction || !completeFunction) {
  fail(`${storePath} must export authorizeExternalAction and completeExternalAction`);
} else {
  const authorizeText = authorizeFunction.body.getText(storeSource);
  const completeText = completeFunction.body.getText(storeSource);
  if (!/status\s*:\s*["']executing["']/.test(authorizeText) || !/updateMany\s*\(/.test(authorizeText)) {
    fail(`${storePath} authorizeExternalAction must atomically consume an allowed receipt into executing state`);
  }
  if (!/updateMany\s*\(/.test(completeText) || !/["']executed["']/.test(completeText) || !/["']failed["']/.test(completeText)) {
    fail(`${storePath} completeExternalAction must persist both executed and failed terminal states`);
  }
}

// The credentials proxy is intentionally behind a short-lived, connector-bound
// Juno token. Native Anthropic MCP used to receive that token and call the proxy
// without giving Juno a chance to broker individual actions. Forbid every part
// of that provider-native path, not just its current helper name.
for (const relativePath of ["src/lib/mcp.ts", "src/lib/llm.ts", "src/lib/anthropic.ts"]) {
  const sourceFile = parsedProduction.get(relativePath) ?? parse(relativePath);
  const forbidden = [];
  visit(sourceFile, (node) => {
    if (ts.isIdentifier(node) && ["anthropicMcpServers", "mcpServers", "mcp_servers", "authorization_token"].includes(node.text)) {
      forbidden.push(node.text);
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      ["mcp_servers", "authorization_token"].includes(node.text)
    ) {
      forbidden.push(node.text);
    }
  });
  if (forbidden.length) {
    fail(`${relativePath} still exposes Anthropic native MCP state (${[...new Set(forbidden)].join(", ")}); connector calls must return through Juno's broker`);
  }
}

// Minting a connector token anywhere except the central connector resolver
// creates a second credential-bearing route that this gate cannot reason about.
const tokenMintCalls = [];
for (const [relativePath, sourceFile] of parsedProduction) {
  for (const record of callRecords(sourceFile)) {
    if (record.name === "mintConnectorToken") tokenMintCalls.push({ relativePath, sourceFile, record });
  }
}
if (tokenMintCalls.length !== 2 || tokenMintCalls.some(({ relativePath }) => relativePath !== mcpPath)) {
  const inventory = tokenMintCalls.map(({ relativePath, sourceFile, record }) => `${relativePath}:${sourceFile.getLineAndCharacterOfPosition(record.start).line + 1}`);
  fail(`connector-token mint inventory changed; expected two central mints in ${mcpPath}, found ${inventory.join(", ") || "none"}`);
}

// -------------------------------------------------------------------------
// Cloud/local runner execution: every tool.execute stays behind its gate.
// -------------------------------------------------------------------------

const runnerGateByFile = new Map([
  [
    "runner/agent-core/src/agent.ts",
    {
      functionName: "executeToolCall",
      gates: [
        { description: "PermissionEngine.decide", matches: (call) => call.name === "decide" },
        { description: "the approval decision", matches: (call) => call.name === "requestApproval" },
      ],
    },
  ],
  [
    "runner/agent-core/src/subagents.ts",
    {
      functionName: "executeChildTool",
      gates: [
        { description: "PermissionEngine.decide", matches: (call) => call.name === "decide" },
        { description: "the subagent approval decision", matches: (call) => call.name === "requestApproval" },
      ],
    },
  ],
  [
    "runner/agent-core/src/work/session.ts",
    {
      functionName: "executeToolCall",
      gates: [
        { description: "approvalAsksUnder", matches: (call) => call.name === "approvalAsksUnder" },
        { description: "the receipt-bound Work approval", matches: (call) => call.name === "gateApproval" },
      ],
    },
  ],
]);

const runnerToolSinks = [];
for (const [relativePath, sourceFile] of parsedProduction) {
  if (!relativePath.startsWith("runner/agent-core/src/")) continue;
  for (const record of callRecords(sourceFile)) {
    if (record.name === "execute" && record.receiver === "tool") runnerToolSinks.push({ relativePath, sourceFile, record });
  }
}
for (const expectedPath of runnerGateByFile.keys()) {
  if (!runnerToolSinks.some(({ relativePath }) => relativePath === expectedPath)) {
    fail(`${expectedPath} no longer contains its known tool.execute sink; update this gate for the new dispatch path`);
  }
}
for (const { relativePath, sourceFile, record: sink } of runnerToolSinks) {
  const expected = runnerGateByFile.get(relativePath);
  const owner = enclosingFunction(sink.node);
  if (!expected || !owner || functionName(owner) !== expected.functionName) {
    fail(`${relativePath} has an unreviewed production tool.execute sink in ${owner ? functionName(owner) : "unknown code"}`);
    continue;
  }
  requireOrderedCalls(relativePath, owner, sourceFile, [
    ...expected.gates,
    { description: "tool.execute", matches: (call) => call.start === sink.start },
  ]);
}

// -------------------------------------------------------------------------
// Native Work / Code execution: lexical, comment-free source invariants.
// -------------------------------------------------------------------------

function swiftCodeWithoutTrivia(source) {
  let output = "";
  let index = 0;
  let state = "code";
  let blockDepth = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    const triple = source.slice(index, index + 3) === '\"\"\"';
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line-comment";
        output += "  ";
        index += 2;
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        blockDepth = 1;
        output += "  ";
        index += 2;
      } else if (triple) {
        state = "multiline-string";
        output += "   ";
        index += 3;
      } else if (char === '"') {
        state = "string";
        output += " ";
        index += 1;
      } else {
        output += char;
        index += 1;
      }
    } else if (state === "line-comment") {
      if (char === "\n") {
        state = "code";
        output += "\n";
      } else {
        output += " ";
      }
      index += 1;
    } else if (state === "block-comment") {
      if (char === "/" && next === "*") {
        blockDepth += 1;
        output += "  ";
        index += 2;
      } else if (char === "*" && next === "/") {
        blockDepth -= 1;
        output += "  ";
        index += 2;
        if (blockDepth === 0) state = "code";
      } else {
        output += char === "\n" ? "\n" : " ";
        index += 1;
      }
    } else if (state === "string") {
      if (char === "\\") {
        output += "  ";
        index += Math.min(2, source.length - index);
      } else if (char === '"') {
        state = "code";
        output += " ";
        index += 1;
      } else {
        output += char === "\n" ? "\n" : " ";
        index += 1;
      }
    } else if (state === "multiline-string") {
      if (triple) {
        state = "code";
        output += "   ";
        index += 3;
      } else {
        output += char === "\n" ? "\n" : " ";
        index += 1;
      }
    }
  }
  return output;
}

function swiftTokens(relativePath) {
  const code = swiftCodeWithoutTrivia(read(relativePath));
  return (code.match(/[A-Za-z_][A-Za-z0-9_]*|[{}().,:]/g) ?? []).join("");
}

function section(tokens, startMarker, endMarkers = []) {
  const start = tokens.indexOf(startMarker);
  if (start < 0) return null;
  let end = tokens.length;
  for (const marker of endMarkers) {
    const candidate = tokens.indexOf(marker, start + startMarker.length);
    if (candidate >= 0 && candidate < end) end = candidate;
  }
  return tokens.slice(start, end);
}

function requireSwiftOrder(relativePath, label, body, markers) {
  if (body === null) {
    fail(`${relativePath} is missing ${label}`);
    return;
  }
  let cursor = -1;
  for (const marker of markers) {
    const next = body.indexOf(marker, cursor + 1);
    if (next < 0) {
      fail(`${relativePath} ${label} is missing ${marker} in dispatch order`);
      return;
    }
    cursor = next;
  }
}

const codeRegistryPath = "native/Packages/JunoCode/Sources/JunoCodeRuntime/ToolRegistry.swift";
const codeRegistry = swiftTokens(codeRegistryPath);
requireSwiftOrder(
  codeRegistryPath,
  "authorizeInvocation()",
  section(codeRegistry, "publicfuncauthorizeInvocation(", ["publicfuncexecuteAuthorized("]),
  ["awaitpermissions.authorize(", "request.authorizes("]
);
requireSwiftOrder(
  codeRegistryPath,
  "invoke()",
  section(codeRegistry, "publicfuncinvoke("),
  ["awaitauthorizeInvocation(", "awaitexecuteAuthorized("]
);

const orchestratorPath = "native/Packages/JunoCode/Sources/JunoCodeRuntime/AgentOrchestrator.swift";
const orchestrator = swiftTokens(orchestratorPath);
requireSwiftOrder(
  orchestratorPath,
  "executeToolCall()",
  section(orchestrator, "privatefuncexecuteToolCall(", ["privatefuncdeniedReason(", "privatefuncfirstLine("]),
  ["awaitregistry.authorizeInvocation(", "awaitregistry.executeAuthorized("]
);

const nativeMcpPath = "native/Packages/JunoCode/Sources/JunoCodeRuntime/MCP/MCPToolRegistry.swift";
const nativeMcp = swiftTokens(nativeMcpPath);
requireSwiftOrder(
  nativeMcpPath,
  "invoke()",
  section(nativeMcp, "publicfuncinvoke(", ["publicfuncdisconnect("]),
  ["awaitauthorize(", "awaitclient.callTool("]
);

const workRegistryPath = "native/Packages/JunoWork/Sources/JunoWorkRuntime/WorkToolRegistry.swift";
const workRegistry = swiftTokens(workRegistryPath);
requireSwiftOrder(
  workRegistryPath,
  "authorize()",
  section(workRegistry, "publicfuncauthorize(", ["publicfuncexecuteAuthorized("]),
  ["awaitapprovals.authorize(", "receipt.authorizes("]
);
requireSwiftOrder(
  workRegistryPath,
  "invoke()",
  section(workRegistry, "publicfuncinvoke("),
  ["awaitauthorize(", "awaitexecuteAuthorized("]
);

const workBatchPath = "native/Packages/JunoWork/Sources/JunoWorkLocal/WorkBatchExecutor.swift";
const workBatch = swiftTokens(workBatchPath);
requireSwiftOrder(
  workBatchPath,
  "execute(approvedBy:)",
  section(workBatch, "publicfuncexecute(", ["privatestaticfunc", "privatefunc"]),
  ["approval.authorizes(", "awaitapply("]
);

const desktopWorkPath = "native/macOS/JunoDesktop/App/DesktopWorkRunHost.swift";
const desktopWork = swiftTokens(desktopWorkPath);
requireSwiftOrder(
  desktopWorkPath,
  "perform()",
  section(desktopWork, "privatefuncperform(", ["privatefunc"]),
  ["binding.registry.invoke(", "approvals:request.approvals"]
);

// Inventory native low-level sinks. A new caller must use a full registry
// invoke, not get added to this list merely because it also asks a question.
const productionSwift = walk("native", new Set([".swift"]));
const nativeClientCallers = [];
const nativeAuthorizedCallers = [];
const nativeToolCallers = [];
for (const relativePath of productionSwift) {
  const tokens = swiftTokens(relativePath);
  if (tokens.includes(".callTool(")) nativeClientCallers.push(relativePath);
  if (tokens.includes(".executeAuthorized(")) nativeAuthorizedCallers.push(relativePath);
  if (tokens.includes("tool.execute(")) nativeToolCallers.push(relativePath);
}
if (nativeClientCallers.length !== 1 || nativeClientCallers[0] !== nativeMcpPath) {
  fail(`native client.callTool inventory changed; expected only ${nativeMcpPath}, found ${nativeClientCallers.join(", ") || "none"}`);
}
if (nativeAuthorizedCallers.length !== 1 || nativeAuthorizedCallers[0] !== orchestratorPath) {
  fail(`native executeAuthorized caller inventory changed; expected only ${orchestratorPath}, found ${nativeAuthorizedCallers.join(", ") || "none"}`);
}
const expectedNativeToolCallers = [codeRegistryPath, workRegistryPath].sort();
if (
  nativeToolCallers.length !== expectedNativeToolCallers.length ||
  nativeToolCallers.some((value, index) => value !== expectedNativeToolCallers[index])
) {
  fail(`native tool.execute inventory changed; expected ${expectedNativeToolCallers.join(", ")}, found ${nativeToolCallers.join(", ") || "none"}`);
}

if (failures.length) {
  console.error("\n[approval-dispatch] FAIL\n");
  for (const message of failures) console.error(`  - ${message}`);
  console.error("\nEvery production connector/tool sink must stay behind its Juno permission and receipt gate.\n");
  process.exit(1);
}

console.log(
  "[approval-dispatch] Chat connectors use the receipt broker; Anthropic has no native connector bypass; Work and Code sinks remain permission/receipt-gated"
);
