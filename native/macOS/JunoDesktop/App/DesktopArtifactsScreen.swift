import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UniformTypeIdentifiers

/// **Artifacts** — the web's `/artifacts` on the page template (Phase 4 A6).
///
/// "Artifacts", its lede, the count and New ▾; the controls row (search, the
/// type chips, List / Grid); then the rows or the tiles. A row opens the
/// artifact's **own page** on this destination's stack, as the web's `/a/{id}`
/// does (register #53); "Open in Conversation" is the chat with the canvas
/// open on that row. With the Designs filter on, the four sizes are pinned as
/// buttons above the list — each draws its own frame, and its plus hands over
/// to the design mark while that design is being made: the page's signature.
struct DesktopArtifactsScreen: View {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    var accountID: AccountID?
    var requestSender: (any NativeAuthenticatedRequestSending)?
    var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    /// Share… (Phase 3's share popover content, in a sheet). The menu item is
    /// hidden while this is nil.
    var shareArtifact: ((NativeArtifact) -> Void)?
    /// A new chat, for "Start building" and "Ask Juno in a New Chat".
    var newChat: (() -> Void)?
    /// The filter and view the page opens on (the snapshot harness's);
    /// otherwise the ones the window remembers, or a router request's.
    var initialFilter: String?
    var initialView: String?
    var initialQuery: String?
    var offline = false

    @Environment(\.desktopPush) private var push
    @Environment(\.junoToast) private var toast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var query = ""
    /// `ALL` or a type (`DESIGN`); remembered per window as the web keeps it
    /// in the URL. A filter whose chip has gone reads as All but is kept.
    @SceneStorage("juno.desktop.artifacts.type") private var sceneFilter = DesktopArtifactsFilter.all
    /// The filter this page is showing; seeded from the scene's, written
    /// back to it. Held as state too, because a view outside a scene (the
    /// snapshot harness) has no scene storage to write to.
    @State private var chosenFilter: String?
    @AppStorage("juno.desktop.artifacts.view") private var storedView = "list"
    @State private var creating: DesktopDesignPreset?
    @State private var renaming: JunoRenameRequest?
    @State private var confirmation: JunoConfirmation?
    @State private var download: DesktopArtifactFile?
    @State private var hovered: String?
    @State private var dealt = false
    @State private var showingDeleted = false

    private var items: [NativeArtifact] {
        model.artifacts.sorted { $0.updatedAt > $1.updatedAt }
    }

    private var storedFilter: String {
        get { chosenFilter ?? sceneFilter }
        nonmutating set {
            chosenFilter = newValue
            sceneFilter = newValue
        }
    }

    private var chips: [NativeArtifactKind] { DesktopArtifactsFilter.chips(present: items.map(\.kind)) }
    private var activeFilter: String { DesktopArtifactsFilter.effective(storedFilter, chips: chips) }
    private var designsView: Bool { activeFilter == NativeArtifactKind.design.rawValue }
    private var filtered: [NativeArtifact] {
        DesktopArtifactsFilter.filter(items, type: activeFilter, query: query)
    }

    private var isLoading: Bool {
        !offline && model.artifacts.isEmpty && (model.phase == .idle || model.phase == .loading)
    }

    private var failed: Bool {
        if offline { return true }
        if case .failed = model.phase { return model.artifacts.isEmpty }
        return false
    }

    private var empty: Bool { !isLoading && !failed && items.isEmpty }
    private var firstRunEmpty: Bool { empty && !designsView }
    private var designsEmpty: Bool { !isLoading && !failed && designsView && !items.contains { $0.kind == .design } }
    private var noResults: Bool { !isLoading && !failed && !items.isEmpty && filtered.isEmpty && !designsEmpty }
    private var isList: Bool { (initialView ?? storedView) != "grid" }

