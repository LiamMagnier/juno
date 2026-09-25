import Foundation
import JunoChatKit
import JunoCodeCore
import JunoDesignSystem
import JunoWorkKit
import Observation

/// The ⌘K / Search panel's state: one per Chat window (Phase 3 brief, B1).
///
/// **One panel, two modes.** Commands (⌘K) runs things; Search (⇧⌘F and the
/// sidebar's Search button) finds things. "Search everything" in Commands
/// switches mode and keeps what was typed. They share the shell and nothing
/// else — a list that mixes "open the thing I wrote" with "run this action"
/// makes Return ambiguous at the moment it must not be.
///
/// **Where Search looks** (decision 7, register P3-12): chats, messages,
/// projects, files and artifacts in this Mac's encrypted store — offline, and
/// over the full text of synced messages — and memory, knowledge and tasks on
/// the server (`GET /api/search`). Both are debounced at 180ms and the older
/// request is cancelled; the local results draw first and the server's groups
/// slot in when they land, without moving the row the cursor is on.
@MainActor
@Observable
final class DesktopSearchPanelModel {
    enum Mode: Equatable {
        case commands
        case search
    }

    /// Where the server half of a search stands.
    enum ServerState: Equatable {
        case idle
        case searching
        case ready(NativeUnifiedSearchResult)
        /// It could not be asked or did not answer. `offline` picks the words
        /// the notices say.
        case failed(offline: Bool)
        /// The filters leave nothing for the server to search.
        case skipped
    }

    /// Where the local half stands. `previous` keeps the last results on
    /// screen while the next keystroke is being searched, so refining a query
    /// never blanks the list.
    enum LocalState: Equatable {
        case idle
        case searching(previous: [NativeSearchResult])
        case ready([NativeSearchResult])
        case failed
    }

    /// What the panel searches and lists with. Set by the window before each
    /// presentation, so a test can hand in its own.
    struct Services {
        var localSearch: (@MainActor (String) async throws -> [NativeSearchResult])?
        var serverSearch: (@MainActor (
            String, [NativeUnifiedSearchType], String?, NativeSearchWindow
        ) async throws -> NativeUnifiedSearchResult)?
        var recents: (@MainActor () async throws -> [NativeRecentItem])?
        /// Chats, Code sessions and projects by recency, from what this Mac
        /// holds — the Recent list while offline.
        var localRecents: @MainActor () -> [NativeRecentItem] = { [] }
        var isOffline: @MainActor () -> Bool = { false }
        /// The project a conversation belongs to, for the project filter over
        /// local results.
        var projectOfConversation: @MainActor (String) -> String? = { _ in nil }
        /// The account's tasks this Mac has read (`NativeWorkModel`), for the
        /// Tasks group beside the server's hits: Phase 5 D's Search › Tasks
        /// scope, folded into the panel at integration.
        var localTasks: @MainActor () -> [WorkSessionSummary] = { [] }

        static let none = Services()
    }

    // MARK: Presentation

    private(set) var isPresented = false
    private(set) var mode: Mode = .commands
    /// Bumped on every presentation, so the field takes focus again even when
    /// the panel was already up.
    private(set) var presentationID = 0
    var services = Services.none
    /// The debounce, shortened by tests.
    var debounce: Duration = .milliseconds(180)

    // MARK: Input

    private(set) var query = ""
    private(set) var typeFilter: NativeUnifiedSearchType?
    private(set) var window: NativeSearchWindow = .any
    private(set) var projectFilter: String?

    // MARK: Results

    private(set) var local: LocalState = .idle
    private(set) var server: ServerState = .idle
    /// The Recent list, kept between presentations so a reopen shows the last
    /// one at once while a fresh one loads. Nil until the first arrives.
    private(set) var recents: [NativeRecentItem]?
    private(set) var recentsLoading = false

    /// The row the cursor is on, by identity, so rows arriving above or
    /// below it do not move it. Nil is the first row.
    private(set) var activeRowID: String?
    /// Whether the reader has moved the cursor since it was last put on row
    /// 0 — presentation only, as on the web.
    private(set) var readerMoved = false

