import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import XCTest
@testable import JunoSync

final class NativeBootstrapClientTests: XCTestCase {
    func testFetchUsesExistingBearerRouteAndValidatesCheckpoint() async throws {
        let sender = BootstrapSender(response: response(body: validBody))
        let accountID = try AccountID("acct_one")

        let checkpoint = try await NativeBootstrapClient(sender: sender).fetch(
            for: accountID
        )

        XCTAssertEqual(checkpoint.profile.id, accountID)
        XCTAssertEqual(checkpoint.currentChangeCursor, "42")
        XCTAssertEqual(checkpoint.compactionFloorCursor, "10")
        XCTAssertEqual(checkpoint.modelManifestVersion, "models-2026-07")
        XCTAssertEqual(checkpoint.minimumClientVersions["macOS"], "3.0.0")
        let requests = await sender.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].0.path, "/api/v1/bootstrap")
        XCTAssertEqual(requests[0].0.method, .get)
        XCTAssertEqual(requests[0].1, accountID)
    }

    func testFetchRejectsAnotherAccountAndContractVersion() async throws {
        let accountID = try AccountID("acct_one")
        let anotherAccount = validBody.replacingOccurrences(
            of: #""id":"acct_one""#,
            with: #""id":"acct_other""#
        )
        do {
            _ = try await NativeBootstrapClient(
                sender: BootstrapSender(response: response(body: anotherAccount))
            ).fetch(for: accountID)
            XCTFail("Another account must fail closed")
        } catch {
            XCTAssertEqual(error as? NativeBootstrapError, .accountMismatch)
        }

        let wrongContract = validBody.replacingOccurrences(
            of: #""contractVersion":"\#(JunoNativeContract.version)""#,
            with: #""contractVersion":"older""#
        )
        do {
            _ = try await NativeBootstrapClient(
                sender: BootstrapSender(response: response(body: wrongContract))
            ).fetch(for: accountID)
            XCTFail("Contract drift must fail closed")
        } catch {
            XCTAssertEqual(
                error as? NativeBootstrapError,
                .contractVersionMismatch(
                    expected: JunoNativeContract.version,
                    received: "older"
                )
            )
        }
    }

    func testFetchRejectsMalformedCursorAndResponse() async throws {
        let accountID = try AccountID("acct_one")
        let invalidCursor = validBody.replacingOccurrences(
            of: #""currentChangeCursor":"42""#,
            with: #""currentChangeCursor":"0042""#
        )
        do {
            _ = try await NativeBootstrapClient(
                sender: BootstrapSender(response: response(body: invalidCursor))
            ).fetch(for: accountID)
            XCTFail("Noncanonical cursors must be rejected")
        } catch {
            XCTAssertEqual(
                error as? NativeBootstrapError,
                .invalidCursor("0042")
            )
        }

        do {
            _ = try await NativeBootstrapClient(
                sender: BootstrapSender(response: response(body: #"{"profile":{}}"#))
            ).fetch(for: accountID)
            XCTFail("Incomplete bootstrap must be rejected")
        } catch {
            XCTAssertEqual(error as? NativeBootstrapError, .malformedResponse)
        }
    }

    func testFetchPreservesTypedServerError() async throws {
        let body = Data(
            #"{"error":{"code":"device_revoked","message":"Revoked","requestId":"request_one","retryable":false}}"#.utf8
        )
        let sender = BootstrapSender(
            response: HTTPResponse(
                statusCode: 401,
                headers: HTTPHeaders(),
                body: body
            )
        )

        do {
            _ = try await NativeBootstrapClient(sender: sender).fetch(
                for: AccountID("acct_one")
            )
            XCTFail("Server failure must be typed")
        } catch {
            XCTAssertEqual(
                error as? NativeBootstrapError,
                .server(statusCode: 401, code: "device_revoked")
            )
        }
    }

    private var validBody: String {
        """
        {
          "profile":{"id":"acct_one","name":"Tester","email":"test@juno.test","image":null},
          "subscription":{"plan":"free","status":"active"},
          "usage":{"period":"2026-07","messageCount":0,"promptTokens":"0","completionTokens":"0"},
          "settings":null,
          "featureFlags":{},
          "currentChangeCursor":"42",
          "compactionFloorCursor":"10",
          "modelManifestVersion":"models-2026-07",
          "contractVersion":"\(JunoNativeContract.version)",
          "minimumClientVersions":{"macOS":"3.0.0"},
          "announcements":[]
        }
        """
    }

    private func response(body: String) -> HTTPResponse {
        HTTPResponse(
            statusCode: 200,
            headers: HTTPHeaders(),
            body: Data(body.utf8)
        )
    }
}

private actor BootstrapSender: NativeAuthenticatedRequestSending {
    private let response: HTTPResponse
    private(set) var requests: [(NativeBearerRequest, AccountID)] = []

    init(response: HTTPResponse) {
        self.response = response
    }

    func send(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPResponse {
        requests.append((request, accountID))
        return response
    }
}
