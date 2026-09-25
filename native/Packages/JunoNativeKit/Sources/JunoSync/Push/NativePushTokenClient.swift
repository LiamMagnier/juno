import Foundation
import JunoAPI
import JunoAuth
import JunoCore

/// The two switches a device's pushes follow, the same pair every push
/// destination carries on the server (`PushPreferences` in
/// `src/lib/notify/types.ts`).
///
/// `needsYou` is blocking work: an approval or a question a task is waiting
/// on. `updates` is everything else: a task finished or failed, an agent has
/// ideas, a handoff landed.
public struct NativePushPreferences: Codable, Equatable, Sendable {
    public var needsYou: Bool
    public var updates: Bool

    public init(needsYou: Bool = true, updates: Bool = true) {
        self.needsYou = needsYou
        self.updates = updates
    }
}

/// What the server is told about this device's APNs token.
public struct NativePushTokenRegistration: Equatable, Sendable {
    /// Lowercase hex, as APNs addresses the device.
    public var token: String
    /// `ios` or `macos`.
    public var platform: String
    /// The APNs topic the server signs this device's pushes for, which is the
    /// app's own bundle id — a Debug and a Next build are different topics.
    public var bundleID: String?
    /// `sandbox` or `production`. The server corrects a wrong guess on the
    /// first push rather than dropping the token.
    public var environment: String
    public var preferences: NativePushPreferences

    public init(
        token: String,
        platform: String,
        bundleID: String?,
        environment: String,
        preferences: NativePushPreferences
    ) {
        self.token = token
        self.platform = platform
        self.bundleID = bundleID
        self.environment = environment
        self.preferences = preferences
    }
}

/// The server's copy of a registered token.
public struct NativePushTokenRecord: Equatable, Sendable {
    public let id: String
    public let active: Bool
    public let preferences: NativePushPreferences
}

public enum NativePushTokenError: Error, Equatable, LocalizedError, Sendable {
    case invalidToken
    case invalidIdentifier
    case server(statusCode: Int, code: String?)
    case malformedResponse

    public var errorDescription: String? {
        switch self {
        case .invalidToken:
            "This device gave Juno a notification token it cannot use."
        case .invalidIdentifier:
            "Juno could not read that notification."
        case .server(let statusCode, let code):
            "Juno could not set up notifications on this device (\(code ?? String(statusCode)))."
        case .malformedResponse:
            "Juno returned an invalid notification registration."
        }
    }
}

/// `POST` and `DELETE /api/v1/devices/apns`, and marking an opened
/// notification read, over the native bearer.
///
/// A re-POST of the same token is how a switch changes: the server upserts on
/// the token and answers with what it now holds, so there is no separate
/// preferences route to keep in step.
public struct NativePushTokenClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func register(
        _ registration: NativePushTokenRegistration,
        for accountID: AccountID
    ) async throws -> NativePushTokenRecord {
        guard Self.isHexToken(registration.token) else { throw NativePushTokenError.invalidToken }
        let body = RegisterBody(
            token: registration.token,
            platform: registration.platform,
            bundleId: registration.bundleID,
            environment: registration.environment,
            notifyNeedsYou: registration.preferences.needsYou,
            notifyUpdates: registration.preferences.updates
        )
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/v1/devices/apns",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(body)
            ),
            for: accountID
        )
        try requireSuccess(response)
        let wire: RegisterResponse
        do {
            wire = try JSONDecoder().decode(RegisterResponse.self, from: response.body)
        } catch {
            throw NativePushTokenError.malformedResponse
        }
        guard wire.registered else { throw NativePushTokenError.malformedResponse }
        let record = wire.devicePushToken
        return NativePushTokenRecord(
            id: record.id,
            active: record.active,
            preferences: NativePushPreferences(
                needsYou: record.notifyNeedsYou ?? registration.preferences.needsYou,
                updates: record.notifyUpdates ?? registration.preferences.updates
            )
        )
    }

    /// Stops this token's pushes for the account. Signing out does not need
    /// it — the server deactivates a device session's tokens when the session
    /// is revoked — so this is for a person turning pushes off on purpose.
    public func unregister(token: String, for accountID: AccountID) async throws {
        guard Self.isHexToken(token) else { throw NativePushTokenError.invalidToken }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/v1/devices/apns",
                method: .delete,
                queryItems: [URLQueryItem(name: "token", value: token)],
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
    }

    /// Marks a notification read once its push has been opened, so the web
    /// inbox does not keep offering what the phone already showed. Idempotent
    /// on the server; a 404 means the row is not this account's and is not
    /// worth an error.
    public func markRead(notificationID: String, for accountID: AccountID) async throws {
        guard JunoNotificationRoute.isValidIdentifier(notificationID) else {
            throw NativePushTokenError.invalidIdentifier
        }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/notifications/\(notificationID)",
                method: .patch,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        if response.statusCode == 404 { return }
        try requireSuccess(response)
    }

    /// APNs tokens are hex, and the server refuses anything else; checking
    /// here keeps a malformed token from costing a request.
    static func isHexToken(_ token: String) -> Bool {
        guard (32...400).contains(token.utf8.count) else { return false }
        return token.utf8.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66)
        }
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let code = try? JSONDecoder().decode(
            NativeAPIErrorEnvelope.self,
            from: response.body
        ).error.code
        throw NativePushTokenError.server(statusCode: response.statusCode, code: code)
    }
}

// MARK: - Wire

/// A nil `bundleId` is left out rather than sent as `null`: synthesized
/// encoding skips an absent optional, and the server takes the key as
/// optional, not nullable.
private struct RegisterBody: Encodable {
    let token: String
    let platform: String
    let bundleId: String?
    let environment: String
    let notifyNeedsYou: Bool
    let notifyUpdates: Bool
}

private struct RegisterResponse: Decodable {
    struct Record: Decodable {
        let id: String
        let active: Bool
        let notifyNeedsYou: Bool?
        let notifyUpdates: Bool?
    }

    let registered: Bool
    let devicePushToken: Record
}
