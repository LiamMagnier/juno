import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoWorkKit
import SwiftUI

/// Chat's navigation column (§2 of the Liquid Glass redesign), as a real macOS
/// source list.
///
/// Top to bottom: the Search button pinned above the list, a headerless block
/// of navigation rows, then the conversation sections — Needs you (Phase 5),
/// Pinned projects, Pinned chats and Recent — and the account footer pinned
/// below. It is the web's information architecture (`app-sidebar.tsx`) in the
/// platform's own mechanics: `List(selection:)` owns the arrow keys,
/// type-select and VoiceOver, the section headers are the system's
/// collapsible headers, and the column itself is the system's floating glass
/// pane — nothing here paints a background except the selected row (§2.6).
///
/// **No chrome of its own above the rows.** The hand-built "Juno" brand row and
/// its second sidebar toggle are gone: the traffic lights and the system
/// toggle already occupy that strip, and the product switch sits in the
/// sidebar's segment of the toolbar (§1.4).
struct DesktopChatSidebar: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Binding var product: DesktopProductMode
    @Binding var destination: DesktopDestination
    @Binding var selection: DesktopSidebarItem?
    /// The conversation whose row is showing its rename field. Owned by the
    /// window, because the title menu's Rename… starts the same inline rename
    /// the row menu does (§1.3).
    @Binding var renamingConversationID: String?
    /// The project a pinned-project row last opened, so that row — and not the
    /// Projects nav row — reads as selected while its page is up.
    let openProjectID: String?
    let actions: DesktopConversationActions
    let newChat: () -> Void
    let newChatInProject: (String) -> Void
    /// Opens the ⌘K / Search panel in Search (§7.4); the sidebar's Search
    /// button and ⇧⌘F both land here.
    let openSearch: () -> Void
    /// The account's agents, for the fold under Needs you. Nil or an empty
    /// roster draws no fold at all.
    var agentsModel: NativeAgentsModel? = nil
    /// Opens an agent's thread by the agent's id, creating it if it has none.
    var messageAgent: ((String) -> Void)? = nil
    /// Opens the hiring sheet: the Agents fold's "New agent" (the web's
    /// `/agents/new`). Nil hides the button.
    var hireAgent: (() -> Void)? = nil
    /// Each chat's newest task, joined from the account's list (Phase 5 C1):
    /// the rows' status dots and the Needs-you fold.
    var runs: WorkRunsByConversation = .empty
    /// The inbox behind the Notifications row. Nil draws no row.
    var notificationsModel: NativeNotificationsModel? = nil
    /// Whether the Notifications popover is up, when the window holds it (⌘K
    /// opens it too). Nil keeps it on the row.
    var showingNotifications: Binding<Bool>? = nil
    @State private var notificationsOpenHere = false
    /// The fold's state is the reader's, and it survives a relaunch: a column
    /// that reopened every agent after it had been folded away would be a
    /// column arguing with the person who arranged it.
    @AppStorage("juno.desktop.sidebar.agents.collapsed") private var agentsCollapsed = false
    /// Opens the Archived chats sheet (Track A). The More menu's "Archived
    /// Chats" item is drawn only while this is set.
    var openArchivedChats: (() -> Void)? = nil

    @AppStorage("juno.sidebar.projects.expanded") private var pinnedProjectsOpen = true
    @AppStorage("juno.sidebar.pinned.expanded") private var pinnedChatsOpen = true
    @AppStorage("juno.sidebar.recent.expanded") private var recentOpen = true
    /// How many Recent rows are drawn. Grows a page at a time as the last one
    /// scrolls into view (§2.1), so a four-year history is not four thousand
    /// rows laid out on launch.
    @State private var recentLimit = DesktopChatSidebarContent.recentPage
    /// While on, every section but Needs you hides (§2.5). Not persisted: a
    /// column that relaunched filtered would hide the reader's chats behind a
    /// control they no longer remember pressing.
    @State private var filterToNeedsYou = false
    /// Snapshots draw the fold pressed; the app never sets it.
    var startsFilteringNeedsYou = false
    @State private var projectPendingDeletion: NativeProject?
    @State private var renamingProjectID: String?
    @State private var hoveringProjectsHeader = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // MARK: Data

    /// Every chat the column may show: `kind == "chat"`, not archived, newest
    /// first.
    ///
    /// Filtered here and **not** in the store (errata 6): the store keeps Code's
    /// conversations because `sendMessage` refuses one it has never heard of,
    /// and Code depends on that. The leak was the column drawing them.
    private var chats: [NativeConversation] {
        DesktopChatSidebarContent.chats(from: model.conversations)
    }

    /// Conversations that need the reader: an approval waiting, a question
    /// asked — each chat whose newest run has stopped for a person (the web's
    /// `workRunNeedsYou`), newest first. The fold draws only while it has one.
    private var needsYou: [NativeConversation] {
        DesktopChatSidebarContent.needsYou(from: chats, runs: runs)
    }

    private var pinnedProjects: [NativeProject] {
        DesktopChatSidebarContent.pinnedProjects(from: projectModel?.projects ?? [])
    }

    private var isBootstrapping: Bool {
        guard chats.isEmpty else { return false }
        if model.phase == .loading { return true }
        guard let syncModel = configuration.syncModel else { return false }
        return syncModel.phase == .synchronizing && syncModel.lastSuccessfulSyncAt == nil
    }

    var body: some View {
        let all = chats
        let excluded = Set(needsYou.map(\.id))
        let pinned = DesktopChatSidebarContent.pinned(from: all, excluding: excluded)
        let recent = DesktopChatSidebarContent.recent(from: all, excluding: excluded)
        let projects = pinnedProjects

        return ScrollViewReader { proxy in
            list(pinned: pinned, recent: recent, projects: projects, all: all)
                // Rename… from the title menu (or a row menu reached through
                // search) names a chat whose row may be folded away, past the
                // loaded page of Recent, or scrolled out of sight — and the
                // rename field lives in that row. So the row is brought out
                // first; otherwise the command would do nothing anyone can see.
                .onChange(of: renamingConversationID) { _, id in
                    guard let id else { return }
                    reveal(id, pinned: pinned, recent: recent, proxy: proxy)
                }
        }
    }

    private func list(
        pinned: [NativeConversation],
        recent: [NativeConversation],
        projects: [NativeProject],
        all: [NativeConversation]
    ) -> some View {
        List(selection: $selection) {
            Section { navigationBlock }

            if !needsYou.isEmpty {
                Section {
                    ForEach(needsYou) { conversationRow($0) }
                } header: {
                    needsYouHeader
                }
            }

            if !filterToNeedsYou {
                // The Agents fold: after Needs you, before the pinned projects
                // (the web's order, `app-sidebar.tsx`), and hidden while the
                // Needs-you filter is on, as the web hides it.
                if let agentsModel, !agentsModel.agents.isEmpty {
                    Section(isExpanded: agentsExpanded) {
                        ForEach(agentsModel.sidebarAgents) { agent in
                            agentRow(agent)
                        }
                    } header: {
                        agentsHeader
                    }
                }

                if !projects.isEmpty {
                    Section(isExpanded: $pinnedProjectsOpen) {
                        ForEach(projects) { project in
                            projectRow(project, chats: DesktopChatSidebarContent.chats(inProject: project.id, from: all))
                        }
                    } header: {
                        pinnedProjectsHeader
                    }
                }

                if !pinned.isEmpty {
                    Section(isExpanded: $pinnedChatsOpen) {
                        ForEach(pinned) { conversationRow($0) }
                    } header: {
                        DesktopSidebarHeading(JunoShellChatSidebar.Heading.pinned.label)
                    }
                }

                if !recent.isEmpty {
                    Section(isExpanded: $recentOpen) {
                        ForEach(recent.prefix(recentLimit)) { conversation in
                            conversationRow(conversation)
                                .onAppear { loadMoreIfLast(conversation, in: recent) }
                        }
                    } header: {
                        DesktopSidebarHeading(JunoShellChatSidebar.Heading.recent.label)
                    }
                } else if isBootstrapping {
                    DesktopSidebarLoadingRows()
                } else if all.isEmpty, projects.isEmpty {
                    emptyRecent
                }
            }
        }
        .listStyle(.sidebar)
        // The selection is still the platform's — only its colour is Juno's.
        .junoSidebarSelectionTint()
        .junoProductSwitch(product: $product)
        // `safeAreaBar`, not `safeAreaInset`: the bar variant is what the
        // system's bottom scroll-edge effect is measured against, and that
        // effect is what lets the footer sit on a translucent column without an
        // opaque bar painted behind it.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            DesktopAccountFooter(configuration: configuration, session: session)
        }
        .junoSidebarScrollEdge()
        .onChange(of: needsYou.count) { previous, count in
            // The filter lets go when the last question is answered, or the
            // column would be empty with the control that emptied it gone.
            if count == 0 { filterToNeedsYou = false }
            if let sentence = DesktopChatSidebarContent.needsYouAnnouncement(from: previous, to: count) {
                AccessibilityNotification.Announcement(sentence).post()
            }
        }
        .onAppear { if startsFilteringNeedsYou { filterToNeedsYou = true } }
        // Opener and actions on one line: the targets gate reads a dialog's
        // buttons as system-drawn only when its brace opens on that line.
        .confirmationDialog("Delete this project?", isPresented: isConfirmingProjectDeletion, titleVisibility: .visible) {
            Button("Delete Project", role: .destructive) { deletePendingProject() }
            Button("Cancel", role: .cancel) { projectPendingDeletion = nil }
        } message: {
            // The web's copy, verbatim (`app-sidebar.tsx`, `deleteProject`).
            Text("Its chats are kept (just unlinked), but the project’s instructions and files are removed. This can’t be undone.")
        }
        .accessibilityIdentifier("juno.desktop.sidebar")
    }

    // MARK: Navigation block

    /// New chat, the four destinations and More. Headerless, as on the web: the
    /// rows name themselves, and a "Navigate" caption above them would be the
    /// one heading in the column that labels nothing a reader was looking for.
    @ViewBuilder
    private var navigationBlock: some View {
        // A button and never a tagged row. An empty draft is the absence of a
        // conversation, so the draft it starts selects nothing (§2.3).
        Button(action: newChat) {
            Label {
                Text(JunoShellChatSidebar.Action.new.label)
            } icon: {
                JunoSymbol(JunoShellChatSidebar.Action.new.icon)
                    .foregroundStyle(Color.junoSidebarInk)
            }
            .foregroundStyle(Color.junoSidebarInk)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(JunoShortcutRegistry.help(JunoShellChatSidebar.Action.new.label, .newChat))
        .accessibilityIdentifier("juno.desktop.sidebar.new-chat")

        // Search is a row, as on the web (§2.2, `app-sidebar.tsx`): shaped
        // like New chat, with no fill and no keycap. The chord lives in the
        // tooltip and the menu bar, where a reader looking for it looks.
        Button(action: openSearch) {
            Label {
                Text(JunoShellChatSidebar.Action.search.label)
            } icon: {
                JunoSymbol(JunoShellChatSidebar.Action.search.icon)
                    .foregroundStyle(Color.junoSidebarInk)
            }
            .foregroundStyle(Color.junoSidebarInk)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(JunoShortcutRegistry.help(JunoShellChatSidebar.Action.search.label, .search))
        .accessibilityIdentifier("juno.desktop.sidebar.search")

        // The inbox, right after New chat (Phase 5 C1, register #62).
        if let notificationsModel {
            DesktopNotificationsRow(
                model: notificationsModel,
                isOpen: showingNotifications ?? $notificationsOpenHere
            )
        }

        ForEach(DesktopDestination.sidebarCases) { item in
            destinationRow(item)
        }

        moreRow
    }

    private func destinationRow(_ item: DesktopDestination) -> some View {
        // The ink is stated on the mark as well as on the label. A `Label` in a
        // `.sidebar` list resolves its icon slot against the system accent, and
        // an inherited `foregroundStyle` does not reach it. The web spends no
        // accent here at all: the mark rests on `--sidebar-foreground` and
        // lifts to `--foreground` with its row. The weight never changes.
        let selected = selection == .destination(item)
        let ink = selected ? Color.junoForeground : Color.junoSidebarInk

        return Label {
            Text(item.label)
        } icon: {
            JunoSymbol(item.junoIcon)
                .foregroundStyle(ink)
        }
        .foregroundStyle(ink)
        .junoSidebarRowSelection(selected)
        .tag(DesktopSidebarItem.destination(item))
        .accessibilityIdentifier("juno.desktop.sidebar.\(item.rawValue)")
    }

    /// More, as a menu rather than a row that navigates. It is never tagged —
    /// the list cannot select it — so it borrows the selected recipe itself
    /// while one of its pages is open.
    ///
    /// The web's order (`app-sidebar.tsx`): Assistants, Skills, Automations,
    /// then a separator and Archived Chats, which is drawn only while its
    /// sheet can be opened (Phase 4 C4).
    private var moreRow: some View {
        let isOpen = DesktopDestination.moreCases.contains(destination)
            && selection == .destination(destination)
        let ink = isOpen ? Color.junoForeground : Color.junoSidebarInk

        return Menu {
            ForEach(DesktopDestination.moreCases) { item in
                Button {
                    selection = .destination(item)
                } label: {
                    Label(item.label, image: item.junoIcon.assetName)
                }
            }
            if let openArchivedChats {
                Divider()
                Button(action: openArchivedChats) {
                    Label(
                        JunoShellChatSidebar.More.archivedTitle,
                        image: JunoShellChatSidebar.More.archivedIcon.assetName
                    )
                }
            }
        } label: {
            Label {
                Text(JunoShellChatSidebar.More.label)
            } icon: {
                JunoSymbol(JunoShellChatSidebar.More.icon)
                    .foregroundStyle(ink)
            }
            .foregroundStyle(ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .junoSidebarRowSelection(isOpen)
        .accessibilityLabel(JunoShellChatSidebar.More.label)
        .accessibilityIdentifier("juno.desktop.sidebar.more")
    }

    // MARK: Sections

    /// "Needs you · n" — a filter, not a destination. Pressing it hides every
    /// other section until it is pressed again or the count reaches zero, and
    /// while it is on it draws as the column's one selected row: the column
    /// shows these chats and nothing else, which is the fact a selection
    /// states. The column's signature detail.
    private var needsYouHeader: some View {
        DesktopNeedsYouHeader(count: needsYou.count, isFiltering: filterToNeedsYou) {
            filterToNeedsYou.toggle()
        }
    }

    /// "Agents", with "New agent" beside it. Shown at rest, as the web's
    /// `SectionAction always`: the fold's one standing affordance.
    private var agentsHeader: some View {
        HStack(spacing: JunoSpace.tight) {
            DesktopSidebarHeading(JunoShellChatSidebar.Heading.agents.label)
            Spacer(minLength: 0)
            if let hireAgent {
                Button(action: hireAgent) {
                    JunoIconView(.plus, size: 12)
                        .foregroundStyle(Color.junoSidebarInk)
                        .frame(width: 28, height: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .help("New agent")
                .accessibilityLabel("New agent")
            }
        }
    }

    private var agentsExpanded: Binding<Bool> {
        Binding(
            get: { !agentsCollapsed },
            set: { agentsCollapsed = !$0 }
        )
    }

    /// One agent: its face, its name, and a dot while it needs the person —
    /// the row's one trailing signal. The sentence the roster says is the
    /// hover text and half of what the row says aloud, so the face itself is
    /// decorative here.
    ///
    /// Lit while its page is open, and while its thread is the conversation on
    /// screen: the thread is the agent too, as the web's row says.
    private func agentRow(_ agent: NativeAgent) -> some View {
        let sentence = NativeAgentFormat.stateSentence(for: agent)
        let spoken = "\(agent.name). \(sentence)"
        var selected = selection == .agent(agent.id)
        if let thread = agent.conversationID, selection == .conversation(thread) {
            selected = true
        }

        return HStack(spacing: JunoSpace.tight) {
            JunoAgentFace(avatar: agent.avatar, state: agent.state, size: JunoAgentFaceSize.xs)
            Text(agent.name)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: JunoSpace.hairline)
            DesktopSidebarTrailingSlot {
                if agent.state == .waiting {
                    NativeAgentNeedsYouDot()
                }
            }
        }
        .padding(.leading, JunoSidebarMetrics.titleLeading)
        .junoSidebarRowInk()
        .junoSidebarRowSelection(selected)
        .help(sentence)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spoken)
        .tag(DesktopSidebarItem.agent(agent.id))
        .contextMenu {
            Button("Message") { messageAgent?(agent.id) }
                .disabled(messageAgent == nil)
            Button("Open") { selection = .agent(agent.id) }
        }
    }

    private var pinnedProjectsHeader: some View {
        HStack(spacing: JunoSpace.tight) {
            DesktopSidebarHeading(JunoShellChatSidebar.Heading.pinnedProjects.label)
            Spacer(minLength: 0)
            Button {
                actions.newProject(nil)
            } label: {
                // Inked here: a borderless label inside the list takes the
                // list's tint — the selection fill, all but invisible on the
                // column — and outside it the system accent.
                JunoIconView(.plus, size: 12)
                    .foregroundStyle(Color.junoSidebarInk)
                    .frame(width: 28, height: 28)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            // Revealed on hover, like the system's own fold chevron beside it;
            // always present to VoiceOver and the keyboard.
            .opacity(hoveringProjectsHeader ? 1 : 0)
            .help("New project")
            .accessibilityLabel("New project")
        }
        .onHover { hoveringProjectsHeader = $0 }
        .animation(JunoMotion.fast, value: hoveringProjectsHeader)
    }

    /// The first-run column: one line that cannot be selected, in the web's
    /// words (`app-sidebar.tsx`), on the column's own text edge.
    private var emptyRecent: some View {
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
            Text(JunoShellChatSidebar.emptyLines[0])
                .junoFont(size: 13, relativeTo: .callout)
                .junoSecondaryInk()
            // Secondary, not tertiary: tertiary ink is 2.89:1 on the light
            // canvas and may only carry non-essential text of 13pt and up.
            Text(JunoShellChatSidebar.emptyLines[1])
                .junoFont(size: 12, relativeTo: .footnote)
                .junoSecondaryInk()
        }
        .padding(.vertical, JunoSpace.tight)
        .selectionDisabled()
        .accessibilityElement(children: .combine)
    }

    private var isConfirmingProjectDeletion: Binding<Bool> {
        Binding(
            get: { projectPendingDeletion != nil },
            set: { if !$0 { projectPendingDeletion = nil } }
        )
    }

    private func deletePendingProject() {
        guard let project = projectPendingDeletion else { return }
        projectPendingDeletion = nil
        Task { await projectModel?.deleteProject(id: project.id) }
    }

    private func loadMoreIfLast(_ conversation: NativeConversation, in recent: [NativeConversation]) {
        guard recent.count > recentLimit,
              conversation.id == recent.prefix(recentLimit).last?.id
        else { return }
        recentLimit += DesktopChatSidebarContent.recentPage
    }

    // MARK: Rows

    /// A conversation's row.
    ///
    /// - Parameter isCanonical: whether this is the chat's own row — in Needs
    ///   you, Pinned chats or Recent — rather than the copy a pinned project
    ///   lists under itself. A project chat is drawn twice, and only one of
    ///   the two may open the rename field: two fields for one rename take
    ///   focus from each other, and the one losing it commits, which ended the
    ///   rename the moment it began. The canonical row is also the one scrolled
    ///   to, so it carries the scroll identity.
    @ViewBuilder
    private func conversationRow(_ conversation: NativeConversation, isCanonical: Bool = true) -> some View {
        let selected = selection == .conversation(conversation.id)
        let row = DesktopConversationRow(
            conversation: conversation,
            isSelected: selected,
            signal: runs.openSignal(for: conversation.id),
            renamingConversationID: $renamingConversationID,
            hostsRename: isCanonical,
            justRenamed: model.recentlyRenamedConversationID == conversation.id,
            projects: projectModel?.projects ?? [],
            actions: actions,
            acknowledgeRename: { model.acknowledgeTitleAnimation(for: conversation.id) }
        )
        if isCanonical {
            row
                .id(DesktopChatSidebarContent.scrollID(for: conversation.id))
                .junoSidebarRowSelection(selected)
                .tag(DesktopSidebarItem.conversation(conversation.id))
        } else {
            row
                .junoSidebarRowSelection(selected)
                .tag(DesktopSidebarItem.conversation(conversation.id))
        }
    }

    /// Unfolds the section holding `id`, pages Recent far enough to draw it,
    /// and scrolls its row into view — so a rename started from outside the
    /// column lands in a field the reader can see.
    private func reveal(
        _ id: String,
        pinned: [NativeConversation],
        recent: [NativeConversation],
        proxy: ScrollViewProxy
    ) {
        if needsYou.contains(where: { $0.id == id }) {
            // Its section never folds.
        } else if pinned.contains(where: { $0.id == id }) {
            filterToNeedsYou = false
            pinnedChatsOpen = true
        } else if let index = recent.firstIndex(where: { $0.id == id }) {
            filterToNeedsYou = false
            recentOpen = true
            recentLimit = DesktopChatSidebarContent.recentLimit(revealing: index, current: recentLimit)
        } else {
            return
        }
        // A turn later, once the unfolded section and the longer page exist to
        // be scrolled to.
        Task { @MainActor in
            await Task.yield()
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                proxy.scrollTo(DesktopChatSidebarContent.scrollID(for: id))
            }
        }
    }

    /// A pinned project: a disclosure row whose children are its three newest
    /// chats, then "View all n" / "Show less" in place.
    private func projectRow(_ project: NativeProject, chats projectChats: [NativeConversation]) -> some View {
        DesktopPinnedProjectRow(
            project: project,
            chats: projectChats,
            isSelected: selection == .project(project.id),
            renamingProjectID: $renamingProjectID,
            conversationRow: { conversationRow($0, isCanonical: false) },
            newChat: { newChatInProject(project.id) },
            unpin: {
                Task { await projectModel?.updateProject(id: project.id, starred: false) }
            },
            rename: { name in
                Task { await projectModel?.updateProject(id: project.id, name: name) }
            },
            delete: { projectPendingDeletion = project }
        )
    }
}

// MARK: - Data rules

/// What the Chat column draws, as pure functions over the stores' arrays — so
/// the rules the view depends on (errata 6's kind filter, archive exclusion,
/// newest-first, Needs you winning over Pinned) can be asserted without a
/// window.
enum DesktopChatSidebarContent {
    /// Recent's page size (§2.1).
    static let recentPage = 40
    /// How many of a pinned project's chats show before "View all".
    static let projectPreview = 3

    /// Chat conversations only — never Code's — without the archived ones,
    /// newest first.
    static func chats(from conversations: [NativeConversation]) -> [NativeConversation] {
        conversations
            .filter { $0.kind == "chat" && !$0.isArchived }
            .sorted { $0.lastMessageAt > $1.lastMessageAt }
    }

    /// The chats in Needs you: every chat whose newest run has stopped for
    /// the reader, in the column's own order (newest first). A chat can only
    /// be in one place, and of Needs you, Pinned and Recent this is the one
    /// with a person waiting on it, so it wins over both.
    static func needsYou(
        from chats: [NativeConversation],
        runs: WorkRunsByConversation
    ) -> [NativeConversation] {
        let waiting = runs.needsYou
        guard !waiting.isEmpty else { return [] }
        return chats.filter { waiting.contains($0.id) }
    }

    /// The fold's live-region sentences (`app-sidebar.tsx`), said when the
    /// count rises and when it reaches zero; nil otherwise.
    static func needsYouAnnouncement(from previous: Int, to count: Int) -> String? {
        if count == 0, previous > 0 { return "Nothing is waiting on you." }
        guard count > previous else { return nil }
        return count == 1 ? "1 run is waiting on you." : "\(count) runs are waiting on you."
    }

    static func pinned(
        from chats: [NativeConversation],
        excluding needsYou: Set<String> = []
    ) -> [NativeConversation] {
        chats.filter { $0.pinned && !needsYou.contains($0.id) }
    }

    /// One flat list with no date folds. Project chats stay here as well as
    /// under their project, as on the web: a project is a workspace rather than
    /// a filing.
    static func recent(
        from chats: [NativeConversation],
        excluding needsYou: Set<String> = []
    ) -> [NativeConversation] {
        chats.filter { !$0.pinned && !needsYou.contains($0.id) }
    }

    /// The starred subset, in the store's order.
    static func pinnedProjects(from projects: [NativeProject]) -> [NativeProject] {
        projects.filter(\.starred)
    }

    static func chats(inProject projectID: String, from chats: [NativeConversation]) -> [NativeConversation] {
        chats.filter { $0.projectId == projectID }
    }

    /// How many Recent rows to draw so the row at `index` is among them: the
    /// current page count, or the smallest whole number of pages that reaches
    /// it. Never fewer than are already drawn.
    static func recentLimit(revealing index: Int, current: Int) -> Int {
        guard index >= current else { return current }
        return (index / recentPage + 1) * recentPage
    }

    /// A row's help: the title, and while its task is open, the task's
    /// sentence after a colon ("Draft the memo: Juno is working on this now.").
    static func rowHelp(title: String, signal: WorkRunsByConversation.Signal?) -> String {
        guard let signal else { return title }
        return "\(title): \(ChatWorkVocabulary.sentence(signal.status))"
    }

    /// What VoiceOver hears after the title: the task's status while it is
    /// open, and the pin.
    static func rowValue(pinned: Bool, signal: WorkRunsByConversation.Signal?) -> String {
        [signal.map { ChatWorkVocabulary.label($0.status) }, pinned ? "Pinned" : nil]
            .compactMap { $0 }
            .joined(separator: ", ")
    }

    /// The scroll identity of a chat's own row. Namespaced, because a pinned
    /// project lists the same chat again under itself and the two must not
    /// answer to one id.
    static func scrollID(for conversationID: String) -> String {
        "conversation-row:\(conversationID)"
    }
}

// MARK: - Section heading

/// One voice for every heading in the column: Pinned projects, Pinned chats,
/// Recent, Agents and Needs you at rest (the web's `text-label
/// text-muted-foreground`). The ink is stated, not left to the list's header
/// style, which draws near 1.7:1 on the vibrant column.
struct DesktopSidebarHeading: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .textCase(nil)
            .foregroundStyle(Color.junoSecondaryInk)
            .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Trailing slot

/// The sidebar's column metrics (§2.3): where a row's words start, and the
/// one box every trailing mark is centred in.
enum JunoSidebarMetrics {
    /// A title or an agent's face starts on the nav glyphs' column. The list
    /// insets a plain row's content about 6pt less than a `Label`'s icon.
    static let titleLeading: CGFloat = 6
    /// The trailing slot: the kebab, a status dot, the pin, an unread or
    /// needs-you dot and a pending spinner share one 20pt box, so every mark
    /// down the column sits on one centre.
    static let trailingSlot: CGFloat = 20
}

/// A run's state in a sidebar row's trailing slot, as a **mark, never a dot**
/// (owner directive, premium pass): a quiet spinner in sidebar ink while it
/// works, a raised hand in the accent while it waits on the reader, a crossed
/// circle in destructive ink when it failed, and nothing at all for a run
/// that is simply done or idle. The row says the state in words (its value
/// and help), so the mark is silent to VoiceOver. Shared by Chat's and
/// Code's columns.
struct DesktopSidebarStatusMark: View {
    let tone: JunoStatusTone

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            switch tone {
            case .live:
                Group {
                    if reduceMotion {
                        Circle().stroke(Color.junoSidebarInk, lineWidth: 1.25)
                    } else {
                        DesktopSidebarSpinner()
                    }
                }
                .frame(width: 9, height: 9)
            case .attention:
                JunoIconView(.hand, size: 11)
                    .foregroundStyle(Color.junoAccent)
            case .bad:
                JunoIconView(.circleX, size: 11)
                    .foregroundStyle(Color.junoDestructiveInk)
            case .good, .neutral:
                EmptyView()
            }
        }
        .accessibilityHidden(true)
    }
}

