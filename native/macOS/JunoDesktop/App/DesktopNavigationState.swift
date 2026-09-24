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
    /// An open agent is the Agents page's selection and nobody else's. A page
    /// reached other than through this column — a thread opened from the
    /// agent's page, Design from the footer — leaves the id set, and the column
    /// must not light an agent's row while that page is on screen.
    static func selection(
        destination: DesktopDestination,
        selectedConversationID: String?,
        selectedAgentID: String?
    ) -> DesktopSidebarItem {
        if destination == .chat, let selectedConversationID {
            return .conversation(selectedConversationID)
        }
        if destination == .agents, let selectedAgentID {
            return .agent(selectedAgentID)
        }
        return .destination(destination)
    }

    /// The state change a sidebar selection implies.
    ///
    /// Selecting a conversation implies the Chat destination. Selecting Chat
    /// itself means "new chat", so it clears the conversation. Selecting any
    /// other destination deliberately leaves `conversationID` untouched, so
    /// coming back to Chat returns the reader to where they were instead of an
    /// empty draft.
    ///
    /// An agent's row opens its page, which is the Agents destination with that
    /// agent open. The Agents row itself is the roster, so it closes whichever
    /// agent was open — the same row on the web is `/agents`, not the last
    /// agent visited.
    static func resolve(
        selection: DesktopSidebarItem?,
        current: (destination: DesktopDestination, conversationID: String?, agentID: String?)
    ) -> (destination: DesktopDestination, conversationID: String?, isDrafting: Bool, agentID: String?) {
        switch selection {
        case .conversation(let id):
            return (.chat, id, false, nil)
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
    /// a destination this build no longer has must not strand the window on a
    /// blank pane.
    static func destination(fromStored raw: String) -> DesktopDestination {
        DesktopDestination(rawValue: raw) ?? .chat
    }

    /// The window's title for a given state.
    static func windowTitle(
        destination: DesktopDestination,
        conversationTitle: String?
    ) -> String {
        guard destination == .chat else { return destination.label }
        return conversationTitle ?? "New chat"
    }
}
