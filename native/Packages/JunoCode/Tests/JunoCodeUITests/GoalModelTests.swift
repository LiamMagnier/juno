import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Answers agent turns with a line of text, the criteria drafter with JSON
/// criteria and the goal judge with "met".
private final class GoalScriptModel: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var agent: [ModelTurnRequest] = []
    private var small: [ModelTurnRequest] = []

    var agentRequests: [ModelTurnRequest] {
        lock.lock()
        defer { lock.unlock() }
        return agent
    }

    var smallModelRequests: [ModelTurnRequest] {
        lock.lock()
        defer { lock.unlock() }
        return small
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        let reply: String
        if request.modelID == "haiku" {
            small.append(request)
            reply = request.systemPrompt.contains("completion criteria")
                ? #"{"criteria": [{"text": "The importer parses a CSV with a header row", "check": null, "ui": null}, {"text": "Bad rows are reported with their line number", "check": null, "ui": null}]}"#
                : #"{"verdict": "met", "reason": "Both criteria are shown working.", "unmet_criteria": []}"#
        } else {
            agent.append(request)
            reply = "Working on it."
        }
        lock.unlock()
        return AsyncThrowingStream { continuation in
            continuation.yield(.textDelta(reply))
            continuation.yield(.turnCompleted(.endTurn))
            continuation.finish()
        }
    }
}

