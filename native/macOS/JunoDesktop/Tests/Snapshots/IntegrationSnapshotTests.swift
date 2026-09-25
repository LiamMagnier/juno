import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import JunoWorkKit
import SwiftUI
import Testing
@testable import JunoDesktop

/// What the integration wired, drawn: the composer's skill mark beside the
/// others, ⌘K's Tasks group with the account's tasks beside the server's hit,
/// and the account popover's usage block read from the month's quota.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the integration fixtures."
    ),
    .serialized
)
struct IntegrationSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("integration", isDirectory: true)
    }

    private static let now = Date()

    @Test
    func theComposerMarksLeadWithTheSkill() async throws {
        let marks = ChatComposerMark.marks(
            skill: (slug: "tidy-inbox", name: "Tidy the inbox", description: "Files every newsletter and flags what needs a reply."),
            research: true,
            webSearch: false,
            connectors: [],
            documentCount: nil
        )
        let view = VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.tight) {
                ForEach(marks) { mark in
                    ComposerArmedMarkView(mark: mark, showsLabel: true, disarm: {}, menu: { EmptyView() })
                }
                Text("Sort this week’s mail")
                    .junoType(.body)
                    .foregroundStyle(Color.junoForeground)
            }
            HStack(spacing: JunoSpace.tight) {
                ForEach(marks) { mark in
                    ComposerArmedMarkView(mark: mark, showsLabel: false, disarm: {}, menu: { EmptyView() })
                }
            }
        }
        .padding(JunoSpace.regular)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .fill(Color.junoCard)
        )
        .padding(24)
        .junoAccentTint()
        try await render(view, name: "integration-composer-skill-mark", width: 520)
    }

    @Test
    func theTasksGroupListsTheAccountsTasksBesideTheServersHit() async throws {
        let model = DesktopSearchPanelModel()
        var services = DesktopSearchPanelModel.Services()
        services.localSearch = { _ in [] }
        services.serverSearch = { query, _, _, _ in
            NativeUnifiedSearchResult(
                query: query,
                groups: [
                    NativeSearchGroup(type: .work, label: "Tasks", hits: [
                        NativeSearchHit(
                            id: "work:s1", type: .work, title: "Compile the launch plan from Linear",
                            titleMarks: [NativeSearchMark(start: 12, end: 18), NativeSearchMark(start: 19, end: 23)],
                            href: "/chat/chat-1", locator: "done", updatedAt: Self.now.addingTimeInterval(-86_400 * 2)
                        ),
                    ]),
                ],
                total: 1,
                coverage: [],
                partial: false
            )
        }
        services.localTasks = {
            [
                Self.task("s1", "Compile the launch plan from Linear", chat: "chat-1", ago: 86_400 * 2),
                Self.task("s2", "Check the launch plan against the budget", chat: nil, ago: 1_800),
                Self.task("s3", "Book the launch plan review room", chat: "chat-4", ago: 7_200),
            ]
        }
        model.services = services
        model.debounce = .seconds(60)
        model.present(.search)
        model.setQuery("launch plan")
        model.setTypeFilter(.work)
        await model.runSearch(generation: model.currentGeneration)
        var hooks = DesktopCommandCatalog.Hooks()
        hooks.openTaskRecord = { _ in }
        let rows = model.searchRows(hooks: hooks, now: Self.now)
        let height = DesktopSearchPanelMetrics.height(
            listContent: DesktopSearchPanelMetrics.listContentHeight(rows),
            showsFilters: model.showsFilters,
            noticeCount: model.notices.count,
            windowHeight: 800
        )
        let view = DesktopSearchPanel(model: model, rows: rows, projects: [], height: height, run: { _ in })
            .frame(width: DesktopSearchPanelMetrics.maxWidth, height: height)
            .padding(32)
            .environment(\.junoSnapshotOpaqueGlass, true)
        try await render(view, name: "integration-panel-tasks", width: DesktopSearchPanelMetrics.maxWidth + 64)
    }

    /// With the seams wired, ⌘K offers every page's "New …" row, each with the
    /// registry's chord where it has one.
    @Test
    func theCommandMenuOffersEveryPagesNewRow() async throws {
        let model = DesktopSearchPanelModel()
        model.present(.commands)
        model.setQuery("new")
        var hooks = DesktopCommandCatalog.Hooks()
        hooks.openNotifications = {}
        hooks.openUpgrade = {}
        hooks.openPage = { _ in }
        hooks.openTaskRecord = { _ in }
        let rows = DesktopCommandCatalog.rows(
            query: model.query,
            context: DesktopCommandCatalog.Context(hooks: hooks, now: Self.now)
        )
        let height = DesktopSearchPanelMetrics.height(
            listContent: DesktopSearchPanelMetrics.listContentHeight(rows),
            showsFilters: model.showsFilters,
            noticeCount: 0,
            windowHeight: 800
        )
        let view = DesktopSearchPanel(model: model, rows: rows, projects: [], height: height, run: { _ in })
            .frame(width: DesktopSearchPanelMetrics.maxWidth, height: height)
            .padding(32)
            .environment(\.junoSnapshotOpaqueGlass, true)
        try await render(view, name: "integration-panel-new-rows", width: DesktopSearchPanelMetrics.maxWidth + 64)
    }

    @Test
    func theAccountPopoverReadsTheMonthsMessages() async throws {
        let plan = try NativeUsagePlan.decode(Data("""
        {"quota":{"plan":"FREE","used":46,"limit":50,"remaining":4},
         "spend":{"spentMicroUsd":7430000,"budgetMicroUsd":20000000,"remainingMicroUsd":12570000,
          "windows":{"session":{"spentMicroUsd":1,"budgetMicroUsd":2,"pct":0.37,"resetsAtMs":1790000000000},
                     "weekly":{"spentMicroUsd":1,"budgetMicroUsd":2,"pct":0.61,"resetsAtMs":1790400000000}},
          "billing":{"renewsAtMs":1791000000000,"cancelAtPeriodEnd":false}}}
        """.utf8))
        let view = DesktopAccountPopover(
            name: "Liam Magnier", email: "crtn.tjb@gmail.com", avatarData: nil, imageURL: nil,
            planName: plan.planName,
            usage: DesktopAccountUsage(plan: plan),
            isOwner: false,
            openSettings: {}, openUpgrade: {}, openAdmin: {}, openShortcuts: {}, signOut: {}
        )
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous)
                .fill(Color.junoPopover)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
        .padding(24)
        .junoAccentTint()
        try await render(view, name: "integration-account-quota", width: DesktopAccountPopover.width + 48)
    }

    private static func task(_ id: String, _ title: String, chat: String?, ago: TimeInterval) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: id, title: title, goal: title, status: chat == nil ? "waiting_input" : "completed",
            needsAttention: chat == nil, requestedTarget: "automatic",
            effectiveTarget: "cloud", hostID: nil, hostDisplayName: nil, pinned: false,
            archived: false, lastActivityAt: now.addingTimeInterval(-ago), currentRunID: nil,
            lastSeq: 0, conversationID: chat, createdAt: now.addingTimeInterval(-ago - 60)
        )
    }

    private func render<V: View>(_ view: V, name: String, width: CGFloat) async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                view, name: name, width: width, appearance: appearance, into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}
