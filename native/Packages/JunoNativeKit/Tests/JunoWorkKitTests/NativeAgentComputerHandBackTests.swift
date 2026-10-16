import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoWorkKit

/// Take over and hand back in the apps, against the same cases as the web.
///
/// Hand back used to answer the first open question with "Done. I've finished
/// on your computer; continue.", on Close and on going to the background as
/// well, so taking control to fetch a 2FA code from an authenticator app told
/// the agent to carry on before the code was typed, and opening and closing
/// Take control answered whatever unrelated question was open. The rules are
/// now the web's (src/lib/agents/computer-handback.ts), read from one fixture.
final class NativeAgentComputerHandBackTests: XCTestCase {
    private let account = try! AccountID("account-a")

    // MARK: - The shared fixture

    private struct Fixture: Decodable {
        struct Question: Decodable {
            let id: String
            let question: String
            let why: String?
        }

        struct TakeoverCase: Decodable {
            let question: String
            let expected: Bool
        }

        struct HandBackCase: Decodable {
            let name: String
            let openAtTakeControl: [String]?
            let openAtHandBack: [String]
            let expected: String?
        }

        let answer: String
        let questions: [String: Question]
        let isTakeover: [TakeoverCase]
        let handBack: [HandBackCase]
    }

    /// The repository root, from this file: Tests/JunoWorkKitTests/<file>.
    private static func repositoryFile(_ path: String, file: StaticString = #filePath) -> URL {
        var url = URL(fileURLWithPath: "\(file)")
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url.appendingPathComponent(path)
    }

