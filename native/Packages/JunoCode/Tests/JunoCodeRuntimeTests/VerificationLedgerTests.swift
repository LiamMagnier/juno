import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// A command executor that answers from a script: each command's exit code
/// and output, and a note of what ran where.
final class ScriptedCommandExecutor: DirectoryScopedCommandExecuting, @unchecked Sendable {
    struct Answer: Sendable {
        var exitCode: Int32 = 0
        var output = ""
        var seconds = 0.5
        var timedOut = false
    }

    private let lock = NSLock()
    private var answers: [String: [Answer]]
    private var ran: [(command: String, directory: String?)] = []
    /// Called with each command before it answers, so a test can change files
    /// "during" a command.
    var onRun: (@Sendable (String) -> Void)?

    init(_ answers: [String: Answer] = [:]) {
        self.answers = answers.mapValues { [$0] }
    }

    init(sequences: [String: [Answer]]) {
        self.answers = sequences
    }

    var commands: [String] { lock.withLock { ran.map(\.command) } }
    var directories: [String?] { lock.withLock { ran.map(\.directory) } }

    func stream(_ commandLine: String, timeoutSeconds: Double, outputLimit: OutputLimit) -> AsyncThrowingStream<CommandEvent, Error> {
        stream(commandLine, timeoutSeconds: timeoutSeconds, outputLimit: outputLimit, workingDirectory: nil)
    }

    func stream(
        _ commandLine: String,
        timeoutSeconds _: Double,
        outputLimit _: OutputLimit,
        workingDirectory: WorkspacePath?
    ) -> AsyncThrowingStream<CommandEvent, Error> {
        let answer: Answer = lock.withLock {
            ran.append((commandLine, workingDirectory?.value))
            guard var queue = answers[commandLine], !queue.isEmpty else { return Answer() }
            let next = queue.removeFirst()
            answers[commandLine] = queue.isEmpty ? [next] : queue
            return next
        }
        onRun?(commandLine)
        return AsyncThrowingStream { continuation in
            if !answer.output.isEmpty { continuation.yield(.stdout(answer.output)) }
            continuation.yield(.completed(CommandResult(
                exitCode: answer.exitCode,
                wasTimeout: answer.timedOut,
                wasCancelled: false,
                wasTruncated: false,
                durationSeconds: answer.seconds
            )))
            continuation.finish()
        }
    }

    func validateWorkingDirectory(_: WorkspacePath) throws {}
}

/// A recipe source with a fixed answer.
struct FixedRecipes: VerifyRecipeProviding {
    var status: VerifyRecipeStatus

    func status() async -> VerifyRecipeStatus { status }

    func acceptedRecipe() -> VerifyRecipe? {
        if case let .accepted(recipe) = status { return recipe }
        return nil
    }
}

