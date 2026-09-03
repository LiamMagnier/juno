import AVFoundation
import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoVoiceKit
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

struct DesktopChatSidebar: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let avatarModel: NativeAvatarModel?
    let workModel: NativeWorkModel?
    let codeModel: NativeCodeModel?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let session: NativeAuthenticatedSession
    @Binding var product: DesktopProductMode
    @Binding var destination: DesktopDestination
    @Binding var selection: DesktopSidebarItem?
    @Binding var requestedProjectID: String?
    var openSettingsModal: (() -> Void)? = nil
    /// Signs the account out from the footer's menu. Nil hides the item.
    var signOut: (() -> Void)? = nil
    @State private var renameProjectTarget: NativeProject?
    @State private var renameChatTarget: NativeConversation?
    @State private var renameDraft = ""
    @State private var deleteProjectTarget: NativeProject?

    private var pinnedChats: [NativeConversation] {
        model.conversations
            .filter { $0.pinned && !$0.isArchived }
            .sorted { $0.lastMessageAt > $1.lastMessageAt }
    }

    private var recentChats: [NativeConversation] {
        model.conversations
            .filter { !$0.pinned && !$0.isArchived }
            .sorted { $0.lastMessageAt > $1.lastMessageAt }
    }

    var body: some View {
        List(selection: $selection) {
            Section {
                destinationRow(.search)
                destinationRow(.chat, label: "New chat", icon: .new)
                destinationRow(.library)
                destinationRow(.projects)
                destinationRow(.artifacts)
                moreRow
            }

            Section {
                Text("Recents")
                    .junoCodeSmall()
                    .junoMetaInk()
                    .textCase(nil)
                    .accessibilityAddTraits(.isHeader)
                ForEach(pinnedChats + recentChats) { conversation in
                    conversationRow(conversation)
                }
            }
        }
        .listStyle(.sidebar)
        // The selection is still the platform's — only its colour is Juno's.
        .junoSidebarSelectionTint()
        .junoSidebarProductHeader(product: $product)
        .safeAreaInset(edge: .top, spacing: 0) {
            sidebarBrandRow
        }
        // `safeAreaBar`, not `safeAreaInset`: the bar variant is what the
        // system's bottom scroll-edge effect is measured against, and that
        // effect is what lets the footer sit on a translucent column without an
        // opaque bar painted behind it.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            accountFooter
        }
        .junoSidebarScrollEdge()
        .alert("Rename", isPresented: renamePresentation) {
            TextField("Name", text: $renameDraft)
            Button("Cancel", role: .cancel) {
                renameProjectTarget = nil
                renameChatTarget = nil
            }
            Button("Save") { commitRename() }
                .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .confirmationDialog(
            deleteProjectTarget.map { "Delete “\($0.name)”?" } ?? "",
            isPresented: Binding(
                get: { deleteProjectTarget != nil },
                set: { if !$0 { deleteProjectTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete project", role: .destructive) {
                guard let project = deleteProjectTarget else { return }
                deleteProjectTarget = nil
                Task { await projectModel?.deleteProject(id: project.id) }
            }
            Button("Cancel", role: .cancel) { deleteProjectTarget = nil }
        } message: {
            Text("Chats stay in Juno and are unlinked from the project. The project’s files are removed.")
        }
    }

    private var sidebarBrandRow: some View {
        HStack(spacing: JunoSpace.tight) {
            Text("Juno")
                .junoFont(size: 13, relativeTo: .subheadline, weight: .semibold)
                .junoInk()
            Spacer(minLength: JunoSpace.hairline)
            Button {
                NSApp.sendAction(#selector(NSSplitViewController.toggleSidebar(_:)), to: nil, from: nil)
            } label: {
                JunoIconView(.panelLeft, size: 16)
            }
            .buttonStyle(.plain)
            .help("Collapse sidebar")
            .accessibilityLabel("Collapse sidebar")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
    }

    private func destinationRow(
        _ item: DesktopDestination,
        label: String? = nil,
        icon: JunoIcon? = nil
    ) -> some View {
        // The ink is stated on the mark as well as on the label. A `Label` in a
        // `.sidebar` list resolves its icon slot against the system accent, and
        // an inherited `foregroundStyle` does not reach it — so every destination
        // glyph in this column drew coral no matter what the row said. The web
        // spends no accent here at all: one fill, one ink, resting on
        // `--sidebar-foreground` and lifting to `--foreground` when selected.
        let selected = selection == .destination(item)
        let ink = selected ? Color.junoForeground : Color.junoSidebarForeground

        return Label {
            Text(label ?? item.label)
        } icon: {
            JunoIconView(icon ?? item.junoIcon, size: 16)
                .foregroundStyle(ink)
        }
        .foregroundStyle(ink)
        // A selection changing is `standard`'s documented brief; the inline
        // 0.22 it replaces was the base rung's own duration living off the
        // ladder. The lift is a colour crossfade in place — tint-tier motion,
        // which Reduce Motion leaves alone — so it is deliberately not gated
        // behind the preference.
        .animation(JunoMotion.standard, value: selected)
        .junoSidebarRowSelection(selected)
        .tag(DesktopSidebarItem.destination(item))
    }

    private var moreRow: some View {
        Menu {
            ForEach(DesktopDestination.moreCases) { item in
                Button {
                    destination = item
                    selection = .destination(item)
                } label: {
                    JunoIconLabel(verbatim: item.label, icon: item.junoIcon, size: 16)
                }
            }
        } label: {
            Label {
                Text("More")
            } icon: {
                JunoIconView(.ellipsis, size: 16)
                    .foregroundStyle(Color.junoSidebarForeground)
            }
            .foregroundStyle(Color.junoSidebarForeground)
            .junoSidebarRowSelection(false)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .accessibilityLabel("More destinations")
        .accessibilityIdentifier("juno.desktop.sidebar.more")
    }

    private func conversationRow(_ conversation: NativeConversation) -> some View {
        HStack(spacing: JunoSpace.tight) {
            Text(conversation.title)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: JunoSpace.hairline)
            if conversation.isPending {
                ProgressView()
                    .controlSize(.mini)
                    .accessibilityLabel("Sending")
            }
            if conversation.pinned {
                JunoIconView(.pin, size: 11)
                    .junoMetaInk()
                    .accessibilityLabel("Pinned")
            }
        }
        .junoSidebarRowInk()
        .junoSidebarRowSelection(selection == .conversation(conversation.id))
        .tag(DesktopSidebarItem.conversation(conversation.id))
        .contextMenu {
            Button(conversation.pinned ? "Unpin" : "Pin") {
                Task {
                    await model.setPinned(
                        id: conversation.id,
                        pinned: !conversation.pinned
                    )
                }
            }
            Button("Rename…") { beginRename(conversation) }
            Divider()
            // One destructive action, and it really deletes: `deleteConversation`
            // enqueues `conversation.delete`, not an archive flag. There is no
            // Archive/Restore pair any more — a chat the reader is done with
            // should leave, not move to a drawer they have to remember exists.
            Button("Delete", role: .destructive) {
                Task { await model.deleteConversation(id: conversation.id) }
            }
        }
    }

    private var renamePresentation: Binding<Bool> {
        Binding(
            get: { renameProjectTarget != nil || renameChatTarget != nil },
            set: {
                if !$0 {
                    renameProjectTarget = nil
                    renameChatTarget = nil
                }
            }
        )
    }

    private func beginRename(_ project: NativeProject) {
        renameDraft = project.name
        renameProjectTarget = project
        renameChatTarget = nil
    }

    private func beginRename(_ conversation: NativeConversation) {
        renameDraft = conversation.title
        renameChatTarget = conversation
        renameProjectTarget = nil
    }

    private func commitRename() {
        let name = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        if let project = renameProjectTarget {
            Task { await projectModel?.updateProject(id: project.id, name: name) }
        } else if let conversation = renameChatTarget {
            Task { await model.renameConversation(id: conversation.id, title: name) }
        }
        renameProjectTarget = nil
        renameChatTarget = nil
    }

    /// The door to Design, a staged update, and then the account row — pinned to
    /// the bottom of the column by `safeAreaBar` rather than by being the last
    /// child of a `VStack`, so the list scrolls underneath them and they stay
    /// reachable.
    ///
    /// ``DesktopSidebarFooter`` is the same component Code's column pins, which
    /// is what stops the two from describing the same account — or the same
    /// waiting update — differently. No plan is passed: the quota meter needs a
    /// plan model this column does not read, and a meter drawn from nothing is a
    /// claim about spend that nobody made.
    ///
    /// Design sits *above* that block rather than inside it, which is the
    /// website's own arrangement: `app-sidebar.tsx` gives the row its own
    /// container and then a bordered block for the account. The footer component
    /// is about the account — who is signed in, what they have spent, what is
    /// waiting to install — and a navigation row is not one of those things.
    private var accountFooter: some View {
        VStack(spacing: 0) {
            DesktopSidebarDesignRow(isActive: destination == .design) {
                destination = .design
            }
            DesktopSidebarFooter(
                session: session,
                avatarModel: avatarModel,
                syncModel: syncModel,
                plan: nil,
                openUsage: { destination = .usage },
                openSettings: {
                    if let openSettingsModal {
                        openSettingsModal()
                    } else {
                        destination = .settings
                    }
                },
                signOut: signOut
            )
        }
    }
}

enum DesktopDestination: String, CaseIterable, Identifiable {
    case chat
    case search
    case projects
    case library
    case artifacts
    case connections
    case tasks
    /// Juno Design — the canvas, and the list of what has been drawn on it.
    ///
    /// A destination and deliberately **not** a fourth ``DesktopProductMode``. A
    /// product owns the whole window: its own source list, its own toolbar, its
    /// own `NavigationSplitView`. Design has none of those, and the website
    /// learned this the expensive way — as a fourth segment it only routed away
    /// and left Home's sidebar standing, which is why `app-sidebar.tsx` now draws
    /// it as a row in the footer. It is also absent from ``sidebarCases`` for the
    /// same reason it is absent from the web's rail: the footer is where it goes.
    case design
    /// What Juno remembers about the reader, as a page of its own rather than
    /// a sheet three clicks into Settings. Memory is something a reader
    /// *reads* — what was kept, what is proposed — and a page in the column is
    /// where a Mac keeps things to read.
    case memory
    case usage
    case settings

    var id: Self { self }

    static let sidebarCases: [Self] = [
        .search, .chat, .library, .projects, .artifacts, .connections, .tasks, .memory, .usage,
    ]

    static let moreCases: [Self] = [.connections, .tasks, .memory, .usage]

    var label: String {
        switch self {
        case .chat: "Chat"
        case .search: "Search"
        case .projects: "Projects"
        case .library: "Library"
        case .artifacts: "Artifacts"
        case .connections: "Connections"
        case .tasks: "Tasks"
        case .design: "Design"
        case .memory: "Memory"
        case .usage: "Usage"
        case .settings: "Settings"
        }
    }

    /// The website's mark for this destination — `src/lib/app-icons.ts`, via
    /// the generated catalog. Design is the pen nib the web draws for it.
    var junoIcon: JunoIcon {
        switch self {
        case .chat: .home
        case .search: .search
        case .projects: .projects
        case .library: .library
        case .artifacts: .artifacts
        case .connections: .connections
        case .tasks: .tasks
        case .settings: .settings
        case .usage: .usage
        case .design: .penTool
        case .memory: .memory
        }
    }
}

// The chat column's own sync dot lived here, drawn in `.green`/`.orange`/`.red`
// while Code's copy drew the same five states on Juno's status tokens. Both
// footers now pin `DesktopSidebarFooter`, and `DesktopSidebarSyncDot` is the
// palette that survived — see DesktopCodeAccountFooter.swift.
