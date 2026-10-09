import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeUI

/// The glue between the v2 composer and the rest of Studio: engine routing,
/// the Alevr-engine mapping, thread → env-session bindings, the dock, agent
/// nodes and the composer model.
@MainActor
final class CodeV2StudioBridgeTests: XCTestCase {
    func testEngineRoutesSubscriptionsToTheEnvServer() {
        XCTAssertEqual(CodeV2Engine.route(CodeV2Fixtures.claudeSelection), .envServer)
        XCTAssertEqual(CodeV2Engine.route(CodeV2Fixtures.codexSelection), .envServer)
        XCTAssertEqual(CodeV2Engine.route(CodeV2Fixtures.alevrSelection), .alevr)
        XCTAssertEqual(CodeV2Engine.route(CodeV2.ModelSelection(instanceId: "byok:anthropic", model: "x")), .alevr)
    }

    func testEngineMappingRoundTrips() {
        for mode in [CodeV2.RuntimeMode.readOnly, .ask, .autoEdit, .full] {
            XCTAssertEqual(CodeV2EngineMapping.runtimeMode(for: CodeV2EngineMapping.permission(for: mode)), mode)
        }
        XCTAssertEqual(CodeV2EngineMapping.permission(for: .auto), .workspaceWrite)
        XCTAssertEqual(CodeV2EngineMapping.effort(.xhigh), .xhigh)
        XCTAssertNil(CodeV2EngineMapping.effort(CodeV2.EffortLevel.none))
        XCTAssertEqual(CodeV2EngineMapping.level(.max), .max)
        let selection = CodeV2EngineMapping.selection(modelID: "openai:gpt-6.1", effort: .high, contextTokens: 272_000)
        XCTAssertEqual(selection.instanceId, "alevr")
        XCTAssertEqual(selection.effort, .high)
    }

    func testBindingsPersist() {
        let suite = "code-v2-bindings-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = CodeV2SessionBindings(defaults: defaults)
        let binding = CodeV2SessionBindings.Binding(envSessionId: "env-1", cwd: "/tmp/repo", selection: CodeV2Fixtures.claudeSelection)
        store.bind("thread-1", to: binding)
        XCTAssertEqual(CodeV2SessionBindings(defaults: defaults).binding(for: "thread-1"), binding)
        store.unbind("thread-1")
        XCTAssertNil(CodeV2SessionBindings(defaults: defaults).binding(for: "thread-1"))
    }

    func testDockTogglesLikeTheToolbar() {
        let dock = CodeV2DockController()
        dock.toggle(.changes)
        XCTAssertTrue(dock.isOpen)
        dock.toggle(.agents)
        XCTAssertEqual(dock.tab, .agents)
        XCTAssertTrue(dock.isOpen)
        dock.toggle(.agents)
        XCTAssertFalse(dock.isOpen)
        dock.selectAgent("w2")
        XCTAssertEqual(dock.selectedAgent, "w2")
        XCTAssertEqual(dock.tab, .agents)
        dock.show(.changes, path: "src/a.ts")
        XCTAssertEqual(dock.focusedPath, "src/a.ts")
    }

    func testAgentNodesSayWhatEachChildIsDoing() throws {
        let snapshot = CodeV2Fixtures.multiAgentSnapshot
        let nodes: [CodeV2AgentNode] = snapshot.items.compactMap { item in
            guard case let .subagent(child) = item else { return nil }
            return CodeV2AgentNode(subagent: child, items: snapshot.items, now: CodeV2Fixtures.now)
        }
        XCTAssertEqual(nodes.map(\.roleLabel), ["Worker 1", "Worker 2", "Worker 3", "Explorer"])
        XCTAssertEqual(nodes[0].elapsedSeconds, 112)
        XCTAssertEqual(nodes[1].liveLine, "Editing src/cart/useCartTotal.ts")
        XCTAssertEqual(nodes[1].elapsedSeconds, 161)
        XCTAssertEqual(nodes[2].liveLine, "Waiting for you: wants to run a command")
        XCTAssertEqual(nodes[3].liveLine, "Found 3 call sites and 2 tests. Closed.")
        // The children's own narration is not in the lead's work log.
        let turn = try XCTUnwrap(CodeV2TurnFolding.turns(from: snapshot.items, activeTurnId: "t1").first)
        XCTAssertFalse(turn.steps.contains { $0.id == "w2-live" })
    }

    func testComposerModelChoosesAndCycles() {
        let model = CodeV2ComposerModel(selection: CodeV2Fixtures.alevrSelection)
        model.choose(instanceId: "claude-agent:default", model: CodeV2Fixtures.claude.models![2])
        XCTAssertEqual(model.engine, .envServer)
        XCTAssertEqual(model.selection.effort, .high)
        XCTAssertEqual(model.selection.contextTokens, 200_000)
        model.cycleEffort(levels: [.low, .high])
        XCTAssertEqual(model.selection.effort, .low)
        model.cycleMode(allowed: [.ask, .autoEdit])
        XCTAssertEqual(model.runtimeMode, .ask)
        XCTAssertNil(model.routing, "a plain solo run sends no routing")
        model.roles.preset = .leadWorkers
        XCTAssertEqual(model.routing?.preset, .leadWorkers)
    }

    func testAlevrCatalogKeepsCodingModelsBestFirst() {
        let instance = CodeV2AlevrCatalog.instance(from: [
            ModelOption(modelID: "openai:gpt-6.1", displayName: "GPT-6.1"),
            ModelOption(modelID: "anthropic:claude-opus-5-5", displayName: "Claude Opus 5.5"),
        ], plan: "Plus")
        XCTAssertEqual(instance.kind, .alevr)
        XCTAssertEqual(instance.models?.count, 2)
        XCTAssertEqual(instance.account?.plan, "Plus")
    }
}