/// A thin turning arc in sidebar ink, driven by the clock so it costs nothing
/// off screen.
private struct DesktopSidebarSpinner: View {
    var body: some View {
        TimelineView(.animation) { context in
            let turns = context.date.timeIntervalSinceReferenceDate / 0.9
            Circle()
                .trim(from: 0, to: 0.7)
                .stroke(Color.junoSidebarInk, style: StrokeStyle(lineWidth: 1.25, lineCap: .round))
                .rotationEffect(.degrees((turns - turns.rounded(.down)) * 360))
        }
    }
}

/// A row's trailing mark, centred in the column's one slot.
struct DesktopSidebarTrailingSlot<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .frame(width: JunoSidebarMetrics.trailingSlot, height: JunoSidebarMetrics.trailingSlot)
    }
}

// MARK: - Conversation row

/// One conversation: its title, and at most one trailing mark.
///
/// No leading glyph and no bullet — the column is a list of titles. The mark
/// is chosen in the web's priority order: a send still pending, then the
/// overflow menu while the row is hovered or selected, then the newest run's
/// status dot while that run is open, then the pin — a run that needs you
/// outranks the fact that the row is pinned, because the pin is something you
/// set and the dot is something that happened.
private struct DesktopConversationRow: View {
    let conversation: NativeConversation
    let isSelected: Bool
    /// The chat's newest task while it is still the reader's business.
    var signal: WorkRunsByConversation.Signal? = nil
    @Binding var renamingConversationID: String?
    /// Whether this row opens the rename field for its chat. False for the
    /// copy a pinned project lists under itself; see
    /// `DesktopChatSidebar.conversationRow(_:isCanonical:)`.
    var hostsRename = true
    /// The server just named this chat; the title cross-fades in once.
    let justRenamed: Bool
    let projects: [NativeProject]
    let actions: DesktopConversationActions
    let acknowledgeRename: () -> Void

