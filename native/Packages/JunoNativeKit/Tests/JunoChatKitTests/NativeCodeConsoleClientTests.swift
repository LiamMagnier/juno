import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoSync
import XCTest
@testable import JunoChatKit

/// Run's one request: the web's console document for a code block, by POST.
final class NativeCodeConsoleClientTests: XCTestCase {
    func testItPostsTheBlockAndReturnsTheDocument() async throws {
        let sender = ConsoleSender(status: 200, body: #"{"html":"<!doctype html><p>run</p>","language":"sql","label":"SQL"}"#)
        let client = NativeCodeConsoleClient(sender: sender)
        let runner = client.runner(for: try! AccountID("acct"))
        let html = try await runner.consoleDocument(try XCTUnwrap(JunoCodeRunTarget.target(for: "plsql")), "SELECT 1 FROM dual;", true)
        XCTAssertEqual(html, "<!doctype html><p>run</p>")
        let captured = await sender.captured
        let request = try XCTUnwrap(captured)
        XCTAssertEqual(request.path, "/api/code/console")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.body)) as? [String: String])
        XCTAssertEqual(body, ["language": "sql", "code": "SELECT 1 FROM dual;", "theme": "dark"])
    }

    func testFailuresAreSaidInWords() async {
        for (status, failure) in [(401, NativeCodeConsoleClient.Failure.signedOut), (429, .rateLimited), (400, .unavailable)] {
            let client = NativeCodeConsoleClient(sender: ConsoleSender(status: status, body: "{}"))
            do {
                _ = try await client.consoleDocument(language: "python", code: "print(1)", dark: false, for: try! AccountID("acct"))
                XCTFail("\(status) returned a document")
            } catch {
                XCTAssertEqual(error as? NativeCodeConsoleClient.Failure, failure)
            }
        }
    }

    func testTheAppsDeclareExercisesAndRun() {
        XCTAssertTrue(NativeChatClientFeatures.declared.contains("live_ui_exercise"))
        XCTAssertTrue(NativeChatClientFeatures.declared.contains("code_run"))
    }
}

private actor ConsoleSender: NativeAuthenticatedRequestSending {
    let status: Int
    let body: String
    private(set) var captured: NativeBearerRequest?

    init(status: Int, body: String) {
        self.status = status
        self.body = body
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        captured = request
        return HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}
