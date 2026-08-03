import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoCodeKit

/// Registration is the whole reason a Mac appears in the phone's picker, and
/// every one of its failure modes reads to the reader as "my computer is
/// offline" — a 400 for an over-long folder name is indistinguishable, on the
/// phone, from the Mac being shut. So these test the body on the wire against
/// `postSchema` in `src/app/api/code/devices/route.ts` rather than the happy
/// path through it.
final class NativeCodeDeviceRegistrationTests: XCTestCase {
    private let account = try! AccountID("account-a")

    /// The first post must not carry `deviceId` at all. The route's schema marks
    /// it `.optional()`, which accepts *absent* and rejects `null`, so an
    /// explicitly-null id would 400 every registration this Mac ever made.
    /// Afterwards it must carry the id the server handed back, or a renamed Mac
    /// leaves its old name behind as a second, permanently offline computer.
    func testTheDeviceIdIsOmittedUntilTheServerIssuesOne() async throws {
        let transport = RegistrationTransport(responses: [
            .ok(#"{"device":{"id":"dev-1"}}"#),
            .ok(#"{"device":{"id":"dev-1"}}"#),
        ])
        let client = NativeCodeTaskClient(sender: transport, streamer: SilentStreamer())

        let issued = try await register(client, deviceID: nil)
        XCTAssertEqual(issued, "dev-1")
        _ = try await register(client, deviceID: issued)

        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].path, "/api/code/devices")
        XCTAssertEqual(requests[0].method, .post)
        let first = try Self.object(requests[0])
        XCTAssertNil(
            first.index(forKey: "deviceId"),
            "an explicit null is not the same as absent, and the route refuses it"
        )
        XCTAssertEqual(try Self.object(requests[1])["deviceId"] as? String, "dev-1")
    }

