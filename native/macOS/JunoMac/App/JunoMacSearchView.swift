import JunoChatKit
import JunoStorage
import SwiftUI

/// Global offline search across the synchronized encrypted account data.
struct JunoMacSearchView: View {
    @Bindable var model: NativeSearchModel<SQLiteAccountRepository>
    let open: (NativeSearchResult) -> Void
    @FocusState private var searchFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    TextField(
                        "Search chats, messages, projects, files, artifacts and memory",
                        text: Binding(
                            get: { model.query },
                            set: { model.setQuery($0) }
                        )
                    )
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .focused($searchFocused)
                    .accessibilityIdentifier("juno.mac.search-field")
                    if model.phase == .searching {
                        ProgressView().controlSize(.small)
                    } else if !model.query.isEmpty {
                        Button {
                            model.setQuery("", debounced: false)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear search")
                    }
                }
                .padding(14)
                Divider()
                content
            }
            .navigationTitle("Search")
            .onAppear { searchFocused = true }
        }
        .accessibilityIdentifier("juno.mac.search")
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle:
            ContentUnavailableView(
                "Search Juno",
                systemImage: "magnifyingglass",
                description: Text("Everything synced to this Mac is searchable offline.")
            )
        case .searching where model.results.isEmpty:
            VStack {
                Spacer()
                ProgressView("Searching…")
                Spacer()
            }
        case .failed:
            ContentUnavailableView {
                Label("Search unavailable", systemImage: "exclamationmark.triangle")
            } description: {
                Text(model.lastErrorDescription ?? "Try again.")
            } actions: {
                Button("Retry") { model.setQuery(model.query, debounced: false) }
            }
        case .ready where model.results.isEmpty:
            ContentUnavailableView(
                "No results",
                systemImage: "magnifyingglass",
                description: Text("Nothing matches “\(model.query)”.")
            )
        default:
            resultsList
        }
    }

    private var resultsList: some View {
        List {
            ForEach(model.groupedResults, id: \.kind) { group in
                Section(sectionTitle(group.kind)) {
                    ForEach(group.results) { result in
                        Button {
                            open(result)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: icon(result.kind))
                                    .frame(width: 24)
                                    .foregroundStyle(.secondary)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(result.title).lineLimit(1)
                                    if !result.snippet.isEmpty,
                                        result.snippet != result.title
                                    {
                                        Text(result.snippet)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                    }
                                }
                                Spacer()
                                Text(result.updatedAt, style: .relative)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens \(sectionTitle(result.kind).lowercased())")
                    }
                }
            }
        }
        .accessibilityIdentifier("juno.mac.search-results")
    }

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

    private func icon(_ kind: NativeSearchResultKind) -> String {
        switch kind {
        case .conversation: "bubble.left.and.bubble.right"
        case .message: "text.bubble"
        case .project: "folder"
        case .file: "doc"
        case .artifact: "square.stack.3d.up"
        case .memory: "brain.head.profile"
        }
    }
}
