import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoCodeKit

/// Revoking a paired computer is the only way to unpair it — the heartbeat
/// would otherwise keep the row alive forever. These pin the wire call and the
/// model's local convergence: the request must name the exact device on the
/// versioned path, and the lists must drop the host (and only the host) once
/// the relay confirms.
@MainActor
final class CodeDeviceRevokeTests: XCTestCase {
    private let account = try! AccountID("account-a")

    /// The versioned path is deliberate: the sibling inventory still lives
    /// under `/api` with a per-operation contract override, while revocation
    /// is new surface starting on `/api/v1` where the OpenAPI entry
    /// (`revokeNativeCodeDevice`) needs no override to describe it.
    func testRevokeDeletesTheNamedDeviceOnTheVersionedPath() async throws {
        let transport = RevokeTransport(responses: [.ok(#"{"revoked":true,"deviceId":"dev-1"}"#)])
        let client = NativeCodeRemoteClient(sender: transport)

        try await client.revokeDevice(deviceID: "dev-1", for: account)

        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].path, "/api/v1/code/devices/dev-1")
        XCTAssertEqual(requests[0].method, .delete)
    }

    /// A device id travels in the path, so it must be path-safe before it is
    /// interpolated — the same guard every other relay call applies.
    func testRevokeRefusesAnUnsafeIdentifierLocally() async throws {
        let transport = RevokeTransport(responses: [.ok("{}")])
        let client = NativeCodeRemoteClient(sender: transport)

        do {
            try await client.revokeDevice(deviceID: "../other", for: account)
            XCTFail("a path-unsafe id must never reach the relay")
        } catch let error as CodeRemoteError {
            XCTAssertEqual(error, .invalidIdentifier)
        }
        // Hoisted: `XCTUnwrap`/`XCTAssert` take autoclosures, which cannot
        // await the actor-isolated `requests`.
        let sent = await transport.requests
        XCTAssertTrue(sent.isEmpty)
    }

    /// A 404 is the relay saying the pairing is already gone — wrong to retry,
    /// and the message must be the relay's own rather than a generic failure.
    func testRevokeSurfacesARefusalWithoutRetry() async throws {
        let transport = RevokeTransport(responses: [.status(404, "gone")])
        let client = NativeCodeRemoteClient(sender: transport)

        do {
            try await client.revokeDevice(deviceID: "dev-1", for: account)
            XCTFail("a refused revoke must throw")
        } catch let error as CodeRemoteError {
            XCTAssertEqual(error, .server(statusCode: 404, message: "gone", retryable: false))
            XCTAssertFalse(error.isRetryable)
        }
    }

    /// The server delete cascades the host's sessions, so the cached per-host
    /// lists go with the row rather than lingering as threads that open onto
    /// a computer that no longer exists. Selection follows the survivors.
    func testRevokeDropsTheHostAndItsCachedSessions() async throws {
        let transport = RevokeTransport(responses: [.ok(#"{"revoked":true,"deviceId":"dev-a"}"#)])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)
        model.updateHosts(from: [device(id: "dev-a", name: "Mac A"), device(id: "dev-b", name: "Mac B")])
        await model.selectHost("dev-a")

        await model.revokeHost(id: "dev-a")

        XCTAssertEqual(model.hosts.map(\.id), ["dev-b"])
        XCTAssertNil(model.sessionsByDevice["dev-a"], "the revoked host's cached sessions must go too")
        XCTAssertEqual(model.selectedDeviceID, "dev-b")
        XCTAssertNil(model.revokingHostID, "the in-flight marker must clear")
        XCTAssertNil(model.lastErrorDescription)
    }

    /// A revoke the relay refused must not look revoked — and it must not fail
    /// the session list alongside it. Only the error line reports it.
    func testARefusedRevokeKeepsEverythingAndReportsOnlyItself() async throws {
        let transport = RevokeTransport(responses: [.status(404, "gone")])
        let model = CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: transport))
        model.start(for: account)
        model.updateHosts(from: [device(id: "dev-a", name: "Mac A")])

        await model.revokeHost(id: "dev-a")

        XCTAssertEqual(model.hosts.map(\.id), ["dev-a"])
        XCTAssertEqual(model.lastErrorDescription, "gone")
        XCTAssertEqual(model.phase, .idle, "a failed revoke must not fail the lists")
        XCTAssertNil(model.revokingHostID)
    }

    // MARK: - Helpers

    private func device(id: String, name: String) -> NativeCodeDevice {
        NativeCodeDevice(
            id: id, name: name, platform: "macos", appVersion: "1",
            workspaces: [], activeCount: 0,
            lastSeenAt: Date(timeIntervalSince1970: 1), online: true,
            servesQueuedTasks: true
        )
    }
}

private actor RevokeTransport: NativeAuthenticatedRequestSending {
    enum Response {
        case ok(String)
        case status(Int, String)
    }

    private var responses: [Response]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [Response]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else {
            return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data("{}".utf8))
        }
        switch responses.removeFirst() {
        case .ok(let body):
            return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(body.utf8))
        case .status(let code, let message):
            return HTTPResponse(
                statusCode: code, headers: HTTPHeaders(),
                body: Data(#"{"error":"\#(message)"}"#.utf8)
            )
        }
    }
}
