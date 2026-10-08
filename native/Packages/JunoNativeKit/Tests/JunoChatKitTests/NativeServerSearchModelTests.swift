import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoChatKit

/// The iPhone's server half of search: which types go to `/api/search` under
/// each filter, the generation guard, and where a hit opens.
@MainActor
final class NativeServerSearchModelTests: XCTestCase {
    private let accountID = try! AccountID("account-search")

    // MARK: Rules

    func testFiltersNarrowTheServerAndTheDevice() {
        XCTAssertEqual(NativeServerSearchModel.serverTypes(for: nil), [.knowledge, .memory, .work])
        XCTAssertEqual(NativeServerSearchModel.serverTypes(for: .memory), [.memory])
        XCTAssertEqual(NativeServerSearchModel.serverTypes(for: .conversation), [])
        XCTAssertTrue(NativeServerSearchModel.searchesLocally(nil))
        XCTAssertTrue(NativeServerSearchModel.searchesLocally(.file))
        XCTAssertFalse(NativeServerSearchModel.searchesLocally(.work))
        XCTAssertEqual(NativeServerSearchModel.localKind(for: .message), .message)
        XCTAssertNil(NativeServerSearchModel.localKind(for: nil))
        XCTAssertNil(NativeServerSearchModel.localKind(for: .knowledge))
    }

    // MARK: State

    func testARealRequestCarriesTheServerTypesAndLandsAsGroups() async throws {
        let sender = SearchSender(body: Self.body(query: "plan"))
        let model = NativeServerSearchModel(
            client: NativeUnifiedSearchClient(sender: sender), accountID: accountID, debounce: .seconds(60)
        )
        model.setQuery("plan")
        XCTAssertEqual(model.state, .searching)
        await model.run(generation: model.currentGeneration)

        XCTAssertEqual(model.groups.map(\.type), [.memory])
        XCTAssertEqual(model.hitCount, 1)
        XCTAssertEqual(model.notice, "Knowledge: Two documents are still being indexed.")
        let recorded = await sender.recorded()
        let request = try XCTUnwrap(recorded.first)
        XCTAssertEqual(request.path, "/api/search")
        XCTAssertEqual(request.queryItems.first { $0.name == "q" }?.value, "plan")
        XCTAssertEqual(request.queryItems.first { $0.name == "types" }?.value, "knowledge,memory,work")
    }

    func testALocalFilterSkipsTheServerAndAnEmptyQueryIsIdle() {
        let model = NativeServerSearchModel(debounce: .seconds(60)) { _, _ in
            XCTFail("must not be asked")
            throw URLError(.badURL)
        }
        model.setTypeFilter(.conversation)
        XCTAssertEqual(model.state, .idle)
        model.setQuery("plan")
        XCTAssertEqual(model.state, .skipped)
        model.setTypeFilter(nil)
        XCTAssertEqual(model.state, .searching)
        model.setQuery("   ")
        XCTAssertEqual(model.state, .idle)
    }

    func testALateAnswerToAnEarlierQueryIsDropped() async {
        let model = NativeServerSearchModel(debounce: .seconds(60)) { query, _ in
            try NativeUnifiedSearchClient.decodeSearch(Self.body(query: query))
        }
        model.setQuery("pla")
        let stale = model.currentGeneration
        model.setQuery("plan")
        await model.run(generation: stale)
        XCTAssertEqual(model.state, .searching, "an answer for an older generation never lands")
        await model.run(generation: model.currentGeneration)
        guard case .ready(let result) = model.state else { return XCTFail("expected a result") }
        XCTAssertEqual(result.query, "plan")
    }

    func testAFailureSaysWhatWasNotSearched() async {
        let model = NativeServerSearchModel(debounce: .seconds(60)) { _, _ in throw URLError(.notConnectedToInternet) }
        model.setQuery("plan")
        await model.run(generation: model.currentGeneration)
        XCTAssertEqual(model.state, .failed)
        XCTAssertEqual(model.notice, "Knowledge, memory and tasks couldn’t be searched right now.")
        model.setTypeFilter(.work)
        await model.run(generation: model.currentGeneration)
        XCTAssertEqual(model.notice, "Tasks couldn’t be searched right now.")
    }

