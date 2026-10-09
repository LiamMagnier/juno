import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

// MARK: - Dialogs on chat surfaces (B6)

/// Deleting a conversation, in the web's words (`app-sidebar.tsx`): one
/// dialog for the row menu, the title menu, the Chat menu and Archived Chats.
enum DesktopChatDeletion {
    static let title = "Delete this conversation?"
    static let message = "This permanently removes the conversation and its messages. This can't be undone."
    /// Title Case on the Mac, the web's words ("Delete chat").
    static let confirmTitle = "Delete Chat"
    static let failure = "Delete failed."

    static func confirmation(perform: @escaping @MainActor () -> Void) -> JunoConfirmation {
        JunoConfirmation(title: title, message: message, confirmTitle: confirmTitle, confirm: perform)
    }

    /// Whether a delete took: the store drops the row as it enqueues the
    /// mutation, so a row still listed afterwards is a delete that failed.
    static func succeeded(id: String, in conversations: [NativeConversation]) -> Bool {
        !conversations.contains { $0.id == id }
    }
}

/// Rename… from the title menu or the Chat menu when the sidebar is hidden:
/// the row holds the field, so the sidebar comes back first (B6).
enum DesktopChatRename {
    static func columns(forRenameFrom visibility: NavigationSplitViewVisibility) -> NavigationSplitViewVisibility {
        visibility == .detailOnly ? .all : visibility
    }
}

// MARK: - Archived Chats

/// The rows Archived Chats lists: this Mac's chats (never Code's) that carry
/// `archivedAt`, most recently archived first.
///
/// From the local store rather than `GET /api/conversations?archived=only`:
/// the sync projection carries every conversation with its `archivedAt`
/// (`src/lib/sync-entities.ts`), so chats archived before this Mac first
/// synced are here too, and the list works offline.
enum DesktopArchivedChats {
    static func rows(from conversations: [NativeConversation]) -> [NativeConversation] {
        conversations
            .filter { $0.kind == "chat" && $0.isArchived }
            .sorted { ($0.archivedAt ?? .distantPast) > ($1.archivedAt ?? .distantPast) }
    }

    enum Load: Equatable {
        case loading
        case failed
        case ready([NativeConversation])
    }

    /// The list's state from the conversation model's.
    static func load(
        phase: NativeConversationModel<SQLiteAccountRepository>.Phase,
        conversations: [NativeConversation]
    ) -> Load {
        if conversations.isEmpty {
            switch phase {
            case .idle, .loading: return .loading
            case .failed: return .failed
            case .ready, .offline: break
            }
        }
        return .ready(rows(from: conversations))
    }
}

/// Archived Chats (Phase 3 brief, B5; register P3-18): a fitted sheet at the
/// web's small size, 480 × 520, on the system's own ground.
///
/// Restore sends a chat back to Recent; Delete asks first. A failure is said
/// under its row for six seconds — never as a toast, which a sheet does not
/// host. **The signature detail** is a restored row leaving the list: the
/// visible sign it went back to Recent.
struct DesktopArchivedChatsSheet: View {
    let load: DesktopArchivedChats.Load
    /// Returns whether the chat is back in Recent.
    let restore: (NativeConversation) async -> Bool
    /// Returns whether the chat is gone.
    let delete: (NativeConversation) async -> Bool
    let open: (String) -> Void
    let done: () -> Void

    static let size = CGSize(width: 480, height: 520)

    /// The sheet's height for what it shows: its header and footer (150),
    /// then the empty state's panel (136) for an empty or failed list, four skeleton rows loading, and
    /// the rows themselves up to 360 once ready. Explicit in every state (the
    /// crash rules), and fitted, so a two-word empty state is not 60% blank.
    static func height(for load: DesktopArchivedChats.Load) -> CGFloat {
        let chrome: CGFloat = 150
        switch load {
        case .loading: return chrome + 4 * 50
        case .failed: return chrome + 136
        case .ready(let rows): return rows.isEmpty ? chrome + 136 : chrome + min(CGFloat(rows.count) * 50, 360)
        }
    }

