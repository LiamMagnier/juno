import Foundation
import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

// MARK: - Version history

/// Version History… — the web's paged history dialog
/// (`artifact-lifecycle-actions.tsx`): every saved version, newest first,
/// fifty at a time, each one showable on the page, restorable and copyable.
struct ArtifactHistorySheet: View {
    let artifact: NativeArtifact
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    /// Shows a version that is held locally on the page.
    let show: (Int) -> Void
    let duplicated: (String) -> Void
    let done: () -> Void

    @Environment(\.junoToast) private var toast
    @State private var history: NativeArtifactHistory?
    @State private var confirmation: JunoConfirmation?

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Version History")
                    .junoType(.heading)
                    .accessibilityAddTraits(.isHeader)
                Text("Every saved version of “\(artifact.title)”.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Group {
                if let history {
                    switch history.phase {
                    case .idle, .loading:
                        ProgressView()
                            .controlSize(.small)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    case .failed:
                        JunoEmptyState(
                            title: "History unavailable",
                            message: history.errorDescription ?? "Check your connection and try again.",
                            icon: .history,
                            size: .panel
                        )
                    case .ready:
                        list(history)
                    }
                } else {
                    JunoEmptyState(title: "Sign in to see history", icon: .history, size: .panel)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack {
                if let message = history?.errorDescription, history?.phase == .ready {
                    Text(message)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoDestructiveInk)
                }
                Spacer()
                Button("Done", action: done)
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 520, height: 520)
        .junoConfirmation($confirmation)
        .task {
            let history = model.history(for: artifact.id)
            self.history = history
            await history?.load()
        }
    }

    private func list(_ history: NativeArtifactHistory) -> some View {
        List {
            ForEach(history.entries) { entry in
                HStack(spacing: JunoSpace.cozy) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.version == artifact.currentVersion ? "Version \(entry.version) — Current" : "Version \(entry.version)")
                            .junoType(.ui)
                            .monospacedDigit()
                        Text(subtitle(entry))
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                    Spacer(minLength: JunoSpace.cozy)
                    if artifact.versions.contains(where: { $0.version == entry.version }) {
                        Button("Show") {
                            show(entry.version)
                            done()
                        }
                        .buttonStyle(.borderless)
                        .contentShape(.rect)
                    }
                    Menu {
                        if entry.version < artifact.currentVersion {
                            Button("Restore Version \(entry.version)…") { confirmRestore(entry.version) }
                        }
                        Button("Make a Copy of Version \(entry.version)") { copy(entry.version) }
                    } label: {
                        JunoIconView(.ellipsis, size: 14)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .frame(width: 28, height: 28)
                            .contentShape(.rect)
                    }
                    .menuStyle(.button)
                    .buttonStyle(.plain)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("Version actions")
                    .accessibilityLabel("Actions for version \(entry.version)")
                }
                .padding(.vertical, JunoSpace.hairline)
            }
            if history.hasMore {
                Button(history.isLoadingMore ? "Loading…" : "Older Versions") {
                    Task { await history.loadMore() }
                }
                .disabled(history.isLoadingMore)
                .buttonStyle(.borderless)
                .contentShape(.rect)
            }
        }
        .listStyle(.inset)
    }

    private func subtitle(_ entry: NativeArtifactVersionSummary) -> String {
        let origin = entry.origin.map(DesktopArtifactKindName.origin) ?? "Saved"
        return "\(origin) · \(entry.createdAt.formatted(date: .abbreviated, time: .shortened))"
    }

    private func confirmRestore(_ version: Int) {
        confirmation = JunoConfirmation(
            title: "Restore version \(version)?",
            message: "This makes a new version from version \(version). The later versions stay in history.",
            confirmTitle: "Restore Version \(version)",
            role: nil
        ) {
            Task {
                if await model.restoreVersion(id: artifact.id, version: version) {
                    toast(.success("Restored version \(version) as a new version."))
                    await history?.load()
                } else {
                    toast(.error(model.lastErrorDescription ?? "Couldn’t restore that version."))
                }
            }
        }
    }

    private func copy(_ version: Int) {
        Task {
            if let id = await model.duplicateArtifact(id: artifact.id, version: version) {
                toast(.success("Copy made."))
                done()
                duplicated(id)
            } else {
                toast(.error(model.lastErrorDescription ?? "Couldn’t make a copy."))
            }
        }
    }
}

// MARK: - Recently deleted

