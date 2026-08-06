import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class WorktreeManagerTests: XCTestCase {
    func testBranchValidationRejectsShellAndGitRefHazards() {
        XCTAssertTrue(WorktreeManager.isSafeBranchName("feature/preview"))
        XCTAssertTrue(WorktreeManager.isSafeBranchName("juno-fix_42"))
        XCTAssertFalse(WorktreeManager.isSafeBranchName("feature name"))
        XCTAssertFalse(WorktreeManager.isSafeBranchName("feature..name"))
        XCTAssertFalse(WorktreeManager.isSafeBranchName("-force"))
        XCTAssertFalse(WorktreeManager.isSafeBranchName("feature;touch /tmp/pwned"))
    }

    func testCreateAndRemoveStayUnderTheGrantedWorkspace() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-worktree-manager-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let executor = StubCommandExecutor()
        let manager = WorktreeManager(executor: executor, workspaceRootURL: root)
        let worktree = try await manager.create(branch: "feature/preview")

        XCTAssertTrue(worktree.rootPath.hasPrefix(root.path + "/"))
        XCTAssertEqual(worktree.branch, "feature/preview")
        XCTAssertEqual(manager.worktrees, [worktree])
        XCTAssertTrue(executor.commands.contains { $0.contains("worktree add") })

        try await manager.remove(worktree)
        XCTAssertTrue(manager.worktrees.isEmpty)
        XCTAssertTrue(executor.commands.contains { $0.contains("worktree remove") })
    }
}

private final class StubCommandExecutor: CommandExecuting, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var commands: [String] = []

    func stream(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit
    ) -> AsyncThrowingStream<CommandEvent, Error> {
        lock.lock()
        commands.append(commandLine)
        lock.unlock()
        let output = commandLine.contains("rev-parse") ? "abc123\n" : ""
        return AsyncThrowingStream { continuation in
            if !output.isEmpty { continuation.yield(.stdout(output)) }
            continuation.yield(
                .completed(
                    CommandResult(
                        exitCode: 0,
                        wasTimeout: false,
                        wasCancelled: false,
                        wasTruncated: false,
                        durationSeconds: 0
                    )
                )
            )
            continuation.finish()
        }
    }
}
