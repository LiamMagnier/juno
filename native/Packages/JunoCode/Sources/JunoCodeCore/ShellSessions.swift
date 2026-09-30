import Foundation

/// Where one background process started by the agent is in its life.
public enum ShellSessionState: Hashable, Codable, Sendable {
    case running(processID: Int32)
    case exited(code: Int32)
    /// Ended by a signal: the agent's `shell_kill`, or the session ending.
    case signalled(signal: Int32)
    case failed(reason: String)

    public var isRunning: Bool {
        if case .running = self { return true }
        return false
    }

    /// `running`, `exited 0`, `killed by SIGTERM` — for a tool result.
    public var summary: String {
        switch self {
        case let .running(pid): return "running (pid \(pid))"
        case let .exited(code): return "exited \(code)"
        case let .signalled(signal): return "killed by \(ShellSignal(rawSignal: signal)?.rawValue ?? "signal \(signal)")"
        case let .failed(reason): return "failed: \(reason)"
        }
    }
}

/// The signals `shell_kill` may send.
public enum ShellSignal: String, CaseIterable, Codable, Sendable {
    case interrupt = "SIGINT"
    case terminate = "SIGTERM"
    case hangup = "SIGHUP"
    case kill = "SIGKILL"

    public var rawSignal: Int32 {
        switch self {
        case .interrupt: return SIGINT
        case .terminate: return SIGTERM
        case .hangup: return SIGHUP
        case .kill: return SIGKILL
        }
    }

    public init?(rawSignal: Int32) {
        guard let match = Self.allCases.first(where: { $0.rawSignal == rawSignal }) else { return nil }
        self = match
    }
}

/// One background process, as the agent and the reader see it.
public struct ShellSessionInfo: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let command: String
    /// Workspace-relative folder it runs in; nil for the workspace root.
    public let workingDirectory: WorkspacePath?
    public let ownerSessionID: CodeSessionID
    public let startedAt: Date
    public var state: ShellSessionState
    /// Every byte of output it has produced so far, the logical end offset.
    public var outputBytes: Int
    /// The risk its start was authorized at. Input written to it later can
    /// do whatever the process does with input, so it is asked about at the
    /// same tier.
    public let risk: ActionRisk

    public init(
        id: String,
        name: String?,
        command: String,
        workingDirectory: WorkspacePath?,
        ownerSessionID: CodeSessionID,
        startedAt: Date,
        state: ShellSessionState,
        outputBytes: Int,
        risk: ActionRisk
    ) {
        self.id = id
        self.name = name
        self.command = command
        self.workingDirectory = workingDirectory
        self.ownerSessionID = ownerSessionID
        self.startedAt = startedAt
        self.state = state
        self.outputBytes = outputBytes
        self.risk = risk
    }

    /// `sh-2 "dev server"` or `sh-2`.
    public var label: String {
        name.map { "\(id) \"\($0)\"" } ?? id
    }
}

/// A slice of one process's output.
public struct ShellOutputChunk: Hashable, Sendable {
    public let info: ShellSessionInfo
    public let text: String
    /// The logical offset of the first byte of `text`.
    public let startOffset: Int
    /// Where the next incremental read should start (`since`).
    public let nextOffset: Int
    /// Output that was asked for but is gone: older than the retained log.
    public let droppedBytes: Int
    /// Bytes left out of the middle of `text` to stay within the read's budget.
    public let omittedBytes: Int

    public init(
        info: ShellSessionInfo,
        text: String,
        startOffset: Int,
        nextOffset: Int,
        droppedBytes: Int = 0,
        omittedBytes: Int = 0
    ) {
        self.info = info
        self.text = text
        self.startOffset = startOffset
        self.nextOffset = nextOffset
        self.droppedBytes = droppedBytes
        self.omittedBytes = omittedBytes
    }
}

public enum ShellSessionError: Error, Equatable, Sendable, CustomStringConvertible {
    case unknownSession(id: String)
    /// Started by another session, or by the reader: never the agent's to touch.
    case notOwned(id: String)
    case notRunning(id: String, state: ShellSessionState)
    /// Its input is closed, or full because it is not reading.
    case notReading(id: String)
    case tooManySessions(limit: Int)
    case invalidWorkingDirectory(String)
    case forbidden(reason: String)
    case launchFailed(message: String)

    public var description: String {
        switch self {
        case let .unknownSession(id):
            return "There is no shell \(id) in this session. Call shell_output without an id to list them."
        case let .notOwned(id):
            return "Shell \(id) was not started by this session's agent, so it cannot be written to or stopped from here."
        case let .notRunning(id, state):
            return "Shell \(id) is not running (\(state.summary))."
        case let .notReading(id):
            return "Shell \(id) is not reading its input (it closed it, or has not consumed what was already sent). Nothing was written."
        case let .tooManySessions(limit):
            return "This session already has \(limit) background shells running. Stop one with shell_kill first."
        case let .invalidWorkingDirectory(message):
            return message
        case let .forbidden(reason):
            return reason
        case let .launchFailed(message):
            return "The process could not be started: \(message)"
        }
    }
}

