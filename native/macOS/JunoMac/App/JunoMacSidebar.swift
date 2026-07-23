import JunoChatKit
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// Everything the primary sidebar can select. Destinations and individual
/// conversations share one selection so the list behaves like a single native
/// source list — arrow keys move between a project row and a chat row, and only
/// one row is ever highlighted.
enum JunoMacSidebarItem: Hashable {
    case section(JunoMacSection)
    case conversation(String)
}

/// The primary sidebar: account, New Chat, Search, the product destinations and
/// the grouped conversation history, with sync state and Settings pinned at the
/// bottom.
///
/// Deliberately built from compact rows rather than cards. A source list is a
/// dense index the reader scans; wrapping each row in its own panel triples its
/// height and halves how much history is reachable without scrolling.
struct JunoMacSidebar: View {
    @Binding var selection: JunoMacSection
    @Binding var productMode: JunoMacProductMode
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let accountName: String
    let signOut: () -> Void
    let newChat: () -> Void

    @State private var showArchived = false
    @State private var renamingID: String?
    @State private var renameValue = ""
    /// One clock read per list rebuild. Reading `Date()` inside the grouping
    /// call would make the buckets recompute on every unrelated redraw.
    /// `JunoMacDayChange` pushes a new value when the calendar day actually
    /// moves, so a window left open across midnight re-labels itself without
    /// paying for a clock read per redraw.
    @State private var groupingNow = Date()

    private var groups: [NativeConversationGroup] {
        guard let conversationModel else { return [] }
        return NativeConversationGrouping.groups(
            for: conversationModel.conversations,
            now: groupingNow
        )
    }

    private var listSelection: Binding<JunoMacSidebarItem?> {
        Binding(
            get: {
                if selection == .chat, let id = conversationModel?.selectedConversationID {
                    return .conversation(id)
                }
                return .section(selection)
            },
            set: { item in
                guard let item else { return }
                switch item {
                case .section(let section):
                    selection = section
                case .conversation(let id):
                    conversationModel?.selectedConversationID = id
                    selection = .chat
                }
            }
        )
    }

