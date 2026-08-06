import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoCodeKit

final class NativeCodeAgentClientTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    func testDeviceTaskUsesSharedRuntimeProfileAndExistingBearerRoute() async throws {
        let sender = CodeQueueSender(responses: [
            response(taskEnvelope),
        ])
        let client = NativeCodeAgentClient(sender: sender)

        let task = try await client.createDeviceTask(
            deviceID: "device-1",
            workspace: .init(
                name: "Juno",
                path: "/workspace/juno",
                key: "workspace-key"
            ),
            prompt: "Review the sync layer",
            conversationID: "conversation-1",
            profile: CodeAgentProfile(
                runtime: .claude,
                permissionMode: .autoEdit,
                modelID: "claude-sonnet-5",
                reasoningEffort: "high",
                computerUse: false,
                subagentsEnabled: true
            ),
            for: accountID
        )

        XCTAssertEqual(task.agentRuntime, .claude)
        XCTAssertEqual(task.permissionMode, .autoEdit)
        let requests = await sender.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/code/tasks")
        XCTAssertEqual(request.method, .post)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(request.body))
                as? [String: Any]
        )
        XCTAssertEqual(object["agentRuntime"] as? String, "claude")
        XCTAssertEqual(object["permissionMode"] as? String, "auto-edit")
        XCTAssertEqual(object["modelId"] as? String, "claude-sonnet-5")
        XCTAssertEqual(object["reasoningEffort"] as? String, "high")
        XCTAssertEqual(object["computerUse"] as? Bool, false)
        XCTAssertEqual(object["subagentsEnabled"] as? Bool, true)
        XCTAssertEqual(object["target"] as? String, "device")
    }

    func testAppendPreservesControlEventsAndTypedServerFailure() async throws {
        let sender = CodeQueueSender(responses: [
            response(
                #"{"lastSeq":8,"control":[{"seq":3,"kind":"cancel_requested","payload":{"reason":"Stopped elsewhere"}}]}"#
            ),
            response(#"{"error":"Task ownership changed."}"#, statusCode: 409),
        ])
        let client = NativeCodeAgentClient(sender: sender)

        let ack = try await client.append(
            taskID: "task-1",
            events: [
                .init(kind: "status", payload: ["phase": .string("running")]),
            ],
            afterControlSequence: 2,
            for: accountID
        )
        XCTAssertEqual(ack.lastSequence, 8)
        XCTAssertEqual(ack.control.first?.kind, "cancel_requested")
        XCTAssertEqual(ack.control.first?.payload["reason"], .string("Stopped elsewhere"))

        do {
            _ = try await client.claim(
                taskID: "task-1",
                deviceID: "device-1",
                for: accountID
            )
            XCTFail("Expected the authoritative conflict")
        } catch {
            XCTAssertEqual(
                error as? NativeCodeAgentAPIError,
                .server(statusCode: 409, message: "Task ownership changed.")
            )
        }
    }

    private var taskEnvelope: String {
        """
        {"task":{"id":"task-1","deviceId":"device-1","workspacePath":"/workspace/juno","workspaceName":"Juno","workspaceKey":"workspace-key","title":"Review sync","prompt":"Review the sync layer","status":"queued","lastSeq":0,"conversationId":"conversation-1","target":"device","repoOwner":null,"repoName":null,"baseRef":null,"prUrl":null,"agentRuntime":"claude","permissionMode":"auto-edit","modelId":"claude-sonnet-5","reasoningEffort":"high","computerUse":false,"subagentsEnabled":true,"createdAt":"2026-07-26T00:00:00.000Z","updatedAt":"2026-07-26T00:00:00.000Z"}}
        """
    }

    private func response(_ body: String, statusCode: Int = 200) -> HTTPResponse {
        HTTPResponse(
            statusCode: statusCode,
            headers: try! HTTPHeaders(["content-type": "application/json"]),
            body: Data(body.utf8)
        )
    }
}

private actor CodeQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws
        -> HTTPResponse
    {
        requests.append(request)
        return responses.removeFirst()
    }
}
