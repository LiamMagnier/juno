import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoWorkKit

/// Saying something to a run that has not asked anything.
///
/// Two things are being pinned here and they fail in opposite directions. The
/// sender must never look like an answer on the wire — the route tells the two
/// requests apart by the presence of `questionId` alone, so one stray key turns
/// a note typed mid-run into the reply to whatever Juno asks next. And the rule
/// deciding which box is on screen must agree with the web's, because the route
/// refuses whichever request does not match the run's state and a 409 is not
/// something the reader can do anything with.
final class NativeWorkInstructionTests: XCTestCase {
    private let account = try! AccountID("account-a")

    // MARK: - The sender

    /// The whole reason this is not `answer(sessionID:questionID:text:for:)`
    /// with the identifier left off. `parseSubmission` in the route branches on
    /// `"questionId" in body` before it validates anything, so a key present and
    /// empty is a malformed *answer* — a 400 — and a key present and plausible
    /// is an answer to a question nobody asked.
    func testAnInstructionCarriesNoQuestionIdentifier() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/sessions/sess_1/answer": json(deliveredJSON)
        ])
        let client = NativeWorkClient(transport: transport)

        _ = try await client.sendInstruction(
            sessionID: "sess_1", text: "Skip the archive folder",
            idempotencyKey: "key-1", for: account
        )

        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/work/sessions/sess_1/answer")
        XCTAssertEqual(request.method, .post)
        let body = try XCTUnwrap(request.body)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["text"] as? String, "Skip the archive folder")
        XCTAssertEqual(object["idempotencyKey"] as? String, "key-1")
        XCTAssertNil(object["questionId"], "an instruction that names a question is an answer")
        XCTAssertEqual(object.count, 2, "nothing else may ride along")
    }

    /// The answer path is untouched by any of this, and this is what says so:
    /// where a run is waiting, the same route still receives the identifier and
    /// the reply and nothing that would make it look like an instruction.
    func testAnAnswerStillNamesItsQuestion() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/sessions/sess_1/answer": json("{}")
        ])
        let client = NativeWorkClient(transport: transport)

        try await client.answer(
            sessionID: "sess_1", questionID: "q_7", text: "Yes, the 2024 one", for: account
        )

        let requests = await transport.requests
        let body = try XCTUnwrap(requests.first?.body)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["questionId"] as? String, "q_7")
        XCTAssertEqual(object["text"] as? String, "Yes, the 2024 one")
    }

    /// `delivered` is not a property of where the run is executing. A task on a
    /// Mac whose pairing was revoked has its instruction queued for nobody, and
    /// only the server — at the moment it tried to enqueue — can say so.
    func testTheOutcomeIsReadOffTheWireRatherThanAssumed() async throws {
        let cases: [(String, Bool, String)] = [
            (deliveredJSON, true, "Juno reads this before its next step."),
            (undeliveredJSON, false, "The Mac this attempt is running on is no longer paired."),
        ]
        for (body, delivered, explanation) in cases {
            let transport = WorkTransport(routes: [
                "/api/work/sessions/sess_1/answer": json(body)
            ])
            let client = NativeWorkClient(transport: transport)

            let outcome = try await client.sendInstruction(
                sessionID: "sess_1", text: "Stop at the drafts",
                idempotencyKey: "key-1", for: account
            )

            XCTAssertEqual(outcome.delivered, delivered)
            XCTAssertEqual(outcome.explanation, explanation)
        }
    }

    /// Neither half may be defaulted. Assuming `true` reports a delivery nobody
    /// made; assuming `false` puts a warning on screen for an instruction that
    /// landed; and inventing the sentence would be this client answering, in its
    /// own words, the one question the route exists to answer in its.
    func testAResponseMissingEitherHalfIsRefused() async throws {
        let incomplete = [
            #"{"lastSeq":41}"#,
            #"{"lastSeq":41,"delivered":true}"#,
            #"{"lastSeq":41,"explanation":"Recorded."}"#,
            #"{"lastSeq":41,"delivered":true,"explanation":""}"#,
            #"{"lastSeq":41,"delivered":"yes","explanation":"Recorded."}"#,
        ]
        for body in incomplete {
            let transport = WorkTransport(routes: [
                "/api/work/sessions/sess_1/answer": json(body)
            ])
            let client = NativeWorkClient(transport: transport)
            do {
                _ = try await client.sendInstruction(
                    sessionID: "sess_1", text: "Go on", idempotencyKey: "key-1", for: account
                )
                XCTFail("\(body) must not decode into a claim about delivery")
            } catch let error as WorkRemoteError {
                XCTAssertEqual(error, .malformedResponse, body)
            }
        }
    }

    /// The session identifier is interpolated into a path whose neighbours stop
    /// runs and answer approvals, so a hostile one is refused before it can
    /// address one of them.
    func testAHostileSessionIdentifierNeverReachesTheNetwork() async throws {
        let transport = WorkTransport()
        let client = NativeWorkClient(transport: transport)

        for identifier in ["../runs/run_1/control", "a%2Fb", "with space", ""] {
            do {
                _ = try await client.sendInstruction(
                    sessionID: identifier, text: "Go on",
                    idempotencyKey: "key-1", for: account
                )
                XCTFail("\(identifier.debugDescription) should have been refused")
            } catch let error as WorkRemoteError {
                XCTAssertEqual(error, .invalidIdentifier, identifier.debugDescription)
            }
        }
        let count = await transport.requests.count
        XCTAssertEqual(count, 0)
    }

    /// A steer is not a run control and must not become one. The kinds a client
    /// may send to `/runs/{id}/control` are a closed set with no body, and
    /// `steer` carries the user's own words to a different route entirely.
    func testSteerIsNotARunControl() async throws {
        XCTAssertFalse(NativeWorkClient.controlKinds.contains(.steer))

        let transport = WorkTransport()
        let client = NativeWorkClient(transport: transport)
        do {
            _ = try await client.control(
                runID: "run_1", .steer, idempotencyKey: "k", for: account
            )
            XCTFail("steer must not be sendable as a control")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(error, .unsupportedCommand(JunoWorkCommandKind.steer.rawValue))
        }
        let count = await transport.requests.count
        XCTAssertEqual(count, 0)
    }

    /// The route refuses an instruction to a stopped run with a sentence written
    /// for the reader and a code beside it. Reading `error` first handed the
    /// reader "answer_expected" and nothing else; `message` is where the Work
    /// API puts the prose, on this route and every other one.
    func testARefusalSurfacesTheServersSentenceRatherThanItsCode() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/sessions/sess_1/answer": json(
                #"{"error":"answer_expected","message":"Juno is waiting for an answer to the "#
                    + #"question it asked, and nothing else will restart it.","#
                    + #""status":"waiting_input"}"#,
                status: 409
            )
        ])
        let client = NativeWorkClient(transport: transport)

        do {
            _ = try await client.sendInstruction(
                sessionID: "sess_1", text: "Also check the invoices",
                idempotencyKey: "key-1", for: account
            )
            XCTFail("a 409 must not read as a delivery")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(
                error.errorDescription,
                "Juno is waiting for an answer to the question it asked, and nothing else will "
                    + "restart it."
            )
        }
    }

    /// A route that sends `error` alone sends prose in it, and that must keep
    /// reaching the reader — the reordering above is only ever allowed to win
    /// where a sentence exists to win with.
    func testARefusalWithOnlyAnErrorStringStillSpeaks() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/hosts": json(#"{"error":"Not found"}"#, status: 404)
        ])
        let client = NativeWorkClient(transport: transport)

        do {
            _ = try await client.hosts(for: account)
            XCTFail("should have thrown")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(error.errorDescription, "Not found")
        }
    }

    // MARK: - Which box is on screen

    /// An open question outranks everything, and this is the branch that keeps
    /// the answer path exactly as it was. While a question stands the run is
    /// stopped, answering is the only thing that restarts it, and the route
    /// refuses an instruction on purpose: it would sit in the log until somebody
    /// answered, while its author was told it had been delivered.
    func testAWaitingRunTakesAnAnswerAndNothingElse() {
        let mode = NativeWorkModel.composerMode(
            session: session(status: "waiting_input"),
            run: run(status: "waiting_input"),
            question: WorkQuestionPrompt(questionID: "q_1", text: "Which invoice?")
        )
        XCTAssertEqual(mode, .answer(WorkQuestionPrompt(questionID: "q_1", text: "Which invoice?")))
    }

    /// A question outranks the run's status rather than the other way round. The
    /// log is the authority on whether one is open — an answer given on another
    /// device arrives as an event — and a status that has not caught up yet must
    /// not reopen the instruction box over a question still on screen.
    func testAQuestionOutranksALiveLookingStatus() {
        let mode = NativeWorkModel.composerMode(
            session: session(status: "running"),
            run: run(status: "running"),
            question: WorkQuestionPrompt(questionID: "q_1", text: "Which invoice?")
        )
        guard case .answer = mode else { return XCTFail("expected the answer box, got \(mode)") }
    }

    /// Every live status with nothing being asked takes an instruction, which is
    /// the case this whole change exists for. `paused` is in here deliberately:
    /// the route accepts one, and a paused run is exactly when somebody wants to
    /// say what should change before it continues.
    func testALiveRunWithNoQuestionTakesAnInstruction() {
        for status in ["queued", "preparing", "running", "waiting_approval", "paused"] {
            let mode = NativeWorkModel.composerMode(
                session: session(status: status), run: run(status: status), question: nil
            )
            XCTAssertEqual(mode, .instruction, status)
        }
    }

    /// A finished attempt takes nothing, and the sentence has to say so rather
    /// than leave a box that produces a 409.
    func testAFinishedAttemptIsClosed() {
        for status in [
            "completed", "failed", "cancelled", "interrupted", "host_offline",
            "budget_exceeded", "timed_out",
        ] {
            let mode = NativeWorkModel.composerMode(
                session: session(status: status), run: run(status: status), question: nil
            )
            guard case .closed(let reason) = mode else {
                return XCTFail("\(status) must not take an instruction, got \(mode)")
            }
            XCTAssertFalse(reason.isEmpty, status)
        }
    }

    /// A status this build cannot name is treated as finished, matching
    /// `displayStatus(of:)` and the server's own fallback. Erring the other way
    /// offers a box on a task whose state nobody here can describe.
    func testAnUnreadableStatusIsClosedRatherThanOpen() {
        let mode = NativeWorkModel.composerMode(
            session: session(status: "reticulating"), run: nil, question: nil
        )
        guard case .closed = mode else { return XCTFail("expected closed, got \(mode)") }
    }

    /// A draft has no attempt for an instruction to join. The route says the
    /// same thing with a 409, and saying it here means the box is never offered
    /// for one.
    func testADraftIsClosed() {
        let mode = NativeWorkModel.composerMode(
            session: session(status: "draft", currentRunID: nil), run: nil, question: nil
        )
        guard case .closed(let reason) = mode else {
            return XCTFail("expected closed, got \(mode)")
        }
        XCTAssertTrue(reason.contains("draft"))
    }

    /// The moment between opening a task and its detail arriving. `openRun` is
    /// nil for that frame, and reading it alone told every running task in the
    /// list that it was still a draft.
    func testAStartedTaskWhoseRunHasNotLoadedIsStillOpen() {
        let mode = NativeWorkModel.composerMode(
            session: session(status: "running", currentRunID: "run_1"), run: nil, question: nil
        )
        XCTAssertEqual(mode, .instruction)
    }

    // MARK: - The model

    /// The gap the model closes and the screens cannot: a question can arrive on
    /// the stream between the field being typed into and Send being pressed. The
    /// route would refuse it, and the run would stay stopped with the reader's
    /// words in neither place.
    @MainActor
    func testAnInstructionIsNotSentToARunThatHasStartedAsking() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/sessions": json(sessionListJSON),
            "/api/work/hosts": json(#"{"hosts":[]}"#),
            "/api/work/sessions/sess_1": json(askingDetailJSON),
        ])
        let model = NativeWorkModel(client: NativeWorkClient(transport: transport))

        await model.start(for: account)
        defer { model.stop() }
        let session = try XCTUnwrap(model.sessions.first)
        model.open(session)
        await settle(until: { model.pendingQuestion != nil })

        guard case .answer = model.composerMode else {
            return XCTFail("the fixture has an unanswered question")
        }
        let outcome = await model.sendInstruction("Also check the invoices")
        XCTAssertNil(outcome)

        let posted = await transport.requests.filter { $0.method == .post }
        XCTAssertTrue(posted.isEmpty, "a refused instruction must not reach the network")
    }

    /// One key across the retry a failure invites, and a fresh one afterwards.
    ///
    /// Both halves matter. Without the reuse, a phone that lost its response and
    /// whose owner pressed Send again would queue a second `steer` at the Mac.
    /// Without the reset, two identical sentences a minute apart — which the
    /// route is explicit are two deliberate instructions — would collapse into
    /// one, because the second would replay the first one's key.
    @MainActor
    func testTheIdempotencyKeyIsHeldForARetryAndDroppedAfterASuccess() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/sessions": json(sessionListJSON),
            "/api/work/hosts": json(#"{"hosts":[]}"#),
            "/api/work/sessions/sess_1": json(workingDetailJSON),
            "/api/work/sessions/sess_1/answer": json(#"{"error":"busy"}"#, status: 503),
        ])
        let model = NativeWorkModel(client: NativeWorkClient(transport: transport))

        await model.start(for: account)
        defer { model.stop() }
        let session = try XCTUnwrap(model.sessions.first)
        model.open(session)
        await settle(until: { model.openRun != nil })
        XCTAssertEqual(model.composerMode, .instruction)

        // Two failed sends of the same sentence: the second is the retry.
        await model.sendInstruction("Skip the archive folder")
        await model.sendInstruction("Skip the archive folder")
        var keys = await transport.instructionKeys
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys[0], keys[1], "a retry of the same words must not record twice")

        // A different sentence is a different instruction, failure or not.
        await model.sendInstruction("Actually, include it")
        keys = await transport.instructionKeys
        XCTAssertEqual(keys.count, 3)
        XCTAssertNotEqual(keys[2], keys[0])

        // Now let one land, and say the same thing again. That is a second
        // deliberate instruction and has to be recorded as one.
        await transport.answerInstructions(with: json(deliveredJSON))
        await model.sendInstruction("Skip the archive folder")
        await model.sendInstruction("Skip the archive folder")
        keys = await transport.instructionKeys
        XCTAssertEqual(keys.count, 5)
        XCTAssertNotEqual(keys[3], keys[4], "a delivered instruction does not hold its key")
    }

    /// The server's sentence is what reaches the reader, whichever way it went,
    /// and it survives on the model rather than being shown once and dropped.
    @MainActor
    func testTheServersExplanationIsWhatTheModelKeeps() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/sessions": json(sessionListJSON),
            "/api/work/hosts": json(#"{"hosts":[]}"#),
            "/api/work/sessions/sess_1": json(workingDetailJSON),
            "/api/work/sessions/sess_1/answer": json(undeliveredJSON),
        ])
        let model = NativeWorkModel(client: NativeWorkClient(transport: transport))

        await model.start(for: account)
        defer { model.stop() }
        let session = try XCTUnwrap(model.sessions.first)
        model.open(session)
        await settle(until: { model.openRun != nil })

        await model.sendInstruction("Skip the archive folder")

        let outcome = try XCTUnwrap(model.lastInstructionOutcome)
        XCTAssertFalse(outcome.delivered)
        XCTAssertEqual(
            outcome.explanation,
            "The Mac this attempt is running on is no longer paired.",
            "the route's own wording, so one failure does not get two phrasings"
        )

        // It belongs to the task it was about. Opening another must not carry a
        // warning about this one under that one's title.
        model.closeOpenSession()
        XCTAssertNil(model.lastInstructionOutcome)
    }

    // MARK: - Fixtures

    private func session(
        status: String,
        currentRunID: String? = "run_1"
    ) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: "sess_1", title: "Tidy the downloads folder", goal: "Sort it by kind",
            status: status, needsAttention: false, requestedTarget: "automatic",
            effectiveTarget: "cloud", hostID: nil, hostDisplayName: nil, pinned: false,
            archived: false, lastActivityAt: Date(timeIntervalSince1970: 1_000_000),
            currentRunID: currentRunID, lastSeq: 12
        )
    }

    private func run(status: String) -> WorkRunSummary {
        WorkRunSummary(
            runID: "run_1", sessionID: "sess_1", attempt: 1, status: status,
            terminalReason: nil, requestedTarget: "automatic", effectiveTarget: "cloud",
            hostID: nil, effectiveModel: nil, degradation: [], costMicroUsd: 0,
            maxCostMicroUsd: 0, lastSeq: 12, startedAt: nil, finishedAt: nil
        )
    }

    private func json(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }

    /// Waits for the model's own `open` task to reach a state, bounded so a
    /// broken expectation fails the test rather than hanging the suite.
    ///
    /// A poll rather than a hook because `open(_:)` deliberately exposes none:
    /// it starts a stream that is designed to outlive any one call, and a seam
    /// added here for the tests would be a seam the apps could wait on.
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

