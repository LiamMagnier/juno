import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// Asks the server what a reader might sensibly ask next.
///
/// The same `POST /api/chat/follow-ups` the browser calls. The server owns the
/// judgement entirely — it reads the stored transcript, runs a utility prompt and
/// returns at most three lines — so a client's only job is to ask and to render.
/// Nothing here inspects the conversation, which is what keeps the three clients
/// from proposing three different sets of follow-ups for one exchange.
///
/// BEST-EFFORT, ALWAYS. The route itself returns `{ suggestions: [] }` rather than
/// an error when the utility model fails, and this mirrors that: every failure
/// path here yields an empty array. A suggestion strip that fails loudly would be
/// an error message under a reply that arrived perfectly well.
public struct NativeFollowUpClient: Sendable {
    /// The server returns three; this is the guard against a future change to that
    /// promise arriving as an unbounded strip on a phone.
    private static let maximum = 3
    /// Long enough for a real question, short enough that one suggestion cannot
    /// become the tallest thing on screen.
    private static let maximumLength = 240

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func suggestions(
        conversationID: String,
        for accountID: AccountID
    ) async -> [String] {
        guard !conversationID.isEmpty else { return [] }
        let body = RequestWire(conversationId: conversationID)
        guard
            let request = try? NativeBearerRequest(
                path: "/api/chat/follow-ups",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(body)
            ),
            let response = try? await sender.send(request, for: accountID),
            (200...299).contains(response.statusCode),
            let wire = try? JSONDecoder().decode(ResponseWire.self, from: response.body)
        else { return [] }

        return wire.suggestions
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0.count <= Self.maximumLength }
            .prefix(Self.maximum)
            .map { $0 }
    }
}

private struct RequestWire: Encodable {
    let conversationId: String
}

private struct ResponseWire: Decodable {
    let suggestions: [String]

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // The route returns `{ suggestions: [] }` on every failure it handles, but
        // an absent key is treated the same way rather than as a decode error —
        // the caller's contract is "some suggestions or none", never a throw.
        suggestions = ((try? container.decodeIfPresent([String].self, forKey: .suggestions)) ?? nil) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case suggestions
    }
}
