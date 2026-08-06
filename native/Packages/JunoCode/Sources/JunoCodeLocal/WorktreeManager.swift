import Foundation
import JunoCodeCore

/// Compatibility name for the integration surface that SessionController can
/// adopt later. The durable model itself lives in JunoCodeCore.
public typealias ManagedWorktree = WorktreeMetadata

public enum WorktreeBlockReason: String, Codable, Equatable, Sendable {
    case parentHasChanges
    case baseRevisionChanged
    case worktreeHasChanges
    case resultNotFinalized
    case worktreeNotRegistered
    case metadataInvalid
}

public enum WorktreeManagerError: Error, Equatable, Sendable {
    case notARepository
    case invalidBranchName
    case invalidBaseRevision
    case workspaceUnavailable
    case pathEscapesWorkspace
    case worktreeNotOwned
    case worktreeMissing
    case worktreeNotRegistered
    case parentHasChanges
    case baseRevisionChanged
    case noChangesToCommit
    case blocked(WorktreeBlockReason)
    case commandFailed(message: String)
    case metadataPersistenceFailed(message: String)
}

extension WorktreeManagerError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .notARepository: return "The workspace is not a Git repository."
        case .invalidBranchName: return "The branch name is not safe for a managed worktree."
        case .invalidBaseRevision: return "The base revision is not a safe Git revision."
        case .workspaceUnavailable: return "The workspace is unavailable."
        case .pathEscapesWorkspace: return "The worktree path is outside the granted workspace."
        case .worktreeNotOwned: return "The worktree is not owned by Juno."
        case .worktreeMissing: return "The owned worktree path is missing."
        case .worktreeNotRegistered: return "Git no longer registers this worktree path."
        case .parentHasChanges: return "The source worktree has changes; applying is blocked."
        case .baseRevisionChanged: return "The source worktree moved since the worktree was created."
        case .noChangesToCommit: return "There are no changes to commit."
        case let .blocked(reason): return "The worktree operation is blocked: \(reason.rawValue)."
        case let .commandFailed(message): return message
        case let .metadataPersistenceFailed(message): return message
        }
    }
}

/// A bounded, read-only view of one registered Git worktree.
public struct RegisteredWorktree: Codable, Equatable, Hashable, Sendable {
    public let rootPath: String
    public let headRevision: String
    public let branch: String?

    public init(rootPath: String, headRevision: String, branch: String?) {
        self.rootPath = rootPath
        self.headRevision = headRevision
        self.branch = branch
    }
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
/// Worktrees are created below `.juno/worktrees` inside the granted
/// repository. The manager never switches the source checkout and never
/// treats a decoded path as trusted: every Git mutation is preceded by an
/// ownership, registration, and canonical containment check.
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

    /// Active records only. Removed tombstones remain persisted so a repeated
    /// cleanup call is idempotent and cannot accidentally target a reused path.
    public var worktrees: [ManagedWorktree] {
        lock.withLock {
            managed.values
                .filter { $0.lifecycle != .removed }
                .sorted { $0.createdAt < $1.createdAt }
        }
    }

    /// Finds an owned active worktree by canonical checkout path. Persisted
    /// metadata makes this work after relaunch, not only while a session lives.
    public func worktree(rootPath: String) -> ManagedWorktree? {
        guard Self.isAbsolutePath(rootPath) else { return nil }
        let canonical = Self.canonicalPath(URL(fileURLWithPath: rootPath))
        return lock.withLock {
            managed.values.first {
                $0.lifecycle != .removed
                    && Self.canonicalPath($0.rootURL) == canonical
            }
        }
    }

    /// Lists Git's registered worktrees without changing any checkout.
    public func list() async throws -> [RegisteredWorktree] {
        try await listRegisteredWorktrees()
    }

