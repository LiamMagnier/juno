import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoWorkKit
import SwiftUI

/// Global search over the encrypted account store.
///
/// A page on the `JunoPage` template (spec §9): its field and its scopes are in
/// content, and the toolbar is the chat window's alone (§3). The ⌘K panel
/// replaces this page in Phase 3.
///
/// **The corpus is stated, never implied.** `NativeSearchStore` decrypts the
/// synchronized snapshot and scores it through a throwaway in-memory index on
/// every keystroke, so "still working" and "nothing matched" are genuinely
/// different states and are shown as different states. An empty result list while
/// that index is being built would read as "no matches", which is the one lie a
/// search surface must not tell.
///
/// **Tasks** (Phase 5 Stage D) is the one scope read from the server rather
/// than the store: every task on the account, archived ones too, newest
/// first. A task with a chat opens it; one the old Work window started, with
/// no chat, opens its sheet (register #63). The ⌘K panel that replaces this
/// page in Phase 3 carries the scope forward.
struct DesktopSearchScreen: View {
    @Bindable var model: NativeSearchModel<SQLiteAccountRepository>
    let openConversation: (String) -> Void
    /// The server's `activity` frames for the generation running in Chat, if
    /// there is one. Empty is the ordinary state and draws nothing.
    var researchActivity: [NativeChatActivity] = []
    /// Takes the reader to the conversation the research run belongs to. Nil
    /// where there is no conversation to return to, which disables the control
    /// rather than leaving one that does nothing.
    var openResearchRun: (() -> Void)?
    /// Reads the account's tasks for the Tasks scope. Nil where Work is not
    /// composed, which leaves the scope out.
    var taskSource: (() async throws -> [WorkSessionSummary])? = nil
    /// Opens a task: its chat, or its sheet when it has none.
    var openTask: (WorkSessionSummary) -> Void = { _ in }
    /// The scope to open on, and the tasks already read — for fixtures.
    var initialScope = DesktopSearchScope.everything
    var initialTasks: DesktopSearchTaskList? = nil
    /// A pinned "now" for fixtures; nil reads the clock.
    var now: Date? = nil

    @State private var scopeChoice: DesktopSearchScope?
    @State private var selection: NativeSearchResult.ID?
    @State private var taskList: DesktopSearchTaskList?
    @State private var taskSelection: WorkSessionSummary.ID?
    @FocusState private var fieldFocused: Bool

    private var scope: DesktopSearchScope {
        get { scopeChoice ?? initialScope }
        nonmutating set { scopeChoice = newValue }
    }

    private var scopeBinding: Binding<DesktopSearchScope> {
        Binding(get: { scope }, set: { scope = $0 })
    }

    /// The scopes this Mac can offer: Tasks only where there is a server to
    /// read them from.
    private var scopes: [DesktopSearchScope] {
        DesktopSearchScope.allCases.filter { $0 != .tasks || taskSource != nil }
    }

    private var tasks: DesktopSearchTaskList { taskList ?? initialTasks ?? .loading }

    private var query: Binding<String> {
        Binding(
            get: { model.query },
            set: { model.setQuery($0) }
        )
    }

