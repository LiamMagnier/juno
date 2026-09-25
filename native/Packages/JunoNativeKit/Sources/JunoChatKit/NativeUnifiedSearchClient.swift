import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

// MARK: - The web's search vocabulary (`src/lib/search/types.ts`)

/// What a person can look for, in the order the web renders its groups:
/// conversations and their messages first, memories and tasks last.
public enum NativeUnifiedSearchType: String, CaseIterable, Equatable, Hashable, Sendable {
    case conversation
    case message
    case project
    case file
    case knowledge
    case artifact
    case memory
    /// Delegated tasks and the steps inside them. The wire says `work`; the
    /// reader is told "Tasks".
    case work

    /// `SEARCH_TYPE_LABELS`, verbatim.
    public var label: String {
        switch self {
        case .conversation: "Chats"
        case .message: "Messages"
        case .project: "Projects"
        case .file: "Files"
        case .knowledge: "Knowledge"
        case .artifact: "Artifacts"
        case .memory: "Memory"
        case .work: "Tasks"
        }
    }
}

/// The date windows the web offers (`SEARCH_WINDOWS`): a bounded set, because
/// a free-form range is a form, not a palette.
public enum NativeSearchWindow: String, CaseIterable, Equatable, Hashable, Sendable {
    case any
    case week
    case month
    case year

    /// `SEARCH_WINDOW_LABELS`, verbatim (sentence case: the trigger's words).
    public var label: String {
        switch self {
        case .any: "Any time"
        case .week: "Past week"
        case .month: "Past month"
        case .year: "Past year"
        }
    }

    /// The earliest moment a hit in this window may have, or nil for any time
    /// — the web's `windowSince`.
    public func since(now: Date = Date()) -> Date? {
        let days: Double = switch self {
        case .any: 0
        case .week: 7
        case .month: 30
        case .year: 365
        }
        return days == 0 ? nil : now.addingTimeInterval(-days * 86_400)
    }
}

/// A matched span, as the server sends it: offsets into the text rather than
/// markup, so user content can never be mis-rendered into an injection.
///
/// **The offsets are JavaScript string indices** — UTF-16 code units — so
/// ``ranges(in:)`` walks the text's UTF-16 view rather than its characters. A
/// title with an emoji or an accented letter in front of the match would land
/// the emphasis a few characters early otherwise.
public struct NativeSearchMark: Equatable, Hashable, Sendable {
    public let start: Int
    public let end: Int

    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }

    /// These marks as ranges of `text`, ascending, dropping any that fall
    /// outside it or split a character — a mark the text cannot hold is
    /// skipped rather than trusted.
    public static func ranges(_ marks: [NativeSearchMark], in text: String) -> [Range<String.Index>] {
        let utf16 = text.utf16
        let count = utf16.count
        var out: [Range<String.Index>] = []
        for mark in marks.sorted(by: { $0.start < $1.start }) {
            guard mark.start >= 0, mark.end > mark.start, mark.end <= count else { continue }
            let lower = utf16.index(utf16.startIndex, offsetBy: mark.start)
            let upper = utf16.index(utf16.startIndex, offsetBy: mark.end)
            guard let start = lower.samePosition(in: text), let end = upper.samePosition(in: text) else { continue }
            if let last = out.last, start < last.upperBound { continue }
            out.append(start..<end)
        }
        return out
    }
}

/// One line of context around a match, already elided where it was cut.
public struct NativeSearchSnippet: Equatable, Sendable {
    public let text: String
    public let marks: [NativeSearchMark]

    public init(text: String, marks: [NativeSearchMark]) {
        self.text = text
        self.marks = marks
    }
}

/// One result. `href` resolves to the exact place the match lives — the
/// message inside the conversation, the version of the artifact.
public struct NativeSearchHit: Identifiable, Equatable, Sendable {
    public let id: String
    public let type: NativeUnifiedSearchType
    public let title: String
    public let titleMarks: [NativeSearchMark]
    public let snippet: NativeSearchSnippet?
    public let href: String
    /// "Page 4", "v3", "Step 12": trailing meta, never the title.
    public let locator: String?
    public let projectID: String?
    public let updatedAt: Date?
    public let score: Double

    public init(
        id: String,
        type: NativeUnifiedSearchType,
        title: String,
        titleMarks: [NativeSearchMark] = [],
        snippet: NativeSearchSnippet? = nil,
        href: String,
        locator: String? = nil,
        projectID: String? = nil,
        updatedAt: Date? = nil,
        score: Double = 0
    ) {
        self.id = id
        self.type = type
        self.title = title
        self.titleMarks = titleMarks
        self.snippet = snippet
        self.href = href
        self.locator = locator
        self.projectID = projectID
        self.updatedAt = updatedAt
        self.score = score
    }
}

