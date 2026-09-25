import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoChatKit

/// The memory page's wire and state machine (Phase 4 Stage B1): tolerant
/// decoding, the bodies each write sends, the route's sentences on refusal,
/// the draft → apply → undo flow, and the scope and grouping rules.
final class NativeMemoryClientTests: XCTestCase {
    private let account = try! AccountID("account-memory")

    // MARK: Decoding

    func testSnapshotDecodesProjectSummariesAndToleratesUnknownFields() async throws {
        let transport = MemoryTransport(routes: ["GET /api/memory": .json(snapshotJSON)])
        let client = NativeMemoryClient(sender: transport)

        let snapshot = try await client.snapshot(for: account)

        XCTAssertEqual(snapshot.facts.count, 4, "the row with no createdAt is dropped, not guessed")
        let first = try XCTUnwrap(snapshot.facts.first)
        XCTAssertEqual(first.category, "preferences")
        XCTAssertEqual(first.sensitive, nil)
        XCTAssertEqual(first.learnedFrom, "You added this")
        XCTAssertEqual(snapshot.facts[1].category, "a-category-from-the-future")
        XCTAssertEqual(snapshot.facts[1].sourceChatID, "conv-9")
        XCTAssertTrue(snapshot.facts[2].isRetired)
        XCTAssertEqual(snapshot.summary?.entryCount, 3)
        XCTAssertEqual(snapshot.projectSummaries.map(\.projectName), ["Thesis"])
    }

