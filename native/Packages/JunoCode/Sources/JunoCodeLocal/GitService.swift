import Foundation
import JunoCodeCore

/// A push target resolved from the repository at confirmation time.
///
/// This is deliberately not part of `GitServicing`: the agent tool registry
/// cannot publish. Only the explicit reader-owned Git inspector flow receives
/// this capability.
public struct GitPushPlan: Sendable, Equatable {
    public let remote: String
    public let localBranch: String
    public let remoteBranch: String
    public let setsUpstream: Bool

    public init(
        remote: String,
        localBranch: String,
        remoteBranch: String,
        setsUpstream: Bool
    ) {
        self.remote = remote
        self.localBranch = localBranch
        self.remoteBranch = remoteBranch
        self.setsUpstream = setsUpstream
    }

    public var displayTarget: String { "\(remote)/\(remoteBranch)" }
}

public enum GitPublishError: Error, Equatable, Sendable {
    case detachedHead
    case noRemote
    case ambiguousRemotes([String])
    case planChanged
}

public struct GitHubCheckStatus: Identifiable, Sendable, Equatable {
    public var id: String { "\(workflow ?? "")\u{1f}\(name)\u{1f}\(link ?? "")" }
    public let name: String
    public let workflow: String?
    public let state: String
    public let bucket: String
    public let link: String?

    public init(
        name: String,
        workflow: String?,
        state: String,
        bucket: String,
        link: String?
    ) {
        self.name = name
        self.workflow = workflow
        self.state = state
        self.bucket = bucket
        self.link = link
    }
}

public struct GitHubPullRequestStatus: Sendable, Equatable {
    public let number: Int
    public let title: String
    public let url: String
    public let state: String
    public let isDraft: Bool
    public let headRefName: String
    public let baseRefName: String
    public let reviewDecision: String?
    public let checks: [GitHubCheckStatus]

    public init(
        number: Int,
        title: String,
        url: String,
        state: String,
        isDraft: Bool,
        headRefName: String,
        baseRefName: String,
        reviewDecision: String?,
        checks: [GitHubCheckStatus]
    ) {
        self.number = number
        self.title = title
        self.url = url
        self.state = state
        self.isDraft = isDraft
        self.headRefName = headRefName
        self.baseRefName = baseRefName
        self.reviewDecision = reviewDecision
        self.checks = checks
    }
}

/// Git operations over the workspace-pinned command execution service.
/// Arguments are shell-quoted. Remote publication is available only through a
/// confirmation-bound, non-force plan that is intentionally absent from the
/// agent-facing `GitServicing` protocol.
public final class GitService: GitServicing, Sendable {
    public static let maximumDiffBytes = 2 * 1_024 * 1_024

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

    /// Resolves the exact non-force push target without changing the remote.
    /// A repository without an upstream uses `origin`, or its only remote.
    public func preparePush() async throws -> GitPushPlan {
        let summary = try await status()
        guard let localBranch = summary.branch else {
            throw GitPublishError.detachedHead
        }

        if let upstream = summary.upstream,
           let separator = upstream.firstIndex(of: "/")
        {
            let remote = String(upstream[..<separator])
            let remoteBranch = String(upstream[upstream.index(after: separator)...])
            guard !remote.isEmpty, !remoteBranch.isEmpty else {
                throw GitPublishError.noRemote
            }
            return GitPushPlan(
                remote: remote,
                localBranch: localBranch,
                remoteBranch: remoteBranch,
                setsUpstream: false
            )
        }

        let remotes = try await remoteNames()
        let remote: String
        if remotes.contains("origin") {
            remote = "origin"
        } else if remotes.count == 1, let only = remotes.first {
            remote = only
        } else if remotes.isEmpty {
            throw GitPublishError.noRemote
        } else {
            throw GitPublishError.ambiguousRemotes(remotes)
        }
        return GitPushPlan(
            remote: remote,
            localBranch: localBranch,
            remoteBranch: localBranch,
            setsUpstream: true
        )
    }

    /// Publishes exactly the plan the reader confirmed. The target is resolved
    /// again immediately before execution, preventing a stale confirmation
    /// from pushing a branch or remote that changed in the meantime.
    @discardableResult
    public func push(_ confirmedPlan: GitPushPlan) async throws -> String {
        guard try await preparePush() == confirmedPlan else {
            throw GitPublishError.planChanged
        }
        var arguments = ["push", "--porcelain"]
        if confirmedPlan.setsUpstream {
            arguments.append("--set-upstream")
        }
        arguments.append(confirmedPlan.remote)
        if confirmedPlan.setsUpstream {
            arguments.append(confirmedPlan.localBranch)
        } else {
            arguments.append(
                "\(confirmedPlan.localBranch):refs/heads/\(confirmedPlan.remoteBranch)"
            )
        }
        let outcome = try await runChecked(arguments)
        return outcome.stdout + outcome.stderr
    }

