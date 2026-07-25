import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// The three server-backed actions the website offers under every answer, and
/// the phone offered none of: rate it, branch from it, hear it.
///
/// Copy and Regenerate are absent from here on purpose — copying is a pasteboard
/// write with no server in it, and regenerating already exists as
/// `NativeConversationModel.retryLastMessage`.
public struct NativeMessageActionsClient: Sendable {
    public enum Feedback: String, Sendable {
        case up = "UP"
        case down = "DOWN"
    }

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    // MARK: - Feedback

    /// Rates an answer, or clears the rating when `feedback` is nil.
    ///
    /// Nil is a real value here rather than "no change": the web toggles a
    /// thumb off by sending `null`, and the column is nullable for exactly that.
    public func setFeedback(
        messageID: String,
        feedback: Feedback?,
        for accountID: AccountID
    ) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/messages/\(messageID)/feedback",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(FeedbackWire(feedback: feedback?.rawValue))
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw failure(response, fallback: "Juno could not save that rating")
        }
    }

    // MARK: - Branch

    /// Copies the thread up to and including `messageID` into a new conversation
    /// and returns its id.
    public func branch(
        conversationID: String,
        atMessageID: String,
        for accountID: AccountID
    ) async throws -> String {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/conversations/\(conversationID)/fork",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(BranchWire(atMessageId: atMessageID))
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw failure(response, fallback: "Juno could not branch this conversation")
        }
        guard let decoded = try? JSONDecoder().decode(BranchResponseWire.self, from: response.body),
            let id = decoded.conversation?.id ?? decoded.id,
            !id.isEmpty
        else { throw NativeMessageActionError.malformedResponse }
        return id
    }

    // MARK: - Read aloud

    /// Synthesised speech for `text`, as MPEG audio — or **nil when the server
    /// has no TTS configured**.
    ///
    /// Nil rather than an error, because 501 is the documented "fall back to the
    /// platform's own synthesiser" answer, and the web reads it the same way. It
    /// is the one status here that is not a failure.
    public func speech(
        text: String,
        voiceID: String?,
        for accountID: AccountID
    ) async throws -> Data? {
        // The route caps text at 4,000 characters; a long answer is trimmed
        // rather than refused, because half an answer read aloud beats none.
        let trimmed = String(text.prefix(4_000))
        guard !trimmed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }

        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/voice/tts",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "audio/mpeg",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(
                    SpeechWire(text: trimmed, voiceId: voiceID?.nilIfBlank)
                )
            ),
            for: accountID
        )
        if response.statusCode == 501 { return nil }
        guard (200...299).contains(response.statusCode) else {
            throw failure(response, fallback: "Juno could not read this aloud")
        }
        guard !response.body.isEmpty else { return nil }
        return response.body
    }

    private func failure(_ response: HTTPResponse, fallback: String) -> NativeMessageActionError {
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        let message = (object?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return .server(
            statusCode: response.statusCode,
            message: message ?? "\(fallback) (\(response.statusCode))."
        )
    }
}

public enum NativeMessageActionError: Error, Equatable, LocalizedError, Sendable {
    case malformedResponse
    case server(statusCode: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .malformedResponse: "Juno returned an unexpected response."
        case .server(_, let message): message
        }
    }
}

private extension String {
    var nilIfBlank: String? {
        trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self
    }
}

private struct FeedbackWire: Encodable { let feedback: String? }
private struct SpeechWire: Encodable { let text: String; let voiceId: String? }
private struct BranchWire: Encodable { let atMessageId: String }
/// The route has answered with both shapes across revisions; accept either
/// rather than breaking on the one this build did not expect.
private struct BranchResponseWire: Decodable {
    struct Conversation: Decodable { let id: String }
    let conversation: Conversation?
    let id: String?
}
