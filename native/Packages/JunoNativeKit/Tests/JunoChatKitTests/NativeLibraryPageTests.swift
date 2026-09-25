import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoChatKit

/// The Library page's client and model (Phase 4 A4), against the web's
/// `use-library.ts` and `library-types.ts`.
@MainActor
final class NativeLibraryPageTests: XCTestCase {
    private let account = try! AccountID("account-a")

    private func json(_ text: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(text.utf8))
    }

    private func item(_ id: String, _ name: String, kind: String = "FILE", at seconds: TimeInterval = 0, inUse: NativeLibraryUse? = nil) -> NativeLibraryItem {
        NativeLibraryItem(
            id: id, fileName: name, mimeType: "application/pdf", size: 100, kind: kind,
            createdAt: Date(timeIntervalSince1970: 1_800_000_000 + seconds), inUse: inUse
        )
    }

    // MARK: Encoding

    func testTheQueryIsSpelledAsTheWebSpellsIt() {
        XCTAssertEqual(
            NativeLibraryQuery().queryItems(),
            [URLQueryItem(name: "limit", value: "60"), URLQueryItem(name: "sort", value: "newest")]
        )
        let full = NativeLibraryQuery(q: "  report ", kind: .image, sort: .size, deleted: true)
        XCTAssertEqual(full.queryItems(cursor: "c-2"), [
            URLQueryItem(name: "limit", value: "60"),
            URLQueryItem(name: "sort", value: "size"),
            URLQueryItem(name: "q", value: "report"),
            URLQueryItem(name: "kind", value: "IMAGE"),
            URLQueryItem(name: "includeDeleted", value: "true"),
            URLQueryItem(name: "cursor", value: "c-2"),
        ])
    }

    func testThePageRequestUsesTheLibraryRoute() async throws {
        let sender = LibraryQueueSender([json(#"{"items":[]}"#)])
        _ = try await NativeLibraryClient(sender: sender).page(NativeLibraryQuery(kind: .file), for: account)
        let request = await sender.requests.first
        XCTAssertEqual(request?.path, "/api/library")
        XCTAssertEqual(request?.queryItems.first(where: { $0.name == "kind" })?.value, "FILE")
    }

    // MARK: Decoding

    func testDecodingIsTolerant() throws {
        let body = #"""
        {"items":[
          {"id":"a1","kind":"IMAGE","fileName":"cat.png","mimeType":"image/png","size":2048,"url":"/api/files/x",
           "createdAt":"2026-09-01T10:00:00.000Z","conversationId":"c1","version":2,"versionCount":3,"origin":"upload",
           "parserState":"ready","deletedAt":null,"inUse":"chat","keptIn":null,"brandNewField":{"x":1},
           "knowledge":{"state":"partial","error":null,"blockCount":4,"pageCount":9}},
          {"id":"a2","kind":"VIDEO","fileName":"clip.mov","size":"10","createdAt":"2026-09-01T10:00:00Z"},
          {"kind":"FILE","fileName":"no-id.pdf"}
        ],
        "nextCursor":"n1","counts":{"all":12,"IMAGE":5,"FILE":7},"total":12,
        "storage":{"usedBytes":1000,"quotaBytes":5000,"remainingBytes":4000}}
        """#
        let page = try XCTUnwrap(NativeLibraryPage.decode(Data(body.utf8)))
        XCTAssertEqual(page.items.map(\.id), ["a1", "a2"], "a row without an id is dropped, not fatal")
        XCTAssertEqual(page.items[0].versionCount, 3)
        XCTAssertEqual(page.items[0].inUse, .chat)
        XCTAssertEqual(page.items[0].conversationID, "c1")
        XCTAssertEqual(page.items[0].knowledge?.state, "partial")
        XCTAssertNil(page.items[0].knowledge?.documentID)
        XCTAssertEqual(page.items[1].kind, "VIDEO", "an unknown kind is kept as written")
        XCTAssertEqual(page.items[1].size, 10)
        XCTAssertEqual(page.nextCursor, "n1")
        XCTAssertEqual(page.counts, NativeLibraryCounts(all: 12, images: 5, files: 7))
        XCTAssertEqual(page.storage, NativeLibraryStorage(usedBytes: 1000, quotaBytes: 5000, remainingBytes: 4000))

        let later = try XCTUnwrap(NativeLibraryPage.decode(Data(#"{"items":[],"nextCursor":null}"#.utf8)))
        XCTAssertNil(later.counts)
        XCTAssertNil(later.storage)
        XCTAssertNil(later.nextCursor)
        XCTAssertNil(NativeLibraryPage.decode(Data("[]".utf8)))
    }

    /// The document inspector lights up only when the server names the document.
    func testADocumentIDIsReadWhenTheServerSendsOne() throws {
        let body = #"{"items":[{"id":"a1","fileName":"f.pdf","kind":"FILE","knowledge":{"state":"ready","documentId":"doc-9"}}]}"#
        let page = try XCTUnwrap(NativeLibraryPage.decode(Data(body.utf8)))
        XCTAssertEqual(page.items.first?.knowledge?.documentID, "doc-9")
    }

    // MARK: Paging

    func testLoadMoreAppendsWithoutDuplicates() async throws {
        let sender = LibraryQueueSender([
            json(#"{"items":[{"id":"a1","fileName":"one.pdf","kind":"FILE"},{"id":"a2","fileName":"two.pdf","kind":"FILE"}],"nextCursor":"n1","counts":{"all":3,"IMAGE":0,"FILE":3}}"#),
            json(#"{"items":[{"id":"a2","fileName":"two.pdf","kind":"FILE"},{"id":"a3","fileName":"three.pdf","kind":"FILE"}],"nextCursor":null}"#),
        ])
        let model = NativeLibraryPageModel(client: NativeLibraryClient(sender: sender))
        model.start(for: account)
        await model.reload()
        XCTAssertTrue(model.hasMore)
        await model.loadMore()
        XCTAssertEqual(model.items?.map(\.id), ["a1", "a2", "a3"])
        XCTAssertFalse(model.hasMore)
        let cursor = await sender.requests.last?.queryItems.first(where: { $0.name == "cursor" })?.value
        XCTAssertEqual(cursor, "n1")
    }

    // MARK: Delete and Undo

    /// Undo waits for the delete to land before it restores; a restore sent
    /// ahead of its delete would find nothing to restore.
    func testUndoWaitsForTheDeleteToLand() async throws {
        let gate = LibraryGate()
        let sender = LibraryQueueSender(
            [json(#"{"mode":"deleted","keptIn":null}"#), json(#"{"ok":true}"#)],
            holdFirst: gate
        )
        let model = NativeLibraryPageModel(client: NativeLibraryClient(sender: sender))
        model.start(for: account)
        let doomed = item("a1", "one.pdf")
        let kept = item("a2", "two.pdf", at: -10)
        await setRows(model, [doomed, kept], sender: sender)

        let deletion = model.delete([doomed])
        XCTAssertEqual(model.items?.map(\.id), ["a2"], "gone in the frame it was asked for")
        XCTAssertEqual(deletion.notice.title, "Moved to Recently deleted")

        let undo = Task { await model.undo(deletion) }
        try await Task.sleep(for: .milliseconds(50))
        var paths = await sender.requests.map(\.path)
        XCTAssertFalse(paths.contains("/api/attachments/a1/restore"), "no restore before the delete lands")
        await gate.open()
        await undo.value
        paths = await sender.requests.map(\.path)
        XCTAssertEqual(paths.suffix(2), ["/api/library/a1", "/api/attachments/a1/restore"])
        XCTAssertEqual(model.items?.map(\.id), ["a1", "a2"], "back where it sorts")
    }

    /// A restore that finds nothing (404) is where the reader asked it to be.
    func testARestoreNotFoundIsNotAFailure() async throws {
        let sender = LibraryQueueSender([json(#"{"error":"Deleted attachment not found."}"#, status: 404)])
        let model = NativeLibraryPageModel(client: NativeLibraryClient(sender: sender))
        model.start(for: account)
        await model.restore([item("a1", "one.pdf")])
        XCTAssertEqual(model.event, .restored)
    }

    func testAFailedDeletePutsTheRowBack() async throws {
        let sender = LibraryQueueSender([json(#"{"error":"nope"}"#, status: 500)])
        let model = NativeLibraryPageModel(client: NativeLibraryClient(sender: sender))
        model.start(for: account)
        let doomed = item("a1", "one.pdf")
        await setRows(model, [doomed], sender: sender)
        let deletion = model.delete([doomed])
        _ = await deletion.settled.value
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(model.items?.map(\.id), ["a1"])
        XCTAssertEqual(model.event, .deleteFailed(count: 1))
    }

    /// The toast tells the delete the way it will land.
    func testTheRemovalNoticeIsTheWebs() {
        XCTAssertEqual(NativeLibraryRemovalNotice.for([item("a", "a")]).title, "Moved to Recently deleted")
        let kept = NativeLibraryRemovalNotice.for([item("a", "a", inUse: .chat)])
        XCTAssertEqual(kept.title, "Removed from your library")
        XCTAssertEqual(kept.detail, "It stays in the chat that uses it.")
        XCTAssertEqual(
            NativeLibraryRemovalNotice.for([item("a", "a", inUse: .project), item("b", "b", inUse: .project)]).detail,
            "They stay in the projects that use them."
        )
        XCTAssertEqual(
            NativeLibraryRemovalNotice.for([item("a", "a", inUse: .chat), item("b", "b")]).detail,
            "Chats and projects keep the files they use."
        )
    }

    // MARK: Versions

    func testVersionRestorePostsAndReloads() async throws {
        let sender = LibraryQueueSender([
            json(#"{"ok":true,"version":3}"#),
            json(#"{"items":[]}"#),
        ])
        let model = NativeLibraryPageModel(client: NativeLibraryClient(sender: sender))
        model.start(for: account)
        let restored = await model.restoreVersion(2, of: item("a1", "one.pdf"))
        XCTAssertTrue(restored)
        let first = await sender.requests.first
        XCTAssertEqual(first?.path, "/api/attachments/a1/versions/2/restore")
        XCTAssertEqual(first?.method, .post)
        XCTAssertEqual(model.event, .versionRestored)
    }

    func testVersionsDecode() async throws {
        let sender = LibraryQueueSender([json(#"{"versions":[{"version":3,"current":true,"fileName":"f.pdf","size":10,"createdAt":"2026-09-01T00:00:00Z"},{"version":2,"current":false,"fileName":"f.pdf","size":8,"createdAt":"2026-08-01T00:00:00Z"}]}"#)])
        let versions = try await NativeLibraryClient(sender: sender).versions(id: "a1", for: account)
        XCTAssertEqual(versions.map(\.version), [3, 2])
        XCTAssertEqual(versions.first?.current, true)
    }

    // MARK: Placing rows

    func testInsertSortedKeepsTheListsOrderAndWaitsForUnloadedPages() {
        let list = [item("c", "c", at: 30), item("a", "a", at: 10)]
        let middle = item("b", "b", at: 20)
        XCTAssertEqual(NativeLibraryPageModel.insertSorted(list, [middle], sort: .newest, hasMore: false).map(\.id), ["c", "b", "a"])
        let oldest = item("z", "z", at: 0)
        XCTAssertEqual(NativeLibraryPageModel.insertSorted(list, [oldest], sort: .newest, hasMore: true).map(\.id), ["c", "a"])
        XCTAssertEqual(NativeLibraryPageModel.insertSorted(list, [oldest], sort: .newest, hasMore: false).map(\.id), ["c", "a", "z"])
    }

    private func setRows(_ model: NativeLibraryPageModel, _ rows: [NativeLibraryItem], sender: LibraryQueueSender) async {
        let body = "{\"items\":[" + rows.map { row in
            "{\"id\":\"\(row.id)\",\"fileName\":\"\(row.fileName)\",\"kind\":\"\(row.kind)\",\"createdAt\":\"\(ISO8601DateFormatter().string(from: row.createdAt))\"}"
        }.joined(separator: ",") + "],\"counts\":{\"all\":\(rows.count),\"IMAGE\":0,\"FILE\":\(rows.count)}}"
        await sender.prepend(json(body))
        await model.reload()
    }
}

private actor LibraryGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

private actor LibraryQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private let holdFirst: LibraryGate?
    private var sent = 0
    private(set) var requests: [NativeBearerRequest] = []

    init(_ responses: [HTTPResponse], holdFirst: LibraryGate? = nil) {
        self.responses = responses
        self.holdFirst = holdFirst
    }

    func prepend(_ response: HTTPResponse) {
        responses.insert(response, at: 0)
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        sent += 1
        guard !responses.isEmpty else { throw URLError(.notConnectedToInternet) }
        let response = responses.removeFirst()
        // The first request after the seeded page is the delete to hold.
        if let holdFirst, request.method == .delete {
            await holdFirst.wait()
        }
        return response
    }
}