    var body: some View {
        JunoPage(measure: .wide, scrolling: .page) {
            JunoPageHeader("Artifacts", lede: "Designs, documents, spreadsheets, decks, sites and code made with Alevr.") {
                if !isLoading, !empty, !failed {
                    Text("\(items.count) \(items.count == 1 ? "artifact" : "artifacts")")
                        .junoType(.ui)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize()
                }
                Button("Recently Deleted") { showingDeleted = true }
                    .buttonStyle(.borderless)
                    .contentShape(.rect)
                    .help("Artifacts deleted in the last 30 days")
                if !firstRunEmpty {
                    newMenu(header: true)
                }
            }
        } controls: {
            if !isLoading, !empty, !failed {
                controls
            }
        } content: {
            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                if designsView, !isLoading, !failed {
                    DesktopDesignPresetRow(creating: creating, start: start)
                }
                content
            }
        }
        .junoRenameSheet($renaming)
        .junoConfirmation($confirmation)
        .sheet(isPresented: $showingDeleted) {
            DesktopRecentlyDeletedArtifactsSheet(model: model) { showingDeleted = false }
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
        .onAppear {
            if let initialFilter { storedFilter = initialFilter }
            if let initialQuery { query = initialQuery }
            takeRouterFilter()
        }
        .onChange(of: DesktopPageRouter.shared.artifactsFilter) { _, _ in takeRouterFilter() }
        .onChange(of: isLoading) { _, loading in if !loading { dealt = true } }
    }

    private func takeRouterFilter() {
        guard let filter = DesktopPageRouter.shared.takeArtifactsFilter() else { return }
        // `?new=design` opens the web's menu on the presets; a native menu
        // cannot be opened by code, and the Designs filter pins the same four
        // presets above the list.
        storedFilter = filter.type
    }

    // MARK: - New ▾

    /// "New ▾": a Design section with the four sizes, then "Ask Juno in a New
    /// Chat". Choosing a size makes the design at once and opens it.
    @ViewBuilder
    private func newMenu(header: Bool) -> some View {
        let menu = Menu {
            Section("Design") {
                ForEach(DesktopDesignPreset.allCases) { preset in
                    Button {
                        start(preset)
                    } label: {
                        Label {
                            Text(preset.label)
                            Text(preset.detail)
                        } icon: {
                            JunoIconView(DesktopArtifactKinds.presetIcon(preset))
                        }
                    }
                    .disabled(creating != nil || requestSender == nil)
                }
            }
            if header, let newChat {
                Divider()
                Button {
                    newChat()
                } label: {
                    Label("Ask Alevr in a New Chat", icon: .chats)
                }
            }
        } label: {
            if creating != nil {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Making the design")
            } else if header {
                Label("New", icon: .plus)
            } else {
                Label("New design", icon: .design)
            }
        }
        .menuStyle(.button)
        .contentShape(.rect)
        .fixedSize()
        .help("Make something new")
        if header {
            menu.junoProminentMenu()
        } else {
            menu.buttonStyle(.junoGlass).tint(nil)
        }
    }

    // MARK: - Controls

