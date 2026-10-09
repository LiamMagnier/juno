import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// Global offline search across the synchronized encrypted account data.
///
/// Round 2 (native first): the field is the system's `.searchable` again — on
/// iOS 26 the system puts it in the bottom toolbar on Liquid Glass, which is the
/// thumb-height slot this screen wanted anyway — and the results are a plain
/// `List` with "Chats", "Projects" and "Messages" sections, rows in `.body` with
/// a `.subheadline` secondary line, and short relative dates ("2 min",
/// "Yesterday") instead of a running "1 yr, 2 mths" timer.
///
/// The field still owns its own string (`draft`) and the store follows it, so
/// the field and the store are never two sources for one value.
struct JunoMobileSearchView: View {
    @Bindable var model: NativeSearchModel<SQLiteAccountRepository>
    let open: (NativeSearchResult) -> Void
    /// Recently touched conversations, newest first. Shown before anything is
    /// typed.
    var recentConversations: [NativeConversation] = []
    var projects: [NativeProject] = []
    var openConversation: ((String) -> Void)?
    var openProject: ((String) -> Void)?
    /// Where a server hit (memory, knowledge, tasks) opens. Nil leaves the
    /// server's half out entirely.
    var openServerHit: ((NativeSearchHitDestination) -> Void)?

    @Environment(\.junoFeatureHub) private var hub
    /// The server half: memory, knowledge and tasks from `/api/search`.
    @State private var server: NativeServerSearchModel?
    @State private var draft = ""

    var body: some View {
        content
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $draft, prompt: Text("Chats, messages, projects, files"))
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .onAppear {
                draft = model.query
                if server == nil, openServerHit != nil, let client = hub?.searchClient, let accountID = hub?.accountID {
                    let made = NativeServerSearchModel(client: client, accountID: accountID)
                    made.setQuery(draft)
                    server = made
                }
            }
        #if DEBUG
            // `--juno-preview-search <query>` types a query, for screenshots.
            .task {
                let arguments = CommandLine.arguments
                guard let index = arguments.firstIndex(of: "--juno-preview-search"), index + 1 < arguments.count
                else { return }
                try? await Task.sleep(for: .seconds(2.5))
                draft = arguments[index + 1]
                model.setQuery(draft, debounced: false)
            }
        #endif
            .onChange(of: draft) { _, text in
                model.setQuery(text)
                server?.setQuery(text)
            }
            .toolbar {
                if server != nil {
                    ToolbarItem(placement: .topBarTrailing) { typeFilterMenu }
                }
            }
            .onChange(of: model.query) { _, query in
                if query != draft { draft = query }
            }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, model.phase == .idle {
            recents
        } else if localGroups.isEmpty, serverGroups.isEmpty, isStillSearching {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if localGroups.isEmpty, serverGroups.isEmpty, model.phase == .failed, server?.state != .skipped {
            ContentUnavailableView {
                Label("Search unavailable", image: JunoIcon.triangleAlert.assetName(.regular))
            } description: {
                Text(model.lastErrorDescription ?? "Try again.")
            } actions: {
                Button("Retry") {
                    model.setQuery(model.query, debounced: false)
                    server?.retry()
                }
                .contentShape(.rect)
                .modifier(JunoMobileWorkspaceActionStyle())
            }
        } else if localGroups.isEmpty, serverGroups.isEmpty, model.phase != .idle {
            ContentUnavailableView {
                Label("No Results", image: JunoIcon.search.assetName(.regular))
            } description: {
                Text(server == nil
                    ? "Nothing synced to this device matches “\(model.query)”."
                    : "Nothing synced to this device, in your memory, knowledge or tasks matches “\(model.query)”.")
            }
        } else {
            results
        }
    }

    private var isStillSearching: Bool {
        if model.phase == .searching { return true }
        return server?.isSearching == true
    }

    /// The local groups the type filter keeps, in the reading order the screen
    /// promises: chats, projects, then messages.
    private var localGroups: [(kind: NativeSearchResultKind, results: [NativeSearchResult])] {
        let filter = server?.typeFilter
        guard NativeServerSearchModel.searchesLocally(filter) else { return [] }
        let groups = visibleGroups.sorted { Self.rank($0.kind) < Self.rank($1.kind) }
        guard let kind = NativeServerSearchModel.localKind(for: filter) else { return groups }
        return groups.filter { $0.kind == kind }
    }

    private static func rank(_ kind: NativeSearchResultKind) -> Int {
        switch kind {
        case .conversation: 0
        case .project: 1
        case .message: 2
        case .file: 3
        case .artifact: 4
        case .memory: 5
        }
    }

    /// The server's groups, each hit kept only where this app can open it.
    private var serverGroups: [NativeSearchGroup] {
        guard let server else { return [] }
        return server.groups.compactMap { group in
            let hits = group.hits.filter { NativeSearchHitDestination(hit: $0) != nil }
            return hits.isEmpty ? nil : NativeSearchGroup(type: group.type, label: group.label, hits: hits)
        }
    }

