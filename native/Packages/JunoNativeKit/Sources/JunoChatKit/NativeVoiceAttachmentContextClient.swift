import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// The server's durable context result for one composed Voice turn.
///
/// The native client sends attachment ids and a question, never document
/// bytes, to `/api/voice/context`. The response is bounded and carries state
/// for every exact id so indexing and parser failures remain visible to the
/// caller instead of becoming an empty answer.
public struct NativeVoiceAttachmentContext: Decodable, Equatable, Sendable {
    public enum Availability: String, Decodable, Sendable {
        case ready
        case pending
        case unavailable
    }

    public struct Item: Decodable, Equatable, Sendable {
        public let id: String
        public let fileName: String
        public let kind: String
        public let availability: Availability
        public let parserState: String
    }

    public let context: String
    public let attachments: [Item]
    public let truncated: Bool

    public var hasPendingAttachments: Bool {
        attachments.contains { $0.availability == .pending }
    }

    public var hasUnavailableAttachments: Bool {
        attachments.contains { $0.availability == .unavailable }
    }
}

public enum NativeVoiceAttachmentContextError: Error, Equatable, LocalizedError, Sendable {
    case invalidRequest
    case malformedResponse
    case server(statusCode: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .invalidRequest:
            "Juno could not prepare the attachment context."
        case .malformedResponse:
            "Juno returned an invalid attachment context."
        case .server(_, let message):
            message
        }
    }
}

public struct NativeVoiceAttachmentContextClient: Sendable {
    public static let maximumAttachments = 4
    public static let maximumQueryCharacters = 4_000

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func fetch(
        attachmentIDs: [String],
        query: String,
        provider: String?,
        for accountID: AccountID
    ) async throws -> NativeVoiceAttachmentContext {
        let ids = Array(
            attachmentIDs
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .prefix(Self.maximumAttachments)
        )
        let trimmedQuery = query
            .replacingOccurrences(of: "\u{0000}", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ids.isEmpty, !trimmedQuery.isEmpty else {
            throw NativeVoiceAttachmentContextError.invalidRequest
        }

        let body = try JSONEncoder().encode(
            RequestWire(
                attachmentIds: ids,
                query: String(trimmedQuery.prefix(Self.maximumQueryCharacters)),
                provider: provider
            )
        )
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/voice/context",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: body
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw NativeVoiceAttachmentContextError.server(
                statusCode: response.statusCode,
                message: Self.errorMessage(from: response)
            )
        }
        guard let decoded = try? JSONDecoder().decode(
            NativeVoiceAttachmentContext.self,
            from: response.body
        ) else {
            throw NativeVoiceAttachmentContextError.malformedResponse
        }
        return decoded
    }

    private static func errorMessage(from response: HTTPResponse) -> String {
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        return (object?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? "Juno could not load attachment context (\(response.statusCode))."
    }
}

private struct RequestWire: Encodable {
    let attachmentIds: [String]
    let query: String
    let provider: String?
}
