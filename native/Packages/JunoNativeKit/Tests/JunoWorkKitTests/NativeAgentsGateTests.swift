import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoWorkKit

/// An agent's page answering what its tasks are stopped at, and the roster's
/// two new readings: the sidebar's order and the moment an agent starts
/// needing the person.
///
/// The gates are read from each task's run — the stream's first frame, the
/// same one the task's thread starts from — and answered through the Work
/// client's own routes. So what these tests pin is that the page and the
/// thread cannot disagree: the question is the log's, the approval goes back
/// with the digest that was on screen, and a card answered here does not come
/// back because a read that left before the answer still listed it.
final class NativeAgentsGateTests: XCTestCase {
    private let account = try! AccountID("account-a")

    // MARK: - A run's open question

    /// Either executor's shape, read without opening the run in a Work model.
    func testAnyRunsLogYieldsItsOpenQuestion() {
        let flat = [
            event(1, "question_asked", ["questionId": .string("q_1"), "text": .string("Which invoice?")]),
        ]
        let nested = [
            event(1, "question_asked", [
                "question": .object(["id": .string("q_1"), "question": .string("Which invoice?")]),
            ]),
        ]
        let expected = WorkQuestionPrompt(questionID: "q_1", text: "Which invoice?")
        XCTAssertEqual(NativeWorkModel.pendingQuestion(in: flat), expected)
        XCTAssertEqual(NativeWorkModel.pendingQuestion(in: nested), expected)
    }

    /// An answer given anywhere closes the question, whichever shape asked it.
    func testAnAnsweredQuestionIsNoLongerOpen() {
        let events = [
            event(1, "question_asked", [
                "question": .object(["id": .string("q_1"), "question": .string("Which invoice?")]),
            ]),
            event(2, "question_answered", ["questionId": .string("q_1"), "text": .string("The 2025 one")]),
        ]
        XCTAssertNil(NativeWorkModel.pendingQuestion(in: events))
    }

    /// Two open questions: the newer one is what the run is waiting on.
    func testTheNewestOpenQuestionIsTheOneAsked() {
        let asked = [
            event(1, "question_asked", ["questionId": .string("q_1"), "text": .string("First?")]),
            event(2, "question_asked", ["questionId": .string("q_2"), "text": .string("Second?")]),
        ]
        XCTAssertEqual(NativeWorkModel.pendingQuestion(in: asked)?.questionID, "q_2")

        let secondAnswered = asked + [
            event(3, "question_answered", ["questionId": .string("q_2"), "text": .string("Yes")]),
        ]
        XCTAssertEqual(NativeWorkModel.pendingQuestion(in: secondAnswered)?.questionID, "q_1")
    }

    // MARK: - The sidebar

    /// Waiting first, then hire order — not the roster's rank by every state,
    /// which would move a row each time an agent started or finished
    /// something. Ties keep the server's order.
    func testTheSidebarPutsWaitingFirstThenHireOrder() async throws {
        let agents = try await roster([
            agentJSON(id: "a", sortOrder: 2, state: "working"),
            agentJSON(id: "b", sortOrder: 0, state: "idle"),
            agentJSON(id: "c", sortOrder: 3, state: "waiting"),
            agentJSON(id: "d", sortOrder: 1, state: "done"),
            agentJSON(id: "e", sortOrder: 1, state: "waiting"),
            agentJSON(id: "f", sortOrder: 1, state: "idle"),
        ])
        XCTAssertEqual(NativeAgentsModel.sidebarOrder(agents).map(\.id), ["e", "c", "b", "d", "f", "a"])
    }

    /// The first read is a state, not a change: an app that opens onto an
    /// agent already waiting has not just been asked anything.
    func testTheFirstReadIsNotARise() async throws {
        let agents = try await roster([agentJSON(id: "a", state: "waiting")])
        XCTAssertTrue(NativeAgentsModel.newlyWaiting(previous: nil, current: agents).isEmpty)
        XCTAssertEqual(NativeAgentsModel.newlyWaiting(previous: [], current: agents).map(\.id), ["a"])
        XCTAssertTrue(NativeAgentsModel.newlyWaiting(previous: ["a"], current: agents).isEmpty)
    }