    /// Creates an isolated checkout from an explicit revision. When omitted,
    /// `HEAD` is resolved immediately and the resolved revision is passed to
    /// `git worktree add`; a dirty source checkout is therefore left intact.
    public func create(
        branch requestedBranch: String,
        from requestedBaseRevision: String? = nil
    ) async throws -> ManagedWorktree {
        let branch = requestedBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isSafeBranchName(branch) else {
            throw WorktreeManagerError.invalidBranchName
        }
        try validateWorkspaceRoot()
        try await validateRepository()

        let baseRevision = try await resolveBaseRevision(requestedBaseRevision)
        let root = Self.canonicalURL(workspaceRootURL)
        let worktreesRoot = root
            .appendingPathComponent(".juno", isDirectory: true)
            .appendingPathComponent("worktrees", isDirectory: true)
        try validateOwnedPath(worktreesRoot, root: root)
        // Check before creating `.juno`: a symlinked `.juno` must never cause
        // Juno to create directories outside the granted workspace.
        try fileManager.createDirectory(at: worktreesRoot, withIntermediateDirectories: true)
        try validateOwnedPath(worktreesRoot, root: root)

        let id = UUID().uuidString.lowercased()
        let destination = worktreesRoot.appendingPathComponent(
            Self.worktreeDirectoryName(branch: branch, id: id),
            isDirectory: true
        )
        try validateOwnedPath(destination, root: root)
        guard !fileManager.fileExists(atPath: destination.path) else {
            throw WorktreeManagerError.commandFailed(
                message: "The worktree destination already exists."
            )
        }

        do {
            _ = try await runChecked([
                "worktree", "add", "-b", branch, destination.path, baseRevision,
            ])
            let registered = try await listRegisteredWorktrees()
            guard let entry = registered.first(where: {
                Self.canonicalPath(URL(fileURLWithPath: $0.rootPath))
                    == Self.canonicalPath(destination)
            }), entry.branch == branch else {
                throw WorktreeManagerError.worktreeNotRegistered
            }

            let worktree = ManagedWorktree(
                id: id,
                rootPath: Self.canonicalPath(destination),
                branch: branch,
                baseRevision: baseRevision,
                owner: .juno,
                lifecycle: .active,
                createdAt: Date()
            )
            lock.withLock { managed[id] = worktree }
            do {
                try persistMetadata()
            } catch {
                _ = lock.withLock { managed.removeValue(forKey: id) }
                try? await removeCreatedWorktree(
                    at: destination,
                    root: root,
                    expectedBranch: branch
                )
                throw WorktreeManagerError.metadataPersistenceFailed(
                    message: "Could not persist worktree metadata: \(error.localizedDescription)"
                )
            }
            return worktree
        } catch {
            // Only this exact, prevalidated destination is eligible for
            // rollback. No arbitrary path from a Git error is ever removed.
            if fileManager.fileExists(atPath: destination.path) {
                try? await removeCreatedWorktree(
                    at: destination,
                    root: root,
                    expectedBranch: branch
                )
            }
            throw normalized(error)
        }
    }

    /// Removes an owned worktree. The default path refuses dirty checkouts;
    /// `force` is explicit and still cannot operate outside Juno's directory.
    /// Calling remove again after success is a no-op.
    public func remove(_ worktree: ManagedWorktree, force: Bool = false) async throws {
        guard let current = ownedMetadata(matching: worktree) else {
            if worktree.lifecycle == .removed { return }
            throw WorktreeManagerError.worktreeNotOwned
        }
        guard current.lifecycle != .removed else { return }
        let root = Self.canonicalURL(workspaceRootURL)
        let worktreesRoot = root.appendingPathComponent(".juno/worktrees", isDirectory: true)
        try validateOwnedMetadata(current, root: root, worktreesRoot: worktreesRoot)

        let registered = try await listRegisteredWorktrees()
        guard let entry = registered.first(where: {
            Self.canonicalPath(URL(fileURLWithPath: $0.rootPath)) == Self.canonicalPath(current.rootURL)
        }) else {
            guard !fileManager.fileExists(atPath: current.rootPath) else {
                try mark(current, as: .recoveryRequired)
                throw WorktreeManagerError.blocked(.worktreeNotRegistered)
            }
            // The path is already gone and Git has no registration left. It is
            // safe to forget, but no filesystem deletion is attempted.
            try mark(current, as: .removed)
            return
        }
        guard entry.branch == current.branch else {
            try mark(current, as: .recoveryRequired)
            throw WorktreeManagerError.blocked(.metadataInvalid)
        }

        if !force {
            let status = try await runCheckedAt(current.rootPath, [
                "status", "--porcelain", "--untracked-files=all",
            ])
            guard status.isEmpty else {
                try mark(current, as: .blocked)
                throw WorktreeManagerError.blocked(.worktreeHasChanges)
            }
        }

        try mark(current, as: .removing)
        do {
            _ = try await runChecked(["worktree", "remove"] + (force ? ["--force"] : []) + [current.rootPath])
            try mark(current, as: .removed)
        } catch {
            try? mark(current, as: .recoveryRequired)
            throw normalized(error)
        }
    }