    private var searchTask: Task<Void, Never>?
    private var recentsTask: Task<Void, Never>?
    private var generation = 0

    var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Filters show only in Search with something typed (decision 8).
    var showsFilters: Bool { mode == .search && !trimmedQuery.isEmpty }

    // MARK: - Opening and closing

    /// ⌘K (`.commands`), or ⇧⌘F and the sidebar button (`.search`).
    ///
    /// ⌘K while the panel is open closes it; ⇧⌘F while Commands is open
    /// switches to Search and keeps the query; either while Search is open
    /// puts the caret back in the field.
    func present(_ requested: Mode) {
        if isPresented {
            if requested == .commands {
                dismiss()
            } else {
                switchMode(to: .search)
                presentationID += 1
            }
            return
        }
        // A fresh surface each time: the last query's results behind a
        // cleared field would read as results for the empty one.
        mode = requested
        query = ""
        typeFilter = nil
        window = .any
        projectFilter = nil
        local = .idle
        server = .idle
        resetCursor()
        isPresented = true
        presentationID += 1
        if requested == .search { loadRecents() }
    }

    func dismiss() {
        guard isPresented else { return }
        isPresented = false
        searchTask?.cancel()
        searchTask = nil
        generation += 1
    }

    /// "Search everything": the same words, now searched.
    func switchMode(to target: Mode) {
        guard mode != target else { return }
        mode = target
        resetCursor()
        if target == .search {
            loadRecents()
            scheduleSearch()
        }
    }

    // MARK: - Input

    func setQuery(_ value: String) {
        guard value != query else { return }
        query = value
        resetCursor()
        if mode == .search { scheduleSearch() }
    }

    func setTypeFilter(_ type: NativeUnifiedSearchType?) {
        guard type != typeFilter else { return }
        typeFilter = type
        filtersChanged()
    }

    func setWindow(_ value: NativeSearchWindow) {
        guard value != window else { return }
        window = value
        filtersChanged()
    }

    func setProjectFilter(_ projectID: String?) {
        guard projectID != projectFilter else { return }
        projectFilter = projectID
        filtersChanged()
    }

    /// Changing a filter puts the cursor back on the first row — the web's
    /// `resetKey` — and searches again at once.
    private func filtersChanged() {
        resetCursor()
        scheduleSearch(immediately: true)
    }

    // MARK: - Cursor

    func resetCursor() {
        activeRowID = nil
        readerMoved = false
    }

    /// The index the cursor is on within `rows`.
    func activeIndex(in rows: [DesktopPanelRow]) -> Int {
        guard let activeRowID, let index = rows.firstIndex(where: { $0.id == activeRowID }) else { return 0 }
        return index
    }

    func moveCursor(by delta: Int, in rows: [DesktopPanelRow]) {
        guard !rows.isEmpty else { return }
        let next = min(max(activeIndex(in: rows) + delta, 0), rows.count - 1)
        activeRowID = rows[next].id
        readerMoved = true
    }

    /// The pointer moving onto a row makes it the active one.
    func hover(_ row: DesktopPanelRow) {
        guard activeRowID != row.id else { return }
        activeRowID = row.id
        readerMoved = true
    }

    // MARK: - Recents

    /// The Recent list: the server's `recents` online, this Mac's own store
    /// offline or when the server does not answer.
    func loadRecents() {
        recentsTask?.cancel()
        recentsTask = Task { [weak self] in await self?.refreshRecents() }
    }

    /// The load itself, awaitable for tests and snapshots.
    func refreshRecents() async {
        if services.isOffline() || services.recents == nil {
            recents = services.localRecents()
            recentsLoading = false
            return
        }
        guard let load = services.recents else { return }
        recentsLoading = true
        let loaded = try? await load()
        guard !Task.isCancelled else { return }
        recents = loaded ?? (recents ?? services.localRecents())
        recentsLoading = false
    }

    // MARK: - Searching