private let deliveredJSON = #"""
{"lastSeq":41,"replay":false,"delivered":true,\#
"explanation":"Juno reads this before its next step."}
"""#

private let undeliveredJSON = #"""
{"lastSeq":41,"replay":false,"delivered":false,\#
"explanation":"The Mac this attempt is running on is no longer paired."}
"""#

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

/// A run that is going and has asked nothing.
private let workingDetailJSON = #"""
{"session":{"id":"sess_1","title":"Tidy the downloads folder","goal":"Sort it by kind",\#
"status":"running","needsAttention":false,"requestedTarget":"cloud","effectiveTarget":"cloud",\#
"pinned":false,"archived":false,"lastActivityAt":"2026-08-05T10:00:00.000Z",\#
"currentRunId":"run_1","lastSeq":12},"run":\#(runJSON),\#
"events":[{"seq":12,"kind":"run_started","payload":{},"createdAt":"2026-08-05T10:00:00.000Z"}],\#
"approvals":[]}
"""#

/// The same run, stopped on a question nobody has answered.
private let askingDetailJSON = #"""
{"session":{"id":"sess_1","title":"Tidy the downloads folder","goal":"Sort it by kind",\#
"status":"waiting_input","needsAttention":true,"requestedTarget":"cloud",\#
"effectiveTarget":"cloud","pinned":false,"archived":false,\#
"lastActivityAt":"2026-08-05T10:00:00.000Z","currentRunId":"run_1","lastSeq":13},\#
"run":\#(runJSON),"events":[\#
{"seq":12,"kind":"run_started","payload":{},"createdAt":"2026-08-05T10:00:00.000Z"},\#
{"seq":13,"kind":"question_asked","payload":{"questionId":"q_1","text":"Which invoice?"},\#
"createdAt":"2026-08-05T10:00:05.000Z"}],"approvals":[]}
"""#

// MARK: - Doubles

/// Answers by path, and remembers the idempotency keys the answer route was
/// sent.
///
/// The keys are the point of half of these tests, so they are read back rather
/// than inferred from the number of requests: two sends under one key are the
/// correct behaviour for a retry and would be indistinguishable from a bug by
/// counting alone.
private actor WorkTransport: NativeWorkTransport {
    private var routes: [String: HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(routes: [String: HTTPResponse] = [:]) {
        self.routes = routes
    }

    /// The keys sent to the answer route, in order.
    var instructionKeys: [String] {
        requests.compactMap { request in
            guard request.path.hasSuffix("/answer"), let body = request.body,
                let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
            else { return nil }
            return object["idempotencyKey"] as? String
        }
    }

    /// Changes what the answer route says from here on, so one test can cover a
    /// failure and the success that follows it.
    func answerInstructions(with response: HTTPResponse) {
        routes["/api/work/sessions/sess_1/answer"] = response
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        guard let response = routes[request.path] else {
            return HTTPResponse(
                statusCode: 500, headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
            )
        }
        return response
    }

    /// No stream fixture at all: these tests are about requests that change
    /// something, and the model's follow loop reads the authoritative detail
    /// before it ever opens one. A stream that refuses simply leaves it
    /// reconnecting in the background, which is what it does in the field.
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
