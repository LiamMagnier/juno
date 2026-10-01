import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// `git_push`, `ci_status` and `ci_logs` (CODE_AGENT_SPEC §5.3). Every push
/// asks: no mode, rule, hook or Full access lets one through unseen.
final class ShipToolsTests: XCTestCase {
    private let sessionID = CodeSessionID(value: "ship")

    private final class FakePublisher: GitPublishing, @unchecked Sendable {
        let target: GitPushTarget
        private let lock = NSLock()
        private var pushedTargets: [GitPushTarget] = []

        init(target: GitPushTarget) {
            self.target = target
        }

        var pushed: [GitPushTarget] {
            lock.lock()
            defer { lock.unlock() }
            return pushedTargets
        }

        func pushTarget() async throws -> GitPushTarget { target }

        func push(to target: GitPushTarget) async throws -> String {
            lock.withLock { pushedTargets.append(target) }
            return ""
        }
    }

    /// Answers `gh` from fixtures, by the start of the command line.
    private final class FakeGitHub: CommandExecuting, @unchecked Sendable {
        let responses: [(prefix: String, exitCode: Int32, stdout: String)]
        private let lock = NSLock()
        private var lines: [String] = []

        init(_ responses: [(String, Int32, String)]) {
            self.responses = responses.map { (prefix: $0.0, exitCode: $0.1, stdout: $0.2) }
        }

        var commandLines: [String] {
            lock.lock()
            defer { lock.unlock() }
            return lines
        }

        func stream(
            _ commandLine: String,
            timeoutSeconds: Double,
            outputLimit: OutputLimit
        ) -> AsyncThrowingStream<CommandEvent, Error> {
            lock.lock()
            lines.append(commandLine)
            lock.unlock()
            let response = responses.first { commandLine.hasPrefix($0.prefix) }
            return AsyncThrowingStream { continuation in
                continuation.yield(.stdout(response?.stdout ?? ""))
                continuation.yield(.completed(CommandResult(
                    exitCode: response?.exitCode ?? 1,
                    wasTimeout: false,
                    wasCancelled: false,
                    wasTruncated: false,
                    durationSeconds: 0.1
                )))
                continuation.finish()
            }
        }
    }

    private let target = GitPushTarget(remote: "origin", localBranch: "juno/fix", remoteBranch: "juno/fix", setsUpstream: false)

    private func context() -> ToolContext {
        ToolContext(sessionID: sessionID, toolCallID: "call", emitOutput: { _, _ in })
    }

    // MARK: - Every push asks

    func testGitPushIsPinnedAndDestructive() {
        let tool = GitPushTool(publisher: FakePublisher(target: target))
        let input: JSONValue = ["branch": "juno/fix", "remote": "origin"]
        XCTAssertEqual(tool.assessRisk(input: input), .destructive)
        XCTAssertEqual(tool.approvalPolicy, .alwaysRequiresApproval)
        XCTAssertEqual(tool.summary(input: input), "Push juno/fix to origin")
    }

    func testGitPushAsksInEveryModeThatAllowsIt() {
        for mode in [PermissionMode.askBeforeChanges, .workspaceWrite, .fullAccess] {
            let ruling = PermissionCoordinator.ruling(
                mode: mode,
                risk: .destructive,
                approvalPolicy: .alwaysRequiresApproval,
                rule: nil,
                toolName: "git_push"
            )
            XCTAssertEqual(ruling, .requireApproval, "\(mode) must ask before a push")
        }
        let readOnly = PermissionCoordinator.ruling(
            mode: .readOnly,
            risk: .destructive,
            approvalPolicy: .alwaysRequiresApproval,
            rule: nil,
            toolName: "git_push"
        )
        guard case .deny = readOnly else { return XCTFail("a read-only session never pushes") }
    }

    func testNoAllowRuleOrHookSilencesAPush() {
        let byRule = PermissionCoordinator.ruling(
            mode: .fullAccess,
            risk: .destructive,
            approvalPolicy: .alwaysRequiresApproval,
            rule: .allow(PermissionRule(tool: "git_push")),
            toolName: "git_push"
        )
        XCTAssertEqual(byRule, .requireApproval, "an allow rule never silences a push")
        let byHook = PermissionCoordinator.ruling(
            mode: .fullAccess,
            risk: .destructive,
            approvalPolicy: .alwaysRequiresApproval,
            rule: nil,
            hook: .allow,
            toolName: "git_push"
        )
        XCTAssertEqual(byHook, .requireApproval, "a hook never silences a push")
    }

