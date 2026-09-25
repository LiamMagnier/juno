import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import SwiftUI
import UniformTypeIdentifiers

/// A project a fact can be filed in.
struct DesktopMemoryProject: Identifiable, Hashable {
    let id: String
    let name: String
}

/// What the memory page needs besides the switch: its model and the projects
/// a fact can move to. Handed down through the environment to the places
/// that reach Memory without the configuration (Settings › Memory, which
/// keeps calling ``DesktopMemoryScreen/init(model:back:context:)`` with two
/// arguments).
struct DesktopMemoryContext {
    let page: NativeMemoryPageModel
    let projects: @MainActor () -> [DesktopMemoryProject]
}

extension EnvironmentValues {
    @Entry var desktopMemoryContext: DesktopMemoryContext? = nil
}

extension DesktopMemoryContext {
    @MainActor
    init?(configuration: JunoDesktopConfiguration) {
        guard let page = configuration.memoryPageModel else { return nil }
        let projectModel = configuration.projectModel
        self.init(page: page) {
            (projectModel?.projects ?? []).map { DesktopMemoryProject(id: $0.id, name: $0.name) }
        }
    }
}

/// **Memory** — what Juno carries from one chat to the next, as the web's one
/// calm column (`src/components/memory/memory-manager.tsx`, Phase 4 B1):
///
///     header      the name, the one On/Off switch, a menu for the rare things
///     notices     memory is off / a policy refused / reading past chats
///     scope       only when a project has memory of its own
///     summary     prose that unfolds in place, the prompt dock at its foot,
///                 and a drafted change right under the dock
///     list        every memory, by topic or by date, rows inside one card
///     footer      what never reaches memory, and import, export, reset
///
/// Your edits and the recap are one step aside, in the Activity sheet.
///
/// The `Table`, the stat tiles, the privacy strip and "What Juno remembers"
/// are gone: the web retired all four. The switch is still
/// ``NativeMemorySettingsModel``'s `memoryEnabled`, the same field
/// Settings › Memory shows, so the two can never disagree.
struct DesktopMemoryScreen: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    /// Returns to whatever opened this (Settings). Nil where the column is
    /// the way back.
    var back: (() -> Void)?
    /// The page's model and projects; the environment's when nil.
    var context: DesktopMemoryContext? = nil
    /// Opens a fact's source chat, where the page can reach Chat.
    var openConversation: ((String) -> Void)? = nil

    @Environment(\.desktopMemoryContext) private var environmentContext

    var body: some View {
        if let context = context ?? environmentContext {
            DesktopMemoryPage(
                settings: model,
                page: context.page,
                projects: context.projects,
                back: back,
                openConversation: openConversation
            )
        } else {
            JunoEmptyState(title: "Memory", message: "The memory service is unavailable.", icon: .triangleAlert)
        }
    }
}

// MARK: - The page

private enum DesktopMemoryMetrics {
    /// A section folds past this many rows, when that hides at least three.
    static let previewRows = 5
    static let minimumFolded = 3
    /// The web's `PREVIEW_CHARS`, for the summary's first unfold.
    static let summaryBudget = 520
    static let searchWidth: CGFloat = 240
}

/// The page itself, over the page model and the settings switch.
struct DesktopMemoryPage: View {
    @Bindable var settings: NativeMemorySettingsModel<SQLiteAccountRepository>
    let page: NativeMemoryPageModel
    let projects: @MainActor () -> [DesktopMemoryProject]
    var back: (() -> Void)?
    var openConversation: ((String) -> Void)? = nil
    /// Starts the list grouped by date (the web's "Newest first"), for a
    /// snapshot; the reader's choice is otherwise remembered.
    var initialGrouping: NativeMemoryGrouping? = nil
    /// Starts narrowed to a project, as the web's `/memory?project=`.
    var initialScope: String? = nil
    /// Draws the switch in this state rather than the setting's, for a
    /// snapshot of the page with memory off.
    var enabledOverride: Bool? = nil