    @MainActor
    func testANeedsYouRiseIsReportedOnceBetweenReads() async throws {
        let transport = AgentsTransport(routes: [
            "/api/agents": json(rosterJSON([
                agentJSON(id: "a", state: "waiting"),
                agentJSON(id: "b", state: "working"),
            ])),
        ])
        let model = NativeAgentsModel(client: NativeAgentsClient(sender: transport))
        let recorder = RiseRecorder()
        model.onNeedsYouRise = { agent in recorder.ids.append(agent.id) }

        await model.start(for: account)
        defer { model.stop() }
        XCTAssertEqual(recorder.ids, [], "Already waiting at the first read is not a rise.")

        await transport.setRoute("/api/agents", json(rosterJSON([
            agentJSON(id: "a", state: "waiting"),
            agentJSON(id: "b", state: "waiting"),
        ])))
        await model.refresh()
        XCTAssertEqual(recorder.ids, ["b"])

        await model.refresh()
        XCTAssertEqual(recorder.ids, ["b"], "Still waiting is not a second rise.")
    }

    // MARK: - Gates

    @MainActor
    func testAWaitingTasksApprovalIsReadFromItsRun() async throws {
        let (model, _) = await openedModel(
            status: "waiting_approval",
            snapshot: snapshotSSE(status: "waiting_approval", events: toolEventsJSON, approvals: "[\(approvalJSON())]")
        )
        defer { model.stop() }

        let gate = try XCTUnwrap(model.gates["agent_1"]?.first)
        XCTAssertEqual(gate.id, "sess_1")
        XCTAssertEqual(gate.runID, "run_1", "A Mac-hosted run's approvals are found by it.")
        XCTAssertEqual(gate.approvals.map(\.approvalID), ["appr_1"])
        XCTAssertNil(gate.question)
        XCTAssertEqual(model.computers["agent_1"]?.lines.map(\.title), ["Read a file"])
        XCTAssertEqual(model.computers["agent_1"]?.isLive, true)
    }

