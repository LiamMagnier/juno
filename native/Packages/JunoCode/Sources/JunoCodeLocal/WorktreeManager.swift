import Foundation
import JunoCodeCore

public enum WorktreeManagerError: Error, Equatable, Sendable {
    case notARepository
    case invalidBranchName
    case workspaceUnavailable
    case pathEscapesWorkspace
    case worktreeNotOwned
    case parentHasChanges
    case baseRevisionChanged
    case noChangesToCommit
    case commandFailed(message: String)
}

/// Metadata for a real Git worktree owned by Juno.
public struct ManagedWorktree: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let rootPath: String
    public let branch: String
    public let baseRevision: String
    public let createdAt: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        rootPath: String,
        branch: String,
        baseRevision: String,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.rootPath = rootPath
        self.branch = branch
        self.baseRevision = baseRevision
        self.createdAt = createdAt
    }

    public var rootURL: URL { URL(fileURLWithPath: rootPath, isDirectory: true) }
}

/// Bounded review data for one isolated agent checkout. Untracked paths are
/// listed separately because Git's ordinary diff does not include their
/// contents until they are staged.
public struct WorktreeReview: Equatable, Sendable {
    public let worktree: ManagedWorktree
    public let status: String
    public let diff: String
    public let untrackedPaths: [String]

    public init(
        worktree: ManagedWorktree,
        status: String,
        diff: String,
        untrackedPaths: [String]
    ) {
        self.worktree = worktree
        self.status = status
        self.diff = diff
        self.untrackedPaths = untrackedPaths
    }
}

/// Non-destructive Git worktree lifecycle for parallel coding sessions.
///
/// Worktrees live below `.juno/worktrees` inside the granted repository. That
/// keeps creation within the same capability and kernel sandbox as ordinary
/// workspace writes, while ensuring the active checkout and its dirty files
/// are never switched underneath the reader. The manager does not merge or
/// delete user work: removal is explicit and uses `git worktree remove --force`
/// only for a path Juno created itself.
public final class WorktreeManager: @unchecked Sendable {
    private let executor: any CommandExecuting
    private let workspaceRootURL: URL
    private let fileManager: FileManager
    private let metadataURL: URL
    private let lock = NSLock()
    private var managed: [String: ManagedWorktree] = [:]

    public init(
        executor: any CommandExecuting,
        workspaceRootURL: URL,
        metadataURL: URL? = nil,
        fileManager: FileManager = .default
    ) {
        self.executor = executor
        self.workspaceRootURL = workspaceRootURL
        self.fileManager = fileManager
        self.metadataURL = metadataURL ?? workspaceRootURL
            .appendingPathComponent(".juno", isDirectory: true)
            .appendingPathComponent("worktrees.json", isDirectory: false)
        self.managed = Self.loadMetadata(
            from: self.metadataURL,
            workspaceRootURL: workspaceRootURL,
            fileManager: fileManager
        )
    }

    public var worktrees: [ManagedWorktree] {
        lock.lock()
        defer { lock.unlock() }
        return managed.values.sorted { $0.createdAt < $1.createdAt }
    }

    /// Finds an owned worktree by its canonical checkout path. Persisted
    /// metadata makes this work after relaunch, not only while the parent
    /// session happens to be alive.
    public func worktree(rootPath: String) -> ManagedWorktree? {
        let canonical = URL(fileURLWithPath: rootPath)
            .resolvingSymlinksInPath().standardizedFileURL.path
        return lock.withLock {
            managed.values.first {
                $0.rootURL.resolvingSymlinksInPath().standardizedFileURL.path == canonical
            }
        }
    }