/// Recently deleted artifacts, newest deletion first, each with the day it
/// is removed for good and a Restore — the Library's trash for made things.
struct DesktopRecentlyDeletedArtifactsSheet: View {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    let done: () -> Void

    @Environment(\.junoToast) private var toast
    @State private var trash: NativeRecentlyDeletedArtifacts?

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Recently Deleted")
                    .junoType(.heading)
                    .accessibilityAddTraits(.isHeader)
                Text("Deleted artifacts stay here for 30 days. Restoring one brings back its versions and its links.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Group {
                if let trash {
                    switch trash.phase {
                    case .idle, .loading:
                        ProgressView()
                            .controlSize(.small)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    case .failed:
                        JunoEmptyState(
                            title: "Recently deleted unavailable",
                            message: trash.errorDescription ?? "Check your connection and try again.",
                            icon: .trash,
                            size: .panel
                        )
                    case .ready where trash.items.isEmpty:
                        JunoEmptyState(title: "Nothing recently deleted", icon: .trash, size: .panel)
                    case .ready:
                        list(trash)
                    }
                } else {
                    JunoEmptyState(title: "Sign in to see deleted artifacts", icon: .trash, size: .panel)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack {
                Spacer()
                Button("Done", action: done)
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 560, height: 520)
        .task {
            let trash = model.recentlyDeleted()
            self.trash = trash
            await trash?.load()
        }
    }

    private func list(_ trash: NativeRecentlyDeletedArtifacts) -> some View {
        List(trash.items) { item in
            HStack(spacing: JunoSpace.cozy) {
                JunoIconView(item.kind.map(DesktopArtifactKinds.icon) ?? .fileCode, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title.isEmpty ? "Untitled artifact" : item.title)
                        .junoType(.ui)
                        .lineLimit(1)
                    Text(subtitle(item))
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
                Spacer(minLength: JunoSpace.cozy)
                if trash.restoring.contains(item.id) {
                    Text("Restoring…")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                } else {
                    Button("Restore") { restore(item, in: trash) }
                        .buttonStyle(.bordered)
                        .tint(nil)
                        .contentShape(.rect)
                }
            }
            .padding(.vertical, JunoSpace.hairline)
        }
        .listStyle(.inset)
    }

    private func subtitle(_ item: NativeDeletedArtifact) -> String {
        var parts = [item.kind.map(DesktopArtifactKindName.singular) ?? item.type.capitalized]
        if let deletedAt = item.deletedAt {
            parts.append("Deleted \(DesktopRelativeTime.short(deletedAt))")
        }
        if let purgeAt = item.purgeAt {
            parts.append("Removed \(purgeAt.formatted(date: .abbreviated, time: .omitted))")
        }
        return parts.joined(separator: " · ")
    }

    private func restore(_ item: NativeDeletedArtifact, in trash: NativeRecentlyDeletedArtifacts) {
        Task {
            if await trash.restore(id: item.id) {
                toast(.success("“\(item.title)” restored."))
            } else {
                toast(.error(trash.errorDescription ?? "Couldn’t restore the artifact."))
            }
        }
    }
}

// MARK: - Download and copy

/// The server-backed Download and Make a Copy, shared by the Artifacts list
/// and an artifact's page.
@MainActor
enum DesktopArtifactLifecycle {
    /// Fetches the file the download route answers and hands it to the
    /// page's `.fileExporter`.
    static func download(
        _ artifact: NativeArtifact,
        version: Int?,
        format: NativeArtifactDownloadFormat,
        model: NativeArtifactModel<SQLiteAccountRepository>,
        toast: JunoToastNotifier,
        deliver: @escaping @MainActor (DesktopArtifactFile) -> Void
    ) {
        Task {
            guard let file = await model.downloadArtifact(id: artifact.id, version: version, format: format) else {
                toast(.error(model.lastErrorDescription ?? "Couldn’t download the artifact."))
                return
            }
            deliver(DesktopArtifactFile(document: DesktopArtifactDocument(data: file.data), name: file.fileName))
        }
    }

    static func duplicate(
        _ artifact: NativeArtifact,
        version: Int?,
        model: NativeArtifactModel<SQLiteAccountRepository>,
        toast: JunoToastNotifier,
        opened: @escaping @MainActor (String) -> Void
    ) {
        Task {
            if let id = await model.duplicateArtifact(id: artifact.id, version: version) {
                toast(.success("Copy made."))
                opened(id)
            } else {
                toast(.error(model.lastErrorDescription ?? "Couldn’t make a copy."))
            }
        }
    }
}
