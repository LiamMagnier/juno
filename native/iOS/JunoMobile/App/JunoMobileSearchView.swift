import JunoChatKit
import JunoStorage
import SwiftUI

/// Global offline search across the synchronized encrypted account data.
struct JunoMobileSearchView: View {
    @Bindable var model: NativeSearchModel<SQLiteAccountRepository>
    let open: (NativeSearchResult) -> Void

    var body: some View {
        content
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: Binding(
                    get: { model.query },
                    set: { model.setQuery($0) }
                ),
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Chats, messages, projects, files…"
            )
            .accessibilityIdentifier("juno.mobile.search")
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle:
            ContentUnavailableView(
                "Search Juno",
                systemImage: "magnifyingglass",
                description: Text("Everything synced to this device is searchable offline.")
            )
        case .searching where model.results.isEmpty:
            ProgressView("Searching…")
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
                                        Text(result.title)
                                            .lineLimit(1)
                                            .foregroundStyle(.primary)
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
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .accessibilityHint("Opens \(sectionTitle(result.kind).lowercased())")
                        }
                    }
                }
            }
            .accessibilityIdentifier("juno.mobile.search-results")
        }
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
