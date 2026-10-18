import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

// Activity (audit gap G70): everything live across Work tasks, Code tasks and
// Research runs, grouped Needs you / Running / Ready / Blocked.
//
// One route, `GET /api/activity` (src/app/api/activity/route.ts), feeds the
// web page, the Mac sidebar destination and the iPhone drawer entry. The
// vocabulary here mirrors `src/lib/activity/model.ts`; tests/activity-routes
// .test.ts and NativeActivityTests.swift hold the two to the same JSON.

/// The four states, in reading order: what is waiting on the reader first,
/// what failed last, so Blocked never sits next to Needs you (spec §7.2).
public enum NativeActivityState: String, CaseIterable, Sendable, Identifiable {
    case needsYou = "needs_you"
    case running
    case ready
    case blocked

    public var id: Self { self }

    /// The shared status words (spec §3.4).
    public var label: String {
        switch self {
        case .needsYou: "Needs you"
        case .running: "Running"
        case .ready: "Ready"
        case .blocked: "Blocked"
        }
    }

    public var hint: String {
        switch self {
        case .needsYou: "Stopped until you answer."
        case .running: "Under way, or waiting for a machine."
        case .ready: "Finished in the last day."
        case .blocked: "Ended on an error in the last day."
        }
    }
}

public enum NativeActivityKind: String, Sendable {
    case work
    case code
    case research

    public var label: String {
        switch self {
        case .work: "Task"
        case .code: "Code"
        case .research: "Research"
        }
    }
}

public enum NativeActivityNeed: String, Sendable {
    case approval, question, plan, host, decision, review

    public var label: String {
        switch self {
        case .approval: "Needs your approval"
        case .question: "Has a question for you"
        case .plan: "Plan to confirm"
        case .host: "Waiting for your Mac"
        case .decision: "Waiting on you"
        case .review: "Ready to review"
        }
    }
}

public struct NativeActivityItem: Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: NativeActivityKind
    public let sourceID: String
    public let title: String
    public let state: NativeActivityState
    public let need: NativeActivityNeed?
    public let status: String
    public let needSummary: String?
    public let startedAt: Date
    public let updatedAt: Date
    /// The in-app web path, for "Open in browser" and for mapping to a native screen.
    public let href: String
    public let conversationID: String?
    public let runID: String?
    public let canStop: Bool

    public init(
        id: String,
        kind: NativeActivityKind,
        sourceID: String,
        title: String,
        state: NativeActivityState,
        need: NativeActivityNeed? = nil,
        status: String,
        needSummary: String? = nil,
        startedAt: Date,
        updatedAt: Date,
        href: String,
        conversationID: String? = nil,
        runID: String? = nil,
        canStop: Bool = false
    ) {
        self.id = id
        self.kind = kind
        self.sourceID = sourceID
        self.title = title
        self.state = state
        self.need = need
        self.status = status
        self.needSummary = needSummary
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.href = href
        self.conversationID = conversationID
        self.runID = runID
        self.canStop = canStop
    }

    /// The row's verb: what opening it is for.
    public var verb: String {
        guard state == .needsYou, let need else { return "Open" }
        switch need {
        case .approval: return "Review"
        case .question: return "Answer"
        case .plan: return "Review plan"
        case .host, .decision, .review: return "Open"
        }
    }
}

public struct NativeActivityCounts: Equatable, Sendable {
    public var needsYou: Int
    public var running: Int
    public var ready: Int
    public var blocked: Int

    public init(needsYou: Int = 0, running: Int = 0, ready: Int = 0, blocked: Int = 0) {
        self.needsYou = needsYou
        self.running = running
        self.ready = ready
        self.blocked = blocked
    }

    public subscript(state: NativeActivityState) -> Int {
        switch state {
        case .needsYou: needsYou
        case .running: running
        case .ready: ready
        case .blocked: blocked
        }
    }

    public var total: Int { needsYou + running + ready + blocked }
}

public struct NativeActivityPage: Equatable, Sendable {
    public let items: [NativeActivityItem]
    public let counts: NativeActivityCounts
    public let nextCursor: String?

    public init(items: [NativeActivityItem], counts: NativeActivityCounts, nextCursor: String?) {
        self.items = items
        self.counts = counts
        self.nextCursor = nextCursor
    }