    private var controls: some View {
        JunoPageControls {
            JunoPageSearchField(text: $query, prompt: "Search artifacts…")
            if chips.count > 1 || activeFilter != DesktopArtifactsFilter.all {
                JunoSegmented(
                    options: [JunoSegmented<String>.Option(DesktopArtifactsFilter.all, "All", count: items.count)]
                        + chips.map { kind in
                            JunoSegmented<String>.Option(
                                kind.rawValue,
                                DesktopArtifactKinds.chipLabel(kind),
                                count: items.filter { $0.kind == kind }.count
                            )
                        },
                    selection: Binding(get: { activeFilter }, set: { storedFilter = $0 }),
                    accessibilityLabel: "Filter by type"
                )
            }
        } trailing: {
            JunoSegmented(
                options: [
                    JunoSegmented<String>.Option("list", "List", icon: .list),
                    JunoSegmented<String>.Option("grid", "Grid", icon: .grid),
                ],
                selection: Binding(get: { isList ? "list" : "grid" }, set: { storedView = $0 }),
                accessibilityLabel: "Artifact view"
            )
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if failed {
            JunoEmptyState(
                title: offline ? "You’re offline" : "Couldn’t load your artifacts",
                message: offline
                    ? "Your artifacts will load again the moment the connection returns."
                    : "Something went wrong on the way here.",
                icon: offline ? .wifiOff : .triangleAlert,
                actionLabel: "Try again",
                action: { Task { await model.reload() } },
                tone: .error
            )
        } else if isLoading {
            DesktopArtifactSkeleton()
        } else if designsEmpty {
            JunoEmptyState(
                title: "No designs yet",
                message: "Pick a size above to start one, or ask Alevr in any chat to design a screen.",
                icon: .design,
                size: .panel
            )
        } else if empty {
            JunoEmptyState(
                title: "Nothing here yet",
                message: "Ask Alevr to build a page, component, document or diagram, or start a design from a blank frame. Each one collects here.",
                icon: .artifacts
            ) {
                if let newChat {
                    Button("Start building", action: newChat)
                        .contentShape(.rect)
                        .buttonStyle(.junoProminent)
                }
                newMenu(header: false)
            }
        } else if noResults {
            JunoEmptyState(
                title: "No matching artifacts",
                message: "Nothing fits \(query.trimmingCharacters(in: .whitespaces).isEmpty ? "these filters" : "“\(query.trimmingCharacters(in: .whitespaces))”").",
                icon: .search,
                size: .panel
            ) {
                Button("Clear filters") {
                    query = ""
                    storedFilter = DesktopArtifactsFilter.all
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.junoSecondaryInk)
                .contentShape(.rect)
            }
        } else if isList {
            list
        } else {
            grid
        }
    }

    // MARK: List

    private var list: some View {
        DesktopPageLayoutReader { layout in
            let showsMeta = layout.pageWidth >= 640
            VStack(spacing: 0) {
                ForEach(Array(filtered.enumerated()), id: \.element.id) { index, artifact in
                    if index > 0 {
                        Rectangle()
                            .fill(Color.junoBorder.opacity(0.7))
                            .frame(height: 1)
                            .padding(.horizontal, JunoSpace.regular)
                            .accessibilityHidden(true)
                    }
                    row(artifact, showsMeta: showsMeta)
                        .junoDealt(index: index, active: !dealt, reduceMotion: reduceMotion)
                }
            }
            .padding(.vertical, JunoSpace.tight)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(Color.junoCard)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
        }
    }

    private func row(_ artifact: NativeArtifact, showsMeta: Bool) -> some View {
        let isHovered = hovered == artifact.id
        return HStack(spacing: JunoSpace.cozy) {
            DesktopArtifactInset(artifact: artifact, hovering: isHovered)
            VStack(alignment: .leading, spacing: 2) {
                Text(artifact.title.isEmpty ? "Untitled artifact" : artifact.title)
                    .junoType(.ui)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                if !artifact.conversationTitle.isEmpty {
                    Text("in “\(artifact.conversationTitle)”")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if showsMeta {
                Text(DesktopArtifactKinds.meta(artifact))
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .help(artifact.updatedAt.formatted(date: .long, time: .shortened))
            }
            moreMenu(artifact)
                .opacity(isHovered ? 1 : 0)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(isHovered ? Color.junoHover : Color.clear)
                .padding(.horizontal, JunoSpace.tight)
        )
        .contentShape(.rect)
        .onTapGesture { open(artifact) }
        .desktopKeyboardOpen { open(artifact) }
        .onHover { inside in hover(artifact, inside) }
        .contextMenu { actions(artifact) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Open") { open(artifact) }
    }

    // MARK: Grid

    private var grid: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 240), spacing: JunoSpace.cozy, alignment: .top)],
            alignment: .leading,
            spacing: JunoSpace.cozy
        ) {
            ForEach(Array(filtered.enumerated()), id: \.element.id) { index, artifact in
                tile(artifact)
                    .junoDealt(index: index, active: !dealt, reduceMotion: reduceMotion)
            }
        }
    }

    private func tile(_ artifact: NativeArtifact) -> some View {
        let isHovered = hovered == artifact.id
        return VStack(alignment: .leading, spacing: 0) {
            DesktopArtifactPreviewTile(artifact: artifact)
                .aspectRatio(4 / 3, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card - JunoSpace.snug, style: .continuous))
            HStack(alignment: .top, spacing: JunoSpace.tight) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(artifact.title.isEmpty ? "Untitled artifact" : artifact.title)
                        .junoType(.ui)
                        .fontWeight(.medium)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                    HStack(spacing: JunoSpace.tight) {
                        JunoIconView(DesktopArtifactKinds.icon(artifact.kind), size: 12)
                            .accessibilityHidden(true)
                        Text(DesktopArtifactKinds.meta(artifact))
                            .monospacedDigit()
                            .lineLimit(1)
                    }
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                moreMenu(artifact)
                    .opacity(isHovered ? 1 : 0)
            }
            .padding(.horizontal, JunoSpace.tight)
            .padding(.top, JunoSpace.snug)
            .padding(.bottom, JunoSpace.hairline)
        }
        .padding(JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(isHovered ? Color.junoHover : Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
        .contentShape(.rect(cornerRadius: JunoRadius.card))
        .onTapGesture { open(artifact) }
        .desktopKeyboardOpen { open(artifact) }
        .onHover { inside in hover(artifact, inside) }
        .contextMenu { actions(artifact) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Open") { open(artifact) }
    }

    private func moreMenu(_ artifact: NativeArtifact) -> some View {
        Menu {
            actions(artifact)
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
        .accessibilityLabel("Actions for \(artifact.title.isEmpty ? "artifact" : artifact.title)")
    }

    // MARK: - Actions

    /// One definition for the More button and the context menu (the web's
    /// `renderActions`), Title Case, destructive last.
    @ViewBuilder
    private func actions(_ artifact: NativeArtifact) -> some View {
        Button("Open") { open(artifact) }
            .contentShape(.rect)
        Button("Open in Conversation") { DesktopPageRouter.shared.openArtifactInConversation(artifact) }
            .contentShape(.rect)
        Divider()
        Button("Rename…") { rename(artifact) }
            .contentShape(.rect)
        Button("Make a Copy") {
            DesktopArtifactLifecycle.duplicate(artifact, version: nil, model: model, toast: toast) { id in
                push(.artifact(id, version: nil))
            }
        }
        .contentShape(.rect)
        Button("Download…") {
            DesktopArtifactLifecycle.download(
                artifact, version: artifact.currentVersion, format: .file, model: model, toast: toast
            ) { download = $0 }
        }
        .contentShape(.rect)
        Button("Download with History…") {
            DesktopArtifactLifecycle.download(
                artifact, version: artifact.currentVersion, format: .zipWithHistory, model: model, toast: toast
            ) { download = $0 }
        }
        .contentShape(.rect)
        if let shareArtifact {
            Button("Share…") { shareArtifact(artifact) }
                .contentShape(.rect)
        }
        Divider()
        Button("Open in New Window") { openInWindow(artifact) }
            .contentShape(.rect)
        Button("Copy Source") { copySource(artifact) }
            .contentShape(.rect)
        Divider()
        Button("Move to Recently Deleted…", role: .destructive) { confirmDelete(artifact) }
            .contentShape(.rect)
    }

    private func open(_ artifact: NativeArtifact) {
        push(.artifact(artifact.id, version: nil))
    }

    private func hover(_ artifact: NativeArtifact, _ inside: Bool) {
        if inside { hovered = artifact.id } else if hovered == artifact.id { hovered = nil }
    }

    private func rename(_ artifact: NativeArtifact) {
        renaming = DesktopArtifactActions.rename(artifact, model: model, toast: toast)
    }

    private func confirmDelete(_ artifact: NativeArtifact) {
        confirmation = DesktopArtifactActions.delete(artifact, model: model, toast: toast) {}
    }

    private func copySource(_ artifact: NativeArtifact) {
        guard let content = artifact.currentContent else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(content, forType: .string)
    }

    private func openInWindow(_ artifact: NativeArtifact) {
        guard let content = artifact.currentContent else { return }
        DesktopArtifactWindows.shared.present(
            title: artifact.title,
            subtitle: "\(DesktopArtifactKindName.singular(artifact.kind)) · v\(artifact.currentVersion)",
            kind: artifact.kind,
            content: content,
            mode: DesktopArtifactViewMode.available(for: artifact.kind).first ?? .source
        )
    }

    /// Makes a design at a size and opens it: the route creates it on the
    /// server, the store catches up, and its page is pushed.
    private func start(_ preset: DesktopDesignPreset) {
        guard creating == nil else { return }
        guard let requestSender, let accountID else {
            toast(.error("Couldn’t start a design."))
            return
        }
        creating = preset
        Task {
            defer { creating = nil }
            do {
                let id = try await DesktopDesignStartClient(sender: requestSender)
                    .startDesign(preset: preset, title: "Untitled design", for: accountID)
                await syncModel?.refresh()
                await model.reload()
                push(.artifact(id, version: nil))
            } catch {
                toast(.error((error as? LocalizedError)?.errorDescription ?? "Couldn’t start a design."))
            }
        }
    }
}

/// Rename and Delete, in the web's words, for the list and the artifact page.
@MainActor
enum DesktopArtifactActions {
    static func rename(
        _ artifact: NativeArtifact,
        model: NativeArtifactModel<SQLiteAccountRepository>,
        toast: JunoToastNotifier
    ) -> JunoRenameRequest {
        JunoRenameRequest(
            title: "Rename artifact",
            message: "The new name shows everywhere this artifact appears.",
            fieldLabel: "Artifact name",
            confirmTitle: "Rename",
            current: artifact.title
        ) { title in
            await model.renameArtifact(id: artifact.id, title: title)
            if model.lastErrorDescription != nil {
                toast(.error("Couldn’t rename the artifact."))
                return false
            }
            return true
        }
    }

    static func delete(
        _ artifact: NativeArtifact,
        model: NativeArtifactModel<SQLiteAccountRepository>,
        toast: JunoToastNotifier,
        deleted: @escaping @MainActor () -> Void
    ) -> JunoConfirmation {
        JunoConfirmation(
            title: "Move “\(artifact.title.isEmpty ? "artifact" : artifact.title)” to Recently Deleted?",
            message: "Its public links stop working until you restore it. You can bring it back from Recently Deleted for 30 days.",
            confirmTitle: "Move to Recently Deleted"
        ) {
            Task {
                await model.deleteArtifact(id: artifact.id)
                if model.lastErrorDescription != nil {
                    toast(.error("Couldn’t delete the artifact."))
                } else {
                    deleted()
                    toast(.success("Moved to Recently Deleted."))
                }
            }
        }
    }
}

// MARK: - The presets (the page's signature)

/// The four sizes, pinned above the list with the Designs filter on: 2
/// across, 4 from 640. Each draws its frame's own proportions; the plus hands
/// over to the design mark while that one is being made — the one loop on
/// the page, because it is live state. The glyph stays neutral on hover
/// (register #64).
struct DesktopDesignPresetRow: View {
    let creating: DesktopDesignPreset?
    let start: (DesktopDesignPreset) -> Void

    var body: some View {
        DesktopPageLayoutReader { layout in
            let columns = layout.pageWidth >= 640 ? 4 : 2
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: JunoSpace.snug), count: columns),
                spacing: JunoSpace.snug
            ) {
                ForEach(DesktopDesignPreset.allCases) { preset in
                    DesktopDesignPresetButton(
                        preset: preset,
                        isCreating: creating == preset,
                        disabled: creating != nil,
                        start: { start(preset) }
                    )
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Start a design")
    }
}

struct DesktopDesignPresetButton: View {
    let preset: DesktopDesignPreset
    let isCreating: Bool
    let disabled: Bool
    let start: () -> Void

    @State private var hovering = false
    @State private var breathing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: start) {
            HStack(spacing: JunoSpace.cozy) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: JunoSpace.tight) {
                        ZStack {
                            JunoIconView(.plus, size: 13)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .opacity(isCreating ? 0 : 1)
                            JunoIconView(.design, size: 13)
                                .foregroundStyle(Color.junoForeground)
                                .opacity(isCreating ? (breathing ? 0.45 : 1) : 0)
                        }
                        .frame(width: 14, height: 14)
                        .accessibilityHidden(true)
                        Text(preset.label)
                            .junoType(.ui)
                            .fontWeight(.medium)
                            .foregroundStyle(Color.junoForeground)
                    }
                    Text(preset.detail)
                        .junoType(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                Spacer(minLength: 0)
                aspect
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .frame(minWidth: 28, minHeight: 28)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(hovering ? Color.junoHover : Color.junoCard)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .contentShape(.rect(cornerRadius: JunoRadius.card))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled && !isCreating ? 0.6 : 1)
        .onHover { hovering = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isCreating)
        .onChange(of: isCreating, initial: true) { _, creating in
            guard creating, !reduceMotion else {
                breathing = false
                return
            }
            withAnimation(JunoMotion.ambient(JunoMotion.breathe(period: JunoMotion.Loop.skeletonBreathe), when: reduceMotion)) {
                breathing = true
            }
        }
        .help("New \(preset.label.lowercased()) design, \(preset.detail)")
        .accessibilityLabel("New \(preset.label) design, \(preset.detail)")
        .accessibilityValue(isCreating ? "Making" : "")
    }

    /// The frame's own proportions, drawn in a 28pt box.
    private var aspect: some View {
        let box: CGFloat = 28
        let ratio = preset.size.width / preset.size.height
        let width = ratio >= 1 ? box : box * ratio
        let height = ratio >= 1 ? box / ratio : box
        return RoundedRectangle(cornerRadius: 3, style: .continuous)
            .strokeBorder(Color.junoSecondaryInk, lineWidth: 1.25)
            .frame(width: width, height: height)
            .frame(width: box, height: box)
            .accessibilityHidden(true)
    }
}

