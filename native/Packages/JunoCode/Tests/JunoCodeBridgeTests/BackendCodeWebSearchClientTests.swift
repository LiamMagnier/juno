import XCTest
import JunoAPI
import JunoAuth
import JunoCodeRuntime
import JunoCore
import JunoSync
@testable import JunoCodeBridge

private actor SearchRequestSender: NativeAuthenticatedRequestSending {
    let response: HTTPResponse
    private(set) var lastRequest: NativeBearerRequest?

    init(response: HTTPResponse) {
        self.response = response
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        lastRequest = request
        return response
    }
}

final class BackendCodeWebSearchClientTests: XCTestCase {
    private let accountID = try! AccountID("account-1")

    func testPostsTheBoundedSearchRequestAndFiltersUnsafeSources() async throws {
        let payload = #"{"sources":[{"title":"Swift","url":"https://swift.org","snippet":"Docs"},{"title":"Nope","url":"javascript:alert(1)","snippet":"Ignore"}]}"#
        let sender = SearchRequestSender(response: HTTPResponse(
            statusCode: 200,
            headers: HTTPHeaders(),
            body: Data(payload.utf8)
        ))
        let client = BackendCodeWebSearchClient(sender: sender, accountID: accountID)

        let sources = try await client.search(query: "swift", maxResults: 99)

        XCTAssertEqual(sources, [
            CodeWebSearchResult(title: "Swift", url: "https://swift.org", snippet: "Docs"),
        ])
        let lastRequest = await sender.lastRequest
        let request = try XCTUnwrap(lastRequest)
        XCTAssertEqual(request.path, "/api/code/search")
        XCTAssertEqual(request.method, .post)
        let body = try XCTUnwrap(request.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["query"] as? String, "swift")
        XCTAssertEqual(object["max_results"] as? Int, 8)
    }

    func testServerErrorsBecomeAUserVisibleBridgeError() async {
        let payload = #"{"message":"Web search is unavailable."}"#
        let sender = SearchRequestSender(response: HTTPResponse(
            statusCode: 503,
            headers: HTTPHeaders(),
            body: Data(payload.utf8)
        ))
        let client = BackendCodeWebSearchClient(sender: sender, accountID: accountID)

        do {
            _ = try await client.search(query: "swift", maxResults: 5)
            XCTFail("expected a server error")
        } catch let error as BackendCodeWebSearchError {
            XCTAssertEqual(error, .server(statusCode: 503, message: "Web search is unavailable."))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}
