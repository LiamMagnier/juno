import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import XCTest
@testable import JunoSync

/// The inbox (Phase 5 brief C1): the four routes as the server shapes them,
/// and the small decisions the sidebar's dot and the popover's list make —
/// the web's `inbox-model.ts`, ported.
@MainActor
final class NativeNotificationsClientTests: XCTestCase {
    private let account = try! AccountID("acct_one")

    // MARK: Routes

    func testAPageDecodesTheServersShapeAndKeepsItsCursor() async throws {
        let sender = InboxSender(body: Self.page)
        let page = try await NativeNotificationsClient(sender: sender).page(limit: 20, before: "cur_9", for: account)

        XCTAssertEqual(page.unreadCount, 2)
        XCTAssertEqual(page.nextBefore, "cur_1")
        XCTAssertEqual(page.notifications.map(\.id), ["n1", "n2"])
        let first = try XCTUnwrap(page.notifications.first)
        XCTAssertEqual(first.priority, .urgent)
        XCTAssertTrue(first.isPressing)
        XCTAssertTrue(first.isUnread)
        XCTAssertEqual(first.href, "/chat/conv_1")
        XCTAssertEqual(first.agent?.name, "Iris")
        XCTAssertEqual(first.agent?.avatarShape, "orb")
        XCTAssertFalse(page.notifications[1].isUnread)
        XCTAssertNil(page.notifications[1].agent)

        let recorded = await sender.recorded()
        let request = try XCTUnwrap(recorded.first)
        XCTAssertEqual(request.path, "/api/notifications")
        XCTAssertEqual(request.method, .get)
        XCTAssertEqual(request.queryItems.first { $0.name == "limit" }?.value, "20")
        XCTAssertEqual(request.queryItems.first { $0.name == "before" }?.value, "cur_9")
        XCTAssertNil(request.queryItems.first { $0.name == "unread" })
    }

    func testARowThisBuildCannotReadIsDroppedNotThePage() async throws {
        let body = #"{"notifications":[{"id":"n1","title":"Fine","createdAt":"2026-09-25T09:00:00Z"},{"title":"No id"}],"unreadCount":1,"nextBefore":null}"#
        let page = try await NativeNotificationsClient(sender: InboxSender(body: body)).page(for: account)
        XCTAssertEqual(page.notifications.map(\.id), ["n1"])
        XCTAssertNil(page.nextBefore)
    }

    func testTheCountAndTheWrites() async throws {
        let sender = InboxSender(body: #"{"unreadCount":3,"urgent":true}"#)
        let client = NativeNotificationsClient(sender: sender)
        let count = try await client.count(for: account)
        XCTAssertEqual(count, NativeNotificationsCount(unreadCount: 3, urgent: true))

        try await client.markRead(id: "n1", for: account)
        try await client.markAllRead(for: account)
        let requests = await sender.recorded()
        XCTAssertEqual(requests.map(\.path), ["/api/notifications/count", "/api/notifications/n1", "/api/notifications"])
        XCTAssertEqual(requests[1].method, .patch)
        XCTAssertEqual(requests[2].method, .post)
        XCTAssertEqual(String(data: requests[2].body ?? Data(), encoding: .utf8), #"{"action":"mark_all_read"}"#)
    }

    func testMarkingARowThatIsGoneIsNotAnError() async throws {
        let client = NativeNotificationsClient(sender: InboxSender(status: 404, body: "{}"))
        try await client.markRead(id: "n1", for: account)
    }

    func testAnIdThatCannotSitInAPathIsRefusedBeforeAnyRequest() async {
        let sender = InboxSender(body: "{}")
        do {
            try await NativeNotificationsClient(sender: sender).markRead(id: "../x", for: account)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? NativeNotificationsError, .invalidIdentifier)
        }
        let requests = await sender.recorded()
        XCTAssertTrue(requests.isEmpty)
    }

    // MARK: The dot

    func testTheDotIsNeverANumberAndOnlyPressingRowsSpendTheAccent() {
        XCTAssertNil(NativeNotificationsModel.dotTone(nil))
        XCTAssertNil(NativeNotificationsModel.dotTone(.init(unreadCount: 0, urgent: true)))
        XCTAssertEqual(NativeNotificationsModel.dotTone(.init(unreadCount: 2, urgent: true)), .accent)
        XCTAssertEqual(NativeNotificationsModel.dotTone(.init(unreadCount: 2, urgent: false)), .muted)
        XCTAssertEqual(NativeNotificationsModel.unreadDetail(.init(unreadCount: 3, urgent: false)), "3 unread")
        XCTAssertNil(NativeNotificationsModel.unreadDetail(.init(unreadCount: 0, urgent: false)))
    }

    func testReadingARowAheadOfTheServer() {
        let after = NativeNotificationsModel.countAfterRead(.init(unreadCount: 1, urgent: true))
        XCTAssertEqual(after, .init(unreadCount: 0, urgent: false))
        XCTAssertEqual(NativeNotificationsModel.countAfterRead(.init(unreadCount: 3, urgent: true)), .init(unreadCount: 2, urgent: true))

        let rows = [row("a"), row("b", read: true)]
        let read = NativeNotificationsModel.withRead(rows, id: "a", at: Date(timeIntervalSince1970: 5))
        XCTAssertFalse(read[0].isUnread)
        XCTAssertEqual(NativeNotificationsModel.withRead(read, id: "a", at: Date()), read, "Already read: the same list.")
        XCTAssertTrue(NativeNotificationsModel.withUnread(read, id: "a")[0].isUnread)
        XCTAssertTrue(NativeNotificationsModel.withAllRead(rows, at: Date()).allSatisfy { !$0.isUnread })
    }

    /// A page's total replaces the number; an accent the last count carried is
    /// kept when the page cannot see the pressing row.
    func testAPageRefreshesTheCountWithoutGuessingAtTheAccent() {
        let quiet = NativeNotificationsPage(notifications: [row("a")], unreadCount: 4, nextBefore: nil)
        XCTAssertEqual(
            NativeNotificationsModel.countFromPage(previous: .init(unreadCount: 1, urgent: true), page: quiet),
            .init(unreadCount: 4, urgent: true)
        )
        XCTAssertEqual(
            NativeNotificationsModel.countFromPage(previous: nil, page: quiet),
            .init(unreadCount: 4, urgent: false)
        )
        let pressing = NativeNotificationsPage(notifications: [row("a", priority: .high)], unreadCount: 1, nextBefore: nil)
        XCTAssertEqual(NativeNotificationsModel.countFromPage(previous: nil, page: pressing), .init(unreadCount: 1, urgent: true))
    }

    func testAnEarlierPageNeverRepeatsARow() {
        let merged = NativeNotificationsModel.appendPage([row("a"), row("b")], [row("b"), row("c")])
        XCTAssertEqual(merged.map(\.id), ["a", "b", "c"])
    }

    func testTheWebsWordsForWhen() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(NativeNotificationsModel.ago(now.addingTimeInterval(-20), now: now), "just now")
        XCTAssertEqual(NativeNotificationsModel.ago(now.addingTimeInterval(-12 * 60), now: now), "12 min ago")
        XCTAssertEqual(NativeNotificationsModel.ago(now.addingTimeInterval(-3 * 3_600), now: now), "3 h ago")
    }