    @Environment(\.junoToast) private var toast
    @Environment(\.openSettings) private var openSettings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @AppStorage("juno.memory.sort") private var storedGrouping = NativeMemoryGrouping.topic.rawValue
    @State private var query = ""
    @State private var scope: String?
    @State private var didApplyInitialState = false
    @State private var composing = false
    @State private var showsActivity = false
    @State private var activityTab = DesktopMemoryActivityTab.edits
    @State private var showsImport = false
    @State private var confirmsReset = false
    @State private var exportDocument: DesktopSettingsExportDocument?
    @State private var showsExporter = false

    private var enabled: Bool { enabledOverride ?? settings.settings?.memoryEnabled ?? true }

    private var grouping: NativeMemoryGrouping {
        NativeMemoryGrouping(rawValue: storedGrouping) ?? .topic
    }

    private var scopes: [NativeMemoryScope] {
        NativeMemoryPresentation.scopes(facts: page.facts, projectSummaries: page.projectSummaries)
    }

    /// A project the account has no memory for shows everything rather than
    /// an empty page that looks like data loss.
    private var activeScope: String? {
        guard let scope, scopes.contains(where: { $0.id == scope }) else { return nil }
        return scope
    }

    private var activeProject: DesktopMemoryProject? {
        guard let activeScope else { return nil }
        let name = scopes.first { $0.id == activeScope }?.label ?? "This project"
        return DesktopMemoryProject(id: activeScope, name: name)
    }

    var body: some View {
        JunoPage(measure: .reading) {
            if let back {
                Button(action: back) {
                    Label("Back to settings", icon: .arrowLeft)
                }
                .buttonStyle(.borderless)
                .tint(nil)
                .keyboardShortcut("[", modifiers: .command)
                .help("Back to settings (⌘[)")
                .padding(.bottom, JunoSpace.cozy)
                .accessibilityIdentifier("juno.desktop.memory.back")
                .contentShape(.rect)
            }
            JunoPageHeader(
                "Memory",
                lede: "What Juno carries from one chat to the next. You can change or remove any of it."
            ) {
                headerActions
            }
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                notices
                bodyContent
                if page.phase == .ready {
                    footer
                }
            }
        }
        .task {
            if !didApplyInitialState {
                didApplyInitialState = true
                scope = initialScope
                if let initialGrouping { storedGrouping = initialGrouping.rawValue }
            }
            page.onNotice = { notice in post(notice) }
            await page.loadIfNeeded()
        }
        .onDisappear { page.flushRemovals() }
        .sheet(isPresented: $showsActivity) {
            DesktopMemoryActivitySheet(page: page, tab: $activityTab, scope: activeScope)
        }
        .sheet(isPresented: $showsImport) {
            DesktopMemoryImportSheet(page: page)
        }
        .confirmationDialog("Reset memory?", isPresented: $confirmsReset, titleVisibility: .visible) {
            Button("Reset Memory", role: .destructive) { Task { post(await page.reset()) } }
            Button("Export First") { export() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently deletes everything Juno remembers, the summary and every project’s memory, and its edit history. It can’t be undone. Your chats stay as they are.")
        }
        .fileExporter(
            isPresented: $showsExporter,
            document: exportDocument,
            contentType: .json,
            defaultFilename: NativeMemoryPageModel.exportFileName()
        ) { result in
            switch result {
            case .success: toast(.success("Memory exported."))
            case .failure(let error):
                if (error as? CocoaError)?.code != .userCancelled { toast(.error(error.localizedDescription)) }
            }
            exportDocument = nil
        }
        .accessibilityIdentifier("juno.desktop.memory")
    }

    // MARK: Header