    var body: some View {
        // The page template (spec §9) until the ⌘K panel replaces this page
        // (Phase 3): the field and the scopes in the controls row, nothing in
        // the toolbar (§3). They used to be the window's `.searchable` and its
        // scope bar, which came and went with the destination — the toolbar
        // rebuild of crash rule 3.
        JunoPage(measure: .reading, scrolling: .content) {
            JunoPageHeader(
                "Search",
                lede: "Chats, messages, files and artifacts synced to this Mac."
            )
        } controls: {
            JunoPageControls {
                JunoPageSearchField(
                    text: query,
                    prompt: "Search Juno",
                    isSearching: model.phase == .searching,
                    accessibilityIdentifier: "juno.desktop.search-field",
                    focus: $fieldFocused,
                    // Return opens the highlighted result: focus usually sits
                    // in the field, where the list's own Return cannot reach.
                    submit: openPrimaryResult
                )
                JunoSegmented(
                    options: scopes.map {
                        JunoSegmented<DesktopSearchScope>.Option($0, $0.title)
                    },
                    selection: scopeBinding,
                    accessibilityLabel: "Search in"
                )
            }
        } content: {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // No canvas here. The detail column paints it once; repainting
                // it inside a page is what flattens the window into a single
                // cream field.
                .safeAreaInset(edge: .top, spacing: 0) { researchBar }
                .safeAreaInset(edge: .bottom, spacing: 0) { statusBar }
        }
        // ⇧⌘F switches the window to Search, and the field takes focus as the
        // page comes up.
        .task { fieldFocused = true }
        .onChange(of: visibleResultIDs) { _, ids in
            // Keep Return meaningful. A new query throws away the previous
            // selection, and a list with nothing selected would open nothing.
            if let current = selection, ids.contains(current) { return }
            selection = ids.first
        }
        .onChange(of: visibleTaskIDs) { _, ids in
            if let current = taskSelection, ids.contains(current) { return }
            taskSelection = ids.first
        }
        // Read each time the scope is chosen, so a task started since shows.
        .task(id: scope) {
            guard scope == .tasks, initialTasks == nil else { return }
            await readTasks()
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if scope == .tasks {
            tasksContent
        } else {
            storeContent
        }
    }

    @ViewBuilder
    private var storeContent: some View {
        switch model.phase {
        case .idle where model.query.isEmpty:
            JunoEmptyState(
                title: "Search Juno",
                message: "Chats, messages, files and artifacts — everything synced to this Mac, searched offline against the encrypted account store.",
                icon: .search
            )
            .accessibilityIdentifier("juno.desktop.search-intro")
        case .idle:
            // The index tokenizes on letters and digits, so a query of pure
            // punctuation is not a query that found nothing — it is not yet a
            // query at all, and saying "no results" would blame the account.
            JunoEmptyState(
                title: "Nothing to match yet",
                message: "“\(model.query)” has no letters or numbers in it. Add a word to search for.",
                icon: .textCursor
            )
            .accessibilityIdentifier("juno.desktop.search-untokenizable")
        case .failed:
            JunoEmptyState(
                title: "Search unavailable",
                message: model.lastErrorDescription
                    ?? "The encrypted account store could not be read on this Mac.",
                icon: .triangleAlert,
                actionLabel: "Try Again",
                action: { model.setQuery(model.query, debounced: false) }
            )
            .accessibilityIdentifier("juno.desktop.search-failed")
        case .searching where visibleResults.isEmpty:
            indexing
        case .ready where visibleResults.isEmpty:
            noMatches
        default:
            results
        }
    }

    /// Shown only while there is nothing to show yet. Once results are on screen a
    /// re-query keeps them and the status bar carries the fact that it is working,
    /// so refining a query does not blank the window on every keystroke.
    private var indexing: some View {
        VStack(spacing: JunoSpace.cozy) {
            ProgressView()
                .controlSize(.small)
            Text("Building the encrypted index…")
                .junoCaption()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.desktop.search-indexing")
    }

    @ViewBuilder
    private var noMatches: some View {
        let elsewhere = model.groupedResults
            .filter { DesktopSearchScope.everything.includes($0.kind) }
            .reduce(0) { $0 + $1.results.count }

        if scope != .everything, elsewhere > 0 {
            JunoEmptyState(
                title: "No \(scope.title.lowercased()) match",
                message: "“\(model.query)” matches \(elsewhere) \(elsewhere == 1 ? "item" : "items") of other kinds.",
                icon: .filter,
                actionLabel: "Search Everything",
                action: { scope = .everything }
            )
            .accessibilityIdentifier("juno.desktop.search-scope-empty")
        } else {
            JunoEmptyState(
                title: "No results",
                message: "Nothing synced to this Mac matches “\(model.query)”.",
                icon: .search
            )
            .accessibilityIdentifier("juno.desktop.search-no-results")
        }
    }

    private var results: some View {
        List(selection: $selection) {
            ForEach(visibleGroups, id: \.kind) { group in
                Section(group.kind.sectionTitle) {
                    ForEach(group.results) { result in
                        row(result)
                            .tag(result.id)
                    }
                }
            }
        }
        .listStyle(.inset)
        // Says what colour a selection is, and leaves the drawing to the list —
        // arrow keys, type-select and the focus ring all keep working. Without
        // it macOS resolves a focused selection to the app's accent, and a
        // full-width coral bar is nothing like the web, where a selected row is
        // `--sidebar-selected`: warm paper picked out of the column it sits in.
        .junoSidebarSelectionTint()
        // The canvas behind the rows is the page's, so the list does not paint a
        // second, cooler background inside a warm window.
        .scrollContentBackground(.hidden)
        .onKeyPress(.return) {
            openPrimaryResult()
            return .handled
        }
        .accessibilityIdentifier("juno.desktop.search-results")
        .junoPageColumn()
    }

    private func row(_ result: NativeSearchResult) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(emphasizingQuery(in: result.title))
                    .junoRowLabel()
                    .lineLimit(1)
                if !result.snippet.isEmpty, result.snippet != result.title {
                    Text(emphasizingQuery(in: result.snippet))
                        .junoCaption()
                        .lineLimit(2)
                }
            }
            Spacer(minLength: JunoSpace.snug)
            if let updatedAt = knownDate(result.updatedAt) {
                Text(updatedAt, format: .relative(presentation: .named))
                    .junoCaption()
                    .lineLimit(1)
            }
        }
        .padding(.vertical, JunoSpace.hairline)
        // Pinned so the platform's emphasis style cannot invert the label to
        // white over a pale grey selection. The caption inside keeps its own
        // secondary style — a colour set closer to the leaf wins.
        .junoSidebarRowInk()
        // Belt and braces over ``junoSidebarSelectionTint()``, and the reason
        // this list is the one place that draws its own fill. The tint is the
        // supported lever and it is what keeps the platform drawing the
        // selection — but `.sidebar` and `.inset` are two different AppKit
        // highlight styles, only the first of which the desktop shell has ever
        // had eyes on, and a row background is composited above whatever fill
        // the row view chose. So this settles the colour rather than asking for
        // it. Clear while unselected, so an unselected row is still nothing but
        // the canvas it sits on and there is no second fill to keep in step with
        // the page.
        //
        // A `Table` publishes no equivalent, which is why the tables on Library,
        // Tasks and Memory have to trust the tint alone.
        .listRowBackground(
            selection == result.id ? Color.junoSidebarSelection : Color.clear
        )
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { open(result) }
        .contextMenu {
            Button("Open in Chat") { open(result) }
                .disabled(conversationTarget(of: result) == nil)
            Button("Copy Title") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(result.title, forType: .string)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(result.title), \(result.kind.sectionTitle)")
        .accessibilityHint(
            conversationTarget(of: result) == nil
                ? "Cannot be opened from Search"
                : "Opens the conversation"
        )
    }