/// What one source actually managed to search. `detail` is user-facing copy
/// and is present for anything short of complete.
public struct NativeSearchCoverage: Equatable, Sendable {
    public enum State: String, Equatable, Sendable {
        case complete
        case partial
        case unavailable
    }

    public let type: NativeUnifiedSearchType
    public let state: State
    public let detail: String?

    public init(type: NativeUnifiedSearchType, state: State, detail: String?) {
        self.type = type
        self.state = state
        self.detail = detail
    }
}

public struct NativeSearchGroup: Equatable, Sendable {
    public let type: NativeUnifiedSearchType
    public let label: String
    public let hits: [NativeSearchHit]

    public init(type: NativeUnifiedSearchType, label: String, hits: [NativeSearchHit]) {
        self.type = type
        self.label = label
        self.hits = hits
    }
}

/// `UnifiedSearchResult`, decoded exactly.
public struct NativeUnifiedSearchResult: Equatable, Sendable {
    /// Echoed back so a late answer can be dropped against the live input.
    public let query: String
    public let groups: [NativeSearchGroup]
    public let total: Int
    public let coverage: [NativeSearchCoverage]
    /// True when any source returned less than everything it holds.
    public let partial: Bool

    public init(
        query: String,
        groups: [NativeSearchGroup],
        total: Int,
        coverage: [NativeSearchCoverage],
        partial: Bool
    ) {
        self.query = query
        self.groups = groups
        self.total = total
        self.coverage = coverage
        self.partial = partial
    }

    /// Whether this answer is for `query` as the reader has it now — the
    /// web's reason for echoing the query. Compared trimmed, as the palette
    /// sends it.
    public func answers(_ query: String) -> Bool {
        self.query.trimmingCharacters(in: .whitespacesAndNewlines)
            == query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The sources that came back short and can say why — the only ones the
    /// palette mentions.
    public var shortfalls: [NativeSearchCoverage] {
        coverage.filter { $0.state != .complete && ($0.detail?.isEmpty == false) }
    }
}

/// One row of `GET /api/recents`: the merged Chat / Work / Code / Projects
/// timeline.
public struct NativeRecentItem: Identifiable, Equatable, Sendable {
    public let id: String
    /// `chat`, `work`, `code` or `project`; anything else is kept as sent.
    public let kind: String
    public let title: String
    public let updatedAt: Date?
    public let href: String
    public let pinned: Bool
    public let projectID: String?

    public init(
        id: String,
        kind: String,
        title: String,
        updatedAt: Date?,
        href: String,
        pinned: Bool = false,
        projectID: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.updatedAt = updatedAt
        self.href = href
        self.pinned = pinned
        self.projectID = projectID
    }
}

public enum NativeUnifiedSearchError: Error, Equatable, Sendable {
    /// The route answered, but not with a result: a 4xx/5xx or a body that
    /// does not decode.
    case failed(status: Int)
}

// MARK: - Client

/// Unified search and recents, as the web's palette reads them
/// (`GET /api/search`, `GET /api/recents`).
///
/// iOS-safe and deliberately not wired on the phone: the Mac's ⌘K panel is the
/// first caller. The Mac searches its own encrypted store for chats, messages,
/// projects, files and artifacts (it works offline, over the full text of
/// synced messages) and asks this client for memory, knowledge and tasks only.
public struct NativeUnifiedSearchClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// `GET /api/search?q=&types=&projectId=&window=`. Only `q` changes what is
    /// searched; the rest narrow it. Unknown types in the answer are dropped.
    public func search(
        query: String,
        types: [NativeUnifiedSearchType] = [],
        projectID: String? = nil,
        window: NativeSearchWindow = .any,
        for accountID: AccountID
    ) async throws -> NativeUnifiedSearchResult {
        let response = try await sender.send(
            try Self.searchRequest(query: query, types: types, projectID: projectID, window: window),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw NativeUnifiedSearchError.failed(status: response.statusCode)
        }
        return try Self.decodeSearch(response.body)
    }

