import Foundation

/// A terminal window size expressed in character cells.
public struct NativeTerminalSize: Equatable, Sendable {
    public let columns: UInt16
    public let rows: UInt16

    public init(columns: UInt16, rows: UInt16) {
        self.columns = columns
        self.rows = rows
    }

    public static let `default` = NativeTerminalSize(columns: 120, rows: 32)
}

/// Limits that protect the host app from an uncooperative interactive child.
public struct NativeTerminalLimits: Equatable, Sendable {
    public let maximumOutputBytes: Int
    public let maximumTranscriptBytes: Int
    public let maximumOutputChunkBytes: Int
    public let maximumPendingEvents: Int
    public let maximumInputBytes: Int
    public let maximumLifetimeNanoseconds: UInt64

    public init(
        maximumOutputBytes: Int = 1 * 1024 * 1024,
        maximumTranscriptBytes: Int = 256 * 1024,
        maximumOutputChunkBytes: Int = 16 * 1024,
        maximumPendingEvents: Int = 256,
        maximumInputBytes: Int = 64 * 1024,
        maximumLifetimeNanoseconds: UInt64 = 60 * 60 * 1_000_000_000
    ) {
        // Keep the limits safe even when a caller constructs them from
        // user-configured values. Zero is useful in tests and means "retain
        // nothing", while negative values are never meaningful.
        self.maximumOutputBytes = max(0, maximumOutputBytes)
        self.maximumTranscriptBytes = max(0, maximumTranscriptBytes)
        self.maximumOutputChunkBytes = max(1, maximumOutputChunkBytes)
        self.maximumPendingEvents = max(1, maximumPendingEvents)
        self.maximumInputBytes = max(1, maximumInputBytes)
        self.maximumLifetimeNanoseconds = maximumLifetimeNanoseconds
    }
}

public enum NativeTerminalCommandError: Error, Equatable, Sendable, LocalizedError {
    case emptyExecutable
    case executableMustBeAbsolute
    case containsNUL(field: String)
    case pathTooLong(field: String)
    case tooManyArguments
    case argumentsTooLarge
    case invalidEnvironmentKey
    case tooManyEnvironmentEntries
    case environmentTooLarge
    case workingDirectoryMustBeAbsolute

    public var errorDescription: String? {
        switch self {
        case .emptyExecutable:
            return "The terminal executable cannot be empty."
        case .executableMustBeAbsolute:
            return "The terminal executable must be an absolute path; PATH lookup is not implicit."
        case let .containsNUL(field):
            return "The terminal command \(field) contains a NUL byte."
        case let .pathTooLong(field):
            return "The terminal command \(field) is too long."
        case .tooManyArguments:
            return "The terminal command has too many arguments."
        case .argumentsTooLarge:
            return "The terminal command arguments exceed the safe size limit."
        case .invalidEnvironmentKey:
            return "A terminal environment key is empty or contains '=' or NUL."
        case .tooManyEnvironmentEntries:
            return "The terminal environment has too many entries."
        case .environmentTooLarge:
            return "The terminal environment exceeds the safe size limit."
        case .workingDirectoryMustBeAbsolute:
            return "The terminal working directory must be an absolute path."
        }
    }
}

/// An explicit executable invocation. It is intentionally not a shell command
/// string: the child receives these values as argv/envp through execve.
public struct NativeTerminalCommand: Equatable, Sendable {
    public let executable: String
    public let arguments: [String]
    public let environment: [String: String]
    public let workingDirectory: URL

