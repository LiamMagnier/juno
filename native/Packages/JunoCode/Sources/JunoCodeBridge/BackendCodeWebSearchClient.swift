import Foundation
import JunoAPI
import JunoAuth
import JunoCodeRuntime
import JunoCore
import JunoSync

/// Authenticated adapter for Code's first-party web-search tool. The Tavily
/// credential stays on Juno's server; the Mac only receives bounded source
/// metadata through the same bearer-refresh transport as the model stream.
public struct BackendCodeWebSearchClient: CodeWebSearching {
    private let sender: any NativeAuthenticatedRequestSending
    private let accountID: AccountID

    public init(
        sender: any NativeAuthenticatedRequestSending,
        accountID: AccountID
    ) {
        self.sender = sender
        self.accountID = accountID
    }

    public func search(
        query: String,
        maxResults: Int
    ) async throws -> [CodeWebSearchResult] {
        let body = try JSONEncoder().encode(
            SearchRequest(query: query, maxResults: min(max(maxResults, 1), 8))
        )
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/code/search",
                method: .post,
                headers: HTTPHeaders([
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                ]),
                body: body
            ),
            for: accountID
        )

        guard (200...299).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(
                SearchErrorWire.self,
                from: response.body
            ))?.message ?? "The Juno web-search service returned HTTP \(response.statusCode)."
            throw BackendCodeWebSearchError.server(
                statusCode: response.statusCode,
                message: message
            )
        }

        let payload: SearchResponse
        do {
            payload = try JSONDecoder().decode(SearchResponse.self, from: response.body)
        } catch {
            throw BackendCodeWebSearchError.malformedResponse
        }

        // Do not let malformed or unexpectedly large provider data become
        // another path into the model context. Only HTTP(S) sources are
        // useful citations, and each field is capped before it reaches SwiftUI
        // or the agent transcript.
        return payload.sources.compactMap { source in
            guard let url = URL(string: source.url),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https",
                  !source.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            return CodeWebSearchResult(
                title: String(source.title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(400)),
                url: String(source.url.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2_000)),
                snippet: String(source.snippet.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1_000))
            )
        }
    }
}

public enum BackendCodeWebSearchError: Error, Equatable, LocalizedError, Sendable {
    case server(statusCode: Int, message: String)
    case malformedResponse

    public var errorDescription: String? {
        switch self {
        case let .server(_, message): return message
        case .malformedResponse:
            return "Juno returned an invalid web-search response."
        }
    }
}

private struct SearchRequest: Encodable {
    let query: String
    let maxResults: Int

    enum CodingKeys: String, CodingKey {
        case query
        case maxResults = "max_results"
    }
}

private struct SearchResponse: Decodable {
    let sources: [Source]

    struct Source: Decodable {
        let title: String
        let url: String
        let snippet: String
    }
}

private struct SearchErrorWire: Decodable {
    let message: String?
}
