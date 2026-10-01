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

/// The checked-out branch, read from the repository's files rather than by
/// running Git.
///
/// For the places that only need the name before anything is approved, such
/// as the system prompt, which is built before the first request: running
/// `git` there runs whatever the repository's own configuration or the
/// command environment points it at, on opening the folder.
public enum GitHeadReader {
    /// The branch `HEAD` names, or nil when detached, not a repository, or
    /// not a name Git itself would have written.
    public static func branch(atRepositoryRoot root: URL) -> String? {
        var gitDirectory = root.appendingPathComponent(".git")
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: gitDirectory.path, isDirectory: &isDirectory) else {
            return nil
        }
        if !isDirectory.boolValue {
            // A linked worktree or submodule: `.git` is a file naming the
            // real Git directory.
            guard let pointer = smallText(at: gitDirectory),
                  let line = pointer.split(separator: "\n").first(where: { $0.hasPrefix("gitdir:") })
            else { return nil }
            let path = line.dropFirst("gitdir:".count).trimmingCharacters(in: .whitespaces)
            gitDirectory = path.hasPrefix("/")
                ? URL(fileURLWithPath: path)
                : root.appendingPathComponent(path)
        }
        guard let head = smallText(at: gitDirectory.appendingPathComponent("HEAD")) else { return nil }
        let reference = head.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = "ref: refs/heads/"
        guard reference.hasPrefix(prefix) else { return nil }
        let name = String(reference.dropFirst(prefix.count))
        // The name lands in the system prompt. Git refuses whitespace and
        // control characters in a ref, so a HEAD file holding them was not
        // written by Git and is not repeated.
        guard !name.isEmpty, name.count <= 255,
              !name.unicodeScalars.contains(where: {
                  CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0)
              })
        else { return nil }
        return name
    }

    private static func smallText(at url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: 4_096) else { return nil }
        return String(data: data, encoding: .utf8)
    }
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
        // `gh` exits 1 when a check failed and 8 while some are pending; the
        // checks are on stdout in every case.
        if checks.result.exitCode == 0 || checks.result.exitCode == 8 {
            checkRows = try GitHubStatusParser.parseChecks(checks.stdout)
        } else if checks.result.exitCode == 1, let parsed = try? GitHubStatusParser.parseChecks(checks.stdout) {
            checkRows = parsed
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

// MARK: - Review and shipping (Lane E, CODE_AGENT_SPEC §5.3, §5.10)

extension GitService: GitPublishing {
    public func pushTarget() async throws -> GitPushTarget {
        let plan = try await preparePush()
        return GitPushTarget(
            remote: plan.remote,
            localBranch: plan.localBranch,
            remoteBranch: plan.remoteBranch,
            setsUpstream: plan.setsUpstream
        )
    }

    public func push(to target: GitPushTarget) async throws -> String {
        try await push(
            GitPushPlan(
                remote: target.remote,
                localBranch: target.localBranch,
                remoteBranch: target.remoteBranch,
                setsUpstream: target.setsUpstream
            )
        )
    }
}

/// Which changes a review shows, beyond the session's own edits.
public enum GitReviewScope: String, CaseIterable, Sendable {
    /// Everything not committed, against `HEAD`, untracked files included.
    case uncommitted
    /// What is staged, against `HEAD`.
    case staged
    /// The branch's whole change, against its merge base with the default
    /// branch.
    case branch
}

/// One file in a review scope, with both sides to diff.
public struct GitScopedFile: Hashable, Sendable {
    public let path: String
    /// `A`, `M`, `D`, `R` or `?`.
    public let status: String
    /// The file before the change; nil when it did not exist.
    public let old: String?
    /// The file after the change; nil when it no longer exists.
    public let new: String?

    public init(path: String, status: String, old: String?, new: String?) {
        self.path = path
        self.status = status
        self.old = old
        self.new = new
    }
}

public enum GitStageHunkError: Error, Equatable, LocalizedError {
    /// The change is already in the index.
    case alreadyStaged
    /// The hunk no longer lines up with the file.
    case noMatch
    case notText

    public var errorDescription: String? {
        switch self {
        case .alreadyStaged: "That change is already kept (staged)."
        case .noMatch: "That change no longer matches the file. Refresh the diff."
        case .notText: "Only text changes can be kept one hunk at a time."
        }
    }
}

extension GitService {
    /// Most files a scope lists with their contents.
    public static let maximumScopedFiles = 200

    /// `git show <revision>:<path>`, or nil when the file is not there.
    /// `:path` reads the index.
    public func show(revision: String, path: String) async -> String? {
        guard let outcome = try? await run(
            ["show", "\(revision):\(path)"],
            outputLimit: OutputLimit(maximumBytes: Self.maximumDiffBytes)
        ), outcome.result.exitCode == 0 else { return nil }
        return outcome.stdout
    }

    /// The default branch the branch scope compares with: `origin/HEAD`, or
    /// the first of `main`, `master`, `trunk` that exists.
    public func defaultBranchRef() async -> String? {
        if let symbolic = try? await runChecked(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
            let name = symbolic.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { return name }
        }
        for candidate in ["main", "master", "trunk"] {
            if let outcome = try? await run(["rev-parse", "--verify", "--quiet", candidate]),
               outcome.result.exitCode == 0
            {
                return candidate
            }
        }
        return nil
    }

    /// The commit the branch scope compares with.
    public func mergeBase() async throws -> String {
        guard let target = await defaultBranchRef() else {
            throw GitServiceError.commandFailed(message: "No default branch to compare with.")
        }
        let outcome = try await runChecked(["merge-base", "HEAD", target])
        return outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The files a review scope covers, with both sides of each.
    public func scopedFiles(_ scope: GitReviewScope) async throws -> [GitScopedFile] {
        switch scope {
        case .uncommitted:
            let status = try await runChecked(["status", "--porcelain", "--untracked-files=all"])
            return await files(
                Self.parsePorcelain(status.stdout),
                oldRevision: "HEAD",
                newFromIndex: false
            )
        case .staged:
            let names = try await runChecked(["diff", "--cached", "--name-status"])
            return await files(Self.parseNameStatus(names.stdout), oldRevision: "HEAD", newFromIndex: true)
        case .branch:
            let base = try await mergeBase()
            let names = try await runChecked(["diff", "--name-status", base])
            let untracked = try await runChecked(["ls-files", "--others", "--exclude-standard"])
            var entries = Self.parseNameStatus(names.stdout)
            for line in untracked.stdout.split(separator: "\n") where !line.isEmpty {
                let path = String(line)
                if !entries.contains(where: { $0.path == path }) {
                    entries.append((path, "?"))
                }
            }
            return await files(entries, oldRevision: base, newFromIndex: false)
        }
    }

    private func files(
        _ entries: [(path: String, status: String)],
        oldRevision: String,
        newFromIndex: Bool
    ) async -> [GitScopedFile] {
        var result: [GitScopedFile] = []
        for entry in entries.prefix(Self.maximumScopedFiles) {
            let old = entry.status == "A" || entry.status == "?"
                ? nil
                : await show(revision: oldRevision, path: entry.path)
            let new: String?
            if entry.status == "D" {
                new = nil
            } else if newFromIndex {
                new = await show(revision: "", path: entry.path)
            } else {
                new = await workingContent(entry.path)
            }
            result.append(GitScopedFile(path: entry.path, status: entry.status, old: old, new: new))
        }
        return result
    }

    /// The working tree's copy of a file, read through the executor, which is
    /// pinned to the checkout.
    private func workingContent(_ path: String) async -> String? {
        try? await executorCat(path)
    }

    private func executorCat(_ path: String) async throws -> String? {
        let outcome = try await runExecutable(
            "cat",
            arguments: ["--", path],
            outputLimit: OutputLimit(maximumBytes: Self.maximumDiffBytes)
        )
        return outcome.result.exitCode == 0 ? outcome.stdout : nil
    }

    /// Stages exactly one change of a file: the hunk of the index-to-working
    /// diff that makes the same edit as `hunk`. Written as a blob and placed
    /// in the index with `update-index`, so nothing else in the file, and no
    /// other file, is staged.
    public func stageHunk(path: String, matching hunk: DiffHunk) async throws {
        guard let working = try await executorCat(path) else {
            throw GitStageHunkError.notText
        }
        guard let index = await show(revision: "", path: path) else {
            // Not in the index yet: the whole file is the change.
            try await stage(paths: [path])
            return
        }
        let diff = try DiffEngine.diff(old: index, new: working)
        let wanted = Self.changedLines(hunk)
        guard let match = diff.hunks.first(where: { Self.changedLines($0) == wanted }) else {
            // Already in the index when HEAD-to-index makes the same edit.
            let head = await show(revision: "HEAD", path: path) ?? ""
            let staged = (try? DiffEngine.diff(old: head, new: index))?.hunks ?? []
            if diff.hunks.isEmpty || staged.contains(where: { Self.changedLines($0) == wanted }) {
                throw GitStageHunkError.alreadyStaged
            }
            throw GitStageHunkError.noMatch
        }
        let updated = Self.applying(match, to: index)
        let gitDir = try await runChecked(["rev-parse", "--absolute-git-dir"])
            .stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let temporary = URL(fileURLWithPath: gitDir)
            .appendingPathComponent("juno-stage-\(UUID().uuidString.lowercased())")
        try Data(updated.utf8).write(to: temporary, options: .atomic)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let blob = try await runChecked(["hash-object", "-w", temporary.path])
            .stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let listed = try await runChecked(["ls-files", "-s", "--", path]).stdout
        let mode = listed.split(separator: " ").first.map(String.init) ?? "100644"
        _ = try await runChecked(["update-index", "--cacheinfo", "\(mode),\(blob),\(path)"])
    }

    /// The edit a hunk makes, without its position: what it removes and
    /// what it adds, in order.
    static func changedLines(_ hunk: DiffHunk) -> [String] {
        hunk.lines.compactMap { line in
            switch line.kind {
            case .added: "+" + line.text
            case .removed: "-" + line.text
            case .context: nil
            }
        }
    }

    /// `content` with `hunk` applied forward.
    static func applying(_ hunk: DiffHunk, to content: String) -> String {
        var lines = DiffEngine.splitLines(content)
        let start = max(0, hunk.oldStart > 0 ? hunk.oldStart - 1 : 0)
        let end = min(lines.count, start + hunk.oldCount)
        let replacement = hunk.lines.compactMap { $0.kind == .removed ? nil : $0.text }
        lines.replaceSubrange(start..<end, with: replacement)
        let joined = lines.joined(separator: "\n")
        return (content.hasSuffix("\n") || content.isEmpty) && !joined.isEmpty ? joined + "\n" : joined
    }

    /// `git status --porcelain` lines as path and status, renames as their
    /// new path.
    public static func parsePorcelain(_ output: String) -> [(path: String, status: String)] {
        output.split(separator: "\n", omittingEmptySubsequences: true).compactMap { raw in
            let line = String(raw)
            guard line.count > 3 else { return nil }
            let index = line[line.startIndex]
            let worktree = line[line.index(after: line.startIndex)]
            var path = String(line.dropFirst(3))
            if let arrow = path.range(of: " -> ") { path = String(path[arrow.upperBound...]) }
            if path.hasPrefix("\""), path.hasSuffix("\""), path.count >= 2 {
                path = String(path.dropFirst().dropLast())
            }
            let status: String
            if index == "?" { status = "?" }
            else if index == "D" || worktree == "D" { status = "D" }
            else if index == "A" { status = "A" }
            else if index == "R" { status = "R" }
            else { status = "M" }
            return (path, status)
        }
    }

    /// `git diff --name-status` lines as path and status.
    static func parseNameStatus(_ output: String) -> [(path: String, status: String)] {
        output.split(separator: "\n", omittingEmptySubsequences: true).compactMap { raw in
            let fields = raw.split(separator: "\t").map(String.init)
            guard let code = fields.first?.first, fields.count >= 2 else { return nil }
            let path = code == "R" || code == "C" ? (fields.last ?? fields[1]) : fields[1]
            return (path, String(code == "C" ? "A" : code))
        }
    }
}