    // MARK: The model

    func testOpeningThePopoverReadsTheListAndMarkingReadMovesTheDotAtOnce() async throws {
        let sender = InboxSender(body: Self.page)
        let model = NativeNotificationsModel(client: NativeNotificationsClient(sender: sender))
        model.start(for: account)
        model.load()
        try await waitUntil { model.listState == .ready }
        XCTAssertEqual(model.items?.count, 2)
        XCTAssertEqual(model.count?.unreadCount, 2)
        XCTAssertEqual(model.dotTone, .accent)
        XCTAssertTrue(model.hasEarlier)

        model.markRead("n1")
        XCTAssertEqual(model.count?.unreadCount, 1, "Read here, before the server answers.")
        XCTAssertFalse(model.items?.first?.isUnread ?? true)
        model.stop()
        XCTAssertNil(model.count)
        XCTAssertNil(model.items)
    }

    func testAFailedListSaysSoAndKeepsNothingStale() async throws {
        let model = NativeNotificationsModel(client: NativeNotificationsClient(sender: InboxSender(status: 500, body: "{}")))
        model.start(for: account)
        model.load()
        try await waitUntil { model.listState == .failed }
        XCTAssertNil(model.items)
        model.stop()
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out")
    }

    private func row(_ id: String, read: Bool = false, priority: NativeNotification.Priority = .normal) -> NativeNotification {
        NativeNotification(
            id: id, title: id, priority: priority,
            readAt: read ? Date(timeIntervalSince1970: 1) : nil,
            createdAt: Date(timeIntervalSince1970: 0)
        )
    }

    private static let page = """
    {"notifications":[
      {"id":"n1","type":"work_needs_you","title":"Iris needs your approval","body":"Send the vendor shortlist","priority":"urgent",
       "sourceType":"work_session","sourceId":"wsi_1","actionable":true,"href":"/chat/conv_1",
       "agent":{"id":"agent_1","name":"Iris","avatar":{"shape":"orb","tone":"violet","eyes":"soft","mark":"spark"}},
       "readAt":null,"createdAt":"2026-09-25T09:12:04.120Z"},
      {"id":"n2","type":"work_completed","title":"Task finished","body":"Quarterly numbers","priority":"normal",
       "sourceType":null,"sourceId":null,"actionable":false,"href":null,"agent":null,
       "readAt":"2026-09-25T08:00:00.000Z","createdAt":"2026-09-25T07:40:00.000Z"}
    ],"unreadCount":2,"nextBefore":"cur_1"}
    """
}

private actor InboxSender: NativeAuthenticatedRequestSending {
    private let status: Int
    private let body: String
    private var requests: [NativeBearerRequest] = []

    init(status: Int = 200, body: String) {
        self.status = status
        self.body = body
    }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }

    func recorded() -> [NativeBearerRequest] { requests }
}
