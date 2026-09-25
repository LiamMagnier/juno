import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import XCTest
@testable import JunoSync

/// The device token is only useful to the server if it arrives with the right
/// topic, gateway and switches, and only while an account is signed in. These
/// pin the request `POST /api/v1/devices/apns` receives and when it is sent.
@MainActor
final class NativePushRegistrarTests: XCTestCase {
    private var token: Data { Data((0..<32).map { UInt8($0 * 7 % 256) }) }
    private var tokenHex: String { token.map { String(format: "%02x", $0) }.joined() }

    func testClientSendsTheRegistrationContract() async throws {
        let sender = PushSender()
        let accountID = try AccountID("acct_one")
        let record = try await NativePushTokenClient(sender: sender).register(
            NativePushTokenRegistration(
                token: tokenHex,
                platform: "ios",
                bundleID: "com.liammagnier.JunoMobile.debug",
                environment: "sandbox",
                preferences: NativePushPreferences(needsYou: true, updates: false)
            ),
            for: accountID
        )

        XCTAssertEqual(record.id, "dpt_1")
        XCTAssertTrue(record.active)
        XCTAssertEqual(record.preferences, NativePushPreferences(needsYou: true, updates: false))

        let requests = await sender.recorded()
        XCTAssertEqual(requests.count, 1)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.0.path, "/api/v1/devices/apns")
        XCTAssertEqual(request.0.method, .post)
        XCTAssertEqual(request.0.headers["content-type"], "application/json")
        XCTAssertNil(request.0.headers["authorization"], "The transport adds the bearer, never the client.")
        XCTAssertEqual(request.1, accountID)
        let body = try jsonBody(of: request.0)
        XCTAssertEqual(body["token"]?.stringValue, tokenHex)
        XCTAssertEqual(body["platform"]?.stringValue, "ios")
        XCTAssertEqual(body["bundleId"]?.stringValue, "com.liammagnier.JunoMobile.debug")
        XCTAssertEqual(body["environment"]?.stringValue, "sandbox")
        XCTAssertEqual(body["notifyNeedsYou"]?.boolValue, true)
        XCTAssertEqual(body["notifyUpdates"]?.boolValue, false)
    }

    func testMissingBundleIDIsLeftOutRatherThanNull() async throws {
        let sender = PushSender()
        _ = try await NativePushTokenClient(sender: sender).register(
            NativePushTokenRegistration(
                token: tokenHex,
                platform: "macos",
                bundleID: nil,
                environment: "production",
                preferences: NativePushPreferences()
            ),
            for: try AccountID("acct_one")
        )
        let requests = await sender.recorded()
        let request = try XCTUnwrap(requests.first)
        let body = try jsonBody(of: request.0)
        XCTAssertNil(body["bundleId"])
        XCTAssertEqual(body["platform"]?.stringValue, "macos")
    }

    func testClientRefusesANonHexTokenWithoutARequest() async throws {
        let sender = PushSender()
        let client = NativePushTokenClient(sender: sender)
        do {
            _ = try await client.register(
                NativePushTokenRegistration(
                    token: "not-a-token-at-all-not-a-token-at-all",
                    platform: "ios",
                    bundleID: nil,
                    environment: "production",
                    preferences: NativePushPreferences()
                ),
                for: try AccountID("acct_one")
            )
            XCTFail("A token that is not hex must not be sent")
        } catch {
            XCTAssertEqual(error as? NativePushTokenError, .invalidToken)
        }
        let requests = await sender.recorded()
        XCTAssertTrue(requests.isEmpty)
    }

    func testServerRefusalIsTyped() async throws {
        let sender = PushSender(status: 429, body: #"{"error":{"code":"rate_limited","message":"Slow down","requestId":"r1","retryable":true}}"#)
        do {
            _ = try await NativePushTokenClient(sender: sender).register(
                NativePushTokenRegistration(
                    token: tokenHex,
                    platform: "ios",
                    bundleID: nil,
                    environment: "production",
                    preferences: NativePushPreferences()
                ),
                for: try AccountID("acct_one")
            )
            XCTFail("A refusal must throw")
        } catch {
            XCTAssertEqual(error as? NativePushTokenError, .server(statusCode: 429, code: "rate_limited"))
        }
    }

    func testUnregisterSendsTheTokenAsAQuery() async throws {
        let sender = PushSender(body: #"{"unregistered":true}"#)
        try await NativePushTokenClient(sender: sender).unregister(token: tokenHex, for: try AccountID("acct_one"))
        let requests = await sender.recorded()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.0.method, .delete)
        XCTAssertEqual(request.0.path, "/api/v1/devices/apns")
        XCTAssertEqual(request.0.queryItems, [URLQueryItem(name: "token", value: tokenHex)])
        XCTAssertNil(request.0.body)
    }

    func testMarkReadPatchesTheRowAndToleratesAnotherAccountsID() async throws {
        let sender = PushSender(status: 404, body: #"{"error":"Notification not found"}"#)
        let client = NativePushTokenClient(sender: sender)
        try await client.markRead(notificationID: "ntf_1", for: try AccountID("acct_one"))
        let requests = await sender.recorded()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.0.method, .patch)
        XCTAssertEqual(request.0.path, "/api/notifications/ntf_1")

        do {
            try await client.markRead(notificationID: "../admin", for: try AccountID("acct_one"))
            XCTFail("An id that could leave the path must be refused")
        } catch {
            XCTAssertEqual(error as? NativePushTokenError, .invalidIdentifier)
        }
    }

    func testRegistrarWaitsForBothHalvesThenSendsOnce() async throws {
        let sender = PushSender()
        let registrar = makeRegistrar()
        let accountID = try AccountID("acct_one")

        registrar.didRegister(deviceToken: token)
        await registrar.settle()
        var requests = await sender.recorded()
        XCTAssertTrue(requests.isEmpty, "No account yet, so nothing to register against")
        XCTAssertEqual(registrar.tokenHex, tokenHex)

        registrar.start(for: accountID, sender: sender)
        await registrar.settle()
        requests = await sender.recorded()
        XCTAssertEqual(requests.count, 1)
        let body = try jsonBody(of: try XCTUnwrap(requests.first).0)
        XCTAssertEqual(body["bundleId"]?.stringValue, "com.liammagnier.JunoMobile")
        XCTAssertEqual(body["environment"]?.stringValue, "sandbox")
        XCTAssertEqual(body["platform"]?.stringValue, "ios")

        // The same token again, as every launch hands it over, costs nothing.
        registrar.didRegister(deviceToken: token)
        registrar.start(for: accountID, sender: sender)
        await registrar.settle()
        requests = await sender.recorded()
        XCTAssertEqual(requests.count, 1)
        XCTAssertNil(registrar.lastError)
    }

    func testFlippingASwitchReRegistersAndPersists() async throws {
        let sender = PushSender()
        let defaults = makeDefaults()
        let registrar = makeRegistrar(defaults: defaults)
        registrar.didRegister(deviceToken: token)
        registrar.start(for: try AccountID("acct_one"), sender: sender)
        await registrar.settle()

        registrar.preferences.updates = false
        await registrar.settle()

        let requests = await sender.recorded()
        XCTAssertEqual(requests.count, 2)
        let body = try jsonBody(of: try XCTUnwrap(requests.last).0)
        XCTAssertEqual(body["notifyNeedsYou"]?.boolValue, true)
        XCTAssertEqual(body["notifyUpdates"]?.boolValue, false)

        // A new process reads the same switches back.
        let relaunched = makeRegistrar(defaults: defaults)
        XCTAssertEqual(relaunched.preferences, NativePushPreferences(needsYou: true, updates: false))
    }

    func testSigningOutAndBackInRegistersAgain() async throws {
        let sender = PushSender()
        let registrar = makeRegistrar()
        let accountID = try AccountID("acct_one")
        registrar.didRegister(deviceToken: token)
        registrar.start(for: accountID, sender: sender)
        await registrar.settle()

        registrar.stop()
        await registrar.settle()
        var requests = await sender.recorded()
        XCTAssertEqual(requests.count, 1, "Signing out sends nothing; the server retires the session's tokens")

        // Signing back in is a new device session, which the token has to be
        // attached to again.
        registrar.start(for: accountID, sender: sender)
        await registrar.settle()
        requests = await sender.recorded()
        XCTAssertEqual(requests.count, 2)
    }

    func testAFailedRegistrationIsReportedAndNotRetriedInALoop() async throws {
        let sender = PushSender(status: 500, body: "{}")
        let registrar = makeRegistrar()
        registrar.didRegister(deviceToken: token)
        registrar.start(for: try AccountID("acct_one"), sender: sender)
        await registrar.settle()

        let requests = await sender.recorded()
        XCTAssertEqual(requests.count, 1)
        XCTAssertNotNil(registrar.lastError)
    }

    // MARK: - Helpers

    private func makeDefaults() -> UserDefaults {
        let suite = "juno.push.tests.\(UUID().uuidString)"
        return UserDefaults(suiteName: suite) ?? .standard
    }

    private func makeRegistrar(defaults: UserDefaults? = nil) -> NativePushRegistrar {
        NativePushRegistrar(
            defaults: defaults ?? makeDefaults(),
            bundleID: "com.liammagnier.JunoMobile",
            platform: "ios",
            environment: "sandbox"
        )
    }

    private func jsonBody(of request: NativeBearerRequest) throws -> [String: JunoJSONValue] {
        let data = try XCTUnwrap(request.body)
        let value = try JSONDecoder().decode(JunoJSONValue.self, from: data)
        guard case .object(let object) = value else {
            XCTFail("Expected an object body")
            return [:]
        }
        return object
    }
}

private actor PushSender: NativeAuthenticatedRequestSending {
    private let status: Int
    private let body: String
    private var requests: [(NativeBearerRequest, AccountID)] = []

    init(
        status: Int = 200,
        body: String = #"{"registered":true,"devicePushToken":{"id":"dpt_1","platform":"ios","environment":"sandbox","active":true,"notifyNeedsYou":true,"notifyUpdates":false,"updatedAt":"2026-09-24T12:00:00.000Z"}}"#
    ) {
        self.status = status
        self.body = body
    }

    func send(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPResponse {
        requests.append((request, accountID))
        return HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }

    func recorded() -> [(NativeBearerRequest, AccountID)] {
        requests
    }
}
