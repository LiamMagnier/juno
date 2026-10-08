import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI
import UniformTypeIdentifiers
#if DEBUG
import JunoPreviewSupport
#endif

/// A file the download route answered, for `.fileExporter`.
struct JunoMobileArtifactDownloadFile {
    let document: JunoMobileArtifactDownloadDocument
    let name: String
}

struct JunoMobileArtifactDownloadDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }

    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration _: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

// MARK: - Version history

/// Every saved version, newest first, fifty at a time — the web's "Version
/// history…". A version held on the phone opens in place; any version can be
/// restored as a new one or copied into a new artifact.
struct JunoMobileArtifactHistory: View {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    let artifact: NativeArtifact
    let show: (Int) -> Void
    let copied: () -> Void
    let done: () -> Void

    @State private var history: NativeArtifactHistory?
    @State private var restoring: Int?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Group {
                if let history {
                    switch history.phase {
                    case .idle, .loading:
                        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    case .failed:
                        ContentUnavailableView(
                            "History unavailable",
                            systemImage: "clock.arrow.circlepath",
                            description: Text(history.errorDescription ?? "Check your connection and try again.")
                        )
                    case .ready:
                        list(history)
                    }
                } else {
                    ContentUnavailableView("History unavailable", systemImage: "clock.arrow.circlepath")
                }
            }
            .navigationTitle("Version history")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: done).contentShape(.rect)
                }
            }
            .confirmationDialog(
                "Restore version \(restoring ?? 0)?",
                isPresented: Binding(get: { restoring != nil }, set: { if !$0 { restoring = nil } }),
                titleVisibility: .visible
            ) {
                Button("Restore version \(restoring ?? 0)") {
                    guard let version = restoring else { return }
                    Task {
                        if await model.restoreVersion(id: artifact.id, version: version) {
                            await history?.load()
                        } else {
                            failure = model.lastErrorDescription ?? "Couldn’t restore that version."
                        }
                    }
                }
                .contentShape(.rect)
                Button("Cancel", role: .cancel) {}.contentShape(.rect)
            } message: {
                Text("This makes a new version from it. The later versions stay in history.")
            }
            .alert(
                "Something went wrong",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
            ) {
                Button("OK") { failure = nil }.contentShape(.rect)
            } message: {
                Text(failure ?? "")
            }
        }
        .task {
            let history = model.history(for: artifact.id)
            self.history = history
            await history?.load()
        }
    }

    private func list(_ history: NativeArtifactHistory) -> some View {
        List {
            Section {
                ForEach(history.entries) { entry in
                    let local = artifact.versions.contains { $0.version == entry.version }
                    Button {
                        guard local else { return }
                        show(entry.version)
                        done()
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.version == artifact.currentVersion
                                 ? "Version \(entry.version) — Current" : "Version \(entry.version)")
                                .foregroundStyle(.primary)
                            Text(subtitle(entry, local: local))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(.rect)
                    }
                    .contextMenu {
                        if entry.version < artifact.currentVersion {
                            Button("Restore version \(entry.version)") { restoring = entry.version }
                        }
                        Button("Make a copy") { copy(entry.version) }
                    }
                    .swipeActions(edge: .trailing) {
                        if entry.version < artifact.currentVersion {
                            Button("Restore") { restoring = entry.version }
                        }
                    }
                }
                if history.hasMore {
                    Button(history.isLoadingMore ? "Loading…" : "Older versions") {
                        Task { await history.loadMore() }
                    }
                    .disabled(history.isLoadingMore)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
            } footer: {
                Text("Touch and hold a version to restore it or make a copy.")
            }
        }
        .listStyle(.insetGrouped)
    }

    private func subtitle(_ entry: NativeArtifactVersionSummary, local: Bool) -> String {
        let origin: String = switch entry.origin {
        case .generated?: "Generated"
        case .edit?: "Edited"
        case .restore?: "Restored"
        case nil: "Saved"
        }
        var parts = [origin, entry.createdAt.formatted(date: .abbreviated, time: .shortened)]
        if !local { parts.append("Not on this iPhone") }
        return parts.joined(separator: " · ")
    }

    private func copy(_ version: Int) {
        Task {
            if await model.duplicateArtifact(id: artifact.id, version: version) != nil {
                done()
                copied()
            } else {
                failure = model.lastErrorDescription ?? "Couldn’t make a copy."
            }
        }
    }
}

// MARK: - Recently deleted

