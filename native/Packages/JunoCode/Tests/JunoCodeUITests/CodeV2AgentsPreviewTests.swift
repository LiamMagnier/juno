import Foundation
import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeUI

/// The Agents panel from a subscription runtime's own subagents (Claude's
/// Agent tool), its empty state per team, and the Preview an agent opens.
@MainActor
final class CodeV2AgentsPreviewTests: XCTestCase {
    /// Items exactly as the env server writes them for Claude's Agent tool
    /// (claude-agent.ts `toolItem` + the child's attributed messages).
    private static let claudeWire = """
    [
      {"id":"u1","kind":"user_message","turnId":"t1","createdAt":"2026-10-11T10:00:00.000Z","text":"Code the best looking portfolio using subagents"},
      {"id":"tool_1","kind":"subagent","turnId":"t1","createdAt":"2026-10-11T10:00:05.000Z","agentId":"toolu_hero","role":"worker",
       "model":{"instanceId":"claude-agent:default","model":"inherit"},"status":"running","title":"Build the hero section",
       "task":"Write portfolio/index.html's hero.","liveLine":"Using Write"},
      {"id":"msg_c1","kind":"assistant_message","turnId":"t1","createdAt":"2026-10-11T10:00:20.000Z","agentId":"toolu_hero","text":"Hero written.","streaming":false},
      {"id":"tool_2","kind":"subagent","turnId":"t1","createdAt":"2026-10-11T10:00:06.000Z","agentId":"toolu_work","role":"worker",
       "model":{"instanceId":"claude-agent:default","model":"inherit"},"status":"completed","title":"Build the work grid",
       "task":"Write the projects grid.","closingText":"Grid done."},
      {"id":"msg_lead","kind":"assistant_message","turnId":"t1","createdAt":"2026-10-11T10:01:00.000Z","text":"Both parts are in.","streaming":false}
    ]
    """

    private func items(_ json: String) throws -> [CodeV2.TurnItem] {
        try JSONDecoder().decode([CodeV2.TurnItem].self, from: Data(json.utf8))
    }

    func testClaudeAgentToolSubagentsFillTheAgentsPanel() throws {
        let items = try items(Self.claudeWire)
        var ordinal = 0
        let nodes: [CodeV2AgentNode] = items.compactMap { item in
            guard case let .subagent(child) = item else { return nil }
            ordinal += 1
            return CodeV2AgentNode(subagent: child, items: items, now: Date(timeIntervalSince1970: 1_791_712_900), ordinal: ordinal)
        }
        XCTAssertEqual(nodes.map(\.agentId), ["toolu_hero", "toolu_work"])
        XCTAssertEqual(nodes.map(\.roleLabel), ["Worker 1", "Worker 2"])
        XCTAssertEqual(nodes[0].status, .running)
        XCTAssertEqual(nodes[0].title, "Build the hero section")
        XCTAssertEqual(nodes[0].steps.count, 1, "the child's own message is its trace")
        XCTAssertEqual(nodes[1].liveLine, "Grid done.")
        XCTAssertEqual(CodeV2AgentCopy.headline(nodes), "2 workers")
        // The lead's answer stays the lead's; the child's narration is not in its work log.
        let turn = try XCTUnwrap(CodeV2TurnFolding.turns(from: items, activeTurnId: "t1").first)
        XCTAssertEqual(turn.subagents.count, 2)
        XCTAssertEqual(turn.answer?.text, "Both parts are in.")
        XCTAssertFalse(turn.steps.contains { $0.id == "msg_c1" })
    }

    func testTheEmptyStateSaysWhetherTheTeamIsOn() {
        XCTAssertTrue(CodeV2AgentCopy.empty(team: .planBuildVerify).hasPrefix("Team is on."))
        XCTAssertTrue(CodeV2AgentCopy.empty(team: .leadWorkers).hasPrefix("Team is on."))
        XCTAssertTrue(CodeV2AgentCopy.empty(team: .bestOfN).hasPrefix("Best of N is on."))
        for team in [nil, CodeV2.RolePreset.solo] {
            let copy = CodeV2AgentCopy.empty(team: team)
            XCTAssertTrue(copy.contains("Ask for subagents"))
            XCTAssertFalse(copy.contains("+ menu"), "Team lives in the composer, not the + menu")
        }
        for team in [nil] + CodeV2.RolePreset.allCases.map(Optional.some) {
            XCTAssertFalse(CodeV2AgentCopy.empty(team: team).contains("\u{2014}"), "no em dashes in UI copy")
        }
        XCTAssertEqual(CodeV2Team.Preset.solo.shortTitle, "Solo", "the Team chip at rest names the state")
    }

    func testAnAgentsPreviewNoticeBecomesARequest() throws {
        let wire = """
        [{"id":"pv_1","kind":"system_notice","turnId":"t1","createdAt":"2026-10-11T10:02:00.000Z","level":"info",
          "text":"Opened the preview at http://127.0.0.1:53111/","code":"preview_opened",
          "url":"http://127.0.0.1:53111/","path":"/Users/me/Desktop/test/portfolio"},
         {"id":"n2","kind":"system_notice","createdAt":"2026-10-11T10:02:01.000Z","level":"info","text":"Used x","code":"mcp_tool"}]
        """
        let requests = CodeV2PreviewRequest.all(in: try items(wire))
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.url?.port, 53111)
        XCTAssertEqual(requests.first?.folder?.lastPathComponent, "portfolio")
    }

    func testTheAgentsPreviewServesAStaticFolderWithoutACard() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("alevr-agent-preview-\(UUID().uuidString)", isDirectory: true)
        let site = root.appendingPathComponent("portfolio", isDirectory: true)
        try FileManager.default.createDirectory(at: site, withIntermediateDirectories: true)
        try "<h1>hi</h1>".write(to: site.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: root) }

        let configuration = try XCTUnwrap(PreviewLeaseModel.agentConfiguration(url: nil, folder: site, workspaceRoot: root))
        XCTAssertEqual(configuration.name, "portfolio")
        XCTAssertTrue(configuration.isStatic)
        XCTAssertEqual(configuration.workingDirectoryDisplay, "portfolio")
        let lease = PreviewLeaseModel()
        lease.bind(sessionID: nil, workspaceRoot: root)
        XCTAssertFalse(lease.needsApproval(configuration), "Alevr's static server asks nothing")

        XCTAssertEqual(PreviewLeaseModel.agentConfiguration(url: nil, folder: root, workspaceRoot: root)?.name, "static")
        XCTAssertNil(PreviewLeaseModel.agentConfiguration(url: nil, folder: URL(fileURLWithPath: "/etc"), workspaceRoot: root))
        let attach = try XCTUnwrap(PreviewLeaseModel.agentConfiguration(url: URL(string: "http://localhost:5173/"), folder: nil, workspaceRoot: root))
        XCTAssertTrue(attach.isAttach)
        XCTAssertNil(PreviewLeaseModel.agentConfiguration(url: URL(string: "https://example.com:443/"), folder: nil, workspaceRoot: root))
    }
}