    private var headerActions: some View {
        HStack(spacing: JunoSpace.cozy) {
            Text(enabled ? "On" : "Off")
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityHidden(true)
            Toggle("Memory", isOn: enabledBinding)
                .toggleStyle(.switch)
                .labelsHidden()
                .tint(Color.junoAccent)
                .disabled(settings.settings == nil || settings.isMutating)
                .help(enabled ? "Turn memory off" : "Turn memory on")
                .accessibilityIdentifier("juno.desktop.memory.enabled")
            DesktopRowMenuButton(accessibilityLabel: "More memory options") {
                moreMenuItems
            }
        }
    }

    @ViewBuilder
    private var moreMenuItems: some View {
        Section {
            if let unread = page.backfillRemaining, unread > 0 {
                Button {
                    learn()
                } label: {
                    Label {
                        Text(page.isBackfilling ? "Reading Past Chats…" : "Learn from Past Chats")
                        Text(unread == 1 ? "1 unread chat" : "\(unread) unread chats")
                    } icon: {
                        Image(JunoIcon.chats.assetName)
                    }
                }
                .disabled(!enabled || page.isBackfilling)
            }
            Button { showsImport = true } label: { Label("Import from Another Assistant…", image: JunoIcon.upload.assetName) }
                .disabled(!enabled)
            Button { export() } label: { Label("Export…", image: JunoIcon.download.assetName) }
                .disabled(!page.anythingRemembered)
            Button { openActivity(.edits) } label: { Label("Activity", image: JunoIcon.history.assetName) }
            Divider()
            Button { openMemorySettings() } label: { Label("Memory Settings…", image: JunoIcon.settings.assetName) }
            Divider()
            Button(role: .destructive) { confirmsReset = true } label: {
                Label("Reset Memory…", image: JunoIcon.restore.assetName)
            }
            .disabled(!page.anythingRemembered)
        }
    }

    private var enabledBinding: Binding<Bool> {
        Binding(
            get: { enabled },
            set: { on in
                Task {
                    await settings.updateSettings(NativeSettingsPatch(memoryEnabled: on))
                    toast(.success(
                        on ? "Memory is on. Juno will learn from your chats."
                            : "Memory is off. Juno won’t use or save memories."
                    ))
                }
            }
        )
    }

    // MARK: Notices

