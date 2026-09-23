import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// A model that answers each turn from a script: tool calls, then text.
private final class ScriptedRewindModel: AgentModelClient, @unchecked Sendable {
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
            for event in events {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }

    static func call(_ id: String, _ name: String, _ input: JSONValue) -> [ModelStreamEvent] {
        [.toolCallRequested(id: id, name: name, input: input), .turnCompleted(.toolUse)]
    }

    static func reply(_ text: String) -> [ModelStreamEvent] {
        [.textDelta(text), .turnCompleted(.endTurn)]
    }
}

/// A model that answers from a script and then never answers again, so the
/// call after the script — a compaction summary — stays in flight.
private final class ScriptedThenSilentModel: AgentModelClient, @unchecked Sendable {
    private let scripted: ScriptedRewindModel
    private let lock = NSLock()
    private var remaining: Int

    init(_ steps: [[ModelStreamEvent]]) {
        scripted = ScriptedRewindModel(steps)
        remaining = steps.count
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        let answers = remaining > 0
        remaining -= 1
        lock.unlock()
        guard answers else { return SilentModel().streamTurn(request) }
        return scripted.streamTurn(request)
    }
}

/// A model that never answers, so a run stays active.
private final class SilentModel: AgentModelClient, @unchecked Sendable {
    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.onTermination = { _ in }
        }
    }
}

/// Rewind through the session controller: the three choices, the divergence
/// question, and the refusal while a run is active.
@MainActor
final class SessionRewindTests: XCTestCase {
    private var baseURL: URL!
    private var workspaceURL: URL!
    private var context: WorkspaceContext!
    private var store: CodeSessionStore!

    override func setUp() async throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-session-rewind-\(UUID().uuidString)")
        baseURL = base
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        workspaceURL = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        try "hello\n".write(to: workspaceURL.appendingPathComponent("notes.txt"), atomically: true, encoding: .utf8)

