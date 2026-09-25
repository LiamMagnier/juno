import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoChatKit

/// The assistants gallery's wire and model (Phase 4 Stage B4).
final class NativeAssistantsClientTests: XCTestCase {
    private let account = try! AccountID("account-assistants")

    func testListDecodesTolerantly() async throws {
        let transport = MemoryTransport(routes: ["GET /api/assistants": .json(listJSON)])
        let assistants = try await NativeAssistantsClient(sender: transport).list(for: account)
        XCTAssertEqual(assistants.map(\.name), ["Python data analyst", "Essay coach"])
        XCTAssertEqual(assistants[0].starterPrompts.count, 2)
        XCTAssertEqual(assistants[0].preferredModelID, "anthropic:claude-opus-4-8")
        XCTAssertTrue(assistants[1].isPinned)
        XCTAssertNil(assistants[1].preferredModelID)
    }

    func testCreateTrimsDropsEmptyStartersAndSendsAutoAsAbsent() async throws {
        let transport = MemoryTransport(routes: [
            "POST /api/assistants": .json(#"{"assistant":{"id":"a3","name":"Tutor","version":1}}"#, status: 201),
            "PATCH /api/assistants/a1": .json(#"{"assistant":{"id":"a1","name":"Python data analyst","isPinned":true}}"#),
        ])
        let client = NativeAssistantsClient(sender: transport)
        let draft = NativeAssistantDraft(
            name: "  Tutor ", description: "", systemPrompt: " Teach. ",
            starterPrompts: ["  ", "Quiz me"], preferredModelID: "juno:auto"
        )
        _ = try await client.create(draft, for: account)
        _ = try await client.setPinned(id: "a1", true, for: account)

        let requests = await transport.recorded()
        let create = try object(requests[0])
        XCTAssertEqual(create["name"], .string("Tutor"))
        XCTAssertEqual(create["systemPrompt"], .string("Teach."))
        XCTAssertEqual(create["starterPrompts"], .array([.string("Quiz me")]))
        XCTAssertNil(create["preferredModelId"], "Auto is sent as absent, as the web does")
        XCTAssertEqual(try object(requests[1])["isPinned"], .bool(true))
    }

    @MainActor
    func testModelValidatesSavesAndSaysTheWebsSentences() async throws {
        let transport = MemoryTransport(routes: [
            "GET /api/assistants": .json(listJSON),
            "POST /api/assistants": .json(#"{"error":"Missing required fields"}"#, status: 500),
            "DELETE /api/assistants/a1": .json(#"{"error":"Assistant not found"}"#, status: 404),
        ])
        let model = NativeAssistantsModel(client: NativeAssistantsClient(sender: transport))
        model.start(for: account)
        await model.loadIfNeeded()
        XCTAssertEqual(model.phase, .ready)
        model.query = "essay"
        XCTAssertEqual(model.filtered.map(\.id), ["a2"])

        let invalid = await model.save(NativeAssistantDraft(name: "Only a name"), editing: nil)
        guard case .failure(let error) = invalid else { return XCTFail("a draft without instructions is refused") }
        XCTAssertEqual(error.message, "Add a name and instructions before saving this assistant.")

        let failed = await model.save(NativeAssistantDraft(name: "A", systemPrompt: "B"), editing: nil)
        guard case .failure(let refusal) = failed else { return XCTFail("expected a failure") }
        XCTAssertEqual(refusal.message, "Missing required fields", "the route's own words when it wrote some")

        let delete = await model.delete(model.assistants[0])
        XCTAssertEqual(delete, "Couldn’t delete the assistant. Nothing was removed.")
        XCTAssertEqual(model.assistants.count, 2, "nothing is removed when the delete failed")
    }

    @MainActor
    func testAFailedReadIsAFailureNotAnEmptyGallery() async throws {
        let transport = MemoryTransport(routes: ["GET /api/assistants": .json("oops", status: 500)])
        let model = NativeAssistantsModel(client: NativeAssistantsClient(sender: transport))
        model.start(for: account)
        await model.reload()
        XCTAssertEqual(model.phase, .failed)
    }

    private func object(_ request: NativeBearerRequest) throws -> [String: JunoJSONValue] {
        let data = try XCTUnwrap(request.body)
        guard case .object(let object) = try JSONDecoder().decode(JunoJSONValue.self, from: data) else {
            throw XCTSkip("not an object")
        }
        return object
    }
}

private let listJSON = #"""
{"assistants":[
  {"id":"a1","userId":"u","slug":"python-data-analyst","name":"Python data analyst","description":"Explores datasets with pandas.","avatarIcon":"bot","systemPrompt":"You are a careful analyst.","starterPrompts":["Analyze this dataset","Plot the trend"],"preferredModelId":"anthropic:claude-opus-4-8","isPinned":false,"version":3,"createdAt":"2026-09-01T10:00:00Z","updatedAt":"2026-09-10T10:00:00Z","somethingNew":true},
  {"id":"a2","name":"Essay coach","description":"Tightens arguments in student essays.","systemPrompt":"Coach.","starterPrompts":[],"isPinned":true,"version":1},
  {"name":"No id"}
]}
"""#