    /// Reconciles persisted metadata with Git. It never deletes a path. A
    /// missing or mismatched checkout is made visibly recoverable instead of
    /// being silently discarded.
    @discardableResult
    public func reconcile() async throws -> [ManagedWorktree] {
        let registered = try await listRegisteredWorktrees()
        let snapshot = lock.withLock { managed.values }
        for entry in snapshot where entry.lifecycle != .removed {
            let matching = registered.first {
                Self.canonicalPath(URL(fileURLWithPath: $0.rootPath)) == Self.canonicalPath(entry.rootURL)
            }
            guard let matching else {
                if fileManager.fileExists(atPath: entry.rootPath) {
                    try mark(entry, as: .recoveryRequired)
                } else {
                    try mark(entry, as: .recoveryRequired)
                }
                continue
            }
            guard matching.branch == entry.branch,
                  Self.isContained(entry.rootURL, in: Self.canonicalURL(workspaceRootURL))
            else {
                try mark(entry, as: .recoveryRequired)
                continue
            }
        }
        return worktrees
    }

    /// Repairs Git's stale administrative records and then performs the same
    /// metadata reconciliation as app relaunch recovery.
    public func prune() async throws {
        _ = try await runChecked(["worktree", "prune"])
        _ = try await reconcile()
        try persistMetadata()
    }

    /// Reads the isolated checkout without changing it.
    public func review(_ worktree: ManagedWorktree) async throws -> WorktreeReview {
        _ = try await validateOwned(worktree)
        let status = try await runCheckedAt(worktree.rootPath, [
            "status", "--porcelain", "--untracked-files=all",
        ])
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

    /// Creates a host-owned snapshot commit for the isolated result.
    @discardableResult
    public func finalize(_ worktree: ManagedWorktree, message: String) async throws -> String? {
        let current = try await validateOwned(worktree)
        let status = try await runCheckedAt(current.rootPath, [
            "status", "--porcelain", "--untracked-files=all",
        ])
        guard !status.isEmpty else { return nil }
        _ = try await runCheckedAt(current.rootPath, ["add", "-A", "--", "."])
        let staged = try await runAllowingFailureAt(current.rootPath, ["diff", "--cached", "--quiet"])
        guard staged.exitCode == 1 else {
            if staged.exitCode == 0 { throw WorktreeManagerError.noChangesToCommit }
            throw WorktreeManagerError.commandFailed(message: staged.output)
        }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try await runCheckedAt(current.rootPath, [
            "commit", "--no-verify", "-m", trimmed.isEmpty ? "Juno sub-agent result" : trimmed,
        ])
        let revision = try await runCheckedAt(current.rootPath, ["rev-parse", "HEAD"])
        try mark(current, as: .finalized)
        return revision
    }

    /// Applies a finalized isolated result only when the source checkout is
    /// still clean and at the recorded base revision. No user changes are
    /// reset, stashed, overwritten, or implicitly merged around.
    public func apply(_ worktree: ManagedWorktree) async throws {
        let current = try await validateOwned(worktree)
        guard current.lifecycle == .finalized else {
            throw WorktreeManagerError.blocked(.resultNotFinalized)
        }
        let parentStatus = try await runChecked(["status", "--porcelain", "--untracked-files=all"])
        let unsafeParentLines = parentStatus
            .split(separator: "\n", omittingEmptySubsequences: true)
            .filter {
                let path = $0.count > 3 ? String($0.dropFirst(3)) : ""
                return !($0.hasPrefix("?? ") && (path == ".juno" || path.hasPrefix(".juno/")))
            }
        guard unsafeParentLines.isEmpty else {
            try mark(current, as: .blocked)
            throw WorktreeManagerError.parentHasChanges
        }
        let currentRevision = try await runChecked(["rev-parse", "HEAD"])
        guard currentRevision == current.baseRevision else {
            try mark(current, as: .blocked)
            throw WorktreeManagerError.baseRevisionChanged
        }
        let worktreeStatus = try await runCheckedAt(current.rootPath, [
            "status", "--porcelain", "--untracked-files=all",
        ])
        guard worktreeStatus.isEmpty else {
            try mark(current, as: .blocked)
            throw WorktreeManagerError.blocked(.worktreeHasChanges)
        }
        _ = try await runChecked(["merge", "--no-ff", "--no-edit", current.branch])
        try mark(current, as: .applied)
    }

    /// Conservative branch validation for a value that will also become part
    /// of a generated directory name. The actual Git command remains quoted.
    public static func isSafeBranchName(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 180,
              !value.hasPrefix("-"), !value.hasPrefix("/"), !value.hasSuffix("/"),
              !value.contains("//"), !value.contains(".."), !value.contains("@{"),
              !value.contains(" ")
        else { return false }
        let components = value.split(separator: "/", omittingEmptySubsequences: false)
        guard components.allSatisfy({ component in
            let part = String(component)
            return !part.isEmpty
                && part != "."
                && part != ".."
                && !part.hasPrefix(".")
                && !part.hasSuffix(".")
                && !part.hasSuffix(".lock")
        }) else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            (scalar.value >= 0x30 && scalar.value <= 0x39)
                || (scalar.value >= 0x41 && scalar.value <= 0x5A)
                || (scalar.value >= 0x61 && scalar.value <= 0x7A)
                || scalar == "/" || scalar == "-" || scalar == "_" || scalar == "."
        }
    }

