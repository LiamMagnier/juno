import Foundation
import Testing
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeUI

/// `.claude/agents/*.md` and `.juno/agents/*.md`, read through the workspace
/// gateway, with the Juno file winning a name collision.
struct CustomAgentDiscoveryTests {
    private func makeWorkspace() throws -> (URL, WorkspaceAccess) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-agents-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let access = try WorkspaceAccess(
            workspaceID: WorkspaceID(value: "ws"),
            bookmarkData: WorkspaceAccess.makeBookmark(for: root)
        )
        return (root, access)
    }

    private func write(_ relative: String, _ contents: String, in root: URL) throws {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try contents.write(to: url, atomically: true, encoding: .utf8)
    }

    @Test
    func parsesFrontmatterAndBody() {
        let agent = CustomAgentDiscovery.parse(
            stem: "reviewer",
            contents: """
            ---
            name: Careful Reviewer
            description: Reviews for correctness first.
            tools: Read, Grep
            ---
            You are a meticulous reviewer. Quote the lines you mean.
            """,
            source: .claude,
            path: ".claude/agents/reviewer.md"
        )
        #expect(agent?.id == "claude:reviewer")
        #expect(agent?.name == "Careful Reviewer")
        #expect(agent?.description == "Reviews for correctness first.")
        #expect(agent?.instructions.hasPrefix("You are a meticulous reviewer.") == true)
    }

    @Test
    func aFileWithNoBodyIsNotAnAgent() {
        #expect(CustomAgentDiscovery.parse(stem: "empty", contents: "---\nname: x\n---\n\n", source: .juno, path: "p") == nil)
        #expect(!CustomAgentDiscovery.isSafeName("../escape"))
        #expect(CustomAgentDiscovery.isSafeName("data-migrator_2"))
    }

    @Test
    func discoversBothDirectoriesAndLetsJunoWin() throws {
        let (root, access) = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: root) }
        try write(".claude/agents/reviewer.md", "---\nname: Reviewer\n---\nClaude's reviewer.", in: root)
        try write(".claude/agents/planner.md", "Plan things.", in: root)
        try write(".juno/agents/reviewer.md", "---\nname: Reviewer\n---\nJuno's reviewer.", in: root)
        try write(".juno/agents/notes.txt", "not an agent", in: root)

        let agents = CustomAgentDiscovery(access: access).discover()
        #expect(agents.map(\.name) == ["planner", "Reviewer"])
        let reviewer = agents.first { $0.name == "Reviewer" }
        #expect(reviewer?.source == .juno)
        #expect(reviewer?.instructions == "Juno's reviewer.")

        let options = AgentRoleOption.options(custom: agents)
        #expect(options.count == AgentRole.allCases.count + 2)
        #expect(options.first?.label == "Engineer")
    }
}
