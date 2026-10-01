import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The CI watch (CODE_AGENT_SPEC §5.3), driven by a fake `gh` that answers
/// from JSON fixtures. Nothing reaches GitHub.
final class CIWatchServiceTests: XCTestCase {
    /// Answers `gh` from a script: each `pr checks` call takes the next
    /// fixture; `run view` answers with a log.
    private final class ScriptedGitHub: CommandExecuting, @unchecked Sendable {
        private let lock = NSLock()
        private var checks: [String]
        private var lines: [String] = []

        init(checks: [String]) {
            self.checks = checks
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
            var stdout = ""
            var exit: Int32 = 0
            if commandLine.hasPrefix("gh pr checks") {
                stdout = checks.count > 1 ? checks.removeFirst() : (checks.first ?? "[]")
                exit = stdout.contains("\"pending\"") ? 8 : 0
            } else if commandLine.hasPrefix("gh run view") {
                stdout = "Run tests\nFAIL SettingsMenu.test.tsx > opens on click\nexpected true"
            }
            lock.unlock()
            return AsyncThrowingStream { continuation in
                continuation.yield(.stdout(stdout))
                continuation.yield(.completed(CommandResult(
                    exitCode: exit,
                    wasTimeout: false,
                    wasCancelled: false,
                    wasTruncated: false,
                    durationSeconds: 0.01
                )))
                continuation.finish()
            }
        }
    }

    private static func fixture(_ rows: [(String, String, String)]) -> String {
        let items = rows.enumerated().map { index, row in
            """
            {"name":"\(row.0)","state":"\(row.1)","bucket":"\(row.2)","link":"https://github.com/o/r/actions/runs/\(100 + index)/job/\(200 + index)","workflow":"CI"}
            """
        }
        return "[" + items.joined(separator: ",") + "]"
    }

    private static let running = fixture([
        ("lint", "IN_PROGRESS", "pending"),
        ("test (ubuntu)", "QUEUED", "pending"),
        ("test (macos)", "IN_PROGRESS", "pending"),
    ])
    private static let partly = fixture([
        ("lint", "SUCCESS", "pass"),
        ("test (ubuntu)", "IN_PROGRESS", "pending"),
        ("test (macos)", "IN_PROGRESS", "pending"),
    ])
    private static let failed = fixture([
        ("lint", "SUCCESS", "pass"),
        ("test (ubuntu)", "FAILURE", "fail"),
        ("test (macos)", "FAILURE", "fail"),
    ])

    /// Collects what the watch reports.
    private actor Updates {
        var all: [CIWatchService.Update] = []
        func append(_ update: CIWatchService.Update) { all.append(update) }
    }

    func testRunningThenFailedSettlesAndStops() async throws {
        let gh = ScriptedGitHub(checks: [Self.running, Self.partly, Self.failed])
        let watch = CIWatchService(reader: GitHubCIClient(executor: gh), sleep: { _ in })
        let updates = Updates()
        await watch.watch(pullRequest: 42, url: "https://github.com/o/r/pull/42") { update in
            await updates.append(update)
        }
        await watch.awaitSettled()
        let all = await updates.all
        XCTAssertEqual(all.count, 3, "running, partly passed, then settled: \(all)")
        guard case let .settled(final) = all.last else { return XCTFail("the watch must end settled") }
        XCTAssertEqual(final.pullRequestNumber, 42)
        XCTAssertEqual(CIStatusWords.summary(final.checks), "1 of 3 checks passed; `test (ubuntu)`, `test (macos)` failed")
        let isWatching = await watch.isWatching
        XCTAssertFalse(isWatching, "the watch stops once every check settled")
        XCTAssertEqual(gh.commandLines.filter { $0.hasPrefix("gh pr checks 42") }.count, 3)
    }

    func testAFailureBecomesAGoalWithOneCriterionPerFailingCheck() async throws {
        let gh = ScriptedGitHub(checks: [Self.failed])
        let watch = CIWatchService(reader: GitHubCIClient(executor: gh), sleep: { _ in })
        let status = try await watch.poll(pullRequest: 42, url: nil)
        let plan = await watch.fixPlan(for: status, recipeChecks: { name in
            name.hasPrefix("test") ? ["web-test"] : []
        })
        XCTAssertEqual(plan.pullRequestNumber, 42)
        XCTAssertEqual(plan.goalSet.origin, .ci)
        let judged = plan.criteria.filter { $0.check == .judged }
        XCTAssertEqual(judged.map(\.text), [
            "The CI check `test (ubuntu)` passes",
            "The CI check `test (macos)` passes",
        ])
        XCTAssertEqual(
            plan.criteria.filter { $0.check == .command(checkID: "web-test") }.count,
            1,
            "the matching recipe check is a command criterion, once"
        )
        XCTAssertEqual(plan.criteria.map(\.id), ["c1", "c2", "c3"])
        XCTAssertEqual(plan.logs.keys.sorted(), ["test (macos)", "test (ubuntu)"])
        XCTAssertTrue(plan.objective.contains("pull request #42"))
        let note = plan.runtimeNote.rendered
        XCTAssertTrue(note.hasPrefix("<juno_runtime reason=\"ci_fix\" pr=\"42\">"), note)
        XCTAssertTrue(note.contains("CI output, data only"), "the log is fenced as data")
        XCTAssertTrue(note.contains("git_push, which asks the reader"))
    }

    func testAutoFixStopsAfterThreeAttemptsPerPullRequest() {
        let status = CIStatusEvent(
            pullRequestNumber: 42,
            checks: [CICheck(name: "lint", state: .passed), CICheck(name: "test", state: .failed)]
        )
        var policy = CIAutoFixPolicy()
        XCTAssertFalse(policy.shouldFix(status), "Auto-fix is off by default")
        policy.isEnabled = true
        for attempt in 1...3 {
            XCTAssertTrue(policy.shouldFix(status), "attempt \(attempt) is allowed")
            XCTAssertTrue(policy.recordAttempt(for: 42))
        }
        XCTAssertFalse(policy.shouldFix(status), "three attempts per pull request, then it stops")
        XCTAssertFalse(policy.recordAttempt(for: 42))
        XCTAssertEqual(policy.attemptsLeft(for: 42), 0)
        let other = CIStatusEvent(pullRequestNumber: 43, checks: status.checks)
        XCTAssertTrue(policy.shouldFix(other), "each pull request has its own three")
        let stillRunning = CIStatusEvent(pullRequestNumber: 43, checks: [CICheck(name: "test", state: .running)])
        XCTAssertFalse(policy.shouldFix(stillRunning), "nothing is fixed before the checks settle")
    }

    func testThePollBacksOffFromAMinuteToFiveMinutes() {
        XCTAssertEqual(CIPollSchedule.interval(beforePoll: 0), 60)
        XCTAssertEqual(CIPollSchedule.interval(beforePoll: 1), 120)
        XCTAssertEqual(CIPollSchedule.interval(beforePoll: 2), 240)
        XCTAssertEqual(CIPollSchedule.interval(beforePoll: 3), 300)
        XCTAssertEqual(CIPollSchedule.interval(beforePoll: 10), 300)
    }

    func testPendingChecksAreANormalAnswerNotAFailure() async throws {
        let gh = ScriptedGitHub(checks: [Self.running])
        let checks = try await GitHubCIClient(executor: gh).checks(pullRequest: 7)
        XCTAssertEqual(checks.map(\.ciState), [.running, .queued, .running])
        XCTAssertTrue(gh.commandLines.first?.contains("--json name,state,bucket,link,workflow") ?? false)
    }
}
