import Foundation
import JunoAPI
import JunoCore

public enum NativeAuthAPIError: Error, Equatable, LocalizedError, Sendable {
    case server(statusCode: Int, code: String?)
    case malformedResponse
    case invalidTokenType
    case contractVersionMismatch(expected: String, received: String)
    case deviceSessionMismatch

    public var errorDescription: String? {
        switch self {
        case .server(let statusCode, let code):
            if statusCode == 401 {
                "Your Juno session is no longer active."
            } else if statusCode == 429 {
                "Too many sign-in requests. Please wait a moment and try again."
            } else {
                "Juno returned an authentication error (\(code ?? String(statusCode)))."
            }
        case .malformedResponse, .invalidTokenType:
            "Juno returned an invalid authentication response."
        case .contractVersionMismatch:
            "This version of Juno is not compatible with the server."
        case .deviceSessionMismatch:
            "The returned Juno session belongs to another device."
        }
    }
}

public struct NativeDeviceMetadata: Equatable, Sendable {
    public let name: String
    public let platform: String
    public let appVersion: String

    public init(name: String, platform: String, appVersion: String) throws {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPlatform = platform.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedVersion = appVersion.trimmingCharacters(in: .whitespacesAndNewlines)
        try BoundedValue.validateText(
            trimmedName,
            field: "deviceName",
            maximumUTF8Bytes: 120
        )
        try BoundedValue.validateText(
            trimmedPlatform,
            field: "platform",
            maximumUTF8Bytes: 40
        )
        try BoundedValue.validateText(
            trimmedVersion,
            field: "appVersion",
            maximumUTF8Bytes: 40
        )
        self.name = trimmedName
        self.platform = trimmedPlatform
        self.appVersion = trimmedVersion
    }
}

public struct NativeAccountProfile: Equatable, Sendable {
    public let id: AccountID
    public let name: String?
    public let email: String
    public let imageURL: URL?

    public init(id: AccountID, name: String?, email: String, imageURL: URL?) {
        self.id = id
        self.name = name
        self.email = email
        self.imageURL = imageURL
    }
}

public struct NativeAuthenticatedSession: Equatable, Sendable {
    public let profile: NativeAccountProfile
    public let deviceID: DeviceID

    public init(profile: NativeAccountProfile, deviceID: DeviceID) {
        self.profile = profile
        self.deviceID = deviceID
    }
}

public struct NativeIssuedTokens: Equatable, Sendable {
    public let deviceID: DeviceID
    public let accessToken: AccessToken
    public let accessTokenExpiresAt: Date
    public let refreshToken: RefreshToken
    public let refreshTokenExpiresAt: Date
}

public struct NativeAuthAPIClient: AuthRefreshClient, Sendable {
    private let client: BoundedHTTPClient

    public init(client: BoundedHTTPClient) {
        self.client = client
    }

    public init(
        origin: APIOrigin,
        transport: any HTTPTransport
    ) {
        client = BoundedHTTPClient(origin: origin, transport: transport)
    }

    public func exchangeAuthorizationCode(
        code: String,
        verifier: PKCECodeVerifier,
        redirectURI: String,
        installationID: InstallationID,
        device: NativeDeviceMetadata
    ) async throws -> NativeIssuedTokens {
        let body = TokenExchangeBody(
            code: code,
            codeVerifier: verifier.value,
            redirectUri: redirectURI,
            installationId: installationID.rawValue,
            deviceName: device.name,
            platform: device.platform,
            appVersion: device.appVersion
        )
        let response = try await sendJSON(
            path: "/api/v1/auth/token",
            method: .post,
            body: body
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(from: response)
        }
        let decoded: NativeTokenResponse = try decode(response.body)
        guard decoded.tokenType == "Bearer" else {
            throw NativeAuthAPIError.invalidTokenType
        }
        guard let deviceSession = decoded.deviceSession else {
            throw NativeAuthAPIError.malformedResponse
        }
        return try issuedTokens(from: decoded, deviceID: DeviceID(deviceSession.id))
    }

    public func refresh(credential: RefreshCredential) async throws -> RefreshedTokens {
        let response: HTTPResponse
        do {
            response = try await sendJSON(
                path: "/api/v1/auth/refresh",
                method: .post,
                body: RefreshBody(refreshToken: credential.refreshToken.reveal())
            )
        } catch {
            throw AuthRefreshFailure.transient
        }
        guard (200...299).contains(response.statusCode) else {
            throw refreshFailure(from: response)
        }
        do {
            let decoded: NativeTokenResponse = try decode(response.body)
            guard decoded.tokenType == "Bearer" else {
                throw AuthRefreshFailure.malformedResponse
            }
            return try RefreshedTokens(
                accessToken: AccessToken(decoded.accessToken),
                accessTokenExpiresAt: parseDate(decoded.accessTokenExpiresAt),
                refreshToken: RefreshToken(decoded.refreshToken),
                refreshTokenExpiresAt: parseDate(decoded.refreshTokenExpiresAt)
            )
        } catch let failure as AuthRefreshFailure {
            throw failure
        } catch {
            throw AuthRefreshFailure.malformedResponse
        }
    }