    /// What the server is asked for under the current filters: the three
    /// types this Mac cannot search itself, narrowed by the type chip.
    var serverTypes: [NativeUnifiedSearchType] {
        Self.serverTypes(for: typeFilter)
    }

    static let serverSearchedTypes: [NativeUnifiedSearchType] = [.knowledge, .memory, .work]
    static let localSearchedTypes: [NativeUnifiedSearchType] = [.conversation, .message, .project, .file, .artifact]

    static func serverTypes(for filter: NativeUnifiedSearchType?) -> [NativeUnifiedSearchType] {
        guard let filter else { return serverSearchedTypes }
        return serverSearchedTypes.contains(filter) ? [filter] : []
    }

    static func searchesLocally(_ filter: NativeUnifiedSearchType?) -> Bool {
        guard let filter else { return true }
        return localSearchedTypes.contains(filter)
    }

    /// Debounces, then searches. Filters search at once.
    func scheduleSearch(immediately: Bool = false) {
        searchTask?.cancel()
        generation += 1
        guard mode == .search, !trimmedQuery.isEmpty else {
            local = .idle
            server = .idle
            searchTask = nil
            return
        }
        local = .searching(previous: currentLocalResults)
        server = serverTypes.isEmpty ? .skipped : .searching
        let token = generation
        let delay = immediately ? .zero : debounce
        searchTask = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled, let self else { return }
            await self.runSearch(generation: token)
        }
    }

    /// Both halves of one search, for the current input. Internal so tests
    /// can drive it without the debounce.
    func runSearch(generation token: Int) async {
        let query = trimmedQuery
        async let localPart: Void = searchLocally(query: query, generation: token)
        async let serverPart: Void = searchServer(query: query, generation: token)
        _ = await (localPart, serverPart)
    }

    private func searchLocally(query: String, generation token: Int) async {
        guard Self.searchesLocally(typeFilter), let search = services.localSearch else {
            if generation == token { local = .ready([]) }
            return
        }
        do {
            let found = try await search(query)
            guard generation == token, trimmedQuery == query else { return }
            local = .ready(found)
        } catch {
            guard generation == token else { return }
            local = .failed
        }
    }

    private func searchServer(query: String, generation token: Int) async {
        let types = serverTypes
        guard !types.isEmpty else { return }
        let services = services
        guard !services.isOffline(), let ask = services.serverSearch else {
            if generation == token { server = .failed(offline: true) }
            return
        }
        do {
            let result = try await ask(query, types, projectFilter, window)
            // The echo guard: a late answer to an earlier query is dropped
            // against what the reader has in the field now.
            guard generation == token, result.answers(trimmedQuery) else { return }
            server = .ready(result)
        } catch {
            guard generation == token else { return }
            server = .failed(offline: services.isOffline())
        }
    }

    /// For tests: the generation the next search will carry.
    var currentGeneration: Int { generation }

    private var currentLocalResults: [NativeSearchResult] {
        switch local {
        case .ready(let results): results
        case .searching(let previous): previous
        case .idle, .failed: []
        }
    }

    // MARK: - Search rows

    /// Whether anything is still on its way for the current query.
    var isSearching: Bool {
        if case .searching = local { return true }
        return server == .searching
    }

    /// The server's answer, once it has one for this query.
    var serverResult: NativeUnifiedSearchResult? {
        if case .ready(let result) = server { return result }
        return nil
    }

    /// Search mode's rows for the current state.
    func searchRows(hooks: DesktopCommandCatalog.Hooks, now: Date = Date()) -> [DesktopPanelRow] {
        if trimmedQuery.isEmpty {
            return Self.recentRows(recents ?? [], now: now)
        }
        return Self.resultRows(
            query: trimmedQuery,
            local: currentLocalResults,
            server: serverResult,
            typeFilter: typeFilter,
            window: window,
            projectFilter: projectFilter,
            projectOfConversation: services.projectOfConversation,
            hooks: hooks,
            now: now,
            tasks: services.localTasks()
        )
    }

    /// The Recent list as rows.
    static func recentRows(_ items: [NativeRecentItem], now: Date) -> [DesktopPanelRow] {
        items.compactMap { item in
            guard let action = DesktopSearchRoute.recent(kind: item.kind, href: item.href) else { return nil }
            return DesktopPanelRow(
                id: "recent-\(item.kind)-\(item.id)",
                group: "Recent",
                label: item.title.isEmpty ? "Untitled" : item.title,
                meta: item.updatedAt.map { DesktopCommandCatalog.relativeTime($0, now: now) },
                icon: recentIcon(item.kind),
                action: action
            )
        }
    }

    /// The Recent list from what this Mac holds, for when the server cannot
    /// be asked: chats, Code sessions and projects by recency, eight rows.
    static func localRecents(
        conversations: [NativeConversation],
        projects: [NativeProject],
        codeSessions: [DesktopPanelCodeSession],
        limit: Int = 8
    ) -> [NativeRecentItem] {
        var items: [NativeRecentItem] = []
        for conversation in conversations where conversation.kind == "chat" && !conversation.isArchived {
            items.append(
                NativeRecentItem(
                    id: conversation.id,
                    kind: "chat",
                    title: conversation.title.isEmpty ? "New chat" : conversation.title,
                    updatedAt: conversation.lastMessageAt,
                    href: "/chat/\(conversation.id)",
                    pinned: conversation.pinned,
                    projectID: conversation.projectId
                )
            )
        }
        for session in codeSessions {
            items.append(
                NativeRecentItem(
                    id: session.id.value,
                    kind: "code",
                    title: session.title.isEmpty ? "Untitled session" : session.title,
                    updatedAt: session.updatedAt,
                    href: DesktopSearchRoute.localCodeSessionPrefix + session.id.value
                )
            )
        }
        for project in projects {
            items.append(
                NativeRecentItem(
                    id: project.id,
                    kind: "project",
                    title: project.name,
                    updatedAt: project.updatedAt,
                    href: "/projects/\(project.id)",
                    pinned: project.starred
                )
            )
        }
        return Array(
            items.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }.prefix(limit)
        )
    }

    static func recentIcon(_ kind: String) -> JunoIcon {
        switch kind {
        case "work": .work
        case "code": .code
        case "project": .projects
        default: .conversation
        }
    }

    /// The merged result list: local groups and the server's, in the web's
    /// group order, each group at most six rows (the web's per-type limit).
    static func resultRows(
        query: String,
        local: [NativeSearchResult],
        server: NativeUnifiedSearchResult?,
        typeFilter: NativeUnifiedSearchType?,
        window: NativeSearchWindow,
        projectFilter: String?,
        projectOfConversation: (String) -> String?,
        hooks: DesktopCommandCatalog.Hooks,
        now: Date,
        tasks: [WorkSessionSummary] = []
    ) -> [DesktopPanelRow] {
        let since = window.since(now: now)
        var byType: [NativeUnifiedSearchType: [DesktopPanelRow]] = [:]

        if searchesLocally(typeFilter) {
            for result in local {
                guard let type = localType(result.kind) else { continue }
                if let typeFilter, typeFilter != type { continue }
                if let since, result.updatedAt < since { continue }
                if let projectFilter {
                    let project: String? = switch result.kind {
                    case .project: result.entityID
                    default: (result.conversationID ?? (result.kind == .conversation ? result.entityID : nil))
                        .flatMap(projectOfConversation)
                    }
                    guard project == projectFilter else { continue }
                }
                guard (byType[type]?.count ?? 0) < 6 else { continue }
                byType[type, default: []].append(localRow(result, type: type, query: query, now: now))
            }
        }

        if let server {
            for group in server.groups where serverSearchedTypes.contains(group.type) {
                if let typeFilter, typeFilter != group.type { continue }
                for hit in group.hits {
                    guard let action = DesktopSearchRoute.hit(hit, hooks: hooks) else { continue }
                    byType[group.type, default: []].append(
                        DesktopPanelRow(
                            id: "server-\(hit.id)",
                            group: group.type.label,
                            label: hit.title.isEmpty ? "Untitled" : hit.title,
                            labelMarks: hit.titleMarks,
                            snippet: hit.snippet,
                            meta: hit.locator ?? hit.updatedAt.map { DesktopCommandCatalog.relativeTime($0, now: now) },
                            icon: icon(for: group.type),
                            action: action
                        )
                    )
                }
            }
        }

        // The account's tasks this Mac holds (Phase 5 D's Tasks scope): every
        // query word in the title or the goal, after the server's hits and
        // never one of them twice, up to the group's six. A task with a chat
        // opens it; one without opens its sheet (seam 6).
        if typeFilter == nil || typeFilter == .work, projectFilter == nil {
            let shown = Set((byType[.work] ?? []).compactMap { row in
                row.id.hasPrefix("server-work:") ? String(row.id.dropFirst("server-work:".count)) : nil
            })
            for task in DesktopPanelTasks.matching(tasks, query: query) {
                guard (byType[.work]?.count ?? 0) < 6 else { break }
                guard !shown.contains(task.id) else { continue }
                if let since, task.lastActivityAt < since { continue }
                let action: DesktopPanelAction
                if let conversationID = task.conversationID {
                    action = .conversation(id: conversationID)
                } else if hooks.openTaskRecord != nil {
                    action = .taskRecord(sessionID: task.id)
                } else {
                    continue
                }
                byType[.work, default: []].append(
                    DesktopPanelRow(
                        id: "task-\(task.id)",
                        group: NativeUnifiedSearchType.work.label,
                        label: DesktopPanelTasks.title(of: task),
                        labelMarks: marks(of: query, in: DesktopPanelTasks.title(of: task)),
                        meta: DesktopCommandCatalog.relativeTime(task.lastActivityAt, now: now),
                        icon: icon(for: .work),
                        action: action
                    )
                )
            }
        }

        return NativeUnifiedSearchType.allCases.flatMap { byType[$0] ?? [] }
    }

    static func localType(_ kind: NativeSearchResultKind) -> NativeUnifiedSearchType? {
        switch kind {
        case .conversation: .conversation
        case .message: .message
        case .project: .project
        case .file: .file
        case .artifact: .artifact
        // Memory is the server's (decision 7): the store's own memory rows
        // are not listed, so a fact never appears twice.
        case .memory: nil
        }
    }

    /// The web's `SEARCH_TYPE_ICONS`.
    static func icon(for type: NativeUnifiedSearchType) -> JunoIcon {
        switch type {
        case .conversation: .conversation
        case .message: .message
        case .project: .projects
        case .file: .file
        case .knowledge: .knowledge
        case .artifact: .artifacts
        case .memory: .memory
        case .work: .work
        }
    }

    private static func localRow(
        _ result: NativeSearchResult,
        type: NativeUnifiedSearchType,
        query: String,
        now: Date
    ) -> DesktopPanelRow {
        let action: DesktopPanelAction = switch result.kind {
        case .conversation: .conversation(id: result.entityID)
        case .message: .conversation(id: result.conversationID ?? result.entityID, messageID: result.entityID)
        case .project: .project(result.entityID)
        // Files open the Library (B1's routing table).
        case .file: .destination(.library)
        case .artifact: .artifact(id: result.entityID, conversationID: result.conversationID)
        case .memory: .destination(.memory)
        }
        let snippetText = result.snippet.trimmingCharacters(in: .whitespacesAndNewlines)
        let snippet: NativeSearchSnippet? = snippetText.isEmpty || snippetText == result.title
            ? nil
            : NativeSearchSnippet(text: snippetText, marks: marks(of: query, in: snippetText))
        return DesktopPanelRow(
            id: "local-\(result.kind.rawValue)-\(result.entityID)",
            group: type.label,
            label: result.title.isEmpty ? "Untitled" : result.title,
            labelMarks: marks(of: query, in: result.title),
            snippet: snippet,
            meta: result.updatedAt.timeIntervalSince1970 > 0
                ? DesktopCommandCatalog.relativeTime(result.updatedAt, now: now)
                : nil,
            icon: icon(for: type),
            action: action
        )
    }

    /// The reader's words inside `text`, as UTF-16 marks.
    ///
    /// The local store carries no ranges, so this marks literal,
    /// case- and diacritic-insensitive occurrences of each word of two or more
    /// characters: text that genuinely contains the word, never a guess.
    static func marks(of query: String, in text: String) -> [NativeSearchMark] {
        let terms = query
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .map(String.init)
            .filter { $0.count > 1 }
        guard !terms.isEmpty, !text.isEmpty else { return [] }
        var ranges: [Range<String.Index>] = []
        for term in terms {
            var cursor = text.startIndex
            while cursor < text.endIndex,
                let found = text.range(
                    of: term,
                    options: [.caseInsensitive, .diacriticInsensitive],
                    range: cursor..<text.endIndex
                )
            {
                ranges.append(found)
                cursor = found.upperBound > found.lowerBound ? found.upperBound : text.index(after: found.lowerBound)
            }
        }
        ranges.sort { $0.lowerBound < $1.lowerBound }
        var merged: [Range<String.Index>] = []
        for range in ranges {
            if let last = merged.last, range.lowerBound <= last.upperBound {
                merged[merged.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
            } else {
                merged.append(range)
            }
        }
        let utf16 = text.utf16
        return merged.map { range in
            NativeSearchMark(
                start: utf16.distance(from: utf16.startIndex, to: range.lowerBound),
                end: utf16.distance(from: utf16.startIndex, to: range.upperBound)
            )
        }
    }

    // MARK: - Notices and status

    /// The lines under the filters that say what was searched only in part.
    ///
    /// Offline, one line per server type in scope ("Memory: not searched while
    /// offline."). A server that failed while this Mac is online says the same
    /// per type with its own words. Otherwise the server's own shortfalls, at
    /// most two, then the web's count of the rest.
    var notices: [String] {
        // A search that failed outright says so in its tile, once.
        guard mode == .search, !trimmedQuery.isEmpty, !searchFailed else { return [] }
        return Self.notices(server: server, types: serverTypes)
    }

    static func notices(server: ServerState, types: [NativeUnifiedSearchType]) -> [String] {
        switch server {
        case .failed(let offline):
            let ordered = NativeUnifiedSearchType.allCases.filter { types.contains($0) }
            return ordered.map {
                offline
                    ? "\($0.label): not searched while offline."
                    : "\($0.label): couldn’t be searched right now."
            }
        case .ready(let result):
            let shortfalls = result.shortfalls
            var lines = shortfalls.prefix(2).map { "\($0.type.label): \($0.detail ?? "")" }
            if shortfalls.count > 2 {
                lines.append("\(shortfalls.count - 2) more part of your account was searched only in part.")
            }
            return lines
        case .idle, .searching, .skipped:
            return []
        }
    }

    /// Whether the search could not be done at all: the error tile.
    var searchFailed: Bool {
        guard case .failed = local else { return false }
        switch server {
        case .failed, .skipped: return true
        default: return false
        }
    }

    /// Whether the search is done for this query, however it ended.
    var searchSettled: Bool {
        if case .searching = local { return false }
        return server != .searching
    }

    /// What the panel announces once a result set settles — the web's status
    /// words.
    func status(rowCount: Int) -> String {
        guard mode == .search, !trimmedQuery.isEmpty else { return "" }
        if searchFailed { return "Search is unavailable right now." }
        if !searchSettled { return "Searching" }
        var partial = false
        if case .ready(let result) = server { partial = result.partial }
        if case .failed = server { partial = true }
        return "\(rowCount) \(rowCount == 1 ? "result" : "results")"
            + (partial ? ", some sources searched only in part" : "")
    }
}