    // MARK: Destinations

    func testHitsOpenWhereTheirHrefPoints() {
        func hit(_ type: NativeUnifiedSearchType, _ id: String, _ href: String) -> NativeSearchHit {
            NativeSearchHit(id: id, type: type, title: "t", href: href)
        }
        XCTAssertEqual(NativeSearchHitDestination(hit: hit(.memory, "memory:m1", "/memory?entry=m1")), .memory)
        XCTAssertEqual(NativeSearchHitDestination(hit: hit(.knowledge, "k:1", "/library?doc=1")), .library)
        XCTAssertEqual(
            NativeSearchHitDestination(hit: hit(.work, "work:s1", "/chat/c-42?m=msg-9")),
            .conversation(id: "c-42", messageID: "msg-9")
        )
        XCTAssertEqual(NativeSearchHitDestination(hit: hit(.work, "work:s2", "/work/s2")), .workSession(id: "s2"))
        XCTAssertNil(NativeSearchHitDestination(hit: hit(.work, "odd", "/chat")))
        XCTAssertEqual(NativeSearchHitDestination(hit: hit(.project, "p", "/projects/p-7")), .project(id: "p-7"))
        XCTAssertEqual(NativeSearchHitDestination(hit: hit(.artifact, "a", "/a/art-1")), .artifact(id: "art-1"))
        XCTAssertNil(NativeSearchHitDestination(hit: hit(.conversation, "c", "/settings")))
    }

    // MARK: Fixtures

    nonisolated static func body(query: String) -> Data {
        Data(
            """
            {
              "query": "\(query)",
              "total": 1,
              "partial": true,
              "groups": [
                {"type": "memory", "label": "Memory", "hits": [
                  {"id": "memory:m1", "type": "memory", "title": "Prefers quarterly plans in a table",
                   "titleMarks": [], "snippet": null, "href": "/memory?entry=m1", "locator": null,
                   "projectId": null, "updatedAt": "2026-09-20T09:14:00.000Z", "score": 0.82}
                ]},
                {"type": "work", "label": "Tasks", "hits": []}
              ],
              "coverage": [
                {"type": "memory", "state": "complete", "detail": null},
                {"type": "knowledge", "state": "partial", "detail": "Two documents are still being indexed."}
              ]
            }
            """.utf8
        )
    }
}

/// The ledger that keeps an announcement from opening twice.
final class NativeAnnouncementLedgerTests: XCTestCase {
    func testAnAnnouncementOpensOnceAndTheListIsCapped() throws {
        let suite = "juno.tests.announcements.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let ledger = NativeAnnouncementLedger(defaults: defaults)
        let item = NativeAnnouncement(id: "launch-1", title: "New model", description: "It is here.")

        XCTAssertFalse(ledger.shouldShow(nil))
        XCTAssertTrue(ledger.shouldShow(item))
        ledger.markDismissed("launch-1")
        ledger.markDismissed("launch-1")
        XCTAssertFalse(ledger.shouldShow(item))
        XCTAssertEqual(defaults.stringArray(forKey: NativeAnnouncementLedger.dismissedKey), ["launch-1"])

        for index in 0..<(NativeAnnouncementLedger.capacity + 5) { ledger.markDismissed("a\(index)") }
        XCTAssertEqual(defaults.stringArray(forKey: NativeAnnouncementLedger.dismissedKey)?.count, NativeAnnouncementLedger.capacity)
        XCTAssertTrue(ledger.shouldShow(item), "the oldest ids fall off the end")
    }
}

private actor SearchSender: NativeAuthenticatedRequestSending {
    private let body: Data
    private var requests: [NativeBearerRequest] = []

    init(body: Data) { self.body = body }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: body)
    }

    func recorded() -> [NativeBearerRequest] { requests }
}
