import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoWorkKit

/// The two shapes a Work event payload arrives in, and the readers that must
/// cope with both.
///
/// This Mac's own run host writes each payload flat — `["questionId": …,
/// "text": …]` — and the cloud runner hands the runtime's discriminated union
/// through verbatim, so the same fact sits one level down under an envelope
/// named for its kind. Every native reader knew only the flat shape, which
/// meant a **cloud** run that stopped to ask something showed no question and
/// no way to answer it: `pendingQuestion` looked for `questionId` at the top
/// level, found nothing, and left the phone rendering a task that appeared to
/// be working while it waited on a person who was never asked.
///
/// So each of these tests asserts the same fact twice, once per executor. A
/// test written against one shape is exactly how this shipped.
final class WorkEventPayloadTests: XCTestCase {
    private let account = try! AccountID("account-a")

    // MARK: - Lifting the envelope

    func testAQuestionReadsTheSameFromEitherExecutor() {
        // The Mac's shape.
        let flat = event(
            kind: "question_asked",
            payload: ["questionId": .string("q_1"), "text": .string("Which invoice?")]
        )
        // The cloud runner's: `{ kind, question: { id, question, why, options } }`.
        let nested = event(
            kind: "question_asked",
            payload: [
                "question": .object([
                    "id": .string("q_1"),
                    "question": .string("Which invoice?"),
                    "why": .string("Two of them are called Invoices."),
                ])
            ]
        )

        for payload in [WorkEventPayload.fields(of: flat), WorkEventPayload.fields(of: nested)] {
            XCTAssertEqual(WorkEventPayload.string(payload, "questionId", "id"), "q_1")
            XCTAssertEqual(
                WorkEventPayload.string(payload, "question", "text", "prompt"), "Which invoice?"
            )
        }
    }

    /// Approvals are the sibling of questions and matter just as much: an
    /// approval row rendered with no summary and no action is a card asking
    /// somebody to authorise "an action".
    func testAnApprovalReadsTheSameFromEitherExecutor() {
        let flat = event(
            kind: "approval_requested",
            payload: [
                "approvalId": .string("ap_1"),
                "action": .string("work.connector.send_message"),
                "summary": .string("Send the reply to Dana"),
                "risk": .string("irreversible"),
            ]
        )
        let nested = event(
            kind: "approval_requested",
            payload: [
                "request": .object([
                    "id": .string("ap_1"),
                    "action": .string("work.connector.send_message"),
                    "summary": .string("Send the reply to Dana"),
                    "risk": .string("irreversible"),
                ])
            ]
        )

        for payload in [WorkEventPayload.fields(of: flat), WorkEventPayload.fields(of: nested)] {
            XCTAssertEqual(WorkEventPayload.string(payload, "approvalId", "requestId", "id"), "ap_1")
            XCTAssertEqual(
                WorkEventPayload.string(payload, "action"), "work.connector.send_message"
            )
            XCTAssertEqual(
                WorkEventPayload.string(payload, "summary", "description"), "Send the reply to Dana"
            )
            XCTAssertEqual(WorkEventPayload.string(payload, "risk"), "irreversible")
        }
    }

    /// The lift replaces rather than merges, and `question_asked` is the case
    /// that forces it: the envelope is called `question` and so is the sentence
    /// inside it. A merge letting the outer key win would put a dictionary's
    /// description on screen as somebody's question.
    func testTheEnvelopesOwnFieldsWinOverTheWrapper() {
        let lifted = WorkEventPayload.fields(
            of: event(
                kind: "question_asked",
                payload: [
                    "question": .object([
                        "id": .string("q_1"), "question": .string("Which invoice?"),
                    ])
                ]
            )
        )
        XCTAssertEqual(lifted["question"], .string("Which invoice?"))
    }

    /// Sibling keys outside the envelope survive it. The runner writes the kind
    /// alongside the wrapper, and a lift that discarded everything but the
    /// wrapper would throw away whatever the next release puts beside it.
    func testFieldsBesideTheEnvelopeAreKept() {
        let lifted = WorkEventPayload.fields(
            of: event(
                kind: "plan_created",
                payload: [
                    "kind": .string("plan_created"),
                    "plan": .object(["version": .number(2)]),
                ]
            )
        )
        XCTAssertEqual(lifted["kind"], .string("plan_created"))
        XCTAssertEqual(lifted["version"], .number(2))
        XCTAssertNil(lifted["plan"], "the wrapper itself is consumed by the lift")
    }