    @State private var isHovering = false

    private var isRenaming: Bool { hostsRename && renamingConversationID == conversation.id }

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            if isRenaming {
                JunoInlineRenameField(conversation.title, accessibilityLabel: "Rename chat") { name in
                    actions.commitRename(conversation, name)
                } end: {
                    renamingConversationID = nil
                }
            } else {
                Text(conversation.title)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .contentTransition(.opacity)
                    .animation(justRenamed ? JunoMotion.slow : nil, value: conversation.title)
            }
            Spacer(minLength: JunoSpace.hairline)
            DesktopSidebarTrailingSlot { trailingMark }
        }
        // On the nav glyphs' column: the title IS the row's left edge.
        .padding(.leading, JunoSidebarMetrics.titleLeading)
        .junoSidebarRowInk()
        .onHover { isHovering = $0 }
        .onChange(of: conversation.title) { _, _ in
            if justRenamed { acknowledgeRename() }
        }
        // The run's sentence joins the title rather than replacing it: the
        // help is also how a truncated title gets read (the web's colon).
        .help(DesktopChatSidebarContent.rowHelp(title: conversation.title, signal: signal))
        .contextMenu {
            DesktopConversationMenu(conversation: conversation, projects: projects, actions: actions)
        }
        .accessibilityValue(DesktopChatSidebarContent.rowValue(pinned: conversation.pinned, signal: signal))
    }

    @ViewBuilder
    private var trailingMark: some View {
        if conversation.isPending {
            ProgressView()
                .controlSize(.mini)
                .accessibilityLabel("Sending")
        } else if (isHovering || isSelected), !isRenaming {
            Menu {
                DesktopConversationMenu(conversation: conversation, projects: projects, actions: actions)
            } label: {
                // A 20pt face in the trailing slot, its hit area widened to
                // the 28pt pointer target around it.
                JunoIconView(.more, size: 16)
                    .frame(width: JunoSidebarMetrics.trailingSlot, height: JunoSidebarMetrics.trailingSlot)
                    .contentShape(Rectangle().inset(by: -4))
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("More")
            .accessibilityLabel("Chat options")
        } else if let signal {
            // The row says the state in words (its value and help), so the
            // dot itself is silent.
            DesktopSidebarStatusMark(tone: signal.tone)
        } else if conversation.pinned {
            // Secondary rather than tertiary: a pin mark has to clear 3:1.
            JunoIconView(.pin, size: 10, isOn: true)
                .junoSecondaryInk()
                .accessibilityHidden(true)
        }
    }

}

