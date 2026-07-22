import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoCodeKit

/// The relay client is the only thing standing between a phone and a Mac that
/// executes code, so these lean on the boundaries rather than the happy path.
final class NativeCodeRemoteClientTests: XCTestCase {
    private let account = try! AccountID("account-a")

    // MARK: - Path safety

    /// Identifiers are interpolated straight into a URL path. A `..` segment or
    /// an encoded slash would address a different route entirely — potentially
    /// another device's — so they are refused before a request is ever made.
    func testHostileIdentifiersNeverReachTheNetwork() async throws {
        let transport = RemoteTransport(responses: [])
        let client = NativeCodeRemoteClient(sender: transport)

        let hostile = [
            "../../devices", "device/../other", "a%2Fb", "with space",
            "with\nnewline", "q?x=1", "frag#ment", "back\\slash", "",
        ]
        for identifier in hostile {
            do {
                _ = try await client.sessions(deviceID: identifier, for: account)
                XCTFail("\(identifier.debugDescription) should have been refused")
            } catch let error as CodeRemoteError {
                XCTAssertEqual(error, .invalidIdentifier, identifier.debugDescription)
            }
        }
        let count = await transport.requests.count
        XCTAssertEqual(count, 0, "Not one hostile identifier may reach the transport.")
    }

    // MARK: - Commands

    /// An unsupported kind fails locally and immediately rather than as an
    /// opaque 400 after a round trip.
    func testAnUnknownCommandKindIsRefusedLocally() async throws {
        let transport = RemoteTransport(responses: [])
        let client = NativeCodeRemoteClient(sender: transport)

        do {
            _ = try await client.enqueueCommand(
                deviceID: "device-1", sessionID: "session-1",
                kind: "rm_rf", payload: [:], idempotencyKey: "key-1", for: account
            )
            XCTFail("an unknown command kind must be refused")
        } catch let error as CodeRemoteError {
            XCTAssertEqual(error, .unsupportedCommand("rm_rf"))
        }
        let count = await transport.requests.count
        XCTAssertEqual(count, 0)
    }

    /// Approve and Deny are the two most consequential commands on the wire, so
    /// the kinds behind them must be in the supported set.
    func testTheConsequentialCommandKindsAreSupported() {
        for kind in ["message", "stop", "approval", "stop_agent"] {
            XCTAssertTrue(
                NativeCodeRemoteClient.supportedCommandKinds.contains(kind),
                "\(kind) must be sendable"
            )
        }
    }

