import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
import JunoDesignSystem
@testable import JunoCodeUI

/// Renders the loop's surfaces to PNGs for review by eye (CODE_AGENT_SPEC
/// §6.1): the goal row in each state, the start card, the goal sheet, the
/// continuation captions and an end divider per `RunEndReason`. Off unless
/// `JUNO_SNAPSHOT_DIR` names a folder; hosted in an offscreen window and drawn
/// with `cacheDisplay`, so it needs no screen access at all.
@MainActor
final class LoopSnapshotTests: XCTestCase {
    private var directory: URL?

    override func setUp() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render the loop's snapshots.")
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        directory = url
    }

    private func goal(_ status: GoalStatus, reason: String? = nil) -> GoalRun {
        var goal = GoalRun(
            id: "g3",
            objective: "Make the settings menu open on click and keyboard, on desktop and phone widths",
            criteria: [
                GoalCriterion(id: "c1", text: "SettingsMenu tests pass", check: .command(checkID: "web-test")),
                GoalCriterion(id: "c2", text: "Menu opens on click at desktop and phone", check: .ui(surface: .web, target: "/settings")),
                GoalCriterion(id: "c3", text: "No other component's props change"),
            ],
            constraints: ["Do not modify other test files."],
            budget: Budget(minutes: 240, turns: 60, costUSD: 20)
        )
        goal.usage = GoalUsage(minutes: 38, turns: 7, tokens: nil, costUSD: 1.12)
        goal.record(GoalVerdict(kind: .gateBlocked, reason: "c2 has no Preview evidence yet", unmetCriteria: ["c2"], revision: 12))
        if status != .active {
            try? goal.transition(to: status, reason: reason)
        }
        if status == .achieved {
            goal.usage = GoalUsage(minutes: 52, turns: 11, tokens: nil, costUSD: 2.4)
        }
        return goal
    }

    private func page<V: View>(_ content: V) -> some View {
        content
            .frame(maxWidth: Studio.Metrics.measure)
            .padding(Studio.Metrics.gutter)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Studio.Surface.canvas)
    }

    func testRenderGoalRow() async throws {
        let rows = VStack(alignment: .leading, spacing: JunoSpace.regular) {
            StudioGoalRow(content: GoalRowContent(goal: goal(.active)), isWorking: true, perform: { _ in }, openSheet: {})
            StudioGoalRow(content: GoalRowContent(goal: goal(.needsYou, reason: "Waiting for you to allow `npm install`")), isWorking: false, perform: { _ in }, openSheet: {})
            StudioGoalRow(content: GoalRowContent(goal: goal(.budgetReached, reason: "Used the goal's 240-minute budget")), isWorking: false, perform: { _ in }, openSheet: {})
            StudioGoalRow(content: GoalRowContent(goal: goal(.paused, reason: "Paused by you")), isWorking: false, perform: { _ in }, openSheet: {})
            StudioGoalRow(content: GoalRowContent(goal: goal(.achieved)), isWorking: false, perform: { _ in }, openSheet: {})
        }
        for dark in [false, true] {
            try await render(page(rows), size: CGSize(width: 860, height: 520), dark: dark, name: "goal-row-\(dark ? "dark" : "light")")
        }
    }

    func testRenderGoalStartCard() async throws {
        var draft = GoalDraft(
            objective: "Make the settings menu open on click and keyboard",
            criteria: [
                GoalCriterion(id: "c1", text: "SettingsMenu tests pass", check: .command(checkID: "web-test")),
                GoalCriterion(id: "c2", text: "Menu opens on click at desktop and phone", check: .ui(surface: .web, target: "/settings")),
                GoalCriterion(id: "c3", text: "No other component's props change"),
            ],
            budget: Budget(minutes: 240, turns: 60, costUSD: 20),
            offeredGrants: ["npm test", "npm run typecheck"]
        )
        draft.selectedGrants = ["npm test"]
        for dark in [false, true] {
            try await render(
                page(StudioGoalStartCard(
                    draft: .constant(draft),
                    isEditing: false,
                    isDrafting: false,
                    replacesCurrent: true,
                    errorMessage: nil,
                    start: {},
                    cancel: {}
                )),
                size: CGSize(width: 860, height: 640),
                dark: dark,
                name: "goal-start-card-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderGoalSheet() async throws {
        var current = goal(.needsYou, reason: "Waiting for you to allow `npm install`")
        current.record(GoalVerdict(kind: .notMet, reason: "c2 is not shown at phone width", unmetCriteria: ["c2"], revision: 14))
        current.grants = [TaskGrant(command: "npm test", goalID: "g3", worktreePath: "/tmp/project")]
        var past = GoalRun(objective: "Add keyboard shortcuts to the composer")
        past.usage = GoalUsage(minutes: 21, turns: 4)
        try? past.transition(to: .achieved)
        for dark in [false, true] {
            try await render(
                StudioGoalSheet(goal: current, history: [past], perform: { _ in }, done: {}),
                size: CGSize(width: 620, height: 760),
                dark: dark,
                name: "goal-sheet-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderContinuationCaptions() async throws {
        let captions = VStack(alignment: .leading, spacing: JunoSpace.regular) {
            StudioAssistantMessage(text: "The menu now opens on pointerdown.")
            StudioContinuedRow(event: RunContinuedEvent(reason: .gate(.todosOpen), detail: "2 todos were still open: \"Fix the menu\", \"Add a test\"", revision: 3, origin: .gate))
            StudioContinuedRow(event: RunContinuedEvent(reason: .gate(.unverified), detail: "`swift test` had not run since your last edit (3 files changed)", revision: 4, origin: .gate))
            StudioContinuedRow(event: RunContinuedEvent(reason: .gate(.checksFailing), detail: "`npm test` failed after your last edit (first: SettingsMenu.test.tsx:41)", revision: 5, origin: .gate))
            StudioContinuedRow(event: RunContinuedEvent(reason: .gate(.diffUnreviewed), detail: "your diff (2 files, 18 lines) had not been read since your last edit", revision: 6, origin: .gate))
            StudioContinuedRow(event: RunContinuedEvent(reason: .gate(.goalNotMet), detail: "c2 has no Preview evidence for /settings since the last edit", revision: 7, origin: .goal))
            StudioContinuedRow(event: RunContinuedEvent(reason: .wrapUp, detail: "Wrapping up: reached the step limit (200 steps)", origin: .gate))
            StudioContinuedRow(event: RunContinuedEvent(reason: .outputLimit, detail: "the reply reached the output limit", origin: .gate))
            StudioContinuedRow(event: RunContinuedEvent(reason: .retry, detail: "", origin: .user))
            StudioContinuedRow(event: RunContinuedEvent(reason: .afterQuit, detail: "", origin: .user))
            StudioGoalVerdictRow(event: GoalVerdictEvent(goalID: "g3", verdict: .gateBlocked, reason: "c2 has no Preview evidence", unmetCriteria: ["c2"], revision: 7))
            StudioGoalVerdictRow(event: GoalVerdictEvent(goalID: "g3", verdict: .notMet, reason: "The phone width is not shown", unmetCriteria: ["c2"], revision: 9), initiallyExpanded: true)
            StudioGoalVerdictRow(event: GoalVerdictEvent(goalID: "g3", verdict: .met, reason: "Every criterion has fresh evidence", revision: 11))
        }
        for dark in [false, true] {
            try await render(page(captions), size: CGSize(width: 860, height: 640), dark: dark, name: "loop-captions-\(dark ? "dark" : "light")")
        }
    }

    func testRenderEndDividers() async throws {
        let details: [RunEndReason: String?] = [
            .doneChecked: "Checked with `swift test`",
            .doneUnchecked: "Not checked: no test command for this project",
            .checksFailing: "`npm test` still fails (2 failures)",
            .blocked: "Blocked: needs a decision about the migration",
            .needsYou: "Waiting for you",
            .stepLimit: "Stopped at 200 steps. Keep going?",
            .budget: "Used the run's 60-minute budget. Keep going?",
            .stalled: "Stopped: no progress in the last two tries",
            .waitingOnBackground: "Waiting for `xcodebuild test` to finish",
            .stopped: "Stopped",
            .interrupted: "Juno quit while this was running",
            .error: "The model is unavailable.",
        ]
        let dividers = VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            ForEach(RunEndReason.allCases, id: \.self) { reason in
                StudioRunSummary(
                    run: RunCompletedEvent(
                        summary: "Done.",
                        filesChanged: 0,
                        testsPassed: nil,
                        durationSeconds: 252,
                        endReason: reason,
                        endDetail: details[reason] ?? nil
                    ),
                    turn: StudioThreadItem.TurnTotals(),
                    openReview: {},
                    keepGoing: reason.offersKeepGoing ? {} : nil
                )
            }
        }
        for dark in [false, true] {
            try await render(page(dividers), size: CGSize(width: 860, height: 900), dark: dark, name: "end-dividers-\(dark ? "dark" : "light")")
        }
    }

    // MARK: - Rendering

    private func render<V: View>(_ view: V, size: CGSize, dark: Bool, name: String) async throws {
        guard let directory else { return }
        let hosting = NSHostingView(
            rootView: view
                .frame(width: size.width, height: size.height)
                .environment(\.colorScheme, dark ? .dark : .light)
                // Liquid Glass is composited by the window server; offscreen,
                // the goal surfaces draw their opaque stand-in instead.
                .environment(\.junoSnapshotOpaqueGlass, true)
        )
        hosting.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: CGRect(origin: CGPoint(x: -10_000, y: -10_000), size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        for _ in 0..<6 {
            try await Task.sleep(for: .milliseconds(80))
            hosting.layoutSubtreeIfNeeded()
        }
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
            XCTFail("No bitmap for \(name)")
            return
        }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let data = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try data.write(to: directory.appendingPathComponent(name + ".png"))
        window.contentView = nil
    }
}
