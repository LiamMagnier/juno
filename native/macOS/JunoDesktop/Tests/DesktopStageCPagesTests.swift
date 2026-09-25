import Foundation
import JunoCore
import JunoWorkKit
import Testing
@testable import JunoDesktop

/// Phase 4 Stage C: the More menu in the web's order, the destinations that
/// left it, and the automation editor's draft.
struct DesktopStageCPagesTests {
    // MARK: - More and the sidebar

    /// The web's More (`app-sidebar.tsx`): Assistants, Skills, Automations.
    @Test
    func moreIsTheWebsOrder() {
        #expect(DesktopDestination.moreCases == [.assistants, .skills, .automations])
        #expect(DesktopDestination.sidebarCases == [.library, .projects, .artifacts, .agents])
    }

    /// Connections, Memory and Permissions left More but stay destinations,
    /// reachable through the router; a stored value still opens them.
    @Test(arguments: [DesktopDestination.connections, .memory, .permissions, .automations, .skills, .assistants])
    func pagesOutsideTheColumnRoundTripThroughStoredState(_ destination: DesktopDestination) {
        #expect(!DesktopDestination.sidebarCases.contains(destination))
        #expect(DesktopNavigationState.destination(fromStored: destination.rawValue) == destination)
    }

    @Test
    func connectionsMemoryAndPermissionsAreNotInMore() {
        for destination in [DesktopDestination.connections, .memory, .permissions] {
            #expect(!DesktopDestination.moreCases.contains(destination))
        }
    }