    private func fixture() throws -> Fixture {
        let data = try Data(contentsOf: Self.repositoryFile("tests/fixtures/computer-handback-cases.json"))
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    private func candidate(_ key: String, in fixture: Fixture) throws -> NativeComputerHandBack.Candidate {
        let question = try XCTUnwrap(fixture.questions[key], "no question \(key) in the fixture")
        return .init(id: question.id, question: question.question, why: question.why)
    }

    func testTheAnswerIsTheWebsVerbatim() throws {
        XCTAssertEqual(NativeComputerHandBack.answer, try fixture().answer)
        XCTAssertEqual(NativeComputerHandBack.answer, "Done. I've finished on your computer; continue.")
    }

    func testTheSameQuestionsAskForTheComputerAsOnTheWeb() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.isTakeover.isEmpty)
        for c in fixture.isTakeover {
            XCTAssertEqual(
                NativeComputerHandBack.isTakeoverQuestion(try candidate(c.question, in: fixture)),
                c.expected,
                c.question
            )
        }
    }

    func testHandBackAnswersTheSameQuestionAsTheWebOrNone() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.handBack.isEmpty)
        for c in fixture.handBack {
            let pin = try c.openAtTakeControl.map { keys in
                NativeComputerHandBack.pin(try keys.map { try candidate($0, in: fixture) })
            }
            let open = try c.openAtHandBack.map { try candidate($0, in: fixture) }
            let expected = try c.expected.map { try candidate($0, in: fixture).id }
            XCTAssertEqual(NativeComputerHandBack.question(open, pin: pin)?.id, expected, c.name)
        }
    }

    // MARK: - The state sentences

    func testStateSentencesMatchTheWebsTable() throws {
        let data = try Data(contentsOf: Self.repositoryFile("src/lib/agents/computer-state-copy.json"))
        let copy = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        func fill(_ key: String, _ values: [String: String] = [:]) -> String {
            var text = (copy[key] as? String) ?? ""
            for (name, value) in values { text = text.replacingOccurrences(of: "{\(name)}", with: value) }
            return text
        }
        let idle = try XCTUnwrap(copy["idle"] as? [String: String])
        let control = try XCTUnwrap(copy["controlHere"] as? [String: String])

        XCTAssertEqual(NativeAgentComputerSentence.asleep(agentName: "Mira"), fill("asleep", ["agent": "Mira"]))
        XCTAssertEqual(NativeAgentComputerSentence.starting, fill("starting"))
        XCTAssertEqual(NativeAgentComputerSentence.resting, fill("resting"))
        XCTAssertEqual(NativeAgentComputerSentence.stopping, fill("stopping"))
        XCTAssertEqual(NativeAgentComputerSentence.error, fill("error"))
        XCTAssertEqual(NativeAgentComputerSentence.idleUnknown, fill("idleUnknown"))
        XCTAssertEqual(NativeAgentComputerSentence.heldByOtherDevice, fill("heldByOtherDevice"))
        XCTAssertEqual(NativeAgentComputerSentence.heldByWeb, fill("heldByWeb"))
        XCTAssertEqual(NativeAgentComputerSentence.handedBack, fill("handedBack"))
        XCTAssertEqual(NativeAgentComputerSentence.takenBack(agentName: "Mira"), fill("takenBack", ["agent": "Mira"]))
        XCTAssertEqual(
            NativeAgentComputerSentence.using(agentName: "Mira", summary: "Open example.com"),
            fill("using", ["agent": "Mira", "summary": "Open example.com"])
        )
        XCTAssertEqual(NativeAgentComputerSentence.idle(restMinutes: 3), idle["other"]?.replacingOccurrences(of: "{minutes}", with: "3"))
        XCTAssertEqual(NativeAgentComputerSentence.idle(restMinutes: 1), idle["one"]?.replacingOccurrences(of: "{minutes}", with: "1"))
        XCTAssertEqual(NativeAgentComputerSentence.idle(restMinutes: nil), fill("idleUnknown"))
        #if os(iOS)
        let here = control["ios"]
        #else
        let here = control["macos"]
        #endif
        XCTAssertEqual(NativeAgentComputerSentence.controlHere(agentName: "Mira"), here?.replacingOccurrences(of: "{agent}", with: "Mira"))
        // Only the statuses the server sends; "waking" is not one of them.
        XCTAssertEqual(
            NativeAgentComputerSentence.sentence(status: "waking", agentName: "Mira", restMinutes: 3, usingNow: nil),
            fill("asleep", ["agent": "Mira"])
        )
    }

    // MARK: - The takeover on the payload

    func testTheHeartbeatDecodesWhoHoldsControlAndTheRestTime() async throws {
        let transport = ComputerTransport(routes: [
            "/api/agents/agent_1/computer/heartbeat": json(
                #"{"computer":{"enabled":true,"status":"awake","hasPoster":false,"usingNow":null,"error":null,"activeSeconds":0,"streamOn":true,"takeover":{"active":true,"holderKind":"app","until":"2026-10-16T10:01:00.000Z"},"restMinutes":3}}"#
            ),
        ])
        let reading = try await NativeAgentsClient(sender: transport)
            .computerHeartbeatReading(agentID: "agent_1", mode: "control", for: account)
        XCTAssertEqual(reading.computer?.status, "awake")
        XCTAssertEqual(reading.takeover?.active, true)
        XCTAssertEqual(reading.takeover?.holderKind, .app)
        XCTAssertNotNil(reading.takeover?.until)
        XCTAssertEqual(reading.restMinutes, 3)
    }

    func testControlHeldByAnotherClientIsItsOwnFailureWithTheServersSentence() async throws {
        let transport = ComputerTransport(routes: [
            "/api/agents/agent_1/computer/heartbeat": json(
                #"{"error":"held_elsewhere","message":"A browser has control of this computer right now. Hand back there first.","computer":{"enabled":true,"status":"awake","takeover":{"active":true,"holderKind":"web","until":null}}}"#,
                status: 409
            ),
        ])
        do {
            _ = try await NativeAgentsClient(sender: transport)
                .computerHeartbeatReading(agentID: "agent_1", mode: "control", ended: true, for: account)
            XCTFail("a 409 held_elsewhere is not a hand back")
        } catch let held as NativeAgentComputerHeldElsewhere {
            XCTAssertEqual(held.message, "A browser has control of this computer right now. Hand back there first.")
            XCTAssertEqual(held.reading.takeover?.holderKind, .web)
        }
    }

    // MARK: - Hand back in the model

    /// The bug, as two presses: Take control with an unrelated question open,
    /// then Close and Hand back. Nothing is answered.
    @MainActor
    func testTakingControlWithAnUnrelatedQuestionOpenAnswersNothing() async throws {
        let (model, transport) = await openedModel(question: "Which folder should I save the report in?")
        defer { model.stop() }
        XCTAssertNotNil(model.gates["agent_1"]?.first?.question)

        model.pinComputerTakeover(agentID: "agent_1")
        XCTAssertEqual(model.computerTakeoverPins["agent_1"]?.questionID, nil)
        let handed = await model.computerHandBack(agentID: "agent_1")

        XCTAssertTrue(handed)
        let requests = await transport.requests
        XCTAssertTrue(requests.contains { $0.path == "/api/agents/agent_1/computer/heartbeat" })
        XCTAssertFalse(
            requests.contains { $0.path == "/api/work/sessions/sess_1/answer" },
            "an unrelated question is the person's to answer"
        )
        XCTAssertNotNil(model.gates["agent_1"]?.first?.question, "the folder question is still open")
        XCTAssertNil(model.computerTakeoverPins["agent_1"])
    }

    /// The takeover question pinned at Take control is the one answered, with
    /// the web's words exactly.
    @MainActor
    func testHandBackAnswersOnlyThePinnedTakeoverQuestion() async throws {
        let (model, transport) = await openedModel(question: "Could you take over my computer and sign in to the bank?")
        defer { model.stop() }

        model.pinComputerTakeover(agentID: "agent_1")
        XCTAssertEqual(model.computerTakeoverPins["agent_1"]?.questionID, "q_1")
        await model.computerHandBack(agentID: "agent_1")

        let requests = await transport.requests
        let answer = try XCTUnwrap(requests.last { $0.path == "/api/work/sessions/sess_1/answer" })
        let fields = try object(answer.body)
        XCTAssertEqual(fields["questionId"]?.stringValue, "q_1")
        XCTAssertEqual(fields["text"]?.stringValue, NativeComputerHandBack.answer)
        let ended = try object(try XCTUnwrap(requests.last { $0.path == "/api/agents/agent_1/computer/heartbeat" }).body)
        XCTAssertEqual(ended["ended"]?.boolValue, true)
    }

    /// Another client holds control: there was nothing to hand back here, and
    /// nothing is answered on its behalf.
    @MainActor
    func testAHandBackRefusedByTheServerAnswersNothing() async throws {
        let (model, transport) = await openedModel(
            question: "Could you take over my computer and sign in to the bank?",
            heartbeat: json(
                #"{"error":"held_elsewhere","message":"A browser has control of this computer right now. Hand back there first."}"#,
                status: 409
            )
        )
        defer { model.stop() }

        model.pinComputerTakeover(agentID: "agent_1")
        let handed = await model.computerHandBack(agentID: "agent_1")

        XCTAssertFalse(handed)
        let requests = await transport.requests
        XCTAssertFalse(requests.contains { $0.path == "/api/work/sessions/sess_1/answer" })
        XCTAssertEqual(model.lastErrorDescription, "A browser has control of this computer right now. Hand back there first.")
    }

    // MARK: - Fixtures

    @MainActor
    private func openedModel(
        question: String,
        heartbeat: HTTPResponse? = nil
    ) async -> (NativeAgentsModel, ComputerTransport) {
        let task = #"""
        {"sessionId":"sess_1","title":"Pay the electricity bill","status":"waiting_input",\#
        "needsAttention":true,"lastActivityAt":"2026-10-16T10:00:00.000Z","conversationId":"conv_1"}
        """#
        let agent = #"""
        {"id":"agent_1","name":"Mira","role":"","conversationId":"conv_agent_1",\#
        "status":"active","sortOrder":0,"createdAt":"2026-10-16T09:00:00.000Z",\#
        "updatedAt":"2026-10-16T09:00:00.000Z","state":"waiting","stateSentence":"",\#
        "needsYou":1,"task":\#(task)}
        """#
        let session = #"""
        {"id":"sess_1","title":"Pay the electricity bill","goal":"","status":"waiting_input",\#
        "needsAttention":true,"requestedTarget":"cloud","pinned":false,"archived":false,\#
        "lastActivityAt":"2026-10-16T10:00:00.000Z","currentRunId":"run_1","lastSeq":1}
        """#
        let run = #"""
        {"id":"run_1","sessionId":"sess_1","status":"waiting_input","attempt":1,\#
        "requestedTarget":"cloud","lastSeq":1}
        """#
        let events = #"""
        [{"seq":1,"kind":"question_asked","payload":{"question":{"id":"q_1","question":"\#(question)"}},"createdAt":"2026-10-16T10:00:05.000Z"}]
        """#
        let frame = #"""
        {"type":"snapshot","session":\#(session),"run":\#(run),"events":\#(events),"approvals":[]}
        """#
        let routes: [String: HTTPResponse] = [
            "/api/agents": json(#"{"agents":[\#(agent)]}"#),
            "/api/agents/agent_1": json(
                #"{"agent":\#(agent),"goals":[],"ideas":[],"notes":[],"routines":[],"tasks":[\#(task)]}"#
            ),
            "/api/agents/agent_1/computer/heartbeat": heartbeat ?? json(
                #"{"computer":{"enabled":true,"status":"awake","takeover":{"active":false,"holderKind":null,"until":null},"restMinutes":3}}"#
            ),
            "/api/work/sessions/sess_1/answer": json(#"{"ok":true}"#),
        ]
        let transport = ComputerTransport(
            routes: routes,
            streams: ["/api/work/sessions/sess_1/events": Data("data: \(frame)\n\n".utf8)]
        )
        let model = NativeAgentsModel(
            client: NativeAgentsClient(sender: transport),
            workClient: NativeWorkClient(transport: transport)
        )
        await model.start(for: account)
        await model.loadDetail(id: "agent_1")
        await model.loadGates(agentID: "agent_1")
        return (model, transport)
    }

    private func json(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }

    private func object(_ body: Data?) throws -> [String: JunoJSONValue] {
        let data = try XCTUnwrap(body)
        guard case .object(let fields) = try JSONDecoder().decode(JunoJSONValue.self, from: data) else {
            XCTFail("the request body is not an object")
            return [:]
        }
        return fields
    }
}

/// Serves the agents and Work routes by path, and the session stream from a
/// scripted body.
private actor ComputerTransport: NativeWorkTransport {
    private let routes: [String: HTTPResponse]
    private let streams: [String: Data]
    private(set) var requests: [NativeBearerRequest] = []

    init(routes: [String: HTTPResponse] = [:], streams: [String: Data] = [:]) {
        self.routes = routes
        self.streams = streams
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        return routes[request.path]
            ?? HTTPResponse(statusCode: 500, headers: HTTPHeaders(), body: Data(#"{"error":"missing fixture"}"#.utf8))
    }

    func stream(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPByteStreamResponse {
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
