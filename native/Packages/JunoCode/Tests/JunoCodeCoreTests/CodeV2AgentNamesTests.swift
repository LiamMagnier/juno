import XCTest
@testable import JunoCodeCore

/// Agents are named for their work, never "Worker 2". The web twin's suite
/// (tests/code-v2-agent-names.test.ts) reads the same fixture, so both sides
/// give every agent the same name.
final class CodeV2AgentNamesTests: XCTestCase {
    private var repository: URL {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }
        return root
    }

    private func fixture() throws -> [String: Any] {
        let data = try Data(contentsOf: repository.appendingPathComponent("contracts/code/agent-names.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testNamesMatchTheSharedFixture() throws {
        let cases = try XCTUnwrap(try fixture()["cases"] as? [[Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 20)
        for entry in cases {
            let text: (Any) -> String? = { $0 as? String }
            let role = try XCTUnwrap(CodeV2.AgentRole(rawValue: try XCTUnwrap(entry[3] as? String)))
            let source = CodeV2AgentNames.Source(id: "a", label: text(entry[0]), title: text(entry[1]), task: text(entry[2]), role: role)
            XCTAssertEqual(CodeV2AgentNames.displayName(source), entry[4] as? String, "\(entry)")
        }
    }

    func testRepeatsAreToldApartAfterTheFirst() throws {
        let repeats = try XCTUnwrap(try fixture()["repeats"] as? [String: [String]])
        let tasks = try XCTUnwrap(repeats["tasks"])
        let sources = tasks.enumerated().map { CodeV2AgentNames.Source(id: "a\($0.offset)", task: $0.element, role: .worker) }
        let names = CodeV2AgentNames.displayNames(sources)
        XCTAssertEqual(sources.map { names[$0.id] ?? "" }, repeats["names"])
    }

    func testOnlyARoleWordAndANumberIsGeneric() {
        for generic in ["Worker 1", "worker", "Builder 12", "Agent #3", "Subagent 2", "Explorer", ""] {
            XCTAssertTrue(CodeV2AgentNames.isGenericLabel(generic), generic)
        }
        XCTAssertTrue(CodeV2AgentNames.isGenericLabel(nil))
        for kept in ["Hook audit", "Candidate B", "Architect", "Verifier", "Reviewer", "Worker bee"] {
            XCTAssertFalse(CodeV2AgentNames.isGenericLabel(kept), kept)
        }
    }

    func testVerbsAreReadInAnyForm() {
        XCTAssertEqual(CodeV2AgentNames.verbBase("redesigning"), "redesign")
        XCTAssertEqual(CodeV2AgentNames.verbBase("checks"), "check")
        XCTAssertEqual(CodeV2AgentNames.verbBase("mapped"), "map")
        XCTAssertEqual(CodeV2AgentNames.verbBase("writing"), "write")
        XCTAssertNil(CodeV2AgentNames.verbBase("server"))
    }
}