/// The row menu, the hover menu, the title menu and the menu bar's Chat menu:
/// one list, in one order (§2.4), so the four can never disagree.
///
/// Each row wears the web's glyph (`app-sidebar.tsx`) as a 16pt `Label`, in
/// Title Case with the web's words. The rows are data (``rows(pinned:renameTitle:showsOpenProject:)``)
/// so a test and the snapshot table can read exactly what the menu draws.
struct DesktopConversationMenu: View {
    /// The chat the rows act on. Nil in the menu bar with no saved chat on
    /// screen: the rows stay, disabled, so the Chat menu keeps its shape.
    let conversation: NativeConversation?
    let projects: [NativeProject]
    let actions: DesktopConversationActions?
    /// The title menu and the menu bar say "Rename…"; a row's menu renames in
    /// place and says "Rename".
    var renameTitle = "Rename"
    var showsOpenProject = false

    @Environment(\.undoManager) private var undoManager

    /// One row of the list: its words, its glyph, and whether it destroys.
    struct Row: Equatable, Identifiable {
        enum Kind: Equatable {
            case rename, pin, addToProject, newProject, openProject, share, archive, delete
        }

        let kind: Kind
        let title: String
        let glyph: JunoIcon
        var isDestructive = false
        /// Drawn inside Add to Project ▸, after the projects.
        var isNested = false

