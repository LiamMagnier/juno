import Foundation
import XCTest
@testable import JunoCodeCore

/// Decodes every shared fixture in contracts/code/fixtures with the Swift
/// mirror, so a field the Mac cannot read fails here rather than in a session.
final class CodeV2ContractsTests: XCTestCase {
    private func fixtureURL(_ name: String) -> URL {
        var root = URL(fileURLWithPath: #filePath)
        // Tests/JunoCodeCoreTests/<file> → Tests → JunoCode → Packages → native → repository.
        for _ in 0..<6 { root.deleteLastPathComponent() }
        return root.appendingPathComponent("contracts/code/fixtures/\(name)")
    }

    private struct Fixture<Case: Decodable>: Decodable {
        var cases: [Case]
        var aliases: [String: String]?
    }

    private func load<Case: Decodable>(_ name: String, as _: Case.Type) throws -> Fixture<Case> {
        try JSONDecoder().decode(Fixture<Case>.self, from: Data(contentsOf: fixtureURL(name)))
    }

    func testProviderInstancesDecode() throws {
        let instances = try load("provider-instances.json", as: CodeV2.ProviderInstance.self).cases
        XCTAssertEqual(Set(instances.map(\.kind)), Set(CodeV2.ProviderKind.allCases))
        let claude = try XCTUnwrap(instances.first { $0.kind == .claudeAgent })
        XCTAssertEqual(claude.label, "Claude (your subscription)")
        XCTAssertEqual(claude.limits?.first?.id, "five_hour")
        XCTAssertEqual(claude.capabilities?.approvals.contains(.autoEdit), true)
        let alevr = try XCTUnwrap(instances.first { $0.kind == .alevr })
        XCTAssertEqual(alevr.models?.first?.contextTiers?.count, 2)
        XCTAssertEqual(instances.first { $0.id == "acp:gemini" }?.acpCommand, ["gemini", "--experimental-acp"])
        XCTAssertTrue(instances.contains { $0.status == .notInstalled })
    }

    func testRoleRoutingDecodes() throws {
        let routings = try load("role-routing.json", as: CodeV2.RoleRouting.self).cases
        XCTAssertEqual(routings.map(\.preset), [.solo, .leadWorkers, .bestOfN, .planBuildVerify])
        XCTAssertEqual(routings[1].budget?.maxUsd, 12.5)
        XCTAssertEqual(routings[2].workers?.count, 3)
        // The team lane's Architect survives a decode and a re-encode.
        let team = routings[3]
        XCTAssertEqual(team.architect?.instanceId, "claude-agent:default")
        XCTAssertEqual(team.workers?.count, 2)
        XCTAssertEqual(team.reviewer?.model, "gpt-6.1-sol")
        XCTAssertEqual(try JSONDecoder().decode(CodeV2.RoleRouting.self, from: JSONEncoder().encode(team)), team)
    }

    func testEveryTurnItemKindDecodesAndRoundTrips() throws {
        let items = try load("turn-items.json", as: CodeV2.TurnItem.self).cases
        let kinds = Set(items.map(\.rawKind))
        XCTAssertEqual(kinds, Set(CodeV2.TurnItemKind.allCases.map(\.rawValue)))
        for item in items {
            let again = try JSONDecoder().decode(CodeV2.TurnItem.self, from: JSONEncoder().encode(item))
            XCTAssertEqual(again, item, item.id)
        }
        guard case let .subagent(child) = items.first(where: { $0.rawKind == "subagent" }) else {
            return XCTFail("no subagent item")
        }
        XCTAssertEqual(child.role, .explorer)
        XCTAssertEqual(child.closingText, "7 callers, all in tests/e2e.")
        let architect = items.compactMap { item -> CodeV2.Subagent? in
            if case let .subagent(agent) = item, agent.role == .architect { return agent }
            return nil
        }.first
        XCTAssertEqual(architect?.phase, .plan)
    }

    func testUnknownTurnItemKindIsKeptNotFatal() throws {
        let json = Data(#"{"id":"x","kind":"hologram","createdAt":"2026-10-08T00:00:00Z"}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(CodeV2.TurnItem.self, from: json), .unknown(kind: "hologram", id: "x"))
    }

    func testClientCommandsDecode() throws {
        let commands = try load("client-commands.json", as: CodeV2.ClientCommand.self).cases
        XCTAssertEqual(Set(commands.map(\.type)), Set(CodeV2.ClientCommandType.allCases))
        let start = try XCTUnwrap(commands.first { $0.type == .turnStart })
        XCTAssertEqual(start.params["runtimeMode"]?.stringValue, "auto-edit")
    }

    func testServerMessagesDecodeAndFollowTheCursorRule() throws {
        let messages = try load("server-messages.json", as: CodeV2.ServerMessage.self).cases
        var cursor: Int?
        var types = Set<String>()
        var responses = 0
        for message in messages {
            switch message {
            case .response: responses += 1
            case let .event(envelope):
                types.insert(envelope.event.type)
                guard envelope.stream == .session else { continue }
                XCTAssertEqual(CodeV2.classify(cursor: cursor, sequence: envelope.sequence, event: envelope.event), .apply)
                cursor = envelope.sequence
            case .unknown: XCTFail("unknown message")
            }
        }
        XCTAssertEqual(responses, 2)
        XCTAssertEqual(types, Set(CodeV2.ServerEventType.allCases.map(\.rawValue)))
        XCTAssertEqual(cursor, 50)
        let snapshot = CodeV2.ServerEvent.sessionSnapshot(
            snapshotSequence: 40,
            session: CodeV2.SessionSnapshot(id: "s1", cwd: "/repo", selection: CodeV2.ModelSelection(instanceId: "alevr", model: "m"))
        )
        XCTAssertEqual(CodeV2.classify(cursor: 48, sequence: 40, event: snapshot), .duplicate)
        XCTAssertEqual(CodeV2.classify(cursor: 40, sequence: 40, event: snapshot), .apply)
        XCTAssertEqual(CodeV2.classify(cursor: nil, sequence: 40, event: snapshot), .apply)
        let delta = CodeV2.ServerEvent.itemDelta(itemId: "i", field: "text", append: "x")
        XCTAssertEqual(CodeV2.classify(cursor: 48, sequence: 48, event: delta), .duplicate)
        XCTAssertEqual(CodeV2.classify(cursor: 48, sequence: 50, event: delta), .gap)
        XCTAssertEqual(CodeV2.classify(cursor: nil, sequence: 1, event: delta), .gap)
    }

    func testSnapshotCarriesItemsAndQueue() throws {
        let messages = try load("server-messages.json", as: CodeV2.ServerMessage.self).cases
        guard case let .event(envelope) = messages[2],
              case let .sessionSnapshot(sequence, session) = envelope.event
        else { return XCTFail("third message is not a snapshot") }
        XCTAssertEqual(sequence, envelope.sequence)
        XCTAssertEqual(session.state, .running)
        XCTAssertEqual(session.items.count, 1)
        XCTAssertEqual(session.queue.first?.input.text, "Then open a PR")
        let again = try JSONDecoder().decode(CodeV2.ServerEvent.self, from: JSONEncoder().encode(envelope.event))
        XCTAssertEqual(again, envelope.event)
    }

    func testAliasTableMatchesTheSharedFixture() throws {
        let fixture = try load("model-aliases.json", as: CodeV2.ModelSelection.self)
        XCTAssertEqual(fixture.aliases, CodeV2.modelAliases)
        XCTAssertEqual(CodeV2.resolveModelAlias(" Sonnet "), "anthropic:claude-sonnet-5-5")
        XCTAssertEqual(CodeV2.resolveModelAlias("pro"), "anthropic:claude-sonnet-5-5")
        XCTAssertEqual(CodeV2.resolveModelAlias("max"), "anthropic:claude-opus-5-5")
        XCTAssertEqual(CodeV2.resolveModelAlias("openai:gpt-6.1-sol"), "openai:gpt-6.1-sol")
    }
}
