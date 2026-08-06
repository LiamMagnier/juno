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
// the shipping app. Keep the three links that make it a real user workflow in
// one cheap, deterministic release check: the dock, the inspector action, and
// the separate-window scene.
requireText("native/Packages/JunoCode/Sources/JunoCodeUI/Views/WorkbenchView.swift", [
  "CodePreviewDock(",
  "openPreview: { openPreviewForCurrentSession() }",
  "openWindow(id: CodePreviewScene.windowID, value: target)",
  "Open the live workspace preview",
  "keyboardShortcut(\"p\", modifiers: [.command, .option])",
]);
requireText("native/macOS/JunoMac/App/JunoMacApp.swift", ["CodePreviewScene()"]);

console.log("[code-preview] active JunoMac dock, inspector action, and window scene are wired");
