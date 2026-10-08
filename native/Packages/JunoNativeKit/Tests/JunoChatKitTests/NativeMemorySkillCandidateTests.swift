import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoChatKit

/// Suggested skills, clearing one project's memory, and the provenance line
/// (`skill-candidates.tsx`, `memory-footer.tsx`, `entry-row.tsx`).
final class NativeMemorySkillCandidateTests: XCTestCase {
    private let account = try! AccountID("account-memory")

    // MARK: Skill candidates

    func testCandidatesDecodeTheRoutesShapeAndDropBrokenRows() async throws {
        let transport = MemoryTransport(routes: ["GET /api/memory/skill-candidates": .json(candidatesJSON)])
        let list = try await NativeMemoryClient(sender: transport).skillCandidates(for: account)

        XCTAssertEqual(list.map(\.id), ["sc-1", "sc-2"], "no title and a decided status are both dropped")
        let first = try XCTUnwrap(list.first)
        XCTAssertEqual(first.title, "Weekly market brief")
        XCTAssertEqual(first.tools, ["web_search", "fetch"])
        XCTAssertEqual(first.examples.count, 2)
        XCTAssertEqual(first.runCount, 4)
        XCTAssertNil(first.projectID)
        XCTAssertEqual(list[1].projectID, "p1")
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-03T10:00:00Z"))
        XCTAssertTrue(
            first.detailLine(now: now, locale: Locale(identifier: "en_US")).hasPrefix("4 runs · last "),
            first.detailLine(now: now)
        )
        XCTAssertTrue(first.detailLine(now: now).hasSuffix("web_search, fetch"))
    }