        let workspaceID = WorkspaceID()
        let access = try WorkspaceAccess(workspaceID: workspaceID, grantedURL: workspaceURL)
        context = WorkspaceContext(
            record: WorkspaceRecord(
                descriptor: WorkspaceDescriptor(
                    id: workspaceID,
                    displayName: "Rewind fixture",
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

    private func makeController(
        model: any AgentModelClient,
        withProject: Bool = true
    ) async throws -> SessionController {
        let session = try await store.createSession(
            workspaceID: withProject ? context.record.id : nil,
            workspaceName: withProject ? "Rewind fixture" : nil,
            title: "Rewind",
            configuration: AgentConfiguration(
                modelID: "test-model",
                reasoningEffort: nil,
                permissionMode: .workspaceWrite
            ),
            gitBranch: nil
        )
        let controller = SessionController(
            session: session,
            context: withProject ? context : nil,
            store: store,
            modelClient: model
        )
        await controller.attach()
        return controller
    }

    private func send(_ text: String, on controller: SessionController) async throws {
        controller.composerText = text
        await controller.send()
        await controller.awaitCurrentRun()
        // The store's updates reach the controller on the main actor.
        for _ in 0..<400 where controller.isRunning {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertFalse(controller.isRunning, "the run should have finished")
    }

    private func read(_ relative: String) throws -> String {
        try String(contentsOf: workspaceURL.appendingPathComponent(relative), encoding: .utf8)
    }

    private func exists(_ relative: String) -> Bool {
        FileManager.default.fileExists(atPath: workspaceURL.appendingPathComponent(relative).path)
    }

    /// Two turns: the first creates `first.txt`, the second edits `notes.txt`.
    private func twoTurns() async throws -> (SessionController, ScriptedRewindModel) {
        let model = ScriptedRewindModel([
            ScriptedRewindModel.call("create", "create_file", ["path": "first.txt", "content": "one\n"]),
            ScriptedRewindModel.reply("Created it."),
            ScriptedRewindModel.call("edit", "write_file", [
                "path": "notes.txt",
                "content": "changed\n",
                "base_sha256": .string(FileFingerprint(of: "hello\n").sha256),
            ]),
            ScriptedRewindModel.reply("Edited it."),
        ])
        let controller = try await makeController(model: model)
        try await send("Create first.txt", on: controller)
        try await send("Change the notes", on: controller)
        XCTAssertEqual(try read("notes.txt"), "changed\n")
        XCTAssertTrue(exists("first.txt"))
        return (controller, model)
    }

    // MARK: - The three choices

    func testRestoringCodeAndConversationPutsBothBackAndThePromptInTheComposer() async throws {
        let (controller, model) = try await twoTurns()
        let second = try XCTUnwrap(controller.rewindTurns.last)

        let preview = await controller.rewindPreview(for: second.id)
        XCTAssertEqual(preview?.files.map(\.path.value), ["notes.txt"])
        XCTAssertNil(preview?.unavailableReason(.codeAndConversation))

        let outcome = await controller.rewind(to: second.id, restoring: .codeAndConversation)

        XCTAssertEqual(outcome, .rewound(restoredPaths: ["notes.txt"]))
        XCTAssertEqual(try read("notes.txt"), "hello\n")
        XCTAssertTrue(exists("first.txt"), "the earlier turn's work stays")
        XCTAssertEqual(controller.rewindTurns.map(\.text), ["Create first.txt"])
        XCTAssertEqual(controller.composerText, "Change the notes")
        XCTAssertFalse(controller.events.contains {
            if case let .userPrompt(prompt) = $0.payload { return prompt.text == "Change the notes" }
            return false
        })
        let conversation = await store.loadConversation(sessionID: controller.sessionID)
        XCTAssertTrue(ConversationIntegrity.isValid(conversation))
        XCTAssertEqual(conversation.last, .assistant("Created it."))

        // Sending again continues from the cut.
        try await send("Change the notes to say hi", on: controller)
        let last = try XCTUnwrap(model.requests.last?.messages)
        XCTAssertEqual(Array(last.prefix(conversation.count)), conversation)
        XCTAssertEqual(last.dropFirst(conversation.count).first, .user("Change the notes to say hi"))
    }

    func testRestoringTheConversationAloneLeavesFiles() async throws {
        let (controller, _) = try await twoTurns()
        let second = try XCTUnwrap(controller.rewindTurns.last)

        let outcome = await controller.rewind(to: second.id, restoring: .conversation)

        XCTAssertEqual(outcome, .rewound(restoredPaths: []))
        XCTAssertEqual(try read("notes.txt"), "changed\n", "files stay as they are")
        XCTAssertEqual(controller.rewindTurns.count, 1)
        XCTAssertEqual(
            controller.changes.map(\.path),
            ["first.txt"],
            "the transcript, and the panel drawn from it, end before the rewound turn"
        )
        // Code can still be taken back to before the first turn, past the one
        // whose conversation is gone.
        let first = try XCTUnwrap(controller.rewindTurns.first)
        let code = await controller.rewind(to: first.id, restoring: .code)
        XCTAssertEqual(code, .rewound(restoredPaths: ["first.txt", "notes.txt"]))
        XCTAssertFalse(exists("first.txt"))
        XCTAssertEqual(try read("notes.txt"), "hello\n")
    }

    func testRestoringCodeAloneKeepsTheThread() async throws {
        let (controller, _) = try await twoTurns()
        let first = try XCTUnwrap(controller.rewindTurns.first)

        let outcome = await controller.rewind(to: first.id, restoring: .code)

        XCTAssertEqual(outcome, .rewound(restoredPaths: ["first.txt", "notes.txt"]))
        XCTAssertFalse(exists("first.txt"), "a file the turns created is removed")
        XCTAssertEqual(try read("notes.txt"), "hello\n")
        XCTAssertEqual(controller.rewindTurns.count, 2, "the conversation is untouched")
        XCTAssertEqual(controller.composerText, "")
        let preview = await controller.rewindPreview(for: first.id)
        XCTAssertEqual(preview?.files, [], "nothing is left to restore")
        XCTAssertNotNil(preview?.unavailableReason(.code))
    }

    // MARK: - Divergence

    func testAFileEditedSinceAsksBeforeItIsOverwritten() async throws {
        let (controller, _) = try await twoTurns()
        try "the reader's edit\n".write(
            to: workspaceURL.appendingPathComponent("notes.txt"),
            atomically: true,
            encoding: .utf8
        )
        let second = try XCTUnwrap(controller.rewindTurns.last)

        let preview = await controller.rewindPreview(for: second.id)
        XCTAssertEqual(preview?.divergedPaths, ["notes.txt"])

        let refused = await controller.rewind(to: second.id, restoring: .codeAndConversation)
        XCTAssertEqual(refused, .diverged(paths: ["notes.txt"]))
        XCTAssertEqual(try read("notes.txt"), "the reader's edit\n")
        XCTAssertEqual(controller.rewindTurns.count, 2, "a refusal changes nothing, conversation included")

        let forced = await controller.rewind(to: second.id, restoring: .codeAndConversation, force: true)
        XCTAssertEqual(forced, .rewound(restoredPaths: ["notes.txt"]))
        XCTAssertEqual(try read("notes.txt"), "hello\n")
        XCTAssertEqual(controller.rewindTurns.count, 1)
    }

    // MARK: - Refusals

    func testARewindIsRefusedWhileARunIsActive() async throws {
        let controller = try await makeController(model: SilentModel())
        controller.composerText = "Take your time"
        await controller.send()
        for _ in 0..<400 where !controller.isRunning {
            try await Task.sleep(for: .milliseconds(5))
        }
        let turn = try XCTUnwrap(controller.rewindTurns.first)

        let outcome = await controller.rewind(to: turn.id, restoring: .conversation)

        XCTAssertEqual(outcome, .failed(message: RewindCopy.running))
        await controller.stop()
    }

    /// A rewind holds the session from its checks to the reloaded
    /// transcript. A prompt from the phone, a message typed here and a
    /// `/compact` that arrive while it restores files and cuts the record are
    /// turned away — not started on the orchestrator the rewind is about to
    /// let go of, whose memory still holds the turns being cut.
    func testNothingStartsWhileARewindIsUnderWay() async throws {
        let (controller, model) = try await twoTurns()
        let second = try XCTUnwrap(controller.rewindTurns.last)
        let requestsBefore = model.requests.count

        let rewinding = Task { await controller.rewind(to: second.id, restoring: .codeAndConversation) }
        for _ in 0..<100 where !controller.isRewinding {
            await Task.yield()
        }
        XCTAssertTrue(controller.isRewinding, "the rewind should be under way")
        XCTAssertFalse(controller.isRunning, "a rewind is not a run: its own panel offers Stop by that")

        do {
            try await controller.deliverRemotePrompt("From the phone")
            XCTFail("a prompt from the phone was taken in the middle of a rewind")
        } catch let refusal as SessionController.RemotePromptRefusal {
            XCTAssertTrue(refusal.message.contains("being rewound"), refusal.message)
        }
        controller.composerText = "From the desk"
        await controller.send()
        XCTAssertEqual(controller.transientError, RewindCopy.inProgress)
        await controller.compactConversation()
        XCTAssertEqual(controller.transientError, RewindCopy.inProgress)
        let again = await controller.rewind(to: second.id, restoring: .conversation)
        XCTAssertEqual(again, .failed(message: RewindCopy.inProgress))

        let outcome = await rewinding.value
        XCTAssertEqual(outcome, .rewound(restoredPaths: ["notes.txt"]))
        XCTAssertFalse(controller.isRewinding)
        XCTAssertEqual(controller.rewindTurns.map(\.text), ["Create first.txt"])
        XCTAssertEqual(try read("notes.txt"), "hello\n")
        XCTAssertEqual(model.requests.count, requestsBefore, "no run started during the rewind")
        let prompts = await store.events(for: controller.sessionID).compactMap { event -> String? in
            if case let .userPrompt(prompt) = event.payload { return prompt.text }
            return nil
        }
        XCTAssertEqual(prompts, ["Create first.txt"])
        XCTAssertEqual(controller.composerText, "Change the notes\n\nFrom the desk", "the draft is kept")

        // Held no longer: the phone's next prompt goes, on the rewound history.
        let delivery = try await controller.deliverRemotePrompt("From the phone")
        let refusal = await delivery.outcome()
        XCTAssertNil(refusal)
        await controller.awaitCurrentRun()
        let sent = try XCTUnwrap(model.requests.last)
        XCTAssertFalse(sent.messages.contains(.user("Change the notes")), "a cut turn came back")
    }

    /// A `/compact` between runs saves its fold over the conversation when
    /// the model's summary comes back, so a rewind meanwhile would be undone
    /// by it, or have the turns it removed folded back into the summary.
    func testARewindIsRefusedWhileTheConversationIsBeingCompacted() async throws {
        let controller = try await makeController(
            model: ScriptedThenSilentModel([ScriptedRewindModel.reply("One."), ScriptedRewindModel.reply("Two.")]),
            withProject: false
        )
        try await send("First", on: controller)
        try await send("Second", on: controller)
        let second = try XCTUnwrap(controller.rewindTurns.last)

        let compacting = Task { await controller.compactConversation(focus: "the parser") }
        for _ in 0..<400 where !controller.isCompacting {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(controller.isCompacting)

        let outcome = await controller.rewind(to: second.id, restoring: .conversation)
        XCTAssertEqual(outcome, .failed(message: RewindCopy.compacting))
        XCTAssertEqual(controller.rewindTurns.map(\.text), ["First", "Second"], "nothing was cut")

        // Stop reaches the summary; the notes stand in and the fold ends.
        await controller.stop()
        await compacting.value
        XCTAssertFalse(controller.isCompacting)
    }

    func testAConversationWithNoProjectRewindsItsConversationOnly() async throws {
        let controller = try await makeController(
            model: ScriptedRewindModel([ScriptedRewindModel.reply("One."), ScriptedRewindModel.reply("Two.")]),
            withProject: false
        )
        try await send("First", on: controller)
        try await send("Second", on: controller)
        let second = try XCTUnwrap(controller.rewindTurns.last)

        let preview = await controller.rewindPreview(for: second.id)
        XCTAssertEqual(preview?.codeUnavailable, RewindCopy.noProject)
        XCTAssertNotNil(preview?.unavailableReason(.codeAndConversation))
        XCTAssertNil(preview?.unavailableReason(.conversation))

        let outcome = await controller.rewind(to: second.id, restoring: .conversation)
        XCTAssertEqual(outcome, .rewound(restoredPaths: []))
        XCTAssertEqual(controller.rewindTurns.map(\.text), ["First"])
        XCTAssertEqual(controller.composerText, "Second")
    }

    func testADraftInTheComposerIsKeptWhenAPromptComesBack() async throws {
        let (controller, _) = try await twoTurns()
        let second = try XCTUnwrap(controller.rewindTurns.last)
        controller.composerText = "half a thought"

        _ = await controller.rewind(to: second.id, restoring: .conversation)

        XCTAssertEqual(controller.composerText, "Change the notes\n\nhalf a thought")
    }

    // MARK: - Esc Esc

    func testTwoQuickPressesMakeOneGesture() {
        var presses = StudioDoublePress(interval: 0.5)
        let start = Date()

        XCTAssertFalse(presses.press(at: start))
        XCTAssertTrue(presses.press(at: start.addingTimeInterval(0.3)))
        XCTAssertFalse(presses.press(at: start.addingTimeInterval(0.4)), "a completed pair starts over")
        XCTAssertFalse(presses.press(at: start.addingTimeInterval(1.2)), "too slow to pair")
        presses.reset()
        XCTAssertFalse(presses.press(at: start.addingTimeInterval(1.3)), "a reset forgets the last press")
    }
}
