import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoWorkKit

final class NativeAgentComputerRefreshTests: XCTestCase {
    private let account = try! AccountID("account-a")
    private let path = "/api/agents/agent_1/computer"

    @MainActor
    func testACompleteReadRemovesAComputerAndItsOldControlState() async throws {
        let (model, transport) = await openedModel()
        defer { model.stop() }
        await transport.setRoute(path, json(#"{"computer":{"enabled":true,"status":"awake","takeover":{"active":true,"holderKind":"web"},"restMinutes":3},"access":{"ok":true}}"#))
        let first = await model.refreshComputer(agentID: "agent_1")
        XCTAssertTrue(first)
        XCTAssertEqual(model.computerTakeovers["agent_1"]?.active, true)

        await transport.setRoute(path, json(#"{"computer":null,"access":{"ok":false,"reason":"server_off","message":"Computers are not available."}}"#))
        let removed = await model.refreshComputer(agentID: "agent_1")
        XCTAssertTrue(removed)
        let detail = try XCTUnwrap(model.details["agent_1"])
        XCTAssertNil(detail.computer)
        XCTAssertFalse(detail.computerConfigured)
        XCTAssertEqual(detail.computerAccess?.reason, "server_off")
        XCTAssertNil(model.computerTakeovers["agent_1"])
        XCTAssertNil(model.computerRestMinutes["agent_1"])
    }

    @MainActor
    func testAFailedOrMalformedReadCannotVerifyCachedState() async {
        let (model, transport) = await openedModel()
        defer { model.stop() }
        for response in [json(#"{"message":"Computer host unavailable."}"#, status: 503), json("{}") ] {
            await transport.setRoute(path, response)
            let fresh = await model.refreshComputer(agentID: "agent_1")
            XCTAssertFalse(fresh)
            XCTAssertNotNil(model.computerErrors["agent_1"])
            XCTAssertEqual(model.details["agent_1"]?.computer?.status, "awake", "Cache stays available, but is never reported as a fresh read.")
        }
        await transport.setRoute(path, json(#"{"computer":{"enabled":true,"status":"asleep"},"access":{"ok":true}}"#))
        let recovered = await model.refreshComputer(agentID: "agent_1")
        XCTAssertTrue(recovered)
        XCTAssertNil(model.computerErrors["agent_1"])
        XCTAssertEqual(model.details["agent_1"]?.computer?.status, "asleep")
    }

    @MainActor
    func testAWriteInvalidatesAnEarlierStatusRead() async {
        let (model, transport) = await openedModel()
        defer { model.stop() }
        await transport.holdNext(path)
        let oldRead = Task { await model.refreshComputer(agentID: "agent_1") }
        await transport.waitUntilHeld()
        await transport.setRoute(path, json(#"{"computer":{"enabled":true,"status":"asleep"}}"#))
        let slept = await model.computerAction(agentID: "agent_1", action: "sleep")
        XCTAssertTrue(slept)
        await transport.release(json(#"{"computer":{"enabled":true,"status":"awake"}}"#))
        let applied = await oldRead.value
        XCTAssertFalse(applied)
        XCTAssertEqual(model.details["agent_1"]?.computer?.status, "asleep")
    }

    @MainActor
    func testAViewerFailureHasAnInlineExplanationAndRetryClearsIt() async {
        let (model, transport) = await openedModel()
        defer { model.stop() }
        let viewPath = path + "/view"
        await transport.setRoute(viewPath, json(#"{"error":"held_elsewhere","message":"A browser already has control."}"#, status: 409))
        let refused = await model.computerHandoffURL(agentID: "agent_1", mode: "control")
        XCTAssertNil(refused)
        XCTAssertEqual(model.computerErrors["agent_1"], "A browser already has control.")
        await transport.setRoute(viewPath, json(#"{"url":"https://chat.liams.dev/computer-view?c=test-handoff"}"#))
        let opened = await model.computerHandoffURL(agentID: "agent_1", mode: "watch")
        XCTAssertNotNil(opened)
        XCTAssertNil(model.computerErrors["agent_1"])
    }

    @MainActor
    func testAViewerLinkFromAnAccountThatSignedOutIsDiscarded() async {
        let (model, transport) = await openedModel()
        await transport.holdNext(path + "/view")
        let opening = Task { await model.computerHandoffURL(agentID: "agent_1", mode: "watch") }
        await transport.waitUntilHeld()
        model.stop()
        await transport.release(json(#"{"url":"https://chat.liams.dev/computer-view?c=old-account"}"#))
        let link = await opening.value
        XCTAssertNil(link)
        XCTAssertTrue(model.computerErrors.isEmpty)
    }

    @MainActor
    private func openedModel() async -> (NativeAgentsModel, RefreshTransport) {
        let agent = #"{"id":"agent_1","name":"Mira","role":"","status":"active","sortOrder":0,"createdAt":"2026-11-08T09:00:00.000Z","updatedAt":"2026-11-08T09:00:00.000Z","state":"idle","stateSentence":"","needsYou":0}"#
        let transport = RefreshTransport(routes: [
            "/api/agents": json(#"{"agents":[\#(agent)]}"#),
            "/api/agents/agent_1": json(#"{"agent":\#(agent),"computerConfigured":true,"computer":{"enabled":true,"status":"awake"}}"#),
        ])
        let model = NativeAgentsModel(client: NativeAgentsClient(sender: transport))
        await model.start(for: account)
        await model.loadDetail(id: "agent_1")
        XCTAssertEqual(model.details["agent_1"]?.computer?.status, "awake")
        return (model, transport)
    }

    private func json(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

private actor RefreshTransport: NativeAuthenticatedRequestSending {
    private var routes: [String: HTTPResponse]
    private var heldPath: String?
    private var pending: CheckedContinuation<HTTPResponse, Never>?
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(routes: [String: HTTPResponse]) { self.routes = routes }
    func setRoute(_ path: String, _ response: HTTPResponse) { routes[path] = response }
    func holdNext(_ path: String) { heldPath = path }

    func waitUntilHeld() async {
        guard pending == nil else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release(_ response: HTTPResponse) {
        let continuation = pending
        pending = nil
        continuation?.resume(returning: response)
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        if heldPath == request.path {
            heldPath = nil
            return await withCheckedContinuation { continuation in
                pending = continuation
                let ready = waiters
                waiters = []
                for waiter in ready { waiter.resume() }
            }
        }
        return routes[request.path] ?? HTTPResponse(statusCode: 500, headers: HTTPHeaders(), body: Data("{}".utf8))
    }
}
