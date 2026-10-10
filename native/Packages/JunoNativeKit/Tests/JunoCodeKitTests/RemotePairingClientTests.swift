import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoCodeKit

/// Remote control pairing on the wire (docs/code-v2/REMOTE-CONTROL.md): the
/// routes each call names, what a scanned QR may carry, and refusals in the
/// server's own words.
final class RemotePairingClientTests: XCTestCase {
    private let account = try! AccountID("account-a")

    func testCreateOfferPostsTheMacAndKindAndReadsTheOffer() async throws {
        let transport = PairingTransport(responses: [
            (200, #"{"id":"pt_1","kind":"browser","token":"rcp1.a.b","url":"https://alevr.com/pair","code":"K7QM-4MZP","expiresAt":"2026-10-10T12:02:00.000Z","deviceName":"Studio Mac"}"#)
        ])
        let offer = try await RemotePairingClient(sender: transport).createOffer(deviceId: "mac1", kind: .browser, for: account)
        XCTAssertEqual(offer.code, "K7QM-4MZP")
        XCTAssertEqual(offer.deviceName, "Studio Mac")
        XCTAssertEqual(offer.expiresAt, RemoteDates.parse("2026-10-10T12:02:00Z"))
        let request = await transport.requests[0]
        XCTAssertEqual(request.path, "/api/code/pairing")
        XCTAssertEqual(request.method, .post)
        let body = try JSONSerialization.jsonObject(with: request.body ?? Data()) as? [String: String]
        XCTAssertEqual(body, ["deviceId": "mac1", "kind": "browser"])
    }

    func testOfferStatusMapsEveryState() async throws {
        let transport = PairingTransport(responses: [
            (200, #"{"status":"pending"}"#),
            (200, #"{"status":"approved","pair":{"id":"p1","kind":"phone","name":"Liam's iPhone","platform":"ios","deviceId":"mac1","createdAt":"2026-10-10T12:00:00Z","lastUsedAt":"2026-10-10T12:00:00Z"}}"#),
            (200, #"{"status":"denied"}"#),
            (200, #"{"status":"expired"}"#),
        ])
        let client = RemotePairingClient(sender: transport)
        let pending = try await client.offerStatus(id: "pt_1", for: account)
        XCTAssertEqual(pending, .pending)
        guard case let .approved(pair) = try await client.offerStatus(id: "pt_1", for: account) else { return XCTFail("approved") }
        XCTAssertEqual(pair?.name, "Liam's iPhone")
        let denied = try await client.offerStatus(id: "pt_1", for: account)
        XCTAssertEqual(denied, .denied)
        let expired = try await client.offerStatus(id: "pt_1", for: account)
        XCTAssertEqual(expired, .expired)
        let path = await transport.requests[0].path
        XCTAssertEqual(path, "/api/code/pairing/offers/pt_1")
    }

    func testApproveDenyAndRevokeNameTheirRoutes() async throws {
        let transport = PairingTransport(responses: [
            (200, #"{"pair":{"id":"p1","kind":"phone","name":"iPhone","platform":"ios","deviceId":"mac1","deviceName":"Studio Mac","createdAt":"2026-10-10T12:00:00.000Z","lastUsedAt":"2026-10-10T12:00:00.000Z"}}"#),
            (200, #"{"ok":true}"#),
            (200, #"{"ok":true}"#),
            (200, #"{"pairs":[]}"#),
        ])
        let client = RemotePairingClient(sender: transport)
        let pair = try await client.approve(token: "rcp1.x.y", for: account)
        XCTAssertEqual(pair.deviceName, "Studio Mac")
        try await client.deny(token: "rcp1.x.y", for: account)
        try await client.revoke(pairId: "p1", for: account)
        let pairs = try await client.pairs(deviceId: "mac1", for: account)
        XCTAssertTrue(pairs.isEmpty)
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/code/pairing/approve", "/api/code/pairing/deny", "/api/code/pairing/pairs/p1", "/api/code/pairing/pairs"])
        XCTAssertEqual(requests[2].method, .delete)
        XCTAssertEqual(requests[3].queryItems, [URLQueryItem(name: "deviceId", value: "mac1")])
    }

    func testRefusalsCarryTheServersMessageAndCode() async throws {
        let transport = PairingTransport(responses: [
            (410, #"{"error":"This code has expired. Show a new one on your Mac.","message":"This code has expired. Show a new one on your Mac.","code":"expired"}"#)
        ])
        do {
            _ = try await RemotePairingClient(sender: transport).inspect(token: "rcp1.x.y", for: account)
            XCTFail("expected a refusal")
        } catch let error as RemotePairingError {
            XCTAssertEqual(error.status, 410)
            XCTAssertEqual(error.code, "expired")
            XCTAssertTrue(error.isExpiredOrUsed)
            XCTAssertEqual(error.errorDescription, "This code has expired. Show a new one on your Mac.")
        }
    }

    func testOnlyAlevrPairingLinksYieldAToken() {
        XCTAssertEqual(RemotePairingLink.token(from: "https://alevr.com/pair?t=rcp1.abc.def"), "rcp1.abc.def")
        XCTAssertEqual(RemotePairingLink.token(from: "com.liammagnier.juno://juno/pair?t=rcp1.abc.def"), "rcp1.abc.def")
        XCTAssertNil(RemotePairingLink.token(from: "https://alevr.com/other?t=rcp1.abc.def"))
        XCTAssertNil(RemotePairingLink.token(from: "https://alevr.com/pair?t=notatoken"))
        XCTAssertNil(RemotePairingLink.token(from: "WIFI:S:home;T:WPA;P:secret;;"))
        XCTAssertEqual(RemotePairingLink.appURL(token: "rcp1.a.b")?.absoluteString, "com.liammagnier.juno://juno/pair?t=rcp1.a.b")
    }
}

actor PairingTransport: NativeAuthenticatedRequestSending {
    private var responses: [(Int, String)]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [(Int, String)]) {
        self.responses = responses
    }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        let (status, body) = responses.isEmpty ? (500, "{}") : responses.removeFirst()
        return HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}