    public init(
        executable: String,
        arguments: [String] = [],
        environment: [String: String] = [:],
        workingDirectory: URL
    ) throws {
        let maximumPathBytes = 4 * 1024
        let maximumArguments = 256
        let maximumArgumentBytes = 512 * 1024
        let maximumEnvironmentEntries = 256
        let maximumEnvironmentBytes = 256 * 1024

        guard !executable.isEmpty else {
            throw NativeTerminalCommandError.emptyExecutable
        }
        guard executable.hasPrefix("/") else {
            throw NativeTerminalCommandError.executableMustBeAbsolute
        }
        guard !executable.utf8.contains(0) else {
            throw NativeTerminalCommandError.containsNUL(field: "executable")
        }
        guard executable.utf8.count <= maximumPathBytes else {
            throw NativeTerminalCommandError.pathTooLong(field: "executable")
        }
        guard arguments.count <= maximumArguments else {
            throw NativeTerminalCommandError.tooManyArguments
        }
        guard arguments.allSatisfy({ !$0.utf8.contains(0) }) else {
            throw NativeTerminalCommandError.containsNUL(field: "argument")
        }
        let argumentBytes = arguments.reduce(0) { $0 + $1.utf8.count + 1 }
        guard argumentBytes <= maximumArgumentBytes else {
            throw NativeTerminalCommandError.argumentsTooLarge
        }
        guard workingDirectory.isFileURL,
              workingDirectory.path.hasPrefix("/"),
              !workingDirectory.path.utf8.contains(0),
              workingDirectory.path.utf8.count <= maximumPathBytes
        else {
            throw NativeTerminalCommandError.workingDirectoryMustBeAbsolute
        }

        guard environment.keys.allSatisfy({
            !$0.isEmpty && !$0.contains("=") && !$0.utf8.contains(0)
        }) else {
            throw NativeTerminalCommandError.invalidEnvironmentKey
        }
        guard environment.values.allSatisfy({ !$0.utf8.contains(0) }) else {
            throw NativeTerminalCommandError.containsNUL(field: "environment value")
        }
        guard environment.count <= maximumEnvironmentEntries else {
            throw NativeTerminalCommandError.tooManyEnvironmentEntries
        }
        let environmentBytes = environment.reduce(0) {
            $0 + $1.key.utf8.count + 1 + $1.value.utf8.count + 1
        }
        guard environmentBytes <= maximumEnvironmentBytes else {
            throw NativeTerminalCommandError.environmentTooLarge
        }

        self.executable = executable
        self.arguments = arguments
        self.environment = environment
        self.workingDirectory = workingDirectory
    }

    /// The exact argv vector, including argv[0]. Useful for inspection and
    /// keeps command construction testable without starting a child.
    public var argv: [String] { [executable] + arguments }

    /// A deterministic envp representation. The launch path uses this same
    /// sorted order, and never inherits the app's environment.
    public var environmentEntries: [String] {
        environment.keys.sorted().map { "\($0)=\(environment[$0] ?? "")" }
    }
}

public enum NativeTerminalError: Error, Equatable, Sendable, LocalizedError {
    case unsupportedPlatform
    case alreadyRunning
    case notRunning
    case invalidSize
    case inputTooLarge
    case launchFailed(errno: Int32)
    case workingDirectoryUnavailable
    case writeFailed(errno: Int32)
    case resizeFailed(errno: Int32)
    case signalFailed(signal: Int32, errno: Int32)
    case waitFailed(errno: Int32)

    public var errorDescription: String? {
        switch self {
        case .unsupportedPlatform:
            return "Native PTY terminals are only available on macOS."
        case .alreadyRunning:
            return "The terminal session already has a child process."
        case .notRunning:
            return "The terminal session has no running child process."
        case .invalidSize:
            return "The terminal size must be within the supported character-cell range."
        case .inputTooLarge:
            return "The terminal input exceeds the per-write limit."
        case let .launchFailed(errno):
            return "Could not allocate or launch the terminal PTY (errno \(errno))."
        case .workingDirectoryUnavailable:
            return "The terminal working directory is unavailable or is not a directory."
        case let .writeFailed(errno):
            return "Could not write terminal input (errno \(errno))."
        case let .resizeFailed(errno):
            return "Could not resize the terminal (errno \(errno))."
        case let .signalFailed(signal, errno):
            return "Could not send signal \(signal) to the terminal process group (errno \(errno))."
        case let .waitFailed(errno):
            return "Could not wait for the terminal child (errno \(errno))."
        }
    }
}

public enum NativeTerminalSignal: Int32, Equatable, Sendable {
    case interrupt = 2
    case hangup = 1
    case terminate = 15
    case kill = 9
}

public enum NativeTerminalExitReason: Equatable, Sendable {
    case processStatus
    case terminated
    case cancelled
    case outputLimit
    case lifetimeLimit
}

public struct NativeTerminalExit: Equatable, Sendable {
    public let processID: Int32
    public let waitStatus: Int32
    public let reason: NativeTerminalExitReason

    public init(processID: Int32, waitStatus: Int32, reason: NativeTerminalExitReason) {
        self.processID = processID
        self.waitStatus = waitStatus
        self.reason = reason
    }

    public var exitCode: Int32? {
        guard waitStatus & 0x7f == 0 else { return nil }
        return (waitStatus >> 8) & 0xff
    }

    public var signal: Int32? {
        let value = waitStatus & 0x7f
        return value == 0 ? nil : value
    }
}

public enum NativeTerminalState: Equatable, Sendable {
    case idle
    case starting
    case running(processID: Int32)
    case stopping
    case exited(NativeTerminalExit)
    case failed(NativeTerminalError)

    public var isRunning: Bool {
        switch self {
        case .starting, .running, .stopping:
            return true
        case .idle, .exited, .failed:
            return false
        }
    }
}

public enum NativeTerminalEvent: Equatable, Sendable {
    case state(NativeTerminalState)
    case output(Data)
    case eof
    case exited(NativeTerminalExit)
}