    /// Rows on their way out, hidden while their change is in flight.
    @State private var leaving: Set<String> = []
    /// A failure under a row, by conversation.
    @State private var failures: [String: String] = [:]
    @State private var confirmation: JunoConfirmation?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Archived chats")
                .junoType(.heading)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            Text("Archived chats stay searchable. Restore one to bring it back to Recent.")
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.tight)
            list
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .padding(.top, JunoSpace.regular)
            HStack {
                Spacer()
                Button("Done", action: done)
                    .buttonStyle(.junoGlass)
                    .tint(nil)
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
            }
            .padding(.top, JunoSpace.regular)
        }
        .padding(JunoSpace.roomy)
        .frame(width: Self.size.width, height: Self.height(for: load), alignment: .topLeading)
        .junoConfirmation($confirmation)
        .accessibilityIdentifier("juno.desktop.archived-chats")
    }

    @ViewBuilder
    private var list: some View {
        switch load {
        case .loading:
            VStack(spacing: 2) {
                ForEach(0..<4, id: \.self) { _ in
                    JunoSkeleton(height: 48, cornerRadius: JunoRadius.control)
                }
            }
            .accessibilityElement()
            .accessibilityLabel("Loading archived chats")
        case .failed:
            JunoEmptyState(title: "Couldn’t load archived chats.", icon: .error, size: .panel, tone: .error)
        case .ready(let rows):
            let visible = rows.filter { !leaving.contains($0.id) || failures[$0.id] != nil }
            if visible.isEmpty {
                JunoEmptyState(title: "Nothing archived.", icon: .archive, size: .panel)
            } else {
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(visible, id: \.id) { conversation in
                            DesktopArchivedChatRow(
                                conversation: conversation,
                                failure: failures[conversation.id],
                                open: {
                                    open(conversation.id)
                                    done()
                                },
                                restore: { restoreRow(conversation) },
                                delete: { confirmDelete(conversation) }
                            )
                            .transition(.asymmetric(insertion: .opacity, removal: .opacity))
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
    }

    private func restoreRow(_ conversation: NativeConversation) {
        withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion, tier: .tint)) {
            _ = leaving.insert(conversation.id)
            failures[conversation.id] = nil
        }
        Task {
            let restored = await restore(conversation)
            if !restored { fail(conversation.id, "Couldn’t restore the chat.") }
        }
    }

    private func confirmDelete(_ conversation: NativeConversation) {
        confirmation = DesktopChatDeletion.confirmation {
            withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion, tier: .tint)) {
                _ = leaving.insert(conversation.id)
                failures[conversation.id] = nil
            }
            Task {
                let deleted = await delete(conversation)
                if !deleted { fail(conversation.id, DesktopChatDeletion.failure) }
            }
        }
    }

    /// The row comes back with the reason under it, for six seconds.
    private func fail(_ id: String, _ message: String) {
        withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint)) {
            leaving.remove(id)
            failures[id] = message
        }
        Task {
            try? await Task.sleep(for: .seconds(6))
            withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion, tier: .tint)) {
                if failures[id] == message { failures[id] = nil }
            }
        }
    }
}

/// One archived chat: its title over "Archived {date}", Restore and Delete.
private struct DesktopArchivedChatRow: View {
    let conversation: NativeConversation
    let failure: String?
    let open: () -> Void
    let restore: () -> Void
    let delete: () -> Void

    @State private var isHovering = false
    @Environment(\.locale) private var locale

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                Button(action: open) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(conversation.title.isEmpty ? "New chat" : conversation.title)
                            .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Text(Self.archivedLabel(conversation.archivedAt, locale: locale))
                            .junoFont(size: 11, relativeTo: .caption2)
                            .monospacedDigit()
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the chat")
                DesktopArchivedRowButton(icon: .archiveRestore, label: "Restore", isDestructive: false, action: restore)
                DesktopArchivedRowButton(icon: .trash, label: "Delete", isDestructive: true, action: delete)
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(minHeight: 48)
            if let failure {
                Text(failure)
                    .junoFont(size: 11, relativeTo: .caption2)
                    .foregroundStyle(Color.junoDestructiveInk)
                    .padding(.horizontal, JunoSpace.snug)
                    .padding(.bottom, JunoSpace.snug)
                    .transition(.opacity)
                    .accessibilityAddTraits(.isStaticText)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(Color.junoHover)
                .opacity(isHovering ? 1 : 0)
        )
        .contentShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
        .onHover { isHovering = $0 }
        .animation(JunoMotion.fast, value: isHovering)
    }

    /// "Archived 9/22/2026", as the web's `toLocaleDateString()` says it.
    static func archivedLabel(_ date: Date?, locale: Locale = .current) -> String {
        guard let date else { return "Archived" }
        return "Archived \(date.formatted(Date.FormatStyle(date: .numeric, time: .omitted).locale(locale)))"
    }
}

/// Restore or Delete: a 28pt icon button, the destructive ink on hover for
/// Delete.
private struct DesktopArchivedRowButton: View {
    let icon: JunoIcon
    let label: String
    let isDestructive: Bool
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            JunoIconView(icon, size: 16)
                .foregroundStyle(
                    isHovering
                        ? (isDestructive ? Color.junoDestructiveInk : Color.junoForeground)
                        : Color.junoSecondaryInk
                )
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous)
                        .fill(Color.junoHover)
                        .opacity(isHovering ? 1 : 0)
                )
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .contentShape(.rect)
        .onHover { isHovering = $0 }
        .help(label)
        .accessibilityLabel(label)
    }
}
