import Foundation

public enum CommandExecutionError: Error, Equatable, Sendable {
    case forbidden(reason: String)
    case launchFailed(message: String)
}

public struct CommandResult: Sendable, Equatable {
    public let exitCode: Int32
    public let wasTimeout: Bool
    public let wasCancelled: Bool
    public let wasTruncated: Bool
    public let durationSeconds: Double

    public init(
        exitCode: Int32,
        wasTimeout: Bool,
        wasCancelled: Bool,
        wasTruncated: Bool,
        durationSeconds: Double
    ) {
        self.exitCode = exitCode
        self.wasTimeout = wasTimeout
        self.wasCancelled = wasCancelled
        self.wasTruncated = wasTruncated
        self.durationSeconds = durationSeconds
    }

    public var succeeded: Bool {
        exitCode == 0 && !wasTimeout && !wasCancelled
    }
}

public enum CommandEvent: Sendable, Equatable {
    case stdout(String)
    case stderr(String)
    case completed(CommandResult)
}

/// Streams one command's execution. Implementations must:
/// - run with the working directory pinned to the workspace root;
/// - build a minimal environment (never inheriting tokens or credentials);
/// - enforce the timeout and total output budget;
/// - terminate the whole child process group on cancellation;
/// - refuse commands the classifier forbids, in every permission mode.
public protocol CommandExecuting: Sendable {
    func stream(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit
    ) -> AsyncThrowingStream<CommandEvent, Error>
}

public extension CommandExecuting {
    /// Convenience: runs to completion, collecting bounded output.
    func run(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit = .commandOutput
    ) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        var stdout = ""
        var stderr = ""
        var result: CommandResult?
        for try await event in stream(
            commandLine,
            timeoutSeconds: timeoutSeconds,
            outputLimit: outputLimit
        ) {
            switch event {
            case let .stdout(text): stdout += text
            case let .stderr(text): stderr += text
            case let .completed(final): result = final
            }
        }
        guard let result else {
            throw CommandExecutionError.launchFailed(message: "Stream ended without completion.")
        }
        return (result, stdout, stderr)
    }
}
