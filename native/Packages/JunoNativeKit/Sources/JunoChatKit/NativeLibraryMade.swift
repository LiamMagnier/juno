import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// Everything Alevr made, in one paged list: the Library's other half.
///
/// The web's `GET /api/library/made` (src/app/api/library/made/route.ts,
/// src/lib/library-made.ts): chat artifacts and task deliverables (Office
/// documents, spreadsheets, decks, PDFs…), each with a `kind` and a `type`,
/// newest first, with the agent that made it when one did. The apps used to
/// list artifacts from sync and deliverables per task only, so a deck a task
/// produced last week was nowhere in the Library.

// MARK: - Wire

public struct NativeLibraryMadeItem: Identifiable, Equatable, Sendable, Decodable {
    public enum Kind: String, Sendable, Decodable {
        case artifact
        case deliverable
    }

    public struct Agent: Equatable, Sendable, Decodable {
        public let id: String
        public let name: String
    }

    public let kind: Kind
    public let id: String
    /// Artifact: its type (HTML, DESIGN, …). Deliverable: DOCUMENT, SPREADSHEET, PRESENTATION, …
    public let type: String
    public let title: String
    public let version: Int
    public let projectId: String?
    public let createdAt: Date
    public let updatedAt: Date
    /// Where the item opens on the web: `/a/<id>`, or a deliverable's download route.
    public let href: String
    public let conversationId: String?
    public let mimeType: String?
    public let validated: Bool?
    public let agent: Agent?
    /// Artifact only: the opening of its newest version.
    public let preview: String?

    public init(
        kind: Kind,
        id: String,
        type: String,
        title: String,
        version: Int = 1,
        projectId: String? = nil,
        createdAt: Date,
        updatedAt: Date,
        href: String,
        conversationId: String? = nil,
        mimeType: String? = nil,
        validated: Bool? = nil,
        agent: Agent? = nil,
        preview: String? = nil
    ) {
        self.kind = kind
        self.id = id
        self.type = type
        self.title = title
        self.version = version
        self.projectId = projectId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.href = href
        self.conversationId = conversationId
        self.mimeType = mimeType
        self.validated = validated
        self.agent = agent
        self.preview = preview
    }

    /// The list's identity: an artifact and a deliverable can share an id.
    public var listID: String { "\(kind.rawValue):\(id)" }

    /// "Made by Alevr", or by the Orbit member whose thread or task made it.
    public var byline: String {
        "Made by \(agent?.name ?? "Alevr")"
    }

    /// The type in words, as the Library's Type column says it.
    public var typeLabel: String {
        switch type.uppercased() {
        case "HTML": "Web page"
        case "REACT": "App"
        case "SVG": "Image"
        case "MERMAID": "Diagram"
        case "MARKDOWN", "DOCUMENT", "DOCX": "Document"
        case "CODE": "Code"
        case "DESIGN": "Design"
        case "SPREADSHEET", "XLSX", "CSV": "Spreadsheet"
        case "PRESENTATION", "PPTX": "Presentation"
        case "PDF": "PDF"
        case "REPORT": "Report"
        case "SITE": "Site"
        case "IMAGE": "Image"
        default: type.prefix(1).uppercased() + type.dropFirst().lowercased()
        }
    }

    /// A short, single-line excerpt of the artifact's preview, for a row's subtitle.
    public var excerpt: String? {
        guard let preview else { return nil }
        let line = preview
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return nil }
        return String(line.prefix(140))
    }

    private enum CodingKeys: String, CodingKey {
        case kind, id, type, title, version, projectId, createdAt, updatedAt, href
        case conversationId, mimeType, validated, agent, preview
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(Kind.self, forKey: .kind)
        id = try c.decode(String.self, forKey: .id)
        type = try c.decode(String.self, forKey: .type)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        createdAt = try NativeLibraryMadePage.date(c.decode(String.self, forKey: .createdAt))
        updatedAt = try NativeLibraryMadePage.date(c.decode(String.self, forKey: .updatedAt))
        href = try c.decodeIfPresent(String.self, forKey: .href) ?? ""
        conversationId = try c.decodeIfPresent(String.self, forKey: .conversationId)
        mimeType = try c.decodeIfPresent(String.self, forKey: .mimeType)
        validated = try c.decodeIfPresent(Bool.self, forKey: .validated)
        agent = try? c.decodeIfPresent(Agent.self, forKey: .agent)
        preview = try c.decodeIfPresent(String.self, forKey: .preview)
    }
}

public struct NativeLibraryMadePage: Equatable, Sendable, Decodable {
    public let items: [NativeLibraryMadeItem]
    public let nextCursor: String?

    public init(items: [NativeLibraryMadeItem], nextCursor: String?) {
        self.items = items
        self.nextCursor = nextCursor
    }

