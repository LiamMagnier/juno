import Foundation

// Reading a pull request's CI through GitHub's own CLI (CODE_AGENT_SPEC §5.3).
// In Core so the CI watch (JunoCodeLocal) and the agent's read-only CI tools
// (JunoCodeRuntime) share one reading of `gh`'s output. Owned by Lane E.
//
// Everything here reads: `gh pr checks`, `gh pr view`, `gh run view`. Nothing
// pushes, merges or comments; `gh` uses the reader's own CLI authentication
// through the scrubbed executor, and no GitHub credential enters Juno.

/// One row of `gh pr checks --json name,state,bucket,link,workflow`.
public struct GitHubCICheck: Hashable, Codable, Sendable {
    public let name: String
    /// GitHub's state: `SUCCESS`, `FAILURE`, `IN_PROGRESS`, `QUEUED`, …
    public let state: String
    /// `gh`'s grouping: `pass`, `fail`, `pending`, `skipping`, `cancel`.
    public let bucket: String
    public let link: String?
    public let workflow: String?

    public init(name: String, state: String, bucket: String, link: String? = nil, workflow: String? = nil) {
        self.name = name
        self.state = state
        self.bucket = bucket
        self.link = link
        self.workflow = workflow
    }

    /// The protocol's state for this check.
    public var ciState: CICheckState {
        switch bucket.lowercased() {
        case "pass": return .passed
        case "fail": return .failed
        case "skipping": return .skipped
        case "cancel": return .cancelled
        default:
            let upper = state.uppercased()
            return upper == "QUEUED" || upper == "PENDING" || upper == "WAITING" || upper == "REQUESTED"
                ? .queued
                : .running
        }
    }

    public var ciCheck: CICheck {
        CICheck(name: name, state: ciState, url: link)
    }

    /// The Actions run this check belongs to, from its link
    /// (`…/actions/runs/<run>/job/<job>`); nil for a check that is not an
    /// Actions job.
    public var runID: String? { Self.pathComponent(after: "runs", in: link) }
    public var jobID: String? { Self.pathComponent(after: "job", in: link) }

    private static func pathComponent(after marker: String, in link: String?) -> String? {
        guard let link, let url = URL(string: link) else { return nil }
        let parts = url.pathComponents
        guard let index = parts.firstIndex(of: marker), index + 1 < parts.count else { return nil }
        let value = parts[index + 1]
        return value.allSatisfy(\.isNumber) && !value.isEmpty ? value : nil
    }
}

/// The pull request a branch has open, as `gh pr view --json number,url,state`
/// reports it.
public struct GitHubPullRequestRef: Hashable, Codable, Sendable {
    public let number: Int
    public let url: String
    public let state: String

    public init(number: Int, url: String, state: String = "OPEN") {
        self.number = number
        self.url = url
        self.state = state
    }

    /// Merged or closed: the session can be archived with its worktree.
    public var isFinished: Bool {
        let upper = state.uppercased()
        return upper == "MERGED" || upper == "CLOSED"
    }
}

public enum GitHubCIError: Error, Equatable, LocalizedError {
    case commandFailed(String)
    case noPullRequest
    case noLog(String)

    public var errorDescription: String? {
        switch self {
        case let .commandFailed(message): message.isEmpty ? "GitHub CLI failed." : message
        case .noPullRequest: "This branch has no pull request on GitHub."
        case let .noLog(check): "No failing log is available for \(check)."
        }
    }
}

/// Runs `gh` for CI, through the workspace's command executor.
public struct GitHubCIClient: Sendable {
    /// The most of a failing log the model and the reader are shown.
    public static let maximumLogLines = 400

    private let executor: any CommandExecuting
    private let timeoutSeconds: Double
    private let redactor = SecretRedactor()

    public init(executor: any CommandExecuting, timeoutSeconds: Double = 60) {
        self.executor = executor
        self.timeoutSeconds = timeoutSeconds
    }