        var id: Kind { kind }
    }

    /// The rows, in the menu's order. Delete comes last, after the one divider.
    static func rows(pinned: Bool, renameTitle: String = "Rename", showsOpenProject: Bool = false) -> [Row] {
        var rows = [
            Row(kind: .rename, title: renameTitle, glyph: .pencil),
            Row(kind: .pin, title: pinned ? "Unpin" : "Pin", glyph: pinned ? .pinOff : .pin),
            Row(kind: .addToProject, title: "Add to Project", glyph: .projects),
            Row(kind: .newProject, title: "New Project…", glyph: .plus, isNested: true),
        ]
        if showsOpenProject {
            rows.append(Row(kind: .openProject, title: "Open Project", glyph: .folderOpen))
        }
        rows += [
            Row(kind: .share, title: "Share…", glyph: .share),
            Row(kind: .archive, title: "Archive", glyph: .archive),
            Row(kind: .delete, title: "Delete…", glyph: .trash, isDestructive: true),
        ]
        return rows
    }


    private var rows: [Row] {
        Self.rows(
            pinned: conversation?.pinned ?? false,
            renameTitle: renameTitle,
            showsOpenProject: showsOpenProject && conversation?.projectId != nil
        )
    }

    private func row(_ kind: Row.Kind) -> Row? {
        rows.first { $0.kind == kind }
    }