    /// The key travels on the body so the relay's unique index can turn a retry
    /// into a lookup instead of a second Stop.
    func testTheIdempotencyKeyIsSentWithTheCommand() async throws {
        let transport = RemoteTransport(responses: [
            json(#"{"command":{"id":"c1","sessionID":"session-1","kind":"stop","payload":{},"status":"pending"}}"#)
        ])
        let client = NativeCodeRemoteClient(sender: transport)

        let command = try await client.enqueueCommand(
            deviceID: "device-1", sessionID: "session-1",
            kind: "stop", payload: [:], idempotencyKey: "stop-once", for: account
        )

        XCTAssertEqual(command.id, "c1")
        let requests = await transport.requests
        let body = try XCTUnwrap(requests.first?.body)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(object["idempotencyKey"] as? String, "stop-once")
        XCTAssertEqual(object["kind"] as? String, "stop")
    }

    // MARK: - Cursor recovery

    /// Reconnecting resumes from the last applied sequence rather than
    /// refetching a transcript, which is the whole point of the cursor.
    func testEventsAreRequestedStrictlyAfterTheCursor() async throws {
        let transport = RemoteTransport(responses: [json(#"{"events":[]}"#)])
        let client = NativeCodeRemoteClient(sender: transport)

        _ = try await client.events(
            deviceID: "device-1", sessionID: "session-1", afterSequence: 41, for: account
        )

        let requests = await transport.requests
        let path = try XCTUnwrap(requests.first?.path)
        XCTAssertTrue(path.hasSuffix("/events?after=41"), path)
    }

    func testEventsDecodeWithTheirSequenceAndPayload() async throws {
        let transport = RemoteTransport(responses: [json("""
        {"events":[
          {"seq":42,"kind":"file_change","payload":{"path":"src/main.swift"},"createdAt":"2026-07-22T10:00:00.000Z"},
          {"seq":43,"kind":"approval_request","payload":{"requestId":"r1"},"createdAt":"2026-07-22T10:00:01.000Z"}
        ]}
        """)])
        let client = NativeCodeRemoteClient(sender: transport)

        let events = try await client.events(
            deviceID: "device-1", sessionID: "session-1", afterSequence: 41, for: account
        )

        XCTAssertEqual(events.map(\.seq), [42, 43])
        XCTAssertEqual(events[0].kind, "file_change")
        XCTAssertEqual(events[0].payload["path"], .string("src/main.swift"))
        XCTAssertEqual(events[1].payload["requestId"], .string("r1"))
    }

    // MARK: - Host side

    /// An idle poll returning no command is the normal case, not a failure. A
    /// host that treated it as an error would log a fault every 25 seconds.
    func testAnIdlePollReturnsNilRatherThanThrowing() async throws {
        let transport = RemoteTransport(responses: [json(#"{"command":null}"#)])
        let client = NativeCodeRemoteClient(sender: transport)

        let command = try await client.claimNextCommand(deviceID: "device-1", for: account)
        XCTAssertNil(command)
    }

    func testAClaimedCommandDecodes() async throws {
        let transport = RemoteTransport(responses: [json("""
        {"command":{"id":"c1","sessionID":"s1","kind":"message",
        "payload":{"text":"run the tests"},"status":"claimed"}}
        """)])
        let client = NativeCodeRemoteClient(sender: transport)

        let claimed = try await client.claimNextCommand(deviceID: "device-1", for: account)
        let command = try XCTUnwrap(claimed)
        XCTAssertEqual(command.kind, "message")
        XCTAssertEqual(command.payload["text"], .string("run the tests"))
    }

    // MARK: - Sessions and the path boundary

    /// The check that keeps the phone from ever learning where a workspace
    /// lives on the Mac. A workspace is identified by an opaque key and a
    /// display name; an absolute path in this payload would leak the account
    /// name and directory layout.
    func testASessionSummaryCarriesNoFilesystemPath() async throws {
        let transport = RemoteTransport(responses: [json("""
        {"sessions":[{"sessionID":"s1","deviceID":"d1","workspaceKey":"wk_ab12",
        "workspaceName":"juno","title":"Fix the sync bug","modelID":"anthropic:claude",
        "permissionMode":"approvalRequired","currentStatus":"idle","isRunning":false,
        "isAwaitingApproval":false,"pendingChangeCount":0,"activeBranch":"main",
        "lastError":null,"lastEventSequence":7,
        "updatedAt":"2026-07-22T10:00:00.000Z","lastMessageAt":"2026-07-22T10:00:00.000Z",
        "fresh":true}]}
        """)])
        let client = NativeCodeRemoteClient(sender: transport)

        let sessions = try await client.sessions(deviceID: "device-1", for: account)
        let session = try XCTUnwrap(sessions.first)

        XCTAssertEqual(session.workspaceKey, "wk_ab12")
        XCTAssertEqual(session.workspaceName, "juno")
        XCTAssertEqual(session.fresh, true)

        // Nothing reachable on the summary may look like a path.
        let mirrored = [
            session.workspaceKey, session.workspaceName, session.title,
            session.activeBranch, session.lastError,
        ].compactMap { $0 }
        for value in mirrored {
            XCTAssertFalse(value.hasPrefix("/"), value)
            XCTAssertFalse(value.contains("/Users/"), value)
        }
    }

    /// A quiet host is reported as stale rather than as live-but-idle: sending
    /// to it would queue a command nobody claims.
    func testAStaleHostIsDistinguishableFromAnIdleOne() async throws {
        let transport = RemoteTransport(responses: [json("""
        {"sessions":[{"sessionID":"s1","deviceID":"d1","workspaceKey":null,
        "workspaceName":null,"title":"t","modelID":"m","permissionMode":"approvalRequired",
        "currentStatus":"idle","isRunning":false,"isAwaitingApproval":false,
        "pendingChangeCount":0,"activeBranch":null,"lastError":null,"lastEventSequence":0,
        "updatedAt":"2026-07-22T10:00:00.000Z","lastMessageAt":"2026-07-22T10:00:00.000Z",
        "fresh":false}]}
        """)])
        let client = NativeCodeRemoteClient(sender: transport)

        let listed = try await client.sessions(deviceID: "device-1", for: account)
        let session = try XCTUnwrap(listed.first)
        XCTAssertEqual(session.fresh, false)
        XCTAssertFalse(session.isRunning)
    }

    // MARK: - Errors

    /// A 4xx will stay wrong however many times it is retried; a 5xx is worth
    /// another attempt. Getting this backwards either hammers a rejecting
    /// server or gives up on a recoverable one.
    func testRetryabilityFollowsTheStatusClass() async throws {
        for (status, retryable) in [(404, false), (403, false), (409, false), (500, true), (503, true)] {
            let transport = RemoteTransport(responses: [
                json(#"{"error":"nope"}"#, status: status)
            ])
            let client = NativeCodeRemoteClient(sender: transport)
            do {
                _ = try await client.sessions(deviceID: "device-1", for: account)
                XCTFail("status \(status) should have thrown")
            } catch let error as CodeRemoteError {
                XCTAssertEqual(error.isRetryable, retryable, "status \(status)")
            }
        }
    }

    // MARK: - Helpers

    private func json(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

private actor RemoteTransport: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else {
            return HTTPResponse(
                statusCode: 500, headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
            )
        }
        return responses.removeFirst()
    }
}
