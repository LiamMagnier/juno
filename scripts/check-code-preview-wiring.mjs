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

// The preview engine can exist in the package while remaining unreachable from
// the shipping app. Keep the links that make it a real user workflow in one
// cheap, deterministic release check. JunoDesktop is the product shell; the
// older JunoMac target is not the app users launch.
requireText("native/macOS/JunoDesktop/App/DesktopCodeWorkspace.swift", [
  "DesktopCodePreviewDock(",
  "target: previewTarget",
  "previewTarget = CodePreviewTarget(",
  "sessionID: controller?.sessionID",
  "openPreviewWindow(previewTarget)",
  "keyboardShortcut(\"p\", modifiers: [.command, .option])",
]);
requireText("native/macOS/JunoDesktop/App/DesktopCodePreviewDock.swift", [
  "CodePreviewDock(",
  "openInWindow:",
]);
requireText("native/Packages/JunoCode/Sources/JunoCodeUI/Views/Preview/CodePreviewWindow.swift", [
  "DevServerService.contained",
  "public struct CodePreviewDock",
  "CodePreviewScene",
  "WindowGroup(id: Self.windowID, for: CodePreviewTarget.self)",
  "juno.code.preview.dock",
]);
requireText("native/Packages/JunoCode/Sources/JunoCodeUI/Views/Preview/CodePreviewInspectionTool.swift", [
  "let name = \"inspect_preview\"",
  "CodePreviewModel.inspectActive(",
]);
requireText("native/Packages/JunoCode/Sources/JunoCodeUI/Models/SessionController.swift", [
  "tools.append(CodePreviewInspectTool())",
]);
requireText("native/macOS/JunoDesktop/App/JunoDesktopApp.swift", ["CodePreviewScene()"]);

console.log("[code-preview] shipping JunoDesktop dock, contained server, inspector action, and window scene are wired");
