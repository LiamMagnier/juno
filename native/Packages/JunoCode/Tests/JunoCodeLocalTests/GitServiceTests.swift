import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class GitServiceTests: XCTestCase {
    private var workspaceURL: URL!
    private var git: GitService!
    private var executor: CommandExecutionService!

    override func setUp() async throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-git-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: workspaceURL,
            withIntermediateDirectories: true
        )
        executor = CommandExecutionService(workspaceRootURL: workspaceURL)
        git = GitService(executor: executor)
        _ = try await executor.run("git init -q -b main", timeoutSeconds: 20)
        _ = try await executor.run(
            "git config user.email juno@test.local && git config user.name 'Juno Test'",
            timeoutSeconds: 20
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    func testRepositoryDetection() async throws {
        let isRepo = await git.isRepository()
        XCTAssertTrue(isRepo)

        // A sibling directory outside any repository. NSTemporaryDirectory
        // itself is never a git repo.
        let plainURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-plain-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: plainURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: plainURL) }
        let plainGit = GitService(
            executor: CommandExecutionService(workspaceRootURL: plainURL)
        )
        let plainIsRepo = await plainGit.isRepository()
        XCTAssertFalse(plainIsRepo)
    }

    func testStatusStageCommitLogFlow() async throws {
        try "v1\n".write(
            to: workspaceURL.appendingPathComponent("a.txt"),
            atomically: true,
            encoding: .utf8
        )
        var status = try await git.status()
        XCTAssertEqual(status.branch, "main")
        XCTAssertEqual(status.untrackedCount, 1)

        try await git.stage(paths: ["a.txt"])
        status = try await git.status()
        XCTAssertEqual(status.stagedCount, 1)

        let commit = try await git.commit(message: "test: add a.txt")
        XCTAssertEqual(commit.subject, "test: add a.txt")
        XCTAssertEqual(commit.author, "Juno Test")
        XCTAssertFalse(commit.shortHash.isEmpty)

        let log = try await git.log(limit: 10)
        XCTAssertEqual(log.count, 1)
        XCTAssertEqual(log.first?.hash, commit.hash)

        status = try await git.status()
        XCTAssertTrue(status.isClean)
    }

    func testDiffAndUnstage() async throws {
        try "one\n".write(
            to: workspaceURL.appendingPathComponent("d.txt"),
            atomically: true,
            encoding: .utf8
        )
        try await git.stage(paths: ["d.txt"])
        _ = try await git.commit(message: "base")

        try "one\ntwo\n".write(
            to: workspaceURL.appendingPathComponent("d.txt"),
            atomically: true,
            encoding: .utf8
        )
        let unstagedDiff = try await git.diff(staged: false, path: nil)
        XCTAssertTrue(unstagedDiff.contains("+two"))

        try await git.stage(paths: ["d.txt"])
        let stagedDiff = try await git.diff(staged: true, path: try WorkspacePath("d.txt"))
        XCTAssertTrue(stagedDiff.contains("+two"))

        try await git.unstage(paths: ["d.txt"])
        let afterUnstage = try await git.status()
        XCTAssertEqual(afterUnstage.stagedCount, 0)
        XCTAssertEqual(afterUnstage.files.count, 1)
    }

    func testCreateBranch() async throws {
        try "x\n".write(
            to: workspaceURL.appendingPathComponent("x.txt"),
            atomically: true,
            encoding: .utf8
        )
        try await git.stage(paths: ["x.txt"])
        _ = try await git.commit(message: "base")
        try await git.createBranch(named: "feature/demo")
        let status = try await git.status()
        XCTAssertEqual(status.branch, "feature/demo")
    }

    func testCommitFailuresSurface() async throws {
        do {
            _ = try await git.commit(message: "   ")
            XCTFail("expected failure")
        } catch let error as GitServiceError {
            guard case .commandFailed = error else {
                return XCTFail("unexpected \(error)")
            }
        }
        do {
            _ = try await git.commit(message: "nothing staged")
            XCTFail("expected nothingToCommit")
        } catch let error as GitServiceError {
            XCTAssertEqual(error, .nothingToCommit)
        }
    }

    func testShellQuoting() {
        XCTAssertEqual(GitService.shellQuote("simple.txt"), "simple.txt")
        XCTAssertEqual(GitService.shellQuote("with space"), "'with space'")
        XCTAssertEqual(GitService.shellQuote("it's"), "'it'\\''s'")
        XCTAssertEqual(GitService.shellQuote("$(dangerous)"), "'$(dangerous)'")
    }

    func testCommitMessageWithQuotesAndSubstitutionStaysLiteral() async throws {
        try "y\n".write(
            to: workspaceURL.appendingPathComponent("y.txt"),
            atomically: true,
            encoding: .utf8
        )
        try await git.stage(paths: ["y.txt"])
        let message = "fix: don't eval `id` or $(id)"
        let commit = try await git.commit(message: message)
        XCTAssertEqual(commit.subject, message)
    }
}
