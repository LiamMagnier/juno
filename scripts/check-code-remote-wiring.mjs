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
const desktopWorkspace = read(
  "native/macOS/JunoDesktop/App/DesktopCodeWorkspace.swift",
);
const desktopRoot = read(
  "native/macOS/JunoDesktop/App/JunoDesktopWorkspaceView.swift",
);
const desktopConfiguration = read(
  "native/macOS/JunoDesktop/App/JunoDesktopConfiguration.swift",
);
const sidebar = read("native/macOS/JunoDesktop/App/DesktopCodeStudio.swift");
const remoteBrowser = read(
  "native/Packages/JunoNativeKit/Sources/JunoCodeKit/CodeRemoteBrowserModel.swift",
);

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
  [desktopWorkspace, "DesktopCodeRemoteCanvas"],
  [desktopWorkspace, "await remoteModel.pollEvents("],
  [desktopWorkspace, "await remote.respondToApproval("],
  [desktopWorkspace, "await remote.send("],
  [desktopWorkspace, "CodeRemoteTaskDetailView("],
  [desktopRoot, "remoteModel: remoteCodeModel"],
  [desktopConfiguration, "CodeRemoteBrowserModel("],
  [sidebar, "matchingRemoteSessions"],
  [sidebar, ".remote(deviceID: summary.deviceID, sessionID: summary.sessionID)"],
  [remoteBrowser, "public func pollEvents("],
  [remoteBrowser, "public func respondToApproval("],
  [remoteBrowser, "public func send("],
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

console.log("[code-remote] shipping JunoDesktop target discovery, dispatch, approvals, and live monitoring are wired");
