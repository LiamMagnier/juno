import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// One artifact's own page — the web's `/a/{id}` (Phase 4 A6, register #53).
///
/// **A design at its latest version is the design editor**, hosted by
/// ``DesktopDesignSurface``, with Discard, Save and Delete Design above it —
/// what the retired Design page did, now where the web keeps it.
///
/// **Everything else, and a design's older versions, is read-only**: a top
/// row in content (the title, the version pager ‹ v2 of 3 › with "Back to
/// latest" when you are behind — the page's signature — Open in Chat and
/// More), then the artifact itself. The web's window is read-only and "the
/// chat is where it is changed", so Open in Chat is the way to edit.
struct ArtifactPage: View {
    let artifactID: String
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    /// The version the route asked for; nil is the latest.
    var requestedVersion: Int?

    @Environment(\.junoToast) private var toast
    @Environment(\.dismiss) private var dismiss
    @Environment(\.desktopPush) private var push

    @State private var version: Int?
    @State private var comparing = false
    @State private var download: DesktopArtifactFile?
    @State private var draft: String?
    @State private var reloadToken = UUID()
    @State private var confirmation: JunoConfirmation?
    @State private var showingHistory = false

    private var artifact: NativeArtifact? { model.artifacts.first { $0.id == artifactID } }

    var body: some View {
        Group {
            if let artifact {
                let shown = version ?? artifact.currentVersion
                if artifact.kind.isDesignDocument, shown == artifact.currentVersion {
                    designEditor(artifact)
                } else {
                    readOnly(artifact, shown: shown)
                }
            } else {
                JunoEmptyState(
                    title: "Artifact not found",
                    message: "It may have been deleted on another device.",
                    icon: .artifacts
                )
            }
        }
        .navigationTitle(artifact?.title ?? "Artifact")
        .junoConfirmation($confirmation)
        .sheet(isPresented: $showingHistory) {
            if let artifact { historySheet(artifact) }
        }
        .fileExporter(
            isPresented: Binding(get: { download != nil }, set: { if !$0 { download = nil } }),
            document: download?.document,
            contentType: .data,
            defaultFilename: download?.name
        ) { result in
            if case .failure = result { toast(.error("Couldn’t download the source.")) }
            download = nil
        }
        .task(id: artifactID) {
            version = requestedVersion
            await model.openArtifact(id: artifactID)
        }
    }

    // MARK: - Read-only window