    // MARK: - Tasks

    /// The account's tasks as rows: the title, "Updated {ago}", and the status
    /// pill in one column at the trailing edge. **Signature detail:** the
    /// pills line up down that edge, so a reader scans the statuses before
    /// the titles, and a live task's dot is the one coral mark on the page.
    @ViewBuilder
    private var tasksContent: some View {
        switch tasks {
        case .loading:
            DesktopSearchTaskSkeleton()
                .junoPageColumn()
                .accessibilityIdentifier("juno.desktop.search-tasks-loading")
        case .failed:
            JunoEmptyState(
                title: "Couldn\u{2019}t load tasks",
                message: "Check your connection and try again.",
                icon: .error,
                actionLabel: taskSource == nil ? nil : "Try Again",
                action: taskSource == nil ? nil : { Task { await readTasks() } },
                size: .panel,
                tone: .error
            )
            .taskScopeState()
            .accessibilityIdentifier("juno.desktop.search-tasks-failed")
        case .ready(let all) where all.isEmpty:
            JunoEmptyState(
                title: "No tasks yet",
                message: "Tasks Juno runs for you appear here.",
                icon: .task,
                size: .panel
            )
            .taskScopeState()
            .accessibilityIdentifier("juno.desktop.search-tasks-empty")
        case .ready where visibleTasks.isEmpty:
            JunoEmptyState(
                title: "No results",
                message: "No task matches \u{201C}\(model.query)\u{201D}.",
                icon: .search,
                size: .panel
            )
            .taskScopeState()
            .accessibilityIdentifier("juno.desktop.search-tasks-no-results")
        case .ready:
            List(selection: $taskSelection) {
                ForEach(visibleTasks) { task in
                    taskRow(task)
                        .tag(task.id)
                }
            }
            .listStyle(.inset)
            .junoSidebarSelectionTint()
            .scrollContentBackground(.hidden)
            .onKeyPress(.return) {
                openPrimaryResult()
                return .handled
            }
            .accessibilityIdentifier("juno.desktop.search-tasks")
            .junoPageColumn()
        }
    }

