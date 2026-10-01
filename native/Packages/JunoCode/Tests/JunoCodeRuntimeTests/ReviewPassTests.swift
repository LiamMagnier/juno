import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// The self-review pass (CODE_AGENT_SPEC §1.9) with a scripted reviewer: the
/// real `delegate_task`, a child orchestrator, and a model that answers from
/// a script.
final class ReviewPassTests: XCTestCase {
    private var base: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!
    private var ledgers: VerificationLedgers!

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-review-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(value: "w"), workspaceName: "w", title: "Review",
            configuration: AgentConfiguration(modelID: "test-model"), gitBranch: nil
        )
        ledgers = VerificationLedgers()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
    }

    private func delegateTool(_ model: ScriptedModelClient) -> DelegateTaskTool {
        DelegateTaskTool(
            model: model,
            registry: ToolRegistry(tools: [
                NamedStubTool(name: "read_file"), NamedStubTool(name: "grep"), NamedStubTool(name: "git_diff"),
                NamedStubTool(name: "web_fetch"),
            ]),
            store: store,
            workspaceID: WorkspaceID(value: "w"),
            workspaceName: "w",
            modelID: "parent-model",
            reasoningEffort: nil,
            parentSystemPrompt: "You are Juno Code."
        )
    }

    private func pass(_ answers: [String]) async -> (ReviewPass, ScriptedModelClient, VerificationLedger) {
        let model = ScriptedModelClient(steps: answers.map { .text($0) })
        let ledger = await ledgers.ledger(for: session.id, store: store)
        return (ReviewPass(delegate: delegateTool(model), ledger: ledger), model, ledger)
    }

    private func request() -> ReviewPass.Request {
        ReviewPass.Request(
            diff: "diff --git a/src/menu.tsx b/src/menu.tsx\n+open on pointerdown\n",
            request: "Fix the settings menu",
            criteria: [(id: "c1", text: "The menu opens on click")],
            todos: ["Fix the handler (completed)"],
            checks: [VerificationRecord(command: "npm test", kind: .test, exitCode: 0, passed: true, workspaceRevision: 1, durationMs: 10)]
        )
    }

    private let blocking = """
        {"findings": [{"priority": "P1", "confidence": 0.8, "path": "src/menu.tsx", "line": 41,
          "title": "Menu closes on the same pointerdown that opens it", "body": "The outside-click handler sees it."}],
         "overall": "incorrect", "summary": "One correctness issue."}
        """

    func testABlockingFindingSendsTheRunBackOnceAndIsRecorded() async throws {
        let (pass, model, ledger) = await pass([blocking])
        try await store.appendEvent(sessionID: session.id, payload: .userPrompt(UserPromptEvent(text: "fix")))
        let outcome = await pass.run(request(), sessionID: session.id)
        guard case let .findings(record) = outcome else { return XCTFail("expected findings, got \(outcome)") }
        XCTAssertEqual(record.round, 1)
        XCTAssertEqual(record.blockingFindings.map(\.title), ["Menu closes on the same pointerdown that opens it"])
        XCTAssertEqual(ledger.review?.id, record.id, "recorded as evidence of a review")
        XCTAssertEqual(ledger.reviewRoundsThisRun, 1)

        let note = ReviewPass.reviewFindingsContinuation(for: record)
        XCTAssertTrue(note.contains("P1 src/menu.tsx:41: Menu closes on the same pointerdown that opens it"), note)
        XCTAssertLessThan(note.count, 600)

        // The reviewer ran read-only, in a fresh context, with its own tools.
        let childRequest = try XCTUnwrap(model.receivedRequests.first)
        XCTAssertEqual(childRequest.modelID, "parent-model", "the parent's model unless the agent names another")
        XCTAssertEqual(Set(childRequest.tools.map(\.name)), ["read_file", "grep", "git_diff"], "web_fetch is not a reviewer tool")
        XCTAssertTrue(childRequest.systemPrompt.contains("You are Juno's reviewer."))
        XCTAssertTrue(childRequest.systemPrompt.contains("read-only Juno Code sub-agent"))
        let prompt = childRequest.messages.compactMap { message -> String? in
            if case let .user(text) = message { return text }
            return nil
        }.joined(separator: "\n")
        XCTAssertTrue(prompt.contains("+open on pointerdown"), "the reviewer receives the diff")
        XCTAssertTrue(prompt.contains("c1: The menu opens on click"), "and the criteria")
    }

    func testOnlyNotesFinishWithThemInTheReport() async throws {
        let notes = #"""
            Here is my review.
            ```json
            {"findings": [{"priority": "P3", "confidence": 0.9, "path": "src/menu.tsx", "line": 12, "title": "The onOpenChange prop is unused"}],
             "overall": "correct", "summary": "Correct.", "extra": "ignored"}
            ```
            """#
        let (pass, _, _) = await pass([notes])
        let outcome = await pass.run(request(), sessionID: session.id)
        guard case let .clean(record) = outcome else { return XCTFail("expected clean, got \(outcome)") }
        XCTAssertEqual(ReviewPass.notes(from: record), ["The onOpenChange prop is unused (src/menu.tsx:12) (review, P3)"])
    }

    func testALowConfidenceP1IsANoteNotAContinuation() async throws {
        let unsure = #"{"findings": [{"priority": "P1", "confidence": 0.4, "title": "Maybe a race"}], "overall": "correct"}"#
        let (pass, _, _) = await pass([unsure])
        guard case .clean = await pass.run(request(), sessionID: session.id) else { return XCTFail("expected clean") }
    }

    func testAnUnmetCriterionIsBlockingWhateverItsPriority() throws {
        let parsed = try XCTUnwrap(ReviewPass.parse(
            #"{"findings": [{"priority": "P2", "confidence": 0.7, "title": "Phone width not handled", "criterion": "c2"}], "overall": "incorrect"}"#
        ))
        let record = ReviewRecord(round: 1, findings: parsed.findings, overall: parsed.overall, workspaceRevision: 0)
        XCTAssertEqual(record.blockingFindings.count, 1)
    }

    func testAnUnreadableAnswerRecordsNoFindingsAndSaysSo() async throws {
        let (pass, _, ledger) = await pass(["Looks good to me!"])
        let outcome = await pass.run(request(), sessionID: session.id)
        guard case let .unreadable(note) = outcome else { return XCTFail("expected unreadable, got \(outcome)") }
        XCTAssertTrue(note.contains("could not be read"))
        XCTAssertNil(ledger.review, "nothing is recorded as a review")
        XCTAssertEqual(ledger.lastDiffReadRevision, ledger.workspaceRevision, "but the diff counts as read")
        for malformed in [
            #"{"findings": "none", "overall": "correct"}"#,
            #"{"findings": [], "overall": "fine"}"#,
            #"{"overall": "correct"}"#,
        ] {
            XCTAssertNil(ReviewPass.parse(malformed), malformed)
        }
    }

    func testAtMostTwoRoundsARun() async throws {
        let clean = #"{"findings": [], "overall": "correct", "summary": "Clean."}"#
        let (pass, _, _) = await pass([blocking, clean, clean])
        try await store.appendEvent(sessionID: session.id, payload: .userPrompt(UserPromptEvent(text: "fix")))
        guard case .findings = await pass.run(request(), sessionID: session.id) else { return XCTFail() }
        guard case let .clean(second) = await pass.run(request(), sessionID: session.id) else { return XCTFail() }
        XCTAssertEqual(second.round, 2)
        guard case .roundLimit = await pass.run(request(), sessionID: session.id) else { return XCTFail("a third round never runs") }
        // A new message is a new run.
        try await store.appendEvent(sessionID: session.id, payload: .userPrompt(UserPromptEvent(text: "and now this")))
        guard case .clean = await pass.run(request(), sessionID: session.id) else { return XCTFail() }
    }

    func testTheThresholdDecidesBetweenTheDiffReadAndTheReviewer() {
        XCTAssertFalse(ReviewPass.needsReviewer(trigger: .auto, changedLines: 39, changedFiles: 2))
        XCTAssertFalse(ReviewPass.needsReviewer(trigger: .auto, changedLines: 40, changedFiles: 2))
        XCTAssertTrue(ReviewPass.needsReviewer(trigger: .auto, changedLines: 41, changedFiles: 1))
        XCTAssertTrue(ReviewPass.needsReviewer(trigger: .auto, changedLines: 5, changedFiles: 3))
        XCTAssertFalse(ReviewPass.needsReviewer(trigger: .auto, changedLines: 5, changedFiles: 0), "nothing changed")
        XCTAssertTrue(ReviewPass.needsReviewer(trigger: .always, changedLines: 1, changedFiles: 1))
        XCTAssertFalse(ReviewPass.needsReviewer(trigger: .diff, changedLines: 500, changedFiles: 9))
        XCTAssertTrue(ReviewPass.needsReviewer(trigger: .diff, changedLines: 1, changedFiles: 1, goalClaimsCompletion: true))
        XCTAssertFalse(ReviewPass.needsReviewer(trigger: .off, changedLines: 500, changedFiles: 9, goalClaimsCompletion: true))
    }

    func testTheDiffReadContinuationIsImperativeAndShort() {
        XCTAssertTrue(ReviewPass.diffReadContinuation.contains("git_diff"))
        XCTAssertLessThan(ReviewPass.diffReadContinuation.count, 600)
    }
}
