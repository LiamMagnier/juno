import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// A session's spend: cache reads and writes counted apart from fresh input
/// and priced at their own rates, kept per model, persisted with the session.
final class UsageLedgerTests: XCTestCase {
    private var baseURL: URL!

    override func setUp() {
        baseURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-usage-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: baseURL)
    }

    func testCachedPromptTokensAreNotCountedAsFreshInput() {
        var totals = ModelUsageTotals()
        totals.record(ModelCallUsage(
            purpose: .turn,
            inputTokens: 100_000,
            outputTokens: 800,
            cacheReadTokens: 90_000,
            cacheWriteTokens: 6_000
        ))
        XCTAssertEqual(totals.freshInputTokens, 4_000)
        XCTAssertEqual(totals.cacheReadTokens, 90_000)
        XCTAssertEqual(totals.cacheWriteTokens, 6_000)
    }

    func testCacheReadsAndWritesArePricedAtTheirOwnRates() {
        var ledger = SessionUsageLedger()
        ledger.record(ModelCallUsage(
            purpose: .turn,
            inputTokens: 1_000_000,
            outputTokens: 10_000,
            cacheReadTokens: 900_000,
            cacheWriteTokens: 50_000,
            modelID: "anthropic:claude-opus-5-5"
        ))
        let rates = CodeUsagePricing.forModel(
            "anthropic:claude-opus-5-5",
            providerID: "anthropic",
            inputPerMillion: 3,
            outputPerMillion: 15
        )
        let cost = try? XCTUnwrap(ledger.estimatedCost { $0 == "anthropic:claude-opus-5-5" ? rates : nil })
        // 50K fresh at $3, 900K read at a tenth, 50K written at 1.25x, 10K out at $15.
        XCTAssertEqual(cost ?? 0, 0.15 + 0.27 + 0.1875 + 0.15, accuracy: 0.000_001)
        // Counted as full input, the same session would have cost about three times as much.
        let naive = 1.0 * 3 + 0.01 * 15
        XCTAssertGreaterThan(naive, 3 * (cost ?? 0))
        XCTAssertNil(ledger.estimatedCost { _ in nil }, "no published price, no estimate")
    }

    func testTheLedgerKeepsModelsApartAndSumsWhatIsAdded() throws {
        var parent = SessionUsageLedger()
        parent.record(ModelCallUsage(purpose: .turn, inputTokens: 10, outputTokens: 1, modelID: "a"))
        var child = SessionUsageLedger()
        child.record(ModelCallUsage(purpose: .turn, inputTokens: 20, outputTokens: 2, modelID: "a"))
        child.record(ModelCallUsage(purpose: .turn, inputTokens: 40, outputTokens: 4, modelID: "b"))
        parent.add(child)
        XCTAssertEqual(parent.byModel["a"]?.inputTokens, 30)
        XCTAssertEqual(parent.byModel["b"]?.outputTokens, 4)
        XCTAssertEqual(parent.total.requests, 3)

        let decoded = try JSONDecoder().decode(SessionUsageLedger.self, from: JSONEncoder().encode(parent))
        XCTAssertEqual(decoded, parent)
        // A totals record written before the cache split existed still reads.
        let older = try JSONDecoder().decode(
            ModelUsageTotals.self,
            from: Data(#"{"inputTokens":5,"outputTokens":1,"requests":1}"#.utf8)
        )
        XCTAssertEqual(older.inputTokens, 5)
        XCTAssertEqual(older.cacheReadTokens, 0)
    }

    /// A run's calls, cache split and all, are in the session's ledger when
    /// the run ends, and a fresh store reads the same ledger back.
    func testARunsSpendIsPersistedWithTheSession() async throws {
        let store = CodeSessionStore(directoryURL: baseURL)
        let session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Usage",
            configuration: AgentConfiguration(modelID: "anthropic:claude-opus-5-5"),
            gitBranch: nil
        )
        let observed = UpdateRecorder()
        _ = await store.addObserver { update in
            if case let .usageChanged(id, ledger) = update, id == session.id { observed.record(ledger) }
        }
        let model = ScriptedModelClient(steps: [
            .events([
                .usage(inputTokens: 50_000, outputTokens: nil),
                .cacheUsage(readTokens: 45_000, writeTokens: 4_000),
                .textDelta("Done."),
                .usage(inputTokens: nil, outputTokens: 300),
                .turnCompleted(.endTurn),
            ]),
        ])
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: []),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "sys"),
            modelID: "anthropic:claude-opus-5-5",
            reasoningEffort: nil
        )
        try await orchestrator.submit(prompt: "Hello")
        await orchestrator.awaitCompletion()

        let ledger = await store.usageLedger(for: session.id)
        let totals = try XCTUnwrap(ledger.byModel["anthropic:claude-opus-5-5"])
        XCTAssertEqual(totals.inputTokens, 50_000)
        XCTAssertEqual(totals.cacheReadTokens, 45_000)
        XCTAssertEqual(totals.cacheWriteTokens, 4_000)
        XCTAssertEqual(totals.freshInputTokens, 1_000)
        XCTAssertEqual(totals.outputTokens, 300)
        XCTAssertEqual(observed.last, ledger, "the window is told")

        let reopened = CodeSessionStore(directoryURL: baseURL)
        let persisted = await reopened.usageLedger(for: session.id)
        XCTAssertEqual(persisted, ledger)
    }
}

private final class UpdateRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var ledgers: [SessionUsageLedger] = []

    func record(_ ledger: SessionUsageLedger) {
        lock.lock(); ledgers.append(ledger); lock.unlock()
    }

    var last: SessionUsageLedger? {
        lock.lock(); defer { lock.unlock() }
        return ledgers.last
    }
}
