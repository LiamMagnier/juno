import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import JunoDesignSystem
import Testing
@testable import JunoChatKit

/// Activity (G70): the decoder over `GET /api/activity`'s JSON, the grouping
/// and cadence rules the web uses (src/lib/activity/model.ts,
/// src/components/activity/use-activity.ts), each request's shape, and the model.
@Suite struct NativeActivityTests {
    private let account = try! AccountID("account-activity")

    static let pageJSON = #"""
    {
      "items": [
        {"id":"work:w1","kind":"work","sourceId":"w1","title":"Send the invoices","state":"needs_you","need":"approval","status":"waiting_approval","needSummary":"Send the invoice to Sam?","startedAt":"2026-10-18T10:00:00.000Z","updatedAt":"2026-10-18T11:59:00.000Z","href":"/work/w1","conversationId":"c1","runId":null,"canStop":false},
        {"id":"work:w2","kind":"work","sourceId":"w2","title":"Tidy the drive","state":"running","need":null,"status":"running","needSummary":null,"startedAt":"2026-10-18T11:56:00.000Z","updatedAt":"2026-10-18T11:58:00.000Z","href":"/work/w2","conversationId":null,"runId":"run-2","canStop":true},
        {"id":"code:t1","kind":"code","sourceId":"t1","title":"Fix the login bug","state":"ready","need":"review","status":"done","needSummary":null,"startedAt":"2026-10-18T09:00:00.000Z","updatedAt":"2026-10-18T09:30:00.000Z","href":"/code/c9","conversationId":"c9","runId":null,"canStop":false},
        {"id":"research:r1","kind":"research","sourceId":"r1","title":"Heat pumps","state":"blocked","need":null,"status":"failed","needSummary":null,"startedAt":"2026-10-18T08:00:00.000Z","updatedAt":"2026-10-18T08:10:00.000Z","href":"/research/r1","conversationId":null,"runId":null,"canStop":false},
        {"id":"work:w9","kind":"work","sourceId":"w9","title":"From the future","state":"teleporting","need":null,"status":"x","needSummary":null,"startedAt":"2026-10-18T08:00:00.000Z","updatedAt":"2026-10-18T08:00:00.000Z","href":"/work/w9","conversationId":null,"runId":null,"canStop":false}
      ],
      "counts": {"needs_you":1,"running":1,"ready":1,"blocked":1},
      "nextCursor":"abc"
    }
    """#

    @Test func decodesTheRouteAndDropsStatesItCannotName() throws {
        let page = try NativeActivityPage.decode(Data(Self.pageJSON.utf8))
        #expect(page.items.map(\.id) == ["work:w1", "work:w2", "code:t1", "research:r1"])
        #expect(page.counts == NativeActivityCounts(needsYou: 1, running: 1, ready: 1, blocked: 1))
        #expect(page.nextCursor == "abc")
        let first = try #require(page.items.first)
        #expect(first.state == .needsYou)
        #expect(first.need == .approval)
        #expect(first.needSummary == "Send the invoice to Sam?")
        #expect(first.verb == "Review")
        #expect(first.conversationID == "c1")
        #expect(page.items[1].runID == "run-2")
        #expect(page.items[1].canStop)
        #expect(page.items[2].verb == "Open")
    }

    @Test func anAgentsRunCarriesItsFaceAndState() throws {
        let json = #"{"items":[{"id":"work:a","kind":"work","sourceId":"a","title":"Inbox","state":"needs_you","need":"question","status":"waiting_input","startedAt":"2026-10-18T10:00:00.000Z","updatedAt":"2026-10-18T11:00:00.000Z","href":"/work/a","canStop":false,"agent":{"id":"agent-1","name":"Maren","avatar":{"shape":"orb","tone":"teal","eyes":"round","mark":"ring"},"state":"waiting"}},{"id":"work:b","kind":"work","sourceId":"b","title":"Mine","state":"running","status":"running","startedAt":"2026-10-18T10:00:00.000Z","updatedAt":"2026-10-18T11:00:00.000Z","href":"/work/b","agent":null}],"counts":{"needs_you":1,"running":1,"ready":0,"blocked":0},"nextCursor":null}"#
        let page = try NativeActivityPage.decode(Data(json.utf8))
        let agent = try #require(page.items.first?.agent)
        #expect(agent.name == "Maren")
        #expect(agent.state == .waiting)
        #expect(agent.avatar == JunoAgentAvatar(shape: "orb", tone: "teal", eyes: "round", mark: "ring", seed: "agent-1"))
        #expect(page.items[1].agent == nil)
    }

    @Test func groupsReadNeedsYouFirstAndBlockedLast() throws {
        let page = try NativeActivityPage.decode(Data(Self.pageJSON.utf8))
        let groups = NativeActivityGrouping.groups(page.items)
        #expect(groups.map(\.state) == [.needsYou, .running, .ready, .blocked])
        #expect(NativeActivityGrouping.groups(page.items, only: .ready).map(\.state) == [.ready])
        #expect(NativeActivityGrouping.groups([], only: nil).isEmpty)
    }

    @Test func pollsOnlyWhileSomethingIsLive() {
        #expect(NativeActivityGrouping.pollInterval(nil) == nil)
        #expect(NativeActivityGrouping.pollInterval(NativeActivityCounts()) == nil)
        #expect(NativeActivityGrouping.pollInterval(NativeActivityCounts(ready: 3, blocked: 1)) == nil)
        #expect(NativeActivityGrouping.pollInterval(NativeActivityCounts(needsYou: 1)) == .seconds(30))
        #expect(NativeActivityGrouping.pollInterval(NativeActivityCounts(needsYou: 1, running: 2)) == .seconds(5))
    }

    @Test func pageRequestCarriesLimitAndCursor() async throws {
        let sender = ActivitySender { _ in (200, Self.pageJSON) }
        let client = NativeActivityClient(sender: sender)
        _ = try await client.page(cursor: "abc", limit: 20, for: account)
        let request = try #require(await sender.requests.first)
        #expect(request.path == "/api/activity")
        #expect(request.method == .get)
        #expect(request.queryItems == [URLQueryItem(name: "limit", value: "20"), URLQueryItem(name: "cursor", value: "abc")])
    }

    @Test func stopUsesEachProductsOwnRoute() throws {
        let page = try NativeActivityPage.decode(Data(Self.pageJSON.utf8))
        let running = page.items[1]
        let work = try #require(try NativeActivityClient.stopRequest(for: running))
        #expect(work.path == "/api/work/runs/run-2/control")
        #expect(work.method == .post)
        #expect(work.body == Data(#"{"action":"cancel"}"#.utf8))

        let code = NativeActivityItem(id: "code:t2", kind: .code, sourceID: "t2", title: "x", state: .running, status: "running", startedAt: .now, updatedAt: .now, href: "/code", canStop: true)
        #expect(try NativeActivityClient.stopRequest(for: code)?.path == "/api/code/tasks/t2/cancel")

        let research = NativeActivityItem(id: "research:r2", kind: .research, sourceID: "r2", title: "x", state: .running, status: "planning", startedAt: .now, updatedAt: .now, href: "/research/r2", canStop: true)
        #expect(try NativeActivityClient.stopRequest(for: research)?.path == "/api/research/r2/control")

        // Nothing that cannot be stopped gets a request.
        #expect(try NativeActivityClient.stopRequest(for: page.items[0]) == nil)
        let orphan = NativeActivityItem(id: "work:w3", kind: .work, sourceID: "w3", title: "x", state: .running, status: "running", startedAt: .now, updatedAt: .now, href: "/work/w3", canStop: true)
        #expect(try NativeActivityClient.stopRequest(for: orphan) == nil)
    }

    @Test func timeLabelsSayHowLong() throws {
        let now = try #require(NativeActivityDates.parse("2026-10-18T12:00:00.000Z"))
        let page = try NativeActivityPage.decode(Data(Self.pageJSON.utf8))
        #expect(NativeActivityGrouping.timeLabel(for: page.items[1], now: now).contains("4"))
        #expect(NativeActivityGrouping.timeLabel(for: page.items[3], now: now).contains("3"))
    }

    @MainActor @Test func theModelLoadsAndKeepsWhatItHasOnAFailedRefresh() async {
        let failing = ActivitySender { _ in (500, #"{"error":"Internal"}"#) }
        let failed = NativeActivityModel(client: NativeActivityClient(sender: failing), accountID: account)
        await failed.load()
        #expect(failed.state == .failed("Internal"))

        let flaky = ActivitySender(script: [(200, Self.pageJSON), (503, #"{"error":"down"}"#)])
        let model = NativeActivityModel(client: NativeActivityClient(sender: flaky), accountID: account)
        await model.load()
        #expect(model.items.count == 4)
        #expect(model.pollInterval == .seconds(5))
        await model.load()
        #expect(model.items.count == 4, "a failed refresh keeps the list")
        #expect(model.state == .loaded)
    }

    @MainActor @Test func olderPagesAppendWithoutDuplicates() async {
        let second = #"{"items":[{"id":"code:t1","kind":"code","sourceId":"t1","title":"Fix the login bug","state":"ready","need":"review","status":"done","startedAt":"2026-10-18T09:00:00.000Z","updatedAt":"2026-10-18T09:30:00.000Z","href":"/code/c9","conversationId":"c9","canStop":false},{"id":"code:t0","kind":"code","sourceId":"t0","title":"Older","state":"ready","need":"review","status":"done","startedAt":"2026-10-18T07:00:00.000Z","updatedAt":"2026-10-18T07:30:00.000Z","href":"/code","conversationId":null,"canStop":false}],"counts":{"needs_you":1,"running":1,"ready":2,"blocked":1},"nextCursor":null}"#
        let sender = ActivitySender(script: [(200, Self.pageJSON), (200, second)])
        let model = NativeActivityModel(client: NativeActivityClient(sender: sender), accountID: account)
        await model.load()
        await model.loadMore()
        #expect(model.items.map(\.id) == ["work:w1", "work:w2", "code:t1", "research:r1", "code:t0"])
        #expect(model.nextCursor == nil)
    }
}

/// Answers through a closure (or a script, in order) and keeps every request.
private actor ActivitySender: NativeAuthenticatedRequestSending {
    private let respond: @Sendable (NativeBearerRequest) -> (Int, String)
    private var script: [(Int, String)]
    private(set) var requests: [NativeBearerRequest] = []

    init(respond: @escaping @Sendable (NativeBearerRequest) -> (Int, String)) {
        self.respond = respond
        self.script = []
    }

    init(script: [(Int, String)]) {
        self.respond = { _ in (404, "{}") }
        self.script = script
    }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        let (status, body) = script.isEmpty ? respond(request) : script.removeFirst()
        return HTTPResponse(statusCode: status, headers: try HTTPHeaders(["content-type": "application/json"]), body: Data(body.utf8))
    }
}
