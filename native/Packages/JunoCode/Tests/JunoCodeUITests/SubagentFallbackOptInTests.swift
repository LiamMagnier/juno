import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Delegates once, then answers; every sub-agent request fails for the
/// provider's quota, which is a failure a fallback model would answer.
private final class DelegatingModel: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var parentTurns = 0
    private var childModelIDs: [String] = []

    var childRequests: [String] {
        lock.lock(); defer { lock.unlock() }
        return childModelIDs
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        let isChild = request.systemPrompt.contains("sub-agent")
        if isChild { childModelIDs.append(request.modelID) } else { parentTurns += 1 }
        let turn = parentTurns
        lock.unlock()
        return AsyncThrowingStream { continuation in
            if isChild {
                continuation.finish(throwing: AgentModelClientError.quotaExhausted(message: "Insufficient Balance"))
                return
            }
            if turn == 1 {
                continuation.yield(.toolCallRequested(id: "d1", name: "delegate_task", input: [
                    "tasks": [["task": "Map the callers", "title": "Callers", "role": "engineer"]],
                ]))
                continuation.yield(.turnCompleted(.toolUse))
            } else {
                continuation.yield(.textDelta("Done."))
                continuation.yield(.turnCompleted(.endTurn))
            }
            continuation.finish()
        }
    }
}

private struct OtherLabFallback: ModelFallbackResolver {
    func resolveFallback(for currentModelID: String) async -> String? { "openai:gpt-6" }
}

/// A sub-agent falls back to another lab's model only when the reader opted
/// into fallback, exactly as the session it was delegated from.
@MainActor
final class SubagentFallbackOptInTests: XCTestCase {
    func testASubagentDoesNotFallBackUnlessTheReaderOptedIn() async throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-subagent-fallback-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        let workspaceURL = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        let workspaceID = WorkspaceID()
        let access = try WorkspaceAccess(workspaceID: workspaceID, grantedURL: workspaceURL)
        let context = WorkspaceContext(
            record: WorkspaceRecord(
                descriptor: WorkspaceDescriptor(
                    id: workspaceID,
                    displayName: "Fallback fixture",
                    localPathHint: workspaceURL.path,
                    isGitRepository: false,
                    lastOpenedAt: Date()
                ),
                bookmarkData: Data()
            ),
            access: access,
            storageRoot: base.appendingPathComponent("storage")
        )
        let store = CodeSessionStore(directoryURL: base.appendingPathComponent("sessions"))
        let session = try await store.createSession(
            workspaceID: workspaceID,
            workspaceName: "Fallback fixture",
            title: "Fallback",
            configuration: AgentConfiguration(
                modelID: "anthropic:claude-opus-5-5",
                reasoningEffort: nil,
                permissionMode: .fullAccess
            ),
            gitBranch: nil
        )
        let model = DelegatingModel()
        let controller = SessionController(
            session: session,
            context: context,
            store: store,
            modelClient: model,
            fallbackResolver: OtherLabFallback()
        )
        await controller.attach()

        controller.composerText = "Find the callers"
        await controller.send()
        await controller.awaitCurrentRun()
        for _ in 0..<400 where controller.isRunning {
            try await Task.sleep(for: .milliseconds(5))
        }

        // Read from this Mac's settings files once the run began.
        try XCTSkipIf(controller.settings.modelFallback, "this Mac's settings opt into fallback")
        XCTAssertFalse(model.childRequests.isEmpty, "the sub-agent ran")
        XCTAssertTrue(
            model.childRequests.allSatisfy { $0 == "anthropic:claude-opus-5-5" },
            "no request went to another lab: \(model.childRequests)"
        )
    }
}
