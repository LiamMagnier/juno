import AppKit
import JunoCodeCore
import JunoCore
import JunoDesignSystem
import Observation
import SwiftUI

/// The Mac's black box (docs/rea/designs/reliability-and-native.md §3.3): the
/// sentinel written at launch and removed at a clean quit, the session
/// snapshot written as the window changes, and what the next launch does when
/// the sentinel is still there.
///
/// - One unclean exit: the window comes back on the conversation (or Code
///   session) it was on, with its unsent draft, and a quiet banner says so.
/// - Two inside ten minutes: safe mode as well — computer use, extensions
///   (MCP), the Quick Entry hotkey, background agents and custom motion stay
///   off, with a banner and Restart Normally.
///
/// The rules live in `JunoCore` (``JunoCrashRecovery``) and are tested there;
/// this type only connects them to the app's lifecycle and its window.
@MainActor
@Observable
final class DesktopCrashRecovery {
    static let shared = DesktopCrashRecovery()

    /// What this launch found. `.clean` until ``launch()`` runs.
    private(set) var assessment = JunoLaunchAssessment.clean
    /// Whether the "closed unexpectedly" banner is up.
    private(set) var showsRestoredBanner = false
    /// Whether the safe mode banner is up. Dismissing it leaves safe mode on.
    private(set) var showsSafeModeBanner = false

    @ObservationIgnored private var recovery: JunoCrashRecovery?
    @ObservationIgnored private var recorder: JunoSessionSnapshotRecorder?
    /// A restored conversation's draft, handed to its composer once.
    @ObservationIgnored private var pendingDraft: JunoSessionSnapshot.Draft?
    /// Set while the restore has not landed yet, so the launch surface (an
    /// empty new chat) is not written over the snapshot it is restoring.
    @ObservationIgnored private var restoreTarget: JunoSessionSnapshot?
    @ObservationIgnored private var heartbeat: Task<Void, Never>?
    @ObservationIgnored private var started = false

    /// UI tests stand in for `kill -9` with this (acceptance test A5).
    static let simulateUncleanExitArgument = "--juno-simulate-unclean-exit"
    /// Starts in safe mode whatever the sentinel says.
    static let safeModeArgument = "--juno-safe-mode"

    private init() {}

    // MARK: Launch and quit

    /// Reads the previous run, decides, and writes this run's sentinel. Called
    /// from `applicationDidFinishLaunching`, before any optional subsystem is
    /// installed, so safe mode can keep them off.
    func launch() {
        guard !started, let location = JunoRecoveryLocation.applicationSupport(
            bundleIdentifier: Bundle.main.bundleIdentifier
        ) else { return }
        started = true
        let recovery = JunoCrashRecovery(location: location)
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let arguments = ProcessInfo.processInfo.arguments
        #if DEBUG
        if arguments.contains(Self.simulateUncleanExitArgument) {
            recovery.plantSentinel(version: version)
        }
        #endif
        var result = recovery.beginLaunch(version: version)
        if arguments.contains(Self.safeModeArgument) { result.kind = .safeMode }
        self.recovery = recovery
        recorder = JunoSessionSnapshotRecorder(location: location)
        assessment = result

        JunoSafeMode.set(active: result.isSafeMode)
        showsSafeModeBanner = result.isSafeMode
        if result.isUnclean, let snapshot = result.snapshot {
            showsRestoredBanner = true
            restore(snapshot)
        }
        startHeartbeat()
    }

    /// The app is quitting cleanly.
    func endCleanly() {
        heartbeat?.cancel()
        recorder?.flushIfDirty()
        recovery?.endCleanly()
    }

