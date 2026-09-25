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
    /// Opens search. The ⌘K / Search panel is Phase 3 (§7.4); until it lands
    /// this is the existing Search page.
    let openSearch: () -> Void
    /// The account's agents, for the fold under the destinations. Nil or an
    /// empty roster draws no fold at all.
    var agentsModel: NativeAgentsModel? = nil
    /// Opens an agent's thread by the agent's id, creating it if it has none.
    var messageAgent: ((String) -> Void)? = nil

    @AppStorage("juno.sidebar.projects.expanded") private var pinnedProjectsOpen = true
    @AppStorage("juno.sidebar.pinned.expanded") private var pinnedChatsOpen = true
    @AppStorage("juno.sidebar.recent.expanded") private var recentOpen = true
    /// The Agents fold's state is the reader's, and it survives a relaunch: a
    /// column that reopened every agent after it had been folded away would
    /// be a column arguing with the person who arranged it.
    @AppStorage("juno.desktop.sidebar.agents.collapsed") private var agentsCollapsed = false
    /// How many Recent rows are drawn. Grows a page at a time as the last one
    /// scrolls into view (§2.1), so a four-year history is not four thousand
    /// rows laid out on launch.
    @State private var recentLimit = DesktopChatSidebarContent.recentPage
    /// While on, every section but Needs you hides (§2.5).
    @State private var filterToNeedsYou = false
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
    /// asked. Phase 5 fills this from each chat's newest run; until then the
    /// slot exists and nothing is in it, so the fold never draws.
    private var needsYou: [NativeConversation] { [] }

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
                if let agentsModel, !agentsModel.agents.isEmpty {
                    Section(isExpanded: agentsExpanded) {
                        ForEach(agentsModel.sidebarAgents) { agent in
                            agentRow(agent)
                        }
                    } header: {
                        Text("Agents").textCase(nil)
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
                        Text("Pinned chats").textCase(nil)
                    }
                }

                if !recent.isEmpty {
                    Section(isExpanded: $recentOpen) {
                        ForEach(recent.prefix(recentLimit)) { conversation in
                            conversationRow(conversation)
                                .onAppear { loadMoreIfLast(conversation, in: recent) }
                        }
                    } header: {
                        Text("Recent").textCase(nil)
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
        // One search surface, as on the web: a button that looks like a field
        // and opens search, never a live field of its own (§2.2).
        .safeAreaBar(edge: .top, spacing: 0) {
            DesktopSidebarSearchButton(action: openSearch)
                .padding(.horizontal, JunoSpace.close)
                .padding(.bottom, JunoSpace.tight)
        }
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
            if count > previous {
                AccessibilityNotification.Announcement(
                    count == 1 ? "1 chat needs you" : "\(count) chats need you"
                ).post()
            }
        }
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
                Text("New chat")
            } icon: {
                JunoSymbol(.new)
                    .foregroundStyle(Color.junoSidebarInk)
            }
            .foregroundStyle(Color.junoSidebarInk)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("New chat  ⌘N")
        .accessibilityIdentifier("juno.desktop.sidebar.new-chat")

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
    /// Items appear as their pages land (§2.3): Phase 1 has Connections and a
    /// temporary Memory, which leaves when ⌘K can reach it. An unbuilt item is
    /// absent, not disabled.
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
        } label: {
            Label {
                Text("More")
            } icon: {
                JunoSymbol(.more)
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
        .accessibilityLabel("More")
        .accessibilityIdentifier("juno.desktop.sidebar.more")
    }

    // MARK: Sections

    /// "Needs you · n" — a filter, not a destination. Pressing it hides every
    /// other section until it is pressed again or the count reaches zero.
    private var needsYouHeader: some View {
        Button {
            filterToNeedsYou.toggle()
        } label: {
            Text("Needs you · \(needsYou.count)")
                .textCase(nil)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(filterToNeedsYou ? "Show everything" : "Show only these")
        .accessibilityAddTraits(filterToNeedsYou ? .isSelected : [])
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
            if agent.state == .waiting {
                NativeAgentNeedsYouDot()
            }
        }
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
            Text("Pinned projects").textCase(nil)
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
            Text("No conversations yet.")
                .junoFont(size: 13, relativeTo: .callout)
                .junoSecondaryInk()
            // Secondary, not tertiary: tertiary ink is 2.89:1 on the light
            // canvas and may only carry non-essential text of 13pt and up.
            Text("Start one above.")
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

    /// The scroll identity of a chat's own row. Namespaced, because a pinned
    /// project lists the same chat again under itself and the two must not
    /// answer to one id.
    static func scrollID(for conversationID: String) -> String {
        "conversation-row:\(conversationID)"
    }
}

// MARK: - Search button

/// A button dressed as a field (§2.2): the one way into search from the column.
///
/// The keycap names the shortcut that opens search **today**, ⇧⌘F. It becomes
/// ⌘K when the command panel lands (Phase 3); a keycap promising a shortcut
/// that does nothing yet would be the one lie on the column.
struct DesktopSidebarSearchButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.search, size: 14)
                Text("Search")
                    .junoFont(size: 13, relativeTo: .callout)
                Spacer(minLength: 0)
                // Keycaps take secondary ink, never tertiary: they have to be
                // read (errata, accessibility).
                Text("⇧⌘F")
                    .junoFont(size: 11, relativeTo: .caption2)
            }
            .junoSecondaryInk()
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 28)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(Color.junoGlassFill)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .help("Search  ⇧⌘F")
        .accessibilityLabel("Search")
        .accessibilityIdentifier("juno.desktop.sidebar.search")
    }
}

