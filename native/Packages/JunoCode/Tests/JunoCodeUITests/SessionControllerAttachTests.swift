import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime
@testable import JunoCodeUI

/// Holds every transcript read at its first line until the test lets it go,
/// so a test can act while `attach()` is part-way through reading.
private final class TranscriptReadGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var isOpen = true
    private var heldReads = 0

    /// Whether a read has reached the gate while it was closed.
    var hasHeldARead: Bool {
        condition.lock()
        defer { condition.unlock() }
        return heldReads > 0
    }

    func close() {
        condition.lock()
        isOpen = false
        condition.unlock()
    }

    func open() {
        condition.lock()
        isOpen = true
        condition.broadcast()
        condition.unlock()
    }

    var decoder: SessionEventLineDecoder {
        SessionEventLineDecoder { [self] line in
            condition.lock()
            if !isOpen {
                heldReads += 1
                while !isOpen { condition.wait() }
            }
            condition.unlock()
            return SessionEventLineDecoder.standard.decode(line)
        }
    }
}

@MainActor
final class SessionControllerAttachTests: XCTestCase {
    private var gate: TranscriptReadGate!
    private var store: CodeSessionStore!
    private var session: CodeSession!

    override func setUp() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-attach-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let gate = TranscriptReadGate()
        self.gate = gate
        // Never left closed by a failing test, which would strand the read on
        // a thread of the shared pool.
        addTeardownBlock { gate.open() }
        store = CodeSessionStore(
            directoryURL: root,
            eventDecoder: gate.decoder,
            transcriptSaveDelay: .seconds(3_600)
        )
        session = try await store.createSession(
            workspaceID: nil,
            workspaceName: nil,
            title: "Streaming while reopened",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
        try await store.appendEvent(
            sessionID: session.id,
            payload: .userPrompt(UserPromptEvent(text: "Tidy the parser"))
        )
        try await store.appendEvent(
            sessionID: session.id,
            payload: .toolStarted(ToolStartedEvent(toolCallID: "call-1"))
        )
    }

    /// A turn still streaming in a session the reader returns to keeps
    /// appending while its transcript is read. None of it may go missing from
    /// the controller: not the output, the changed file, the tool's completion
    /// or the reply.
    func testEventsAppendedWhileAttachIsReadingAreKept() async throws {
        let controller = makeController()
        gate.close()
        let attaching = Task { await controller.attach() }
        try await waitUntil { self.gate.hasHeldARead }

        // Appended while the read is held: past the length it is reading to,
        // and delivered to the controller's observer before the read returns.
        var appendedDuringRead: [SessionEvent] = []
        for payload: SessionEventPayload in [
            .toolOutput(ToolOutputEvent(toolCallID: "call-1", channel: .stdout, text: "Compiling\n")),
            .fileChanged(
                FileChangedEvent(
                    path: try WorkspacePath("Sources/Parser.swift"),
                    kind: .modified,
                    linesAdded: 4,
                    linesRemoved: 2,
                    checkpointID: nil
                )
            ),
            .toolCompleted(
                ToolCompletedEvent(
                    toolCallID: "call-1",
                    status: .succeeded,
                    resultSummary: "Built",
                    durationSeconds: 1
                )
            ),
            .assistantMessage(AssistantMessageEvent(text: "The parser is tidy.")),
        ] {
            appendedDuringRead.append(
                try await store.appendEvent(sessionID: session.id, payload: payload)
            )
        }
        // Let every delivery reach the main actor while the read is still held,
        // which is the order that used to lose them.
        for _ in 0..<20 { await Task.yield() }
        try await Task.sleep(for: .milliseconds(50))

        gate.open()
        await attaching.value

        let stored = await store.events(for: session.id)
        XCTAssertEqual(stored.count, 7)
        XCTAssertEqual(
            controller.events.map(\.id),
            stored.map(\.id),
            "every event exactly once, in transcript order"
        )
        XCTAssertTrue(
            controller.events.contains { $0.id == appendedDuringRead.last?.id },
            "the reply appended during the read is in the thread"
        )
        XCTAssertEqual(controller.liveAssistantText, "")
        XCTAssertTrue(
            controller.terminal.contains { $0.text.contains("Compiling") },
            "output appended during the read reaches the console"
        )
        XCTAssertEqual(
            controller.changes.map(\.path),
            ["Sources/Parser.swift"],
            "a file changed during the read reaches the changes panel"
        )

        // And observation carries on from there, once per event.
        let after = try await store.appendEvent(
            sessionID: session.id,
            payload: .userPrompt(UserPromptEvent(text: "Thanks"))
        )
        try await waitUntil { controller.events.last?.id == after.id }
        XCTAssertEqual(controller.events.filter { $0.id == after.id }.count, 1)
        XCTAssertEqual(controller.events.count, 8)
    }

    /// The window and the remote bridge can both open a session at once. The
    /// second `attach()` must wait for the first to finish reading rather than
    /// return a controller with nothing in it, and must not observe the store
    /// a second time.
    func testASecondAttachWaitsForTheOneUnderWay() async throws {
        let controller = makeController()
        gate.close()
        let first = Task { await controller.attach() }
        try await waitUntil { self.gate.hasHeldARead }

        let secondReturned = LockedFlag()
        let second = Task {
            await controller.attach()
            secondReturned.set()
        }
        for _ in 0..<20 { await Task.yield() }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(secondReturned.value, "returned while the transcript was still being read")

        gate.open()
        await first.value
        await second.value
        XCTAssertEqual(controller.events.count, 3)

        let after = try await store.appendEvent(
            sessionID: session.id,
            payload: .assistantMessage(AssistantMessageEvent(text: "Done."))
        )
        try await waitUntil { controller.events.last?.id == after.id }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(
            controller.events.filter { $0.id == after.id }.count,
            1,
            "observed once, not once per attach"
        )
    }

    // MARK: - Helpers

    private func makeController() -> SessionController {
        SessionController(
            session: session,
            context: nil,
            store: store,
            modelClient: UnconfiguredModelClient()
        )
    }

    private func waitUntil(
        timeout: Duration = .seconds(10),
        _ condition: () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            guard ContinuousClock.now < deadline else {
                XCTFail("timed out waiting", file: file, line: line)
                throw CancellationError()
            }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = false

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func set() {
        lock.lock()
        storage = true
        lock.unlock()
    }
}