// MARK: - Insets, tiles and posters

/// A row's 36pt inset: a design's poster, fitted with 4pt of padding, or the
/// kind's glyph (the web's `ICONS`).
struct DesktopArtifactInset: View {
    let artifact: NativeArtifact
    var hovering = false

    var body: some View {
        Group {
            if artifact.kind == .design {
                DesktopDesignPoster(artifactID: artifact.id, version: artifact.currentVersion, isCurrent: true, glyphSize: 16)
                    .padding(JunoSpace.hairline)
            } else {
                JunoIconView(DesktopArtifactKinds.icon(artifact.kind), size: 16)
                    .foregroundStyle(hovering ? Color.junoForeground : Color.junoSecondaryInk)
            }
        }
        .frame(width: 36, height: 36)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoSecondary)
        )
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .accessibilityHidden(true)
    }
}

/// A tile's 4:3 preview: a design's poster; otherwise the web's
/// `ArtifactPreview`, an excerpt of the source (an SVG as its picture), never
/// a live render; the kind's glyph when there is no source yet.
struct DesktopArtifactPreviewTile: View {
    let artifact: NativeArtifact

    var body: some View {
        ZStack {
            Color.junoSecondary
            if artifact.kind == .design {
                DesktopDesignPoster(artifactID: artifact.id, version: artifact.currentVersion, isCurrent: true, glyphSize: 28)
                    .padding(JunoSpace.cozy)
            } else if let content = artifact.currentContent, !content.isEmpty {
                DesktopArtifactExcerpt(source: content, kind: artifact.kind, well: Color.junoSecondary)
            } else {
                JunoIconView(DesktopArtifactKinds.icon(artifact.kind), size: 28)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
        .accessibilityHidden(true)
    }
}

/// A design's poster from ``NativeDesignPreviewLoader`` (Phase 4 A3), drawn
/// natively from its SVG; the design mark while it loads or when it cannot
/// be drawn. Cross-fades in on the fast duration.
struct DesktopDesignPoster: View {
    let artifactID: String
    let version: Int
    let isCurrent: Bool
    var glyphSize: CGFloat = 16

    @Environment(\.junoDesignPreviews) private var previews

    private var image: NSImage? {
        guard case .ready(let svg)? = previews?.designPreviewState(artifactID: artifactID, version: version) else { return nil }
        return NSImage(data: Data(svg.utf8))
    }

    var body: some View {
        ZStack {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .transition(.opacity)
            } else {
                JunoIconView(.design, size: glyphSize)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
        .animation(JunoMotion.fast, value: image != nil)
        .task(id: "\(artifactID)#\(version)") {
            await previews?.loadDesignPreview(artifactID: artifactID, version: version, isCurrent: isCurrent)
        }
    }
}

/// Loading, shaped like the rows.
private struct DesktopArtifactSkeleton: View {
    @State private var dimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<6, id: \.self) { _ in
                HStack(spacing: JunoSpace.cozy) {
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(Color.junoSecondary)
                        .frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        Capsule().fill(Color.junoSecondary).frame(width: 192, height: 10)
                        Capsule().fill(Color.junoSecondary).frame(width: 112, height: 8)
                    }
                    Spacer()
                    Capsule().fill(Color.junoSecondary).frame(width: 64, height: 8)
                }
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.snug)
            }
        }
        .opacity(dimmed ? 0.55 : 1)
        .animation(
            JunoMotion.ambient(JunoMotion.breathe(period: JunoMotion.Loop.skeletonBreathe), when: reduceMotion),
            value: dimmed
        )
        .onAppear { if !reduceMotion { dimmed = true } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading artifacts")
    }
}