/// The goal model and its commands (CODE_AGENT_SPEC §2.3, §2.8): `/goal`
/// sets a goal with no approval card, pause, resume, edit and clear act on
/// it, and it survives a store round trip and a controller rebuild.
@MainActor
final class GoalModelTests: XCTestCase {
    private var base: URL!
    private var context: WorkspaceContext!
    private var store: CodeSessionStore!
    private var model: GoalScriptModel!

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-goal-model-\(UUID().uuidString)")
        let workspaceURL = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        let workspaceID = WorkspaceID()
        let access = try WorkspaceAccess(workspaceID: workspaceID, grantedURL: workspaceURL)
        context = WorkspaceContext(
            record: WorkspaceRecord(
                descriptor: WorkspaceDescriptor(
                    id: workspaceID,
                    displayName: "Goal fixture",
                    localPathHint: workspaceURL.path,
                    isGitRepository: false,
                    lastOpenedAt: Date()
                ),
                bookmarkData: Data()
            ),
            access: access,
            storageRoot: base.appendingPathComponent("storage")
        )
        store = CodeSessionStore(directoryURL: base.appendingPathComponent("sessions"))
        model = GoalScriptModel()
    }

    // Async, so it runs on the main actor with the rest of the @MainActor
    // case; a synchronous override is nonisolated and cannot read `base`.
    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: base)
    }

    private func controller(mode: PermissionMode = .askBeforeChanges) async throws -> SessionController {
        let session = try await store.createSession(
            workspaceID: context.record.id,
            workspaceName: "Goal fixture",
            title: "Goal",
            configuration: AgentConfiguration(modelID: "test-model", reasoningEffort: nil, permissionMode: mode),
            gitBranch: nil
        )
        let controller = SessionController(session: session, context: context, store: store, modelClient: model)
        await controller.attach()
        return controller
    }

    private func settle(_ controller: SessionController) async throws {
        await controller.awaitCurrentRun()
        for _ in 0..<400 where controller.isRunning || controller.session.status.isActive {
            try await Task.sleep(for: .milliseconds(5))
        }
        await controller.goal.refresh()
    }

    // MARK: - /goal

    func testSlashGoalDraftsAStartCardAndStartSetsTheGoalWithNoApproval() async throws {
        let controller = try await controller()

        await controller.goal.perform(.set(objective: "Make the importer handle CSV files"))
        let draft = try XCTUnwrap(controller.goal.draft, "the start card is showing")
        XCTAssertEqual(draft.objective, "Make the importer handle CSV files")
        XCTAssertEqual(draft.criteria.map(\.text), [
            "The importer parses a CSV with a header row",
            "Bad rows are reported with their line number",
        ])
        XCTAssertEqual(draft.budget, AutonomySettings.standard.goalBudget)
        let stored = await store.currentGoalRun(for: controller.sessionID)
        XCTAssertNil(stored, "nothing starts until Start")

        await controller.goal.confirmDraft()
        try await settle(controller)

        XCTAssertNil(controller.goal.draft)
        let goal = try XCTUnwrap(controller.goal.current)
        XCTAssertEqual(goal.objective, "Make the importer handle CSV files")
        XCTAssertEqual(goal.status, .achieved, "the judge said met at the end of the first turn")
        let events = await store.events(for: controller.sessionID)
        XCTAssertFalse(events.contains { if case .approvalRequested = $0.payload { return true } else { return false } },
                       "typing /goal was the approval: no card")
        let firstPrompt = events.compactMap { event -> String? in
            if case let .userPrompt(prompt) = event.payload { return prompt.text }
            return nil
        }.first
        XCTAssertEqual(firstPrompt, "Make the importer handle CSV files", "Start begins the first turn with the objective")
        XCTAssertTrue(events.contains { if case .goalSet = $0.payload { return true } else { return false } })
    }

    func testDismissingTheStartCardStartsNothing() async throws {
        let controller = try await controller()
        await controller.goal.perform(.set(objective: "Refactor the parser"))
        XCTAssertNotNil(controller.goal.draft)
        await controller.goal.cancelDraft()
        XCTAssertNil(controller.goal.draft)
        let stored = await store.currentGoalRun(for: controller.sessionID)
        XCTAssertNil(stored)
        XCTAssertTrue(model.agentRequests.isEmpty)
    }

    // MARK: - Pause, edit, resume, clear

    func testPauseEditResumeAndClear() async throws {
        let controller = try await controller()
        try await store.setGoal(GoalRun(objective: "Ship the importer"), for: controller.sessionID)
        await controller.goal.refresh()
        XCTAssertEqual(controller.goal.row?.actions, [.pause, .edit, .clear])

        await controller.goal.perform(.pause)
        XCTAssertEqual(controller.goal.current?.status, .paused)
        XCTAssertEqual(controller.goal.row?.actions.first, .resume)

        await controller.goal.perform(.edit)
        XCTAssertNotNil(controller.goal.draft)
        controller.goal.draft?.objective = "Ship the importer with CSV support"
        controller.goal.draft?.budget = Budget(minutes: 120, turns: 30)
        await controller.goal.confirmDraft()
        XCTAssertEqual(controller.goal.current?.objective, "Ship the importer with CSV support")
        XCTAssertEqual(controller.goal.current?.budget, Budget(minutes: 120, turns: 30))
        XCTAssertEqual(controller.goal.current?.status, .paused, "editing does not resume")
        let edited = await store.events(for: controller.sessionID).contains {
            if case .goalEdited = $0.payload { return true } else { return false }
        }
        XCTAssertTrue(edited)

        await controller.goal.perform(.resume)
        try await settle(controller)
        XCTAssertEqual(controller.goal.current?.status, .achieved, "resumed, worked a turn, and the judge said met")
        XCTAssertFalse(model.agentRequests.isEmpty)

        await controller.goal.perform(.clear)
        XCTAssertNil(controller.goal.current)
        XCTAssertEqual(controller.goal.history.last?.objective, "Ship the importer with CSV support")
        XCTAssertEqual(controller.goal.history.last?.status, .cleared)
    }

    func testAPausedGoalDoesNotBlockAMessage() async throws {
        let controller = try await controller()
        try await store.setGoal(GoalRun(objective: "Ship the importer", status: .paused), for: controller.sessionID)
        controller.composerText = "A question on the side"
        await controller.send()
        try await settle(controller)
        XCTAssertEqual(model.agentRequests.count, 1)
        XCTAssertNil(controller.transientError)
        let goal = await store.currentGoalRun(for: controller.sessionID)
        XCTAssertEqual(goal?.status, .paused, "a paused goal is not worked on")
        XCTAssertTrue(model.smallModelRequests.isEmpty, "nor judged")
    }

    // MARK: - Persistence

    func testTheGoalSurvivesAStoreRoundTripAndAControllerRebuild() async throws {
        let first = try await controller()
        let goal = GoalRun(
            objective: "Ship the importer",
            criteria: [GoalCriterion(id: "c1", text: "CSV parses", check: .command(checkID: "swift-test"))],
            constraints: ["Do not change the public API"],
            budget: Budget(minutes: 90, turns: 20),
            status: .paused,
            // Whole seconds: the file keeps dates to the second.
            createdAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
        try await store.setGoal(goal, for: first.sessionID)

        let reopened = CodeSessionStore(directoryURL: base.appendingPathComponent("sessions"))
        let file = await reopened.goalFile(for: first.sessionID)
        XCTAssertEqual(file.current, goal)

        let session = try await reopened.session(id: first.sessionID)
        let rebuilt = SessionController(session: session, context: context, store: reopened, modelClient: model)
        await rebuilt.attach()
        XCTAssertEqual(rebuilt.goal.current, goal)
        XCTAssertEqual(rebuilt.goal.row?.objective, "Ship the importer")
    }

    // MARK: - Words

    /// The grants the reader ticked apply while the goal runs. The goal
    /// runtime then ends the goal on its own — here, met — and nobody tells
    /// the permission coordinator; the session's grant check reads the stored
    /// goal at the moment of the call, so the grant is gone with it.
    func testATaskGrantEndsWhenTheRuntimeEndsItsGoal() async throws {
        let session = try await store.createSession(
            workspaceID: context.record.id,
            workspaceName: "Goal fixture",
            title: "Goal",
            configuration: AgentConfiguration(modelID: "test-model", reasoningEffort: nil, permissionMode: .askBeforeChanges),
            gitBranch: nil
        )
        var goal = GoalRun(objective: "Make the importer handle CSV files")
        goal.grants = [TaskGrant(command: "swift test", goalID: goal.id, worktreePath: context.access.rootURL.path)]
        try await store.setGoal(goal, for: session.id)
        let controller = SessionController(session: session, context: context, store: store, modelClient: model)
        await controller.attach()
        let permissions = try XCTUnwrap(controller.live?.permissions)

        let whileActive = await permissions.allowsWithoutPrompt(toolName: "run_command", subject: .command("swift test"), risk: .execute)
        XCTAssertTrue(whileActive, "the ticked command runs without asking while the goal is active")

        // The judge says met: the runtime moves the goal, not the reader.
        try await store.updateCurrentGoal(for: session.id, record: .status) { current in
            try current.transition(to: .achieved)
        }
        let afterMet = await permissions.allowsWithoutPrompt(toolName: "run_command", subject: .command("swift test"), risk: .execute)
        XCTAssertFalse(afterMet, "a met goal's grant no longer applies")
    }

    func testGoalCommandsParseWithTheirAliases() {
        XCTAssertEqual(GoalCommand.parse(""), .showSheet)
        XCTAssertEqual(GoalCommand.parse("pause"), .pause)
        XCTAssertEqual(GoalCommand.parse("Resume"), .resume)
        XCTAssertEqual(GoalCommand.parse("edit"), .edit)
        for alias in ["clear", "stop", "off", "cancel"] {
            XCTAssertEqual(GoalCommand.parse(alias), .clear, alias)
        }
        XCTAssertEqual(GoalCommand.parse("  Make the menu open on click "), .set(objective: "Make the menu open on click"))
    }

    func testTheRowSaysWhereTheGoalStandsInWords() {
        var goal = GoalRun(
            objective: "Make the settings menu open on click and keyboard",
            criteria: [
                GoalCriterion(id: "c1", text: "Tests pass"),
                GoalCriterion(id: "c2", text: "Menu opens"),
                GoalCriterion(id: "c3", text: "No other props change"),
            ]
        )
        goal.usage = GoalUsage(minutes: 38, turns: 7, tokens: nil, costUSD: 1.12)
        goal.record(GoalVerdict(kind: .gateBlocked, reason: "c2 has no Preview evidence yet", unmetCriteria: ["c2"], revision: 4))
        let active = GoalRowContent(goal: goal)
        XCTAssertEqual(active.facts, "2 of 3 criteria · 38 min · turn 7 · $1.12")
        XCTAssertEqual(active.detail, "Checking: c2 has no Preview evidence yet")
        XCTAssertEqual(active.actions, [.pause, .edit, .clear])

        try? goal.transition(to: .needsYou, reason: "Waiting for you to allow `npm install`")
        let waiting = GoalRowContent(goal: goal)
        XCTAssertEqual(waiting.detail, "Waiting for you to allow `npm install`")
        XCTAssertEqual(waiting.actions.first, .resume)

        try? goal.transition(to: .budgetReached, reason: "Used the goal's 240-minute budget")
        XCTAssertEqual(GoalRowContent(goal: goal).actions.first, .keepGoing)

        var met = GoalRun(objective: "Ship")
        met.usage = GoalUsage(minutes: 52, turns: 11, tokens: nil, costUSD: 2.4)
        try? met.transition(to: .achieved)
        let achieved = GoalRowContent(goal: met)
        XCTAssertTrue(achieved.facts.hasPrefix("Goal met in 52 min · 11 turns · $2.40"))
        XCTAssertEqual(achieved.actions, [.clear])
    }
}