// MARK: - Conversation row

/// One conversation: its title, and at most one trailing mark.
///
/// No leading glyph and no bullet — the column is a list of titles. The mark
/// is chosen in the web's priority order: a send still pending, then the
/// overflow menu while the row is hovered or selected, then (Phase 5) the
/// newest run's status dot, then the pin.
private struct DesktopConversationRow: View {
    let conversation: NativeConversation
    let isSelected: Bool
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
            trailingMark
        }
        .junoSidebarRowInk()
        .onHover { isHovering = $0 }
        .onChange(of: conversation.title) { _, _ in
            if justRenamed { acknowledgeRename() }
        }
        .help(conversation.title)
        .contextMenu {
            DesktopConversationMenu(conversation: conversation, projects: projects, actions: actions)
        }
        .accessibilityValue(conversation.pinned ? "Pinned" : "")
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
                JunoIconView(.more, size: 16)
                    .frame(width: 28, height: 20)
                    .contentShape(.rect)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("More")
            .accessibilityLabel("Chat options")
        } else if conversation.pinned {
            // Secondary rather than tertiary: a pin mark has to clear 3:1.
            JunoIconView(.pin, size: 10, isOn: true)
                .junoSecondaryInk()
                .accessibilityHidden(true)
        }
    }

}

/// The row menu, the hover menu and (minus Rename's ellipsis) the title menu:
/// one list, in one order (§2.4), so the three can never disagree.
struct DesktopConversationMenu: View {
    let conversation: NativeConversation
    let projects: [NativeProject]
    let actions: DesktopConversationActions
    /// The title menu says "Rename…"; a row's menu renames in place and says
    /// "Rename".
    var renameTitle = "Rename"
    var showsOpenProject = false

    @Environment(\.undoManager) private var undoManager

    // One `Section`, which a menu draws as nothing at all: it is what tells
    // the targets gate these are system-drawn menu rows, not views we lay out.
    var body: some View {
        Section {
            items
        }
    }

    @ViewBuilder
    private var items: some View {
        Button(renameTitle) { actions.rename(conversation) }
        Button(conversation.pinned ? "Unpin" : "Pin") { actions.togglePin(conversation) }
        Menu("Add to Project") {
            Toggle(
                "No Project",
                isOn: Binding(
                    get: { conversation.projectId == nil },
                    set: { if $0 { actions.move(conversation, nil) } }
                )
            )
            if !projects.isEmpty {
                Divider()
                ForEach(projects) { project in
                    Toggle(
                        project.name,
                        isOn: Binding(
                            get: { conversation.projectId == project.id },
                            set: { if $0 { actions.move(conversation, project.id) } }
                        )
                    )
                }
            }
            Divider()
            Button("New Project…") { actions.newProject(conversation) }
        }
        if showsOpenProject, let projectID = conversation.projectId {
            Button("Open Project") { actions.openProject(projectID) }
        }
        Button("Share…") { actions.share(conversation) }
            .disabled(!actions.canShare(conversation))
        Button("Archive") { actions.archive(conversation, undoManager) }
        Divider()
        Button("Delete…", role: .destructive) { actions.delete(conversation) }
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
    /// The Search page. Reached from the column's Search button and ⇧⌘F; it
    /// has no row of its own and is replaced by the ⌘K panel in Phase 3.
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
    /// Juno Design — the canvas, and the list of what has been drawn on it.
    ///
    /// A destination and deliberately **not** a ``DesktopProductMode``. A
    /// product owns the whole window: its own source list, its own toolbar, its
    /// own `NavigationSplitView`. Design has none of those. It is a navigation
    /// row (§2.1), no longer a footer row: the footer is about the account.
    case design
    /// What Juno remembers about the reader, as a page of its own. A temporary
    /// More item until ⌘K reaches it (Phase 3), after which Settings › Memory
    /// links to it.
    case memory

    var id: Self { self }

    /// The navigation rows under New chat, in the web's order
    /// (`app-sidebar.tsx`): Library, Projects, Artifacts, Design, Agents.
    static let sidebarCases: [Self] = [.library, .projects, .artifacts, .design, .agents]

    /// The More menu's items, as their pages exist (§2.3).
    static let moreCases: [Self] = [.connections, .memory]

    var label: String {
        switch self {
        case .chat: "Chat"
        case .search: "Search"
        case .projects: "Projects"
        case .library: "Library"
        case .artifacts: "Artifacts"
        case .agents: "Agents"
        case .connections: "Connections"
        case .design: "Design"
        case .memory: "Memory"
        }
    }

    /// The website's mark for this destination — `src/lib/app-icons.ts`, via
    /// the generated catalog.
    var junoIcon: JunoIcon {
        switch self {
        case .chat: .home
        case .search: .search
        case .projects: .projects
        case .library: .library
        case .artifacts: .artifacts
        case .agents: .agents
        case .connections: .connections
        case .design: .design
        case .memory: .memory
        }
    }
}
