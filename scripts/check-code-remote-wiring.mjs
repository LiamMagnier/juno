import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

/*
 * A SOURCE FILE THAT NO LONGER EXISTS IS A WIRING FAILURE, AND IT MUST READ AS ONE.
 *
 * `fs.readFileSync` on a deleted path throws a raw ENOENT with a Node stack
 * trace, which is what this check did when 8720ffbd removed NewSessionSheet.swift
 * (along with WorkbenchView, AgentCanvasView and GitAndFilesTabs) and replaced it
 * with nothing. The gate failed for the right reason and said the wrong thing:
 * a reader saw "Error: ENOENT: no such file or directory" and could not tell a
 * moved file from a deleted feature from a broken checkout.
 *
 * Returning null and letting the assertion loop below report a MISSING SURFACE
 * is deliberately NOT a softening — every fragment required of an absent file
 * still fails, and the exit code is unchanged. The only thing that changes is
 * that the failure names the surface that vanished and the wiring that went with
 * it, instead of making whoever hits it go digging through git log to find out.
 */
function read(relativePath) {
  let text = null;
  try {
    text = fs.readFileSync(path.join(root, relativePath), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return {
    path: relativePath,
    missing: text === null,
    // Named `includes` so every `[source, fragment]` pair below reads exactly as
    // it did when these were plain strings; an absent file simply contains
    // nothing, so each fragment it owed is reported individually.
    includes: (fragment) => text !== null && text.includes(fragment),
  };
}

/*
 * WHERE "START A REMOTE TASK" ACTUALLY LIVES.
 *
 * `NativeCodeModel.startTask(prompt:)` picks cloud or device and calls
 * `createCloudTask`/`createDeviceTask` on the task store's client — and it is
 * driven from both apps: JunoMobileCodeView on iPhone and StudioLanding on the
 * Mac. The assertions below follow that live surface.
 *
 * They used to also require WorkbenchModel's startRemoteSession /
 * loadRemoteRepositories / loadRemoteDevices and the
 * NativeCodeTaskRemoteSessionProvider behind them, on the claim that the
 * provider "still backs that path and is still composed". It was not: no app
 * ever supplied `remoteSessionProvider`, so the whole path was unreachable, and
 * this gate was the only thing keeping it in the tree. It is deleted, and the
 * gate now fails if it comes back without a caller (see `retired` below).
 */
const nativeCodeModel = read(
  "native/Packages/JunoNativeKit/Sources/JunoCodeKit/NativeCodeModel.swift",
);
const mobileCode = read("native/iOS/JunoMobile/App/JunoMobileCodeView.swift");
const model = read(
  "native/Packages/JunoCode/Sources/JunoCodeUI/Models/WorkbenchModel.swift",
);
const monitor = read(
  "native/Packages/JunoCode/Sources/JunoCodeUI/Views/Remote/CodeRemoteTaskDetailView.swift",
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
// The Mac's New session screen, where Cloud and Device runs start.
const landing = read(
  "native/Packages/JunoCode/Sources/JunoCodeUI/Studio/StudioLanding.swift",
);
const remoteBrowser = read(
  "native/Packages/JunoNativeKit/Sources/JunoCodeKit/CodeRemoteBrowserModel.swift",
);
const remoteClient = read(
  "native/Packages/JunoNativeKit/Sources/JunoCodeKit/NativeCodeRemoteClient.swift",
);
// The return path. The Mac claimed and acknowledged commands for months while
// uploading nothing, so a phone's transcript of its own Mac stayed empty; these
// pin the one uploader, its composition on the Mac, and the field spellings the
// phone actually sends.
const desktopHost = read("native/macOS/JunoDesktop/App/DesktopCodeHost.swift");
const remoteBridge = read(
  "native/Packages/JunoCode/Sources/JunoCodeUI/Models/WorkbenchRemoteBridge.swift",
);
const remoteAdapter = read(
  "native/Packages/JunoCode/Sources/JunoCodeBridge/RemoteCommandAdapter.swift",
);
const remoteUploader = read(
  "native/Packages/JunoCode/Sources/JunoCodeUI/Models/WorkbenchRemoteUploader.swift",
);

const required = [
  // The live start path, end to end: one entry point that chooses a target,
  // both client calls it can choose between, and the two app surfaces that
  // reach it. A run a person can actually start needs all four.
  [nativeCodeModel, "public func startTask(prompt: String)"],
  [nativeCodeModel, "createCloudTask("],
  [nativeCodeModel, "createDeviceTask("],
  [mobileCode, "model.startTask(prompt:"],
  [landing, "code.startTask(prompt:"],
  [monitor, "NativeCodeModel"],
  [monitor, "model.events"],
  [monitor, "respondToApproval"],
  [monitor, "cancelOpenTask"],
  [desktopWorkspace, "DesktopCodeRemoteCanvas"],
  [desktopWorkspace, "await remoteModel.watchEvents("],
  [desktopWorkspace, "await remote.respondToApproval("],
  [desktopWorkspace, "await remote.send("],
  [desktopWorkspace, "CodeRemoteTaskDetailView("],
  [desktopRoot, "remoteModel: remoteCodeModel"],
  [desktopConfiguration, "CodeRemoteBrowserModel("],
  [sidebar, "remote.sessions.filter(matchesSearch)"],
  [sidebar, ".remote(deviceID: summary.deviceID, sessionID: summary.sessionID)"],
  [remoteBrowser, "public func watchEvents("],
  [remoteBrowser, "client.eventStream("],
  [remoteClient, "public func eventStream("],
  [remoteBrowser, "public func respondToApproval("],
  [remoteBrowser, "public func send("],
  // Uploads: the list and each session's events, from the Mac, while hosting is on.
  [remoteClient, "public func putSessions("],
  [remoteClient, "public func postEvents("],
  [desktopHost, "CodeRemoteSessionSync("],
  // Each uploader follows the store through an observation it owns and ends,
  // and starts only after the previous one has finished ending.
  [desktopHost, "WorkbenchRemoteUploader("],
  [remoteUploader, "bridge.startRelayObservation"],
  [remoteUploader, "bridge.stopRelayObservation(observation)"],
  [remoteUploader, "await previous?.value"],
  [remoteBridge, "CodeRemoteSyncSource"],
  // The phone is shown what this Mac has, never an unread workbench as empty.
  [remoteBridge, "await model.loadIfNeeded()"],
  [remoteBridge, "CodeRelayEventProjection.relayEvents("],
  // Both wires this Mac speaks are spelled from the one protocol projection.
  [read("native/Packages/JunoCode/Sources/JunoCodeBridge/CodeRelayEventProjection.swift"), "AgentProtocolProjection.events(for: event)"],
  [desktopHost, "CodeTaskWireProjection(includesProtocol: task.acceptsAgentProtocol)"],
  // A phone's create_session and a remote prompt that leaves the draft alone.
  [remoteAdapter, '"workspaceKey"'],
  [remoteAdapter, '"prompt"'],
  [remoteBridge, "deliverRemotePrompt("],
];

const unmet = required.filter(([source, fragment]) => !source.includes(fragment));

/*
 * RETIRED PATHS STAY RETIRED. The remote-session provider, the model state
 * behind it and the two sandbox clients were dead for months while a gate
 * pinned them in place; nothing composed them and nothing could reach them.
 * If one returns, it has to arrive with a caller and an assertion above.
 */
const retired = [
  "native/Packages/JunoCode/Sources/JunoCodeUI/Remote/NativeCodeTaskRemoteSessionProvider.swift",
  "native/Packages/JunoCode/Sources/JunoCodeUI/Remote/RemoteExecutionModel.swift",
  "native/Packages/JunoCode/Sources/JunoCodeRuntime/CloudCodeSandboxClient.swift",
  "native/Packages/JunoCode/Sources/JunoCodeRuntime/LocalPythonSandboxClient.swift",
].filter((relativePath) => fs.existsSync(path.join(root, relativePath)));
if (retired.length > 0 || model.includes("remoteSessionProvider")) {
  throw new Error(
    `[code-remote] a retired remote path is back without a caller: ${
      [...retired, ...(model.includes("remoteSessionProvider") ? ["WorkbenchModel.remoteSessionProvider"] : [])].join(", ")
    }`,
  );
}

/*
 * A DELETED FILE IS REPORTED AS ONE FACT, NOT AS FIVE ORPHANED FRAGMENTS.
 *
 * Listing every fragment an absent file owed buries the actual cause: the reader
 * gets five Swift snippets to hunt for and no hint that the file holding them is
 * simply gone. Naming the surface first, then what went with it, is what tells
 * whoever moved it whether to update this list or restore the wiring.
 */
const absent = [...new Set(unmet.filter(([source]) => source.missing).map(([source]) => source.path))];
if (absent.length > 0) {
  const owed = unmet
    .filter(([source]) => source.missing)
    .map(([source, fragment]) => `    ${source.path}: ${fragment}`)
    .join("\n");
  throw new Error(
    `[code-remote] missing surface — this file is gone, so the wiring it carried is unverifiable:\n` +
      `  ${absent.join("\n  ")}\n` +
      `  wiring it was asserted to hold:\n${owed}\n` +
      `  Either restore the surface, or move these assertions to whatever replaced it.\n` +
      `  Before concluding the feature is broken, check whether it MOVED: that is what\n` +
      `  happened the last time this fired. Find the live caller of createCloudTask /\n` +
      `  createDeviceTask and assert against that, rather than against whichever model\n` +
      `  still exports a same-sounding function nothing calls.`,
  );
}

const missing = unmet.map(([, fragment]) => fragment);
if (missing.length > 0) {
  throw new Error(`[code-remote] missing wiring: ${missing.join(", ")}`);
}

/*
 * The old sheet carried a `.disabled(… || location != .local)` modifier that
 * greyed out every remote target, and this file guarded against its return. The
 * guard is not dropped so much as absorbed: the modifier belonged to a deleted
 * file, and the same property on the live path is that `startTask` switches over
 * `target` and reaches BOTH arms — which is exactly what the `createCloudTask(`
 * and `createDeviceTask(` assertions above require. A future regression that
 * refuses remote runs would have to delete one of those calls, and would fail
 * there rather than here.
 */

console.log("[code-remote] shipping JunoDesktop target discovery, dispatch, approvals, and live monitoring are wired");