    /// `GET /api/recents?limit=`.
    public func recents(limit: Int = 8, for accountID: AccountID) async throws -> [NativeRecentItem] {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/recents",
                queryItems: [URLQueryItem(name: "limit", value: String(max(1, min(limit, 200))))],
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw NativeUnifiedSearchError.failed(status: response.statusCode)
        }
        return try Self.decodeRecents(response.body)
    }

    // MARK: Request and decoding (internal for tests)

    static func searchRequest(
        query: String,
        types: [NativeUnifiedSearchType],
        projectID: String?,
        window: NativeSearchWindow
    ) throws -> NativeBearerRequest {
        var items = [URLQueryItem(name: "q", value: query.trimmingCharacters(in: .whitespacesAndNewlines))]
        if !types.isEmpty {
            items.append(URLQueryItem(name: "types", value: types.map(\.rawValue).joined(separator: ",")))
        }
        if let projectID, !projectID.isEmpty {
            items.append(URLQueryItem(name: "projectId", value: projectID))
        }
        if window != .any {
            items.append(URLQueryItem(name: "window", value: window.rawValue))
        }
        return try NativeBearerRequest(
            path: "/api/search",
            queryItems: items,
            headers: try HTTPHeaders(["accept": "application/json"])
        )
    }

    static func decodeSearch(_ data: Data) throws -> NativeUnifiedSearchResult {
        guard let wire = try? JSONDecoder().decode(ResultWire.self, from: data) else {
            throw NativeUnifiedSearchError.failed(status: 200)
        }
        let groups: [NativeSearchGroup] = wire.groups.compactMap { group in
            guard let type = NativeUnifiedSearchType(rawValue: group.type) else { return nil }
            let hits = group.hits.compactMap { $0.model }
            return NativeSearchGroup(type: type, label: group.label ?? type.label, hits: hits)
        }
        let coverage: [NativeSearchCoverage] = (wire.coverage ?? []).compactMap { entry in
            guard let type = NativeUnifiedSearchType(rawValue: entry.type),
                let state = NativeSearchCoverage.State(rawValue: entry.state)
            else { return nil }
            return NativeSearchCoverage(type: type, state: state, detail: entry.detail)
        }
        return NativeUnifiedSearchResult(
            query: wire.query ?? "",
            groups: groups,
            total: wire.total ?? groups.reduce(0) { $0 + $1.hits.count },
            coverage: coverage,
            partial: wire.partial ?? false
        )
    }

    static func decodeRecents(_ data: Data) throws -> [NativeRecentItem] {
        guard let wire = try? JSONDecoder().decode(RecentsWire.self, from: data) else {
            throw NativeUnifiedSearchError.failed(status: 200)
        }
        return wire.items.compactMap { row in
            guard let id = row.id, !id.isEmpty else { return nil }
            return NativeRecentItem(
                id: id,
                kind: row.kind ?? "chat",
                title: row.title ?? "",
                updatedAt: row.updatedAt.flatMap(Self.date),
                href: row.href ?? "/",
                pinned: row.pinned ?? false,
                projectID: row.projectId
            )
        }
    }

    static func date(_ raw: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: raw) { return date }
        return ISO8601DateFormatter().date(from: raw)
    }
}

// MARK: - Wire

private struct MarkWire: Decodable {
    let start: Int
    let end: Int
}

private struct SnippetWire: Decodable {
    let text: String
    let marks: [MarkWire]?
}

private struct HitWire: Decodable {
    let id: String
    let type: String
    let title: String?
    let titleMarks: [MarkWire]?
    let snippet: SnippetWire?
    let href: String?
    let locator: String?
    let projectId: String?
    let updatedAt: String?
    let score: Double?

    var model: NativeSearchHit? {
        guard let type = NativeUnifiedSearchType(rawValue: type) else { return nil }
        return NativeSearchHit(
            id: id,
            type: type,
            title: title ?? "",
            titleMarks: (titleMarks ?? []).map { NativeSearchMark(start: $0.start, end: $0.end) },
            snippet: snippet.map {
                NativeSearchSnippet(
                    text: $0.text,
                    marks: ($0.marks ?? []).map { NativeSearchMark(start: $0.start, end: $0.end) }
                )
            },
            href: href ?? "/",
            locator: locator,
            projectID: projectId,
            updatedAt: updatedAt.flatMap(NativeUnifiedSearchClient.date),
            score: score ?? 0
        )
    }
}

private struct GroupWire: Decodable {
    let type: String
    let label: String?
    let hits: [HitWire]

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        // One hit this build cannot read does not cost the reader the group.
        hits = (try? container.decode([LossyHit].self, forKey: .hits))?.compactMap(\.hit) ?? []
    }

    private enum CodingKeys: String, CodingKey { case type, label, hits }
}

private struct LossyHit: Decodable {
    let hit: HitWire?

    init(from decoder: any Decoder) throws {
        hit = try? HitWire(from: decoder)
    }
}

private struct CoverageWire: Decodable {
    let type: String
    let state: String
    let detail: String?
}

private struct ResultWire: Decodable {
    let query: String?
    let groups: [GroupWire]
    let total: Int?
    let coverage: [CoverageWire]?
    let partial: Bool?
}

private struct RecentWire: Decodable {
    let id: String?
    let kind: String?
    let title: String?
    let updatedAt: String?
    let href: String?
    let pinned: Bool?
    let projectId: String?
}

private struct RecentsWire: Decodable {
    let items: [RecentWire]
}
