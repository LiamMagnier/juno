import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

private actor SearchServiceStub: CodeWebSearching {
    private(set) var requests: [(query: String, maxResults: Int)] = []
    let results: [CodeWebSearchResult]

    init(results: [CodeWebSearchResult]) {
        self.results = results
    }

    func search(query: String, maxResults: Int) async throws -> [CodeWebSearchResult] {
        requests.append((query: query, maxResults: maxResults))
        return results
    }
}

final class WebSearchToolTests: XCTestCase {
    func testSearchIsReadOnlyAndBoundsTheRequestedResults() async throws {
        let service = SearchServiceStub(results: [
            CodeWebSearchResult(
                title: "Swift documentation",
                url: "https://developer.apple.com/swift",
                snippet: "Official language documentation."
            ),
        ])
        let tool = WebSearchTool(service: service)
        let context = ToolContext(
            sessionID: CodeSessionID(),
            toolCallID: "search-1",
            emitOutput: { _, _ in }
        )

        XCTAssertEqual(tool.assessRisk(input: ["query": "swift"]), .read)
        XCTAssertNil(tool.precheck(input: ["query": "swift"]))

        let result = try await tool.execute(
            input: ["query": " swift ", "max_results": 99],
            context: context
        )

        XCTAssertFalse(result.isError)
        XCTAssertTrue(result.content.contains("untrusted"))
        XCTAssertTrue(result.content.contains("https://developer.apple.com/swift"))
        let requests = await service.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].query, "swift")
        XCTAssertEqual(requests[0].maxResults, 8)
    }

    func testEmptyQueryIsRejectedBeforeTheProviderRuns() async {
        let service = SearchServiceStub(results: [])
        let tool = WebSearchTool(service: service)

        guard case let .invalidInput(message)? = tool.precheck(input: ["query": "   "]) else {
            return XCTFail("expected an empty query to be rejected")
        }
        XCTAssertTrue(message.contains("must not be empty"))
        let requests = await service.requests
        XCTAssertTrue(requests.isEmpty)
    }
}
