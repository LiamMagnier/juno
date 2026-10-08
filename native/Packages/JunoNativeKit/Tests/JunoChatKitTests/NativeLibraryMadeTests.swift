import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoChatKit

/// The Library's made half, against the web's `GET /api/library/made`
/// (src/app/api/library/made/route.ts, src/lib/library-made.ts).
@MainActor
final class NativeLibraryMadeTests: XCTestCase {
    private let account = try! AccountID("account-a")

    private func json(_ text: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(text.utf8))
    }

    private let page1 = #"""
    {"items":[
      {"kind":"artifact","id":"a1","type":"HTML","title":"Launch page","version":3,"projectId":"p1",
       "createdAt":"2026-10-01T09:00:00.000Z","updatedAt":"2026-10-04T10:00:00.000Z","href":"/a/a1",
       "conversationId":"c1","preview":"<!doctype html>\n<html>  <h1>Field Notes</h1>"},
      {"kind":"deliverable","id":"d1","type":"SPREADSHEET","title":"Q3 model","version":1,"projectId":null,
       "createdAt":"2026-10-02T09:00:00Z","updatedAt":"2026-10-03T10:00:00Z",
       "href":"/api/work/artifacts/d1/download","conversationId":"c2",
       "mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","validated":true,
       "agent":{"id":"ag1","name":"Mira","avatar":{"shape":"pebble","tone":"sky"}}}
    ],"nextCursor":"cur-2"}
    """#

    func testTheQueryIsSpelledAsTheRouteReadsIt() {
        XCTAssertEqual(NativeLibraryMadeQuery().queryItems(cursor: nil), [URLQueryItem(name: "limit", value: "50")])
        let full = NativeLibraryMadeQuery(q: "  deck  ", kind: .deliverable, projectID: "p1", limit: 500)
        XCTAssertEqual(full.queryItems(cursor: "c-9"), [
            URLQueryItem(name: "limit", value: "100"),
            URLQueryItem(name: "q", value: "deck"),
            URLQueryItem(name: "kind", value: "deliverable"),
            URLQueryItem(name: "projectId", value: "p1"),
            URLQueryItem(name: "cursor", value: "c-9"),
        ])
    }

    func testAPageDecodesBothKindsWithTheirByline() throws {
        let page = try XCTUnwrap(NativeLibraryMadePage.decode(Data(page1.utf8)))
        XCTAssertEqual(page.items.map(\.listID), ["artifact:a1", "deliverable:d1"])
        XCTAssertEqual(page.nextCursor, "cur-2")
        XCTAssertEqual(page.items[0].byline, "Made by Alevr")
        XCTAssertEqual(page.items[1].byline, "Made by Mira")
        XCTAssertEqual(page.items[0].typeLabel, "Web page")
        XCTAssertEqual(page.items[1].typeLabel, "Spreadsheet")
        XCTAssertEqual(page.items[1].validated, true)
        XCTAssertEqual(page.items[0].excerpt, "<!doctype html> <html> <h1>Field Notes</h1>")
        XCTAssertEqual(page.items[0].updatedAt, ISO8601DateFormatter().date(from: "2026-10-04T10:00:00Z"))
    }

    func testTheModelPagesWithoutDuplicates() async throws {
        let sender = MadeQueueSender([
            json(page1),
            json(#"{"items":[{"kind":"deliverable","id":"d1","type":"SPREADSHEET","title":"Q3 model","createdAt":"2026-10-02T09:00:00Z","updatedAt":"2026-10-03T10:00:00Z","href":"x"},{"kind":"artifact","id":"a0","type":"DESIGN","title":"Poster","createdAt":"2026-09-02T09:00:00Z","updatedAt":"2026-09-03T10:00:00Z","href":"/a/a0"}],"nextCursor":null}"#),
        ])
        let model = NativeLibraryMadeModel(client: NativeLibraryMadeClient(sender: sender))
        model.start(for: account)
        await model.reload()
        XCTAssertEqual(model.items?.count, 2)
        XCTAssertTrue(model.hasMore)
        await model.loadMore()
        XCTAssertEqual(model.items?.map(\.listID), ["artifact:a1", "deliverable:d1", "artifact:a0"])
        XCTAssertFalse(model.hasMore)
        let requests = await sender.requests
        XCTAssertEqual(requests.map(\.path), ["/api/library/made", "/api/library/made"])
        XCTAssertEqual(requests[1].queryItems.first { $0.name == "cursor" }?.value, "cur-2")
    }

    func testAFailureSaysWhatTheRouteSaid() async throws {
        let sender = MadeQueueSender([json(#"{"error":"Unknown kind"}"#, status: 400)])
        let model = NativeLibraryMadeModel(client: NativeLibraryMadeClient(sender: sender))
        model.start(for: account)
        await model.reload()
        XCTAssertNil(model.items)
        XCTAssertNotNil(model.errorDescription)
    }

    func testAQueryChangeStartsOver() async throws {
        let sender = MadeQueueSender([json(page1), json(#"{"items":[],"nextCursor":null}"#)])
        let model = NativeLibraryMadeModel(client: NativeLibraryMadeClient(sender: sender))
        model.start(for: account)
        await model.reload()
        await model.setQuery(NativeLibraryMadeQuery(q: "nothing"))
        XCTAssertEqual(model.items, [])
        let last = await sender.requests.last
        XCTAssertEqual(last?.queryItems.first { $0.name == "q" }?.value, "nothing")
        XCTAssertNil(last?.queryItems.first { $0.name == "cursor" })
    }
}

private actor MadeQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(_ responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.notConnectedToInternet) }
        return responses.removeFirst()
    }
}