    private func taskRow(_ task: WorkSessionSummary) -> some View {
        let status = JunoWorkStatus(rawValue: task.status) ?? .interrupted
        let title = Self.title(of: task)
        let updated = "Updated \(ChatWorkFormat.ago(task.lastActivityAt, now: now ?? Date()))"
        return HStack(alignment: .center, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(emphasizingQuery(in: title))
                    .junoRowLabel()
                    .lineLimit(1)
                Text(task.archived ? "\(updated) \u{00B7} Archived" : updated)
                    .junoCaption()
                    .lineLimit(1)
            }
            Spacer(minLength: JunoSpace.regular)
            ChatWorkStatusPill(status: status)
        }
        .padding(.vertical, JunoSpace.hairline)
        .junoSidebarRowInk()
        .listRowBackground(taskSelection == task.id ? Color.junoSidebarSelection : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { openTask(task) }
        .contextMenu {
            Button(task.conversationID == nil ? "Open Task" : "Open in Chat") { openTask(task) }
            Button("Copy Title") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(title, forType: .string)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(ChatWorkVocabulary.label(status)), \(updated)")
        .accessibilityHint(task.conversationID == nil ? "Opens the task" : "Opens its chat")
        .accessibilityIdentifier("juno.desktop.search-task.\(task.id)")
    }

    static func title(of task: WorkSessionSummary) -> String {
        let title = task.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? task.goal : title
    }

    /// The tasks the query matches — every word, in the title or the goal —
    /// newest activity first.
    private var visibleTasks: [WorkSessionSummary] {
        guard case .ready(let all) = tasks else { return [] }
        return DesktopSearchTaskList.matching(all, query: model.query)
    }

    private var visibleTaskIDs: [WorkSessionSummary.ID] {
        scope == .tasks ? visibleTasks.map(\.id) : []
    }

    private func readTasks() async {
        guard let taskSource else { return }
        if case .ready = tasks {} else { taskList = .loading }
        do {
            taskList = .ready(try await taskSource())
        } catch is CancellationError {
            return
        } catch {
            // What was read stays on screen; only a first read fails loudly.
            if case .ready = tasks { return }
            taskList = .failed
        }
    }

    // MARK: - Research

    /// The deep-research run happening in Chat, reported on the screen whose
    /// whole job is finding things.
    ///
    /// **Why here.** This page searches the encrypted store on this Mac and says
    /// so in its own status bar; deep research is the other half of the same
    /// question, running against the web, and a reader who came here looking for
    /// something Juno is *at that moment* reading twelve pages about should be
    /// told rather than shown "No results". The strip is the pointer back.
    ///
    /// Everything in it is read through ``DeepResearchActivityProjection``, which
    /// maps the server's existing `activity` stream onto the same phase and
    /// citation vocabulary a local run produces — not a second research engine
    /// with its own opinion about what the run did.
    @ViewBuilder
    private var researchBar: some View {
        let run = DeepResearchActivityProjection.progress(from: researchActivity)
        // Absent, not empty: no activity is no run, and a strip that appears with
        // nothing in it would read as a run that has stalled.
        if !researchActivity.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                HStack(spacing: JunoSpace.snug) {
                    JunoIconView(.binoculars)
                        .junoSecondaryInk()
                    // The phase is the server's own account of where it is, never
                    // a guess one step ahead of the events — a label that runs
                    // ahead is how a stuck run looks healthy.
                    Text(researchHeadline(run))
                        .junoCaption()
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: JunoSpace.regular)
                    if let counts = run.countsSummary {
                        Text(counts)
                            .junoCaption()
                            .monospacedDigit()
                            .lineLimit(1)
                    }
                    if let openResearchRun {
                        Button("Open in Chat", action: openResearchRun)
                            .buttonStyle(.link)
                            .accessibilityIdentifier("juno.desktop.search-research-open")
                    }
                }
                // A run that quietly degraded to plain chat has to say so: the
                // reader asked for research and the answer is not researched.
                // Only the first — the rest of a warning burst says the same
                // thing in different words and would bury the strip.
                if let warning = run.warnings.first {
                    Label(verbatim: warning, icon: .triangleAlert)
                        .junoCaption()
                        .foregroundStyle(Color.junoCaution)
                        .lineLimit(2)
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.snug)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.junoRaised)
            .overlay(alignment: .bottom) { Divider() }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("juno.desktop.search-research")
        }
    }

    /// Phase plus the query, when the run reported one.
    ///
    /// Two things it refuses to do. It does not keep saying "Researching" once
    /// the run is over — the activity outlives the generation that produced it,
    /// and a present tense over a finished run reports work that stopped minutes
    /// ago as still happening. And it drops the quoted half rather than inventing
    /// one: a nil query is the honest answer on the provider-tool search paths,
    /// where sources arrive from grounding metadata and the query the model typed
    /// never reaches this client.
    private func researchHeadline(_ run: ServerResearchProgress) -> String {
        let stage = switch run.phase {
        case .completed: "Researched the web"
        case .stopped: "Research stopped"
        default: "Researching the web · \(run.phase.displayName)"
        }
        guard let query = run.currentQuery else { return stage }
        return "\(stage) — “\(query)”"
    }

    // MARK: - Status

    /// The Mac's own way of stating provenance without a title strip in the
    /// content: a status bar, always present, saying what was searched and what
    /// the search covers.
    private var statusBar: some View {
        HStack(spacing: JunoSpace.snug) {
            if model.phase == .searching {
                ProgressView()
                    .controlSize(.small)
            }
            Text(statusText)
                .junoCaption()
            Spacer(minLength: JunoSpace.regular)
            Text(scope == .tasks ? "Tasks on your account" : "Encrypted store on this Mac")
                .junoCaption()
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .frame(maxWidth: .infinity)
        .background(Color.junoRaised)
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.desktop.search-status")
    }

    private var statusText: String {
        if scope == .tasks {
            switch tasks {
            case .loading: return "Reading your tasks\u{2026}"
            case .failed: return "Tasks unavailable"
            case .ready: return countText
            }
        }
        return switch model.phase {
        case .idle:
            model.query.isEmpty ? "Nothing searched yet" : "Waiting for a searchable word"
        case .searching:
            visibleResults.isEmpty ? "Reading the encrypted store…" : "Updating results…"
        case .ready:
            countText
        case .failed:
            "Index unavailable"
        }
    }

    private var countText: String {
        if scope == .tasks {
            let count = visibleTasks.count
            return count == 1 ? "1 task" : "\(count) tasks"
        }
        let count = visibleResults.count
        let noun = count == 1 ? "result" : "results"
        guard scope != .everything else { return "\(count) \(noun)" }
        return "\(count) \(noun) in \(scope.title.lowercased())"
    }

    // MARK: - Results in scope

    /// Memory is deliberately outside every scope, matching the phone: a saved
    /// fact is not somewhere the reader can be taken, and having every query
    /// surface Juno's notes about the account made results feel like they were
    /// about the wrong subject.
    private var visibleGroups: [(kind: NativeSearchResultKind, results: [NativeSearchResult])] {
        model.groupedResults.filter { scope.includes($0.kind) }
    }

    private var visibleResults: [NativeSearchResult] {
        visibleGroups.flatMap(\.results)
    }

    private var visibleResultIDs: [NativeSearchResult.ID] {
        visibleResults.map(\.id)
    }

    // MARK: - Opening

    private func openPrimaryResult() {
        if scope == .tasks {
            let chosen = taskSelection.flatMap { id in visibleTasks.first { $0.id == id } }
            if let task = chosen ?? visibleTasks.first { openTask(task) }
            return
        }
        let chosen = selection.flatMap { id in
            visibleResults.first { $0.id == id }
        }
        guard let result = chosen ?? visibleResults.first else { return }
        open(result)
    }

    private func open(_ result: NativeSearchResult) {
        guard let conversationID = conversationTarget(of: result) else { return }
        openConversation(conversationID)
    }

    /// Chat is the only place this screen can send the reader: it is handed one
    /// `openConversation` callback and nothing else. Projects have no conversation
    /// to open into, which is why the context menu's Open is disabled for them
    /// rather than silently doing nothing.
    private func conversationTarget(of result: NativeSearchResult) -> String? {
        if let conversationID = result.conversationID { return conversationID }
        return result.kind == .conversation ? result.entityID : nil
    }

    /// The store falls back to the epoch when a record carries no parseable
    /// timestamp. Rendering that relatively would claim the match is 56 years old.
    private func knownDate(_ date: Date) -> Date? {
        date.timeIntervalSince1970 > 0 ? date : nil
    }

    // MARK: - Emphasis

    /// Marks the reader's own words inside a result.
    ///
    /// A literal, case- and diacritic-insensitive match, because the model carries
    /// no ranges: `LocalSearchResult.matchedTerms` exists in the index but
    /// `NativeSearchResult` drops it. Literal matching only ever emphasizes text
    /// that genuinely contains the word — a result that matched on a keyword or a
    /// filename gets no emphasis instead of a guess. Terms shorter than two
    /// characters are skipped: bolding every "a" in a snippet is noise, not a hit.
    private func emphasizingQuery(in text: String) -> AttributedString {
        let terms = model.query
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .map(String.init)
            .filter { $0.count > 1 }
        guard !terms.isEmpty else { return AttributedString(text) }

        var matches: [Range<String.Index>] = []
        for term in terms {
            var cursor = text.startIndex
            while cursor < text.endIndex,
                let found = text.range(
                    of: term,
                    options: [.caseInsensitive, .diacriticInsensitive],
                    range: cursor..<text.endIndex
                ) {
                matches.append(found)
                cursor = found.upperBound > found.lowerBound
                    ? found.upperBound
                    : text.index(after: found.lowerBound)
            }
        }
        guard !matches.isEmpty else { return AttributedString(text) }

        // Two terms can overlap in the text ("open" and "pen"); merged first so a
        // run is never emitted twice and the emphasis stays flat.
        matches.sort { $0.lowerBound < $1.lowerBound }
        var merged: [Range<String.Index>] = []
        for match in matches {
            if let last = merged.last, match.lowerBound <= last.upperBound {
                merged[merged.count - 1] =
                    last.lowerBound..<max(last.upperBound, match.upperBound)
            } else {
                merged.append(match)
            }
        }

        // Built by concatenation rather than by mutating attributes through
        // `AttributedString.Index`es held across edits, which is the one way to
        // write this that does not depend on index-validity rules.
        var emphasized = AttributedString()
        var cursor = text.startIndex
        for range in merged {
            if cursor < range.lowerBound {
                emphasized += AttributedString(String(text[cursor..<range.lowerBound]))
            }
            var run = AttributedString(String(text[range]))
            run.inlinePresentationIntent = .stronglyEmphasized
            emphasized += run
            cursor = range.upperBound
        }
        if cursor < text.endIndex {
            emphasized += AttributedString(String(text[cursor...]))
        }
        return emphasized
    }
}

