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
      throw new Error(`${relativePath} is missing runtime wiring: ${snippet}`);
    }
  }
}

// A package can compile every capability while the active session constructor
// silently leaves one out. Keep the real composition points guarded: these are
// the features that make Juno Code a product rather than a collection of
// unused Swift types. These checks intentionally follow JunoDesktop, the
// shipping host, rather than the retired standalone JunoMac shell.
requireText("native/macOS/JunoDesktop/project.yml", [
  "product: JunoCodeUI",
  "product: JunoCodeRuntime",
  "product: JunoWorkRuntime",
  "product: JunoWorkAutomation",
]);

requireText("native/macOS/JunoDesktop/App/DesktopCodeWorkspace.swift", [
  "SessionController",
  // The session's thread and composer, and the side panel beside it.
  "StudioSessionView(",
  "StudioSidePanel(",
  "controller: controller,",
  ".inspector(isPresented: panelPresentation)",
  // Screen control stays visible and stoppable while it runs.
  "if controller.computerUseActive {",
  "await controller.stopComputerUse()",
]);

// Runs that finish or wait while the reader is elsewhere say so. Wired to the
// workbench and the app's launch, not to the Code view: a view-owned monitor
// went deaf, and held the Mac awake, as soon as the reader switched to Chat
// or closed the window, which is exactly when it is needed.
requireText("native/macOS/JunoDesktop/App/DesktopWorkbenchRegistry.swift", [
  "workbench?.sessionsObserver =",
  "StudioRunMonitor.shared.observe(",
]);
requireText("native/macOS/JunoDesktop/App/JunoDesktopApp.swift", [
  "StudioRunMonitor.shared.install",
]);
requireText("native/Packages/JunoCode/Sources/JunoCodeUI/Models/WorkbenchModel.swift", [
  "didSet { sessionsObserver?(sessions) }",
  "sessionsObserver?([])",
]);

requireText("native/Packages/JunoCode/Sources/JunoCodeUI/Models/WorkspaceContext.swift", [
  "self.mcpRegistry = try MCPToolRegistry(",
  "public func mcpTools(excludingServers disabled: Set<String> = []) async -> [any CodeTool]",
  // Every workspace adapts onto the one app-wide screen-control service.
  "self.computerUse = ComputerUseCoordinator()",
  "self.worktrees = WorktreeManager(",
]);

requireText("native/Packages/JunoCode/Sources/JunoCodeUI/Models/SessionController.swift", [
  "contentsOf: await context.mcpTools(",
  "excludingServers: CodeDefaults.shared.disabledMCPServers",
  "DelegateTaskTool(",
  "WorkspaceAgentHooks(",
  // Computer use and the Simulator reach Code turns through the screen
  // lane's provider, with the session's services.
  "screen: screen.toolServices(",
  // The reader's terminal is the real PTY, owned by the session controller.
  "private var interactiveTerminalService: NativeTerminalSession?",
  "public func startInteractiveTerminal(_ command: String) async {",
]);

requireText("native/Packages/JunoCode/Sources/JunoCodeUI/Models/CodeToolProviders.swift", [
  "ScreenToolProvider()",
]);
requireText("native/Packages/JunoCode/Sources/JunoCodeRuntime/Tools/SimulatorTools.swift", [
  "ComputerTool(computer: computer, permissions: context.permissions",
  "SimulatorTool(",
]);
// The on-screen presence and the menu bar's stop are installed at launch.
requireText("native/macOS/JunoDesktop/App/JunoDesktopApp.swift", [
  "DesktopScreenPresence.shared.install()",
]);

requireText("native/Packages/JunoCode/Sources/JunoCodeRuntime/AgentOrchestrator.swift", [
  "lifecycleHooks?.sessionStarted",
  "lifecycleHooks?.sessionStopped",
]);
// Per-tool hooks run inside the scheduler every tool call goes through.
requireText("native/Packages/JunoCode/Sources/JunoCodeRuntime/ToolScheduler.swift", [
  "lifecycleHooks.beforeTool",
  "lifecycleHooks?.afterTool",
]);

console.log("[code-runtime] shipping JunoDesktop composes MCP, hooks, computer use, subagents, terminal, Work, and the session side panel");
