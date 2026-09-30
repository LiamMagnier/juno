import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoCodeKit

final class NativeCodeAgentClientTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    /// What the queue hands a Mac is the server's own serialization, decoded
    /// with the model the submitter picked (see `code-task-wire.json`).
    func testQueuedTaskDecodesTheServersTaskWithItsModel() async throws {
        let sender = CodeQueueSender(responses: [response(try taskEnvelope)])
        let client = NativeCodeAgentClient(sender: sender)

        let task = try await client.queuedTask(deviceID: "device-1", for: accountID)

        XCTAssertEqual(task?.id, "task-device")
        XCTAssertEqual(task?.modelId, "claude-sonnet-5")
        XCTAssertEqual(task?.reasoningEffort, "high")
        XCTAssertEqual(task?.acceptsAgentProtocol, true)
        let requests = await sender.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/code/queue")
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

    /// The server's own serialization of a device task, wrapped as the create
    /// route returns it — see `NativeCodeAgentTaskDecodingTests`.
    private var taskEnvelope: String {
        get throws {
            let url = try XCTUnwrap(
                Bundle.module.url(forResource: "code-task-wire", withExtension: "json", subdirectory: "Fixtures")
            )
            let all = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
            )
            let task = try XCTUnwrap(all["deviceTaskWithModel"])
            let data = try JSONSerialization.data(withJSONObject: ["task": task])
            return String(decoding: data, as: UTF8.self)
        }
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