    // One `Section`, which a menu draws as nothing at all: it is what tells
    // the targets gate these are system-drawn menu rows, not views we lay out
    // — which is why every row is written inside it.
    var body: some View {
        Section {
            if let rename = row(.rename) {
                Button { act { $0.rename($1) } } label: { label(rename) }
                    .disabled(!isAvailable)
            }
            if let pin = row(.pin) {
                Button { act { $0.togglePin($1) } } label: { label(pin) }
                    .disabled(!isAvailable)
            }
            if let addToProject = row(.addToProject) {
                Menu {
                    Toggle(
                        "No Project",
                        isOn: Binding(
                            get: { conversation?.projectId == nil },
                            set: { if $0 { act { $0.move($1, nil) } } }
                        )
                    )
                    if !projects.isEmpty {
                        Divider()
                        ForEach(projects) { project in
                            Toggle(
                                project.name,
                                isOn: Binding(
                                    get: { conversation?.projectId == project.id },
                                    set: { if $0 { act { $0.move($1, project.id) } } }
                                )
                            )
                        }
                    }
                    Divider()
                    if let newProject = row(.newProject) {
                        Button { act { $0.newProject($1) } } label: { label(newProject) }
                    }
                } label: {
                    label(addToProject)
                }
                .disabled(!isAvailable)
            }
            if let openProject = row(.openProject), let projectID = conversation?.projectId {
                Button { actions?.openProject(projectID) } label: { label(openProject) }
                    .disabled(!isAvailable)
            }
            if let share = row(.share) {
                Button { act { $0.share($1) } } label: { label(share) }
                    .disabled(!canShare)
            }
            if let archive = row(.archive) {
                Button {
                    // The menu bar's copy of this list has no window in its
                    // environment; the key window's undo stack is the one the
                    // reader would reach with ⌘Z.
                    let undo = undoManager ?? NSApp.keyWindow?.undoManager
                    act { $0.archive($1, undo) }
                } label: {
                    label(archive)
                }
                .disabled(!isAvailable)
            }
            Divider()
            if let delete = row(.delete) {
                Button(role: .destructive) { act { $0.delete($1) } } label: { label(delete) }
                    .disabled(!isAvailable)
            }
        }
    }