    /// The whole request goes back: the decision and the digest of the exact
    /// action that was on screen, to the same route the thread's card uses.
    @MainActor
    func testAnApprovalIsAnsweredWithTheDigestItShowed() async throws {
        let denied = approvalJSON(decision: "denied")
        let (model, transport) = await openedModel(
            status: "waiting_approval",
            snapshot: snapshotSSE(status: "waiting_approval", events: "[]", approvals: "[\(approvalJSON())]"),
            routes: ["/api/work/approvals/appr_1/decision": json(#"{"approval":\#(denied)}"#)]
        )
        defer { model.stop() }

        let approval = try XCTUnwrap(model.gates["agent_1"]?.first?.approvals.first)
        await model.decide(agentID: "agent_1", approval, .denied)

        let requests = await transport.requests
        let sent = try XCTUnwrap(requests.last(where: { $0.path == "/api/work/approvals/appr_1/decision" }))
        XCTAssertEqual(sent.method, .post)
        let fields = try object(sent.body)
        XCTAssertEqual(fields["decision"]?.stringValue, "denied")
        XCTAssertEqual(fields["actionDigest"]?.stringValue, "digest-abc")
        XCTAssertNil(model.lastErrorDescription)
        // The fixture's run still lists it, as a read that left before the
        // answer landed would. It stays answered.
        XCTAssertEqual(model.gates["agent_1"]?.first?.approvals.count, 0)
        XCTAssertFalse(model.isAnswering("appr_1"))
    }

    /// A refused answer puts the card back while it can still be answered,
    /// with the server's own sentence.
    @MainActor
    func testAFailedAnswerPutsTheApprovalBack() async throws {
        let (model, _) = await openedModel(
            status: "waiting_approval",
            snapshot: snapshotSSE(status: "waiting_approval", events: "[]", approvals: "[\(approvalJSON())]"),
            routes: [
                "/api/work/approvals/appr_1/decision": json(
                    #"{"error":"already_decided","message":"Someone already answered this."}"#,
                    status: 409
                ),
            ]
        )
        defer { model.stop() }

        let approval = try XCTUnwrap(model.gates["agent_1"]?.first?.approvals.first)
        await model.decide(agentID: "agent_1", approval, .allowed)

        XCTAssertEqual(model.gates["agent_1"]?.first?.approvals.map(\.approvalID), ["appr_1"])
        XCTAssertEqual(model.lastErrorDescription, "Someone already answered this.")
    }

    /// The question is the log's, and the reply names it.
    @MainActor
    func testAQuestionIsAnsweredByItsIdentifier() async throws {
        let asking = #"""
        [{"seq":1,"kind":"question_asked","payload":{"question":{"id":"q_1","question":"Which invoice did you mean?"}},"createdAt":"2026-08-05T10:00:05.000Z"}]
        """#
        let (model, transport) = await openedModel(
            status: "waiting_input",
            snapshot: snapshotSSE(status: "waiting_input", events: asking, approvals: "[]"),
            routes: ["/api/work/sessions/sess_1/answer": json(#"{"ok":true}"#)]
        )
        defer { model.stop() }

        let question = try XCTUnwrap(model.gates["agent_1"]?.first?.question)
        XCTAssertEqual(question.questionID, "q_1")
        XCTAssertEqual(question.text, "Which invoice did you mean?")

        let landed = await model.answer(
            agentID: "agent_1",
            sessionID: "sess_1",
            question: question,
            text: "  The 2025 one  "
        )
        XCTAssertTrue(landed)

        let requests = await transport.requests
        let sent = try XCTUnwrap(requests.last(where: { $0.path == "/api/work/sessions/sess_1/answer" }))
        let fields = try object(sent.body)
        XCTAssertEqual(fields["questionId"]?.stringValue, "q_1")
        XCTAssertEqual(fields["text"]?.stringValue, "The 2025 one")
        XCTAssertNil(model.gates["agent_1"]?.first?.question, "An answered question stays answered.")
    }

    /// A connection that will not carry a stream still gets the approvals,
    /// from the plain session read. It cannot get the log, so no question.
    @MainActor
    func testARefusedStreamStillReadsTheApprovals() async throws {
        let session = sessionJSON(status: "waiting_approval")
        let run = runJSON(status: "waiting_approval")
        let approval = approvalJSON()
        let detail = #"{"session":\#(session),"run":\#(run),"approvals":[\#(approval)]}"#
        let (model, _) = await openedModel(
            status: "waiting_approval",
            snapshot: nil,
            routes: ["/api/work/sessions/sess_1": json(detail)]
        )
        defer { model.stop() }

        let gate = try XCTUnwrap(model.gates["agent_1"]?.first)
        XCTAssertEqual(gate.approvals.map(\.approvalID), ["appr_1"])
        XCTAssertNil(gate.question)
    }

    /// Without a Work client the page reads nothing and says where to answer.
    @MainActor
    func testWithoutAWorkClientNothingIsRead() async throws {
        let transport = AgentsTransport(routes: agentRoutes(status: "waiting_approval"))
        let model = NativeAgentsModel(client: NativeAgentsClient(sender: transport))
        await model.start(for: account)
        defer { model.stop() }
        await model.loadDetail(id: "agent_1")
        await model.loadGates(agentID: "agent_1")

        XCTAssertFalse(model.canAnswerInPlace)
        XCTAssertNil(model.gates["agent_1"])
        let requests = await transport.requests
        XCTAssertFalse(requests.contains { $0.path.hasPrefix("/api/work/") })
    }

    // MARK: - Its computer

    func testCallsArePairedStartToEnd() {
        let lines = NativeAgentComputerFeed.lines(from: [
            event(1, "tool_started", ["tool": .string("read_file"), "callId": .string("c1")]),
            event(2, "tool_started", [
                "tool": .string("web_search"),
                "callId": .string("c2"),
                "summary": .string("Searching for flights to Lisbon"),
            ]),
            event(3, "tool_finished", ["tool": .string("read_file"), "callId": .string("c1")]),
            event(4, "assistant_message", ["text": .string("Nearly there.")]),
            // The Mac writes a refusal with no call id: it ends the newest
            // open call of the same tool.
            event(5, "tool_started", ["tool": .string("apply_changes")]),
            event(6, "tool_denied", ["tool": .string("apply_changes"), "reason": .string("Refused")]),
            event(7, "tool_started", ["tool": .string("read_file"), "callId": .string("c3")]),
            event(8, "tool_finished", ["tool": .string("read_file"), "callId": .string("c3"), "isError": .bool(true)]),
        ])
        let expectedStates: [NativeAgentComputerLine.State] = [.done, .running, .refused, .failed]
        XCTAssertEqual(lines.map(\.id), [1, 2, 5, 7])
        XCTAssertEqual(lines.map(\.state), expectedStates)
        XCTAssertEqual(lines.map(\.title), [
            "Read a file",
            "Searching for flights to Lisbon",
            "Change files",
            "Read a file",
        ])
    }

    /// A run that stopped with a call open says the call never reported back,
    /// rather than leaving it running on the record.
    func testARunThatStopsLeavesNoCallRunning() {
        let lines = NativeAgentComputerFeed.lines(from: [
            event(1, "tool_started", ["tool": .string("browser"), "callId": .string("c1")]),
            event(2, "run_finished", [:]),
        ])
        let expectedStates: [NativeAgentComputerLine.State] = [.unreported]
        XCTAssertEqual(lines.map(\.state), expectedStates)
        XCTAssertEqual(lines.first?.title, "Using a web page")
    }

    func testOnlyTheLatestCallsAreShown() {
        var events: [WorkEvent] = []
        for seq in 1...10 {
            events.append(event(seq, "tool_started", ["tool": .string("read_file"), "callId": .string("c\(seq)")]))
        }
        XCTAssertEqual(NativeAgentComputerFeed.lines(from: events).map(\.id), [5, 6, 7, 8, 9, 10])
    }

    // MARK: - Activity

    /// A line about a run opens it; a line in a kind this build has never
    /// heard of is still a line, in words.
    func testActivityLinesAboutARunAreKnownByKind() {
        XCTAssertTrue(activity(kind: "handed_off", sessionID: "sess_1").isAboutARun)
        XCTAssertTrue(activity(kind: "handoff_received", sessionID: "sess_1").isAboutARun)
        XCTAssertTrue(activity(kind: "approval", sessionID: "sess_1").isAboutARun)
        XCTAssertTrue(activity(kind: "task_completed", sessionID: "sess_1").isAboutARun)
        XCTAssertFalse(activity(kind: "handed_off", sessionID: nil).isAboutARun)
        XCTAssertFalse(activity(kind: "goal_set", sessionID: "sess_1").isAboutARun)

        XCTAssertEqual(NativeAgentActivity.fallbackTitle(for: "handed_off"), "Handed a task to a teammate")
        XCTAssertEqual(NativeAgentActivity.fallbackTitle(for: "task_failed"), "Worked on a task")
        XCTAssertEqual(NativeAgentActivity.fallbackTitle(for: "room_opened"), "Room opened")
    }

    // MARK: - Fixtures

    /// A started model with agent_1's page loaded and its gates read once.
    @MainActor
    private func openedModel(
        status: String,
        snapshot: Data?,
        routes extra: [String: HTTPResponse] = [:]
    ) async -> (NativeAgentsModel, AgentsTransport) {
        var routes = agentRoutes(status: status)
        for (path, response) in extra {
            routes[path] = response
        }
        var streams: [String: Data] = [:]
        if let snapshot {
            streams["/api/work/sessions/sess_1/events"] = snapshot
        }
        let transport = AgentsTransport(routes: routes, streams: streams)
        let model = NativeAgentsModel(
            client: NativeAgentsClient(sender: transport),
            workClient: NativeWorkClient(transport: transport)
        )
        await model.start(for: account)
        await model.loadDetail(id: "agent_1")
        await model.loadGates(agentID: "agent_1")
        return (model, transport)
    }

    private func agentRoutes(status: String) -> [String: HTTPResponse] {
        let task = taskJSON(status: status)
        let agent = agentJSON(id: "agent_1", state: "waiting", needsYou: 1, task: task)
        return [
            "/api/agents": json(rosterJSON([agent])),
            "/api/agents/agent_1": json(
                #"{"agent":\#(agent),"goals":[],"ideas":[],"notes":[],"routines":[],"tasks":[\#(task)]}"#
            ),
        ]
    }

    private func roster(_ agents: [String]) async throws -> [NativeAgent] {
        let transport = AgentsTransport(routes: ["/api/agents": json(rosterJSON(agents))])
        return try await NativeAgentsClient(sender: transport).agents(for: account)
    }

    private func agentJSON(
        id: String,
        sortOrder: Int = 0,
        state: String = "idle",
        needsYou: Int = 0,
        task: String? = nil
    ) -> String {
        let taskField = task.map { #","task":\#($0)"# } ?? ""
        return #"""
        {"id":"\#(id)","name":"Agent \#(id)","role":"","conversationId":"conv_\#(id)",\#
        "status":"active","sortOrder":\#(sortOrder),"createdAt":"2026-08-05T09:00:00.000Z",\#
        "updatedAt":"2026-08-05T09:00:00.000Z","state":"\#(state)","stateSentence":"",\#
        "needsYou":\#(needsYou)\#(taskField)}
        """#
    }

    private func rosterJSON(_ agents: [String]) -> String {
        #"{"agents":["# + agents.joined(separator: ",") + "]}"
    }

    private func taskJSON(status: String) -> String {
        #"""
        {"sessionId":"sess_1","title":"Tidy the downloads folder","status":"\#(status)",\#
        "needsAttention":true,"lastActivityAt":"2026-08-05T10:00:00.000Z","conversationId":"conv_1"}
        """#
    }

    private func sessionJSON(status: String) -> String {
        #"""
        {"id":"sess_1","title":"Tidy the downloads folder","goal":"","status":"\#(status)",\#
        "needsAttention":true,"requestedTarget":"cloud","pinned":false,"archived":false,\#
        "lastActivityAt":"2026-08-05T10:00:00.000Z","currentRunId":"run_1","lastSeq":3}
        """#
    }

    private func runJSON(status: String) -> String {
        #"""
        {"id":"run_1","sessionId":"sess_1","status":"\#(status)","attempt":1,\#
        "requestedTarget":"cloud","lastSeq":3}
        """#
    }

    private func approvalJSON(decision: String = "pending") -> String {
        #"""
        {"id":"appr_1","runId":"run_1","action":"work.connector.send_message","risk":"irreversible",\#
        "summary":"Send the reply to Dana","detail":{},"actionDigest":"digest-abc",\#
        "expiresAt":"2999-01-01T00:00:00.000Z","decision":"\#(decision)"}
        """#
    }

    private var toolEventsJSON: String {
        #"""
        [{"seq":1,"kind":"run_started","payload":{},"createdAt":"2026-08-05T10:00:00.000Z"},\#
        {"seq":2,"kind":"tool_started","payload":{"tool":"read_file","callId":"c1"},\#
        "createdAt":"2026-08-05T10:00:01.000Z"},\#
        {"seq":3,"kind":"tool_finished","payload":{"tool":"read_file","callId":"c1"},\#
        "createdAt":"2026-08-05T10:00:02.000Z"}]
        """#
    }

    /// The first frame of the session stream, as the route writes it.
    private func snapshotSSE(status: String, events: String, approvals: String) -> Data {
        let session = sessionJSON(status: status)
        let run = runJSON(status: status)
        let frame = #"""
        {"type":"snapshot","session":\#(session),"run":\#(run),\#
        "events":\#(events),"approvals":\#(approvals)}
        """#
        return Data("data: \(frame)\n\n".utf8)
    }

    private func event(_ seq: Int, _ kind: String, _ payload: [String: JunoJSONValue]) -> WorkEvent {
        WorkEvent(
            seq: seq,
            kind: kind,
            payload: payload,
            agentID: nil,
            createdAt: Date(timeIntervalSince1970: 1_000_000 + Double(seq))
        )
    }

    private func activity(kind: String, sessionID: String?) -> NativeAgentActivity {
        NativeAgentActivity(
            id: "line_1",
            kind: kind,
            title: "A line",
            detail: nil,
            at: nil,
            sessionID: sessionID,
            tone: .neutral
        )
    }

    private func object(_ body: Data?) throws -> [String: JunoJSONValue] {
        let data = try XCTUnwrap(body)
        guard case .object(let fields) = try JSONDecoder().decode(JunoJSONValue.self, from: data) else {
            XCTFail("the request body is not an object")
            return [:]
        }
        return fields
    }

    private func json(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

// MARK: - Doubles

@MainActor
private final class RiseRecorder {
    var ids: [String] = []
}

/// Serves the agents routes and the Work routes by path, and the session
/// stream from a scripted body. A path with no stream answers 503, which is
/// how a proxy that refuses `text/event-stream` looks to the client.
private actor AgentsTransport: NativeWorkTransport {
    private var routes: [String: HTTPResponse]
    private let streams: [String: Data]
    private(set) var requests: [NativeBearerRequest] = []

    init(routes: [String: HTTPResponse] = [:], streams: [String: Data] = [:]) {
        self.routes = routes
        self.streams = streams
    }

    func setRoute(_ path: String, _ response: HTTPResponse) {
        routes[path] = response
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        return routes[request.path]
            ?? HTTPResponse(
                statusCode: 500, headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
            )
    }

    func stream(
        _ request: NativeBearerRequest, for _: AccountID
    ) async throws -> HTTPByteStreamResponse {
        requests.append(request)
        guard let body = streams[request.path] else {
            return HTTPByteStreamResponse(
                statusCode: 503,
                headers: try HTTPHeaders(["content-type": "application/json"]),
                bytes: AsyncThrowingStream { $0.finish() }
            )
        }
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "text/event-stream; charset=utf-8"]),
            bytes: AsyncThrowingStream { continuation in
                for byte in body { continuation.yield(byte) }
                continuation.finish()
            }
        )
    }
}
