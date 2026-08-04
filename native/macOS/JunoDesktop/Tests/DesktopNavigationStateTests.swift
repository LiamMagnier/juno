import JunoCodeCore
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
    /// The example is deliberately a string no build has ever written. An
    /// earlier one named a destination that later shipped, so the test began
    /// failing for the right reason at the wrong moment — and a destination that
    /// is only *retired* is no safer, because scene storage still holds it. The
    /// second case proves the point positively: every destination this build
    /// *does* have must round-trip, so the fallback can never quietly swallow a
    /// real one.
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

    // MARK: - Round-tripping the whole vocabulary

    /// Every Code selection survives scene storage, checked as a set rather than
    /// one case at a time.
    ///
    /// The two existing round-trip tests above were written for `allProjects` and
    /// `draft` because those encode as a *single* field and a decoder built
    /// around "kind + value" pairs returns nil for them. That hazard is not a
    /// property of those two cases — it belongs to the shape, and `connections`,
    /// `usage` and `settings` were added later with exactly the same shape. A
    /// list that has to be extended by hand every time a destination is added is
    /// the kind of test that passes forever while the coverage rots, so this
    /// enumerates the vocabulary in one place and fails the moment a new case is
    /// added without a decoder arm to match.
    @Test
    func everySelectionSurvivesSceneStorage() {
        let everySelection: [DesktopCodeSidebarItem] = [
            .allProjects,
            .draft,
            .pulls,
            .connections,
            .usage,
            .settings,
            .repository(WorkspaceID(value: "ws-1")),
            .session(CodeSessionID(value: "sess-1")),
            .task("task-1"),
            .remote(deviceID: "device-1", sessionID: "sess-2"),
        ]

        for selection in everySelection {
            let encoded = DesktopCodeNavigationState.encode(selection)
            #expect(
                encoded.isEmpty == false,
                "\(selection) encoded to nothing, which decodes as no selection at all"
            )
            #expect(
                DesktopCodeNavigationState.decode(encoded) == selection,
                "\(selection) did not survive encode → decode (got \(encoded))"
            )
        }
    }

    /// The account-level pages are never invalidated by what happens locally.
    ///
    /// Usage, Settings, Connections and the pull request list name pages on the
    /// account, not local records — so validating them against empty sessions,
    /// tasks and repositories has to leave them alone. Dropping one would send a
    /// reader who reopened the window on Usage back to a blank Code canvas with
    /// no explanation.
    @Test
    func accountLevelPagesSurviveValidationAgainstAnEmptyWorkspace() {
        for page in [
            DesktopCodeSidebarItem.pulls, .connections, .usage, .settings, .draft, .allProjects,
        ] {
            #expect(
                DesktopCodeNavigationState.validate(
                    page,
                    sessions: [],
                    tasks: [],
                    repositories: []
                ) == page,
                "\(page) was invalidated by an empty workspace"
            )
        }
    }

    /// A selection naming a record that is gone is dropped rather than restored.
    @Test
    func selectionsNamingMissingRecordsAreDropped() {
        let gone: [DesktopCodeSidebarItem] = [
            .session(CodeSessionID(value: "deleted")),
            .task("deleted"),
            .repository(WorkspaceID(value: "deleted")),
        ]
        for selection in gone {
            #expect(
                DesktopCodeNavigationState.validate(
                    selection,
                    sessions: [],
                    tasks: [],
                    repositories: []
                ) == nil,
                "\(selection) should not survive when the record it names is gone"
            )
        }
    }
}