// MARK: - Rules and words (ported from the web, tested)

/// The home's filter rules — `src/lib/artifacts-home.ts`.
enum DesktopArtifactsFilter {
    static let all = "ALL"

    /// `HOME_TYPE_ORDER`: Designs first, the one chip that always shows.
    static let order: [NativeArtifactKind] = [
        .design, .document, .spreadsheet, .presentation, .html, .react, .code, .markdown, .svg, .mermaid,
    ]

    /// `homeTypeChips`: Designs always; the others when they have items.
    static func chips(present: [NativeArtifactKind]) -> [NativeArtifactKind] {
        let seen = Set(present)
        return order.filter { $0 == .design || seen.contains($0) }
    }

    /// `effectiveHomeFilter`: a filter whose chip has gone reads as All,
    /// without being forgotten.
    static func effective(_ filter: String, chips: [NativeArtifactKind]) -> String {
        guard filter != all else { return all }
        return chips.contains { $0.rawValue == filter } ? filter : all
    }

    /// `homeTypeFromParam`: case-insensitive; a value that names no type is
    /// All.
    static func type(fromParam value: String?) -> String {
        guard let value else { return all }
        let upper = value.trimmingCharacters(in: .whitespaces).uppercased()
        return order.contains { $0.rawValue == upper } ? upper : all
    }