    /// Nothing is thrown and nothing is dropped for an event this build cannot
    /// name, or one whose envelope key holds something other than an object. An
    /// executor a release ahead of this bundle is the expected case, and one
    /// unreadable event has to cost one line of one panel rather than a screen.
    func testAnUnknownOrMalformedEventIsPassedThroughUntouched() {
        let unknown = event(kind: "telepathy_established", payload: ["text": .string("hello")])
        XCTAssertEqual(WorkEventPayload.fields(of: unknown), unknown.payload)

        // Right kind, wrong type under the envelope key.
        let malformed = event(kind: "question_asked", payload: ["question": .string("Which one?")])
        XCTAssertEqual(WorkEventPayload.fields(of: malformed), malformed.payload)

        // A kind with no envelope at all is its own payload.
        let flat = event(kind: "assistant_message", payload: ["text": .string("Done.")])
        XCTAssertEqual(WorkEventPayload.fields(of: flat), flat.payload)
    }

    /// `run_finished` is deliberately absent from the envelope table: its
    /// wrapper is the whole report, and hoisting it would let a finished run's
    /// summary of the plan stand in for the plan events that already said it.
    func testTheFinishedReportIsNeverHoisted() {
        XCTAssertNil(WorkEventPayload.envelope[.runFinished])
        let finished = event(
            kind: "run_finished",
            payload: ["report": .object(["goal": .string("Sort it by kind")])]
        )
        XCTAssertEqual(WorkEventPayload.fields(of: finished), finished.payload)
    }

    /// A blank string is not an answer. The Mac writes `""` for a question it
    /// could not phrase, and a reader that accepted it would render an empty
    /// prompt instead of falling through to the key that has the words.
    func testBlankStringsFallThroughToTheNextKey() {
        let payload: [String: JunoJSONValue] = [
            "question": .string("   "), "text": .string("Which invoice?"),
        ]
        XCTAssertEqual(WorkEventPayload.string(payload, "question", "text"), "Which invoice?")
        XCTAssertNil(WorkEventPayload.string(payload, "missing"))
    }

    // MARK: - Through the model

    /// The bug, end to end: a cloud run's question reaching the composer.
    ///
    /// Driven through `NativeWorkModel` rather than asserted on the reader
    /// alone, because what broke was not the parse — it was that the phone had
    /// no box to answer in. `composerMode` is the thing both apps gate that box
    /// on, so this is the assertion that says the run can be unblocked.
    @MainActor
    func testACloudRunsQuestionOpensTheAnswerBox() async throws {
        let model = NativeWorkModel(
            client: NativeWorkClient(
                transport: WorkPayloadTransport(routes: [
                    "/api/work/sessions": json(sessionListJSON),
                    "/api/work/hosts": json(#"{"hosts":[]}"#),
                    "/api/work/sessions/sess_1": json(cloudAskingDetailJSON),
                ])
            )
        )

        await model.start(for: account)
        defer { model.stop() }
        let session = try XCTUnwrap(model.sessions.first)
        model.open(session)
        await settle(until: { model.pendingQuestion != nil })

        let question = try XCTUnwrap(model.pendingQuestion)
        XCTAssertEqual(question.questionID, "q_1")
        XCTAssertEqual(question.text, "Which invoice did you mean?")
        XCTAssertEqual(model.composerMode, .answer(question))
    }

    /// And the answer closes it — across the shapes, which is the case a cloud
    /// run actually produces.
    ///
    /// `question_asked` is enveloped and `question_answered` is not: the
    /// runtime emits `{ kind, questionId, answer }` flat and `POST /answer`
    /// writes `{ questionId, text }`, so one run's two halves arrive in two
    /// different shapes and have to agree on an id anyway. A reader that lifted
    /// only one of them would leave the prompt on screen for ever, with the run
    /// already moving.
    @MainActor
    func testACloudRunsAnswerClosesTheQuestion() async throws {
        let model = NativeWorkModel(
            client: NativeWorkClient(
                transport: WorkPayloadTransport(routes: [
                    "/api/work/sessions": json(sessionListJSON),
                    "/api/work/hosts": json(#"{"hosts":[]}"#),
                    "/api/work/sessions/sess_1": json(cloudAnsweredDetailJSON),
                ])
            )
        )

        await model.start(for: account)
        defer { model.stop() }
        let session = try XCTUnwrap(model.sessions.first)
        model.open(session)
        await settle(until: { model.openRun != nil })

        XCTAssertNil(model.pendingQuestion)
        XCTAssertEqual(model.composerMode, .instruction)
    }

    // MARK: - Fixtures

    private func event(kind: String, payload: [String: JunoJSONValue]) -> WorkEvent {
        WorkEvent(
            seq: 13, kind: kind, payload: payload, agentID: nil,
            createdAt: Date(timeIntervalSince1970: 1_000_000)
        )
    }

    private func json(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }

    @MainActor
    private func settle(
        until condition: () -> Bool,
        within timeout: Duration = .seconds(5)
    ) async {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if condition() { return }
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(2))
        }
    }
}