    public func session(accessToken: AccessToken) async throws
        -> NativeAuthenticatedSession
    {
        let headers = try HTTPHeaders([
            "accept": "application/json",
            "authorization": "Bearer \(accessToken.reveal())",
        ])
        let request = try client.makeRequest(
            path: "/api/v1/auth/session",
            method: .get,
            headers: headers
        )
        let response = try await client.send(request)
        guard (200...299).contains(response.statusCode) else {
            throw serverError(from: response)
        }
        let decoded: NativeSessionResponse = try decode(response.body)
        guard decoded.contractVersion == JunoNativeContract.version else {
            throw NativeAuthAPIError.contractVersionMismatch(
                expected: JunoNativeContract.version,
                received: decoded.contractVersion
            )
        }
        let profile = try NativeAccountProfile(
            id: AccountID(decoded.profile.id),
            name: decoded.profile.name,
            email: decoded.profile.email,
            imageURL: decoded.profile.image.flatMap(URL.init(string:))
        )
        return try NativeAuthenticatedSession(
            profile: profile,
            deviceID: DeviceID(decoded.deviceSession.id)
        )
    }

    public func logout(accessToken: AccessToken) async throws {
        let headers = try HTTPHeaders([
            "accept": "application/json",
            "authorization": "Bearer \(accessToken.reveal())",
        ])
        let request = try client.makeRequest(
            path: "/api/v1/auth/logout",
            method: .post,
            headers: headers
        )
        let response = try await client.send(request)
        guard (200...299).contains(response.statusCode) else {
            throw serverError(from: response)
        }
    }

    private func sendJSON<Body: Encodable & Sendable>(
        path: String,
        method: HTTPMethod,
        body: Body
    ) async throws -> HTTPResponse {
        let headers = try HTTPHeaders([
            "accept": "application/json",
            "content-type": "application/json",
        ])
        let request = try client.makeRequest(
            path: path,
            method: method,
            headers: headers,
            body: try JSONEncoder().encode(body)
        )
        return try await client.send(request)
    }

    private func issuedTokens(
        from response: NativeTokenResponse,
        deviceID: DeviceID
    ) throws -> NativeIssuedTokens {
        do {
            let accessExpiry = try parseDate(response.accessTokenExpiresAt)
            let refreshExpiry = try parseDate(response.refreshTokenExpiresAt)
            guard accessExpiry <= refreshExpiry else {
                throw NativeAuthAPIError.malformedResponse
            }
            return NativeIssuedTokens(
                deviceID: deviceID,
                accessToken: try AccessToken(response.accessToken),
                accessTokenExpiresAt: accessExpiry,
                refreshToken: try RefreshToken(response.refreshToken),
                refreshTokenExpiresAt: refreshExpiry
            )
        } catch let error as NativeAuthAPIError {
            throw error
        } catch {
            throw NativeAuthAPIError.malformedResponse
        }
    }

    private func parseDate(_ value: String) throws -> Date {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value)
            ?? ISO8601DateFormatter().date(from: value)
        {
            return date
        }
        throw NativeAuthAPIError.malformedResponse
    }

    private func decode<Value: Decodable>(_ data: Data) throws -> Value {
        do {
            return try JSONDecoder().decode(Value.self, from: data)
        } catch {
            throw NativeAuthAPIError.malformedResponse
        }
    }

    private func serverError(from response: HTTPResponse) -> NativeAuthAPIError {
        let code = try? JSONDecoder().decode(
            NativeAPIErrorEnvelope.self,
            from: response.body
        ).error.code
        return .server(statusCode: response.statusCode, code: code)
    }

    private func refreshFailure(from response: HTTPResponse) -> AuthRefreshFailure {
        let detail = try? JSONDecoder().decode(
            NativeAPIErrorEnvelope.self,
            from: response.body
        ).error
        switch detail?.code {
        case "invalid_grant":
            return .invalidGrant
        case "token_expired":
            return .expired
        case "token_reuse_detected":
            return .refreshTokenReused
        case "account_banned":
            return .accountBanned
        case "device_revoked":
            return .deviceRevoked
        case "unauthenticated":
            return .sessionInvalidated
        default:
            if response.statusCode == 429 {
                return .rateLimited(retryAfterMilliseconds: detail?.retryAfterMs)
            }
            if response.statusCode >= 500 {
                return .transient
            }
            return .malformedResponse
        }
    }
}

private struct TokenExchangeBody: Encodable, Sendable {
    let code: String
    let codeVerifier: String
    let redirectUri: String
    let installationId: String
    let deviceName: String
    let platform: String
    let appVersion: String
}

private struct RefreshBody: Encodable, Sendable {
    let refreshToken: String
}
