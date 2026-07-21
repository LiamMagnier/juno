import Foundation
import JunoAPI
import JunoCore
import XCTest
@testable import JunoAuth

final class NativeAuthRuntimeTests: XCTestCase {
    func testPlannerBuildsCanonicalRequestAndValidatesCallback() throws {
        let planner = try makePlanner()
        let attempt = try planner.makeAttempt(
            installationID: InstallationID("installation_00000000000000000000000000000000")
        )
        let components = try XCTUnwrap(
            URLComponents(url: attempt.authorizationURL, resolvingAgainstBaseURL: false)
        )
        let query = Dictionary(
            uniqueKeysWithValues: (components.queryItems ?? []).compactMap { item in
                item.value.map { (item.name, $0) }
            }
        )

        XCTAssertEqual(components.scheme, "https")
        XCTAssertEqual(components.host, "juno.test")
        XCTAssertEqual(components.path, "/app-auth")
        XCTAssertEqual(query["code_challenge_method"], "S256")
        XCTAssertEqual(
            query["redirect_uri"],
            JunoNativeContract.canonicalRedirectURI
        )
        XCTAssertEqual(attempt.callbackScheme, "com.liammagnier.juno")

        let callback = try callbackURL(for: attempt, code: validCode)
        XCTAssertEqual(
            try planner.authorizationCode(from: callback, for: attempt),
            validCode
        )
    }

    func testPlannerRejectsTamperingDuplicatesAndMalformedCode() throws {
        let planner = try makePlanner()
        let attempt = try planner.makeAttempt(
            installationID: InstallationID("installation_00000000000000000000000000000000")
        )
        let wrongState = URL(
            string: "com.liammagnier.juno://auth/callback?code=\(validCode)&state=wrong&nonce=\(attempt.nonce.value)"
        )!
        XCTAssertThrowsError(
            try planner.authorizationCode(from: wrongState, for: attempt)
        )

        var duplicateComponents = URLComponents(
            string: JunoNativeContract.canonicalRedirectURI
        )!
        duplicateComponents.queryItems = [
            URLQueryItem(name: "code", value: validCode),
            URLQueryItem(name: "code", value: validCode),
            URLQueryItem(name: "state", value: attempt.state.value),
            URLQueryItem(name: "nonce", value: attempt.nonce.value),
        ]
        let duplicate = try XCTUnwrap(duplicateComponents.url)
        XCTAssertThrowsError(
            try planner.authorizationCode(from: duplicate, for: attempt)
        )

        let malformed = try callbackURL(for: attempt, code: "contains space")
        XCTAssertThrowsError(
            try planner.authorizationCode(from: malformed, for: attempt)
        ) { error in
            XCTAssertEqual(
                error as? NativeBrowserAuthorizationError,
                .malformedAuthorizationCode
            )
        }
    }

    func testInstallationIdentifierIsStableAndMalformedValueFailsClosed() async throws {
        let security = TestSecurityClient()
        let store = KeychainInstallationIDStore(
            securityClient: security,
            generator: PKCEGenerator(random: FixedRandomBytes())
        )

        let first = try await store.loadOrCreate()
        let second = try await store.loadOrCreate()
        XCTAssertEqual(first, second)
        XCTAssertEqual(security.upsertCount, 1)

        let malformedSecurity = TestSecurityClient()
        malformedSecurity.seedOnly(Data("bad id".utf8))
        let malformedStore = KeychainInstallationIDStore(
            securityClient: malformedSecurity
        )
        do {
            _ = try await malformedStore.loadOrCreate()
            XCTFail("Malformed secure installation state must fail closed")
        } catch {
            XCTAssertEqual(
                error as? NativeBrowserAuthorizationError,
                .malformedStoredInstallationIdentifier
            )
        }
    }