/// Long-lived processes the agent starts in the background — dev servers,
/// watchers, jobs it checks on later — run under the same containment as
/// `run_command` and owned by the session that started them.
public protocol ShellSessionManaging: Sendable {
    func start(
        command: String,
        workingDirectory: WorkspacePath?,
        name: String?,
        ownerSessionID: CodeSessionID,
        risk: ActionRisk
    ) async throws -> ShellSessionInfo

    /// Output after `since` (a `nextOffset` from an earlier read), or the last
    /// `tailLines` lines when `since` is nil, at most `maximumBytes`. Waits up
    /// to `waitSeconds` for output past `since`, or for the process to end,
    /// before answering.
    func output(
        id: String,
        ownerSessionID: CodeSessionID,
        since: Int?,
        tailLines: Int?,
        maximumBytes: Int,
        waitSeconds: Double
    ) async throws -> ShellOutputChunk

    /// Writes to the process's standard input. Returns the bytes written.
    func write(id: String, ownerSessionID: CodeSessionID, text: String) async throws -> Int

    func kill(id: String, ownerSessionID: CodeSessionID, signal: ShellSignal) async throws -> ShellSessionInfo

    /// A shell by id, whoever owns it. Synchronous so a tool can size a
    /// write's risk before asking.
    func info(id: String) -> ShellSessionInfo?

    func sessions(ownedBy sessionID: CodeSessionID) -> [ShellSessionInfo]

    /// Stops every process the session started: it has ended.
    func terminateAll(ownedBy sessionID: CodeSessionID) async

    /// Stops every process: the workspace is closing or the app quitting.
    func terminateAll() async
}

/// The folder each session's `run_command` runs in: the workspace root until
/// a command that is only `cd <dir>` moves it.
public final class SessionWorkingDirectories: @unchecked Sendable {
    private let lock = NSLock()
    private var directories: [CodeSessionID: WorkspacePath] = [:]

    public init() {}

    /// Nil means the workspace root.
    public func current(for sessionID: CodeSessionID) -> WorkspacePath? {
        lock.lock()
        defer { lock.unlock() }
        return directories[sessionID]
    }

    public func set(_ directory: WorkspacePath?, for sessionID: CodeSessionID) {
        lock.lock()
        defer { lock.unlock() }
        directories[sessionID] = directory
    }

    /// `target` resolved against `current`, as a shell would resolve a `cd`
    /// argument, without leaving the workspace. Nil is the workspace root.
    ///
    /// - Parameter workspaceRoot: the root's absolute path, so an absolute
    ///   target inside the workspace is accepted and one outside refused.
    public static func resolve(
        _ target: String,
        from current: WorkspacePath?,
        workspaceRoot: String
    ) throws -> WorkspacePath? {
        var trimmed = target.trimmingCharacters(in: .whitespaces)
        if trimmed.count >= 2,
           let first = trimmed.first, let last = trimmed.last,
           first == last, first == "\"" || first == "'"
        {
            trimmed = String(trimmed.dropFirst().dropLast())
        }
        var components: [String]
        if trimmed.isEmpty || trimmed == "~" {
            return nil
        } else if trimmed.hasPrefix("/") {
            let root = workspaceRoot.hasSuffix("/") ? String(workspaceRoot.dropLast()) : workspaceRoot
            guard trimmed == root || trimmed.hasPrefix(root + "/") else {
                throw ShellSessionError.invalidWorkingDirectory(
                    "\(trimmed) is outside the workspace; commands run inside it."
                )
            }
            components = []
            trimmed = String(trimmed.dropFirst(root.count))
        } else if trimmed.hasPrefix("~") {
            throw ShellSessionError.invalidWorkingDirectory(
                "\(trimmed) is outside the workspace; commands run inside it."
            )
        } else {
            components = current?.components ?? []
        }
        for part in trimmed.split(separator: "/", omittingEmptySubsequences: true) {
            switch part {
            case ".":
                continue
            case "..":
                guard !components.isEmpty else {
                    throw ShellSessionError.invalidWorkingDirectory(
                        "\(target) leads out of the workspace; commands run inside it."
                    )
                }
                components.removeLast()
            default:
                components.append(String(part))
            }
        }
        guard !components.isEmpty else { return nil }
        do {
            return try WorkspacePath(components.joined(separator: "/"))
        } catch {
            throw ShellSessionError.invalidWorkingDirectory("\(target) is not a usable folder name.")
        }
    }
}

/// An executor that can run a command in a folder below the workspace root.
public protocol DirectoryScopedCommandExecuting: CommandExecuting {
    func stream(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit,
        workingDirectory: WorkspacePath?
    ) -> AsyncThrowingStream<CommandEvent, Error>

    /// Throws unless `directory` is a folder inside the workspace, links
    /// resolved.
    func validateWorkingDirectory(_ directory: WorkspacePath) throws
}