    /// Creates a branch and checks it out into an isolated working directory.
    /// The current checkout's branch and dirty state are left untouched.
    public func create(branch requestedBranch: String) async throws -> ManagedWorktree {
        let branch = requestedBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isSafeBranchName(branch) else {
            throw WorktreeManagerError.invalidBranchName
        }
        guard fileManager.fileExists(atPath: workspaceRootURL.path) else {
            throw WorktreeManagerError.workspaceUnavailable
        }

        let baseRevision = try await runChecked(["rev-parse", "HEAD"])
        let root = workspaceRootURL.resolvingSymlinksInPath().standardizedFileURL.path
        let baseDirectory = workspaceRootURL
            .appendingPathComponent(".juno", isDirectory: true)
            .appendingPathComponent("worktrees", isDirectory: true)
        try fileManager.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        guard Self.isContained(baseDirectory, in: root) else {
            throw WorktreeManagerError.pathEscapesWorkspace
        }

        let id = UUID().uuidString.lowercased()
        let destination = baseDirectory.appendingPathComponent(
            "\(Self.slug(branch))-\(id.prefix(8))",
            isDirectory: true
        )
        guard !fileManager.fileExists(atPath: destination.path) else {
            throw WorktreeManagerError.commandFailed(message: "The worktree destination already exists.")
        }

        do {
            _ = try await runChecked([
                "worktree", "add", "-b", branch, destination.path, "HEAD",
            ])
        } catch let WorktreeManagerError.commandFailed(message) {
            throw WorktreeManagerError.commandFailed(message: message)
        } catch {
            throw error
        }

        let worktree = ManagedWorktree(
            id: id,
            rootPath: destination.resolvingSymlinksInPath().standardizedFileURL.path,
            branch: branch,
            baseRevision: baseRevision,
            createdAt: Date()
        )
        lock.withLock {
            managed[id] = worktree
        }
        do {
            try persistMetadata()
        } catch {
            _ = lock.withLock { managed.removeValue(forKey: id) }
            _ = try? await runChecked(["worktree", "remove", "--force", worktree.rootPath])
            throw WorktreeManagerError.commandFailed(
                message: "Could not persist worktree metadata: \(error.localizedDescription)"
            )
        }
        return worktree
    }

    /// Removes one of Juno's worktrees. The path is checked against both the
    /// manager's in-memory ownership and the repository root before Git runs.
    public func remove(_ worktree: ManagedWorktree) async throws {
        let owned = lock.withLock { managed[worktree.id] == worktree }
        guard owned else { throw WorktreeManagerError.worktreeNotOwned }
        let root = workspaceRootURL.resolvingSymlinksInPath().standardizedFileURL.path
        guard Self.isContained(worktree.rootURL, in: root) else {
            throw WorktreeManagerError.pathEscapesWorkspace
        }
        _ = try await runChecked(["worktree", "remove", "--force", worktree.rootPath])
        _ = lock.withLock {
            managed.removeValue(forKey: worktree.id)
        }
        try persistMetadata()
    }

    /// Reads the isolated checkout without changing it. The path and ownership
    /// checks are repeated here because review can happen much later than
    /// creation, including after a relaunch.
    public func review(_ worktree: ManagedWorktree) async throws -> WorktreeReview {
        try validateOwned(worktree)
        let status = try await runCheckedAt(
            worktree.rootPath,
            ["status", "--porcelain", "--untracked-files=all"]
        )
        let diff = try await runCheckedAt(
            worktree.rootPath,
            ["diff", worktree.baseRevision, "--binary"],
            outputLimit: OutputLimit(maximumBytes: GitService.maximumDiffBytes)
        )
        let untracked = status
            .split(separator: "\n", omittingEmptySubsequences: true)
            .compactMap { line -> String? in
                guard line.count > 3, line.hasPrefix("?? ") else { return nil }
                return String(line.dropFirst(3))
            }
        return WorktreeReview(
            worktree: worktree,
            status: status,
            diff: diff,
            untrackedPaths: untracked
        )
    }