// MARK: - Routing

/// Where a hit or a Recent row goes (B1's routing table), as a
/// ``DesktopPanelAction`` — or nil when this Mac has nowhere to take it, which
/// leaves the row out.
enum DesktopSearchRoute {
    /// A server hit, by its type first and its `href` second.
    static func hit(_ hit: NativeSearchHit, hooks: DesktopCommandCatalog.Hooks) -> DesktopPanelAction? {
        switch hit.type {
        case .file, .knowledge:
            return .destination(.library)
        case .memory:
            return .destination(.memory)
        case .work:
            if let conversation = conversation(in: hit.href) {
                return .conversation(id: conversation.id, messageID: conversation.messageID)
            }
            // A task with no conversation: its record, once seam 6 is wired.
            guard hooks.openTaskRecord != nil, hit.id.hasPrefix("work:") else { return nil }
            return .taskRecord(sessionID: String(hit.id.dropFirst("work:".count)))
        case .artifact:
            if let id = artifactID(in: hit.href) { return .artifact(id: id, conversationID: nil) }
            return path(hit.href)
        case .conversation, .message, .project:
            return path(hit.href)
        }
    }

    /// A Recent row. Code's rows switch to Code: the web's code sessions are
    /// not this Mac's local ones.
    static func recent(kind: String, href: String) -> DesktopPanelAction? {
        if kind == "code" {
            if href.hasPrefix(localCodeSessionPrefix) {
                return .codeSession(CodeSessionID(value: String(href.dropFirst(localCodeSessionPrefix.count))))
            }
            return .openCode
        }
        return path(href)
    }