    func testAPIExchangeUsesExistingContractAndDecodesDeviceTokens() async throws {
        let transport = QueueTransport(responses: [tokenResponse()])
        let client = try makeAPIClient(transport: transport)
        let issued = try await client.exchangeAuthorizationCode(
            code: validCode,
            verifier: PKCECodeVerifier(String(repeating: "v", count: 43)),
            redirectURI: JunoNativeContract.canonicalRedirectURI,
            installationID: InstallationID(
                "installation_00000000000000000000000000000000"
            ),
            device: NativeDeviceMetadata(
                name: "Test Mac",
                platform: "macOS",
                appVersion: "0.1.0"
            )
        )

        XCTAssertEqual(issued.deviceID.rawValue, "device_one")
        XCTAssertEqual(issued.accessToken, try AccessToken("access-one"))
        XCTAssertEqual(
            issued.refreshToken,
            try RefreshToken(refreshToken)
        )
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.url.path, "/api/v1/auth/token")
        XCTAssertEqual(request.method, .post)
        XCTAssertNil(request.headers["authorization"])
        let body = try XCTUnwrap(request.body)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: String]
        )
        XCTAssertEqual(object["redirectUri"], JunoNativeContract.canonicalRedirectURI)
        XCTAssertEqual(object["platform"], "macOS")
    }

    func testRefreshMapsReuseAndRateLimitErrors() async throws {
        let reuse = errorResponse(status: 401, code: "token_reuse_detected")
        let limited = errorResponse(
            status: 429,
            code: "rate_limited",
            retryAfterMilliseconds: 4_000
        )
        let transport = QueueTransport(responses: [reuse, limited])
        let client = try makeAPIClient(transport: transport)
        let credential = try RefreshCredential(
            accountID: AccountID("acct_one"),
            deviceID: DeviceID("device_one"),
            refreshToken: RefreshToken(refreshToken)
        )

        do {
            _ = try await client.refresh(credential: credential)
            XCTFail("Expected reuse detection")
        } catch {
            XCTAssertEqual(error as? AuthRefreshFailure, .refreshTokenReused)
        }
        do {
            _ = try await client.refresh(credential: credential)
            XCTFail("Expected rate limiting")
        } catch {
            XCTAssertEqual(
                error as? AuthRefreshFailure,
                .rateLimited(retryAfterMilliseconds: 4_000)
            )
        }
    }

    func testRuntimeCompletesRealContractRestoresAndSignsOut() async throws {
        let transport = QueueTransport(
            responses: [
                tokenResponse(),
                sessionResponse(),
                sessionResponse(),
                successResponse(body: #"{"revoked":true}"#),
            ]
        )
        let security = TestSecurityClient()
        let tokenStore = KeychainAuthTokenStore(securityClient: security)
        let runtime = try makeRuntime(
            transport: transport,
            security: security,
            tokenStore: tokenStore
        )
        let attempt = try await runtime.beginAuthorization()
        let callback = try callbackURL(for: attempt, code: validCode)

        let signedIn = try await runtime.completeAuthorization(
            attempt,
            callbackURL: callback
        )
        XCTAssertEqual(signedIn.profile.id.rawValue, "acct_one")
        XCTAssertEqual(signedIn.deviceID.rawValue, "device_one")
        let storedAfterSignIn = try await tokenStore.loadActive()
        XCTAssertNotNil(storedAfterSignIn)

        let restored = try await runtime.restore()
        XCTAssertEqual(restored, signedIn)
        try await runtime.signOut()
        let storedAfterSignOut = try await tokenStore.loadActive()
        XCTAssertNil(storedAfterSignOut)

        let requests = await transport.requests
        XCTAssertEqual(
            requests.map(\.url.path),
            [
                "/api/v1/auth/token",
                "/api/v1/auth/session",
                "/api/v1/auth/session",
                "/api/v1/auth/logout",
            ]
        )
        XCTAssertTrue(
            requests.dropFirst().allSatisfy {
                $0.headers["authorization"] == "Bearer access-one"
            }
        )
    }

    func testRuntimeRejectsMismatchedDeviceWithoutPersistingTokens() async throws {
        let transport = QueueTransport(
            responses: [tokenResponse(), sessionResponse(deviceID: "device_other")]
        )
        let security = TestSecurityClient()
        let tokenStore = KeychainAuthTokenStore(securityClient: security)
        let runtime = try makeRuntime(
            transport: transport,
            security: security,
            tokenStore: tokenStore
        )
        let attempt = try await runtime.beginAuthorization()

        do {
            _ = try await runtime.completeAuthorization(
                attempt,
                callbackURL: callbackURL(for: attempt, code: validCode)
            )
            XCTFail("A session for another device must be rejected")
        } catch {
            XCTAssertEqual(
                error as? NativeAuthAPIError,
                .deviceSessionMismatch
            )
        }
        let stored = try await tokenStore.loadActive()
        XCTAssertNil(stored)
    }

    func testAuthenticatedRequestRefreshesOnceAfterUnauthorized() async throws {
        let transport = QueueTransport(
            responses: [
                errorResponse(status: 401, code: "token_expired"),
                refreshResponse(),
                successResponse(body: #"{"ok":true}"#),
            ]
        )
        let security = TestSecurityClient()
        let tokenStore = KeychainAuthTokenStore(securityClient: security)
        let accountID = try AccountID("acct_one")
        try await tokenStore.storeInitial(
            AuthTokenSet(
                accountID: accountID,
                deviceID: try DeviceID("device_one"),
                accessToken: try AccessToken("access-one"),
                accessTokenExpiresAt: Date(timeIntervalSince1970: 2_100_000_000),
                refreshToken: try RefreshToken(refreshToken),
                refreshTokenExpiresAt: Date(timeIntervalSince1970: 2_200_000_000)
            )
        )
        let runtime = try makeRuntime(
            transport: transport,
            security: security,
            tokenStore: tokenStore
        )

        let response = try await runtime.send(
            NativeBearerRequest(path: "/api/v1/bootstrap"),
            for: accountID
        )
        XCTAssertEqual(response.statusCode, 200)

        let requests = await transport.requests
        XCTAssertEqual(
            requests.map(\.url.path),
            ["/api/v1/bootstrap", "/api/v1/auth/refresh", "/api/v1/bootstrap"]
        )
        XCTAssertEqual(requests[0].headers["authorization"], "Bearer access-one")
        XCTAssertNil(requests[1].headers["authorization"])
        XCTAssertEqual(requests[2].headers["authorization"], "Bearer access-two")
    }

    func testBearerRequestRejectsCallerCredentialHeaders() throws {
        for header in ["Authorization", "Cookie"] {
            let headers = try HTTPHeaders([header: "caller-controlled"])
            XCTAssertThrowsError(
                try NativeBearerRequest(
                    path: "/api/v1/bootstrap",
                    headers: headers
                )
            ) { error in
                XCTAssertEqual(
                    error as? NativeBearerRequestError,
                    .callerSuppliedCredentialHeader(header.lowercased())
                )
            }
        }
    }

    private let validCode = "authorization_code_0000000000000000000000000000"
    private let refreshToken = "refresh_token_00000000000000000000000000000000000000000000"

    private func makePlanner() throws -> NativeAuthorizationPlanner {
        try NativeAuthorizationPlanner(
            origin: APIOrigin(URL(string: "https://juno.test")!),
            generator: PKCEGenerator(random: FixedRandomBytes())
        )
    }

    private func makeAPIClient(
        transport: QueueTransport
    ) throws -> NativeAuthAPIClient {
        NativeAuthAPIClient(
            origin: try APIOrigin(URL(string: "https://juno.test")!),
            transport: transport
        )
    }

    private func makeRuntime(
        transport: QueueTransport,
        security: TestSecurityClient,
        tokenStore: KeychainAuthTokenStore
    ) throws -> NativeAuthRuntime {
        let origin = try APIOrigin(URL(string: "https://juno.test")!)
        return try NativeAuthRuntime(
            tokenStore: tokenStore,
            installationStore: KeychainInstallationIDStore(
                securityClient: security,
                generator: PKCEGenerator(random: FixedRandomBytes())
            ),
            planner: NativeAuthorizationPlanner(
                origin: origin,
                generator: PKCEGenerator(random: FixedRandomBytes())
            ),
            apiClient: NativeAuthAPIClient(origin: origin, transport: transport),
            device: NativeDeviceMetadata(
                name: "Test device",
                platform: "macOS",
                appVersion: "0.1.0"
            )
        )
    }

    private func callbackURL(
        for attempt: NativeAuthorizationAttempt,
        code: String
    ) throws -> URL {
        var components = URLComponents(
            string: JunoNativeContract.canonicalRedirectURI
        )!
        components.queryItems = [
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "state", value: attempt.state.value),
            URLQueryItem(name: "nonce", value: attempt.nonce.value),
        ]
        return try XCTUnwrap(components.url)
    }

    private func tokenResponse() -> HTTPResponse {
        successResponse(
            body: """
            {
              "tokenType":"Bearer",
              "accessToken":"access-one",
              "accessTokenExpiresAt":"2033-05-18T04:33:20Z",
              "refreshToken":"\(refreshToken)",
              "refreshTokenExpiresAt":"2033-06-17T04:33:20Z",
              "deviceSession":{
                "id":"device_one",
                "name":"Test device",
                "createdAt":"2033-05-18T03:33:20Z"
              }
            }
            """
        )
    }

    private func sessionResponse(deviceID: String = "device_one") -> HTTPResponse {
        successResponse(
            body: """
            {
              "profile":{
                "id":"acct_one",
                "name":"Juno Tester",
                "email":"test@juno.test",
                "image":null
              },
              "deviceSession":{
                "id":"\(deviceID)",
                "name":"Test device",
                "createdAt":"2033-05-18T03:33:20Z"
              },
              "accessTokenExpiresAt":"2033-05-18T04:33:20Z",
              "contractVersion":"\(JunoNativeContract.version)",
              "minimumSupportedAppVersion":"0.1.0"
            }
            """
        )
    }

    private func refreshResponse() -> HTTPResponse {
        successResponse(
            body: """
            {
              "tokenType":"Bearer",
              "accessToken":"access-two",
              "accessTokenExpiresAt":"2033-05-18T05:33:20Z",
              "refreshToken":"refresh_token_two_000000000000000000000000000000000000000",
              "refreshTokenExpiresAt":"2033-06-17T04:33:20Z"
            }
            """
        )
    }

    private func successResponse(body: String) -> HTTPResponse {
        HTTPResponse(
            statusCode: 200,
            headers: HTTPHeaders(),
            body: Data(body.utf8)
        )
    }

    private func errorResponse(
        status: Int,
        code: String,
        retryAfterMilliseconds: Int? = nil
    ) -> HTTPResponse {
        let retry = retryAfterMilliseconds.map(String.init) ?? "null"
        return HTTPResponse(
            statusCode: status,
            headers: HTTPHeaders(),
            body: Data(
                """
                {
                  "error": {
                    "code": "\(code)",
                    "message": "Failure",
                    "requestId": "request_one",
                    "retryable": false,
                    "retryAfterMs": \(retry)
                  }
                }
                """.utf8
            )
        )
    }
}