/// Deleted artifacts, kept for 30 days, each restorable.
struct JunoMobileRecentlyDeletedArtifacts: View {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    let done: () -> Void

    @State private var trash: NativeRecentlyDeletedArtifacts?

    var body: some View {
        NavigationStack {
            Group {
                if let trash {
                    switch trash.phase {
                    case .idle, .loading:
                        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    case .failed:
                        ContentUnavailableView(
                            "Recently Deleted unavailable",
                            systemImage: "trash",
                            description: Text(trash.errorDescription ?? "Check your connection and try again.")
                        )
                    case .ready where trash.items.isEmpty:
                        ContentUnavailableView(
                            "Nothing recently deleted",
                            systemImage: "trash",
                            description: Text("Deleted artifacts stay here for 30 days.")
                        )
                    case .ready:
                        list(trash)
                    }
                } else {
                    ContentUnavailableView("Recently Deleted unavailable", systemImage: "trash")
                }
            }
            .navigationTitle("Recently Deleted")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: done).contentShape(.rect)
                }
            }
        }
        .task {
            // Opened straight after launch, the account may still be starting:
            // wait a moment for it rather than declaring the list unavailable.
            var trash = model.recentlyDeleted()
            var waited = 0
            while trash == nil, waited < 50, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                waited += 1
                trash = model.recentlyDeleted()
            }
            self.trash = trash
            await trash?.load()
        }
    }

    private func list(_ trash: NativeRecentlyDeletedArtifacts) -> some View {
        List {
            Section {
                ForEach(trash.items) { item in
                    HStack(spacing: JunoSpace.cozy) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title.isEmpty ? "Untitled artifact" : item.title)
                                .font(.body)
                                .lineLimit(1)
                            Text(subtitle(item))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: JunoSpace.cozy)
                        if trash.restoring.contains(item.id) {
                            Text("Restoring…")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        } else {
                            Button("Restore") { Task { await trash.restore(id: item.id) } }
                                .buttonStyle(.borderless)
                                .frame(minHeight: 44)
                        }
                    }
                }
            } footer: {
                if let error = trash.errorDescription {
                    Text(error).foregroundStyle(Color.junoDestructiveInk)
                } else {
                    Text("Restoring an artifact brings back its versions and its links.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await trash.load() }
    }

    private func subtitle(_ item: NativeDeletedArtifact) -> String {
        let kind: String = switch item.kind {
        case .spreadsheet?: "Spreadsheet"
        case .document?: "Document"
        case .presentation?: "Deck"
        case .design?: "Design"
        case .html?: "Page"
        case .react?: "Component"
        case .markdown?: "Markdown"
        case .svg?: "Vector"
        case .mermaid?: "Diagram"
        case .code?: "Code"
        case nil: item.type.capitalized
        }
        var parts = [kind]
        // What the reader needs to know about something in the bin: how long
        // it has left. `purgeAt` is when it goes for good.
        if let purgeAt = item.purgeAt, purgeAt > .now {
            let days = max(1, Calendar.current.dateComponents([.day], from: .now, to: purgeAt).day ?? 1)
            parts.append(days == 1 ? "1 day left" : "\(days) days left")
        } else if let deletedAt = item.deletedAt {
            parts.append("Deleted \(JunoMobileRelativeDate.text(deletedAt))")
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Preview hooks

/// `--juno-preview-artifact <id>` opens a stored artifact over the list and
/// `--juno-preview-artifacts-deleted` opens Recently Deleted, so the preview
/// world can be photographed without a tap. Inert outside DEBUG previews.
struct JunoMobileArtifactsPreviewHooks: ViewModifier {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    @Binding var showingDeleted: Bool

    private struct Opened: Identifiable { let id: String }
    @State private var opened: Opened?

    func body(content: Content) -> some View {
        content
            .sheet(item: $opened) { item in
                if let artifact = model.artifacts.first(where: { $0.id == item.id }) {
                    JunoMobileArtifactDetail(
                        model: model, artifact: artifact, openConversation: { _ in }, close: { opened = nil }
                    )
                }
            }
            .task {
                #if DEBUG
                guard JunoPreviewEnvironment.isActive else { return }
                if JunoPreviewEnvironment.showsRecentlyDeletedArtifacts { showingDeleted = true }
                if let id = JunoPreviewEnvironment.initialArtifact { opened = Opened(id: id) }
                #endif
            }
    }
}
