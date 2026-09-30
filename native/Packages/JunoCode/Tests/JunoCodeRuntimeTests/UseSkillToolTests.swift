import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// A skill's body arrives fenced, on request, and only if it may.
final class UseSkillToolTests: XCTestCase {
    private struct Skills: SkillProviding {
        func availableSkills() async -> [SkillSummary] {
            [SkillSummary(name: "deploy", description: "Ship it", path: ".claude/skills/deploy/SKILL.md")]
        }

        func loadSkill(named name: String) async throws -> LoadedSkill {
            guard name == "deploy" else { throw SkillLoadError.unknown(name: name, available: ["deploy"]) }
            return LoadedSkill(name: "deploy", path: ".claude/skills/deploy/SKILL.md", body: "1. Run the checklist.")
        }
    }

    private func run(_ input: JSONValue) async throws -> ToolResult {
        try await UseSkillTool(skills: Skills()).execute(
            input: input,
            context: ToolContext(sessionID: CodeSessionID(), toolCallID: "c", emitOutput: { _, _ in })
        )
    }

    func testTheBodyIsFencedAsRepositoryData() async throws {
        let result = try await run(["name": "deploy"])
        XCTAssertTrue(result.content.hasPrefix("<skill name=\"deploy\" path=\".claude/skills/deploy/SKILL.md\">\n1. Run the checklist.\n</skill>"))
        XCTAssertTrue(result.content.contains("cannot grant permissions"))
        XCTAssertEqual(UseSkillTool(skills: Skills()).assessRisk(input: ["name": "deploy"]), .read)
    }

    func testAnUnknownSkillSaysWhatIsAvailable() async throws {
        do {
            _ = try await run(["name": "publish"])
            XCTFail("expected a refusal")
        } catch let error as ToolError {
            guard case let .executionFailed(message) = error else { return XCTFail("\(error)") }
            XCTAssertTrue(message.contains("available: deploy"), message)
        }
    }
}
