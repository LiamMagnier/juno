import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Answers agent turns with a line of text and summary requests with a
/// summary, reporting usage for both, as a provider would.
private final class SummarisingModelClient: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [ModelTurnRequest] = []

    var requests: [ModelTurnRequest] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        storage.append(request)
        lock.unlock()
        let isSummary = request.tools.isEmpty && request.maximumOutputTokens != nil
        return AsyncThrowingStream { continuation in
            if isSummary {
                continuation.yield(.usage(inputTokens: 2_000, outputTokens: 150))
                continuation.yield(.textDelta("<summary>**Current work.** Both turns answered.</summary>"))
            } else {
                continuation.yield(.usage(inputTokens: 100, outputTokens: 10))
                continuation.yield(.textDelta("Answered."))
            }
            continuation.yield(.turnCompleted(.endTurn))
            continuation.finish()
        }
    }
}

/// A model that never answers, so a run stays working for as long as a test
/// needs it to.
private final class HangingModelClient: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var requestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        count += 1
        lock.unlock()
        return AsyncThrowingStream { continuation in
            continuation.onTermination = { _ in }
        }
    }
}

@MainActor
final class CompactionSurfaceTests: XCTestCase {
    private var baseURL: URL!

    override func setUp() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-compaction-ui-\(UUID().uuidString)")
        baseURL = root
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("workspace"),
            withIntermediateDirectories: true
        )
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        for _ in 0..<300 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    /// `/compact keep …` from the composer reaches the model as focus, shows
    /// as one compaction in the thread, and its call is counted with the rest.
    func testCompactWithFocusThroughTheController() async throws {
        let client = SummarisingModelClient()
        let controller = try await liveController(client)

        for prompt in ["First request", "Second request"] {
            let expected = client.requests.count + 1
            controller.composerText = prompt
            await controller.send()
            try await waitUntil { client.requests.count >= expected && !controller.session.status.isActive }
        }

        await controller.compactConversation(focus: "  the parser decisions ")
        try await waitUntil { controller.sessionUsage.requests >= 3 }

        XCTAssertFalse(controller.isCompacting)
        XCTAssertNil(controller.transientError)
        let summaryRequest = try XCTUnwrap(client.requests.last)
        guard case let .user(prompt) = summaryRequest.messages.first else {
            return XCTFail("expected the summary request")
        }
        XCTAssertTrue(prompt.contains("the parser decisions"))

        let compactions = controller.events.compactMap { event -> CompactionEvent? in
            if case let .compaction(value) = event.payload { return value }
            return nil
        }
        XCTAssertEqual(compactions.count, 1)
        XCTAssertEqual(compactions.first?.summarySource, .model)
        XCTAssertEqual(compactions.first?.focus, "the parser decisions")
        XCTAssertTrue(compactions.first?.requestedByUser == true)

        // Two turns and the summary, as billed.
        XCTAssertEqual(controller.sessionUsage.requests, 3)
        XCTAssertEqual(controller.sessionUsage.inputTokens, 100 + 100 + 2_000)
        XCTAssertEqual(controller.sessionUsage.outputTokens, 10 + 10 + 150)
    }

    func testCompactIsRefusedWhileARunIsWorking() async throws {
        let client = HangingModelClient()
        let controller = try await liveController(client)
        controller.composerText = "A long task"
        await controller.send()
        try await waitUntil { controller.session.status.isActive && client.requestCount == 1 }
        XCTAssertTrue(controller.session.status.isActive)

        await controller.compactConversation(focus: "anything")

        XCTAssertEqual(
            controller.transientError,
            "Alevr is still working. Compaction happens between turns; try again once this one ends."
        )
        XCTAssertFalse(controller.events.contains { event in
            if case .compaction = event.payload { return true }
            return false
        })
        XCTAssertEqual(client.requestCount, 1, "no summary call is made mid-run")
        await controller.stop()
    }

    private func liveController(_ client: any AgentModelClient) async throws -> SessionController {
        let workbench = WorkbenchModel(
            dependencies: WorkbenchModel.Dependencies(
                storageRootURL: baseURL.appendingPathComponent("storage-\(UUID().uuidString)"),
                modelClient: client,
                availableModels: [ModelOption(modelID: "test-model", displayName: "Test Model")]
            )
        )
        await workbench.bootstrap()
        let added = await workbench.addWorkspace(grantedURL: baseURL.appendingPathComponent("workspace"))
        let created = await workbench.createSession(
            workspaceID: try XCTUnwrap(added).id,
            configuration: AgentConfiguration(modelID: "test-model")
        )
        let loaded = await workbench.controller(for: try XCTUnwrap(created).id)
        return try XCTUnwrap(loaded)
    }

    func testPreviewCompactRecordsTheFocus() async throws {
        let controller = SessionController(previewFixture: CodePreviewData.fixture(for: .transcript))
        let before = controller.events.count

        await controller.compactConversation(focus: "  the spacing scale ")

        XCTAssertEqual(controller.events.count, before + 1)
        guard case let .compaction(event)? = controller.events.last?.payload else {
            return XCTFail("expected a compaction row")
        }
        XCTAssertEqual(event.focus, "the spacing scale")
        XCTAssertTrue(event.requestedByUser)
    }
}
