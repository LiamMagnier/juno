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

    /// The Projects index survives a relaunch like any other destination.
    ///
    /// It encodes as a single field, unlike every other Code destination, so it is
    /// the one case where a decoder written around "kind + value" pairs would
    /// silently return nil and drop the reader back to a repository draft.
    @Test
    func theAllProjectsIndexRoundTripsThroughSceneStorage() {
        let encoded = DesktopCodeNavigationState.encode(.allProjects)
        #expect(DesktopCodeNavigationState.decode(encoded) == .allProjects)
    }

    /// Selecting the index is never invalidated by what happens to the projects
    /// under it — it names the collection, not a member of it.
    @Test
    func theAllProjectsIndexStaysValidWithNoProjects() {
        let validated = DesktopCodeNavigationState.validate(
            .allProjects,
            sessions: [],
            tasks: [],
            repositories: []
        )
        #expect(validated == .allProjects)
    }

    /// A half-typed conversation with no project survives a relaunch.
    ///
    /// It encodes as a single field like the index above, and shares that
    /// case's hazard: a decoder written around "kind + value" pairs returns nil
    /// for it, which used to mean the reader landed back on the first-run wall.
    @Test
    func theProjectlessDraftRoundTripsThroughSceneStorage() {
        let encoded = DesktopCodeNavigationState.encode(.draft)
        #expect(encoded == "draft")
        #expect(DesktopCodeNavigationState.decode(encoded) == .draft)
    }

    /// The composer names nothing that can go missing, so nothing that happens
    /// to sessions, runs or projects can invalidate it. Validating it away is
    /// how a reader on a fresh install would lose the only screen they can use.
    @Test
    func theProjectlessDraftStaysValidWithNothingGranted() {
        let validated = DesktopCodeNavigationState.validate(
            .draft,
            sessions: [],
            tasks: [],
            repositories: []
        )
        #expect(validated == .draft)
    }

    /// Scene storage outlives an app update, so a destination this build dropped
    /// must fall back rather than strand the window on a blank pane.
    ///
    /// The example used to be `"compare"`, which stopped being unknown the day
    /// Compare shipped — and the test then failed for the right reason at the
    /// wrong moment. It is now a string no build has ever written, and the second
    /// case proves the point positively: every destination this build *does* have
    /// must round-trip, so the fallback can never quietly swallow a real one.
    @Test
    func anUnknownStoredDestinationFallsBackToChat() {
        #expect(DesktopNavigationState.destination(fromStored: "moodboard") == .chat)
        #expect(DesktopNavigationState.destination(fromStored: "") == .chat)

        for destination in DesktopDestination.allCases {
            #expect(DesktopNavigationState.destination(fromStored: destination.rawValue) == destination)
        }
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