    /// Deterministic and shell-independent destination naming for tests and
    /// recovery tooling. The UUID is still unique; the branch is only a hint.
    public static func worktreeDirectoryName(branch: String, id: String) -> String {
        let slug = branch
            .replacingOccurrences(of: "/", with: "-")
            .map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "-" }
        let trimmed = String(slug).trimmingCharacters(in: CharacterSet(charactersIn: "-_."))
        let safeSlug = trimmed.isEmpty ? "task" : String(trimmed.prefix(64))
        return "\(safeSlug)-\(String(id.prefix(8)))"
    }

    /// Path containment is public for deterministic safety tests and for a
    /// future SessionController integration point. Both paths are canonical.
    public static func isContained(_ candidate: URL, in root: URL) -> Bool {
        let candidatePath = canonicalPath(candidate)
        let rootPath = canonicalPath(root)
        return candidatePath == rootPath || candidatePath.hasPrefix(rootPath + "/")
    }

    // MARK: - Validation and state

    private func validateWorkspaceRoot() throws {
        var isDirectory: ObjCBool = false
        guard Self.isAbsolutePath(workspaceRootURL.path),
              fileManager.fileExists(atPath: workspaceRootURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else { throw WorktreeManagerError.workspaceUnavailable }
    }

    private func validateRepository() async throws {
        do {
            let result = try await runChecked(["rev-parse", "--is-inside-work-tree"])
            guard result == "true" else { throw WorktreeManagerError.notARepository }
        } catch let error as WorktreeManagerError {
            if case .commandFailed = error { throw WorktreeManagerError.notARepository }
            throw error
        }
    }

    private func resolveBaseRevision(_ requested: String?) async throws -> String {
        let reference: String
        if let requested {
            let trimmed = requested.trimmingCharacters(in: .whitespacesAndNewlines)
            guard Self.isSafeRevisionReference(trimmed) else {
                throw WorktreeManagerError.invalidBaseRevision
            }
            reference = trimmed
        } else {
            reference = "HEAD"
        }
        let revision = try await runChecked([
                "rev-parse", "--verify", "--end-of-options", "\(reference)^{commit}",
        ])
        guard Self.isSafeRevisionReference(revision) else {
            throw WorktreeManagerError.invalidBaseRevision
        }
        return revision
    }

    private static func isSafeRevisionReference(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 256,
              !value.hasPrefix("-"), !value.contains(where: { $0.isWhitespace })
        else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            scalar.value >= 0x21 && scalar.value != 0x7F
                && !" ~^:?*[]\\".unicodeScalars.contains(scalar)
        }
    }

    private func validateOwned(_ worktree: ManagedWorktree) async throws -> ManagedWorktree {
        guard let current = ownedMetadata(matching: worktree) else {
            throw WorktreeManagerError.worktreeNotOwned
        }
        guard current.lifecycle != .removed else {
            throw WorktreeManagerError.worktreeNotOwned
        }
        let root = Self.canonicalURL(workspaceRootURL)
        let worktreesRoot = root.appendingPathComponent(".juno/worktrees", isDirectory: true)
        try validateOwnedMetadata(current, root: root, worktreesRoot: worktreesRoot)
        let registered = try await listRegisteredWorktrees()
        guard let entry = registered.first(where: {
            Self.canonicalPath(URL(fileURLWithPath: $0.rootPath)) == Self.canonicalPath(current.rootURL)
        }) else {
            try mark(current, as: .recoveryRequired)
            throw WorktreeManagerError.blocked(.worktreeNotRegistered)
        }
        guard entry.branch == current.branch else {
            try mark(current, as: .recoveryRequired)
            throw WorktreeManagerError.blocked(.metadataInvalid)
        }
        return current
    }

    private func validateOwnedMetadata(
        _ worktree: ManagedWorktree,
        root: URL,
        worktreesRoot: URL
    ) throws {
        guard worktree.owner == .juno,
              Self.isAbsolutePath(worktree.rootPath),
              Self.isContained(worktree.rootURL, in: root),
              Self.isContained(worktree.rootURL, in: worktreesRoot),
              Self.isSafeBranchName(worktree.branch),
              Self.isSafeRevisionReference(worktree.baseRevision)
        else { throw WorktreeManagerError.pathEscapesWorkspace }
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: worktree.rootPath, isDirectory: &isDirectory),
              isDirectory.boolValue
        else { throw WorktreeManagerError.worktreeMissing }
    }

    private func ownedMetadata(matching worktree: ManagedWorktree) -> ManagedWorktree? {
        lock.withLock {
            guard let current = managed[worktree.id],
                  current.owner == worktree.owner,
                  current.rootPath == worktree.rootPath,
                  current.branch == worktree.branch,
                  current.baseRevision == worktree.baseRevision
            else { return nil }
            return current
        }
    }

    private func mark(_ worktree: ManagedWorktree, as next: WorktreeLifecycleState) throws {
        guard let current = ownedMetadata(matching: worktree) else {
            throw WorktreeManagerError.worktreeNotOwned
        }
        let updated = try current.transitioning(to: next)
        lock.withLock { managed[worktree.id] = updated }
        do {
            try persistMetadata()
        } catch {
            throw WorktreeManagerError.metadataPersistenceFailed(
                message: "Could not persist worktree state: \(error.localizedDescription)"
            )
        }
    }

    // MARK: - Git and persistence

    private func listRegisteredWorktrees() async throws -> [RegisteredWorktree] {
        let output = try await runChecked(["worktree", "list", "--porcelain"])
        var result: [RegisteredWorktree] = []
        var path: String?
        var head = ""
        var branch: String?
        func appendCurrent() {
            guard let path else { return }
            result.append(RegisteredWorktree(rootPath: path, headRevision: head, branch: branch))
        }
        for line in output.split(separator: "\n", omittingEmptySubsequences: false) {
            let text = String(line)
            if text.isEmpty {
                appendCurrent()
                path = nil
                head = ""
                branch = nil
            } else if text.hasPrefix("worktree ") {
                path = String(text.dropFirst("worktree ".count))
            } else if text.hasPrefix("HEAD ") {
                head = String(text.dropFirst("HEAD ".count))
            } else if text.hasPrefix("branch refs/heads/") {
                branch = String(text.dropFirst("branch refs/heads/".count))
            }
        }
        appendCurrent()
        return result
    }

    private func removeCreatedWorktree(
        at destination: URL,
        root: URL,
        expectedBranch: String
    ) async throws {
        guard Self.isContained(destination, in: root),
              Self.isContained(destination, in: root.appendingPathComponent(".juno/worktrees", isDirectory: true))
        else { throw WorktreeManagerError.pathEscapesWorkspace }
        let registered = try await listRegisteredWorktrees()
        guard let entry = registered.first(where: {
            Self.canonicalPath(URL(fileURLWithPath: $0.rootPath)) == Self.canonicalPath(destination)
        }), entry.branch == expectedBranch else {
            // A path that is not registered as the worktree just created is
            // never deleted, even during rollback.
            return
        }
        _ = try await runChecked(["worktree", "remove", "--force", Self.canonicalPath(destination)])
    }

    private func runChecked(_ arguments: [String]) async throws -> String {
        try await runCheckedAt(workspaceRootURL.path, arguments)
    }

    private func runCheckedAt(
        _ rootPath: String,
        _ arguments: [String],
        outputLimit: OutputLimit = OutputLimit(maximumBytes: 256 * 1_024
        )
    ) async throws -> String {
        let line = (["git", "-C", rootPath] + arguments).map(Self.shellQuote).joined(separator: " ")
        let result: (result: CommandResult, stdout: String, stderr: String)
        do {
            result = try await executor.run(line, timeoutSeconds: 60, outputLimit: outputLimit)
        } catch {
            throw WorktreeManagerError.commandFailed(message: String(describing: error))
        }
        guard result.result.succeeded else {
            let detail = (result.stderr.isEmpty ? result.stdout : result.stderr)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw WorktreeManagerError.commandFailed(
                message: detail.isEmpty ? "Git command failed." : detail
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
        return (
            result.result.exitCode,
            (result.stderr.isEmpty ? result.stdout : result.stderr)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    private func normalized(_ error: Error) -> Error {
        if let error = error as? WorktreeManagerError { return error }
        return WorktreeManagerError.commandFailed(message: error.localizedDescription)
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
        try encoder.encode(snapshot).write(to: metadataURL, options: [.atomic])
    }

    private static func loadMetadata(
        from metadataURL: URL,
        workspaceRootURL: URL,
        fileManager: FileManager
    ) -> [String: ManagedWorktree] {
        guard let data = try? Data(contentsOf: metadataURL),
              let entries = try? JSONDecoder.iso8601.decode([ManagedWorktree].self, from: data)
        else { return [:] }
        let root = canonicalURL(workspaceRootURL)
        let worktreesRoot = root.appendingPathComponent(".juno/worktrees", isDirectory: true)
        var result: [String: ManagedWorktree] = [:]
        for entry in entries {
            guard result[entry.id] == nil,
                  entry.owner == .juno,
                  isAbsolutePath(entry.rootPath),
                  isContained(entry.rootURL, in: root),
                  isContained(entry.rootURL, in: worktreesRoot),
                  isSafeBranchName(entry.branch),
                  isSafeRevisionReference(entry.baseRevision)
            else { continue }
            result[entry.id] = entry
        }
        return result
    }

    private static func canonicalURL(_ url: URL) -> URL {
        // Foundation only resolves symlinks for the portion of a path that
        // exists. A candidate such as `root/link/new-file` can therefore look
        // contained when `link` points outside `root` but `new-file` has not
        // been created yet. Resolve the longest existing prefix first, then
        // append the non-existent suffix so containment checks cover both
        // existing checkouts and paths about to be created.
        let standardized = url.standardizedFileURL
        var existingPrefix = standardized
        var missingComponents: [String] = []
        let fileManager = FileManager.default

        while !fileManager.fileExists(atPath: existingPrefix.path),
              existingPrefix.path != "/" {
            missingComponents.insert(existingPrefix.lastPathComponent, at: 0)
            existingPrefix.deleteLastPathComponent()
        }

        let resolvedPrefix = existingPrefix
            .resolvingSymlinksInPath()
            .standardizedFileURL
        return missingComponents.reduce(resolvedPrefix) {
            $0.appendingPathComponent($1, isDirectory: false)
        }.standardizedFileURL
    }

    private static func canonicalPath(_ url: URL) -> String {
        canonicalURL(url).path
    }

    private static func isAbsolutePath(_ path: String) -> Bool {
        path.hasPrefix("/") && !path.contains("\0")
    }

    private func validateOwnedPath(_ path: URL, root: URL) throws {
        guard Self.isAbsolutePath(path.path), Self.isContained(path, in: root) else {
            throw WorktreeManagerError.pathEscapesWorkspace
        }
    }

    private static func shellQuote(_ argument: String) -> String {
        if argument.range(of: "^[A-Za-z0-9_./:=@%+-]+$", options: .regularExpression) != nil {
            return argument
        }
        return "'" + argument.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

private extension JSONDecoder {
    static var iso8601: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