    public static func decode(_ data: Data) -> NativeLibraryMadePage? {
        try? JSONDecoder().decode(NativeLibraryMadePage.self, from: data)
    }

    static func date(_ raw: String) throws -> Date {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: raw) { return date }
        throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Not an ISO 8601 date: \(raw)"))
    }
}

/// The query `GET /api/library/made` takes.
public struct NativeLibraryMadeQuery: Equatable, Sendable {
    public enum Kind: String, Sendable, CaseIterable {
        case all
        case artifact
        case deliverable
    }

    public var q: String
    public var kind: Kind
    public var projectID: String?
    public var limit: Int

    public init(q: String = "", kind: Kind = .all, projectID: String? = nil, limit: Int = 50) {
        self.q = q
        self.kind = kind
        self.projectID = projectID
        self.limit = limit
    }

    /// The route's query items, in its own spelling; the route caps `q` at
    /// 200 characters and `limit` to 1…100, so the client does the same.
    public func queryItems(cursor: String?) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(min(100, max(1, limit))))]
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { items.append(URLQueryItem(name: "q", value: String(trimmed.prefix(200)))) }
        if kind != .all { items.append(URLQueryItem(name: "kind", value: kind.rawValue)) }
        if let projectID, !projectID.isEmpty { items.append(URLQueryItem(name: "projectId", value: projectID)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return items
    }
}

// MARK: - Client

public struct NativeLibraryMadeClient: Sendable {
    let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func page(
        _ query: NativeLibraryMadeQuery,
        cursor: String? = nil,
        for accountID: AccountID
    ) async throws -> NativeLibraryMadePage {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/library/made",
                queryItems: query.queryItems(cursor: cursor),
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            let envelope = try? JSONDecoder().decode(NativeAPIErrorEnvelope.self, from: response.body)
            let plain = try? JSONDecoder().decode(PlainError.self, from: response.body)
            throw NativeLibraryError.server(
                statusCode: response.statusCode,
                message: envelope?.error.message ?? plain?.error
                    ?? "Alevr could not read what it made (\(response.statusCode))."
            )
        }
        guard let page = NativeLibraryMadePage.decode(response.body) else {
            throw NativeLibraryError.malformedResponse
        }
        return page
    }
}

/// The route's own error body: `{ "error": "Unknown kind" }`.
private struct PlainError: Decodable {
    let error: String
}

// MARK: - Model

/// The made list's state, page by page, one request in flight per query (the
/// web's `useMade`). A query change starts over; a stale answer to an older
/// query is dropped.
@MainActor
@Observable
public final class NativeLibraryMadeModel {
    public private(set) var items: [NativeLibraryMadeItem]?
    public private(set) var nextCursor: String?
    public private(set) var isLoading = false
    public private(set) var isLoadingMore = false
    public private(set) var errorDescription: String?
    public private(set) var query = NativeLibraryMadeQuery()

    private let client: NativeLibraryMadeClient
    private var accountID: AccountID?
    private var generation = 0

    public init(client: NativeLibraryMadeClient, accountID: AccountID? = nil) {
        self.client = client
        self.accountID = accountID
    }

    public var hasMore: Bool { nextCursor != nil }

    public func start(for accountID: AccountID) {
        guard self.accountID != accountID else { return }
        self.accountID = accountID
        items = nil
        nextCursor = nil
    }

    public func stop() {
        accountID = nil
        generation += 1
        items = nil
        nextCursor = nil
        errorDescription = nil
    }

    /// Replaces the query and reloads from the first page.
    public func setQuery(_ query: NativeLibraryMadeQuery) async {
        guard query != self.query || items == nil else { return }
        self.query = query
        await reload()
    }

    public func reload() async {
        guard let accountID else { return }
        generation += 1
        let mine = generation
        isLoading = true
        errorDescription = nil
        defer { if mine == generation { isLoading = false } }
        do {
            let page = try await client.page(query, for: accountID)
            guard mine == generation else { return }
            items = page.items
            nextCursor = page.nextCursor
        } catch {
            guard mine == generation else { return }
            errorDescription = NativeFailureMessage.presentable(error)
        }
    }

    public func loadMore() async {
        guard let accountID, let cursor = nextCursor, !isLoadingMore, !isLoading else { return }
        let mine = generation
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await client.page(query, cursor: cursor, for: accountID)
            guard mine == generation else { return }
            let seen = Set((items ?? []).map(\.listID))
            items = (items ?? []) + page.items.filter { !seen.contains($0.listID) }
            nextCursor = page.nextCursor
        } catch {
            guard mine == generation else { return }
            errorDescription = NativeFailureMessage.presentable(error)
        }
    }
}