    @ViewBuilder
    private var notices: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            if !enabled {
                DesktopNoteBand(icon: .circlePause) {
                    desktopLeadSentence("Memory is off.", "Juno isn’t using or saving memories. What’s here is kept.")
                } action: {
                    Button("Turn on") {
                        Task { await settings.updateSettings(NativeSettingsPatch(memoryEnabled: true)) }
                    }
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .controlSize(.small)
                    .contentShape(.rect)
                }
                .transition(.opacity)
            }
            if let policy = page.policyNotice {
                DesktopNoteBand(icon: .info) {
                    Text(policy).foregroundStyle(Color.junoSecondaryInk)
                } action: {
                    Button("Background processing") { openMemorySettings() }
                        .buttonStyle(.bordered)
                        .tint(nil)
                        .controlSize(.small)
                        .contentShape(.rect)
                }
            }
            if page.isBackfilling {
                DesktopNoteBand(icon: .chats) {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        desktopLeadSentence("Reading your past chats.", "You can leave this page; Juno picks up where it left off.")
                        ProgressView(value: backfillProgress)
                            .progressViewStyle(.linear)
                            .tint(Color.junoAccent)
                            .frame(maxWidth: 240)
                            .accessibilityLabel("Past chats read")
                    }
                }
            } else if offersBackfill, let remaining = page.backfillRemaining {
                DesktopNoteBand(icon: .chats) {
                    desktopLeadSentence(
                        remaining == 1 ? "1 past chat hasn’t been read yet." : "\(remaining) past chats haven’t been read yet.",
                        "Juno can learn from them now."
                    )
                } action: {
                    Button("Learn from them") { learn() }
                        .buttonStyle(.bordered)
                        .tint(nil)
                        .controlSize(.small)
                        .contentShape(.rect)
                }
            }
        }
        .padding(.bottom, hasNotice ? JunoSpace.roomy : 0)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: enabled)
    }

    private var hasNotice: Bool {
        !enabled || page.policyNotice != nil || page.isBackfilling || offersBackfill
    }

    private var offersBackfill: Bool {
        page.phase == .ready && page.anythingRemembered && enabled && !page.isBackfilling
            && (page.backfillRemaining ?? 0) > 0 && page.accountActiveCount < NativeMemoryPageModel.thinMemory
    }

    private var backfillProgress: Double {
        let total = max(page.backfillTotal, 1)
        let done = max(0, page.backfillTotal - (page.backfillRemaining ?? 0))
        return min(1, Double(done) / Double(total))
    }

    // MARK: Body

    @ViewBuilder
    private var bodyContent: some View {
        switch page.phase {
        case .failed:
            JunoEmptyState(
                title: "Couldn’t load your memory",
                message: "Check your connection and try again. Nothing has been changed.",
                icon: .error,
                actionLabel: "Try again",
                action: { Task { await page.reload() } },
                tone: .error
            )
        case .idle, .loading:
            DesktopMemorySkeleton()
        case .ready:
            if page.anythingRemembered {
                VStack(alignment: .leading, spacing: 0) {
                    scopeBar
                    DesktopMemorySummaryPanel(
                        page: page,
                        summary: activeScope == nil ? page.summary : page.projectSummaries.first { $0.projectID == activeScope }?.summary,
                        project: activeProject,
                        enabled: enabled,
                        rebuild: { Task { if let notice = await page.regenerate(projectID: activeScope) { post(notice) } } },
                        openActivity: { openActivity(.edits) },
                        post: post
                    )
                    .id(activeScope ?? "account")
                    DesktopMemoryList(
                        page: page,
                        facts: scopedFacts,
                        query: $query,
                        grouping: Binding(get: { grouping }, set: { storedGrouping = $0.rawValue }),
                        enabled: enabled,
                        project: activeProject,
                        projects: projects,
                        openChat: openConversation,
                        post: post
                    )
                    .padding(.top, JunoSpace.expanse)
                }
            } else {
                DesktopMemoryWelcome(
                    page: page,
                    enabled: enabled,
                    composing: $composing,
                    importMemory: { showsImport = true },
                    learn: learn,
                    post: post
                )
            }
        }
    }

    private var scopedFacts: [NativeMemoryFact] {
        NativeMemoryPresentation.facts(page.facts, inScope: activeScope)
            .filter { $0.isFact && !page.hiddenIDs.contains($0.id) }
    }

    @ViewBuilder
    private var scopeBar: some View {
        if scopes.count > 1 {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                if scopes.count <= 5 {
                    HStack(spacing: JunoSpace.tight) {
                        ForEach(scopes) { option in
                            DesktopMemoryScopeChip(option: option, isSelected: option.id == activeScope) {
                                scope = option.id
                            }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Show memory from")
                } else {
                    JunoPageMenu(
                        options: scopes.map { JunoPageMenuOption($0.id ?? "", "\($0.label) \($0.count)") },
                        selection: Binding(get: { activeScope ?? "" }, set: { scope = $0.isEmpty ? nil : $0 }),
                        accessibilityLabel: "Show memory from"
                    )
                }
                if let project = activeProject {
                    HStack(spacing: JunoSpace.tight) {
                        Text("Only chats in this project use these memories, and they use nothing else Juno remembers.")
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Open project") {
                            DesktopPageRouter.shared.open(.projects, route: .project(project.id))
                        }
                        .buttonStyle(DesktopUnderlineLinkStyle())
                        .contentShape(.rect)
                    }
                    .transition(.opacity)
                }
            }
            .padding(.bottom, JunoSpace.regular)
        }
    }

    // MARK: Footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Rectangle()
                .fill(Color.junoBorder)
                .frame(height: 1)
                .padding(.bottom, JunoSpace.snug)
                .accessibilityHidden(true)
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                JunoIconView(.shieldCheck, size: 14)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityHidden(true)
                Text("Incognito chats are never remembered. Sensitive subjects like health or religion are only learned if you allow them.")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: JunoSpace.tight) {
                Button("Memory settings") { openMemorySettings() }
                    .contentShape(.rect)
                separator
                Button("Import") { showsImport = true }
                    .disabled(!enabled)
                    .contentShape(.rect)
                separator
                Button("Export") { export() }
                    .disabled(!page.anythingRemembered)
                    .contentShape(.rect)
                separator
                Button("Reset memory…") { confirmsReset = true }
                    .disabled(!page.anythingRemembered)
                    .contentShape(.rect)
            }
            .buttonStyle(DesktopUnderlineLinkStyle())
            .padding(.leading, 22)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Your memory data")
        }
        .padding(.top, JunoSpace.expanse)
    }

    private var separator: some View {
        Text("·")
            .junoType(.caption)
            .foregroundStyle(Color.junoSecondaryInk)
            .accessibilityHidden(true)
    }

    // MARK: Actions

    private func post(_ notice: NativeMemoryNotice?) {
        guard let notice else { return }
        let undo = notice.undoID.map { id in
            JunoToast.Action("Undo", icon: .undo) { page.undoRemoval(id) }
        }
        let tone: JunoToast.Tone
        switch notice.tone {
        case .success: tone = .success
        case .error: tone = .error
        case .info: tone = .info
        }
        toast(JunoToast(
            id: notice.undoID.map { "memory.removal.\($0)" } ?? UUID().uuidString,
            tone: tone,
            title: notice.title,
            detail: notice.detail,
            action: undo,
            duration: notice.undoID == nil ? JunoToast.defaultDuration : page.undoWindow
        ))
    }

    private func learn() {
        Task { post(await page.runBackfill()) }
    }

    private func openActivity(_ tab: DesktopMemoryActivityTab) {
        activityTab = tab
        showsActivity = true
    }

    private func openMemorySettings() {
        DesktopSettingsRouter.open(.memory, using: openSettings)
    }

    private func export() {
        exportDocument = DesktopSettingsExportDocument(data: page.exportData())
        showsExporter = true
    }
}

