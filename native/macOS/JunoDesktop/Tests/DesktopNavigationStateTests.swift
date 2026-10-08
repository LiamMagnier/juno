import Foundation
import JunoCodeCore
import JunoCodeUI
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
                selectedConversationID: "conv-1",
                selectedAgentID: nil
            ) == .conversation("conv-1")
        )
    }

    /// An empty draft selects nothing (§2.3 of the Liquid Glass redesign).
    ///
    /// New chat is an untagged button, not a row the reader is on, so the
    /// chat route with no conversation must resolve to no selection at all —
    /// otherwise the column highlights the button that made the draft, or
    /// the last conversation, while the reader is in neither.
    @Test
    func aDraftSelectsNothing() {
        #expect(
            DesktopNavigationState.selection(
                destination: .chat,
                selectedConversationID: nil,
                selectedAgentID: nil
            ) == nil
        )
    }

    /// `.search` is the retired Search page's stored value and has no row;
    /// the column must not claim some other row is open for it.
    @Test
    func theSearchPageSelectsNothing() {
        #expect(
            DesktopNavigationState.selection(
                destination: .search,
                selectedConversationID: "conv-1"
            ) == nil
        )
    }

    /// A pinned project's row is the selection while the page it opened is
    /// up; with no pinned project open, the Projects row is.
    @Test
    func aPinnedProjectRowIsTheSelectionForItsPage() {
        #expect(
            DesktopNavigationState.selection(
                destination: .projects,
                selectedConversationID: "conv-1",
                openProjectID: "proj-1"
            ) == .project("proj-1")
        )
        #expect(
            DesktopNavigationState.selection(
                destination: .projects,
                selectedConversationID: nil
            ) == .destination(.projects)
        )
    }

    @Test
    func selectingAPinnedProjectOpensProjectsAndKeepsTheConversation() {
        let resolved = DesktopNavigationState.resolve(
            selection: .project("proj-2"),
            current: (.chat, "conv-5", nil)
        )
        #expect(resolved.destination == .projects)
        #expect(resolved.conversationID == "conv-5")
        #expect(resolved.isDrafting == false)
    }

    /// A conversation can stay loaded while the user is on another page. The
    /// selection must follow the *page*, or the sidebar highlights a conversation
    /// while Library is on screen.
    @Test
    func anotherDestinationSelectsItselfEvenWithAConversationLoaded() {
        #expect(
            DesktopNavigationState.selection(
                destination: .library,
                selectedConversationID: "conv-1",
                selectedAgentID: nil
            ) == .destination(.library)
        )
    }

    // MARK: - Resolving a selection back to state

    @Test
    func selectingAConversationSwitchesToChatAndStopsDrafting() {
        let resolved = DesktopNavigationState.resolve(
            selection: .conversation("conv-9"),
            current: (.library, nil, nil)
        )
        #expect(resolved.destination == .chat)
        #expect(resolved.conversationID == "conv-9")
        #expect(resolved.isDrafting == false)
    }

    @Test
    func selectingChatItselfStartsADraft() {
        let resolved = DesktopNavigationState.resolve(
            selection: .destination(.chat),
            current: (.chat, "conv-3", nil)
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
            current: (.chat, "conv-7", nil)
        )
        #expect(resolved.destination == .library)
        #expect(resolved.conversationID == "conv-7")
        #expect(resolved.isDrafting == false)
    }

    /// The list letting go of its selection — which is what a new draft looks
    /// like from the list's side — must not navigate anywhere or start a draft.
    @Test
    func aClearedSelectionChangesNothing() {
        let resolved = DesktopNavigationState.resolve(
            selection: nil,
            current: (.library, "conv-2", nil)
        )
        #expect(resolved.destination == .library)
        #expect(resolved.conversationID == "conv-2")
        #expect(resolved.isDrafting == false)
    }

    // MARK: - Agents

    @Test
    func anOpenAgentIsTheAgentsPagesSelection() {
        #expect(
            DesktopNavigationState.selection(
                destination: .agents,
                selectedConversationID: "conv-1",
                selectedAgentID: "agent-1"
            ) == .agent("agent-1")
        )
        #expect(
            DesktopNavigationState.selection(
                destination: .agents,
                selectedConversationID: nil,
                selectedAgentID: nil
            ) == .destination(.agents)
        )
    }

    /// The id can outlive the page — opening an agent's thread from its page
    /// leaves it set — and an agent row lit under a conversation or Library
    /// would be the column pointing at something that is not on screen.
    @Test
    func anOpenAgentIsNotTheSelectionAnywhereElse() {
        #expect(
            DesktopNavigationState.selection(
                destination: .chat,
                selectedConversationID: "conv-1",
                selectedAgentID: "agent-1"
            ) == .conversation("conv-1")
        )
        #expect(
            DesktopNavigationState.selection(
                destination: .library,
                selectedConversationID: nil,
                selectedAgentID: "agent-1"
            ) == .destination(.library)
        )
    }

    /// An agent's row opens its page and, like every page but Chat, keeps the
    /// conversation to come back to.
    @Test
    func selectingAnAgentOpensItsPageAndKeepsTheConversation() {
        let resolved = DesktopNavigationState.resolve(
            selection: .agent("agent-4"),
            current: (.chat, "conv-4", nil)
        )
        #expect(resolved.destination == .agents)
        #expect(resolved.agentID == "agent-4")
        #expect(resolved.conversationID == "conv-4")
        #expect(resolved.isDrafting == false)
    }

    /// The Agents row is the roster, as `/agents` is on the web — not the last
    /// agent visited.
    @Test
    func theAgentsRowIsTheRoster() {
        let resolved = DesktopNavigationState.resolve(
            selection: .destination(.agents),
            current: (.agents, nil, "agent-2")
        )
        #expect(resolved.destination == .agents)
        #expect(resolved.agentID == nil)
    }

    @Test
    func aClearedSelectionKeepsTheOpenAgent() {
        let resolved = DesktopNavigationState.resolve(
            selection: nil,
            current: (.agents, nil, "agent-3")
        )
        #expect(resolved.destination == .agents)
        #expect(resolved.agentID == "agent-3")
    }

    // MARK: - Restoration

    @Test
    func everyDestinationRoundTripsThroughSceneStorage() {
        // Design reads back as Artifacts (A2); Search, retired with Phase 3's
        // panel, as Chat (integration).
        for destination in DesktopDestination.allCases where destination != .design && destination != .search {
            #expect(
                DesktopNavigationState.destination(fromStored: destination.rawValue)
                    == destination
            )
        }
        #expect(DesktopNavigationState.destination(fromStored: DesktopDestination.search.rawValue) == .chat)
    }

    // MARK: - Design is a type in Artifacts (Phase 4 A2)

    /// A window stored on the retired Design page reopens on Artifacts, with
    /// the Designs filter — the web's `/design` → `/artifacts?type=DESIGN`.
    @Test
    func aStoredDesignOpensArtifactsFilteredToDesigns() {
        #expect(DesktopNavigationState.destination(fromStored: "design") == .artifacts)
        let normalized = DesktopNavigationState.normalized(.design)
        #expect(normalized.destination == .artifacts)
        #expect(normalized.artifactsType == "DESIGN")
        #expect(DesktopNavigationState.normalized(.library).destination == .library)
        #expect(DesktopNavigationState.normalized(.library).artifactsType == nil)
    }

    /// Library, Projects, Artifacts, Agents — the web's rows, with no Design.
    @Test
    func theSidebarHasNoDesignRow() {
        #expect(DesktopDestination.sidebarCases == [.projects, .library, .connections])
        #expect(!DesktopDestination.sidebarCases.contains(.design))
    }

    /// The case stays decodable for stored state and old callers.
    @Test
    func theDesignRawValueStillRoundTrips() {
        #expect(DesktopDestination(rawValue: "design") == .design)
        #expect(DesktopDestination.design.rawValue == "design")
    }

    /// A router request for Design lands on Artifacts carrying the filter,
    /// which the Artifacts page takes once.
    @Test
    @MainActor
    func aDesignRequestCarriesTheDesignsFilter() {
        let router = DesktopPageRouter()
        router.open(.design, opensNewMenu: true)
        let request = try? #require(router.pending)
        #expect(request?.destination == .artifacts)
        #expect(request?.artifactsType == "DESIGN")
        if let request { router.consume(request) }
        #expect(router.pending == nil)
        let filter = router.takeArtifactsFilter()
        #expect(filter?.type == "DESIGN")
        #expect(filter?.opensNewMenu == true)
        #expect(router.takeArtifactsFilter() == nil)
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
        // The three pages Phase 1 retired from the column. A window saved on
        // one of them reopens on Chat rather than on a blank pane.
        for retired in ["tasks", "usage", "settings"] {
            #expect(DesktopNavigationState.destination(fromStored: retired) == .chat)
        }

        // Every destination but Design, which reads back as Artifacts (A2),
        // and Search, which reads back as Chat now that the panel replaced it.
        for destination in DesktopDestination.allCases where destination != .design && destination != .search {
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
            ) == "Made by Alevr"
        )
    }

    /// The window is never nameless: the Window menu, Mission Control and ⌘`
    /// read this title, and `.navigationTitle("")` left them a blank row.
    @Test
    func theWindowTitleIsNeverEmpty() {
        #expect(
            DesktopNavigationState.windowTitle(destination: .chat, conversationTitle: "   ")
                == "New chat"
        )
        #expect(
            DesktopNavigationState.windowTitle(destination: .chat, conversationTitle: "")
                == "New chat"
        )
        for destination in DesktopDestination.allCases {
            #expect(
                !DesktopNavigationState.windowTitle(
                    destination: destination,
                    conversationTitle: nil
                ).isEmpty
            )
        }
    }

    /// A private chat is titled in the web's words, whatever conversation was
    /// open before it — it is a new chat that is never saved.
    @Test
    func aPrivateChatIsTitledIncognitoChat() {
        #expect(
            DesktopNavigationState.windowTitle(
                destination: .chat,
                conversationTitle: "Designing the sidebar",
                isPrivate: true
            ) == "Incognito chat"
        )
        #expect(
            DesktopNavigationState.windowTitle(
                destination: .library,
                conversationTitle: nil,
                isPrivate: true
            ) == "Library"
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
            .design,
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

    /// The account-level pages left the Code column for the Settings window.
    ///
    /// Scene storage written by a build that still had them must decode to
    /// *no* selection rather than strand the window on a page it no longer
    /// draws — the window then opens on the New task screen, which is the
    /// honest fallback.
    @Test
    func retiredAccountPagesDecodeToNoSelection() {
        for retired in ["usage", "settings", "connections"] {
            #expect(DesktopCodeNavigationState.decode(retired) == nil)
        }
        #expect(DesktopCodeNavigationState.decode("pulls") == .pulls)
    }

    /// The column's one filter, as a pure rule over run status.
    @Test
    func sessionFilterAdmitsTheStatusesItNames() {
        let running = CodeRunStatus(CodeRunState.running)
        let blocked = CodeRunStatus(CodeRunState.needsApproval)
        let finished = CodeRunStatus(CodeRunState.finished)
        let failed = CodeRunStatus(CodeRunState.failed)

        #expect(DesktopCodeSessionFilter.all.includes(running))
        #expect(DesktopCodeSessionFilter.all.includes(finished))
        #expect(DesktopCodeSessionFilter.running.includes(running))
        #expect(!DesktopCodeSessionFilter.running.includes(blocked))
        #expect(!DesktopCodeSessionFilter.running.includes(finished))
        #expect(DesktopCodeSessionFilter.needsYou.includes(blocked))
        #expect(!DesktopCodeSessionFilter.needsYou.includes(running))
        #expect(DesktopCodeSessionFilter.done.includes(finished))
        #expect(DesktopCodeSessionFilter.done.includes(failed))
        #expect(!DesktopCodeSessionFilter.done.includes(running))
    }

    /// Filtering keeps blocked runs on top, then live ones, then newest first.
    @Test
    func filteredRunsPutBlockedWorkFirst() {
        let now = Date()
        func run(_ id: String, _ state: CodeRunState, minutesAgo: Double) -> DesktopCodeRun {
            DesktopCodeRun(
                item: .session(CodeSessionID(value: id)),
                title: id,
                workspace: "juno",
                workspaceID: nil,
                branch: nil,
                environment: .local,
                status: CodeRunStatus(state),
                updatedAt: now.addingTimeInterval(-minutesAgo * 60)
            )
        }
        let runs = [
            run("old-done", .finished, minutesAgo: 60),
            run("live", .running, minutesAgo: 5),
            run("blocked", .needsApproval, minutesAgo: 30),
            run("new-done", .finished, minutesAgo: 1),
        ]
        let ordered = DesktopCodeNavigationState.filtered(runs, by: .all).map(\.title)
        #expect(ordered == ["blocked", "live", "new-done", "old-done"])
        #expect(DesktopCodeNavigationState.filtered(runs, by: .done).map(\.title) == ["new-done", "old-done"])
    }

    /// The four honest refusals on the New task screen.
    @Test
    func draftReadinessNamesWhatIsMissing() {
        #expect(
            DesktopCodeDraftReadiness.blockingReason(
                environment: .cloud, hasProject: false, projectIsGitRepository: false,
                hasCloudRepository: false, hasDevice: false, hasAttachments: false
            )?.contains("GitHub repository") == true
        )
        #expect(
            DesktopCodeDraftReadiness.blockingReason(
                environment: .device, hasProject: false, projectIsGitRepository: false,
                hasCloudRepository: false, hasDevice: false, hasAttachments: false
            )?.contains("computer") == true
        )
        #expect(
            DesktopCodeDraftReadiness.blockingReason(
                environment: .worktree, hasProject: true, projectIsGitRepository: false,
                hasCloudRepository: false, hasDevice: false, hasAttachments: false
            )?.contains("Git repository") == true
        )
        #expect(
            DesktopCodeDraftReadiness.blockingReason(
                environment: .cloud, hasProject: true, projectIsGitRepository: true,
                hasCloudRepository: true, hasDevice: false, hasAttachments: true
            )?.contains("this Mac") == true
        )
        #expect(
            DesktopCodeDraftReadiness.blockingReason(
                environment: .local, hasProject: false, projectIsGitRepository: false,
                hasCloudRepository: false, hasDevice: false, hasAttachments: false
            ) == nil
        )
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
