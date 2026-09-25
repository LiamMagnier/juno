import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoChatKit

/// `GET /api/search` and `GET /api/recents`, decoded from recorded bodies, and
/// the share route's refusal (Phase 3 Stage B, B0).
final class NativeUnifiedSearchClientTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    /// A body recorded from `src/lib/search` on `origin/main`: two groups, a
    /// title mark, a snippet with marks, a partial source and an unknown type
    /// a newer server might send.
    private let recorded = Data(
        """
        {
          "query": "quarterly plan",
          "total": 3,
          "partial": true,
          "groups": [
            {"type": "memory", "label": "Memory", "hits": [
              {"id": "memory:m1", "type": "memory", "title": "Prefers quarterly plans in a table",
               "titleMarks": [{"start": 8, "end": 17}, {"start": 18, "end": 23}],
               "snippet": null, "href": "/memory?entry=m1", "locator": null, "projectId": null,
               "updatedAt": "2026-09-20T09:14:00.000Z", "score": 0.82}
            ]},
            {"type": "work", "label": "Tasks", "hits": [
              {"id": "work:s1", "type": "work", "title": "Draft the quarterly plan",
               "titleMarks": [{"start": 10, "end": 19}],
               "snippet": {"text": "…pull last quarter’s numbers into a plan…", "marks": [{"start": 37, "end": 41}]},
               "href": "/chat/c-42", "locator": "done", "projectId": "p-7",
               "updatedAt": "2026-09-19T16:02:11Z", "score": 0.61},
              {"id": "work:s2", "type": "work", "title": "Old task",
               "titleMarks": [], "snippet": null, "href": "/chat", "locator": "done",
               "projectId": null, "updatedAt": "2026-08-01T10:00:00Z", "score": 0.2}
            ]},
            {"type": "hologram", "label": "Holograms", "hits": []}
          ],
          "coverage": [
            {"type": "memory", "state": "complete", "detail": null},
            {"type": "knowledge", "state": "partial", "detail": "Two documents are still being indexed."},
            {"type": "hologram", "state": "partial", "detail": "New."}
          ]
        }
        """.utf8
    )

    func testDecodesGroupsHitsMarksAndCoverage() throws {
        let result = try NativeUnifiedSearchClient.decodeSearch(recorded)
        XCTAssertEqual(result.query, "quarterly plan")
        XCTAssertEqual(result.total, 3)
        XCTAssertTrue(result.partial)
        XCTAssertEqual(result.groups.map(\.type), [.memory, .work])
        let memory = try XCTUnwrap(result.groups.first?.hits.first)
        XCTAssertEqual(memory.titleMarks, [NativeSearchMark(start: 8, end: 17), NativeSearchMark(start: 18, end: 23)])
        XCTAssertNil(memory.snippet)
        XCTAssertEqual(memory.href, "/memory?entry=m1")
        XCTAssertNotNil(memory.updatedAt)
        let task = try XCTUnwrap(result.groups.last?.hits.first)
        XCTAssertEqual(task.snippet?.marks, [NativeSearchMark(start: 37, end: 41)])
        XCTAssertEqual(task.locator, "done")
        XCTAssertEqual(task.projectID, "p-7")
    }

    /// A type this build does not know is ignored, in the groups and the
    /// coverage, rather than failing the whole answer.
    func testAnUnknownTypeIsIgnored() throws {
        let result = try NativeUnifiedSearchClient.decodeSearch(recorded)
        XCTAssertFalse(result.groups.contains { $0.label == "Holograms" })
        XCTAssertEqual(result.coverage.map(\.type), [.memory, .knowledge])
    }

    /// Only a source that came back short and can say why is mentioned.
    func testShortfallsAreThePartialSourcesWithADetail() throws {
        let result = try NativeUnifiedSearchClient.decodeSearch(recorded)
        XCTAssertEqual(result.shortfalls.map(\.type), [.knowledge])
        XCTAssertEqual(result.shortfalls.first?.detail, "Two documents are still being indexed.")
    }

    /// The echo guard: an answer is for the query it echoes, compared trimmed.
    func testTheEchoedQueryGuardsAgainstALateAnswer() throws {
        let result = try NativeUnifiedSearchClient.decodeSearch(recorded)
        XCTAssertTrue(result.answers("  quarterly plan "))
        XCTAssertFalse(result.answers("quarterly"))
    }

    /// Marks are UTF-16 offsets: an emoji before the match must not shift it.
    func testMarksAreUTF16Offsets() {
        let text = "🗓️ Quarterly plan"
        // "Quarterly" starts after the emoji (3 UTF-16 units) and a space.
        let start = "🗓️ ".utf16.count
        let ranges = NativeSearchMark.ranges([NativeSearchMark(start: start, end: start + 9)], in: text)
        XCTAssertEqual(ranges.map { String(text[$0]) }, ["Quarterly"])
        // A mark past the end, or splitting a character, is dropped.
        XCTAssertTrue(NativeSearchMark.ranges([NativeSearchMark(start: 1, end: 2)], in: text).isEmpty)
        XCTAssertTrue(NativeSearchMark.ranges([NativeSearchMark(start: 0, end: 99)], in: text).isEmpty)
    }

    func testTheRequestCarriesOnlyWhatNarrowsIt() throws {
        let plain = try NativeUnifiedSearchClient.searchRequest(query: " plan ", types: [], projectID: nil, window: .any)
        XCTAssertEqual(plain.path, "/api/search")
        XCTAssertEqual(plain.queryItems, [URLQueryItem(name: "q", value: "plan")])
        let narrowed = try NativeUnifiedSearchClient.searchRequest(
            query: "plan",
            types: [.memory, .knowledge, .work],
            projectID: "p-7",
            window: .month
        )
        XCTAssertEqual(
            narrowed.queryItems,
            [
                URLQueryItem(name: "q", value: "plan"),
                URLQueryItem(name: "types", value: "memory,knowledge,work"),
                URLQueryItem(name: "projectId", value: "p-7"),
                URLQueryItem(name: "window", value: "month"),
            ]
        )
    }

    func testRecentsDecode() throws {
        let body = Data(
            """
            {"items": [
              {"id": "c-1", "kind": "chat", "title": "Trip to Lisbon", "updatedAt": "2026-09-24T18:00:00Z", "pinned": false, "href": "/chat/c-1"},
              {"id": "p-7", "kind": "project", "title": "Q4 planning", "updatedAt": "2026-09-23T08:00:00.000Z", "pinned": true, "href": "/projects/p-7"},
              {"kind": "chat", "title": "no id"}
            ], "counts": {"all": 2}, "filter": "all"}
            """.utf8
        )
        let items = try NativeUnifiedSearchClient.decodeRecents(body)
        XCTAssertEqual(items.map(\.id), ["c-1", "p-7"])
        XCTAssertEqual(items.last?.kind, "project")
        XCTAssertTrue(items.last?.pinned == true)
        XCTAssertNotNil(items.first?.updatedAt)
    }

    func testTheClientSendsAndDecodes() async throws {
        let sender = RecordingSender(status: 200, body: recorded)
        let client = NativeUnifiedSearchClient(sender: sender)
        let result = try await client.search(query: "quarterly plan", types: [.memory, .work], for: accountID)
        XCTAssertEqual(result.groups.count, 2)
        XCTAssertEqual(sender.requests.first?.path, "/api/search")
    }

    func testAFailingRouteThrows() async {
        let client = NativeUnifiedSearchClient(sender: RecordingSender(status: 503, body: Data("{}".utf8)))
        do {
            _ = try await client.search(query: "plan", for: accountID)
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? NativeUnifiedSearchError, .failed(status: 503))
        }
    }

    // MARK: Share

    /// `403 {code: "share_taken_down"}` is a refusal in the server's words,
    /// not a failure to retry.
    func testATakenDownShareIsBlockedWithTheServersSentence() {
        let body = Data(#"{"code":"share_taken_down","error":"This chat was reported and can’t be shared."}"#.utf8)
        XCTAssertThrowsError(try NativeShareClient.decodeCreate(status: 403, body: body)) { error in
            XCTAssertEqual(error as? NativeShareError, .blocked("This chat was reported and can’t be shared."))
        }
        XCTAssertThrowsError(try NativeShareClient.decodeCreate(status: 403, body: Data("{}".utf8))) { error in
            XCTAssertEqual(error as? NativeShareError, .failed)
        }
    }

    func testAnArtifactShareSendsItsKindAndID() async throws {
        let body = Data(
            #"{"share":{"id":"s-1","kind":"ARTIFACT","token":"t","url":"https://juno.example/s/t","snapshotAt":"2026-09-22T10:00:00.000Z","views":3}}"#.utf8
        )
        let sender = RecordingSender(status: 200, body: body)
        let share = try await NativeShareClient(sender: sender).share(artifactID: "a-9", for: accountID)
        XCTAssertEqual(share.kind, "ARTIFACT")
        XCTAssertEqual(share.views, 3)
        let sent = try XCTUnwrap(sender.requests.first?.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: sent) as? [String: String])
        XCTAssertEqual(object, ["kind": "ARTIFACT", "artifactId": "a-9"])
    }
}

/// Answers every request with one recorded response, and keeps the requests.
private final class RecordingSender: NativeAuthenticatedRequestSending, @unchecked Sendable {
    let status: Int
    let body: Data
    private(set) var requests: [NativeBearerRequest] = []

    init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(
            statusCode: status,
            headers: try HTTPHeaders(["content-type": "application/json"]),
            body: body
        )
    }
}
