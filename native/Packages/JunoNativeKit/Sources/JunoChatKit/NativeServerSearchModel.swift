import Foundation
import JunoCore
import Observation

/// The server half of search on a device that searches its own synced data
/// first (the iPhone's Search screen; the Mac's panel keeps its own model).
///
/// The device searches chats, messages, projects, files and artifacts
/// offline, over everything synced to it. What it cannot search — memory,
/// knowledge (indexed documents) and delegated tasks — is asked of
/// `GET /api/search` here, with the same type narrowing the web's filter
/// applies, and shown under the local results.
///
/// **One answer per query.** Every keystroke bumps a generation; a late answer
/// to an earlier query is dropped twice over — by generation, and by the
/// server's echoed query (``NativeUnifiedSearchResult/answers(_:)``).
@MainActor
@Observable
public final class NativeServerSearchModel {
    public enum State: Equatable, Sendable {
        /// Nothing typed.
        case idle
        /// The type filter names something this route is not asked for.
        case skipped
        case searching
        case ready(NativeUnifiedSearchResult)
        case failed
    }

    /// What the server is asked for when no filter is set.
    public static let serverTypes: [NativeUnifiedSearchType] = [.knowledge, .memory, .work]
    /// What the device answers itself.
    public static let localTypes: [NativeUnifiedSearchType] = [.conversation, .message, .project, .file, .artifact]
    /// The filter menu's choices, in the web's group order.
    public static let filterChoices: [NativeUnifiedSearchType] = NativeUnifiedSearchType.allCases

    public typealias Search = @Sendable (String, [NativeUnifiedSearchType]) async throws -> NativeUnifiedSearchResult

    public private(set) var state: State = .idle
    public private(set) var query = ""
    public private(set) var typeFilter: NativeUnifiedSearchType?

    private let search: Search
    private let debounce: Duration
    private var generation = 0
    private var task: Task<Void, Never>?

    public init(debounce: Duration = .milliseconds(250), search: @escaping Search) {
        self.debounce = debounce
        self.search = search
    }

    public convenience init(
        client: NativeUnifiedSearchClient,
        accountID: AccountID,
        debounce: Duration = .milliseconds(250)
    ) {
        self.init(debounce: debounce) { query, types in
            try await client.search(query: query, types: types, for: accountID)
        }
    }

    // MARK: - Rules

    /// The types the server is asked for under a filter: all three without
    /// one, the one when it is a server type, none when it is a local type.
    public static func serverTypes(for filter: NativeUnifiedSearchType?) -> [NativeUnifiedSearchType] {
        guard let filter else { return serverTypes }
        return serverTypes.contains(filter) ? [filter] : []
    }

    /// Whether the device's own index should be searched under a filter.
    public static func searchesLocally(_ filter: NativeUnifiedSearchType?) -> Bool {
        guard let filter else { return true }
        return localTypes.contains(filter)
    }

    /// The local result kind a filter keeps, or nil for every kind.
    public static func localKind(for filter: NativeUnifiedSearchType?) -> NativeSearchResultKind? {
        switch filter {
        case .conversation: .conversation
        case .message: .message
        case .project: .project
        case .file: .file
        case .artifact: .artifact
        case .knowledge, .memory, .work, nil: nil
        }
    }

    // MARK: - Input

    public func setQuery(_ value: String) {
        guard value != query else { return }
        query = value
        schedule(immediately: false)
    }

    public func setTypeFilter(_ filter: NativeUnifiedSearchType?) {
        guard filter != typeFilter else { return }
        typeFilter = filter
        schedule(immediately: true)
    }

    /// Asks again for the current input, at once (Retry).
    public func retry() {
        schedule(immediately: true)
    }

