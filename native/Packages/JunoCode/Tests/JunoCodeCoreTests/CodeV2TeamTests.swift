import XCTest
@testable import JunoCodeCore

/// The Team orchestrator's Core half: role mapping onto the routing, the
/// chip's words (shared with the web through one fixture), and persistence.
final class CodeV2TeamTests: XCTestCase {
    private let lead = CodeV2.ModelSelection(instanceId: "alevr", model: "anthropic:claude-sonnet-5-5", effort: .medium)
    private let opus = CodeV2.ModelSelection(instanceId: "alevr", model: "anthropic:claude-opus-5-5", effort: .high)
    private let gpt = CodeV2.ModelSelection(instanceId: "codex:default", model: "gpt-6.1-sol", effort: .high)

    private var repository: URL {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }
        return root
    }

    func testRolesMapOntoTheRouting() {
        var draft = CodeV2RoleDraft(lead: lead)
        XCTAssertNil(draft.teamSummary, "Solo shows nothing extra")
        draft.applyTeamPreset(.planBuildVerify)
        XCTAssertEqual(draft.preset, .planBuildVerify)
        XCTAssertEqual(draft.workerCount, 2, "two builders by default")
        draft.setSelection(opus, for: .architect)
        draft.setSelection(gpt, for: .verifier)
        draft.setSelection(CodeV2.ModelSelection(instanceId: "alevr", model: "google:gemini-3.8-flash"), for: .builder)
        draft.setWorkers(3)
        draft.setEffort(.max, for: .architect)

        let routing = draft.routing
        XCTAssertEqual(routing.preset, .planBuildVerify)
        XCTAssertEqual(routing.orchestrator, lead, "the lead stays the composer's model")
        XCTAssertEqual(routing.architect?.model, opus.model)
        XCTAssertEqual(routing.architect?.effort, .max)
        XCTAssertEqual(routing.workers?.count, 3)
        XCTAssertTrue(routing.workers?.allSatisfy { $0.model == "google:gemini-3.8-flash" } ?? false)
        XCTAssertEqual(routing.reviewer, gpt)
        XCTAssertNil(routing.explorer)
        XCTAssertEqual(routing.budget?.maxUsd, CodeV2RoleDraft.defaultBudgetUsd)

        draft.setSelection(CodeV2.ModelSelection(instanceId: "alevr", model: "anthropic:claude-haiku-4-5"), for: .explorer)
        XCTAssertEqual(draft.routing.explorer?.model, "anthropic:claude-haiku-4-5")
        draft.setSelection(nil, for: .explorer)
        XCTAssertNil(draft.routing.explorer, "the Explorer is optional")

        // A routing read back is the same team.
        let again = CodeV2RoleDraft(routing: routing)
        XCTAssertEqual(again.routing, routing)
        XCTAssertEqual(again.teamPreset, .planBuildVerify)
        XCTAssertEqual(CodeV2Team.Preset(.leadWorkers), .planBuildVerify)

        draft.applyTeamPreset(.solo)
        XCTAssertEqual(draft.preset, .solo)
        XCTAssertNil(draft.teamSummary)
        draft.applyTeamPreset(.bestOfN)
        XCTAssertEqual(draft.preset, .bestOfN)
        XCTAssertGreaterThanOrEqual(draft.candidates.count, 2)

        XCTAssertEqual(CodeV2Team.Role.allCases.map(\.routingKey), ["architect", "workers", "reviewer", "explorer"])
        XCTAssertEqual(CodeV2Team.phase(of: .architect), .plan)
        XCTAssertEqual(CodeV2Team.phase(of: .worker), .build)
        XCTAssertEqual(CodeV2Team.phase(of: .reviewer), .verify)
        XCTAssertNil(CodeV2Team.phase(of: .explorer))
    }

    func testTheChipSaysWhatTheWebSays() throws {
        struct Fixture: Decodable {
            struct Summary: Decodable {
                let routing: CodeV2.RoleRouting
                let max: Int?
                let summary: String?
            }
            let names: [[String]]
            let summaries: [Summary]
        }
        let url = repository.appendingPathComponent("contracts/code/team-summaries.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        for pair in fixture.names {
            XCTAssertEqual(CodeV2Team.shortModelName(pair[0]), pair[1], pair[0])
        }
        for c in fixture.summaries {
            XCTAssertEqual(CodeV2Team.summary(c.routing, maximum: c.max ?? CodeV2Team.summaryMaximum), c.summary)
        }
    }

    func testATeamIsKeptPerThreadWithAProjectDefault() throws {
        let suite = "alevr-team-tests-\(UUID().uuidString)"
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let store = CodeV2TeamStore(suiteName: suite)
        var draft = CodeV2RoleDraft(lead: lead)
        draft.applyTeamPreset(.planBuildVerify)
        draft.setSelection(gpt, for: .verifier)
        let team = draft.routing

        XCTAssertNil(store.load(.init(session: "t1", project: "juno")))
        store.save(team, scope: .init(session: "t1", project: "juno"))
        XCTAssertEqual(store.load(.init(session: "t1", project: "juno")), team)
        XCTAssertEqual(store.load(.init(session: "t2", project: "juno")), team, "a new thread starts from the project's default")
        XCTAssertNil(store.load(.init(session: "t3", project: "elsewhere")))

        var solo = draft
        solo.applyTeamPreset(.solo)
        store.save(solo.routing, scope: .init(session: "t2", project: "juno"))
        XCTAssertEqual(store.load(.init(session: "t1"))?.preset, .planBuildVerify, "t1 keeps its own")
        XCTAssertEqual(store.load(.init(project: "juno"))?.preset, .solo, "the last edit is the project's default")
        XCTAssertTrue(UserDefaults(suiteName: suite)?.string(forKey: CodeV2TeamStore.sessionPrefix + "t1")?.contains("plan-build-verify") ?? false,
                      "stored as the contract's JSON, under the web's keys")
    }
}
