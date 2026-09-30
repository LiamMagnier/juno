import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Answers each turn from a script and records every request.
private final class PrefixRecordingModel: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var steps: [[ModelStreamEvent]]
    private var received: [ModelTurnRequest] = []

    init(_ steps: [[ModelStreamEvent]]) {
        self.steps = steps
    }

    var requests: [ModelTurnRequest] {
        lock.lock()
        defer { lock.unlock() }
        return received
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        received.append(request)
        let events = steps.isEmpty
            ? [.textDelta("Done."), .turnCompleted(.endTurn)]
            : steps.removeFirst()
        lock.unlock()
        return AsyncThrowingStream { continuation in
            events.forEach { continuation.yield($0) }
            continuation.finish()
        }
    }
}

/// The system prompt and tool list a session sends stay byte for byte the
/// same while its goal changes, because the goal, the date, the branch and
/// the skills reach the model as `<session_state>` blocks instead.
@MainActor
final class StableCachePrefixTests: XCTestCase {
    private var workspaceURL: URL!
    private var context: WorkspaceContext!
    private var store: CodeSessionStore!

    override func setUp() async throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-stable-prefix-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        workspaceURL = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        let workspaceID = WorkspaceID()
        let access = try WorkspaceAccess(workspaceID: workspaceID, grantedURL: workspaceURL)
        context = WorkspaceContext(
            record: WorkspaceRecord(
                descriptor: WorkspaceDescriptor(
                    id: workspaceID,
                    displayName: "Prefix fixture",
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
    }

    func testGoalUpdatesBetweenTurnsLeaveTheSystemPromptAndToolsByteIdentical() async throws {
        let model = PrefixRecordingModel([
            [
                .toolCallRequested(id: "goal-1", name: "update_goal", input: [
                    "action": "create",
                    "objective": "Ship the importer",
                    "steps": ["Parse", "Verify"],
                ]),
                .turnCompleted(.toolUse),
            ],
            [.textDelta("Goal recorded."), .turnCompleted(.endTurn)],
            [
                .toolCallRequested(id: "goal-2", name: "update_goal", input: [
                    "action": "add_step",
                    "step_title": "Document",
                ]),
                .turnCompleted(.toolUse),
            ],
            [.textDelta("Step added."), .turnCompleted(.endTurn)],
        ])
        let session = try await store.createSession(
            workspaceID: context.record.id,
            workspaceName: "Prefix fixture",
            title: "Prefix",
            configuration: AgentConfiguration(
                modelID: "test-model",
                reasoningEffort: nil,
                permissionMode: .fullAccess
            ),
            gitBranch: nil
        )
        let controller = SessionController(
            session: session,
            context: context,
            store: store,
            modelClient: model
        )
        await controller.attach()

        try await send("Plan the importer", on: controller)
        XCTAssertEqual(controller.session.goal?.objective, "Ship the importer")
        try await send("Add documentation to the plan", on: controller)
        XCTAssertEqual(controller.session.goal?.steps.count, 3)

        let requests = model.requests
        XCTAssertEqual(requests.count, 4)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let system = Data(requests[0].systemPrompt.utf8)
        let tools = try encoder.encode(requests[0].tools)
        for request in requests {
            XCTAssertEqual(Data(request.systemPrompt.utf8), system, "the system prompt never changes")
            XCTAssertEqual(try encoder.encode(request.tools), tools, "nor does the tool list")
        }
        XCTAssertFalse(requests[0].systemPrompt.contains("Objective:"))
        XCTAssertFalse(requests[0].systemPrompt.contains("Date:"))
        XCTAssertTrue(requests[0].systemPrompt.contains("<session_state>"), "it says what the blocks are")
        for (earlier, later) in zip(requests, requests.dropFirst()) {
            XCTAssertEqual(Array(later.messages.prefix(earlier.messages.count)), earlier.messages)
        }

        let blocks = requests[3].messages.compactMap { message -> String? in
            guard case let .user(text) = message, text.hasPrefix("<session_state") else { return nil }
            return text
        }
        XCTAssertEqual(blocks.count, 3)
        XCTAssertTrue(blocks[0].contains("<environment>\nDate: "))
        XCTAssertTrue(blocks[0].contains("No goal is set."))
        XCTAssertTrue(blocks[0].contains("No skills are enabled."))
        // Later blocks carry only the section that changed.
        XCTAssertTrue(blocks[1].contains("Objective: Ship the importer"))
        XCTAssertFalse(blocks[1].contains("<environment>"))
        XCTAssertTrue(blocks[2].contains("Document"))
    }

    private func send(_ text: String, on controller: SessionController) async throws {
        controller.composerText = text
        await controller.send()
        await controller.awaitCurrentRun()
        for _ in 0..<400 where controller.isRunning {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertFalse(controller.isRunning, "the run should have finished")
        // The goal reaches the controller through the store's observer.
        for _ in 0..<200 {
            if (try? await store.goal(for: controller.sessionID)) == controller.session.goal { break }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
}