    /// Creates a host-owned snapshot commit for the isolated result. This is
    /// intentionally outside the child tool registry: it gives the parent a
    /// stable review/apply unit without granting the child a way to mutate the
    /// parent checkout or bypass its own approval policy.
    @discardableResult
    public func finalize(
        _ worktree: ManagedWorktree,
        message: String
    ) async throws -> String? {
        try validateOwned(worktree)
        let status = try await runCheckedAt(
            worktree.rootPath,
            ["status", "--porcelain", "--untracked-files=all"]
        )
        guard !status.isEmpty else { return nil }
        _ = try await runCheckedAt(worktree.rootPath, ["add", "-A", "--", "."])
        let staged = try await runAllowingFailureAt(worktree.rootPath, ["diff", "--cached", "--quiet"])
        // `diff --quiet` exits 1 when content is staged, which is the only
        // successful path for a commit. Any other non-zero is a real failure.
        guard staged.exitCode == 1 else {
            if staged.exitCode == 0 { throw WorktreeManagerError.noChangesToCommit }
            throw WorktreeManagerError.commandFailed(message: staged.output)
        }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let commitMessage = trimmed.isEmpty ? "Juno sub-agent result" : trimmed
        _ = try await runCheckedAt(
            worktree.rootPath,
            ["commit", "--no-verify", "-m", commitMessage]
        )
        return try await runCheckedAt(worktree.rootPath, ["rev-parse", "HEAD"])
    }

    /// Applies a finalized isolated result to the parent branch. The parent
    /// must still be at the worktree's base revision and have no user changes;
    /// refusing otherwise avoids an implicit conflict or overwriting work the
    /// reader made while the agent was running.
    public func apply(_ worktree: ManagedWorktree) async throws {
        try validateOwned(worktree)
        let parentStatus = try await runChecked(["status", "--porcelain", "--untracked-files=all"])
        let unsafeParentLines = parentStatus
            .split(separator: "\n", omittingEmptySubsequences: true)
            .filter {
                let path = $0.count > 3 ? String($0.dropFirst(3)) : ""
                // `.juno` is Juno-owned workspace metadata. Tracked files in
                // it still appear as modified and block apply; untracked
                // metadata must not make every isolated result look dirty.
                return !($0.hasPrefix("?? ") && path.hasPrefix(".juno/"))
            }
        guard unsafeParentLines.isEmpty else {
            throw WorktreeManagerError.parentHasChanges
        }
        let currentRevision = try await runChecked(["rev-parse", "HEAD"])
        guard currentRevision == worktree.baseRevision else {
            throw WorktreeManagerError.baseRevisionChanged
        }
        let worktreeStatus = try await runCheckedAt(
            worktree.rootPath,
            ["status", "--porcelain", "--untracked-files=all"]
        )
        guard worktreeStatus.isEmpty else {
            throw WorktreeManagerError.commandFailed(
                message: "The isolated result is not finalized yet. Finish the sub-agent snapshot first."
            )
        }
        _ = try await runChecked(["merge", "--no-ff", "--no-edit", worktree.branch])
    }

    /// Repairs stale administrative entries without removing any worktree
    /// directory. Safe to call when the app starts.
    public func prune() async throws {
        _ = try await runChecked(["worktree", "prune"])
        let existing = lock.withLock { managed }
        let filtered = existing.filter { fileManager.fileExists(atPath: $0.value.rootPath) }
        lock.withLock { managed = filtered }
        try persistMetadata()
    }