    // MARK: - Type filter

    /// The web's type filter, as a native menu: everything, or one kind.
    private var typeFilterMenu: some View {
        Menu {
            Picker("Show", selection: Binding(
                get: { server?.typeFilter },
                set: { server?.setTypeFilter($0) }
            )) {
                Text("Everything").tag(NativeUnifiedSearchType?.none)
                ForEach(NativeServerSearchModel.filterChoices, id: \.self) { type in
                    Text(type.label).tag(NativeUnifiedSearchType?.some(type))
                }
            }
        } label: {
            JunoIconView(.filter, size: JunoLayout.Control.glyph, isOn: server?.typeFilter != nil)
                .accessibilityLabel(server?.typeFilter?.label ?? "Filter")
        }
        .contentShape(.rect)
        .accessibilityIdentifier("juno.mobile.search-filter")
    }

    /// Memory is excluded on purpose: a saved fact is not a place you can go.
    private var visibleGroups: [(kind: NativeSearchResultKind, results: [NativeSearchResult])] {
        model.groupedResults.filter { $0.kind != .memory }
    }

    private var results: some View {
        List {
            ForEach(localGroups, id: \.kind) { group in
                Section(sectionTitle(group.kind)) {
                    ForEach(group.results) { result in
                        row(
                            title: result.title,
                            detail: result.snippet != result.title ? result.snippet : "",
                            trailing: JunoMobileRelativeDate.text(result.updatedAt),
                            hint: "Opens \(sectionTitle(group.kind).lowercased())"
                        ) { open(result) }
                    }
                }
            }
            if let server {
                ForEach(serverGroups, id: \.type) { group in
                    Section(group.label) {
                        ForEach(group.hits) { hit in
                            row(
                                title: hit.title,
                                detail: hit.snippet?.text ?? "",
                                trailing: hit.locator.flatMap { $0.isEmpty ? nil : $0 }
                                    ?? hit.updatedAt.map { JunoMobileRelativeDate.text($0) } ?? "",
                                hint: "Opens \(hit.type.label.lowercased())"
                            ) {
                                if let destination = NativeSearchHitDestination(hit: hit) {
                                    openServerHit?(destination)
                                }
                            }
                        }
                    }
                }
                if server.isSearching || server.notice != nil {
                    Section {
                        if server.isSearching, !localGroups.isEmpty {
                            Text("Searching memory, knowledge and tasks…")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        if let notice = server.notice {
                            Text(notice)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .listRowSeparator(.hidden)
                }
            }
        }
        .listStyle(.plain)
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("juno.mobile.search-results")
    }

    /// One result: title in `.body`, an optional snippet under it, and a short
    /// date at the trailing edge.
    private func row(
        title: String,
        detail: String,
        trailing: String,
        hint: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
                    Text(title)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if !trailing.isEmpty {
                        Text(trailing)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                }
                if !detail.isEmpty {
                    Text(Self.plain(detail))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint(hint)
    }

    /// Snippets arrive as message markdown; a result row shows the words, not
    /// the asterisks.
    private static func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "__", with: "")
            .replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: "\n", with: " ")
    }

    // MARK: - Recents

    /// What the screen shows before a query: the chats and projects the reader was
    /// last in.
    @ViewBuilder
    private var recents: some View {
        if recentConversations.isEmpty && projects.isEmpty {
            ContentUnavailableView {
                Label("Search Alevr", image: JunoIcon.search.assetName(.regular))
            } description: {
                Text("Chats, messages, projects and files — everything synced to this device, searchable offline.")
            }
        } else {
            List {
                if !recentConversations.isEmpty {
                    Section("Recent Chats") {
                        ForEach(recentConversations.prefix(6)) { conversation in
                            row(
                                title: conversation.title,
                                detail: "",
                                trailing: JunoMobileRelativeDate.text(conversation.lastMessageAt),
                                hint: "Opens chat"
                            ) { openConversation?(conversation.id) }
                        }
                    }
                }
                if !projects.isEmpty {
                    Section("Projects") {
                        ForEach(projects.prefix(5)) { project in
                            row(
                                title: project.name,
                                detail: "",
                                trailing: JunoMobileRelativeDate.text(project.updatedAt),
                                hint: "Opens project"
                            ) { openProject?(project.id) }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("juno.mobile.search-recents")
        }
    }

    // MARK: - Kinds

    private func sectionTitle(_ kind: NativeSearchResultKind) -> String {
        switch kind {
        case .conversation: "Chats"
        case .message: "Messages"
        case .project: "Projects"
        case .file: "Files"
        case .artifact: "Artifacts"
        case .memory: "Memory"
        }
    }
}