    private func readOnly(_ artifact: NativeArtifact, shown: Int) -> some View {
        VStack(spacing: 0) {
            ArtifactPageTopRow(
                artifact: artifact,
                version: shown,
                select: { version = $0 == artifact.currentVersion ? nil : $0 },
                openInChat: { DesktopPageRouter.shared.openArtifactInConversation(artifact) },
                more: { more(artifact, shown: shown) }
            )
            Rectangle()
                .fill(Color.junoBorder)
                .frame(height: 1)
                .accessibilityHidden(true)
            ArtifactPageBody(artifact: artifact, version: shown)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .sheet(isPresented: $comparing) {
            ArtifactCompareSheet(artifact: artifact, target: shown) { comparing = false }
        }
    }

    /// Version History…, shared by the read-only window and the design editor.
    private func historySheet(_ artifact: NativeArtifact) -> some View {
        ArtifactHistorySheet(
            artifact: artifact,
            model: model,
            show: { version = $0 == artifact.currentVersion ? nil : $0 },
            duplicated: { push(.artifact($0, version: nil)) },
            done: { showingHistory = false }
        )
    }

    @ViewBuilder
    private func more(_ artifact: NativeArtifact, shown: Int) -> some View {
        Button("Version History…") { showingHistory = true }
            .contentShape(.rect)
        if shown < artifact.currentVersion {
            Button("Restore Version \(shown)…") { confirmRestore(artifact, version: shown) }
                .contentShape(.rect)
        }
        Button("Make a Copy") { makeCopy(artifact, version: shown) }
            .contentShape(.rect)
        Divider()
        Button("Download This Version…") { serverDownload(artifact, version: shown, format: .file) }
            .contentShape(.rect)
        Button("Download with History…") { serverDownload(artifact, version: shown, format: .zipWithHistory) }
            .contentShape(.rect)
        Button("Copy Source") { copySource(artifact, version: shown) }
            .contentShape(.rect)
        Button("Open in New Window") { openInWindow(artifact, version: shown) }
            .contentShape(.rect)
        if artifact.versions.count > 1 {
            Button("Compare Versions…") { comparing = true }
                .contentShape(.rect)
        }
        Divider()
        Button("Move to Recently Deleted…", role: .destructive) {
            confirmation = DesktopArtifactActions.delete(artifact, model: model, toast: toast) { dismiss() }
        }
        .contentShape(.rect)
    }

    private func confirmRestore(_ artifact: NativeArtifact, version: Int) {
        confirmation = JunoConfirmation(
            title: "Restore version \(version)?",
            message: "This makes a new version from the one you are viewing. The later versions stay in history.",
            confirmTitle: "Restore Version \(version)",
            role: nil
        ) {
            Task {
                if await model.restoreVersion(id: artifact.id, version: version) {
                    self.version = nil
                    toast(.success("Restored version \(version) as a new version."))
                } else {
                    toast(.error(model.lastErrorDescription ?? "Couldn’t restore that version."))
                }
            }
        }
    }

    private func makeCopy(_ artifact: NativeArtifact, version: Int?) {
        DesktopArtifactLifecycle.duplicate(artifact, version: version, model: model, toast: toast) { id in
            push(.artifact(id, version: nil))
        }
    }

    private func serverDownload(_ artifact: NativeArtifact, version: Int, format: NativeArtifactDownloadFormat) {
        DesktopArtifactLifecycle.download(
            artifact, version: version, format: format, model: model, toast: toast
        ) { download = $0 }
    }

    // MARK: - Design editor

    private func designEditor(_ artifact: NativeArtifact) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    Text(artifact.title.isEmpty ? "Untitled design" : artifact.title)
                        .junoType(.ui)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                    Text(editorSubtitle(artifact))
                        .junoType(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
                Spacer(minLength: JunoSpace.cozy)
                if artifact.versions.count > 1 {
                    ArtifactVersionPager(
                        version: artifact.currentVersion,
                        count: artifact.currentVersion,
                        select: { version = $0 == artifact.currentVersion ? nil : $0 }
                    )
                }
                Button("Discard") {
                    draft = nil
                    reloadToken = UUID()
                }
                    .contentShape(.rect)
                .buttonStyle(.junoGlass)
                .tint(nil)
                .disabled(draft == nil)
                .help("Throw away every change since the last save")
                Button("Save") { Task { await save(artifact) } }
                    .contentShape(.rect)
                    .buttonStyle(.junoProminent)
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(draft == nil || model.isMutating)
                    .help("Save your edit as a new version (⌘S)")
                Menu {
                    Button("Open in Conversation") { DesktopPageRouter.shared.openArtifactInConversation(artifact) }
                    Button("Version History…") { showingHistory = true }
                    Button("Make a Copy") { makeCopy(artifact, version: nil) }
                    Button("Download Source…") { downloadSource(artifact, version: artifact.currentVersion) }
                    Button("Download with History…") {
                        serverDownload(artifact, version: artifact.currentVersion, format: .zipWithHistory)
                    }
                    Divider()
                    Button("Move to Recently Deleted…", role: .destructive) {
                        confirmation = DesktopArtifactActions.delete(artifact, model: model, toast: toast) { dismiss() }
                    }
                } label: {
                    JunoIconView(.ellipsis, size: 16)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(width: 28, height: 28)
                        .contentShape(.rect)
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .frame(width: 28, height: 28)
                .help("Design actions")
                .accessibilityLabel("Design actions")
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.snug)
            Rectangle()
                .fill(Color.junoBorder)
                .frame(height: 1)
                .accessibilityHidden(true)
            DesktopDesignSurface(
                content: draft ?? artifact.currentContent ?? "",
                readOnly: false,
                onEdit: { draft = $0 }
            )
            // Keyed on the design and the discard token only: a save bumps the
            // version, and reloading then would throw away pan, zoom and
            // selection.
            .id("\(artifact.id)#\(reloadToken)")
        }
    }