    /// The type filter, then the search over title, conversation title and
    /// runtime label (the page's `filtered`).
    static func filter(_ items: [NativeArtifact], type: String, query: String) -> [NativeArtifact] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return items.filter { item in
            if type != all, item.kind.rawValue != type { return false }
            guard !needle.isEmpty else { return true }
            return item.title.lowercased().contains(needle)
                || item.conversationTitle.lowercased().contains(needle)
                || NativeArtifactRuntimeInfo.resolve(kind: item.kind, language: item.language).label.lowercased().contains(needle)
        }
    }
}

/// The page's words and marks for a kind — the web's `TYPE_LABELS`, `ICONS`
/// and `DOWNLOAD_EXTENSIONS`.
enum DesktopArtifactKinds {
    static func chipLabel(_ kind: NativeArtifactKind) -> String {
        switch kind {
        case .html: "Sites"
        case .react: "Components"
        case .code: "Code"
        case .markdown: "Documents"
        case .svg: "Graphics"
        case .mermaid: "Diagrams"
        case .design: "Designs"
        case .spreadsheet: "Spreadsheets"
        case .document: "Docs"
        case .presentation: "Decks"
        }
    }

    static func icon(_ kind: NativeArtifactKind) -> JunoIcon {
        switch kind {
        case .html: .web
        case .react: .codeBrackets
        case .code: .fileCode
        case .svg: .image
        case .markdown: .file
        case .mermaid: .branch
        case .design: .design
        case .spreadsheet: .grid
        case .document: .file
        case .presentation: .squareStack
        }
    }