/// The result kinds the toolbar's scope bar offers.
///
/// Chats and messages share one scope: to a reader looking for a conversation
/// they are the same thing found two ways, and splitting them would put two
/// segments in the bar that answer the same question.
enum DesktopSearchScope: String, CaseIterable, Identifiable, Hashable {
    case everything
    case chats
    case projects
    case files
    case artifacts
    /// The account's tasks, read from the server (Phase 5 Stage D).
    case tasks

    var id: Self { self }

    var title: String {
        switch self {
        case .everything: "All"
        case .chats: "Chats"
        case .projects: "Projects"
        case .files: "Files"
        case .artifacts: "Artifacts"
        case .tasks: "Tasks"
        }
    }

    func includes(_ kind: NativeSearchResultKind) -> Bool {
        switch self {
        case .everything: kind != .memory
        case .chats: kind == .conversation || kind == .message
        case .projects: kind == .project
        case .files: kind == .file
        case .artifacts: kind == .artifact
        case .tasks: false
        }
    }
}

private extension NativeSearchResultKind {
    /// The website's vocabulary, which the phone already follows: a conversation
    /// is a "chat" everywhere a reader can see it.
    var sectionTitle: String {
        switch self {
        case .conversation: "Chats"
        case .message: "Messages"
        case .project: "Projects"
        case .file: "Files"
        case .artifact: "Artifacts"
        case .memory: "Memory"
        }
    }
}

