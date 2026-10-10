import Foundation
import JunoCodeCore
import JunoCodeLocal

// Auto-open: when the agent starts a dev server or uses the Preview, the
// Preview pane opens on that server; when it builds or runs an app for the
// Simulator, the Simulator pane opens. Decided from the tool calls the
// session already records (the proposed call and its completion), so it
// works the same for every way the agent gets there. One setting turns it
// off; the reader can always open either pane by hand.

/// The reader's switch for opening the Preview and Simulator panes on their
/// own. On unless turned off.
public enum CodeAutoOpenSettings {
    public static let defaultsKey = "juno.code.autoOpenPanes"

    public static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: defaultsKey) }
    }
}

public extension Notification.Name {
    /// Posted when the agent builds or runs an app for the Simulator, so the
    /// workbench can open the Simulator pane for the session in view. The
    /// object is a ``CodePreviewTarget`` naming the workspace and session.
    static let junoCodeSimulatorOpenRequested = Notification.Name(
        "com.liammagnier.juno.code.simulator.open-requested"
    )
}

/// What a finished tool call asks the workbench to show.
public enum CodeAutoOpenDecision: Equatable, Sendable {
    case none
    /// The Preview pane, on this configuration when one is named.
    case preview(configuration: String?)
    /// A background shell that may be starting a server: watch it, and open
    /// the Preview on the address its process listens on.
    case watchShell(id: String)
    /// The Simulator pane.
    case simulator
}

public enum CodeAutoOpen {
    /// The decision for one finished call. Failed calls open nothing.
    public static func decision(
        toolName: String,
        input: JSONValue,
        resultSummary: String,
        succeeded: Bool
    ) -> CodeAutoOpenDecision {
        guard succeeded else { return .none }
        switch toolName {
        case "preview_server":
            switch input["action"]?.stringValue {
            case "start", "restart", "attach": return .preview(configuration: input["name"]?.stringValue)
            default: return .none
            }
        case "preview_browser", "inspect_preview":
            return .preview(configuration: input["name"]?.stringValue)
        case "shell_start":
            guard let id = shellID(in: resultSummary) else { return .none }
            return .watchShell(id: id)
        case ComputerUseToolName.simulator:
            switch input["action"]?.stringValue {
            case "boot", "install", "launch", "screenshot", "open_url": return .simulator
            default: return .none
            }
        case "run_command":
            return buildsForSimulator(input["command"]?.stringValue ?? "") ? .simulator : .none
        default:
            return .none
        }
    }

    /// `xcodebuild … -sdk iphonesimulator`, `-destination 'platform=iOS
    /// Simulator…'`, or `xcrun simctl boot|install|launch`.
    public static func buildsForSimulator(_ command: String) -> Bool {
        let lowered = command.lowercased()
        if lowered.contains("xcodebuild") {
            return lowered.contains("iphonesimulator") || lowered.contains("simulator")
        }
        if lowered.contains("simctl") {
            return ["boot", "install", "launch", "openurl"].contains { lowered.contains("simctl \($0)") }
        }
        return false
    }

    /// The `"id"` of shell_start's one-line JSON header.
    static func shellID(in header: String) -> String? {
        guard header.hasPrefix("{"), header.contains("\"status\":\"running\"") else { return nil }
        guard let range = header.range(of: #""id":"([^"]+)""#, options: .regularExpression) else { return nil }
        return String(header[range].dropFirst(6).dropLast())
    }
}

/// Uses a durable shell's server as a preview: the address must be one the
/// shell's own process group listens on (§4.1, PV-5). Shared by the agent's
/// `preview_server attach` and auto-open.
enum PreviewShellAttach {
    enum Outcome: Equatable {
        case ready(URL, PreviewKey)
        /// Nothing usable yet: no loopback address printed, or nothing of
        /// the shell's listens on it.
        case notYet(String)
        case failed(String)
    }

