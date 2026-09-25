import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// `GET /api/account/mfa`: the account's two-step verification and whether it
/// has a password at all (Google and Apple accounts do not).
public struct NativeAccountSecurityStatus: Equatable, Sendable {
    public let enabled: Bool
    public let pending: Bool
    public let recoveryCodesRemaining: Int
    public let hasPassword: Bool

    public init(enabled: Bool, pending: Bool, recoveryCodesRemaining: Int, hasPassword: Bool) {
        self.enabled = enabled
        self.pending = pending
        self.recoveryCodesRemaining = recoveryCodesRemaining
        self.hasPassword = hasPassword
    }
}

/// `POST /api/account/mfa/start`: the secret to enrol, and the QR code the
/// server drew for it (a `data:` URL, so no third party ever sees the secret).
public struct NativeTwoStepEnrolment: Equatable, Sendable {
    public let secret: String
    public let otpauthURL: String
    /// The QR code's PNG bytes, decoded from the server's data URL.
    public let qrImage: Data?

    public init(secret: String, otpauthURL: String, qrImage: Data?) {
        self.secret = secret
        self.otpauthURL = otpauthURL
        self.qrImage = qrImage
    }
}

/// Sign-in and security, as Settings › Account draws it on the web
/// (`src/components/auth/account-security.tsx`), plus the profile picture.
///
/// Every sentence a refusal carries is the server's, in a ``NativeWebRouteError``
/// whose `field` says which input it belongs under.
public struct NativeAccountSecurityClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func status(for accountID: AccountID) async throws -> NativeAccountSecurityStatus {
        let object = try await json(path: "/api/account/mfa", method: .get, body: nil, fallback: "Couldn’t load your sign-in settings.", for: accountID)
        return NativeAccountSecurityStatus(
            enabled: object["enabled"] as? Bool ?? false,
            pending: object["pending"] as? Bool ?? false,
            recoveryCodesRemaining: object["recoveryCodesRemaining"] as? Int ?? 0,
            hasPassword: object["hasPassword"] as? Bool ?? true
        )
    }

    public func startTwoStep(for accountID: AccountID) async throws -> NativeTwoStepEnrolment {
        let object = try await json(
            path: "/api/account/mfa/start", method: .post, body: nil,
            fallback: "Couldn’t start setting up two-step verification.", for: accountID
        )
        guard let secret = object["secret"] as? String, let otpauth = object["otpauthUrl"] as? String else {
            throw NativeWebRouteError(statusCode: 200, message: "Couldn’t start setting up two-step verification.")
        }
        return NativeTwoStepEnrolment(
            secret: secret,
            otpauthURL: otpauth,
            qrImage: (object["qrDataUrl"] as? String).flatMap(Self.dataURLBytes)
        )
    }

    /// Turns two-step verification on and returns the ten recovery codes,
    /// shown once.
    public func confirmTwoStep(code: String, for accountID: AccountID) async throws -> [String] {
        let object = try await json(
            path: "/api/account/mfa/confirm", method: .post,
            body: ["code": code.trimmingCharacters(in: .whitespacesAndNewlines)],
            fallback: "That code isn’t right.", for: accountID
        )
        return object["recoveryCodes"] as? [String] ?? []
    }

    /// Turns it off. True when the Admin panel stays locked as a result.
    @discardableResult
    public func disableTwoStep(code: String, for accountID: AccountID) async throws -> Bool {
        let object = try await json(
            path: "/api/account/mfa/disable", method: .post,
            body: ["code": code.trimmingCharacters(in: .whitespacesAndNewlines)],
            fallback: "That code isn’t right.", for: accountID
        )
        return object["ownerAdminLocked"] as? Bool ?? false
    }

    /// Changes the password; the server signs out every device, this one too.
    public func changePassword(current: String, new: String, for accountID: AccountID) async throws {
        _ = try await json(
            path: "/api/account/password", method: .post,
            body: ["currentPassword": current, "newPassword": new],
            fallback: "Couldn’t change your password.", for: accountID
        )
    }

    /// Starts an address change: the server mails a link to the new address.
    public func changeEmail(to address: String, currentPassword: String?, for accountID: AccountID) async throws {
        var body: [String: Any] = ["email": address.trimmingCharacters(in: .whitespacesAndNewlines)]
        if let currentPassword { body["currentPassword"] = currentPassword }
        _ = try await json(
            path: "/api/account/email", method: .post, body: body,
            fallback: "Couldn’t start the change.", for: accountID
        )
    }

    /// Ends every session on every device, this one included.
    public func signOutEverywhere(for accountID: AccountID) async throws {
        _ = try await json(
            path: "/api/account/sessions/revoke", method: .post, body: nil,
            fallback: "Couldn’t sign the other devices out.", for: accountID
        )
    }

    /// Mails a password-reset link to the account's address.
    public func sendPasswordReset(email: String, for accountID: AccountID) async throws -> String? {
        let object = try await json(
            path: "/api/auth/forgot-password", method: .post, body: ["email": email],
            fallback: "Couldn’t send the reset email.", for: accountID
        )
        return object["message"] as? String
    }

    /// Replaces the profile picture (`POST /api/profile/avatar`, JPEG, PNG,
    /// WebP or GIF under 5 MB) and returns its new address.
    public func uploadAvatar(
        data: Data,
        fileName: String,
        mimeType: String,
        for accountID: AccountID
    ) async throws -> URL? {
        let boundary = "juno-native-\(UUID().uuidString.lowercased())"
        let safeName = fileName.replacingOccurrences(of: "\"", with: "")
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\n".utf8))
        body.append(Data("Content-Type: \(mimeType)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/profile/avatar",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "multipart/form-data; boundary=\(boundary)",
                ]),
                body: body
            ),
            for: accountID
        )
        if let error = NativeWebRouteError.from(response, fallback: "Couldn’t update the picture.") { throw error }
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        return (object?["url"] as? String).flatMap(URL.init(string:))
    }

    // MARK: - Plumbing

    private func json(
        path: String,
        method: HTTPMethod,
        body: [String: Any]?,
        fallback: String,
        for accountID: AccountID
    ) async throws -> [String: Any] {
        var headers = ["accept": "application/json"]
        var data: Data?
        if let body {
            headers["content-type"] = "application/json"
            data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        }
        let response = try await sender.send(
            try NativeBearerRequest(path: path, method: method, headers: try HTTPHeaders(headers), body: data),
            for: accountID
        )
        if let error = NativeWebRouteError.from(response, fallback: fallback) { throw error }
        return (try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]) ?? [:]
    }

    /// The bytes of a `data:image/png;base64,…` URL.
    static func dataURLBytes(_ value: String) -> Data? {
        guard value.hasPrefix("data:"), let comma = value.firstIndex(of: ",") else { return nil }
        let header = value[..<comma]
        guard header.hasSuffix(";base64") else { return nil }
        return Data(base64Encoded: String(value[value.index(after: comma)...]))
    }
}