private struct FixedRandomBytes: RandomByteGenerating {
    func bytes(count: Int) throws -> [UInt8] {
        (0..<count).map { UInt8(($0 + 1) % 255) }
    }
}

private actor QueueTransport: HTTPTransport {
    private var responses: [HTTPResponse]
    private(set) var requests: [HTTPRequest] = []

    init(responses: [HTTPResponse]) {
        self.responses = responses
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else {
            throw QueueTransportError.noResponse
        }
        return responses.removeFirst()
    }
}

private enum QueueTransportError: Error {
    case noResponse
}

private final class TestSecurityClient: SecurityKeychainClient,
    @unchecked Sendable
{
    private let lock = NSLock()
    private var items: [SecurityKeychainItem: Data] = [:]
    private var storedUpsertCount = 0

    var upsertCount: Int {
        lock.withLock { storedUpsertCount }
    }

    func read(_ item: SecurityKeychainItem) throws -> Data? {
        lock.withLock { items[item] }
    }

    func upsert(_ data: Data, for item: SecurityKeychainItem) throws {
        lock.withLock {
            storedUpsertCount += 1
            items[item] = data
        }
    }

    func delete(_ item: SecurityKeychainItem) throws -> Bool {
        lock.withLock { items.removeValue(forKey: item) != nil }
    }

    func seedOnly(_ data: Data) {
        lock.withLock {
            items[
                SecurityKeychainItem(
                    service: "com.liammagnier.juno.auth.installation",
                    account: "current"
                )
            ] = data
        }
    }
}