    /// Decodes the route's JSON. An item in a state or kind this build cannot
    /// name is dropped rather than guessed at, as the web drops it.
    public static func decode(_ data: Data) throws -> NativeActivityPage {
        let wire = try JSONDecoder().decode(PageWire.self, from: data)
        let items = wire.items.compactMap { $0.item }
        let counts = NativeActivityCounts(
            needsYou: wire.counts?.needs_you ?? 0,
            running: wire.counts?.running ?? 0,
            ready: wire.counts?.ready ?? 0,
            blocked: wire.counts?.blocked ?? 0
        )
        return NativeActivityPage(items: items, counts: counts, nextCursor: wire.nextCursor)
    }

    private struct PageWire: Decodable {
        let items: [ItemWire]
        let counts: CountsWire?
        let nextCursor: String?
    }

    private struct CountsWire: Decodable {
        let needs_you: Int?
        let running: Int?
        let ready: Int?
        let blocked: Int?
    }

    private struct ItemWire: Decodable {
        let id: String
        let kind: String
        let sourceId: String
        let title: String
        let state: String
        let need: String?
        let status: String
        let needSummary: String?
        let startedAt: String
        let updatedAt: String
        let href: String
        let conversationId: String?
        let runId: String?
        let canStop: Bool?

        var item: NativeActivityItem? {
            guard
                let kind = NativeActivityKind(rawValue: kind),
                let state = NativeActivityState(rawValue: state),
                let started = NativeActivityDates.parse(startedAt),
                let updated = NativeActivityDates.parse(updatedAt)
            else { return nil }
            return NativeActivityItem(
                id: id,
                kind: kind,
                sourceID: sourceId,
                title: title,
                state: state,
                need: need.flatMap(NativeActivityNeed.init(rawValue:)),
                status: status,
                needSummary: needSummary,
                startedAt: started,
                updatedAt: updated,
                href: href,
                conversationID: conversationId,
                runID: runId,
                canStop: canStop ?? false
            )
        }
    }
}

/// The server writes `Date.toISOString()`: always UTC, always milliseconds.
public enum NativeActivityDates {
    public static func parse(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }
}

public struct NativeActivityGroup: Equatable, Sendable, Identifiable {
    public let state: NativeActivityState
    public let items: [NativeActivityItem]
    public var id: NativeActivityState { state }
}

public enum NativeActivityGrouping {
    /// The four states in reading order, each with its items in page order,
    /// empty groups left out; `only` narrows to one state (a filter).
    public static func groups(_ items: [NativeActivityItem], only: NativeActivityState? = nil) -> [NativeActivityGroup] {
        NativeActivityState.allCases.compactMap { state in
            if let only, only != state { return nil }
            let inState = items.filter { $0.state == state }
            return inState.isEmpty ? nil : NativeActivityGroup(state: state, items: inState)
        }
    }

    /// The web's cadence (src/components/activity/use-activity.ts): every 5s
    /// while something runs, every 30s while only decisions wait, and not at
    /// all when nothing is live (a refresh on appear or activation instead).
    public static func pollInterval(_ counts: NativeActivityCounts?) -> Duration? {
        guard let counts else { return nil }
        if counts.running > 0 { return .seconds(5) }
        if counts.needsYou > 0 { return .seconds(30) }
        return nil
    }

    /// "Running for 4 min" / "Waiting for 12 min" / "3 h ago", whole minutes.
    public static func timeLabel(for item: NativeActivityItem, now: Date) -> String {
        let reference = item.state == .running ? item.startedAt : item.updatedAt
        let seconds = max(60, now.timeIntervalSince(reference))
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 1
        formatter.allowedUnits = seconds >= 7200 ? [.day, .hour] : [.minute]
        let span = formatter.string(from: seconds) ?? ""
        switch item.state {
        case .running: return String(localized: "Running for \(span)")
        case .needsYou: return String(localized: "Waiting for \(span)")
        case .ready, .blocked: return String(localized: "\(span) ago")
        }
    }
}