    private func editorSubtitle(_ artifact: NativeArtifact) -> String {
        var parts: [String] = []
        if artifact.currentVersion > 1 { parts.append("v\(artifact.currentVersion)") }
        parts.append("Updated \(DesktopRelativeTime.short(artifact.updatedAt))")
        if draft != nil { parts.append("Unsaved changes") }
        return parts.joined(separator: " · ")
    }

    private func save(_ artifact: NativeArtifact) async {
        guard let draft else { return }
        await model.saveArtifact(id: artifact.id, content: draft)
        if model.lastErrorDescription == nil {
            self.draft = nil
        } else {
            toast(.error("Couldn’t save the design."))
        }
    }

    // MARK: - Actions

    private func content(_ artifact: NativeArtifact, version: Int) -> String? {
        artifact.versions.first { $0.version == version }?.content
    }

    private func downloadSource(_ artifact: NativeArtifact, version: Int) {
        guard let content = content(artifact, version: version) else {
            toast(.error("Couldn’t download the source."))
            return
        }
        download = DesktopArtifactFile(
            document: DesktopArtifactDocument(data: Data(content.utf8)),
            name: DesktopArtifactKinds.downloadName(artifact)
        )
    }

    private func copySource(_ artifact: NativeArtifact, version: Int) {
        guard let content = content(artifact, version: version) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(content, forType: .string)
    }

    private func openInWindow(_ artifact: NativeArtifact, version: Int) {
        guard let content = content(artifact, version: version) else { return }
        DesktopArtifactWindows.shared.present(
            title: artifact.title,
            subtitle: "\(DesktopArtifactKindName.singular(artifact.kind)) · v\(version)",
            kind: artifact.kind,
            content: content,
            mode: DesktopArtifactViewMode.available(for: artifact.kind).first ?? .source
        )
    }
}

// MARK: - The top row

/// The read-only window's row, in content rather than the toolbar: the
/// title, the version pager, Open in Chat and More.
struct ArtifactPageTopRow<More: View>: View {
    let artifact: NativeArtifact
    let version: Int
    let select: (Int) -> Void
    let openInChat: () -> Void
    @ViewBuilder let more: () -> More

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            Text(artifact.title.isEmpty ? "Untitled artifact" : artifact.title)
                .junoType(.ui)
                .fontWeight(.semibold)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(1)
                .help("\(DesktopArtifactKindName.singular(artifact.kind)) · \(artifact.title)")
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: JunoSpace.cozy)
            if artifact.currentVersion > 1 {
                ArtifactVersionPager(version: version, count: artifact.currentVersion, select: select)
            }
            Button("Open in Chat", action: openInChat)
                .contentShape(.rect)
                .buttonStyle(.junoGlass)
                .tint(nil)
                .help("Open in the conversation it was made in")
            Menu {
                more()
            } label: {
                JunoIconView(.ellipsis, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 28, height: 28)
                    .contentShape(.rect)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .frame(width: 28, height: 28)
            .help("More actions")
            .accessibilityLabel("More actions")
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
    }
}

/// ‹ v2 of 3 ›, with "Back to latest" when the reader is behind — the
/// artifact page's signature. The count is a bare number, so it is mono.
struct ArtifactVersionPager: View {
    let version: Int
    let count: Int
    let select: (Int) -> Void

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            if version < count {
                Button("Back to latest") { select(count) }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.junoAccentInk)
                    .junoType(.ui)
                    .contentShape(.rect)
                    .padding(.trailing, JunoSpace.tight)
            }
            arrow(.chevronLeft, "Previous version", enabled: version > 1) { select(version - 1) }
            Text("v\(version) of \(count)")
                .junoCodeSmall()
                .monospacedDigit()
                .foregroundStyle(Color.junoForeground)
                .accessibilityLabel("Version \(version) of \(count)")
            arrow(.chevronRight, "Next version", enabled: version < count) { select(version + 1) }
        }
    }

    private func arrow(_ icon: JunoIcon, _ label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            JunoIconView(icon, size: 14)
                .foregroundStyle(enabled ? Color.junoForeground : Color.junoSecondaryInk.opacity(0.5))
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .strokeBorder(Color.junoBorder, lineWidth: 1)
                )
                .frame(minWidth: 28, minHeight: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .disabled(!enabled)
        .help(label)
        .accessibilityLabel(label)
    }
}

// MARK: - The body