    /// How a local Recent row names one of this Mac's Code sessions.
    static let localCodeSessionPrefix = "juno-code-session:"

    /// An `href` on the web app.
    static func path(_ href: String) -> DesktopPanelAction? {
        if let conversation = conversation(in: href) {
            return .conversation(id: conversation.id, messageID: conversation.messageID)
        }
        let components = URLComponents(string: href)
        let segments = (components?.path ?? href).split(separator: "/").map(String.init)
        switch segments.first {
        case "projects":
            if segments.count > 1 { return .project(segments[1]) }
            return .destination(.projects)
        case "a":
            if segments.count > 1 { return .artifact(id: segments[1], conversationID: nil) }
            return .destination(.artifacts)
        case "artifacts":
            return .destination(.artifacts)
        case "memory":
            return .destination(.memory)
        case "library":
            return .destination(.library)
        case "chat" where segments.count == 1:
            return nil
        default:
            return href.hasPrefix("/") ? .web(path: href) : nil
        }
    }

    /// `/chat/{id}[?m=]` → the conversation and the message.
    static func conversation(in href: String) -> (id: String, messageID: String?)? {
        guard let components = URLComponents(string: href) else { return nil }
        let segments = components.path.split(separator: "/").map(String.init)
        guard segments.count >= 2, segments[0] == "chat" else { return nil }
        let id = segments[1].removingPercentEncoding ?? segments[1]
        guard !id.isEmpty else { return nil }
        let message = components.queryItems?.first { $0.name == "m" }?.value
        return (id, message?.isEmpty == false ? message : nil)
    }

    static func artifactID(in href: String) -> String? {
        guard let components = URLComponents(string: href) else { return nil }
        let segments = components.path.split(separator: "/").map(String.init)
        guard segments.count >= 2, segments[0] == "a" else { return nil }
        return segments[1]
    }
}

/// The account's tasks as the panel lists them (Phase 5 D's Search › Tasks
/// scope, moved here with the Search page's retirement).
enum DesktopPanelTasks {
    /// A task's name: its title, or its goal when it has none.
    static func title(of task: WorkSessionSummary) -> String {
        let title = task.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? task.goal : title
    }

    /// Every word of the query in the title or the goal, ignoring case and
    /// accents; newest activity first.
    static func matching(_ tasks: [WorkSessionSummary], query: String) -> [WorkSessionSummary] {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        let sorted = tasks.sorted { $0.lastActivityAt > $1.lastActivityAt }
        guard !words.isEmpty else { return sorted }
        return sorted.filter { task in
            words.allSatisfy { word in
                task.title.range(of: word, options: [.caseInsensitive, .diacriticInsensitive]) != nil
                    || task.goal.range(of: word, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            }
        }
    }
}