    /// A branch name is passed as a single Git argument, but a conservative
    /// validation still keeps generated paths and the UI predictable.
    public static func isSafeBranchName(_ value: String) -> Bool {
        guard !value.isEmpty,
              value.count <= 180,
              !value.hasPrefix("-"),
              !value.hasSuffix("."),
              !value.contains(".."),
              !value.contains("@{"),
              !value.contains("//")
        else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            scalar.value >= 0x21
                && scalar.value != 0x7F
                && !" ~^:?*[\\".unicodeScalars.contains(scalar)
        }
    }

    private static func slug(_ branch: String) -> String {
        let value = branch
            .replacingOccurrences(of: "/", with: "-")
            .map { character in
                character.isLetter || character.isNumber || character == "-" || character == "_"
                    ? character
                    : "-"
            }
        let result = String(value).trimmingCharacters(in: CharacterSet(charactersIn: "-_."))
        return result.isEmpty ? "task" : String(result.prefix(64))
    }

    private func runChecked(_ arguments: [String]) async throws -> String {
        try await runCheckedAt(workspaceRootURL.path, arguments)
    }

    private func runCheckedAt(
        _ rootPath: String,
        _ arguments: [String],
        outputLimit: OutputLimit = OutputLimit(maximumBytes: 256 * 1_024)
    ) async throws -> String {
        let line = (["git", "-C", rootPath] + arguments).map(Self.shellQuote).joined(separator: " ")
        let result: (result: CommandResult, stdout: String, stderr: String)
        do {
            result = try await executor.run(
                line,
                timeoutSeconds: 60,
                outputLimit: outputLimit
            )
        } catch {
            throw WorktreeManagerError.commandFailed(message: String(describing: error))
        }
        guard result.result.exitCode == 0 else {
            let detail = result.stderr.isEmpty ? result.stdout : result.stderr
            throw WorktreeManagerError.commandFailed(
                message: detail.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }
        return result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func runAllowingFailureAt(
        _ rootPath: String,
        _ arguments: [String]
    ) async throws -> (exitCode: Int32, output: String) {
        let line = (["git", "-C", rootPath] + arguments).map(Self.shellQuote).joined(separator: " ")
        let result: (result: CommandResult, stdout: String, stderr: String)
        do {
            result = try await executor.run(
                line,
                timeoutSeconds: 60,
                outputLimit: OutputLimit(maximumBytes: 256 * 1_024)
            )
        } catch {
            throw WorktreeManagerError.commandFailed(message: String(describing: error))
        }
        let output = (result.stderr.isEmpty ? result.stdout : result.stderr)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (result.result.exitCode, output)
    }

    private func validateOwned(_ worktree: ManagedWorktree) throws {
        let owned = lock.withLock { managed[worktree.id] == worktree }
        guard owned else { throw WorktreeManagerError.worktreeNotOwned }
        let root = workspaceRootURL.resolvingSymlinksInPath().standardizedFileURL.path
        guard Self.isContained(worktree.rootURL, in: root),
              fileManager.fileExists(atPath: worktree.rootPath)
        else { throw WorktreeManagerError.pathEscapesWorkspace }
    }

    private func persistMetadata() throws {
        let snapshot = lock.withLock {
            managed.values.sorted { $0.createdAt < $1.createdAt }
        }
        try fileManager.createDirectory(
            at: metadataURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(snapshot)
        try data.write(to: metadataURL, options: [.atomic])
    }

    private static func loadMetadata(
        from metadataURL: URL,
        workspaceRootURL: URL,
        fileManager: FileManager
    ) -> [String: ManagedWorktree] {
        guard let data = try? Data(contentsOf: metadataURL),
              let entries = try? JSONDecoder.iso8601.decode([ManagedWorktree].self, from: data)
        else { return [:] }
        let root = workspaceRootURL.resolvingSymlinksInPath().standardizedFileURL.path
        let worktreesRoot = workspaceRootURL
            .appendingPathComponent(".juno", isDirectory: true)
            .appendingPathComponent("worktrees", isDirectory: true)
            .resolvingSymlinksInPath().standardizedFileURL.path
        var result: [String: ManagedWorktree] = [:]
        for entry in entries {
            guard isContained(entry.rootURL, in: root),
                  isContained(entry.rootURL, in: worktreesRoot),
                  WorktreeManager.isSafeBranchName(entry.branch),
                  fileManager.fileExists(atPath: entry.rootPath),
                  result[entry.id] == nil
            else { continue }
            result[entry.id] = entry
        }
        return result
    }

    private static func shellQuote(_ argument: String) -> String {
        if argument.range(of: "^[A-Za-z0-9_./:=@%+-]+$", options: .regularExpression) != nil {
            return argument
        }
        return "'" + argument.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func isContained(_ url: URL, in rootPath: String) -> Bool {
        let candidate = url.resolvingSymlinksInPath().standardizedFileURL.path
        let root = URL(fileURLWithPath: rootPath)
            .resolvingSymlinksInPath().standardizedFileURL.path
        let prefix = root.hasSuffix("/") ? root : root + "/"
        return candidate == root || candidate.hasPrefix(prefix)
    }
}

private extension JSONDecoder {
    static var iso8601: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
