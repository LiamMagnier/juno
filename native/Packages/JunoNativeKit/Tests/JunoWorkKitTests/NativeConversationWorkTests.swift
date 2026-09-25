import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import XCTest

@testable import JunoWorkKit

/// One chat's tasks (Phase 5 brief A2): which task the card follows, what the
/// composer does, and what the log says is still waiting.
@MainActor
final class NativeConversationWorkTests: XCTestCase {
    private let account = try! AccountID("account-a")

    // MARK: Adoption

    func testAdoptionRefusesDraftsAndOtherChats() {
        let work = follower()
        defer { work.close() }
        XCTAssertFalse(work.adopt(summary(id: "d", created: 10, status: "draft")))
        XCTAssertFalse(work.adopt(summary(id: "x", created: 10, conversation: "conv_2")))
        XCTAssertNil(work.current)

        XCTAssertTrue(work.adopt(summary(id: "a", created: 10)))
        XCTAssertEqual(work.current?.sessionID, "a")
        // The same id keeps what is followed.
        XCTAssertFalse(work.adopt(summary(id: "a", created: 10, status: "running")))

        // A second task files the first under history.
        XCTAssertTrue(work.adopt(summary(id: "b", created: 20)))
        XCTAssertEqual(work.current?.sessionID, "b")
        XCTAssertEqual(work.history.map(\.sessionID), ["a"])
    }

    // MARK: Discovery

    /// The newest composed is current, not the most recently active; the rest
    /// are history, oldest first; drafts never count.
    func testDiscoveryFollowsTheNewestComposedWithHistory() {
        let work = follower()
        defer { work.close() }
        work.apply(discovered: [
            summary(id: "old", created: 100, active: 900),
            summary(id: "new", created: 500, active: 600),
            summary(id: "mid", created: 300, active: 950),
            summary(id: "draft", created: 999, status: "draft"),
            summary(id: "elsewhere", created: 999, conversation: "conv_2"),
        ])
        XCTAssertEqual(work.current?.sessionID, "new")
        XCTAssertEqual(work.history.map(\.sessionID), ["old", "mid"])
    }

    /// A task adopted from the stream is newer than a list that left before it
    /// existed; the list must not take the card back.
    func testAnAdoptedTaskOutranksAnOlderList() {
        let work = follower()
        defer { work.close() }
        work.adopt(summary(id: "fresh", created: 1_000))
        work.apply(discovered: [summary(id: "older", created: 100)])
        XCTAssertEqual(work.current?.sessionID, "fresh")
        XCTAssertEqual(work.history.map(\.sessionID), ["older"])
    }

    // MARK: Composer mode

    func testTheComposerModeTable() {
        let question = WorkQuestionPrompt(questionID: "q_1", text: "Which folder?")
        XCTAssertNil(NativeConversationWork.composerMode(status: nil, openQuestion: nil))
        XCTAssertNil(NativeConversationWork.composerMode(status: .draft, openQuestion: nil))
        XCTAssertEqual(
            NativeConversationWork.composerMode(status: .running, openQuestion: nil), .instruction
        )
        XCTAssertEqual(
            NativeConversationWork.composerMode(status: .paused, openQuestion: nil), .instruction
        )
        XCTAssertEqual(
            NativeConversationWork.composerMode(status: .waitingInput, openQuestion: question),
            .answer(question)
        )
        // Register #54: a finished run never keeps the composer answering —
        // the route refuses the answer, and Stop would cancel a finished run.
        for finished in [JunoWorkStatus.completed, .failed, .cancelled, .interrupted, .timedOut] {
            XCTAssertNil(NativeConversationWork.composerMode(status: finished, openQuestion: question))
            XCTAssertNil(NativeConversationWork.composerMode(status: finished, openQuestion: nil))
        }
    }

    // MARK: What the log says

