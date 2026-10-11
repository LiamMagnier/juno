import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeUI

/// Alevr's API models for a paired phone: the Mac hands the env server's
/// Alevr engine its session and the models its own Code picker lists.
@MainActor
final class EnvServerBackendTests: XCTestCase {
    private final class Credential {
        var token = "Bearer one"
    }

    private let options = [
        ModelOption(modelID: "anthropic:claude-opus-5-5", displayName: "Claude Opus 5.5", supportedReasoningEfforts: [.low, .medium, .high]),
        ModelOption(modelID: "openai:gpt-6.1-codex", displayName: "GPT-6.1 Codex", supportedReasoningEfforts: [.low, .high]),
        ModelOption(modelID: "zhipu:glm-5", displayName: "GLM-5", supportedReasoningEfforts: []),
        // Auto routes whole chat turns; the agent proxy has no path for it.
        ModelOption(modelID: "juno:auto", displayName: "Auto"),
    ]

    func testTheBackendModelsAreTheMacPickersWithTheirWireAndLevels() {
        let models = CodeV2AlevrCatalog.backendModels(from: options)
        XCTAssertEqual(models.map(\.provider), ["anthropic", "openai", "zhipu"])
        XCTAssertEqual(models.map(\.model), ["claude-opus-5-5", "gpt-6.1-codex", "glm-5"])
        XCTAssertEqual(models.map(\.kind), ["anthropic", "openai", "openai"])
        XCTAssertEqual(models.map(\.api), [nil, "responses", nil])
        XCTAssertEqual(models[0].effortLevels, [.low, .medium, .high])
        XCTAssertEqual(models[1].effortLevels, [.low, .high])
        XCTAssertNil(models[2].effortLevels, "no levels invented for a model without them")
        XCTAssertEqual(models.map { $0.isDefault == true }, [true, false, false], "the best for coding, as the Mac marks it")
        XCTAssertEqual(EnvBackendConfig.agentBaseURL(origin: URL(string: "https://alevr.com/")!), "https://alevr.com/api/agent")
    }

    func testTheSessionIsHandedOverOnceAndAgainWhenItChanges() async throws {
        let transport = FakeEnvServer()
        transport.handle = { command in
            command.kind == .providerList ? .init(result: .object(["instances": .array([])])) : .init()
        }
        let hub = EnvServerHub(connection: EnvServerConnection(transport: transport))
        defer { hub.stop() }
        for _ in 0..<200 where !hub.isReady { try await Task.sleep(for: .milliseconds(5)) }
        let credential = Credential()
        let models = CodeV2AlevrCatalog.backendModels(from: options)
        hub.backendInterval = .seconds(3_600)
        hub.setBackend { EnvBackendConfig(baseUrl: "https://alevr.com/api/agent", authorization: credential.token, models: models, deviceId: "mac1") }
        let configures = { transport.commands.filter { $0.kind == .envConfigure } }
        for _ in 0..<200 where configures().isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        let sent = try XCTUnwrap(configures().first?.params["backend"])
        XCTAssertEqual(sent["authorization"]?.stringValue, "Bearer one")
        XCTAssertEqual(sent["baseUrl"]?.stringValue, "https://alevr.com/api/agent")
        XCTAssertEqual(sent["deviceId"]?.stringValue, "mac1")
        XCTAssertEqual(sent["models"]?.arrayValue?.count, 3)
        XCTAssertNil(transport.commands.first { $0.kind == .envConfigure }?.params["byok"], "keys never go from here")

        await hub.pushBackend()
        XCTAssertEqual(configures().count, 1, "unchanged: not re-sent")
        credential.token = "Bearer two"
        await hub.pushBackend()
        XCTAssertEqual(configures().count, 2)
        XCTAssertEqual(configures().last?.params["backend"]?["authorization"]?.stringValue, "Bearer two")
        XCTAssertFalse(String(describing: EnvBackendConfig(baseUrl: "b", authorization: "Bearer two")).contains("two"))

        hub.setBackend(nil)
        XCTAssertFalse(hub.hasBackend)
    }
}
