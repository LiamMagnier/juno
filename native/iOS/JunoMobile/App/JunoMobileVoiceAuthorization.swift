import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import JunoVoiceKit

/// Supplies ``JunoRealtimeVoiceController`` with a relay credential.
///
/// This is the seam `JunoVoiceRelayAuthorizing` exists for. JunoVoiceKit owns the
/// socket, the audio engine and the reconnect and imports neither JunoAuth nor
/// JunoAPI; the account layer owns bearer tokens, refresh and error copy. This
/// adapter is the only place the two meet, and it lives in the app rather than in
/// the package for the same reason — the package must stay testable without a
/// signed-in account.
///
/// **Errors are re-thrown as prose.** The protocol's contract is that whatever is
/// thrown becomes the user-visible failure verbatim through
/// `localizedDescription`, so a raw decode error or a bare status code would
/// surface to the reader as-is. `/api/voice/relay-token` answers a 402 with
/// `budget_exceeded` in its machine `error` slug and the readable sentence in
/// `message`, and only the latter is worth showing — so `message` wins whenever
/// the server sends one.
struct JunoMobileVoiceAuthorization: JunoVoiceRelayAuthorizing {
    private let sender: any NativeAuthenticatedRequestSending
    private let accountID: AccountID

    init(sender: any NativeAuthenticatedRequestSending, accountID: AccountID) {
        self.sender = sender
        self.accountID = accountID
    }

    func relayToken() async throws -> JunoVoiceRelayToken {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/voice/relay-token",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )

        guard (200...299).contains(response.statusCode) else {
            throw JunoMobileVoiceAuthorizationError(
                message: message(from: response.body)
                    ?? fallbackMessage(for: response.statusCode)
            )
        }
        guard let decoded = try? JSONDecoder().decode(
            JunoVoiceRelayTokenResponse.self, from: response.body
        ), !decoded.token.isEmpty else {
            throw JunoMobileVoiceAuthorizationError(
                message: String(localized: "voice.error.malformed-token")
            )
        }
        return decoded.resolved
    }

    /// The route answers failures as `{ "error": …, "message"?: … }` — Next's own
    /// shape, not the native envelope — so this reads both keys and prefers the
    /// sentence over the slug.
    private func message(from body: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            return nil
        }
        if let sentence = object["message"] as? String, !sentence.isEmpty { return sentence }
        guard let slug = object["error"] as? String, !slug.isEmpty else { return nil }
        // A slug is only worth showing when it reads as a sentence. "Unauthorized"
        // does; "budget_exceeded" does not, and that case always carries a
        // `message` anyway.
        return slug.contains("_") ? nil : slug
    }

    private func fallbackMessage(for statusCode: Int) -> String {
        switch statusCode {
        case 401: String(localized: "voice.error.unauthorized")
        case 402, 403: String(localized: "voice.error.plan")
        case 429: String(localized: "voice.error.rate-limited")
        case 503: String(localized: "voice.error.unconfigured")
        default: String(localized: "voice.error.generic")
        }
    }
}

/// A failure whose whole purpose is its sentence — see the note on the type above.
struct JunoMobileVoiceAuthorizationError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