    static func presetIcon(_ preset: DesktopDesignPreset) -> JunoIcon {
        switch preset {
        case .phone: .smartphone
        case .tablet: .tablet
        case .desktop: .monitor
        case .square: .square
        }
    }

    /// "{runtime} · v{n} (from 2) · {ago}", SF with tabular digits (#58).
    static func meta(_ artifact: NativeArtifact) -> String {
        var parts = [NativeArtifactRuntimeInfo.resolve(kind: artifact.kind, language: artifact.language).label]
        if artifact.currentVersion > 1 { parts.append("v\(artifact.currentVersion)") }
        parts.append(DesktopRelativeTime.short(artifact.updatedAt))
        return parts.joined(separator: " · ")
    }

    /// `{identifier}.{ext}`: the language's extension, else the type's, else
    /// `txt` (`extensionForLanguage`, `DOWNLOAD_EXTENSIONS`).
    static func downloadName(_ artifact: NativeArtifact) -> String {
        let ext = fileExtension(forLanguage: artifact.language) ?? typeExtensions[artifact.kind] ?? "txt"
        let base = artifact.identifier.isEmpty ? "artifact" : artifact.identifier
        return "\(base).\(ext)"
    }

    static let typeExtensions: [NativeArtifactKind: String] = [
        .html: "html", .react: "tsx", .svg: "svg", .markdown: "md", .mermaid: "mmd",
        .design: "juno.design.json", .code: "txt",
        .spreadsheet: "json", .document: "json", .presentation: "json",
    ]

