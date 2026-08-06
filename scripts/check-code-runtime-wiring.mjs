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
// unused Swift types.
requireText("native/Packages/JunoCode/Sources/JunoCodeUI/Models/WorkspaceContext.swift", [
  "self.mcpRegistry = try MCPToolRegistry(",
  "public func mcpTools() async -> [any CodeTool]",
  "ComputerScreenshotTool(computer: computerUse)",
  "self.worktrees = WorktreeManager(",
]);

requireText("native/Packages/JunoCode/Sources/JunoCodeUI/Models/SessionController.swift", [
  "tools.append(contentsOf: await context.mcpTools())",
  "DelegateTaskTool(",
  "WorkspaceAgentHooks(",
  "context.makeInteractiveTerminal(allowsNetwork: true)",
]);

requireText("native/Packages/JunoCode/Sources/JunoCodeRuntime/AgentOrchestrator.swift", [
  "lifecycleHooks?.sessionStarted",
  "lifecycleHooks.beforeTool",
  "lifecycleHooks?.afterTool",
  "lifecycleHooks?.sessionStopped",
]);

requireText("native/Packages/JunoCode/Sources/JunoCodeUI/Views/WorkbenchView.swift", [
  "CodePreviewDock(",
  "CodeRemoteTaskMonitorView(model: remoteTaskModel)",
]);

console.log("[code-runtime] MCP, hooks, computer use, subagents, terminal, preview, and remote monitoring are composed");
