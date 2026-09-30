import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime
@testable import JunoCodeUI

/// Answers each turn from a list: a tool call, or text.
private final class TurnScript: AgentModelClient, @unchecked Sendable {
    enum Turn {
        case call(id: String, name: String, input: JSONValue)
        case text(String)
    }

    private let lock = NSLock()
    private var turns: [Turn]
    private var storage: [ModelTurnRequest] = []

    init(_ turns: [Turn]) {
        self.turns = turns
    }

    var requests: [ModelTurnRequest] { lock.withLock { storage } }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        let turn = lock.withLock { () -> Turn in
            storage.append(request)
            return turns.isEmpty ? .text("Done.") : turns.removeFirst()
        }
        return AsyncThrowingStream { continuation in
            switch turn {
            case let .call(id, name, input):
                continuation.yield(.toolCallRequested(id: id, name: name, input: input))
                continuation.yield(.turnCompleted(.toolUse))
            case let .text(text):
                continuation.yield(.textDelta(text))
                continuation.yield(.turnCompleted(.endTurn))
            }
            continuation.finish()
        }
    }
}

/// Plan → approve → Code, and questions, through the session controller the
/// Studio drives.
@MainActor
final class PlanHandoffTests: XCTestCase {
    private var root: URL!

    override func setUp() async throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-plan-handoff-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("project"),
            withIntermediateDirectories: true
        )
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makeController(
        behavior: AgentBehavior,
        storedMode: PermissionMode,
        model: TurnScript
    ) async throws -> (SessionController, CodeSessionStore, CodeSessionID) {
        let workspaceID = WorkspaceID()
        let project = root.appendingPathComponent("project")
        let context = WorkspaceContext(
            record: WorkspaceRecord(
                descriptor: WorkspaceDescriptor(
                    id: workspaceID,
                    displayName: "Project",
                    localPathHint: project.path,
                    isGitRepository: false,
                    lastOpenedAt: Date()
                ),
                bookmarkData: Data()
            ),
            access: try WorkspaceAccess(workspaceID: workspaceID, grantedURL: project),
            storageRoot: root.appendingPathComponent("storage"),
            userSettingsDirectory: nil
        )
        let store = CodeSessionStore(directoryURL: root.appendingPathComponent("sessions"))
        let session = try await store.createSession(
            workspaceID: workspaceID,
            workspaceName: "Project",
            title: "Plan",
            configuration: AgentConfiguration(
                modelID: "test-model",
                behavior: behavior,
                permissionMode: storedMode
            ),
            gitBranch: nil
        )
        let controller = SessionController(session: session, context: context, store: store, modelClient: model)
        await controller.attach()
        return (controller, store, session.id)
    }

    private func eventually(_ condition: @MainActor () async -> Bool) async throws {
        for _ in 0..<300 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("the condition never held")
    }

    func testApprovingAPlanStartsACodeTurnAtExactlyThePickedLevel() async throws {
        let plan = "1. Add `limit` to the query\n2. Test it"
        let model = TurnScript([
            .call(id: "p1", name: "exit_plan", input: ["plan": .string(plan)]),
            .text("Implemented."),
        ])
        // The session held Full access before Plan; approving at Ask must
        // not hand that back.
        let (controller, store, sessionID) = try await makeController(
            behavior: .plan, storedMode: .fullAccess, model: model
        )
        controller.composerText = "Plan the limit parameter"
        await controller.send()
        try await eventually { !model.requests.isEmpty }

        let firstTools = Set(model.requests.first?.tools.map(\.name) ?? [])
        XCTAssertTrue(firstTools.contains("exit_plan"))
        XCTAssertTrue(firstTools.contains("todo_write"))
        XCTAssertFalse(firstTools.contains("write_file"), "Plan is read-only by construction")

        try await eventually { !controller.pendingPlans.isEmpty }
        let request = try XCTUnwrap(controller.pendingPlans.first)
        XCTAssertEqual(request.plan, plan)

        await controller.approvePlan(request.id, mode: .askBeforeChanges)
        try await eventually { model.requests.count == 2 }
        try await eventually {
            (try? await store.session(id: sessionID).status.isActive) == false
        }

        XCTAssertEqual(controller.session.configuration.behavior, .code)
        XCTAssertEqual(controller.session.configuration.permissionMode, .askBeforeChanges)
        let live = await controller.live?.permissions.permissionMode
        XCTAssertEqual(live, .askBeforeChanges)

        let second = try XCTUnwrap(model.requests.last)
        let secondTools = Set(second.tools.map(\.name))
        XCTAssertTrue(secondTools.contains("write_file"), "the implementation turn can edit")
        XCTAssertFalse(secondTools.contains("exit_plan"), "and has no plan to hand over")
        guard case let .user(prompt)? = second.messages.last else {
            return XCTFail("the turn opens with the plan")
        }
        XCTAssertTrue(prompt.contains("<approved_plan>\n\(plan)\n</approved_plan>"), prompt)

        let prompts = controller.events.compactMap { event -> String? in
            if case let .userPrompt(prompt) = event.payload { return prompt.text }
            return nil
        }
        XCTAssertEqual(prompts, ["Plan the limit parameter", "Implement the approved plan."])
    }

    func testKeepPlanningStaysInPlan() async throws {
        let model = TurnScript([
            .call(id: "p1", name: "exit_plan", input: ["plan": "Rough"]),
            .text("I will revise it."),
        ])
        let (controller, store, sessionID) = try await makeController(
            behavior: .plan, storedMode: .workspaceWrite, model: model
        )
        controller.composerText = "Plan it"
        await controller.send()
        try await eventually { !controller.pendingPlans.isEmpty }
        await controller.keepPlanning(try XCTUnwrap(controller.pendingPlans.first).id, feedback: "Add a rollback")
        try await eventually {
            (try? await store.session(id: sessionID).status.isActive) == false
        }
        XCTAssertEqual(model.requests.count, 2)
        XCTAssertEqual(controller.session.configuration.behavior, .plan)
        let mode = await controller.live?.permissions.permissionMode
        XCTAssertEqual(mode, .readOnly)
        XCTAssertTrue(controller.pendingPlans.isEmpty)
    }

    func testAQuestionIsShownThenAnsweredFromTheController() async throws {
        let model = TurnScript([
            .call(id: "q1", name: "ask_user", input: [
                "questions": [["question": "Tabs or spaces?", "options": [["label": "Tabs"], ["label": "Spaces"]]]],
            ]),
            .text("Spaces it is."),
        ])
        let (controller, store, sessionID) = try await makeController(
            behavior: .ask, storedMode: .workspaceWrite, model: model
        )
        controller.composerText = "Format the file"
        await controller.send()
        try await eventually { !controller.pendingQuestions.isEmpty }
        let request = try XCTUnwrap(controller.pendingQuestions.first)
        XCTAssertEqual(request.questions.first?.question, "Tabs or spaces?")

        await controller.answerQuestion(
            request.id,
            answers: [QuestionAnswer(questionID: "q1", selectedOptions: ["Spaces"])]
        )
        try await eventually {
            (try? await store.session(id: sessionID).status.isActive) == false
        }
        XCTAssertTrue(controller.pendingQuestions.isEmpty)
        guard case let .toolResult(_, content, _)? = model.requests.last?.messages.last else {
            return XCTFail("the answer is the tool's result")
        }
        XCTAssertTrue(content.contains("→ Spaces"), content)

        let items = StudioThreadItems.build(
            events: controller.events,
            groups: controller.narrativeGroups,
            pendingApprovalIDs: [],
            showReasoning: false
        )
        XCTAssertTrue(items.contains { if case .question = $0 { return true } else { return false } })
    }
}
