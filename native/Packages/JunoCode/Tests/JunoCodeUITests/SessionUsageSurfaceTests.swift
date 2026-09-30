import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Reports a cached prompt on every turn, as Anthropic does.
private final class CachingUsageModel: AgentModelClient, @unchecked Sendable {
    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.usage(inputTokens: 20_000, outputTokens: nil))
            continuation.yield(.cacheUsage(readTokens: 18_000, writeTokens: 1_000))
            continuation.yield(.textDelta("Answered."))
            continuation.yield(.usage(inputTokens: nil, outputTokens: 400))
            continuation.yield(.turnCompleted(.endTurn))
            continuation.finish()
        }
    }
}

/// The session's spend as the window reads it: the store's persisted ledger,
/// with the cache split and a cost estimate from the manifest's rates.
@MainActor
final class SessionUsageSurfaceTests: XCTestCase {
    private var baseURL: URL!
    private var context: WorkspaceContext!
    private var store: CodeSessionStore!

    override func setUp() async throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-usage-surface-\(UUID().uuidString)")
        baseURL = base
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        let workspaceURL = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        let workspaceID = WorkspaceID()
        let access = try WorkspaceAccess(workspaceID: workspaceID, grantedURL: workspaceURL)
        context = WorkspaceContext(
            record: WorkspaceRecord(
                descriptor: WorkspaceDescriptor(
                    id: workspaceID,
                    displayName: "Usage fixture",
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

    private let pricing: (String) -> CodeUsagePricing? = { model in
        model == "anthropic:claude-opus-5-5"
            ? .forModel(model, providerID: "anthropic", inputPerMillion: 5, outputPerMillion: 25)
            : nil
    }

    func testTheWindowReadsThePersistedLedgerWithItsCacheSplitAndCost() async throws {
        let session = try await store.createSession(
            workspaceID: context.record.id,
            workspaceName: "Usage fixture",
            title: "Usage",
            configuration: AgentConfiguration(modelID: "anthropic:claude-opus-5-5", reasoningEffort: nil),
            gitBranch: nil
        )
        let controller = SessionController(
            session: session,
            context: context,
            store: store,
            modelClient: CachingUsageModel(),
            modelPricing: pricing
        )
        await controller.attach()
        for prompt in ["One", "Two"] {
            controller.composerText = prompt
            await controller.send()
            await controller.awaitCurrentRun()
            for _ in 0..<300 where controller.isRunning || controller.sessionUsage.requests == 0 {
                try await Task.sleep(for: .milliseconds(5))
            }
        }
        for _ in 0..<300 where controller.sessionUsage.requests < 2 {
            try await Task.sleep(for: .milliseconds(5))
        }

        let spent = controller.sessionUsage
        XCTAssertEqual(spent.requests, 2)
        XCTAssertEqual(spent.freshInputTokens, 2 * 1_000)
        XCTAssertEqual(spent.cacheReadTokens, 2 * 18_000)
        XCTAssertEqual(spent.cacheWriteTokens, 2 * 1_000)
        XCTAssertEqual(spent.outputTokens, 2 * 400)
        // 2K fresh at $5, 36K read at $0.50, 2K written at $6.25, 800 out at $25 — per million.
        let expected: Double = (10_000 + 18_000 + 12_500 + 20_000) / 1_000_000
        XCTAssertEqual(try XCTUnwrap(controller.sessionCostEstimate), expected, accuracy: 0.000_001)
        XCTAssertEqual(
            StudioContextMeter.spendLine(spent, cost: controller.sessionCostEstimate),
            "This session: 2.0K in, 36K from cache, 2.0K cached, 800 out over 2 requests, about $0.06"
        )

        // A controller opened later — the next launch — reads the same ledger.
        let reopened = SessionController(
            session: try await store.session(id: session.id),
            context: context,
            store: store,
            modelClient: CachingUsageModel(),
            modelPricing: pricing
        )
        await reopened.attach()
        XCTAssertEqual(reopened.usageLedger, controller.usageLedger)
    }
}