    /// A More page is the column's selection, which is what lights the More
    /// trigger with the selected fill while it is showing.
    @Test
    func aMorePageIsTheSelection() {
        #expect(
            DesktopNavigationState.selection(destination: .automations, selectedConversationID: "c")
                == .destination(.automations)
        )
    }

    @Test
    func theNewDestinationsNameThemselvesWithTheWebsMarks() {
        #expect(DesktopDestination.automations.label == "Automations")
        #expect(DesktopDestination.permissions.label == "Permissions")
        #expect(DesktopDestination.automations.junoIcon == .automations)
        #expect(DesktopDestination.permissions.junoIcon == .permissions)
        #expect(DesktopDestination.skills.junoIcon == .skills)
        #expect(DesktopDestination.assistants.junoIcon == .assistants)
    }

    @Test
    @MainActor
    func aPermissionsRequestCarriesItsHost() throws {
        let router = DesktopPageRouter()
        router.open(.permissions, route: .host("host-1"))
        let request = try #require(router.pending)
        #expect(request.destination == .permissions)
        #expect(request.route == .host("host-1"))
    }

    // MARK: - The automation editor

    /// Every policy's label maps to its wire value, in the web's order.
    @Test
    func policyLabelsMapToWireValues() {
        typealias C = NativeWorkScheduleCopy
        #expect(C.unattendedOptions.map(\.value) == ["pause_for_approval", "skip_irreversible", "disallow_irreversible"])
        #expect(C.unattendedOptions.map(\.label) == [
            "Stop and wait for me", "Do the rest, and say what it skipped", "Treat it as a failure",
        ])
        #expect(C.hostOfflineOptions.map(\.value) == ["wait", "skip", "cloud_subset"])
        #expect(C.hostOfflineOptions.map(\.label) == ["Wait for the Mac", "Skip this one", "Do the cloud part"])
        #expect(C.missedRunOptions.map(\.value) == ["skip", "run_once", "run_all"])
        #expect(C.missedRunOptions.map(\.label) == ["Let them go", "Catch up once", "Run every one"])
        #expect(C.notifyOptions.map(\.value) == ["none", "on_attention", "on_finish", "all"])
        #expect(C.notifyOptions.map(\.label) == ["Never", "Only when it needs me", "When it finishes", "Everything"])
    }

    /// A stored automation seeds the editor, and the editor's body is what
    /// was stored: the ceilings survive the trip through their text fields.
    @Test
    func aDraftRoundTripsThroughTheEditor() throws {
        let schedule = Self.schedule()
        let draft = DesktopAutomationDraft(schedule: schedule)
        #expect(draft.costUSD == "2.5")
        #expect(draft.tokens == "12000")
        #expect(draft.minutes == "15")
        let body = try #require(draft.scheduleDraft)
        #expect(body == schedule.draft)
    }

    /// Empty is no ceiling; a word is refused, not read as zero.
    @Test
    func ceilingsAreEmptyOrANumber() {
        var draft = DesktopAutomationDraft(schedule: Self.schedule())
        draft.costUSD = ""
        #expect(draft.scheduleDraft?.budget.maxCostMicroUSD == 0)
        draft.tokens = "lots"
        #expect(!draft.budgetIsValid)
        #expect(draft.scheduleDraft == nil)
    }

    /// A pinned automation must name its Mac; a policy the options do not
    /// know is read as the web's fallback.
    @Test
    func aPinnedAutomationNeedsItsMacAndUnknownPoliciesFallBack() {
        var draft = DesktopAutomationDraft()
        draft.name = "Sweep"
        draft.instructions = "Tidy the inbox."
        draft.target = .local
        #expect(draft.missingHost)
        #expect(!draft.canSave)
        draft.hostID = "host-1"
        #expect(draft.canSave)

        let odd = DesktopAutomationDraft(schedule: Self.schedule(unattended: "auto_approve"))
        #expect(odd.unattendedPolicy == "pause_for_approval")
    }

    /// Work runs and Code runs, newest first, each with the conversation it
    /// opens.
    @Test
    func historyInterleavesNewestFirst() {
        let history = NativeWorkScheduleHistory(
            runs: [
                NativeWorkScheduleRun(
                    id: "run-1", sessionID: "s-1", scheduleID: "a", origin: "schedule", status: "completed",
                    requestedTarget: "cloud", effectiveTarget: "cloud", hostID: nil,
                    createdAt: Date(timeIntervalSince1970: 100), startedAt: nil, finishedAt: nil,
                    attempt: 2
                ),
                NativeWorkScheduleRun(
                    id: "run-2", sessionID: "s-1", scheduleID: "a", origin: "schedule", status: "cancelled",
                    requestedTarget: "local", effectiveTarget: nil, hostID: nil,
                    createdAt: Date(timeIntervalSince1970: 300), startedAt: nil, finishedAt: nil,
                    terminalDetail: "The Mac was away, so this fire was skipped."
                ),
            ],
            codeRuns: [
                NativeWorkScheduleCodeRun(
                    id: "code-1", title: "Bump deps", status: "done", conversationID: "conv-code",
                    pullRequestURL: nil, branch: "juno/bump", createdAt: Date(timeIntervalSince1970: 200)
                ),
            ]
        )
        let rows = DesktopAutomationHistoryRow.rows(history) { $0 == "s-1" ? "conv-1" : nil }
        #expect(rows.map(\.id) == ["run-2", "code-1", "run-1"])
        #expect(rows[0].label == "The Mac was away, so this fire was skipped.")
        #expect(rows[1].status == "completed")
        #expect(rows[1].label == "juno/bump")
        #expect(rows[1].conversationID == "conv-code")
        #expect(rows[2].label == "Attempt 2")
        #expect(rows[2].conversationID == "conv-1")
    }

    // MARK: - Fixtures

    static func schedule(unattended: String = "skip_irreversible") -> NativeWorkSchedule {
        NativeWorkSchedule(
            id: "auto-1", sessionID: "s-1", name: "Monday inbox sweep", enabled: true,
            instructions: "Sort the inbox and draft replies.", instructionsVersion: 1,
            target: "local", hostID: "host-1", timezone: "Europe/Paris",
            runConfig: ["model": .string("anthropic:claude-opus-4-8")], runConfigVersion: 1,
            budget: NativeWorkScheduleBudget(
                maxCostMicroUSD: 2_500_000, maxTokens: 12_000, maxRuntimeMilliseconds: 900_000
            ),
            unattendedPolicy: unattended, hostOfflinePolicy: "wait", maxConcurrentRuns: 2,
            notifyPolicy: "on_finish", missedRunPolicy: "run_all", retryPolicy: .object([:]),
            lastRunAt: nil, nextRunAt: nil, legacyScheduledTaskID: nil,
            createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0),
            triggers: [
                NativeWorkScheduleTrigger(
                    id: "t-1", kind: "weekly", config: ["weekday": .number(1), "hour": .number(8), "minute": .number(30)],
                    configVersion: 1, enabled: true, lastFiredAt: nil, dedupeWindowSeconds: 0
                ),
            ]
        )
    }
}
