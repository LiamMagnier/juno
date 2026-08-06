import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoCodeKit

final class NativeCodeTaskContinuationTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    func testCodeConversationAndFollowUpUseTheLinkedSessionWireShape() async throws {
        let sender = ContinuationSender(responses: [
            response(#"{"conversation":{"id":"conversation-1"}}"#, statusCode: 201),
            response(taskEnvelope(id: "task-1", prompt: "Review the sync layer")),
            response(taskEnvelope(id: "task-2", prompt: "Now add coverage")),
        ])
        let client = NativeCodeTaskClient(sender: sender, streamer: SilentTaskStreamer())
        let repository = NativeCodeRepository(
            owner: "liam", name: "juno", fullName: "liam/juno", isPrivate: true,
            defaultBranch: "main", updatedAt: nil
        )

        let conversationID = try await client.createCodeConversation(
            workspaceName: "juno",
            workspacePath: nil,
            workspaceKey: nil,
            for: accountID
        )
        let first = try await client.createCloudTask(
            prompt: "Review the sync layer",
            repository: repository,
            baseRef: nil,
            for: accountID,
            conversationID: conversationID
        )
        let second = try await client.followUp(
            prompt: "  Now add coverage  ", after: first, for: accountID
        )

        XCTAssertEqual(conversationID, "conversation-1")
        XCTAssertEqual(first.conversationID, conversationID)
        XCTAssertEqual(second.id, "task-2")
        let requests = await sender.requests
        XCTAssertEqual(requests.count, 3)

        let conversationBody = try object(requests[0])
        XCTAssertEqual(conversationBody["kind"] as? String, "code")
        XCTAssertEqual(conversationBody["codeWorkspaceName"] as? String, "juno")
        XCTAssertNil(conversationBody["codeWorkspacePath"])
        XCTAssertNil(conversationBody["codeWorkspaceKey"])

        let firstBody = try object(requests[1])
        XCTAssertEqual(firstBody["target"] as? String, "cloud")
        XCTAssertEqual(firstBody["conversationId"] as? String, conversationID)
        XCTAssertEqual(firstBody["createsNewSession"] as? Bool, false)
        XCTAssertEqual(firstBody["baseRef"] as? String, "main")
        XCTAssertNotNil(firstBody["repo"] as? [String: Any])
        XCTAssertNil(firstBody["deviceId"])
        XCTAssertNil(firstBody["workspacePath"])
        XCTAssertNil(firstBody["workspaceName"])

        let followUpBody = try object(requests[2])
        XCTAssertEqual(followUpBody["prompt"] as? String, "Now add coverage")
        XCTAssertEqual(followUpBody["conversationId"] as? String, conversationID)
        XCTAssertEqual(followUpBody["createsNewSession"] as? Bool, false)
        XCTAssertNil(followUpBody["workspaceKey"])
    }

    func testUnlinkedTaskRefusesFollowUpBeforeItTouchesTheNetwork() async throws {
        let sender = ContinuationSender(responses: [])
        let client = NativeCodeTaskClient(sender: sender, streamer: SilentTaskStreamer())
        let task = NativeCodeTask(
            id: "task-1", title: "Old run", prompt: "Review", status: .done,
            target: .device, deviceID: "device-1", workspaceName: "juno",
            workspacePath: "/workspace/juno", repoOwner: nil, repoName: nil,
            baseRef: nil, conversationID: nil, pullRequestURL: nil, lastSeq: 0,
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: Date(timeIntervalSince1970: 1)
        )

        do {
            _ = try await client.followUp(prompt: "Continue", after: task, for: accountID)
            XCTFail("an unlinked task must not be continued")
        } catch let error as NativeCodeError {
            XCTAssertEqual(error, .followUpUnavailable)
        }
        let requests = await sender.requests
        XCTAssertTrue(requests.isEmpty)
    }

    private func taskEnvelope(id: String, prompt: String) -> String {
        """
        {"task":{"id":"\(id)","deviceId":null,"workspacePath":"liam/juno","workspaceName":"juno","title":"\(prompt)","prompt":"\(prompt)","status":"queued","lastSeq":0,"conversationId":"conversation-1","target":"cloud","repoOwner":"liam","repoName":"juno","baseRef":"main","prUrl":null,"createdAt":"2026-07-26T00:00:00.000Z","updatedAt":"2026-07-26T00:00:00.000Z"}}
        """
    }

    private func object(_ request: NativeBearerRequest) throws -> [String: Any] {
        let body = try XCTUnwrap(request.body)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    private func response(_ body: String, statusCode: Int = 200) -> HTTPResponse {
        HTTPResponse(
            statusCode: statusCode,
            headers: try! HTTPHeaders(["content-type": "application/json"]),
            body: Data(body.utf8)
        )
    }
}

private actor ContinuationSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else {
            return HTTPResponse(
                statusCode: 500,
                headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
            )
        }
        return responses.removeFirst()
    }
}

private struct SilentTaskStreamer: NativeAuthenticatedByteStreaming {
    func stream(
        _: NativeBearerRequest, for _: AccountID
    ) async throws -> HTTPByteStreamResponse {
        HTTPByteStreamResponse(
            statusCode: 200,
            headers: HTTPHeaders(),
            bytes: AsyncThrowingStream { $0.finish() }
        )
    }
}
