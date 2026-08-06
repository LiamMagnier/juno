import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class WorktreeManagerTests: XCTestCase {
    func testBranchValidationAndDestinationNamingAreDeterministic() {
        XCTAssertTrue(WorktreeManager.isSafeBranchName("feature/preview"))
        XCTAssertTrue(WorktreeManager.isSafeBranchName("juno-fix_42"))
        XCTAssertFalse(WorktreeManager.isSafeBranchName("feature name"))
        XCTAssertFalse(WorktreeManager.isSafeBranchName("feature..name"))
        XCTAssertFalse(WorktreeManager.isSafeBranchName("-force"))
        XCTAssertFalse(WorktreeManager.isSafeBranchName("feature;touch /tmp/pwned"))
        XCTAssertFalse(WorktreeManager.isSafeBranchName("feature/.hidden"))

        XCTAssertEqual(
            WorktreeManager.worktreeDirectoryName(branch: "feature/preview", id: "12345678-rest"),
            "feature-preview-12345678"
        )
    }

    func testContainmentUsesCanonicalPathBoundaries() throws {
        let root = try temporaryDirectory(named: "containment")
        defer { try? FileManager.default.removeItem(at: root) }
        let child = root.appendingPathComponent("child")
        let sibling = root.deletingLastPathComponent()
            .appendingPathComponent(root.lastPathComponent + "-other")
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)

        XCTAssertTrue(WorktreeManager.isContained(child, in: root))
        XCTAssertFalse(WorktreeManager.isContained(sibling, in: root))

        let outside = root.deletingLastPathComponent().appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outside) }
        let symlink = root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: outside)
        XCTAssertFalse(WorktreeManager.isContained(symlink.appendingPathComponent("file"), in: root))
    }

    func testCreateFromExplicitRevisionLeavesDirtySourceUntouched() async throws {
        let root = try temporaryDirectory(named: "create")
        defer { try? FileManager.default.removeItem(at: root) }
        let marker = root.appendingPathComponent("user-change.txt")
        try Data("keep me".utf8).write(to: marker)

        let executor = StubCommandExecutor()
        let manager = WorktreeManager(executor: executor, workspaceRootURL: root)
        let worktree = try await manager.create(branch: "feature/preview", from: "deadbeef")

        XCTAssertEqual(worktree.baseRevision, "deadbeef")
        XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), "keep me")
        XCTAssertEqual(worktree.owner, .juno)
        XCTAssertEqual(worktree.lifecycle, .active)
        XCTAssertTrue(executor.commands.contains { $0.contains("deadbeef") })
        XCTAssertTrue(executor.commands.contains { $0.contains("worktree list --porcelain") })
    }

    func testCleanupRefusesDirtyWorktreeAndSecondCleanupIsIdempotent() async throws {
        let root = try temporaryDirectory(named: "cleanup")
        defer { try? FileManager.default.removeItem(at: root) }
        let executor = StubCommandExecutor()
        let manager = WorktreeManager(executor: executor, workspaceRootURL: root)
        let worktree = try await manager.create(branch: "feature/cleanup", from: "deadbeef")
        executor.worktreeIsDirty = true

        do {
            try await manager.remove(worktree)
            XCTFail("Dirty cleanup should be blocked")
        } catch let error as WorktreeManagerError {
            XCTAssertEqual(error, .blocked(.worktreeHasChanges))
        }
        XCTAssertEqual(manager.worktrees.first?.lifecycle, .blocked)
        XCTAssertFalse(executor.commands.contains { $0.contains("worktree remove") })

        executor.worktreeIsDirty = false
        try await manager.remove(worktree)
        XCTAssertTrue(manager.worktrees.isEmpty)
        try await manager.remove(worktree)
        XCTAssertTrue(manager.worktrees.isEmpty)
    }

    private func temporaryDirectory(named name: String) throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("juno-worktree-\(name)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}

private final class StubCommandExecutor: CommandExecuting, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var commands: [String] = []
    var worktreeIsDirty = false
    private var registeredPath: String?
    private var registeredBranch: String?

    func stream(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit
    ) -> AsyncThrowingStream<CommandEvent, Error> {
        lock.withLock { commands.append(commandLine) }
        let tokens = commandLine.split(separator: " ").map(String.init)
        var output = ""
        if commandLine.contains("rev-parse --is-inside-work-tree") {
            output = "true\n"
        } else if commandLine.contains("rev-parse --verify") {
            output = "deadbeef\n"
        } else if commandLine.contains("worktree add") {
            guard let branchIndex = tokens.firstIndex(of: "-b"),
                  branchIndex + 2 < tokens.count
            else { return completed(output: "") }
            registeredBranch = tokens[branchIndex + 1]
            registeredPath = tokens[branchIndex + 2]
            try? FileManager.default.createDirectory(
                atPath: registeredPath!,
                withIntermediateDirectories: true
            )
        } else if commandLine.contains("worktree list") {
            if let registeredPath, let registeredBranch {
                output = "worktree \(registeredPath)\nHEAD deadbeef\nbranch refs/heads/\(registeredBranch)\n"
            }
        } else if commandLine.contains("status --porcelain") {
            output = worktreeIsDirty ? " M user-change.txt\n" : ""
        } else if commandLine.contains("worktree remove") {
            if let path = tokens.last {
                try? FileManager.default.removeItem(atPath: path)
            }
            registeredPath = nil
            registeredBranch = nil
        }
        return completed(output: output)
    }

    private func completed(output: String) -> AsyncThrowingStream<CommandEvent, Error> {
        AsyncThrowingStream { continuation in
            if !output.isEmpty { continuation.yield(.stdout(output)) }
            continuation.yield(.completed(CommandResult(
                exitCode: 0,
                wasTimeout: false,
                wasCancelled: false,
                wasTruncated: false,
                durationSeconds: 0
            )))
            continuation.finish()
        }
    }
}