    static func attach(
        shellID: String,
        session: CodeSessionID,
        workspaceRoot: URL,
        shells: any ShellSessionManaging,
        registry: JunoCodeLocal.PreviewRegistry
    ) async -> Outcome {
        guard let info = shells.info(id: shellID) else { return .failed("No shell \(shellID).") }
        guard info.ownerSessionID == session else { return .failed("Shell \(shellID) belongs to another session.") }
        guard case let .running(pid) = info.state else { return .failed("Shell \(shellID) is not running.") }
        guard let chunk = try? await shells.output(
            id: shellID, ownerSessionID: session, since: nil, tailLines: 400, maximumBytes: 64 * 1_024, waitSeconds: 0
        ) else { return .failed("Shell \(shellID)'s output could not be read.") }
        let candidates = chunk.text.split(separator: "\n").flatMap { DevServerURLDetector.detectAll(in: String($0)) }
        let group = ListeningSocketOwnership.processGroup(of: pid) ?? pid
        let owned = candidates.first { candidate in
            PreviewOrigin.isLoopback(candidate)
                && candidate.port.map { ListeningSocketOwnership.groupListens(port: $0, processGroup: group) } == true
        }
        guard let url = owned ?? candidates.first(where: PreviewOrigin.isLoopback) else {
            return .notYet("Shell \(shellID) has not printed a loopback address its process listens on.")
        }
        if owned == nil, let port = url.port, !ListeningSocketOwnership.groupListens(port: port, processGroup: group) {
            return .notYet("No process of shell \(shellID) listens on port \(port) yet.")
        }
        let outcome = await registry.attachShell(
            shellID: shellID, url: url, processGroup: group, checkoutRoot: workspaceRoot, session: session
        )
        switch outcome.result {
        case let .ready(ready, _): return .ready(ready, outcome.snapshot.key)
        case let .failed(reason): return .failed(reason)
        case .timedOut: return .failed("Shell \(shellID)'s server did not answer.")
        }
    }
}

/// Follows one session's finished tool calls and opens the panes they call
/// for. Owned by the session controller.
@MainActor
final class CodeAutoOpener {
    private let sessionID: CodeSessionID
    private var watchers: [String: Task<Void, Never>] = [:]
    /// Tests replace the check and the poster.
    var isEnabled: () -> Bool = { CodeAutoOpenSettings.isEnabled }
    var post: (Notification.Name, CodePreviewTarget) -> Void = { name, target in
        NotificationCenter.default.post(name: name, object: target)
    }
    var pollInterval: Duration = .seconds(1)
    var watchLimit = 45

    init(sessionID: CodeSessionID) {
        self.sessionID = sessionID
    }

    func toolFinished(
        name: String,
        input: JSONValue,
        resultSummary: String,
        succeeded: Bool,
        workspaceRoot: URL?,
        shells: (any ShellSessionManaging)?
    ) {
        guard isEnabled(), let workspaceRoot else { return }
        switch CodeAutoOpen.decision(toolName: name, input: input, resultSummary: resultSummary, succeeded: succeeded) {
        case .none:
            return
        case let .preview(configuration):
            post(.junoCodePreviewOpenRequested, CodePreviewTarget(
                workspaceRoot: workspaceRoot, sessionID: sessionID, configurationName: configuration
            ))
        case .simulator:
            post(.junoCodeSimulatorOpenRequested, CodePreviewTarget(workspaceRoot: workspaceRoot, sessionID: sessionID))
        case let .watchShell(id):
            guard let shells, watchers[id] == nil else { return }
            watchShell(id: id, workspaceRoot: workspaceRoot, shells: shells)
        }
    }

    /// Polls a new background shell until its process serves a loopback
    /// address (then the Preview opens on it), it stops, or the limit passes.
    private func watchShell(id: String, workspaceRoot: URL, shells: any ShellSessionManaging) {
        let session = sessionID
        let interval = pollInterval
        let limit = watchLimit
        watchers[id] = Task { [weak self] in
            defer { Task { @MainActor [weak self] in self?.watchers[id] = nil } }
            for _ in 0..<limit {
                if Task.isCancelled { return }
                let outcome = await PreviewShellAttach.attach(
                    shellID: id, session: session, workspaceRoot: workspaceRoot, shells: shells, registry: .shared
                )
                switch outcome {
                case let .ready(_, key):
                    await MainActor.run {
                        guard let self, self.isEnabled() else { return }
                        self.post(.junoCodePreviewOpenRequested, CodePreviewTarget(
                            workspaceRoot: workspaceRoot, sessionID: session, configurationName: key.name
                        ))
                    }
                    return
                case .failed:
                    return
                case .notYet:
                    try? await Task.sleep(for: interval)
                }
            }
        }
    }

    func cancelAll() {
        watchers.values.forEach { $0.cancel() }
        watchers = [:]
    }
}