    private var isAvailable: Bool { conversation != nil && actions != nil }

    private var canShare: Bool {
        guard let conversation, let actions else { return false }
        return actions.canShare(conversation)
    }

    private func act(_ perform: (DesktopConversationActions, NativeConversation) -> Void) {
        guard let conversation, let actions else { return }
        perform(actions, conversation)
    }

    private func label(_ row: Row) -> some View {
        Label {
            Text(row.title)
        } icon: {
            Image(row.glyph.assetName)
        }
    }
}

/// What a conversation's menus can do, handed down by the window that owns the
/// confirmation dialog, the share popover and the new-project sheet — so the
/// sidebar row, its hover menu and the window's title menu all reach the same
/// one of each.
struct DesktopConversationActions {
    let rename: (NativeConversation) -> Void
    let commitRename: (NativeConversation, String) -> Void
    let togglePin: (NativeConversation) -> Void
    let move: (NativeConversation, String?) -> Void
    /// Opens the New Project sheet; the conversation, when given, moves into
    /// the project it creates.
    let newProject: (NativeConversation?) -> Void
    let openProject: (String) -> Void
    let share: (NativeConversation) -> Void
    /// Whether Share… can do anything for this chat: an account with a share
    /// service, and a chat with something in it. Asked per chat so the row is
    /// disabled rather than enabled and silent — a Share… that did nothing on
    /// an empty chat was the silent Share the popover exists to replace.
    let canShare: (NativeConversation) -> Bool
    let archive: (NativeConversation, UndoManager?) -> Void
    /// Asks first (§2.4); deleting is the confirmation dialog's job.
    let delete: (NativeConversation) -> Void
}

// MARK: - Pinned project row

private struct DesktopPinnedProjectRow<ConversationRow: View>: View {
    let project: NativeProject
    let chats: [NativeConversation]
    let isSelected: Bool
    @Binding var renamingProjectID: String?
    @ViewBuilder let conversationRow: (NativeConversation) -> ConversationRow
    let newChat: () -> Void
    let unpin: () -> Void
    let rename: (String) -> Void
    let delete: () -> Void

    @State private var isExpanded = false
    @State private var showsAll = false

    private var isRenaming: Bool { renamingProjectID == project.id }