    func testSnapshotWithoutProjectSummariesFromAnOlderServer() async throws {
        let transport = MemoryTransport(routes: [
            "GET /api/memory": .json(#"{"memories":[],"summary":null}"#)
        ])
        let snapshot = try await NativeMemoryClient(sender: transport).snapshot(for: account)
        XCTAssertTrue(snapshot.facts.isEmpty)
        XCTAssertNil(snapshot.summary)
        XCTAssertTrue(snapshot.projectSummaries.isEmpty)
    }

    func testEditsDropUnknownStatusesAndOperations() async throws {
        let transport = MemoryTransport(routes: ["GET /api/memory/edits": .json(editsJSON)])
        let edits = try await NativeMemoryClient(sender: transport).edits(for: account)
        XCTAssertEqual(edits.map(\.id), ["edit-1", "edit-2"])
        XCTAssertEqual(edits[0].operations.count, 2, "the operation from a newer build is dropped")
        XCTAssertEqual(edits[1].inverse?.count, 1)
    }

    // MARK: Encoding

    func testWritesSendTheWebsBodies() async throws {
        let transport = MemoryTransport(routes: [
            "POST /api/memory": .json(#"{"memory":{"id":"new-1","content":"Prefers metric","createdAt":"2026-09-20T10:00:00Z"}}"#, status: 201),
            "PATCH /api/memory/fact-1": .json(#"{"ok":true}"#),
            "DELETE /api/memory/fact-2": .json(#"{"error":"Not found"}"#, status: 404),
            "GET /api/memory/recap": .json(#"{"days":30,"themes":["Thesis"],"conversations":4}"#),
        ])
        let client = NativeMemoryClient(sender: transport)

        _ = try await client.add(content: "Prefers metric", projectID: "project-1", for: account)
        try await client.move(id: "fact-1", toProject: nil, for: account)
        try await client.forget(id: "fact-1", for: account)
        try await client.delete(id: "fact-2", for: account)
        let recap = try await client.recap(days: 30, for: account)

        let requests = await transport.recorded()
        XCTAssertEqual(try body(requests[0])["projectId"], .string("project-1"))
        XCTAssertEqual(try body(requests[1])["projectId"], .null, "back to the account is an explicit null")
        XCTAssertEqual(try body(requests[2])["forget"], .bool(true))
        XCTAssertEqual(requests[3].method, .delete, "a 404 delete is the outcome asked for")
        XCTAssertEqual(requests[4].queryItems.first?.value, "30")
        XCTAssertEqual(recap.themes, ["Thesis"])
        XCTAssertThrowsError(try NativeMemoryClient.validate("../escape"))
    }

    func testDraftAnswersAProposalOrARefusal() async throws {
        let proposal = MemoryTransport(routes: [
            "POST /api/memory/edit": .json(#"{"proposal":{"summary":"Switch to metric","operations":[{"op":"update","id":"f1","before":"Uses miles","content":"Uses kilometres"}]}}"#)
        ])
        let refusal = MemoryTransport(routes: [
            "POST /api/memory/edit": .json(#"{"refusal":"Juno can’t remember passwords."}"#)
        ])
        let drafted = try await NativeMemoryClient(sender: proposal).draft(instruction: "use metric", for: account)
        XCTAssertEqual(drafted, .proposal(
            summary: "Switch to metric",
            operations: [.update(id: "f1", before: "Uses miles", content: "Uses kilometres")]
        ))
        let refused = try await NativeMemoryClient(sender: refusal).draft(instruction: "my password", for: account)
        XCTAssertEqual(refused, .refusal("Juno can’t remember passwords."))
        let body = try self.body(await proposal.recorded()[0])
        XCTAssertEqual(body["instruction"], .string("use metric"))
    }

    // MARK: Failure

    func testRefusalsCarryTheRoutesSentenceAndFailuresTheGenericOne() async throws {
        let transport = MemoryTransport(routes: [
            "POST /api/memory": .json(#"{"error":"Juno was asked never to remember that.","code":"suppressed"}"#, status: 409),
            "POST /api/memory/consolidate": .json("<html>", status: 502),
            "POST /api/memory/edit": .json(#"{"error":"Background processing is off.","code":"background_policy_denied"}"#, status: 409),
        ])
        let client = NativeMemoryClient(sender: transport)
        do {
            _ = try await client.add(content: "x", projectID: nil, for: account)
            XCTFail("expected a refusal")
        } catch let error as NativeMemoryRequestError {
            XCTAssertEqual(error.message, "Juno was asked never to remember that.")
            XCTAssertEqual(error.code, "suppressed")
        }
        do {
            _ = try await client.consolidate(projectID: nil, for: account)
            XCTFail("expected a failure")
        } catch let error as NativeMemoryRequestError {
            XCTAssertEqual(error.message, NativeMemoryRequestError.generic)
        }
        let model = await NativeMemoryPageModel(client: client)
        await model.start(for: account)
        let outcome = await model.instruct("forget my job")
        XCTAssertFalse(outcome.drafted)
        let notice = await model.policyNotice
        XCTAssertEqual(notice, "Background processing is off.", "a policy refusal is a notice, not a toast")
    }

    func testUnauthorizedAfterTheCoordinatorGaveUpIsARefusalNotACrash() async throws {
        let transport = MemoryTransport(routes: ["GET /api/memory": .json(#"{"error":"Unauthorized"}"#, status: 401)])
        let model = await NativeMemoryPageModel(client: NativeMemoryClient(sender: transport))
        await model.start(for: account)
        await model.reload()
        let phase = await model.phase
        XCTAssertEqual(phase, .failed)
    }

    // MARK: The model

    func testDraftApplyAndUndoFlow() async throws {
        let transport = MemoryTransport(routes: [
            "POST /api/memory/edit": .json(#"{"proposal":{"summary":"Switch to metric","operations":[{"op":"update","id":"f1","before":"Uses miles","content":"Uses kilometres"}]}}"#),
            "POST /api/memory/edits": .json(ledger(status: "pending", inverse: nil)),
            "POST /api/memory/edit/apply": .json(#"{"memories":[{"id":"f1","content":"Uses kilometres","createdAt":"2026-09-20T10:00:00Z"}],"summary":null,"inverse":[{"op":"update","id":"f1","before":"Uses kilometres","content":"Uses miles"}]}"#),
            "PATCH /api/memory/edits/edit-1": .json(ledger(status: "applied", inverse: #"[{"op":"update","id":"f1","before":"Uses kilometres","content":"Uses miles"}]"#)),
        ])
        let model = await NativeMemoryPageModel(client: NativeMemoryClient(sender: transport))
        await model.start(for: account)

        let drafted = await model.instruct("  use metric  ")
        XCTAssertTrue(drafted.drafted)
        XCTAssertNil(drafted.notice, "a draft lands under the field, not in a toast")
        let pending = await model.pendingEdits
        XCTAssertEqual(pending.map(\.id), ["edit-1"])

        let applied = await model.accept(pending[0], fromDock: true)
        XCTAssertNil(applied)
        let facts = await model.facts
        XCTAssertEqual(facts.first?.content, "Uses kilometres")
        let recent = await model.recentlyApplied()
        XCTAssertEqual(recent.map(\.id), ["edit-1"], "an applied change keeps its inline Undo")

        let requests = await transport.recorded()
        let patch = try XCTUnwrap(requests.last)
        XCTAssertEqual(try body(patch)["status"], .string("applied"))
        XCTAssertEqual(try body(patch)["inverse"]?.arrayCount, 1, "the ledger keeps the server's inverse")

        let later = Date().addingTimeInterval(NativeMemoryPageModel.appliedHold + 1)
        await model.expireApplied(now: later)
        let folded = await model.recentlyApplied(now: later)
        XCTAssertTrue(folded.isEmpty)
    }

    func testDiscardRemovesTheDraft() async throws {
        let transport = MemoryTransport(routes: [
            "GET /api/memory/edits": .json(ledger(status: "pending", inverse: nil)),
            "DELETE /api/memory/edits/edit-1": .json(#"{"edits":[]}"#),
            "GET /api/memory/backfill": .json(#"{"remaining":7}"#),
        ])
        let model = await NativeMemoryPageModel(client: NativeMemoryClient(sender: transport))
        await model.start(for: account)
        await model.loadSideData()
        var pending = await model.pendingEdits
        XCTAssertEqual(pending.count, 1)
        let remaining = await model.backfillRemaining
        XCTAssertEqual(remaining, 7)
        _ = await model.deleteEdit("edit-1")
        pending = await model.pendingEdits
        XCTAssertTrue(pending.isEmpty)
    }

    func testRemovalWaitsOutItsUndoWindow() async throws {
        let transport = MemoryTransport(routes: [
            "DELETE /api/memory/f1": .json(#"{"ok":true}"#),
        ])
        let model = await NativeMemoryPageModel(
            client: NativeMemoryClient(sender: transport), undoWindow: .milliseconds(50)
        )
        await model.start(for: account)
        let fact = NativeMemoryFact(id: "f1", content: "Uses miles", createdAt: Date())
        await model.preview(NativeMemorySnapshot(facts: [fact], summary: nil, projectSummaries: []))

        let notice = await model.remove(fact, kind: .delete)
        XCTAssertEqual(notice.undoID, "f1")
        await model.undoRemoval("f1")
        try await Task.sleep(for: .milliseconds(120))
        var requests = await transport.recorded()
        XCTAssertTrue(requests.isEmpty, "an Undo inside the window sends nothing")
        let hidden = await model.hiddenIDs
        XCTAssertTrue(hidden.isEmpty)

        _ = await model.remove(fact, kind: .delete)
        try await Task.sleep(for: .milliseconds(200))
        requests = await transport.recorded()
        XCTAssertEqual(requests.map(\.path), ["/api/memory/f1"])
        let facts = await model.facts
        XCTAssertTrue(facts.isEmpty)
    }

    // MARK: Presentation

    func testScopesCountActiveFactsAndIncludeProjectsWithOnlyASummary() throws {
        let now = Date()
        let facts = [
            NativeMemoryFact(id: "a", content: "A", createdAt: now),
            NativeMemoryFact(id: "b", content: "B", createdAt: now, projectID: "p1", projectName: "Thesis"),
            NativeMemoryFact(id: "c", content: "C", createdAt: now, projectID: "p1", projectName: "Thesis", status: "superseded"),
            NativeMemoryFact(id: "d", content: "D", kind: "SUPPRESSION", createdAt: now),
        ]
        let summaries = [NativeProjectMemorySummary(
            projectID: "p2", projectName: "Kitchen",
            summary: NativeMemoryPageSummary(content: "x", updatedAt: now, entryCount: 0)
        )]
        let scopes = NativeMemoryPresentation.scopes(facts: facts, projectSummaries: summaries)
        XCTAssertEqual(scopes.map(\.label), ["Everything", "Thesis", "Kitchen"])
        XCTAssertEqual(scopes.map(\.count), [2, 1, 0])

        let inThesis = NativeMemoryPresentation.facts(facts, inScope: "p1")
        XCTAssertEqual(inThesis.map(\.id), ["b", "c", "d"], "a project keeps the account-wide never-remember list")
        XCTAssertEqual(NativeMemoryPresentation.facts(facts, inScope: nil).count, 4)
    }

    func testTopicSectionsFollowTheCategoryOrderWithUnknownLast() throws {
        let now = Date()
        let facts = [
            NativeMemoryFact(id: "1", content: "Loves trains", createdAt: now, category: "preferences"),
            NativeMemoryFact(id: "2", content: "Lives in Lyon", createdAt: now, category: "identity"),
            NativeMemoryFact(id: "3", content: "Mystery", createdAt: now, category: "from-the-future"),
            NativeMemoryFact(id: "4", content: "Old", createdAt: now, category: nil),
        ]
        let sections = NativeMemoryPresentation.sections(facts, grouping: .topic, now: now)
        XCTAssertEqual(sections.map(\.label), ["Identity", "Preferences", "Uncategorised"])
        XCTAssertEqual(sections.last?.rows.count, 2)
        XCTAssertTrue(NativeMemoryPresentation.matches(facts[1], query: "identity"), "search reads the topic")
        XCTAssertFalse(NativeMemoryPresentation.matches(facts[1], query: "trains"))
    }

    func testSummarySectionsAndPreview() throws {
        let markdown = "Liam is a designer.\n\n## Work\nBuilds Juno.\n\n## Style\nShort answers."
        let sections = NativeMemoryPresentation.summarySections(markdown)
        XCTAssertEqual(sections.map(\.title), ["About you", "Work", "Style"])
        XCTAssertEqual(NativeMemoryPresentation.summaryPreviewCount(sections), 3, "a short remainder is not folded")
        let project = NativeMemoryPresentation.summarySections("Plain text", preambleTitle: "About this project")
        XCTAssertEqual(project.first?.title, "About this project")
    }

    func testRecapDatesEachChangeByItsOwnMeaning() throws {
        let now = Date()
        let old = now.addingTimeInterval(-60 * 86_400)
        let recent = now.addingTimeInterval(-2 * 86_400)
        let rows = [
            NativeMemoryFact(id: "new", content: "Uses km", createdAt: recent, lastUsedAt: recent),
            NativeMemoryFact(id: "old", content: "Uses miles", createdAt: old, status: "superseded", supersededByID: "new"),
            NativeMemoryFact(id: "gone", content: "Password", kind: "SUPPRESSION", createdAt: recent),
        ]
        let recap = NativeMemoryRecap.build(rows, days: 7, now: now)
        XCTAssertEqual(recap.learned.map(\.id), ["new"])
        XCTAssertEqual(recap.replaced.map(\.before.id), ["old"], "dated by the replacement's createdAt")
        XCTAssertEqual(recap.forgotten.map(\.id), ["gone"])
        XCTAssertEqual(recap.leanedOn.map(\.id), ["new"])
        XCTAssertFalse(recap.isEmpty(themes: []))
    }

    // MARK: Helpers

    private func body(_ request: NativeBearerRequest) throws -> [String: JunoJSONValue] {
        let data = try XCTUnwrap(request.body)
        guard case .object(let object) = try JSONDecoder().decode(JunoJSONValue.self, from: data) else {
            throw XCTSkip("not an object")
        }
        return object
    }

    private func ledger(status: String, inverse: String?) -> String {
        #"{"edits":[{"id":"edit-1","instruction":"use metric","summary":"Switch to metric","status":""# + status
            + #"","operations":[{"op":"update","id":"f1","before":"Uses miles","content":"Uses kilometres"}],"inverse":"#
            + (inverse ?? "null") + #","createdAt":"2026-09-20T10:00:00Z"}]}"#
    }
}

private extension JunoJSONValue {
    var arrayCount: Int? {
        if case .array(let values) = self { return values.count }
        return nil
    }
}

struct MemoryFixtureResponse: Sendable {
    let status: Int
    let body: String

    static func json(_ body: String, status: Int = 200) -> Self { Self(status: status, body: body) }
}

actor MemoryTransport: NativeAuthenticatedRequestSending {
    private let routes: [String: MemoryFixtureResponse]
    private var requests: [NativeBearerRequest] = []

    init(routes: [String: MemoryFixtureResponse]) {
        self.routes = routes
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        let key = "\(request.method.rawValue.uppercased()) \(request.path)"
        let fixture = routes[key] ?? MemoryFixtureResponse(status: 500, body: #"{"error":"missing fixture"}"#)
        return HTTPResponse(statusCode: fixture.status, headers: HTTPHeaders(), body: Data(fixture.body.utf8))
    }

    func recorded() -> [NativeBearerRequest] { requests }
}

private let snapshotJSON = #"""
{
  "memories": [
    {"id":"f1","content":"Prefers metric units","source":"MANUAL","kind":"FACT","sourceRef":"manual","createdAt":"2026-09-24T10:00:00.000Z","category":"preferences","projectId":null,"projectName":null,"confidence":1,"status":"active","reason":null,"expiresAt":null,"lastUsedAt":null,"lastVerifiedAt":null,"supersededById":null,"sensitive":null,"aFieldFromTheFuture":{"x":1}},
    {"id":"f2","content":"Works on Juno","source":"AUTO","kind":"FACT","sourceRef":"conv-9","createdAt":"2026-09-23T10:00:00Z","category":"a-category-from-the-future","status":"active"},
    {"id":"f3","content":"Uses miles","source":"AUTO","kind":"FACT","sourceRef":"conv-2","createdAt":"2026-08-01T10:00:00Z","category":"preferences","status":"superseded","supersededById":"f1"},
    {"id":"f4","content":"Never remember my address","source":"MANUAL","kind":"SUPPRESSION","sourceRef":"forget","createdAt":"2026-09-01T10:00:00Z","status":"active"},
    {"id":"broken","content":"No date"}
  ],
  "summary": {"content":"## Work\nBuilds Juno.","updatedAt":"2026-09-24T09:00:00Z","entryCount":3},
  "projectSummaries": [
    {"projectId":"p1","projectName":"Thesis","content":"About the thesis.","updatedAt":"2026-09-20T09:00:00Z","entryCount":2},
    {"projectName":"No id"}
  ]
}
"""#

private let editsJSON = #"""
{"edits":[
  {"id":"edit-1","instruction":"use metric","status":"pending","operations":[{"op":"update","id":"f1","before":"a","content":"b"},{"op":"remove","id":"f2","before":"c"},{"op":"transmogrify","id":"f3"}],"createdAt":"2026-09-20T10:00:00Z"},
  {"id":"edit-2","instruction":"forget my job","status":"applied","operations":[{"op":"add","content":"My job","suppress":true}],"inverse":[{"op":"remove","id":"s1","before":"My job"}],"createdAt":"2026-09-19T10:00:00Z"},
  {"id":"edit-3","instruction":"?","status":"a-status-from-the-future","operations":[]}
]}
"""#