    /// Restart Normally: forget the crash count and relaunch with everything
    /// on. A helper waits for this process to end before opening the app
    /// again, so the new launch finds no sentinel; if the quit is cancelled
    /// (a run the reader chose to keep), it gives up rather than opening a
    /// second copy.
    func restartNormally() {
        recovery?.resetCrashLoop()
        let pid = ProcessInfo.processInfo.processIdentifier
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-c",
            "for _ in $(seq 1 300); do kill -0 \"$1\" 2>/dev/null || break; sleep 0.2; done; "
                + "kill -0 \"$1\" 2>/dev/null || /usr/bin/open \"$2\"",
            "alevr-relaunch", String(pid), Bundle.main.bundleURL.path,
        ]
        try? process.run()
        NSApp.terminate(nil)
    }

    func dismissRestoredBanner() {
        showsRestoredBanner = false
    }

    func dismissSafeModeBanner() {
        showsSafeModeBanner = false
    }

    // MARK: Restore

    /// Hands the snapshot to the main window the way a notification or Quick
    /// Entry hands it a route: through the registry, consumed once, after the
    /// launch surface is up.
    private func restore(_ snapshot: JunoSessionSnapshot) {
        restoreTarget = snapshot
        recorder?.seed(snapshot)
        let registry = DesktopWorkbenchRegistry.shared
        // In safe mode the Code session is not reopened: Chat is the lighter
        // surface, and a session left mid-run is what may have crashed.
        if snapshot.product == .code, let id = snapshot.codeSessionID, !assessment.isSafeMode {
            registry.request(.openSession(CodeSessionID(value: id)))
        } else if let id = snapshot.conversationID {
            pendingDraft = snapshot.draft?.conversationID == id ? snapshot.draft : nil
            registry.requestRoute(.conversation(id: id))
        } else if let text = snapshot.draftText(for: nil) {
            registry.request(.newChat(prompt: text))
        } else {
            restoreTarget = nil
        }
        // A restore that never lands (a conversation deleted elsewhere, a
        // plan without Code) must not stop the recorder for good.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            self?.restoreTarget = nil
        }
    }

    /// The restored conversation's draft, once, for the composer showing it.
    func takeRestoredDraft(for conversationID: String?) -> String? {
        guard let draft = pendingDraft, draft.conversationID == conversationID else { return nil }
        pendingDraft = nil
        return draft.text
    }

    // MARK: Recording

    /// What the front window shows. Called by the workspace as it changes.
    func noteWindow(product: JunoSessionSnapshot.Product, conversationID: String?, codeSessionID: String?) {
        if let target = restoreTarget {
            let landed = target.product == product
                && (product == .code ? target.codeSessionID == codeSessionID : target.conversationID == conversationID)
            guard landed else { return }
            restoreTarget = nil
        }
        recorder?.update { snapshot in
            snapshot.product = product
            snapshot.conversationID = conversationID
            snapshot.codeSessionID = codeSessionID
            // A draft follows its conversation; moving away drops it from
            // the snapshot (the composer reports the new one).
            if snapshot.draft?.conversationID != conversationID { snapshot.draft = nil }
        }
    }

    /// The composer's unsent words. Never called for a private chat.
    func noteDraft(_ text: String, conversationID: String?) {
        guard restoreTarget == nil else { return }
        recorder?.update { snapshot in
            snapshot.draft = text.isEmpty ? nil : .init(conversationID: conversationID, text: text)
        }
    }

    /// Every few seconds: write a held draft; once the run has lasted long
    /// enough, call it stable and reset the crash count.
    private func startHeartbeat() {
        heartbeat = Task { [weak self] in
            var stable = false
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(JunoSessionSnapshotRecorder.defaultDraftInterval))
                guard let self else { return }
                self.recorder?.flushIfDirty()
                if !stable, self.recovery?.markStable() == true { stable = true }
            }
        }
    }
}

// MARK: - Draft

/// Keeps a chat composer's unsent words in the session snapshot, and puts a
/// restored conversation's draft back in its field after an unclean exit.
///
/// Not for a private chat: nothing a private turn types is written anywhere.
struct DesktopRecoveryDraft: ViewModifier {
    /// False for a private chat and a project's fixed composer.
    let isRecorded: Bool
    /// The conversation on screen, or nil for a new chat.
    let conversationID: String?
    @Binding var text: String

    func body(content: Content) -> some View {
        content
            .onChange(of: conversationID, initial: true) { _, id in
                guard isRecorded, let id, text.isEmpty,
                    let restored = DesktopCrashRecovery.shared.takeRestoredDraft(for: id)
                else { return }
                text = restored
            }
            .onChange(of: text) { _, value in
                guard isRecorded else { return }
                DesktopCrashRecovery.shared.noteDraft(value, conversationID: conversationID)
            }
    }
}

// MARK: - Banner

/// The one quiet line after an unclean exit, and the safe mode line under it.
/// Calm on purpose: a caption, not an alert — the work is back, and nothing
/// needs deciding unless the reader wants to.
struct DesktopRecoveryBanner: View {
    @State private var recovery = DesktopCrashRecovery.shared

    var body: some View {
        VStack(spacing: 0) {
            if recovery.showsSafeModeBanner {
                line(icon: .shield, identifier: "juno.desktop.safe-mode-banner") {
                    Text(JunoShellStrings.safeModeTitle).fontWeight(.semibold)
                    Text(JunoShellStrings.safeModeBody)
                        .lineLimit(2)
                        .help(JunoShellStrings.safeModeBody)
                } actions: {
                    action(JunoShellStrings.safeModeRestartNormally) { recovery.restartNormally() }
                    action(JunoShellStrings.recoveryDismiss) { recovery.dismissSafeModeBanner() }
                }
            }
            if recovery.showsRestoredBanner {
                line(icon: .history, identifier: "juno.desktop.recovery-banner") {
                    Text(JunoShellStrings.recoveryRestored)
                } actions: {
                    action(JunoShellStrings.recoveryDismiss) { recovery.dismissRestoredBanner() }
                }
            }
        }
    }

    private func line(
        icon: JunoIcon,
        identifier: String,
        @ViewBuilder text: () -> some View,
        @ViewBuilder actions: () -> some View
    ) -> some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(icon, size: 12)
            text()
            Spacer(minLength: JunoSpace.snug)
            actions()
        }
        .junoFont(size: 12, relativeTo: .footnote)
        .junoSecondaryInk()
        .lineLimit(1)
        .frame(minHeight: 28)
        .padding(.horizontal, JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    /// Link-style accent text in the ink rung, as the offline caption's Try
    /// Again is drawn.
    private func action(_ title: String, perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            Text(title)
                .fontWeight(.medium)
                .foregroundStyle(Color.junoAccentInk)
                .frame(minHeight: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}