/// The Tasks scope's read: not yet, failed, or the account's tasks.
enum DesktopSearchTaskList: Equatable {
    case loading
    case failed
    case ready([WorkSessionSummary])

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

/// Rows of the shape the Tasks scope will draw while it reads: a title, a
/// caption and a pill — skeleton rows, not a spinner.
private struct DesktopSearchTaskSkeleton: View {
    private static let widths: [(CGFloat, CGFloat)] = [(248, 96), (196, 112), (284, 88), (172, 104), (228, 92)]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Self.widths.indices, id: \.self) { index in
                HStack(spacing: JunoSpace.cozy) {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        bar(width: Self.widths[index].0, height: 10)
                        bar(width: Self.widths[index].1, height: 8)
                    }
                    Spacer(minLength: JunoSpace.regular)
                    Capsule(style: .continuous)
                        .fill(Color.junoMuted)
                        .frame(width: 64, height: 20)
                }
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.cozy)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, JunoSpace.snug)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Reading your tasks")
    }

    private func bar(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: JunoRadius.micro, style: .continuous)
            .fill(Color.junoMuted)
            .frame(width: width, height: height)
    }
}

private extension View {
    /// A Tasks-scope state panel: in the page's column, just under the
    /// controls, where the rows would start.
    func taskScopeState() -> some View {
        junoPageColumn()
            .padding(.top, JunoSpace.regular)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
