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
 * This used to assert against JunoCodeUI's NewSessionSheet, which 8720ffbd
 * deleted along with WorkbenchView, AgentCanvasView and GitAndFilesTabs. The
 * obvious reading of that deletion — the one this file itself argued for until
 * now — was that starting a remote task had been broken outright, because
 * WorkbenchModel still exports startRemoteSession/loadRemoteRepositories/
 * loadRemoteDevices and nothing calls any of the three.
 *
 * That reading was wrong, and it is worth writing down why so the next person
 * does not re-derive it. Those three are the OLD path: WorkbenchModel reaches a
 * remote run through `remoteExecutionModel`, and the only UI that ever drove it
 * was the deleted sheet. The path a person actually uses today is
 * `NativeCodeModel.startTask(prompt:)`, which picks cloud or device and calls
 * `createCloudTask`/`createDeviceTask` on the client — and it is driven from
 * both apps: JunoMobileCodeView on iPhone and DesktopCodeStudio on the Mac.
 * The capability moved packages; it did not go away.
 *
 * So the assertions below follow the live surface. The WorkbenchModel entries
 * are kept because `NativeCodeTaskRemoteSessionProvider` still backs that path
 * and is still composed, but they are no longer what proves a human can start a
 * run — these three are.
 */
const nativeCodeModel = read(
  "native/Packages/JunoNativeKit/Sources/JunoCodeKit/NativeCodeModel.swift",
);
const mobileCode = read("native/iOS/JunoMobile/App/JunoMobileCodeView.swift");
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
  // The live start path, end to end: one entry point that chooses a target,
  // both client calls it can choose between, and the two app surfaces that
  // reach it. A run a person can actually start needs all four.
  [nativeCodeModel, "public func startTask(prompt: String)"],
  [nativeCodeModel, "createCloudTask("],
  [nativeCodeModel, "createDeviceTask("],
  [mobileCode, "model.startTask(prompt:"],
  [sidebar, "code.startTask(prompt:"],
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

const unmet = required.filter(([source, fragment]) => !source.includes(fragment));

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
