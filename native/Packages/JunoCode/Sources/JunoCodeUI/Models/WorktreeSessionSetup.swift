import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

/// A session that runs in a worktree of its own: what its header says, how
/// the worktree is prepared from `.juno/worktree.json`, how its changes come
/// back, and how a fork carries its files (CODE_AGENT_SPEC §5.6, §5.7).
/// Owned by Lane E.
public struct SessionWorktreeInfo: Equatable, Sendable {
    public let rootPath: String
    public let branch: String
    /// The branch the worktree came from, when known.
    public let baseBranch: String?
    public let baseRevision: String

    /// "Working in `juno-wt/fix-settings` from `main` @ 1feb392".
    public var headline: String {
        let folder = (rootPath as NSString).lastPathComponent
        let from = baseBranch.map { " from `\($0)`" } ?? ""
        return "Working in `\(folder)` on `\(branch)`\(from) @ \(String(baseRevision.prefix(7)))"
    }
}

enum WorktreeSessionSetup {
    /// Copies the configuration's `include` files into a new worktree and
    /// runs its `setup` when the reader approved those exact bytes. Returns
    /// the setup command that still needs approval, if any.
    static func prepare(
        _ worktree: ManagedWorktree,
        in context: WorkspaceContext,
        approvals: WorktreeSetupApprovals
    ) async -> String? {
        guard let configuration = WorktreeConfiguration.load(fromWorkspace: context.access.rootURL) else {
            return nil
        }
        _ = try? context.worktrees.copyIncludes(configuration.include, into: worktree)
        guard let setup = configuration.setup else { return nil }
        let outcome = try? await context.worktrees.runSetup(setup, in: worktree, approvals: approvals)
        if case .needsApproval = outcome { return setup }
        return nil
    }

    /// Writes a forked session's files into its new worktree: the source
    /// checkout's uncommitted changes, then, when the fork is from an earlier
    /// message, every file a later turn touched as it was before that turn,
    /// then the configuration's `include` files.
    static func carryFiles(
        of source: CodeSession,
        throughTurn turnID: String?,
        events: [SessionEvent],
        from context: WorkspaceContext,
        into root: URL
    ) async throws {
        let sourceRoot = source.executionRootPath.map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? context.access.rootURL
        let status = try await context.executor.run(
            "git -C \(quote(sourceRoot.path)) status --porcelain --untracked-files=all",
            timeoutSeconds: 60
        )
        let manager = FileManager.default
        let destinationRoot = root.standardizedFileURL.path + "/"
        for entry in GitService.parsePorcelain(status.stdout) {
            // Juno's own folder holds the worktrees themselves.
            guard entry.path != ".juno", !entry.path.hasPrefix(".juno/") else { continue }
            let target = root.appendingPathComponent(entry.path).standardizedFileURL
            guard target.path.hasPrefix(destinationRoot) else { continue }
            if entry.status == "D" {
                try? manager.removeItem(at: target)
                continue
            }
            let origin = sourceRoot.appendingPathComponent(entry.path)
            var isDirectory: ObjCBool = false
            guard manager.fileExists(atPath: origin.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                continue
            }
            try manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? manager.removeItem(at: target)
            try manager.copyItem(at: origin, to: target)
        }
        if let turnID {
            let turns = ConversationRewind.turns(in: events)
            if let position = turns.firstIndex(where: { $0.id == turnID }), position + 1 < turns.count {
                try await context.turnCheckpoints.materialize(
                    sessionID: source.id,
                    beforeTurn: turns[position + 1].id,
                    into: root
                )
            }
        }
        if let configuration = WorktreeConfiguration.load(fromWorkspace: context.access.rootURL),
           let worktree = context.worktrees.worktree(rootPath: root.path)
        {
            _ = try? context.worktrees.copyIncludes(configuration.include, into: worktree)
        }
    }

    private static func quote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

public extension WorkbenchModel {
    /// The worktree a session runs in, for its header; nil when it runs in
    /// the project's own checkout.
    func worktreeInfo(for sessionID: CodeSessionID) async -> SessionWorktreeInfo? {
        guard let session = sessions.first(where: { $0.id == sessionID }),
              let rootPath = session.executionRootPath,
              let workspaceID = session.workspaceID,
              let context = await context(for: workspaceID),
              let worktree = context.worktrees.worktree(rootPath: rootPath)
        else { return nil }
        let base = try? await context.git.status().branch
        return SessionWorktreeInfo(
            rootPath: worktree.rootPath,
            branch: worktree.branch,
            baseBranch: base,
            baseRevision: worktree.baseRevision
        )
    }

    /// The steps that bring a worktree session's changes back to the branch
    /// the reader has open. Each is confirmed on its own.
    func bringBackPlan(
        for sessionID: CodeSessionID,
        method: WorktreeBringBackMethod = .merge
    ) async -> Result<[WorktreeBringBackStep], WorktreeManagerError> {
        guard let (context, worktree) = await sessionWorktree(sessionID) else {
            return .failure(.worktreeMissing)
        }
        do {
            let title = sessions.first { $0.id == sessionID }?.title ?? "a worktree session"
            return .success(try await context.worktrees.bringBackPlan(
                worktree,
                method: method,
                message: "Juno: \(title)"
            ))
        } catch let error as WorktreeManagerError {
            return .failure(error)
        } catch {
            return .failure(.commandFailed(message: error.localizedDescription))
        }
    }

    /// Performs one confirmed bring-back step.
    func performBringBack(_ step: WorktreeBringBackStep, for sessionID: CodeSessionID) async -> RunActionResult {
        guard let (context, worktree) = await sessionWorktree(sessionID) else {
            return .refused("This session has no worktree of its own.")
        }
        do {
            try await context.worktrees.perform(step, on: worktree)
            return .done
        } catch {
            return .refused((error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }

    /// Approves the worktree's setup command by its exact bytes, then runs it.
    func approveAndRunWorktreeSetup(
        _ command: String,
        for sessionID: CodeSessionID,
        approvals: WorktreeSetupApprovals = .standard
    ) async -> RunActionResult {
        guard let (context, worktree) = await sessionWorktree(sessionID) else {
            return .refused("This session has no worktree of its own.")
        }
        do {
            try approvals.approve(command, workspace: context.access.rootURL)
            switch try await context.worktrees.runSetup(command, in: worktree, approvals: approvals) {
            case let .ran(exitCode, output):
                worktreeSetupPending[sessionID] = nil
                return exitCode == 0 ? .done : .refused("Setup exited with \(exitCode): \(output.suffix(300))")
            case .needsApproval:
                return .refused("The setup command still needs approval.")
            }
        } catch {
            return .refused((error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }

    private func sessionWorktree(_ sessionID: CodeSessionID) async -> (WorkspaceContext, ManagedWorktree)? {
        guard let session = sessions.first(where: { $0.id == sessionID }),
              let rootPath = session.executionRootPath,
              let workspaceID = session.workspaceID,
              let context = await context(for: workspaceID),
              let worktree = context.worktrees.worktree(rootPath: rootPath)
        else { return nil }
        return (context, worktree)
    }
}
