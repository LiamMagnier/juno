import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoCodeKit

final class CodeStartBudgetRefusalTests: XCTestCase {
    func testBudgetRefusalsKeepTheServersExplanationForBothNativeApps() async throws {
        let accountID = try AccountID("budget-test")
        let repository = NativeCodeRepository(
            owner: "test", name: "repo", fullName: "test/repo", isPrivate: true,
            defaultBranch: "main", updatedAt: nil
        )
        for code in ["USAGE_WINDOW_EXCEEDED", "MEMBER_BUDGET_EXHAUSTED"] {
            let message = "The budget is spent. It resets on Friday at 10:00 UTC."
            let body = try JSONSerialization.data(withJSONObject: [
                "error": message, "code": code, "resetsAt": "2026-10-16T10:00:00Z",
            ])
            let client = NativeCodeTaskClient(sender: BudgetRefusalSender(body: body), streamer: BudgetRefusalStreamer())
            do {
                _ = try await client.createCloudTask(prompt: "Test", repository: repository, baseRef: nil, for: accountID)
                XCTFail("An exhausted budget must refuse task creation")
            } catch let error as NativeCodeError {
                XCTAssertEqual(error, .server(statusCode: 429, message: message))
                XCTAssertEqual(error.localizedDescription, message)
            }
        }
    }
}

private struct BudgetRefusalSender: NativeAuthenticatedRequestSending {
    let body: Data
    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        XCTAssertEqual(request.path, "/api/code/tasks")
        return HTTPResponse(statusCode: 429, headers: try HTTPHeaders(["content-type": "application/json"]), body: body)
    }
}

private struct BudgetRefusalStreamer: NativeAuthenticatedByteStreaming {
    func stream(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPByteStreamResponse {
        fatalError("A refused task never opens a stream")
    }
}