    /// The fields the route requires, in the shape it requires them. `platform`
    /// is an enum of exactly `macos` and `windows`; `protocolVersion` is what
    /// tells the server which event vocabulary this host speaks.
    func testTheBodyMatchesTheRoutesSchema() async throws {
        let transport = RegistrationTransport(responses: [.ok(#"{"device":{"id":"dev-1"}}"#)])
        let client = NativeCodeTaskClient(sender: transport, streamer: SilentStreamer())

        _ = try await client.registerDevice(
            deviceID: nil,
            name: "Liam's MacBook Pro",
            platform: "macos",
            appVersion: "1.4.2",
            workspaces: [.init(name: "juno", path: "/Users/liam/juno", key: "ws-1")],
            sessionCount: 3,
            activeCount: 1,
            for: account
        )

        let body = try Self.object(await transport.requests[0])
        XCTAssertEqual(body["name"] as? String, "Liam's MacBook Pro")
        XCTAssertEqual(body["platform"] as? String, "macos")
        XCTAssertEqual(body["appVersion"] as? String, "1.4.2")
        XCTAssertEqual(body["protocolVersion"] as? Int, 1)
        XCTAssertEqual(body["sessionCount"] as? Int, 3)
        XCTAssertEqual(body["activeCount"] as? Int, 1)
        let workspaces = try XCTUnwrap(body["workspaces"] as? [[String: Any]])
        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0]["name"] as? String, "juno")
        XCTAssertEqual(workspaces[0]["path"] as? String, "/Users/liam/juno")
        XCTAssertEqual(workspaces[0]["key"] as? String, "ws-1")
    }

    /// A key-less workspace must omit the field rather than send `null`, for the
    /// same reason `deviceId` does — the route validates it as optional.
    func testAKeylessWorkspaceOmitsTheKey() async throws {
        let transport = RegistrationTransport(responses: [.ok(#"{"device":{"id":"dev-1"}}"#)])
        let client = NativeCodeTaskClient(sender: transport, streamer: SilentStreamer())

        _ = try await register(
            client,
            workspaces: [.init(name: "juno", path: "/Users/liam/juno", key: nil)]
        )

        // Hoisted: `XCTUnwrap` takes an autoclosure, which cannot await the
        // actor-isolated `requests`.
        let request = await transport.requests[0]
        let workspaces = try XCTUnwrap(
            try Self.object(request)["workspaces"] as? [[String: Any]]
        )
        XCTAssertNil(workspaces[0].index(forKey: "key"))
    }

    /// One folder with a 1200-character path would 400 the whole post, and the
    /// Mac would simply never appear — a silent, total failure caused by a
    /// folder the reader has every right to have. Clamping is what keeps one bad
    /// row from taking the machine's presence down with it.
    func testOversizedFieldsAreClampedRatherThanRefused() async throws {
        let transport = RegistrationTransport(responses: [.ok(#"{"device":{"id":"dev-1"}}"#)])
        let client = NativeCodeTaskClient(sender: transport, streamer: SilentStreamer())

        _ = try await client.registerDevice(
            deviceID: nil,
            name: String(repeating: "n", count: 400),
            platform: "macos",
            appVersion: String(repeating: "v", count: 250),
            workspaces: (0..<150).map { index in
                .init(
                    name: String(repeating: "w", count: 300),
                    path: "/" + String(repeating: "p", count: 1_400) + "/\(index)",
                    key: String(repeating: "k", count: 400)
                )
            },
            sessionCount: -4,
            activeCount: -1,
            for: account
        )

        let body = try Self.object(await transport.requests[0])
        XCTAssertEqual((body["name"] as? String)?.count, 200)
        XCTAssertEqual((body["appVersion"] as? String)?.count, 100)
        XCTAssertEqual(body["sessionCount"] as? Int, 0, "the route's minimum is zero")
        XCTAssertEqual(body["activeCount"] as? Int, 0)
        let workspaces = try XCTUnwrap(body["workspaces"] as? [[String: Any]])
        XCTAssertEqual(workspaces.count, 100, "the route caps the array at a hundred")
        XCTAssertEqual((workspaces[0]["name"] as? String)?.count, 200)
        XCTAssertEqual((workspaces[0]["path"] as? String)?.count, 1_000)
        XCTAssertEqual((workspaces[0]["key"] as? String)?.count, 200)
    }

    /// A folder whose name is whitespace, or whose path is, cannot satisfy the
    /// route's `min(1)` after its own trim. Dropping that one row keeps the rest
    /// of the machine's folders registerable.
    func testABlankWorkspaceIsDroppedRatherThanSentAndRefused() async throws {
        let transport = RegistrationTransport(responses: [.ok(#"{"device":{"id":"dev-1"}}"#)])
        let client = NativeCodeTaskClient(sender: transport, streamer: SilentStreamer())

        _ = try await register(
            client,
            workspaces: [
                .init(name: "   ", path: "/Users/liam/juno", key: nil),
                .init(name: "juno", path: "\n", key: nil),
                .init(name: "  juno  ", path: "  /Users/liam/juno  ", key: nil),
            ]
        )

        // Hoisted: `XCTUnwrap` takes an autoclosure, which cannot await the
        // actor-isolated `requests`.
        let request = await transport.requests[0]
        let workspaces = try XCTUnwrap(
            try Self.object(request)["workspaces"] as? [[String: Any]]
        )
        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0]["name"] as? String, "juno", "trimmed, as the route trims")
        XCTAssertEqual(workspaces[0]["path"] as? String, "/Users/liam/juno")
    }

    /// A Mac with no localized name is not a reason to be invisible, and the
    /// route rejects an empty one.
    func testAnEmptyNameFallsBackRatherThanFailing() async throws {
        let transport = RegistrationTransport(responses: [.ok(#"{"device":{"id":"dev-1"}}"#)])
        let client = NativeCodeTaskClient(sender: transport, streamer: SilentStreamer())

        _ = try await register(client, name: "")

        let request = await transport.requests[0]
        XCTAssertEqual(try Self.object(request)["name"] as? String, "Mac")
    }

    /// The heartbeat has to be able to say why it stopped working. A refusal
    /// that surfaced as "malformed response" would send the reader looking at
    /// the wrong thing entirely.
    func testARefusalCarriesTheServersOwnMessage() async throws {
        let transport = RegistrationTransport(responses: [.status(400, "Invalid input")])
        let client = NativeCodeTaskClient(sender: transport, streamer: SilentStreamer())

        do {
            _ = try await register(client)
            XCTFail("a refused registration must throw")
        } catch let error as NativeCodeError {
            XCTAssertEqual(error, .server(statusCode: 400, message: "Invalid input"))
        }
    }

    // MARK: - Helpers

    private func register(
        _ client: NativeCodeTaskClient,
        deviceID: String? = nil,
        name: String = "Mac mini",
        workspaces: [NativeCodeDevice.Workspace] = []
    ) async throws -> String {
        try await client.registerDevice(
            deviceID: deviceID,
            name: name,
            platform: "macos",
            appVersion: "1.0.0",
            workspaces: workspaces,
            sessionCount: 0,
            activeCount: 0,
            for: account
        )
    }

    private static func object(_ request: NativeBearerRequest) throws -> [String: Any] {
        let body = try XCTUnwrap(request.body)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }
}

private actor RegistrationTransport: NativeAuthenticatedRequestSending {
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
            return HTTPResponse(
                statusCode: 500, headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
            )
        }
        switch responses.removeFirst() {
        case .ok(let body):
            return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(body.utf8))
        case .status(let code, let message):
            return HTTPResponse(
                statusCode: code, headers: HTTPHeaders(),
                body: Data(#"{"message":"\#(message)"}"#.utf8)
            )
        }
    }
}

/// `NativeCodeTaskClient` needs a streamer to exist; registration never uses
/// one, and a fixture that answered would only invite a test to lean on it.
private struct SilentStreamer: NativeAuthenticatedByteStreaming {
    func stream(
        _: NativeBearerRequest, for _: AccountID
    ) async throws -> HTTPByteStreamResponse {
        HTTPByteStreamResponse(
            statusCode: 200,
            headers: HTTPHeaders(),
            bytes: AsyncThrowingStream { $0.finish() }
        )
    }
}