    /// The pull request for the current branch, or for `number`.
    public func pullRequest(number: Int? = nil) async throws -> GitHubPullRequestRef {
        var arguments = ["pr", "view"]
        if let number { arguments.append(String(number)) }
        arguments += ["--json", "number,url,state"]
        let outcome = try await run(arguments)
        guard outcome.result.exitCode == 0 else {
            let message = outcome.stderr.isEmpty ? outcome.stdout : outcome.stderr
            if message.lowercased().contains("no pull requests found") {
                throw GitHubCIError.noPullRequest
            }
            throw GitHubCIError.commandFailed(Self.tail(message))
        }
        return try JSONDecoder().decode(GitHubPullRequestRef.self, from: Data(outcome.stdout.utf8))
    }

    /// The checks on the pull request. `gh` exits 8 while some are pending,
    /// which is a normal answer, not a failure.
    public func checks(pullRequest number: Int?) async throws -> [GitHubCICheck] {
        var arguments = ["pr", "checks"]
        if let number { arguments.append(String(number)) }
        arguments += ["--json", "name,state,bucket,link,workflow"]
        let outcome = try await run(arguments)
        // `gh` exits 1 when a check failed and 8 while some are pending, with
        // the checks on stdout either way: a JSON answer is an answer.
        if let checks = try? Self.parseChecks(outcome.stdout),
           !checks.isEmpty || outcome.result.exitCode == 0
        {
            return checks
        }
        let message = outcome.stderr.isEmpty ? outcome.stdout : outcome.stderr
        if message.lowercased().contains("no checks") { return [] }
        throw GitHubCIError.commandFailed(Self.tail(message))
    }

    /// The failing part of a check's log: `gh run view <run> --log-failed`,
    /// its last ``maximumLogLines`` lines, with likely secrets redacted.
    public func failedLog(for check: GitHubCICheck) async throws -> String {
        guard let runID = check.runID else { throw GitHubCIError.noLog(check.name) }
        var arguments = ["run", "view", runID, "--log-failed"]
        if let job = check.jobID { arguments += ["--job", job] }
        let outcome = try await run(arguments, outputLimit: OutputLimit(maximumBytes: 4 * 1_024 * 1_024))
        guard outcome.result.exitCode == 0 else {
            let message = outcome.stderr.isEmpty ? outcome.stdout : outcome.stderr
            throw GitHubCIError.commandFailed(Self.tail(message))
        }
        let text = outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw GitHubCIError.noLog(check.name) }
        return redactor.redact(Self.lastLines(text, Self.maximumLogLines))
    }

    public static func parseChecks(_ json: String) throws -> [GitHubCICheck] {
        let trimmed = json.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        return try JSONDecoder().decode([GitHubCICheck].self, from: Data(trimmed.utf8))
    }

    public static func lastLines(_ text: String, _ count: Int) -> String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count > count else { return text }
        return lines.suffix(count).joined(separator: "\n")
    }

    private func run(
        _ arguments: [String],
        outputLimit: OutputLimit = .commandOutput
    ) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        let commandLine = (["gh"] + arguments).map(Self.quote).joined(separator: " ")
        return try await executor.run(commandLine, timeoutSeconds: timeoutSeconds, outputLimit: outputLimit)
    }

    static func quote(_ argument: String) -> String {
        if argument.range(of: "^[A-Za-z0-9_./:=@%+,-]+$", options: .regularExpression) != nil {
            return argument
        }
        return "'" + argument.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func tail(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count > 500 ? String(trimmed.suffix(500)) : trimmed
    }
}

/// CI in words: "3 of 4 checks passed; `test (ubuntu)` failed".
public enum CIStatusWords {
    public static func summary(_ checks: [CICheck]) -> String {
        guard !checks.isEmpty else { return "No checks yet" }
        let passed = checks.filter { $0.state == .passed }.count
        let failed = checks.filter { $0.state == .failed }.map { "`\($0.name)`" }
        let running = checks.filter { !$0.state.isSettled }.count
        var text = "\(passed) of \(checks.count) checks passed"
        if !failed.isEmpty {
            text += "; \(failed.joined(separator: ", ")) failed"
        }
        if running > 0 {
            text += "; \(running) still running"
        }
        return text
    }

    /// Whether every check has settled.
    public static func isSettled(_ checks: [CICheck]) -> Bool {
        !checks.isEmpty && checks.allSatisfy(\.state.isSettled)
    }
}
