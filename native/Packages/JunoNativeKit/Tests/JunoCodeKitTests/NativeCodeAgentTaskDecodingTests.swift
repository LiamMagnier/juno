import XCTest
@testable import JunoCodeKit

final class NativeCodeAgentTaskDecodingTests: XCTestCase {
    /// Exactly what `serializeTask` in src/lib/code-remote.ts sends for a
    /// device task: no runtime, model, effort or capability fields, and a
    /// null permission mode.
    func testDecodesTheServersDeviceTaskShape() throws {
        let json = """
        {"id":"t1","deviceId":"d1","workspacePath":"/Users/me/app","workspaceName":"app",
         "workspaceKey":null,"title":"Fix login","prompt":"Fix the login bug","status":"queued",
         "lastSeq":0,"conversationId":null,"parentSessionId":null,"createsNewSession":true,
         "origin":"phone","target":"device","repoOwner":null,"repoName":null,"baseRef":null,
         "branch":null,"prUrl":null,"prNumber":null,"environmentId":null,"permissionMode":null,
         "createdAt":"2026-09-22T10:00:00.000Z","updatedAt":"2026-09-22T10:00:00.000Z"}
        """
        let task = try JSONDecoder().decode(NativeCodeAgentTask.self, from: Data(json.utf8))
        XCTAssertEqual(task.id, "t1")
        XCTAssertEqual(task.prompt, "Fix the login bug")
        XCTAssertEqual(task.permissionMode, .ask)
        XCTAssertEqual(task.agentRuntime, .claude)
        XCTAssertFalse(task.computerUse)
        XCTAssertNil(task.modelId)
    }

    func testListShapeWithoutPromptStillDecodes() throws {
        let json = #"{"id":"t2","status":"running","permissionMode":"auto-edit","target":"cloud"}"#
        let task = try JSONDecoder().decode(NativeCodeAgentTask.self, from: Data(json.utf8))
        XCTAssertEqual(task.prompt, "")
        XCTAssertEqual(task.permissionMode, .autoEdit)
        XCTAssertEqual(task.target, "cloud")
    }
}