// MARK: - Fixture bodies

private let sessionListJSON = #"""
{"sessions":[{"id":"sess_1","title":"Tidy the downloads folder","goal":"Sort it by kind",\#
"status":"running","needsAttention":false,"requestedTarget":"cloud","effectiveTarget":"cloud",\#
"pinned":false,"archived":false,"lastActivityAt":"2026-08-05T10:00:00.000Z",\#
"currentRunId":"run_1","lastSeq":12}]}
"""#

private let runJSON = #"""
{"id":"run_1","sessionId":"sess_1","status":"running","attempt":1,\#
"requestedTarget":"cloud","effectiveTarget":"cloud","lastSeq":12}
"""#

/// A cloud run stopped on a question, written the way the runner writes one.
private let cloudAskingDetailJSON = #"""
{"session":{"id":"sess_1","title":"Tidy the downloads folder","goal":"Sort it by kind",\#
"status":"waiting_input","needsAttention":true,"requestedTarget":"cloud",\#
"effectiveTarget":"cloud","pinned":false,"archived":false,\#
"lastActivityAt":"2026-08-05T10:00:00.000Z","currentRunId":"run_1","lastSeq":13},\#
"run":\#(runJSON),"events":[\#
{"seq":12,"kind":"run_started","payload":{},"createdAt":"2026-08-05T10:00:00.000Z"},\#
{"seq":13,"kind":"question_asked","payload":{"kind":"question_asked","question":\#
{"id":"q_1","question":"Which invoice did you mean?",\#
"why":"Two folders are called Invoices.","options":["The 2025 one","The archive"]}},\#
"createdAt":"2026-08-05T10:00:05.000Z"}],"approvals":[]}
"""#

/// The same run once the answer landed: an enveloped ask and a flat answer,
/// which is what a cloud run really writes.
private let cloudAnsweredDetailJSON = #"""
{"session":{"id":"sess_1","title":"Tidy the downloads folder","goal":"Sort it by kind",\#
"status":"running","needsAttention":false,"requestedTarget":"cloud",\#
"effectiveTarget":"cloud","pinned":false,"archived":false,\#
"lastActivityAt":"2026-08-05T10:00:00.000Z","currentRunId":"run_1","lastSeq":14},\#
"run":\#(runJSON),"events":[\#
{"seq":13,"kind":"question_asked","payload":{"question":\#
{"id":"q_1","question":"Which invoice did you mean?"}},\#
"createdAt":"2026-08-05T10:00:05.000Z"},\#
{"seq":14,"kind":"question_answered","payload":{"questionId":"q_1","text":"The 2025 one"},\#
"createdAt":"2026-08-05T10:00:09.000Z"}],\#
"approvals":[]}
"""#

// MARK: - Doubles

/// Answers by path. No stream fixture: the model reads the authoritative detail
/// before it opens one, and a stream that refuses simply leaves it reconnecting
/// in the background, which is what it does in the field.
private actor WorkPayloadTransport: NativeWorkTransport {
    private let routes: [String: HTTPResponse]

    init(routes: [String: HTTPResponse]) {
        self.routes = routes
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        routes[request.path]
            ?? HTTPResponse(
                statusCode: 500, headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
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
