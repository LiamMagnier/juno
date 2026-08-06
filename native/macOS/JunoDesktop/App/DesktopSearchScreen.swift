import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// Global search over the encrypted account store, as a Mac window's own search.
///
/// On this platform search is not a page with a text field drawn in it: it is the
/// window's search field, in the toolbar, with a scope bar under it. That is what
/// `.searchable` + `.searchScopes` give us, and it is why this view draws no field
/// of its own — the phone app hand-builds one because iOS 26 relocates the
/// system field without asking, and a Mac toolbar has no such problem.
///
/// **The corpus is stated, never implied.** `NativeSearchStore` decrypts the
/// synchronized snapshot and scores it through a throwaway in-memory index on
/// every keystroke, so "still working" and "nothing matched" are genuinely
/// different states and are shown as different states. An empty result list while
/// that index is being built would read as "no matches", which is the one lie a
/// search surface must not tell.
struct DesktopSearchScreen: View {
    @Bindable var model: NativeSearchModel<SQLiteAccountRepository>
    let openConversation: (String) -> Void

    @State private var scope = DesktopSearchScope.everything
    @State private var selection: NativeSearchResult.ID?
    @FocusState private var fieldFocused: Bool

    private var query: Binding<String> {
        Binding(
            get: { model.query },
            set: { model.setQuery($0) }
        )
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // No canvas here. The detail column paints it once; repainting it
            // inside a page is what flattens the window into a single cream field
            // and leaves floating chrome with nothing to refract.
            .safeAreaInset(edge: .bottom, spacing: 0) { statusBar }
            .searchable(text: query, placement: .toolbar, prompt: "Search Juno")
            .searchFocused($fieldFocused)
            // `.onSearchPresentation` rather than `.onTextEntry` on purpose: the
            // Mac's field is always presented, so the scope bar stays put instead
            // of being inserted and removed beneath a live window's toolbar as
            // the reader types.
            .searchScopes($scope, activation: .onSearchPresentation) {
                ForEach(DesktopSearchScope.allCases) { option in
                    Text(option.title).tag(option)
                }
            }
            // Return in the field opens the highlighted result. Focus usually sits
            // in the field, where the list's own Return handling cannot reach.
            .onSubmit(of: .search) { openPrimaryResult() }
            // Not `.onAppear`: the toolbar's field does not exist yet at that
            // point, so the focus request has nothing to land on. This is the
            // ⌘⇧F path — the menu command switches the window to Search, and the
            // field takes focus as the screen comes up.
            .task { fieldFocused = true }
            .onChange(of: visibleResultIDs) { _, ids in
                // Keep Return meaningful. A new query throws away the previous
                // selection, and a list with nothing selected would open nothing.
                if let current = selection, ids.contains(current) { return }
                selection = ids.first
            }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
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
                symbol: "character.cursor.ibeam"
            )
            .accessibilityIdentifier("juno.desktop.search-untokenizable")
        case .failed:
            JunoEmptyState(
                title: "Search unavailable",
                message: model.lastErrorDescription
                    ?? "The encrypted account store could not be read on this Mac.",
                symbol: "exclamationmark.triangle",
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
                symbol: "line.3.horizontal.decrease.circle",
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
        // `--sidebar-accent`: a warm grey barely a step off the ground.
        .junoSidebarSelectionTint()
        // The canvas behind the rows is the page's, so the list does not paint a
        // second, cooler background inside a warm window.
        .scrollContentBackground(.hidden)
        .onKeyPress(.return) {
            openPrimaryResult()
            return .handled
        }
        .accessibilityIdentifier("juno.desktop.search-results")
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
            Text("Encrypted store on this Mac")
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
        switch model.phase {
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
private enum DesktopSearchScope: String, CaseIterable, Identifiable, Hashable {
    case everything
    case chats
    case projects
    case files
    case artifacts

    var id: Self { self }

    var title: String {
        switch self {
        case .everything: "All"
        case .chats: "Chats"
        case .projects: "Projects"
        case .files: "Files"
        case .artifacts: "Artifacts"
        }
    }

    func includes(_ kind: NativeSearchResultKind) -> Bool {
        switch self {
        case .everything: kind != .memory
        case .chats: kind == .conversation || kind == .message
        case .projects: kind == .project
        case .files: kind == .file
        case .artifacts: kind == .artifact
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