// MARK: - Scope chip

private struct DesktopMemoryScopeChip: View {
    let option: NativeMemoryScope
    let isSelected: Bool
    let select: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: select) {
            HStack(spacing: JunoSpace.tight) {
                if option.id != nil {
                    JunoIconView(.projects, size: 13)
                        .accessibilityHidden(true)
                }
                Text(option.label)
                    .lineLimit(1)
                Text(option.count, format: .number)
                    .monospacedDigit()
                    .foregroundStyle(isSelected ? Color.junoCanvas.opacity(0.75) : Color.junoSecondaryInk)
            }
            .junoType(JunoType.ui.weight(.medium))
            .foregroundStyle(isSelected ? Color.junoCanvas : Color.junoForeground)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 28)
            .background(
                Capsule(style: .continuous)
                    .fill(isSelected ? Color.junoForeground : (isHovering ? Color.junoHover : Color.junoSecondary))
            )
            .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - Loading

/// The page's shape while it loads: the summary panel and three rows, so
/// nothing moves when the data lands.
private struct DesktopMemorySkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.expanse) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                JunoSkeleton(height: 12, width: 72)
                JunoSkeleton(height: 14, width: 120)
                JunoSkeleton(height: 12)
                JunoSkeleton(height: 12)
                JunoSkeleton(height: 12, width: 280)
                JunoSkeleton(height: 40, cornerRadius: JunoRadius.field)
                    .padding(.top, JunoSpace.snug)
            }
            .padding(JunoSpace.roomy)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .fill(Color.junoCard)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                JunoSkeleton(height: 16, width: 110)
                ForEach(0..<3, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        JunoSkeleton(height: 12)
                        JunoSkeleton(height: 10, width: 160)
                    }
                    .padding(.vertical, JunoSpace.snug)
                }
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading memory")
    }
}
