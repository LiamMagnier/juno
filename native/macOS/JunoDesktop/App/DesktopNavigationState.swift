import Foundation

/// The pure navigation rules behind the Chat window's sidebar.
///
/// These lived inside a `Binding` in the view body, which made them unreachable
/// from a test: the only way to check that selecting a destination did not
/// silently discard the open conversation was to run the app and click. They are
/// pure functions over the values the window keeps, so they belong here, where
/// the interesting cases — a stale stored destination, a conversation that no
/// longer exists, returning to Chat — can each be asserted.
enum DesktopNavigationState {
    /// What the sidebar's single selection should be, given the state the
    /// window actually keeps.
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
    ///
    /// An open agent is the Agents page's selection and nobody else's. A page
    /// reached other than through this column — a thread opened from the
    /// agent's page — leaves the id set, and the column must not light an
    /// agent's row while that page is on screen.
    static func selection(
        destination: DesktopDestination,
        selectedConversationID: String?,
        openProjectID: String? = nil,
        selectedAgentID: String? = nil
    ) -> DesktopSidebarItem? {
        switch destination {
        case .chat:
            return selectedConversationID.map(DesktopSidebarItem.conversation)
        case .search:
            return nil
        case .projects:
            return openProjectID.map(DesktopSidebarItem.project) ?? .destination(.projects)
        case .agents:
            return selectedAgentID.map(DesktopSidebarItem.agent) ?? .destination(.agents)
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
    ///
    /// An agent's row opens its page, which is the Agents destination with that
    /// agent pushed. The Agents row itself is the roster, so it closes whichever
    /// agent was open — the same row on the web is `/agents`, not the last
    /// agent visited.
    static func resolve(
        selection: DesktopSidebarItem?,
        current: (destination: DesktopDestination, conversationID: String?, agentID: String?)
    ) -> (destination: DesktopDestination, conversationID: String?, isDrafting: Bool, agentID: String?) {
        switch selection {
        case .conversation(let id):
            return (.chat, id, false, nil)
        case .project:
            // The page opens on that project; which one is the caller's to
            // carry, because it is a route into Projects, not window state.
            return (.projects, current.conversationID, false, nil)
        case .agent(let id):
            return (.agents, current.conversationID, false, id)
        case .destination(.chat):
            return (.chat, nil, true, nil)
        case .destination(let value):
            return (value, current.conversationID, false, nil)
        case nil:
            return (current.destination, current.conversationID, false, current.agentID)
        }
    }

    /// A stored `@SceneStorage` string, validated back into a destination.
    ///
    /// Scene storage survives app updates, so a value written by a build that had
    /// a destination this build no longer has — Tasks, Usage and Settings left
    /// the column in Phase 1 — must not strand the window on a blank pane. Those
    /// fall back to Chat like any other unknown string.
    static func destination(fromStored raw: String) -> DesktopDestination {
        normalized(DesktopDestination(rawValue: raw) ?? .chat).destination
    }

    /// The destination a request really means, and the Artifacts filter it
    /// carries. `.design` is Artifacts filtered to Designs, as the web's
    /// `/design` redirects to `/artifacts?type=DESIGN`; everything else is
    /// itself.
    static func normalized(
        _ destination: DesktopDestination
    ) -> (destination: DesktopDestination, artifactsType: String?) {
        switch destination {
        case .design: (.artifacts, designsType)
        // The Search page retired with Phase 3's panel: a window restored on
        // it opens on Chat.
        case .search: (.chat, nil)
        default: (destination, nil)
        }
    }

    /// The web's `ArtifactType` for a design (`?type=DESIGN`).
    static let designsType = "DESIGN"

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