    /// A steer is queued until the run speaks or starts a step; answering a
    /// question is not the run taking a turn.
    func testPendingSteersLastUntilTheRunTakesATurn() {
        let base = [
            event(1, "step_started", ["stepId": .string("s1"), "title": .string("Read the quotes")]),
            event(2, "user_message", ["text": .string("Ignore the Brightline quote")]),
        ]
        XCTAssertEqual(WorkEventLog.pendingSteers(in: base).map(\.text), ["Ignore the Brightline quote"])

        let two = base + [
            event(3, "question_answered", ["questionId": .string("q_1"), "text": .string("Yes")]),
            event(4, "user_message", ["text": .string("And use euros")]),
        ]
        XCTAssertEqual(
            WorkEventLog.pendingSteers(in: two).map(\.text),
            ["Ignore the Brightline quote", "And use euros"]
        )

        let read = two + [event(5, "assistant_message", ["text": .string("Noted.")])]
        XCTAssertTrue(WorkEventLog.pendingSteers(in: read).isEmpty)
    }

    /// A step still open when the run ends is `unreported`, not turning.
    func testAStepOpenWhenTheRunEndedIsUnreported() {
        let events = [
            event(1, "plan_created", ["steps": .array([
                .object(["id": .string("s1"), "title": .string("Read the quotes")]),
                .object(["id": .string("s2"), "title": .string("Compare them")]),
            ])]),
            event(2, "step_started", ["stepId": .string("s1")]),
            event(3, "step_finished", ["stepId": .string("s1")]),
            event(4, "step_started", ["stepId": .string("s2")]),
        ]
        XCTAssertEqual(WorkEventLog.plan(from: events).map(\.state), [.done, .active])
        let ended = events + [event(5, "run_finished", ["status": .string("failed")])]
        XCTAssertEqual(WorkEventLog.plan(from: ended).map(\.state), [.done, .unreported])
        XCTAssertEqual(WorkEventLog.tally(WorkEventLog.plan(from: ended)).done, 1)
    }

    func testOpenQuestionsCloseWhenAnswered() {
        let events = [
            event(1, "question_asked", [
                "questionId": .string("q_1"), "question": .string("Which currency?"),
                "options": .array([.string("Euros"), .string("Dollars")]),
            ]),
            event(2, "question_asked", ["questionId": .string("q_2"), "question": .string("Include VAT?")]),
            event(3, "question_answered", ["questionId": .string("q_1"), "text": .string("Euros")]),
        ]
        let open = WorkEventLog.openQuestions(in: events)
        XCTAssertEqual(open.map(\.questionID), ["q_2"])
    }

    // MARK: Approvals

    /// The coordinator holding a suspended tool on this Mac answers first; a
    /// server card with the same id is not shown twice, and decided ones never.
    func testLocalApprovalsComeFirst() {
        let local = approval("ap_2", decision: "pending")
        let merged = NativeConversationWork.mergedApprovals(
            local: [local],
            server: [approval("ap_1", decision: "pending"), approval("ap_2", decision: "pending"),
                     approval("ap_3", decision: "allowed")]
        )
        XCTAssertEqual(merged.map(\.id), ["ap_2", "ap_1"])
        XCTAssertEqual(merged.map(\.isLocal), [true, false])
    }

    // MARK: Acting

    /// Stop before the run has reported in says so, in the web's words, and
    /// sends nothing.
    func testStopWithNoRunSaysNothingCanBeStopped() async {
        let transport = FollowerTransport()
        let work = NativeConversationWork.preview(
            conversationID: "conv_1", client: NativeWorkClient(transport: transport),
            accountID: account, current: summary(id: "a", created: 10)
        )
        let outcome = await work.stop()
        XCTAssertEqual(outcome, .failed(
            "This task hasn’t reported in yet, so there is nothing to stop. Try again in a moment."
        ))
        let sent = await transport.requests
        XCTAssertTrue(sent.isEmpty)
    }