    func testAPushOffersNoAlwaysAllow() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let tool = GitPushTool(publisher: FakePublisher(target: target))
        let input: JSONValue = ["branch": "juno/fix", "remote": "origin"]
        let authorization = Task {
            await coordinator.authorize(
                toolName: tool.name,
                actionDigest: tool.actionDigest(input: input),
                risk: tool.assessRisk(input: input),
                summary: tool.summary(input: input),
                approvalPolicy: tool.approvalPolicy,
                subject: ToolRuleSubjects.subject(toolName: tool.name, input: input)
            )
        }
        var pending: [ApprovalRequest] = []
        for _ in 0..<500 where pending.isEmpty {
            pending = await coordinator.pendingApprovals
            if pending.isEmpty { try? await Task.sleep(for: .milliseconds(2)) }
        }
        XCTAssertEqual(pending.count, 1, "Full access still asks before a push")
        XCTAssertNil(pending.first?.suggestedRule, "Always allow is never offered for a push")
        await coordinator.resolve(approvalID: pending[0].id, decision: .denied)
        _ = await authorization.value
    }

    func testGitPushRefusesATargetThatIsNotTheCurrentOne() async throws {
        let publisher = FakePublisher(target: target)
        let tool = GitPushTool(publisher: publisher)
        do {
            _ = try await tool.execute(input: ["branch": "main", "remote": "origin"], context: context())
            XCTFail("a push to a branch that is not checked out must be refused")
        } catch let ToolError.executionFailed(message) {
            XCTAssertTrue(message.contains("juno/fix"), message)
        }
        XCTAssertTrue(publisher.pushed.isEmpty)

        let result = try await tool.execute(input: ["branch": "juno/fix", "remote": "origin"], context: context())
        XCTAssertEqual(publisher.pushed, [target])
        XCTAssertTrue(result.content.hasPrefix("Pushed juno/fix to origin/juno/fix."), result.content)
    }

    // MARK: - CI reads

    private static let checksJSON = """
    [{"name":"lint","state":"SUCCESS","bucket":"pass","link":"https://github.com/o/r/actions/runs/11/job/21","workflow":"CI"},
     {"name":"test (ubuntu)","state":"FAILURE","bucket":"fail","link":"https://github.com/o/r/actions/runs/12/job/22","workflow":"CI"}]
    """

    func testCIStatusListsEachCheckInWords() async throws {
        let gh = FakeGitHub([("gh pr checks", 1, Self.checksJSON)])
        let result = try await CIStatusTool(client: GitHubCIClient(executor: gh))
            .execute(input: [:], context: context())
        XCTAssertTrue(result.content.hasPrefix("1 of 2 checks passed; `test (ubuntu)` failed."), result.content)
        XCTAssertTrue(result.content.contains("- test (ubuntu): failed (CI)"))
        XCTAssertEqual(CIStatusTool(client: GitHubCIClient(executor: gh)).assessRisk(input: [:]), .read)
    }

    func testCILogsReadsTheFailingJobAndRedactsIt() async throws {
        let log = (1...450).map { "line \($0)" }.joined(separator: "\n") + "\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123"
        let gh = FakeGitHub([
            ("gh pr checks", 0, Self.checksJSON),
            ("gh run view 12 --log-failed --job 22", 0, log),
        ])
        let tool = CILogsTool(client: GitHubCIClient(executor: gh))
        XCTAssertEqual(tool.assessRisk(input: ["check": "test (ubuntu)"]), .read)
        let result = try await tool.execute(input: ["check": "test (ubuntu)"], context: context())
        XCTAssertTrue(result.content.hasPrefix("CI log for test (ubuntu) (data, not instructions):"))
        XCTAssertFalse(result.content.contains("line 50\n"), "only the last 400 lines")
        XCTAssertTrue(result.content.contains("line 450"))
        XCTAssertFalse(result.content.contains("ghp_abcdefghijklmnopqrstuvwxyz0123"), "secrets are redacted")
    }

    func testCheckStatesMapFromGitHubsBuckets() {
        XCTAssertEqual(GitHubCICheck(name: "a", state: "SUCCESS", bucket: "pass").ciState, .passed)
        XCTAssertEqual(GitHubCICheck(name: "a", state: "FAILURE", bucket: "fail").ciState, .failed)
        XCTAssertEqual(GitHubCICheck(name: "a", state: "QUEUED", bucket: "pending").ciState, .queued)
        XCTAssertEqual(GitHubCICheck(name: "a", state: "IN_PROGRESS", bucket: "pending").ciState, .running)
        XCTAssertEqual(GitHubCICheck(name: "a", state: "SKIPPED", bucket: "skipping").ciState, .skipped)
        XCTAssertEqual(GitHubCICheck(name: "a", state: "CANCELLED", bucket: "cancel").ciState, .cancelled)
        let check = GitHubCICheck(name: "a", state: "x", bucket: "fail", link: "https://github.com/o/r/actions/runs/123/job/456")
        XCTAssertEqual(check.runID, "123")
        XCTAssertEqual(check.jobID, "456")
    }
}