    var body: some View {
        List(selection: listSelection) {
            topSection
            destinationsSection
            historySections
        }
        .listStyle(.sidebar)
        .environment(\.defaultMinListRowHeight, 26)
        // The header region is pinned above the scrolling list so the mark and
        // the mode switch stay put however far the history is scrolled. It
        // paints no background of its own, so the system's sidebar material
        // shows through and the whole column reads as one native source list.
        .safeAreaInset(edge: .top, spacing: 0) {
            JunoMacSidebarHeader(mode: $productMode)
        }
        .navigationTitle("Juno")
        .navigationSplitViewColumnWidth(min: 208, ideal: 252, max: 360)
        .accessibilityIdentifier("juno.mac.sidebar")
        .onChange(of: conversationModel?.conversations.count) { _, _ in
            // Refresh the recency boundaries when the history changes, so a
            // conversation created after midnight does not stay in "Yesterday".
            groupingNow = Date()
        }
        .onReceive(JunoMacDayChange.signal) { now in
            // …and again when the day itself moves, so an idle window does not
            // keep yesterday's chats under "Today".
            groupingNow = now
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        .overlay { emptyState }
        .alert("chat.rename.title", isPresented: renamingBinding) {
            TextField("chat.rename.field", text: $renameValue)
            Button("common.cancel", role: .cancel) { renamingID = nil }
            Button("common.save") {
                if let id = renamingID {
                    let title = renameValue
                    Task { await conversationModel?.renameConversation(id: id, title: title) }
                }
                renamingID = nil
            }
        }
    }

    // MARK: - Sections
    //
    // Split into separate properties because one expression covering the whole
    // list — nested generics over two selection cases and seven bucket kinds —
    // exceeds the type-checker's budget.

    @ViewBuilder
    private var topSection: some View {
        Section {
            Button(action: newChat) {
                // The one accented row in the sidebar: coral marks the action,
                // not the navigation around it.
                JunoMacNavigationRow(
                    title: "chat.new",
                    systemImage: "square.and.pencil",
                    isAccented: true
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(conversationModel == nil)
            .accessibilityIdentifier("juno.mac.sidebar.new-chat")

            destinationRow(.search)
        }
    }

    @ViewBuilder
    private var destinationsSection: some View {
        Section {
            destinationRow(.projects)
            destinationRow(.library)
            destinationRow(.artifacts)
        } header: {
            Text("sidebar.group.content").junoSidebarSection()
        }
    }

    @ViewBuilder
    private var historySections: some View {
        ForEach(groups) { group in
            if group.bucket == .archived {
                Section {
                    DisclosureGroup(isExpanded: $showArchived) {
                        ForEach(group.conversations) { conversationRow($0) }
                    } label: {
                        Text(Self.title(for: .archived)).junoSidebarSection()
                    }
                }
            } else {
                Section {
                    ForEach(group.conversations) { conversationRow($0) }
                } header: {
                    Text(Self.title(for: group.bucket)).junoSidebarSection()
                }
            }
        }
    }

    /// Bucket headers are localized keys, never the raw enum case.
    static func title(for bucket: NativeConversationBucket) -> LocalizedStringKey {
        switch bucket {
        case .pinned: "chat.bucket.pinned"
        case .today: "chat.bucket.today"
        case .yesterday: "chat.bucket.yesterday"
        case .previous7Days: "chat.bucket.previous7Days"
        case .previous30Days: "chat.bucket.previous30Days"
        case .older: "chat.bucket.older"
        case .archived: "chat.bucket.archived"
        }
    }

    private var renamingBinding: Binding<Bool> {
        Binding(get: { renamingID != nil }, set: { if !$0 { renamingID = nil } })
    }

    @ViewBuilder
    private var emptyState: some View {
        if let conversationModel, conversationModel.conversations.isEmpty {
            switch conversationModel.phase {
            case .idle, .loading:
                ProgressView().controlSize(.small)
            case .failed:
                ContentUnavailableView {
                    Label("chat.list.failed.title", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(conversationModel.lastErrorDescription ?? "")
                } actions: {
                    Button("common.retry") { Task { await conversationModel.reload() } }
                }
                .background(.background)
            case .ready, .offline:
                EmptyView()
            }
        }
    }

    // MARK: - Rows

    private func destinationRow(_ section: JunoMacSection) -> some View {
        JunoMacNavigationRow(title: section.title, systemImage: section.systemImage)
            .tag(JunoMacSidebarItem.section(section))
            .accessibilityIdentifier("juno.mac.sidebar.\(section.rawValue)")
    }

    private func conversationRow(_ conversation: NativeConversation) -> some View {
        HStack(spacing: JunoSpace.tight) {
            if conversation.pinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            Text(conversation.title)
                .junoRowLabel()
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: JunoSpace.hairline)
            if conversation.isPending {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("sync.pending")
            }
        }
        .tag(JunoMacSidebarItem.conversation(conversation.id))
        .accessibilityLabel(accessibilityLabel(for: conversation))
        .contextMenu { conversationMenu(conversation) }
    }

    /// VoiceOver hears the state that sighted users read from the pin glyph and
    /// the relative timestamp, so nothing is conveyed by iconography alone.
    private func accessibilityLabel(for conversation: NativeConversation) -> Text {
        var label = Text(conversation.title)
        if conversation.pinned {
            label = label + Text(", ") + Text("chat.pinned")
        }
        if conversation.isPending {
            label = label + Text(", ") + Text("sync.pending")
        }
        return label
    }

    @ViewBuilder
    private func conversationMenu(_ conversation: NativeConversation) -> some View {
        Button("chat.rename") {
            renameValue = conversation.title
            renamingID = conversation.id
        }
        Button(conversation.pinned ? "chat.unpin" : "chat.pin") {
            Task {
                await conversationModel?.setPinned(
                    id: conversation.id,
                    pinned: !conversation.pinned
                )
            }
        }
        Divider()
        Button(
            conversation.isArchived ? "chat.unarchive" : "chat.archive",
            role: conversation.isArchived ? nil : .destructive
        ) {
            Task {
                await conversationModel?.setArchived(
                    id: conversation.id,
                    archived: !conversation.isArchived
                )
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        JunoMacSidebarFooter(
            accountName: accountName,
            openSettings: { selection = .settings },
            signOut: signOut
        ) {
            JunoMacSyncIndicator(model: syncModel)
            JunoMacIconButton(
                title: "navigation.settings",
                systemImage: "gearshape"
            ) {
                selection = .settings
            }
            .accessibilityIdentifier("juno.mac.sidebar.settings")
        }
    }
}

/// Sync state as a single compact glyph with a text alternative, never as
/// colour alone: the offline and error states differ by symbol and by label.
struct JunoMacSyncIndicator: View {
    let model: NativeSyncModel<SQLiteAccountRepository>?

    var body: some View {
        if let model {
            Button {
                Task { await model.refresh() }
            } label: {
                switch model.phase {
                case .idle, .synchronizing:
                    ProgressView().controlSize(.small)
                case .live:
                    Image(systemName: "checkmark.circle")
                case .offline:
                    Image(systemName: "wifi.slash")
                case .failed:
                    // Reached the server and cannot proceed — not a wifi problem,
                    // so it must not borrow the wifi glyph.
                    Image(systemName: "exclamationmark.triangle")
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(syncStatusTint(model.phase))
            .help(helpText(model))
            .accessibilityLabel(helpText(model))
            .accessibilityIdentifier("juno.mac.sync-status")
        }
    }

    private func syncStatusTint(
        _ phase: NativeSyncModel<SQLiteAccountRepository>.Phase
    ) -> Color {
        switch phase {
        case .offline: Color.orange
        case .failed: Color.red
        case .idle, .synchronizing, .live: Color.secondary
        }
    }

    private func helpText(_ model: NativeSyncModel<SQLiteAccountRepository>) -> Text {
        if let error = model.lastErrorDescription { return Text(error) }
        return switch model.phase {
        case .live: Text("sync.state.synced")
        case .offline: Text("sync.state.offline")
        case .failed: Text("sync.state.failed")
        case .idle, .synchronizing: Text("sync.state.syncing")
        }
    }
}
