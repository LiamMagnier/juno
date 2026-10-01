import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`missing required file: ${relativePath}`);
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function requireText(relativePath, snippets) {
  const source = read(relativePath);
  for (const snippet of snippets) {
    if (!source.includes(snippet)) {
      throw new Error(`${relativePath} is missing required preview wiring: ${snippet}`);
    }
  }
}

function forbidText(relativePath, snippets, why) {
  const source = read(relativePath);
  for (const snippet of snippets) {
    if (source.includes(snippet)) {
      throw new Error(`${relativePath} must not contain ${snippet}: ${why}`);
    }
  }
}

// The Preview belongs to the session, not the view (CODE_AGENT_SPEC §4.1).
// These are the links that make the engine a real workflow in the shipping
// app, and the safety facts the audit (docs/rework/audit/code-preview.md,
// PV-39) asked a release check to hold. Behaviour is exercised by the tests
// named in §6.4 (PreviewBrowserTests, PreviewRegistryTests,
// StaticPreviewServerTests, PreviewVerifyLoopTests); this check catches the
// wiring a refactor could silently drop.

const pkg = "native/Packages/JunoCode/Sources";
const app = "native/macOS/JunoDesktop/App";

// The shipping desktop hosts the pane, hands it the session's lease model,
// turns on the background host and stops servers on quit.
requireText(`${app}/DesktopCodeWorkspace.swift`, [
  "DesktopCodePreviewDock(",
  "target: previewTarget",
  "lease: controller?.previewLease",
  "previewTarget = CodePreviewTarget(",
  "sessionID: controller?.sessionID",
  "openPreviewWindow(previewTarget)",
  "PreviewHost.configureForApp()",
]);
requireText(`${app}/JunoShortcutRegistry.swift`, [
  ".codePreview, menu: \"Toggle Preview\"",
  "key: \"p\", [.command, .option]",
]);
requireText(`${app}/DesktopCommands.swift`, ["case .codePreview:", "code?.togglePreview"]);
requireText(`${app}/DesktopCodePreviewDock.swift`, ["CodePreviewDock(", "lease: lease", "openInWindow:"]);
requireText(`${app}/JunoDesktopApp.swift`, ["CodePreviewScene()"]);

// The surfaces are views onto the registry and the one page; neither owns a
// server, and state is said in words (no status capsule, PV-36).
requireText(`${pkg}/JunoCodeUI/Views/Preview/CodePreviewWindow.swift`, [
  "public struct CodePreviewDock",
  "CodePreviewScene",
  "WindowGroup(id: Self.windowID, for: CodePreviewTarget.self)",
  "juno.code.preview.dock",
]);
forbidText(`${pkg}/JunoCodeUI/Views/Preview/CodePreviewWindow.swift`, ["service.stop()", "statusPill"], "a view never stops a server or shows a status capsule");
forbidText(`${pkg}/JunoCodeUI/Views/Preview/PreviewChrome.swift`, ["statusPill", "Circle().fill"], "no status pills or dots");
requireText(`${pkg}/JunoCodeUI/Views/Preview/PreviewChrome.swift`, [
  "PreviewRegistry.shared.addViewer(",
  "PreviewRegistry.shared.removeViewer(",
  "lease.statusSentence",
  "PreviewConfigApprovalCard(",
  "PreviewPageView(page: page)",
  "page.stopAgent()",
]);

// The registry: leases, viewers, idle stop, the ledger.
requireText(`${pkg}/JunoCodeLocal/PreviewRegistry.swift`, [
  "public actor PreviewRegistry",
  "public func lease(",
  "public func release(",
  "public func releaseAll(session:",
  "entry.leases.insert(session)",
  "public func sweepIdle()",
  "ledger?.record(",
  "DevServerService.contained(workspaceRootURL: checkoutRoot, allowsNetwork: network == .internet)",
]);
requireText(`${pkg}/JunoCodeLocal/PreviewServerLedger.swift`, ["func reapOrphans(", "isSameServer("]);
requireText(`${pkg}/JunoCodeLocal/DevServerService.swift`, [
  "ListeningSocketOwnership.listeningSockets(inProcessGroup:",
  "public func start(_ launch: DevServerLaunch) async",
]);

// One page per preview, with the navigation policy, the UI delegate and the
// diagnostics origin check (PV-4, PV-26, PV-27).
requireText(`${pkg}/JunoCodeUI/Views/Preview/PreviewPage.swift`, [
  "decidePolicyFor navigationAction: WKNavigationAction",
  "decidePolicyFor navigationResponse: WKNavigationResponse",
  "WKUIDelegate",
  "runJavaScriptConfirmPanelWithMessage",
  "runOpenPanelWith",
  "createWebViewWith",
  "page.isAllowed(url)",
  "message.frameInfo.securityOrigin",
  "func adopt(into container:",
  "func release(from container:",
]);

// The static server: SIGPIPE, Host, secrets, CORS (PV-29, PV-30, PV-31).
requireText(`${pkg}/JunoCodeLocal/StaticPreviewServer.swift`, [
  "SO_NOSIGPIPE",
  "acceptsHost(request.headers[\"host\"])",
  "Self.isDenied(components)",
  "POLLOUT",
]);
forbidText(`${pkg}/JunoCodeLocal/StaticPreviewServer.swift`, ['"Access-Control-Allow-Origin"'], "no other origin may read the static server (PV-29)");

// The agent's tools come from the lane's provider, bound to the session, and
// the browser mints evidence; the session wraps Code turns' stop check.
requireText(`${pkg}/JunoCodeUI/Views/Preview/CodePreviewInspectionTool.swift`, [
  "let name = \"preview_server\"",
  "let name = \"preview_browser\"",
  "let name = \"open_preview\"",
  "let name = \"inspect_preview\"",
  "services.registry.start(configuration, checkoutRoot: services.workspaceRoot, session: session)",
  "struct PreviewToolProvider: CodeToolProvider",
  "services.hub.mint(",
  ".uiVerificationRecorded(",
]);
requireText(`${pkg}/JunoCodeUI/Models/CodeToolProviders.swift`, ["PreviewToolProvider()"]);
requireText(`${pkg}/JunoCodeUI/Models/SessionController.swift`, ["previewLease.completionGate("]);
forbidText(
  `${pkg}/JunoCodeUI/Models/SessionController.swift`,
  ["tools.append(CodePreviewOpenTool(", "tools.append(CodePreviewBrowserTool())"],
  "the Preview's tools are registered through PreviewToolProvider",
);
requireText(`${pkg}/JunoCodeRuntime/PreviewVerification.swift`, ["public struct PreviewUIGate: CompletionGating"]);

console.log(
  "[code-preview] session-owned registry, one hardened page, provider-registered tools, the verify gate and the desktop pane are wired",
);