/// The artifact itself: pages and components through the closed sandbox
/// (register #21), Markdown in the reading prose, an older design as its
/// poster, and source where nothing runs.
struct ArtifactPageBody: View {
    let artifact: NativeArtifact
    let version: Int

    private var content: String? {
        artifact.versions.first { $0.version == version }?.content
    }

    var body: some View {
        Group {
            if artifact.kind.isDesignDocument {
                ArtifactOlderDesign(artifactID: artifact.id, version: version, isCurrent: version == artifact.currentVersion)
            } else if let content {
                if artifact.kind.isSemantic {
                    SemanticArtifactView(kind: artifact.kind, content: content)
                        .id("\(artifact.id)#\(version)")
                } else if artifact.kind == .markdown {
                    ScrollView {
                        JunoMarkdownText(content)
                            .environment(\.junoProseStyle, .reading)
                            .frame(maxWidth: JunoReadingMeasure.reading, alignment: .leading)
                            .padding(JunoSpace.section)
                            .frame(maxWidth: .infinity)
                    }
                } else if artifact.kind.supportsRenderedPreview {
                    NativeArtifactPreview(
                        kind: artifact.kind,
                        content: content,
                        mode: .preview,
                        policy: .inline,
                        language: artifact.language
                    )
                    .id("\(artifact.id)#\(version)")
                } else {
                    ScrollView {
                        Text(content)
                            .junoMono()
                            .foregroundStyle(Color.junoForeground)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(JunoSpace.section)
                    }
                }
            } else {
                JunoEmptyState(
                    title: "Version unavailable",
                    message: "Reconnect to load this version’s content.",
                    icon: .history
                )
            }
        }
    }
}

/// An older design version, drawn from its poster on a desk; the web's
/// sentence when it cannot be drawn.
struct ArtifactOlderDesign: View {
    let artifactID: String
    let version: Int
    let isCurrent: Bool

    @Environment(\.junoDesignPreviews) private var previews

    private var state: NativeDesignPreviewState {
        previews?.designPreviewState(artifactID: artifactID, version: version) ?? .failed
    }

    var body: some View {
        ZStack {
            Color.junoSecondary.opacity(0.5)
            switch state {
            case .ready(let svg):
                if let image = NSImage(data: Data(svg.utf8)) {
                    Image(nsImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                        .padding(JunoSpace.vast)
                } else {
                    cannotDraw
                }
            case .loading:
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Preparing design")
            case .unavailable, .failed:
                cannotDraw
            }
        }
        .task(id: "\(artifactID)#\(version)") {
            await previews?.loadDesignPreview(artifactID: artifactID, version: version, isCurrent: isCurrent)
        }
    }

    private var cannotDraw: some View {
        JunoEmptyState(
            title: "This version can’t be drawn here. Its document is unchanged.",
            icon: .design,
            size: .panel
        )
        .frame(maxWidth: 420)
    }
}

// MARK: - Compare

/// Compare Versions…: the existing line diff, between the version before and
/// the one on screen.
struct ArtifactCompareSheet: View {
    let artifact: NativeArtifact
    let target: Int
    let done: () -> Void

    @State private var base: Int
    @State private var lines: [DesktopArtifactDiffLine] = []
    @State private var computing = true

    init(artifact: NativeArtifact, target: Int, done: @escaping () -> Void) {
        self.artifact = artifact
        self.target = target
        self.done = done
        _base = State(initialValue: max(1, target - 1))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack {
                Text("Compare Versions")
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Picker("Compare with", selection: $base) {
                    ForEach(artifact.versions.map(\.version).filter { $0 != target }.sorted(by: >), id: \.self) { value in
                        Text("v\(value)").tag(value)
                    }
                }
                .fixedSize()
                .tint(nil)
            }
            DesktopArtifactDiffCanvas(lines: lines, computing: computing, baseVersion: base, targetVersion: target)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack {
                Spacer()
                Button("Done", action: done)
                    .contentShape(.rect)
                    .tint(nil)
                    .keyboardShortcut(.cancelAction)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 760, height: 560)
        .task(id: base) {
            computing = true
            let from = artifact.versions.first { $0.version == base }?.content ?? ""
            let to = artifact.versions.first { $0.version == target }?.content ?? ""
            lines = DesktopArtifactDiff.lines(from: from, to: to)
            computing = false
        }
    }
}