    static func fileExtension(forLanguage raw: String?) -> String? {
        let key = (raw ?? "").trimmingCharacters(in: .whitespaces).lowercased()
            .replacingOccurrences(of: #"^\.+"#, with: "", options: .regularExpression)
        guard !key.isEmpty else { return nil }
        let canonical = aliases[key] ?? key
        return fileExtensions[canonical]
    }

    private static let aliases: [String: String] = [
        "js": "javascript", "mjs": "javascript", "cjs": "javascript", "node": "javascript",
        "ts": "typescript", "react": "tsx", "py": "python", "python3": "python", "htm": "html",
        "mmd": "mermaid", "md": "markdown", "sh": "bash", "shell": "bash", "zsh": "bash",
        "golang": "go", "rs": "rust", "c++": "cpp", "cc": "cpp", "cxx": "cpp", "c#": "csharp",
        "cs": "csharp", "kt": "kotlin", "rb": "ruby", "yml": "yaml",
    ]

    private static let fileExtensions: [String: String] = [
        "design": "juno.design.json", "javascript": "js", "typescript": "ts", "jsx": "jsx", "tsx": "tsx",
        "python": "py", "html": "html", "svg": "svg", "css": "css", "mermaid": "mmd", "markdown": "md",
        "bash": "sh", "sql": "sql", "go": "go", "rust": "rs", "c": "c", "cpp": "cpp", "csharp": "cs",
        "java": "java", "kotlin": "kt", "swift": "swift", "ruby": "rb", "php": "php", "perl": "pl",
        "json": "json", "yaml": "yml", "toml": "toml", "xml": "xml", "dockerfile": "dockerfile",
        "makefile": "mk", "ini": "ini", "graphql": "graphql", "vue": "vue", "svelte": "svelte",
        "dart": "dart", "r": "r", "lua": "lua", "scala": "scala", "elixir": "ex", "haskell": "hs",
    ]
}
