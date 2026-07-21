import Foundation
import JunoCodeCore

/// Git operations over the workspace-pinned command execution service.
/// Arguments are shell-quoted; only non-destructive commands are issued.
public final class GitService: GitServicing, Sendable {
    public static let maximumDiffBytes = 512 * 1_024

    private let executor: any CommandExecuting
    private let timeoutSeconds: Double

    public init(executor: any CommandExecuting, timeoutSeconds: Double = 30) {
        self.executor = executor
        self.timeoutSeconds = timeoutSeconds
    }

    public func isRepository() async -> Bool {
        guard let outcome = try? await run(["rev-parse", "--is-inside-work-tree"]) else {
            return false
        }
        return outcome.result.exitCode == 0
            && outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    }

    public func status() async throws -> GitStatusSummary {
        let outcome = try await runChecked(["status", "--porcelain", "--branch"])
        return GitStatusParser.parse(outcome.stdout)
    }

    public func diff(staged: Bool, path: WorkspacePath?) async throws -> String {
        var arguments = ["diff"]
        if staged { arguments.append("--cached") }
        if let path {
            arguments.append("--")
            arguments.append(path.value)
        }
        let outcome = try await runChecked(
            arguments,
            outputLimit: OutputLimit(maximumBytes: Self.maximumDiffBytes)
        )
        return outcome.stdout
    }

    public func log(limit: Int) async throws -> [GitCommitInfo] {
        let bounded = min(max(1, limit), 200)
        let outcome = try await runChecked([
            "log", "-n", String(bounded), "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI",
        ])
        return Self.parseLog(outcome.stdout)
    }

    public func stage(paths: [String]) async throws {
        guard !paths.isEmpty else { return }
        _ = try await runChecked(["add", "--"] + paths)
    }

    public func unstage(paths: [String]) async throws {
        guard !paths.isEmpty else { return }
        _ = try await runChecked(["restore", "--staged", "--"] + paths)
    }

    public func createBranch(named name: String) async throws {
        _ = try await runChecked(["switch", "-c", name])
    }

    public func commit(message: String) async throws -> GitCommitInfo {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw GitServiceError.commandFailed(message: "Empty commit message.")
        }
        let outcome = try await run(["commit", "-m", trimmed])
        guard outcome.result.exitCode == 0 else {
            let combined = outcome.stdout + outcome.stderr
            if combined.contains("nothing to commit") {
                throw GitServiceError.nothingToCommit
            }
            throw GitServiceError.commandFailed(message: Self.tail(combined))
        }
        let head = try await runChecked(["log", "-1", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI"])
        guard let info = Self.parseLog(head.stdout).first else {
            throw GitServiceError.commandFailed(message: "Could not read the new commit.")
        }
        return info
    }

    // MARK: - Helpers

    private func run(
        _ arguments: [String],
        outputLimit: OutputLimit = .commandOutput
    ) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        let commandLine = (["git"] + arguments.map(Self.shellQuote)).joined(separator: " ")
        return try await executor.run(
            commandLine,
            timeoutSeconds: timeoutSeconds,
            outputLimit: outputLimit
        )
    }

    private func runChecked(
        _ arguments: [String],
        outputLimit: OutputLimit = .commandOutput
    ) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        let outcome = try await run(arguments, outputLimit: outputLimit)
        guard outcome.result.exitCode == 0 else {
            let combined = outcome.stderr.isEmpty ? outcome.stdout : outcome.stderr
            if combined.contains("not a git repository") {
                throw GitServiceError.notARepository
            }
            throw GitServiceError.commandFailed(message: Self.tail(combined))
        }
        return outcome
    }

    static func shellQuote(_ argument: String) -> String {
        if argument.range(of: "^[A-Za-z0-9_./:=@%+-]+$", options: .regularExpression) != nil {
            return argument
        }
        return "'" + argument.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func parseLog(_ output: String) -> [GitCommitInfo] {
        let formatter = ISO8601DateFormatter()
        return output.components(separatedBy: "\n").compactMap { line in
            let fields = line.components(separatedBy: "\u{1f}")
            guard fields.count >= 5, !fields[0].isEmpty else { return nil }
            return GitCommitInfo(
                hash: fields[0],
                shortHash: fields[1],
                subject: fields[2],
                author: fields[3],
                date: formatter.date(from: fields[4]) ?? Date(timeIntervalSince1970: 0)
            )
        }
    }

    private static func tail(_ text: String, characters: Int = 500) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count > characters ? String(trimmed.suffix(characters)) : trimmed
    }
}