    /// Loads the pull request associated with the current branch and its CI
    /// checks through GitHub's authenticated CLI. This path is read-only and
    /// inherits no process secrets; the scrubbed executor permits only the
    /// user's existing CLI/Keychain authentication.
    public func githubPullRequestStatus() async throws -> GitHubPullRequestStatus? {
        let pullRequest = try await runExecutable(
            "gh",
            arguments: [
                "pr", "view", "--json",
                "number,title,url,state,isDraft,headRefName,baseRefName,reviewDecision",
            ]
        )
        guard pullRequest.result.exitCode == 0 else {
            let message = pullRequest.stderr.isEmpty
                ? pullRequest.stdout
                : pullRequest.stderr
            let lowercased = message.lowercased()
            if lowercased.contains("no pull requests found")
                || lowercased.contains("could not find pull request")
                || lowercased.contains("no pull request found")
            {
                return nil
            }
            throw GitServiceError.commandFailed(message: Self.tail(message))
        }

        let checks = try await runExecutable(
            "gh",
            arguments: [
                "pr", "checks", "--json",
                "bucket,name,state,link,workflow",
            ]
        )
        let checkRows: [GitHubCheckStatus]
        if checks.result.exitCode == 0 || checks.result.exitCode == 8 {
            checkRows = try GitHubStatusParser.parseChecks(checks.stdout)
        } else {
            let message = checks.stderr.isEmpty ? checks.stdout : checks.stderr
            let lowercased = message.lowercased()
            if lowercased.contains("no checks") {
                checkRows = []
            } else {
                throw GitServiceError.commandFailed(message: Self.tail(message))
            }
        }
        return try GitHubStatusParser.parsePullRequest(
            pullRequest.stdout,
            checks: checkRows
        )
    }

    /// Opens a pull request for the current branch through GitHub's CLI.
    ///
    /// Reader-initiated only: like ``push(_:)`` this is deliberately absent from
    /// the agent-facing ``GitServicing`` protocol, so no tool can publish on the
    /// reader's behalf. `gh` uses the reader's own CLI/Keychain authentication
    /// through the scrubbed executor; no GitHub credential enters Juno. The
    /// returned string is the URL `gh` prints, which is the only thing worth
    /// showing afterwards.
    public func createPullRequest(
        title: String,
        body: String,
        baseBranch: String?,
        draft: Bool
    ) async throws -> String {
        var arguments = ["pr", "create", "--title", title, "--body", body]
        if let baseBranch, !baseBranch.isEmpty {
            arguments += ["--base", baseBranch]
        }
        if draft {
            arguments.append("--draft")
        }
        let outcome = try await runExecutable("gh", arguments: arguments)
        guard outcome.result.exitCode == 0 else {
            let message = outcome.stderr.isEmpty ? outcome.stdout : outcome.stderr
            throw GitServiceError.commandFailed(message: Self.tail(message))
        }
        let url = outcome.stdout
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .last { $0.hasPrefix("https://") }
        return url ?? outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The repository's default branch, when `gh` knows it. Nil when the CLI is
    /// missing or the remote is not GitHub; the sheet then leaves the base blank
    /// and lets `gh pr create` pick.
    public func githubDefaultBranch() async -> String? {
        guard let outcome = try? await runExecutable(
            "gh",
            arguments: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]
        ), outcome.result.exitCode == 0 else { return nil }
        let name = outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    // MARK: - Helpers

    private func remoteNames() async throws -> [String] {
        let outcome = try await runChecked(["remote"])
        return outcome.stdout
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .sorted()
    }

    private func run(
        _ arguments: [String],
        outputLimit: OutputLimit = .commandOutput
    ) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        try await runExecutable("git", arguments: arguments, outputLimit: outputLimit)
    }

    private func runExecutable(
        _ executable: String,
        arguments: [String],
        outputLimit: OutputLimit = .commandOutput
    ) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        let commandLine = ([executable] + arguments).map(Self.shellQuote)
            .joined(separator: " ")
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

enum GitHubStatusParser {
    private struct PullRequestPayload: Decodable {
        let number: Int
        let title: String
        let url: String
        let state: String
        let isDraft: Bool
        let headRefName: String
        let baseRefName: String
        let reviewDecision: String?
    }

    private struct CheckPayload: Decodable {
        let bucket: String
        let name: String
        let state: String
        let link: String?
        let workflow: String?
    }

    static func parsePullRequest(
        _ json: String,
        checks: [GitHubCheckStatus]
    ) throws -> GitHubPullRequestStatus {
        let payload = try JSONDecoder().decode(
            PullRequestPayload.self,
            from: Data(json.utf8)
        )
        return GitHubPullRequestStatus(
            number: payload.number,
            title: payload.title,
            url: payload.url,
            state: payload.state,
            isDraft: payload.isDraft,
            headRefName: payload.headRefName,
            baseRefName: payload.baseRefName,
            reviewDecision: payload.reviewDecision,
            checks: checks
        )
    }

    static func parseChecks(_ json: String) throws -> [GitHubCheckStatus] {
        try JSONDecoder().decode([CheckPayload].self, from: Data(json.utf8))
            .map {
                GitHubCheckStatus(
                    name: $0.name,
                    workflow: $0.workflow,
                    state: $0.state,
                    bucket: $0.bucket,
                    link: $0.link
                )
            }
    }
}