    public func reset() {
        task?.cancel()
        task = nil
        generation += 1
        query = ""
        typeFilter = nil
        state = .idle
    }

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func schedule(immediately: Bool) {
        task?.cancel()
        generation += 1
        let types = Self.serverTypes(for: typeFilter)
        guard !trimmedQuery.isEmpty else {
            state = .idle
            task = nil
            return
        }
        guard !types.isEmpty else {
            state = .skipped
            task = nil
            return
        }
        state = .searching
        let token = generation
        let delay = immediately ? Duration.zero : debounce
        task = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled, let self else { return }
            await self.run(generation: token)
        }
    }

    /// One search for the current input. Internal so tests can drive it
    /// without the debounce.
    func run(generation token: Int) async {
        let asked = trimmedQuery
        let types = Self.serverTypes(for: typeFilter)
        guard !asked.isEmpty, !types.isEmpty else { return }
        do {
            let result = try await search(asked, types)
            guard generation == token, result.answers(trimmedQuery) else { return }
            state = .ready(result)
        } catch {
            guard generation == token else { return }
            state = .failed
        }
    }

    /// For tests: the generation the current search carries.
    var currentGeneration: Int { generation }

    // MARK: - Output

    /// The groups with something in them, in the server's order.
    public var groups: [NativeSearchGroup] {
        guard case .ready(let result) = state else { return [] }
        return result.groups.filter { !$0.hits.isEmpty }
    }

    public var hitCount: Int { groups.reduce(0) { $0 + $1.hits.count } }

    public var isSearching: Bool { state == .searching }

    /// One line about what could not be searched in full, or nil.
    public var notice: String? {
        switch state {
        case .failed:
            let names = Self.serverTypes(for: typeFilter).map(\.label)
            return names.isEmpty ? nil : "\(Self.joined(names)) couldn’t be searched right now."
        case .ready(let result):
            guard let first = result.shortfalls.first else { return nil }
            return "\(first.type.label): \(first.detail ?? "")"
        default:
            return nil
        }
    }

    /// "Knowledge, memory and tasks".
    static func joined(_ labels: [String]) -> String {
        guard let first = labels.first else { return "" }
        let rest = labels.dropFirst().map { $0.prefix(1).lowercased() + $0.dropFirst() }
        switch rest.count {
        case 0: return first
        case 1: return "\(first) and \(rest[0])"
        default: return ([first] + rest.dropLast()).joined(separator: ", ") + " and \(rest.last!)"
        }
    }
}

/// Where a server hit opens on a device: the web's `href` read back into a
/// screen the app has. Nil leaves the row out of the list rather than drawing
/// one that goes nowhere.
public enum NativeSearchHitDestination: Equatable, Sendable {
    case conversation(id: String, messageID: String?)
    case workSession(id: String)
    case project(id: String)
    case artifact(id: String)
    case memory
    case library

    public init?(hit: NativeSearchHit) {
        switch hit.type {
        case .memory:
            self = .memory
        case .file, .knowledge:
            self = .library
        case .work:
            if let destination = Self(href: hit.href), case .conversation = destination {
                self = destination
            } else if hit.id.hasPrefix("work:"), hit.id.count > 5 {
                self = .workSession(id: String(hit.id.dropFirst(5)))
            } else {
                return nil
            }
        case .conversation, .message, .project, .artifact:
            guard let destination = Self(href: hit.href) else { return nil }
            self = destination
        }
    }

    /// An `href` on the web app: `/chat/{id}[?m=]`, `/projects/{id}`,
    /// `/a/{id}`, `/memory`, `/library`.
    public init?(href: String) {
        guard let components = URLComponents(string: href) else { return nil }
        let segments = components.path.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) }
        switch (segments.first, segments.count) {
        case ("chat", 2...):
            guard !segments[1].isEmpty else { return nil }
            let message = components.queryItems?.first { $0.name == "m" }?.value
            self = .conversation(id: segments[1], messageID: message?.isEmpty == false ? message : nil)
        case ("projects", 2...):
            self = .project(id: segments[1])
        case ("a", 2...):
            self = .artifact(id: segments[1])
        case ("memory", _):
            self = .memory
        case ("library", _):
            self = .library
        default:
            return nil
        }
    }
}
