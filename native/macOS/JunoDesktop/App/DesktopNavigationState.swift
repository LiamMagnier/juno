import Foundation

/// The pure navigation rules behind the Chat window's sidebar.
///
/// These lived inside a `Binding` in the view body, which made them unreachable
/// from a test: the only way to check that selecting a destination did not
/// silently discard the open conversation was to run the app and click. They are
/// pure functions over two values, so they belong here, where the interesting
/// cases — a stale stored destination, a conversation that no longer exists,
/// returning to Chat — can each be asserted.
enum DesktopNavigationState {
    /// What the sidebar's single selection should be, given the two pieces of
    /// state the window actually keeps.
    ///
    /// **A draft selects nothing.** "New chat" is an untagged button at the top
    /// of the column, not a destination the reader is *on*: an empty draft is
    /// the absence of a conversation, and highlighting the button that made it
    /// told the reader they were inside a row when they were not. So the chat
    /// route with no conversation — and the search route, which has no row of
    /// its own until the ⌘K panel replaces it — resolve to `nil`, and no row is
    /// drawn selected (§2.3).
    ///
    /// `openProjectID` is the pinned project whose page is up, if a pinned
    /// project's row opened it: that row, not the Projects row, is then the
    /// selection.
    static func selection(
        destination: DesktopDestination,
        selectedConversationID: String?,
        openProjectID: String? = nil
    ) -> DesktopSidebarItem? {
        switch destination {
        case .chat:
            return selectedConversationID.map(DesktopSidebarItem.conversation)
        case .search:
            return nil
        case .projects:
            return openProjectID.map(DesktopSidebarItem.project) ?? .destination(.projects)
        default:
            return .destination(destination)
        }
    }

    /// The state change a sidebar selection implies.
    ///
    /// Selecting a conversation implies the Chat destination. Selecting any
    /// other destination deliberately leaves `conversationID` untouched, so
    /// coming back to Chat returns the reader to where they were instead of an
    /// empty draft. A cleared selection — ⌘-clicking the selected row, or the
    /// list letting go when a draft begins — changes nothing: a new draft is
    /// started by the New chat button, never by the list losing its selection.
    ///
    /// `.destination(.chat)` is still honoured as "start a draft" because the
    /// value exists and a caller holding one should get the obvious answer,
    /// but the column no longer tags a row with it.
    static func resolve(
        selection: DesktopSidebarItem?,
        current: (destination: DesktopDestination, conversationID: String?)
    ) -> (destination: DesktopDestination, conversationID: String?, isDrafting: Bool) {
        switch selection {
        case .conversation(let id):
            return (.chat, id, false)
        case .project:
            // The page opens on that project; which one is the caller's to
            // carry, because it is a route into Projects, not window state.
            return (.projects, current.conversationID, false)
        case .destination(.chat):
            return (.chat, nil, true)
        case .destination(let value):
            return (value, current.conversationID, false)
        case nil:
            return (current.destination, current.conversationID, false)
        }
    }

    /// A stored `@SceneStorage` string, validated back into a destination.
    ///
    /// Scene storage survives app updates, so a value written by a build that had
    /// a destination this build no longer has — Tasks, Usage and Settings left
    /// the column in Phase 1 — must not strand the window on a blank pane. Those
    /// fall back to Chat like any other unknown string.
    static func destination(fromStored raw: String) -> DesktopDestination {
        DesktopDestination(rawValue: raw) ?? .chat
    }

    /// The window's title for a given state: what the Window menu, Mission
    /// Control and ⌘` call this window, and what the toolbar shows on a chat.
    ///
    /// Never empty. The window used to set `.navigationTitle("")`, which left
    /// the Window menu listing a row with no name. A draft is "New chat", a
    /// private chat is "Incognito chat" (the web's copy), and a page is its own
    /// name.
    static func windowTitle(
        destination: DesktopDestination,
        conversationTitle: String?,
        isPrivate: Bool = false
    ) -> String {
        guard destination == .chat else { return destination.label }
        if isPrivate { return "Incognito chat" }
        guard let conversationTitle,
            !conversationTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return "New chat" }
        return conversationTitle
    }
}
