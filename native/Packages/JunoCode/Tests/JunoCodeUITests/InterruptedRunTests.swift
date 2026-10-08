import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Records each request and answers with one line.
private final class AnsweringModel: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var received: [ModelTurnRequest] = []

    var requests: [ModelTurnRequest] {
        lock.lock()
        defer { lock.unlock() }
        return received
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        received.append(request)
        lock.unlock()
        return AsyncThrowingStream { continuation in
            continuation.yield(.textDelta("Carried on."))
            continuation.yield(.turnCompleted(.endTurn))
            continuation.finish()
        }
    }
}

/// A run Juno quit in the middle of comes back as interrupted, with Resume,
/// and Resume carries on with a runtime note and no new reader message
/// (CODE_AGENT_SPEC §1.12).
@MainActor
final class InterruptedRunTests: XCTestCase {
    private var root: URL!

    override func setUp() async throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-interrupted-\(UUID().uuidString)")
        let directory = root!
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    /// A session left mid-batch: a prompt, a command that started and never
    /// finished, the conversation saved before the batch ran, and the status
    /// still running, as a crash leaves it.
    private func sessionLeftMidRun() async throws -> CodeSessionID {
        let store = CodeSessionStore(directoryURL: root.appendingPathComponent("sessions"))
        let session = try await store.createSession(
            workspaceID: nil,
            workspaceName: nil,
            title: "Migrate the settings",
            configuration: AgentConfiguration(modelID: "test-model", permissionMode: .workspaceWrite),
            gitBranch: nil
        )
        _ = try await store.appendEvent(
            sessionID: session.id,
            payload: .userPrompt(UserPromptEvent(text: "Run the migration", conversationIndex: 0))
        )
        try await store.setStatus(id: session.id, status: .running)
        _ = try await store.appendEvent(sessionID: session.id, payload: .toolProposed(ToolProposedEvent(
            toolCallID: "migrate",
            toolName: "run_command",
            input: ["command": "npm run migrate"],
            risk: .critical,
            summary: "Run: npm run migrate"
        )))
        _ = try await store.appendEvent(sessionID: session.id, payload: .toolStarted(ToolStartedEvent(toolCallID: "migrate")))
        try await store.saveConversation(sessionID: session.id, messages: [
            .user("Run the migration"),
            .toolCall(id: "migrate", name: "run_command", input: ["command": "npm run migrate"]),
        ])
        await store.saveTranscriptSummaries()
        return session.id
    }

    func testARestoredInterruptedSessionOffersResumeAndResumeAddsNoReaderMessage() async throws {
        let id = try await sessionLeftMidRun()

        // Relaunch: a fresh store reads the record and marks the run
        // interrupted.
        let relaunched = CodeSessionStore(directoryURL: root.appendingPathComponent("sessions"))
        let session = try await relaunched.session(id: id)
        XCTAssertEqual(session.status, .failed)
        XCTAssertEqual(session.lastErrorSummary, CodeSessionStore.interruptionMessage)

        let entry = RunIndex.entry(for: RunFacts(session: session, project: "No project"))
        XCTAssertEqual(entry?.group, .interrupted)
        XCTAssertEqual(entry?.actions, [.resume], "the row offers Resume")

        let model = AnsweringModel()
        let controller = SessionController(session: session, context: nil, store: relaunched, modelClient: model)
        await controller.attach()
        XCTAssertTrue(controller.isInterrupted)
        XCTAssertEqual(controller.interruptedCallSummaries, ["Run: npm run migrate"])
        let promptsBefore = controller.events.filter { if case .userPrompt = $0.payload { return true } else { return false } }.count

        let resumed = await controller.resumeInterrupted()
        XCTAssertTrue(resumed)
        await controller.awaitCurrentRun()
        for _ in 0..<300 where controller.session.status.isActive {
            try await Task.sleep(for: .milliseconds(5))
        }

        let request = try XCTUnwrap(model.requests.first, "Resume must reach the model")
        guard case let .user(note)? = request.messages.last else {
            return XCTFail("the last message must be Alevr's note, got \(String(describing: request.messages.last))")
        }
        XCTAssertTrue(RuntimeNote.isRuntimeNote(note), "fenced as runtime text, never as the reader")
        XCTAssertTrue(note.hasPrefix("<juno_runtime reason=\"after_quit\""), note)
        XCTAssertTrue(note.contains("Run: npm run migrate"), "the call whose outcome is unknown is named")
        XCTAssertTrue(request.messages.contains {
            if case let .toolResult(id, content, _) = $0 {
                return id == "migrate" && content == ConversationIntegrity.outcomeUnknownMessage
            }
            return false
        }, "the model is told the running call's outcome is unknown")
        let events = await relaunched.events(for: id)
        let promptsAfter = events.filter { if case .userPrompt = $0.payload { return true } else { return false } }.count
        XCTAssertEqual(promptsAfter, promptsBefore, "Resume adds no reader message")
        XCTAssertTrue(events.contains {
            if case let .runContinued(continued) = $0.payload { return continued.reason == .afterQuit }
            return false
        }, "the resume is recorded as a continuation")
        XCTAssertFalse(controller.isInterrupted, "the session is no longer interrupted")
    }

    func testResumeOnLaunchIsOffByDefault() {
        let preferences = StudioPreferences(store: UserDefaults(suiteName: "juno.resume.\(UUID().uuidString)")!)
        XCTAssertFalse(preferences.resumeInterruptedOnLaunch, "D-025: off by default")
    }

    func testTheWorkbenchResumesInterruptedRunsAtLaunchOnlyWhenTheSettingIsOn() async throws {
        let id = try await sessionLeftMidRun()
        // The workbench's store lives under its storage root.
        let storage = root.appendingPathComponent("storage")
        try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
        try FileManager.default.moveItem(
            at: root.appendingPathComponent("sessions"),
            to: storage.appendingPathComponent("sessions-store")
        )
        let model = AnsweringModel()
        let off = WorkbenchModel(dependencies: WorkbenchModel.Dependencies(
            storageRootURL: storage,
            modelClient: model,
            availableModels: [ModelOption(modelID: "test-model", displayName: "Test")]
        ))
        off.resumesInterruptedRunsOnLaunch = { false }
        await off.bootstrap()
        XCTAssertEqual(off.runSections.first?.group, .interrupted)
        XCTAssertTrue(model.requests.isEmpty, "nothing carries on by itself while the setting is off")

        let on = WorkbenchModel(dependencies: WorkbenchModel.Dependencies(
            storageRootURL: storage,
            modelClient: model,
            availableModels: [ModelOption(modelID: "test-model", displayName: "Test")]
        ))
        on.resumesInterruptedRunsOnLaunch = { true }
        await on.bootstrap()
        for _ in 0..<300 where model.requests.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(model.requests.count, 1, "with the setting on, the run resumes at launch")
        _ = id
    }
}