/// `GET /api/activity`, and Stop through each product's own route.
public struct NativeActivityClient: Sendable {
    public static let path = "/api/activity"
    public static let pageLimit = 50

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func page(cursor: String? = nil, limit: Int = NativeActivityClient.pageLimit, for accountID: AccountID) async throws -> NativeActivityPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: Self.path,
                method: .get,
                queryItems: query,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        if let error = NativeWebRouteError.from(response, fallback: "Couldn’t load your activity.") { throw error }
        do {
            return try NativeActivityPage.decode(response.body)
        } catch {
            throw NativeWebRouteError(statusCode: response.statusCode, message: "Couldn’t load your activity.")
        }
    }

    /// The request that stops one item, or nil when nothing can address it.
    public static func stopRequest(for item: NativeActivityItem) throws -> NativeBearerRequest? {
        guard item.canStop else { return nil }
        let json = try HTTPHeaders(["content-type": "application/json", "accept": "application/json"])
        switch item.kind {
        case .work:
            guard let runID = item.runID else { return nil }
            return try NativeBearerRequest(
                path: "/api/work/runs/\(runID)/control",
                method: .post,
                headers: json,
                body: Data(#"{"action":"cancel"}"#.utf8)
            )
        case .code:
            return try NativeBearerRequest(path: "/api/code/tasks/\(item.sourceID)/cancel", method: .post, headers: json)
        case .research:
            return try NativeBearerRequest(
                path: "/api/research/\(item.sourceID)/control",
                method: .post,
                headers: json,
                body: Data(#"{"action":"cancel"}"#.utf8)
            )
        }
    }

    public func stop(_ item: NativeActivityItem, for accountID: AccountID) async throws {
        guard let request = try Self.stopRequest(for: item) else { return }
        let response = try await sender.send(request, for: accountID)
        if let error = NativeWebRouteError.from(response, fallback: "Couldn’t stop it. Try again from its own page.") { throw error }
    }
}

/// The screen's state: the first page polled on the web's cadence, older pages
/// appended on request, a filter, and Stop.
@MainActor
@Observable
public final class NativeActivityModel {
    public enum State: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    public private(set) var state: State = .loading
    public private(set) var items: [NativeActivityItem] = []
    public private(set) var counts: NativeActivityCounts?
    public private(set) var nextCursor: String?
    public private(set) var loadingMore = false
    public private(set) var stopping: Set<String> = []
    public private(set) var lastError: String?
    public var filter: NativeActivityState?

    private let client: NativeActivityClient?
    private let accountID: AccountID
    private var firstPage: [NativeActivityItem] = []
    private var older: [NativeActivityItem] = []

    public init(client: NativeActivityClient?, accountID: AccountID) {
        self.client = client
        self.accountID = accountID
    }

    /// A model that already holds a page (previews and snapshots).
    public init(page: NativeActivityPage, accountID: AccountID) {
        self.client = nil
        self.accountID = accountID
        apply(page)
        state = .loaded
    }

    public var groups: [NativeActivityGroup] { NativeActivityGrouping.groups(items, only: filter) }
    public var pollInterval: Duration? { NativeActivityGrouping.pollInterval(counts) }
    public var isEmpty: Bool { state == .loaded && items.isEmpty && nextCursor == nil }

    public func load() async {
        guard let client else {
            if counts == nil { state = .failed("Couldn’t load your activity.") }
            return
        }
        do {
            apply(try await client.page(for: accountID))
            state = .loaded
        } catch {
            // A refresh that fails keeps what is on screen.
            if counts == nil {
                state = .failed((error as? NativeWebRouteError)?.message ?? "Couldn’t load your activity.")
            }
        }
    }

    public func retry() async {
        state = .loading
        await load()
    }

    public func loadMore() async {
        guard let client, let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        guard let page = try? await client.page(cursor: cursor, limit: 100, for: accountID) else { return }
        older.append(contentsOf: page.items)
        nextCursor = page.nextCursor
        merge()
    }

    public func stop(_ item: NativeActivityItem) async {
        guard let client, !stopping.contains(item.id) else { return }
        stopping.insert(item.id)
        defer { stopping.remove(item.id) }
        do {
            try await client.stop(item, for: accountID)
            lastError = nil
        } catch {
            lastError = (error as? NativeWebRouteError)?.message ?? "Couldn’t stop it. Try again from its own page."
        }
        await load()
    }

    private func apply(_ page: NativeActivityPage) {
        counts = page.counts
        firstPage = page.items
        // Once older pages are held, their cursor is the one that continues.
        if older.isEmpty { nextCursor = page.nextCursor }
        merge()
    }

    /// The fresh first page, then the older pages minus anything that moved up.
    private func merge() {
        let seen = Set(firstPage.map(\.id))
        items = firstPage + older.filter { !seen.contains($0.id) }
    }
}
