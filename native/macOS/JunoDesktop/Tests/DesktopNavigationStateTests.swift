import Testing
@testable import JunoDesktop

/// The window's navigation rules.
///
/// These are the cases that a click-through would not reliably catch: a scene
/// storage value written by an older build, and the difference between *leaving*
/// Chat and *returning* to it. Both silently lose a user's place when they are
/// wrong, and neither shows up as a crash.
struct DesktopNavigationStateTests {
    // MARK: - Selection projection

    @Test
    func aSelectedConversationIsTheChatSelection() {
        #expect(
            DesktopNavigationState.selection(
                destination: .chat,
                selectedConversationID: "conv-1"
            ) == .conversation("conv-1")
        )
    }

    @Test
    func chatWithNoConversationSelectsTheChatDestination() {
        #expect(
            DesktopNavigationState.selection(
                destination: .chat,
                selectedConversationID: nil
            ) == .destination(.chat)
        )
    }

    /// A conversation can stay loaded while the user is on another page. The
    /// selection must follow the *page*, or the sidebar highlights a conversation
    /// while Library is on screen.
    @Test
    func anotherDestinationSelectsItselfEvenWithAConversationLoaded() {
        #expect(
            DesktopNavigationState.selection(
                destination: .library,
                selectedConversationID: "conv-1"
            ) == .destination(.library)
        )
    }

    // MARK: - Resolving a selection back to state

    @Test
    func selectingAConversationSwitchesToChatAndStopsDrafting() {
        let resolved = DesktopNavigationState.resolve(
            selection: .conversation("conv-9"),
            current: (.library, nil)
        )
        #expect(resolved.destination == .chat)
        #expect(resolved.conversationID == "conv-9")
        #expect(resolved.isDrafting == false)
    }

    @Test
    func selectingChatItselfStartsADraft() {
        let resolved = DesktopNavigationState.resolve(
            selection: .destination(.chat),
            current: (.chat, "conv-3")
        )
        #expect(resolved.destination == .chat)
        #expect(resolved.conversationID == nil)
        #expect(resolved.isDrafting)
    }

    /// The regression this exists for: navigating to Library used to be able to
    /// clear the open conversation, so coming back to Chat showed an empty draft
    /// instead of what the user had been reading.
    @Test
    func leavingChatKeepsTheOpenConversation() {
        let resolved = DesktopNavigationState.resolve(
            selection: .destination(.library),
            current: (.chat, "conv-7")
        )
        #expect(resolved.destination == .library)
        #expect(resolved.conversationID == "conv-7")
        #expect(resolved.isDrafting == false)
    }

    @Test
    func aClearedSelectionChangesNothing() {
        let resolved = DesktopNavigationState.resolve(
            selection: nil,
            current: (.tasks, "conv-2")
        )
        #expect(resolved.destination == .tasks)
        #expect(resolved.conversationID == "conv-2")
    }

    // MARK: - Restoration

    @Test
    func everyDestinationRoundTripsThroughSceneStorage() {
        for destination in DesktopDestination.allCases {
            #expect(
                DesktopNavigationState.destination(fromStored: destination.rawValue)
                    == destination
            )
        }
    }

    /// Scene storage outlives an app update, so a destination this build dropped
    /// must fall back rather than strand the window on a blank pane.
    @Test
    func anUnknownStoredDestinationFallsBackToChat() {
        #expect(DesktopNavigationState.destination(fromStored: "compare") == .chat)
        #expect(DesktopNavigationState.destination(fromStored: "") == .chat)
    }

    // MARK: - Window title

    @Test
    func theWindowTitleIsTheConversationOnChatAndThePageElsewhere() {
        #expect(
            DesktopNavigationState.windowTitle(
                destination: .chat,
                conversationTitle: "Designing the sidebar"
            ) == "Designing the sidebar"
        )
        #expect(
            DesktopNavigationState.windowTitle(destination: .chat, conversationTitle: nil)
                == "New chat"
        )
        #expect(
            DesktopNavigationState.windowTitle(
                destination: .artifacts,
                conversationTitle: "ignored"
            ) == "Artifacts"
        )
    }

    /// Every sidebar destination needs a label, because the label is the window
    /// title when that page is showing.
    @Test
    func everySidebarDestinationHasANonEmptyLabel() {
        for destination in DesktopDestination.allCases {
            #expect(destination.label.isEmpty == false)
        }
    }
}
