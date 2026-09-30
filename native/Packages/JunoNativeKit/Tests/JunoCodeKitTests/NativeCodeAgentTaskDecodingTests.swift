import Foundation
import XCTest
@testable import JunoCodeKit

/// The device-task decoder, against what the server really sends.
///
/// Every fixture here is written by `serializeTask` itself
/// (`scripts/generate-code-task-wire-fixtures.ts`; `npm test` fails when the
/// file drifts from the function). The previous fixtures were typed by hand and
/// carried `modelId`, `agentRuntime`, `computerUse` and `subagentsEnabled` —
/// none of which any server sends — so the decoder passed while a model picked
/// on the web never reached the Mac.
final class NativeCodeAgentTaskDecodingTests: XCTestCase {
    private func fixture(_ name: String) throws -> NativeCodeAgentTask {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "code-task-wire", withExtension: "json", subdirectory: "Fixtures")
        )
        let all = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        )
        let entry = try XCTUnwrap(all[name], "No \(name) fixture; regenerate code-task-wire.json")
        let data = try JSONSerialization.data(withJSONObject: entry)
        return try JSONDecoder().decode(NativeCodeAgentTask.self, from: data)
    }

    func testTheModelAndEffortPickedOnTheWebReachTheMac() throws {
        let task = try fixture("deviceTaskWithModel")
        XCTAssertEqual(task.id, "task-device")
        XCTAssertEqual(task.modelId, "claude-sonnet-5")
        XCTAssertEqual(task.reasoningEffort, "high")
        XCTAssertEqual(task.prompt, "Fix the login bug in the sign-in form.")
        XCTAssertEqual(task.workspaceKey, "workspace-key")
        // A device task carries no mode: the Mac's own gating, which asks.
        XCTAssertEqual(task.permissionMode, .ask)
    }

    func testNoPreferenceDecodesAsNil() throws {
        let task = try fixture("deviceTaskWithoutPreferences")
        XCTAssertNil(task.modelId)
        XCTAssertNil(task.reasoningEffort)
        XCTAssertEqual(task.target, "device")
    }

    func testCloudTaskCarriesItsModeAndModel() throws {
        let task = try fixture("cloudTask")
        XCTAssertEqual(task.target, "cloud")
        XCTAssertEqual(task.permissionMode, .autoEdit)
        XCTAssertEqual(task.modelId, "gpt-5.2")
        XCTAssertEqual(task.prUrl, "https://github.com/liam/juno/pull/7")
    }

    func testListShapeWithoutPromptStillDecodes() throws {
        let task = try fixture("listRow")
        XCTAssertEqual(task.prompt, "")
        XCTAssertEqual(task.status, "running")
    }

    /// An older server's shape is still read: `modelId` was never sent, but a
    /// task relayed through anything that did send it keeps working.
    func testLegacyModelIdIsAFallbackNotTheKey() throws {
        let legacy = #"{"id":"t1","status":"queued","modelId":"old-model"}"#
        let task = try JSONDecoder().decode(NativeCodeAgentTask.self, from: Data(legacy.utf8))
        XCTAssertEqual(task.modelId, "old-model")

        let both = #"{"id":"t1","status":"queued","model":"new-model","modelId":"old-model"}"#
        let preferred = try JSONDecoder().decode(NativeCodeAgentTask.self, from: Data(both.utf8))
        XCTAssertEqual(preferred.modelId, "new-model")
    }
}
