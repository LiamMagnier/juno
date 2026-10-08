import Foundation
import JunoChatKit
import JunoWorkKit
import SwiftUI
import Testing
@testable import JunoDesktop

/// The seams the lanes left for the integration (Phase 3 brief §2.3, Phase 4
/// brief §0.4, Phase 5 D): each is a few lines, and each is pinned here.
@MainActor
struct IntegrationSeamsTests {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    // MARK: Seam 2: the panel's keycaps are the registry's

    @Test
    func everyPanelHintIsTheRegistrysChord() {
        let rows = DesktopCommandCatalog.rows(query: "", context: DesktopCommandCatalog.Context(hooks: .none, now: now))
        let expected: [String: JunoShortcutID] = [
            "new-chat": .newChat,
            "new-private-chat": .newPrivateChat,
            "toggle-sidebar": .toggleSidebar,
            "settings": .settings,
            "theme": .toggleTheme,
            "shortcuts": .keyboardShortcuts,
        ]
        for (rowID, shortcut) in expected {
            let row = rows.first { $0.id == rowID }
            #expect(row != nil, "no row \(rowID)")
            #expect(row?.hint == JunoShortcutRegistry.entry(shortcut).keys, "\(rowID)")
        }
    }

    // MARK: Phase 5 D's Tasks scope, in the panel

    private func task(_ id: String, _ title: String, chat: String?, ago: TimeInterval) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: id, title: title, goal: title, status: "running",
            needsAttention: false, requestedTarget: "automatic",
            effectiveTarget: "cloud", hostID: nil, hostDisplayName: nil, pinned: false,
            archived: false, lastActivityAt: now.addingTimeInterval(-ago), currentRunID: nil,
            lastSeq: 0, conversationID: chat, createdAt: now.addingTimeInterval(-ago - 60)
        )
    }

    @Test
    func theTasksGroupListsTheAccountsTasksAndOpensThemWhereTheyLive() {
        let tasks = [
            task("t-chat", "Reconcile the invoices", chat: "conv-1", ago: 60),
            task("t-alone", "Reconcile the receipts", chat: nil, ago: 30),
            task("t-other", "Book the hotel", chat: "conv-2", ago: 10),
        ]
        var hooks = DesktopCommandCatalog.Hooks()
        hooks.openTaskRecord = { _ in }
        let rows = DesktopSearchPanelModel.resultRows(
            query: "reconcile", local: [], server: nil, typeFilter: .work, window: .any,
            projectFilter: nil, projectOfConversation: { _ in nil }, hooks: hooks, now: now, tasks: tasks
        )
        #expect(rows.map(\.id) == ["task-t-alone", "task-t-chat"])
        #expect(rows.first?.action == .taskRecord(sessionID: "t-alone"))
        #expect(rows.last?.action == .conversation(id: "conv-1"))

        // Without the sheet's hook, a task with no chat has nowhere to go.
        let unhooked = DesktopSearchPanelModel.resultRows(
            query: "reconcile", local: [], server: nil, typeFilter: .work, window: .any,
            projectFilter: nil, projectOfConversation: { _ in nil }, hooks: .none, now: now, tasks: tasks
        )
        #expect(unhooked.map(\.id) == ["task-t-chat"])

        // Another type's chip leaves tasks out.
        let conversations = DesktopSearchPanelModel.resultRows(
            query: "reconcile", local: [], server: nil, typeFilter: .conversation, window: .any,
            projectFilter: nil, projectOfConversation: { _ in nil }, hooks: hooks, now: now, tasks: tasks
        )
        #expect(conversations.isEmpty)
    }

    @Test
    func aTaskFallsBackToItsGoal() {
        let untitled = WorkSessionSummary(
            sessionID: "a", title: "  ", goal: "Tidy the Receipts folder", status: "completed",
            needsAttention: false, requestedTarget: "automatic", effectiveTarget: "cloud", hostID: nil,
            hostDisplayName: nil, pinned: false, archived: false, lastActivityAt: now, currentRunID: nil,
            lastSeq: 0, conversationID: nil, createdAt: now
        )
        #expect(DesktopPanelTasks.title(of: untitled) == "Tidy the Receipts folder")
    }

    // MARK: The retired Search page

    @Test
    func aStoredSearchDestinationOpensChat() {
        #expect(DesktopNavigationState.destination(fromStored: "search") == .chat)
        #expect(DesktopNavigationState.normalized(.search).destination == .chat)
        #expect(DesktopNavigationState.normalized(.design).artifactsType == "DESIGN")
    }

    // MARK: Seam 13: one theme toggle

    @Test
    func theThemeToggleReadsTheAccountFirstThenTheSystem() {
        #expect(DesktopThemeToggle.isDark(theme: .dark, drawn: .light))
        #expect(!DesktopThemeToggle.isDark(theme: .light, drawn: .dark))
        #expect(DesktopThemeToggle.isDark(theme: .system, drawn: .dark))
        #expect(!DesktopThemeToggle.isDark(theme: nil, drawn: .light))
    }

    // MARK: Seam 9: the account popover's usage block

    @Test
    func theUsageBlockReadsTheMonthsMessagesWhenTheServerSendsThem() throws {
        let plan = try NativeUsagePlan.decode(Data("""
        {"quota":{"plan":"FREE","used":46,"limit":50,"remaining":4},
         "spend":{"spentMicroUsd":7430000,"budgetMicroUsd":20000000,"remainingMicroUsd":12570000,
          "windows":{"session":{"spentMicroUsd":1,"budgetMicroUsd":2,"pct":0.37,"resetsAtMs":1790000000000},
                     "weekly":{"spentMicroUsd":1,"budgetMicroUsd":2,"pct":0.61,"resetsAtMs":1790400000000}},
          "billing":{"renewsAtMs":1791000000000,"cancelAtPeriodEnd":false}}}
        """.utf8))
        let usage = DesktopAccountUsage(plan: plan)
        #expect(usage.caption == "Messages")
        #expect(usage.readout == "46 / 50")
        #expect(usage.fraction == 0.92)
        #expect(usage.tone == .warning)
    }

    // MARK: ⌘K's New assistant

    @Test
    func newAssistantIsTakenOnce() {
        let router = DesktopPageRouter()
        router.openNewAssistant()
        #expect(router.pending?.destination == .assistants)
        #expect(router.takeNewAssistantRequest())
        #expect(!router.takeNewAssistantRequest())
    }

    // MARK: Phase 4 C4: More and the sidebar

    @Test
    func moreHoldsTheWebsThreePagesAndTheSidebarItsFour() {
        #expect(DesktopDestination.sidebarCases == [.projects, .library, .connections])
        #expect(DesktopDestination.moreCases == [])
    }
}