    func testDecisionSendsTheWebsBodyAndReadsTheNewSkill() async throws {
        let transport = MemoryTransport(routes: [
            "POST /api/memory/skill-candidates/sc-1": .json(#"{"ok":true,"slug":"weekly-market-brief","href":"/skills/skill-9"}"#),
        ])
        let outcome = try await NativeMemoryClient(sender: transport)
            .decideSkillCandidate(id: "sc-1", action: .accept, for: account)

        XCTAssertEqual(outcome.slug, "weekly-market-brief")
        XCTAssertEqual(outcome.skillID, "skill-9")
        let recorded = await transport.recorded()
        let request = try XCTUnwrap(recorded.first)
        XCTAssertEqual(request.method, .post)
        XCTAssertEqual(try body(request)["action"], .string("accept"))
        XCTAssertEqual(NativeSkillCandidateOutcome(slug: nil, href: nil).skillID, nil)
    }

    @MainActor
    func testPageModelAcceptKeepsTheRowAndDismissRemovesIt() async throws {
        let transport = MemoryTransport(routes: [
            "GET /api/memory/skill-candidates": .json(candidatesJSON),
            "POST /api/memory/skill-candidates/sc-1": .json(#"{"ok":true,"slug":"weekly-market-brief","href":"/skills/skill-9"}"#),
            "POST /api/memory/skill-candidates/sc-2": .json(#"{"ok":true}"#),
        ])
        let model = NativeMemoryPageModel(client: NativeMemoryClient(sender: transport))
        model.start(for: account)
        await model.loadSkillCandidates()
        XCTAssertEqual(model.skillCandidates.count, 2)

        let accepted = await model.decide(model.skillCandidates[0], .accept)
        XCTAssertEqual(accepted?.tone, .success)
        XCTAssertEqual(model.madeSkills["sc-1"]?.skillID, "skill-9")
        XCTAssertEqual(model.skillCandidates.count, 2, "an accepted proposal stays, saying so")

        let dismissed = await model.decide(model.skillCandidates[1], .dismiss)
        XCTAssertNil(dismissed)
        XCTAssertEqual(model.skillCandidates.map(\.id), ["sc-1"])
        XCTAssertTrue(model.busyCandidateIDs.isEmpty)
    }

    @MainActor
    func testRefusedAcceptSaysTheRoutesSentenceAndAGoneOneLeaves() async throws {
        let transport = MemoryTransport(routes: [
            "GET /api/memory/skill-candidates": .json(candidatesJSON),
            "POST /api/memory/skill-candidates/sc-1": .json(
                #"{"error":"You already have a skill with this name. Rename that one, then try again."}"#, status: 409
            ),
            "POST /api/memory/skill-candidates/sc-2": .json(#"{"error":"That proposal is no longer open."}"#, status: 404),
        ])
        let model = NativeMemoryPageModel(client: NativeMemoryClient(sender: transport))
        model.start(for: account)
        await model.loadSkillCandidates()

        let taken = await model.decide(model.skillCandidates[0], .accept)
        XCTAssertEqual(taken?.title, "You already have a skill with this name. Rename that one, then try again.")
        XCTAssertNil(model.madeSkills["sc-1"])

        let gone = await model.decide(model.skillCandidates[1], .accept)
        XCTAssertEqual(gone?.tone, .error)
        XCTAssertEqual(model.skillCandidates.map(\.id), ["sc-1"])
    }

    // MARK: Clearing a project

    @MainActor
    func testClearProjectSendsTheQueryAndDropsOnlyThatProject() async throws {
        let transport = MemoryTransport(routes: [
            "GET /api/memory": .json(projectSnapshotJSON),
            "DELETE /api/memory": .json(#"{"ok":true,"projectId":"p1"}"#),
        ])
        let model = NativeMemoryPageModel(client: NativeMemoryClient(sender: transport))
        model.start(for: account)
        await model.reload()
        XCTAssertEqual(model.facts.count, 3)

        let notice = await model.clearProject("p1")

        XCTAssertEqual(notice.title, "This project’s memory is cleared.")
        XCTAssertEqual(model.facts.map(\.id), ["a1", "s1"], "account facts and never-remember notes stay")
        XCTAssertTrue(model.projectSummaries.isEmpty)
        XCTAssertNil(model.clearingProjectID)
        let recorded = await transport.recorded()
        let delete = try XCTUnwrap(recorded.last)
        XCTAssertEqual(delete.method, .delete)
        XCTAssertEqual(delete.path, "/api/memory")
        XCTAssertEqual(delete.queryItems, [URLQueryItem(name: "projectId", value: "p1")])
    }

    @MainActor
    func testClearProjectFailureDeletesNothingOnScreen() async throws {
        let transport = MemoryTransport(routes: [
            "GET /api/memory": .json(projectSnapshotJSON),
            "DELETE /api/memory": .json(#"{"error":"Unauthorized"}"#, status: 401),
        ])
        let model = NativeMemoryPageModel(client: NativeMemoryClient(sender: transport))
        model.start(for: account)
        await model.reload()
        let notice = await model.clearProject("p1")
        XCTAssertEqual(notice.tone, .error)
        XCTAssertEqual(model.facts.count, 3)
        XCTAssertEqual(model.projectSummaries.count, 1)
    }

    // MARK: Provenance

    func testProvenanceSaysOnlyWhatChangesTrust() throws {
        let created = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-09-01T10:00:00Z"))
        let now = created.addingTimeInterval(30 * 86_400)
        let inferred = NativeMemoryFact(
            id: "f1", content: "Likes tea", source: "AUTO", createdAt: created, confidence: 0.4,
            lastUsedAt: created.addingTimeInterval(86_400), lastVerifiedAt: created.addingTimeInterval(3 * 86_400)
        )
        let parts = NativeMemoryProvenance.of(inferred)
        XCTAssertEqual(parts.count, 3)
        XCTAssertEqual(parts.first, .inferred)
        let line = try XCTUnwrap(NativeMemoryProvenance.line(for: inferred, now: now, locale: Locale(identifier: "en_US")))
        XCTAssertTrue(line.hasPrefix("Inferred · Confirmed "), line)
        XCTAssertTrue(line.contains(" · Used "), line)

        // Told, not inferred; verified the same day says nothing.
        let told = NativeMemoryFact(
            id: "f2", content: "Lives in Paris", source: "MANUAL", createdAt: created, confidence: 0.3,
            lastVerifiedAt: created.addingTimeInterval(3_600)
        )
        XCTAssertNil(NativeMemoryProvenance.line(for: told, now: now))

        // A retired fact is neither inferred nor in use.
        let retired = NativeMemoryFact(
            id: "f3", content: "Uses miles", source: "AUTO", createdAt: created, confidence: 0.2,
            status: "superseded", lastUsedAt: created
        )
        XCTAssertTrue(NativeMemoryProvenance.of(retired).isEmpty)
    }

    func testSourceMessageAndChatAreReadFromTheRow() async throws {
        let transport = MemoryTransport(routes: ["GET /api/memory": .json(projectSnapshotJSON)])
        let snapshot = try await NativeMemoryClient(sender: transport).snapshot(for: account)
        let fact = try XCTUnwrap(snapshot.facts.first { $0.id == "p-fact-1" })
        XCTAssertEqual(fact.sourceChatID, "conv-7")
        XCTAssertEqual(fact.sourceMessageID, "msg-3")
        XCTAssertEqual(fact.projectName, "Thesis")
    }

    private func body(_ request: NativeBearerRequest) throws -> [String: JunoJSONValue] {
        let data = try XCTUnwrap(request.body)
        guard case .object(let object) = try JSONDecoder().decode(JunoJSONValue.self, from: data) else {
            throw XCTSkip("not an object")
        }
        return object
    }
}

private let candidatesJSON = #"""
{"candidates":[
  {"id":"sc-1","title":"Weekly market brief","projectId":null,"examples":["Brief me on the market","What moved this week?"],"tools":["web_search","fetch"],"runCount":4,"lastSeenAt":"2026-10-01T10:00:00.000Z","status":"pending","skillId":null},
  {"id":"sc-2","title":"Thesis citations","projectId":"p1","examples":[],"tools":["library_search"],"runCount":3,"lastSeenAt":"2026-09-28T10:00:00.000Z","status":"pending","skillId":null},
  {"id":"sc-3","title":"","examples":[],"tools":[],"runCount":2,"lastSeenAt":"2026-09-28T10:00:00.000Z","status":"pending"},
  {"id":"sc-4","title":"Already a skill","examples":[],"tools":[],"runCount":5,"lastSeenAt":"2026-09-28T10:00:00.000Z","status":"accepted","skillId":"s1"}
]}
"""#

private let projectSnapshotJSON = #"""
{
  "memories": [
    {"id":"p-fact-1","content":"Cites in APA","source":"AUTO","kind":"FACT","sourceRef":"conv-7","sourceMessageId":"msg-3","createdAt":"2026-09-24T10:00:00Z","projectId":"p1","projectName":"Thesis","confidence":0.9,"status":"active"},
    {"id":"a1","content":"Prefers metric units","source":"MANUAL","kind":"FACT","sourceRef":"manual","createdAt":"2026-09-24T10:00:00Z","projectId":null,"confidence":1,"status":"active"},
    {"id":"s1","content":"Never remember my address","source":"MANUAL","kind":"SUPPRESSION","sourceRef":"forget","createdAt":"2026-09-01T10:00:00Z","projectId":"p1","status":"active"}
  ],
  "summary": null,
  "projectSummaries": [
    {"projectId":"p1","projectName":"Thesis","content":"About the thesis.","updatedAt":"2026-09-20T09:00:00Z","entryCount":1}
  ]
}
"""#