/// The ledger is a fold over the transcript (CODE_AGENT_SPEC §1.2, §1.8).
final class VerificationLedgerTests: XCTestCase {
    private var base: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!
    private var ledgers: VerificationLedgers!

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-ledger-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Ledger",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
        ledgers = VerificationLedgers()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
    }

    private func append(_ payload: SessionEventPayload) async throws {
        try await store.appendEvent(sessionID: session.id, payload: payload)
    }

    private func fileChanged(_ path: String, lines: Int = 2) throws -> SessionEventPayload {
        .fileChanged(FileChangedEvent(path: try WorkspacePath(path), kind: .modified, linesAdded: lines, linesRemoved: 0, checkpointID: nil))
    }

    private func check(_ command: String, passed: Bool, at revision: Int, id: String = UUID().uuidString) -> VerificationRecord {
        VerificationRecord(id: id, command: command, kind: .test, exitCode: passed ? 0 : 1, passed: passed, workspaceRevision: revision, durationMs: 100)
    }

    // MARK: - Freshness

    func testEveryFileChangeBumpsTheRevisionAndAPassBeforeTheLastEditDoesNotCount() async throws {
        let ledger = await ledgers.ledger(for: session.id, store: store)
        try await append(.userPrompt(UserPromptEvent(text: "fix it")))
        try await append(try fileChanged("src/a.ts"))
        XCTAssertEqual(ledger.workspaceRevision, 1, "the store tells the ledger as it appends")
        await ledger.recordVerification(check("npm test", passed: true, at: 1))
        XCTAssertEqual(ledger.freshVerifications.count, 1)
        XCTAssertEqual(ledger.latestFreshVerification?.passed, true)

        try await append(try fileChanged("src/b.ts"))
        XCTAssertEqual(ledger.workspaceRevision, 2)
        XCTAssertTrue(ledger.freshVerifications.isEmpty, "a pass from before the last edit does not satisfy")
        XCTAssertEqual(ledger.verifications.count, 1, "but it is still on record")
        XCTAssertEqual(ledger.filesChangedThisRun, ["src/a.ts", "src/b.ts"])
    }

    func testRecordsAreIdempotentOnTheirId() async throws {
        let ledger = await ledgers.ledger(for: session.id, store: store)
        let record = check("npm test", passed: true, at: 0, id: "same")
        await ledger.recordVerification(record)
        await ledger.recordVerification(record)
        XCTAssertEqual(ledger.verifications.count, 1)
        let recorded = await store.events(for: session.id).filter {
            if case .verificationRecorded = $0.payload { return true } else { return false }
        }
        XCTAssertEqual(recorded.count, 1)
    }

    func testAGitDiffCallMarksTheDiffReadAtItsRevision() async throws {
        let ledger = await ledgers.ledger(for: session.id, store: store)
        try await append(try fileChanged("a.swift"))
        XCTAssertFalse(ledger.diffReadIsFresh)
        try await append(.toolProposed(ToolProposedEvent(toolCallID: "c1", toolName: "git_diff", input: [:], risk: .read, summary: "Git diff")))
        try await append(.toolCompleted(ToolCompletedEvent(toolCallID: "c1", status: .succeeded, resultSummary: "diff", durationSeconds: 0.1)))
        XCTAssertEqual(ledger.lastDiffReadRevision, 1)
        XCTAssertTrue(ledger.diffReadIsFresh)
        try await append(try fileChanged("a.swift"))
        XCTAssertFalse(ledger.diffReadIsFresh, "an edit after the read makes it stale")
        // A failed diff reads nothing.
        try await append(.toolProposed(ToolProposedEvent(toolCallID: "c2", toolName: "git_diff", input: [:], risk: .read, summary: "Git diff")))
        try await append(.toolCompleted(ToolCompletedEvent(toolCallID: "c2", status: .failed, resultSummary: "x", durationSeconds: 0.1)))
        XCTAssertFalse(ledger.diffReadIsFresh)
    }

    func testAReadersMessageStartsANewRun() async throws {
        let ledger = await ledgers.ledger(for: session.id, store: store)
        try await append(.userPrompt(UserPromptEvent(text: "one")))
        try await append(try fileChanged("a.swift"))
        await ledger.recordReview(ReviewRecord(round: 1, findings: [], overall: .correct, workspaceRevision: 1))
        XCTAssertEqual(ledger.reviewRoundsThisRun, 1)
        XCTAssertEqual(ledger.lastDiffReadRevision, 1, "a review pass read the diff")
        try await append(.userPrompt(UserPromptEvent(text: "two")))
        XCTAssertEqual(ledger.reviewRoundsThisRun, 0)
        XCTAssertEqual(ledger.filesChangedThisRun, [])
        XCTAssertNil(ledger.snapshotThisRun.review)
        XCTAssertNotNil(ledger.snapshot.review)
        XCTAssertEqual(ledger.workspaceRevision, 1, "the revision runs on across runs")
    }

    func testAReopenedSessionKnowsExactlyWhatItKnewBefore() async throws {
        let ledger = await ledgers.ledger(for: session.id, store: store)
        try await append(.userPrompt(UserPromptEvent(text: "fix")))
        try await append(try fileChanged("a.swift"))
        await ledger.recordVerification(check("swift test", passed: true, at: 1))
        await ledger.recordUIVerification(UIVerificationRecord(surface: .web, target: "/", checks: [], passed: true, workspaceRevision: 1))
        let before = ledger.snapshot

        // A relaunch: a new store over the same folder.
        let reopened = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        let restored = await VerificationLedger.open(sessionID: session.id, store: reopened)
        // The same evidence at the same revisions (dates come back at the
        // transcript's second precision).
        XCTAssertEqual(restored.workspaceRevision, before.workspaceRevision)
        XCTAssertEqual(restored.verifications.map(\.id), before.verifications.map(\.id))
        XCTAssertEqual(restored.verifications.map(\.workspaceRevision), before.verifications.map(\.workspaceRevision))
        XCTAssertEqual(restored.uiVerifications.map(\.id), before.uiVerifications.map(\.id))
        XCTAssertEqual(restored.filesChangedThisRun, ["a.swift"])
        XCTAssertEqual(restored.freshVerifications.count, 1)
        await restored.close()
    }

    func testARewindMakesEarlierEvidenceStale() async throws {
        let ledger = await ledgers.ledger(for: session.id, store: store)
        try await append(try fileChanged("a.swift"))
        await ledger.recordVerification(check("swift test", passed: true, at: 1))
        XCTAssertEqual(ledger.freshVerifications.count, 1)
        try await append(.transcriptRewound(TranscriptRewoundEvent(turnID: "t1")))
        XCTAssertTrue(ledger.freshVerifications.isEmpty)
    }

    func testUIEvidenceFromAPreviewWriterIsReadByTheGateSeam() async throws {
        let ledger = await ledgers.ledger(for: session.id, store: store)
        let writer: any VerificationLedgerWriting = ledger
        try await append(try fileChanged("app/page.tsx"))
        await writer.recordUIVerification(UIVerificationRecord(
            surface: .web, target: "/settings", viewport: "desktop",
            checks: [UICheckResult(name: "no new console errors", passed: true)],
            passed: true, screenshotHash: "abc", workspaceRevision: ledger.workspaceRevision
        ))
        let reading: any VerificationLedgerReading = ledger
        XCTAssertEqual(reading.freshUIVerifications(surface: .web, target: "/settings").count, 1)
        XCTAssertTrue(reading.freshUIVerifications(surface: .ios).isEmpty)
    }

    // MARK: - Evidence from run_command and run_tests

    private func recipe() -> VerifyRecipe {
        VerifyRecipe(checks: [
            VerifyCheck(id: "web-test", kind: .test, run: .shell("npm test"), targeted: "npx vitest run {tests}", paths: ["src/**"]),
        ])
    }

    private func context() -> ToolContext {
        ToolContext(sessionID: session.id, toolCallID: "call", emitOutput: { _, _ in })
    }

    private func records(in result: ToolResult) -> [VerificationRecord] {
        result.sideEffects.compactMap {
            if case let .verificationRecorded(record) = $0 { return record }
            return nil
        }
    }

    func testRunCommandRecordsAnExactRecipeCheckWithItsId() async throws {
        let ledger = await ledgers.ledger(for: session.id, store: store)
        try await append(try fileChanged("src/a.ts"))
        let tool = RunCommandTool(
            executor: ScriptedCommandExecutor(["npx vitest run src/a.test.ts": .init(exitCode: 1, output: "Tests:       2 failed, 36 passed, 38 total\n")]),
            evidence: CheckEvidenceRecorder(recipes: FixedRecipes(status: .accepted(recipe())), ledgers: ledgers)
        )
        let result = try await tool.execute(input: ["command": "npx vitest run src/a.test.ts"], context: context())
        let record = try XCTUnwrap(records(in: result).first)
        XCTAssertEqual(record.checkID, "web-test")
        XCTAssertEqual(record.kind, .test)
        XCTAssertFalse(record.passed)
        XCTAssertTrue(record.excerpt.hasPrefix("2 of 38 tests failed"), record.excerpt)
        XCTAssertEqual(record.workspaceRevision, ledger.workspaceRevision)
        XCTAssertTrue(result.content.contains("Juno recorded this as a test check that failed"))
    }

    func testRunCommandRecordsAClassifierGradedCheckAndNothingElse() async throws {
        _ = await ledgers.ledger(for: session.id, store: store)
        let evidence = CheckEvidenceRecorder(recipes: FixedRecipes(status: .discovered(VerifyRecipe(checks: []))), ledgers: ledgers)
        let tool = RunCommandTool(executor: ScriptedCommandExecutor(), evidence: evidence)
        let graded = try await tool.execute(input: ["command": "cd web && pnpm run typecheck"], context: context())
        XCTAssertEqual(records(in: graded).first?.kind, .typecheck)
        XCTAssertNil(records(in: graded).first?.checkID)
        XCTAssertEqual(records(in: graded).first?.passed, true)
        for other in ["ls -la", "npm test | tail -5", "echo npm test", "npm install"] {
            let result = try await tool.execute(input: ["command": .string(other)], context: context())
            XCTAssertTrue(records(in: result).isEmpty, "\(other) is not evidence")
        }
    }

    func testACheckIsStampedWithTheRevisionAfterItsOwnChanges() async throws {
        let workspace = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        let ledger = await ledgers.ledger(for: session.id, store: store)
        let executor = ScriptedCommandExecutor()
        executor.onRun = { _ in
            try? "fixed".write(to: workspace.appendingPathComponent("formatted.ts"), atomically: true, encoding: .utf8)
        }
        let tool = RunCommandTool(
            executor: executor,
            changes: WorkspaceChangeDetector(rootURL: workspace),
            evidence: CheckEvidenceRecorder(recipes: nil, ledgers: ledgers)
        )
        let result = try await tool.execute(input: ["command": "npx eslint . --fix"], context: context())
        // Appended as the scheduler would: the change, then the record.
        for effect in result.sideEffects { try await append(effect) }
        let record = try XCTUnwrap(ledger.verifications.last)
        XCTAssertEqual(ledger.workspaceRevision, 1)
        XCTAssertEqual(record.workspaceRevision, 1)
        XCTAssertTrue(ledger.isFresh(record), "the check describes the files as it left them")
    }

    func testASessionWithoutAnOpenLedgerRecordsNothing() async throws {
        let tool = RunCommandTool(
            executor: ScriptedCommandExecutor(),
            evidence: CheckEvidenceRecorder(recipes: nil, ledgers: ledgers)
        )
        let result = try await tool.execute(input: ["command": "swift test"], context: context())
        XCTAssertTrue(records(in: result).isEmpty, "a sub-agent's session has no ledger of its own")
    }

    func testRunTestsRecordsItsResultToo() async throws {
        _ = await ledgers.ledger(for: session.id, store: store)
        let tool = RunTestsTool(
            tests: ScriptedTests(output: "Executed 12 tests, with 0 failures (0 unexpected) in 0.5 seconds\n"),
            evidence: CheckEvidenceRecorder(recipes: nil, ledgers: ledgers)
        )
        let result = try await tool.execute(input: ["command": "swift test"], context: context())
        let record = try XCTUnwrap(records(in: result).first)
        XCTAssertTrue(record.passed)
        XCTAssertEqual(record.excerpt, "12 tests passed")
    }
}

/// A test runner that prints one output and exits 0.
struct ScriptedTests: TestRunning {
    var output: String
    var exitCode: Int32 = 0

    func detectSuggestions() async -> [TestSuggestion] { [] }

    func stream(command _: String, timeoutSeconds _: Double) -> AsyncThrowingStream<CommandEvent, Error> {
        let output = output
        let exitCode = exitCode
        return AsyncThrowingStream { continuation in
            continuation.yield(.stdout(output))
            continuation.yield(.completed(CommandResult(exitCode: exitCode, wasTimeout: false, wasCancelled: false, wasTruncated: false, durationSeconds: 0.5)))
            continuation.finish()
        }
    }
}