    /// A refused steer keeps the web's sentence; the server's own refusal wins.
    func testASteerThatFailsSaysSo() async {
        let transport = FollowerTransport(routes: [
            "/api/work/sessions/a/answer": HTTPResponse(
                statusCode: 409, headers: HTTPHeaders(),
                body: Data(#"{"error":"This task has finished, so there is nothing to steer."}"#.utf8)
            ),
        ])
        let work = NativeConversationWork.preview(
            conversationID: "conv_1", client: NativeWorkClient(transport: transport),
            accountID: account, current: summary(id: "a", created: 10)
        )
        let outcome = await work.steer("Use euros")
        XCTAssertFalse(outcome.succeeded)
        XCTAssertNotNil(outcome.message)

        let unreachable = NativeConversationWork.preview(
            conversationID: "conv_1", client: NativeWorkClient(transport: FollowerTransport()),
            accountID: account, current: summary(id: "b", created: 10)
        )
        let failed = await unreachable.steer("Use euros")
        XCTAssertEqual(failed, .failed("Couldn’t add that to the task. Nothing was recorded."))
    }

    /// A steer the server takes returns its explanation for the toast.
    func testAnAcceptedSteerCarriesTheServersSentence() async {
        let transport = FollowerTransport(routes: [
            "/api/work/sessions/a/answer": HTTPResponse(
                statusCode: 200, headers: HTTPHeaders(),
                body: Data(#"{"delivered":true,"explanation":"Added. Juno reads it before its next step."}"#.utf8)
            ),
        ])
        let work = NativeConversationWork.preview(
            conversationID: "conv_1", client: NativeWorkClient(transport: transport),
            accountID: account, current: summary(id: "a", created: 10)
        )
        let outcome = await work.steer("Use euros")
        XCTAssertEqual(outcome, .ok("Added. Juno reads it before its next step."))
        let sent = await transport.requests
        let body = try? JSONSerialization.jsonObject(with: sent.first?.body ?? Data()) as? [String: Any]
        XCTAssertNil(body?["questionId"], "an instruction never names a question")
        XCTAssertNotNil(body?["idempotencyKey"])
    }

    /// "Change it" refuses the action and hands the run the correction: the
    /// decision is `denied` and the text rides as the reason (Phase 5 B5).
    func testTheAmendmentRefusesWithTheReason() async {
        let pending = approval("ap_9", decision: "pending")
        let transport = FollowerTransport(routes: [
            "/api/work/approvals/ap_9/decision": HTTPResponse(
                statusCode: 200, headers: HTTPHeaders(),
                body: Data(#"{"approval":{"id":"ap_9","runId":"run_1","action":"send_email","risk":"sensitive","summary":"Send the comparison to Priya","actionDigest":"digest-ap_9","expiresAt":"2099-01-01T00:00:00.000Z","decision":"denied"}}"#.utf8)
            ),
        ])
        let work = NativeConversationWork.preview(
            conversationID: "conv_1", client: NativeWorkClient(transport: transport),
            accountID: account, current: summary(id: "a", created: 10), approvals: [pending]
        )
        let outcome = await work.decide(
            .init(request: pending, isLocal: false), .denied, reason: "  Send it to the finance alias instead.  "
        )
        XCTAssertTrue(outcome.succeeded)
        let sent = await transport.requests
        let body = try? JSONSerialization.jsonObject(with: sent.first?.body ?? Data()) as? [String: Any]
        XCTAssertEqual(body?["decision"] as? String, "denied")
        XCTAssertEqual(body?["reason"] as? String, "Send it to the finance alias instead.")
        XCTAssertTrue(work.approvals.isEmpty)
    }

    /// The batch stops at the first answer that does not land.
    func testTheBatchStopsAtTheFirstFailure() async {
        let first = approval("ap_1", decision: "pending")
        let second = approval("ap_2", decision: "pending")
        let transport = FollowerTransport()
        let work = NativeConversationWork.preview(
            conversationID: "conv_1", client: NativeWorkClient(transport: transport),
            accountID: account, current: summary(id: "a", created: 10), approvals: [first, second]
        )
        let outcome = await work.decideAll([
            .init(request: first, isLocal: false), .init(request: second, isLocal: false),
        ])
        XCTAssertFalse(outcome.succeeded)
        let sent = await transport.requests
        XCTAssertEqual(sent.count, 1)
        XCTAssertFalse(work.isBatching)
    }

    // MARK: The frame's session

    func testTheWorkFramesSessionDecodes() throws {
        let data = Data(#"{"id":"wsi_3f9a0c1e5b7d","projectId":null,"conversationId":"conv_1","title":"Compare the quotes","titleSource":"model","goal":"Compare the quotes.","status":"queued","needsAttention":false,"requestedTarget":"automatic","preferredHostId":null,"requestedModel":null,"reasoningEffort":null,"permissionPolicy":"balanced","pinned":false,"archived":false,"lastActivityAt":"2026-09-24T17:58:02.114Z","createdAt":"2026-09-24T17:58:01.902Z","updatedAt":"2026-09-24T17:58:02.114Z"}"#.utf8)
        let session = try NativeWorkClient.decodeSessionSummary(data)
        XCTAssertEqual(session.sessionID, "wsi_3f9a0c1e5b7d")
        XCTAssertEqual(session.conversationID, "conv_1")
        XCTAssertEqual(session.permissionPolicy, .balanced)
        XCTAssertNotNil(session.createdAt)
        XCTAssertThrowsError(try NativeWorkClient.decodeSessionSummary(Data("{}".utf8)))
    }

    // MARK: - Fixtures

    private func follower() -> NativeConversationWork {
        NativeConversationWork(
            conversationID: "conv_1", client: NativeWorkClient(transport: FollowerTransport()),
            accountID: account
        )
    }

    private func summary(
        id: String, created: TimeInterval, active: TimeInterval? = nil,
        status: String = "running", conversation: String = "conv_1"
    ) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: id, title: id, goal: id, status: status, needsAttention: false,
            requestedTarget: "automatic", effectiveTarget: nil, hostID: nil,
            hostDisplayName: nil, pinned: false, archived: false,
            lastActivityAt: Date(timeIntervalSince1970: active ?? created), currentRunID: nil,
            lastSeq: 0, conversationID: conversation, createdAt: Date(timeIntervalSince1970: created)
        )
    }

    private func event(_ seq: Int, _ kind: String, _ payload: [String: JunoJSONValue]) -> WorkEvent {
        WorkEvent(
            seq: seq, kind: kind, payload: payload, agentID: nil,
            createdAt: Date(timeIntervalSince1970: 1_000 + Double(seq))
        )
    }

    private func approval(_ id: String, decision: String) -> WorkApprovalRequest {
        WorkApprovalRequest(
            approvalID: id, runID: "run_1", action: "send_email", risk: "external",
            summary: "Send the comparison to Priya", detail: [:], actionDigest: "digest-\(id)",
            expiresAt: Date(timeIntervalSinceNow: 3_600), decision: decision
        )
    }
}

/// Answers by path; streams refuse, as a proxy that will not stream does.
private actor FollowerTransport: NativeWorkTransport {
    private let routes: [String: HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(routes: [String: HTTPResponse] = [:]) { self.routes = routes }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        return routes[request.path]
            ?? HTTPResponse(
                statusCode: 503, headers: HTTPHeaders(),
                body: Data(#"{"error":"unreachable"}"#.utf8)
            )
    }

    func stream(
        _: NativeBearerRequest, for _: AccountID
    ) async throws -> HTTPByteStreamResponse {
        HTTPByteStreamResponse(
            statusCode: 503,
            headers: try HTTPHeaders(["content-type": "application/json"]),
            bytes: AsyncThrowingStream { $0.finish() }
        )
    }
}
