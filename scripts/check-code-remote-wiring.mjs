import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const sheet = read(
  "native/Packages/JunoCode/Sources/JunoCodeUI/Views/NewSessionSheet.swift",
);
const model = read(
  "native/Packages/JunoCode/Sources/JunoCodeUI/Models/WorkbenchModel.swift",
);
const provider = read(
  "native/Packages/JunoCode/Sources/JunoCodeUI/Remote/NativeCodeTaskRemoteSessionProvider.swift",
);
const monitor = read(
  "native/Packages/JunoCode/Sources/JunoCodeUI/Views/Remote/CodeRemoteTaskMonitorView.swift",
);
const workbench = read(
  "native/Packages/JunoCode/Sources/JunoCodeUI/Views/WorkbenchView.swift",
);
const codeView = read("native/macOS/JunoMac/App/JunoMacCodeView.swift");
const rootSource = read("native/macOS/JunoMac/App/JunoMacRootView.swift");

const required = [
  [sheet, 'Button(location == .local ? "Create Session" : "Start Remote Task")'],
  [sheet, "loadRemoteTargets(for: newLocation)"],
  [sheet, 'Section("Remote target")'],
  [sheet, "model.startRemoteSession"],
  [sheet, "onRemoteTaskStarted?()"],
  [model, "public func loadRemoteRepositories()"],
  [model, "public func loadRemoteDevices()"],
  [model, "public func startRemoteSession("],
  [provider, "public func repositories() async throws"],
  [provider, "public func devices() async throws"],
  [monitor, "NativeCodeModel"],
  [monitor, "model.events"],
  [monitor, "respondToApproval"],
  [monitor, "cancelOpenTask"],
  [workbench, "CodeRemoteTaskMonitorView(model: remoteTaskModel)"],
  [workbench, "onRemoteTaskStarted: { remoteTaskModel?.refreshSoon() }"],
  [workbench, "remoteTaskModel.tasks.filter"],
  [codeView, "let remoteTaskModel: NativeCodeModel?"],
  [codeView, "makeRemoteTaskModel"],
  [rootSource, "codeTaskModel?.start(for: session.profile.id)"],
  [rootSource, "remoteTaskModel: codeTaskModel"],
];

const missing = required
  .filter(([source, fragment]) => !source.includes(fragment))
  .map(([, fragment]) => fragment);

if (missing.length > 0) {
  throw new Error(`[code-remote] missing wiring: ${missing.join(", ")}`);
}

if (sheet.includes(".disabled(workspaceID == nil || location != .local)")) {
  throw new Error("[code-remote] remote creation is still disabled in the session sheet");
}

console.log("[code-remote] target discovery, dispatch, and JunoMac live monitoring are wired");