    private var visibleChats: ArraySlice<NativeConversation> {
        showsAll ? chats[...] : chats.prefix(DesktopChatSidebarContent.projectPreview)
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            ForEach(visibleChats) { conversationRow($0) }
            if chats.count > DesktopChatSidebarContent.projectPreview {
                Button {
                    showsAll.toggle()
                } label: {
                    Text(showsAll ? "Show less" : "View all \(chats.count)")
                        .junoFont(size: 12, relativeTo: .footnote)
                        .junoSecondaryInk()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .selectionDisabled()
            }
        } label: {
            label
                .junoSidebarRowSelection(isSelected)
                .tag(DesktopSidebarItem.project(project.id))
                .contextMenu {
                    Button("New Chat in Project", action: newChat)
                    Button("Unpin", action: unpin)
                    Button("Rename") { renamingProjectID = project.id }
                    Divider()
                    Button("Delete…", role: .destructive, action: delete)
                }
        }
    }

    private var label: some View {
        let ink = isSelected ? Color.junoForeground : Color.junoSidebarInk
        return Label {
            if isRenaming {
                JunoInlineRenameField(project.name, accessibilityLabel: "Rename project") { name in
                    rename(name)
                } end: {
                    renamingProjectID = nil
                }
            } else {
                Text(project.name)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        } icon: {
            JunoSymbol(isExpanded ? .folderOpen : .projects)
                .foregroundStyle(ink)
        }
        .foregroundStyle(ink)
    }

}

// MARK: - Loading

/// Six placeholder rows while the first bootstrap after sign-in fills an empty
/// store (§2.1): redacted text breathing between full and 62% opacity on the
/// skeleton period. Still under Reduce Motion.
private struct DesktopSidebarLoadingRows: View {
    private static let widths: [String] = [
        "Planning the quarterly review",
        "Draft reply to the landlord",
        "Recipes for a small kitchen",
        "Why the build is slow",
        "Notes from Tuesday",
        "A trip to Lisbon in May",
    ]

    @State private var dimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ForEach(Array(Self.widths.enumerated()), id: \.offset) { index, title in
            Text(title)
                .lineLimit(1)
                .redacted(reason: .placeholder)
                .opacity(dimmed ? 0.62 : 1)
                .animation(
                    JunoMotion.ambient(
                        JunoMotion.breathe(period: JunoMotion.Loop.skeletonBreathe),
                        when: reduceMotion
                    ),
                    value: dimmed
                )
                .selectionDisabled()
                // One announcement for the six, on the first; the rest are
                // shapes, not text anyone should hear.
                .accessibilityLabel(index == 0 ? "Loading conversations" : "")
                .accessibilityHidden(index != 0)
                .onAppear { if index == 0, !reduceMotion { dimmed = true } }
        }
    }
}

// MARK: - Destinations

enum DesktopDestination: String, CaseIterable, Identifiable {
    /// The conversation route: a chat, a draft, or a private chat.
    case chat
    /// The retired Search page, as a stored value only: the ⌘K / Search panel
    /// replaced it at integration, and ``DesktopNavigationState/normalized(_:)``
    /// turns a restored `.search` into Chat.
    case search
    case projects
    case library
    case artifacts
    /// Named, persistent teammates (docs/design/AGENTS.md): a roster, each
    /// agent's page, and hiring. A destination in Chat's column rather than a
    /// fourth product, because an agent lives in Chat — its thread is an
    /// ordinary conversation — and its tasks are Work's.
    case agents
    case connections
    /// Design, as a stored value only. The web made a design an artifact of
    /// type `DESIGN` (`app-sidebar.tsx`: `/design` redirects to
    /// `/artifacts?type=DESIGN`), so there is no Design row and no Design page:
    /// ``DesktopNavigationState/normalized(_:)`` turns this into Artifacts with
    /// the Designs filter. The case stays so stored window state and the
    /// legacy tasks window's footer (`leaveForChat(.design)`) keep decoding.
    case design
    /// What Juno remembers about the reader, as a page of its own. Reached
    /// from Settings › Memory and ⌘K through ``DesktopPageRouter``; the web
    /// moved it out of More (Phase 4 C4).
    case memory
    /// Reusable specialists (Phase 4 Stage B builds the page). A More item.
    case assistants
    /// Instructions Juno follows for a specific job (Phase 4 Stage B). A More
    /// item.
    case skills
    /// Everything that starts without a fresh prompt (Phase 4 C1). A More
    /// item.
    case automations
    /// What Juno may do, what it always asks first, and the Macs it can reach
    /// (Phase 4 C2). Not in More: reached through ``DesktopPageRouter`` —
    /// ⌘K and Settings › Devices.
    case permissions

    var id: Self { self }

    /// The navigation rows under New chat, in the web's order: Chat's
    /// destinations in the shell contract (`app-sidebar.tsx`), today Library,
    /// Projects, Artifacts, Agents. No Design row: a design is an artifact
    /// (Phase 4 A2).
    static let sidebarCases: [Self] = JunoShellChatSidebar.destinations.compactMap(Self.init)

    /// The More menu's items, in the web's order: Chat's More in the shell
    /// contract, today Assistants, Skills, Automations. Connections, Memory
    /// and Permissions left More for Settings and ⌘K, as they did on the web.
    static let moreCases: [Self] = JunoShellChatSidebar.More.items.compactMap { Self($0.destination) }

    /// The web's name for a destination it has (the shell contract), and the
    /// Mac's own for the values it does not.
    var label: String {
        switch self {
        case .chat: "Chat"
        case .search: "Search"
        case .design: "Design"
        case .memory: "Memory"
        case .permissions: "Permissions"
        case .projects, .library, .artifacts, .agents, .connections, .assistants, .skills, .automations:
            shell?.label ?? rawValue
        }
    }

    /// The website's mark for this destination — `src/lib/app-icons.ts`, via
    /// the generated catalog, and through the shell contract where the web
    /// has the destination.
    var junoIcon: JunoIcon {
        switch self {
        case .chat: .home
        case .search: .search
        case .design: .design
        case .memory: .memory
        case .permissions: .permissions
        case .projects, .library, .artifacts, .agents, .connections, .assistants, .skills, .automations:
            shell?.icon ?? .home
        }
    }
}
