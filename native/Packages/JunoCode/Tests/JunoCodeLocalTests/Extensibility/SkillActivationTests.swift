import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class SkillActivationTests: XCTestCase {
    func testDiscoversPortableSkillsWithJunoPrecedence() throws {
        let root = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: root) }

        let claudeSkill = root.appendingPathComponent(".claude/skills/review", isDirectory: true)
        let junoSkill = root.appendingPathComponent(".juno/skills/review", isDirectory: true)
        let uniqueSkill = root.appendingPathComponent(".claude/skills/release", isDirectory: true)
        try FileManager.default.createDirectory(at: claudeSkill, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: junoSkill, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: uniqueSkill, withIntermediateDirectories: true)
        try "claude instructions".write(
            to: claudeSkill.appendingPathComponent("SKILL.md"),
            atomically: true,
            encoding: .utf8
        )
        try "juno instructions".write(
            to: junoSkill.appendingPathComponent("SKILL.md"),
            atomically: true,
            encoding: .utf8
        )
        try "release instructions".write(
            to: uniqueSkill.appendingPathComponent("SKILL.md"),
            atomically: true,
            encoding: .utf8
        )

        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: root)
        let result = SkillDiscovery(access: access).discover()
        XCTAssertEqual(result.skills.map(\.name), ["release", "review"])
        XCTAssertEqual(result.skills.first { $0.name == "review" }?.instructions, "juno instructions")
        XCTAssertTrue(result.diagnostics.isEmpty)
    }

    func testSkillActivationRequiresAllowlistAndExplicitTrust() {
        let skill = SkillDefinition(
            name: "review",
            instructions: "inspect the diff",
            source: .claude,
            path: ".claude/skills/review/SKILL.md"
        )

        guard case let .denied(reason) = SkillActivationPolicy.denyAll.activate(skill) else {
            return XCTFail("default skill policy must deny activation")
        }
        XCTAssertTrue(reason.contains("allowlisted"))

        let allowlisted = SkillActivationPolicy(allowedSkillIDs: [skill.id])
        guard case let .denied(reason) = allowlisted.activate(skill) else {
            return XCTFail("allowlisting alone must not trust repository instructions")
        }
        XCTAssertTrue(reason.contains("untrusted"))

        let explicitlyTrusted = SkillActivationPolicy(
            allowedSkillIDs: [skill.id],
            allowUntrustedSkills: true
        )
        guard case let .activated(activated) = explicitlyTrusted.activate(skill) else {
            return XCTFail("explicitly allowlisted and trusted skill should activate")
        }
        XCTAssertEqual(activated.instructions, "inspect the diff")
    }

    func testSkillDiscoveryIgnoresPathEscapesAndDoesNotLoadSiblingFiles() throws {
        let root = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: root) }
        let outside = root.deletingLastPathComponent()
            .appendingPathComponent("juno-skill-outside-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outside) }

        let skills = root.appendingPathComponent(".juno/skills", isDirectory: true)
        try FileManager.default.createDirectory(at: skills, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: skills.appendingPathComponent("escape"),
            withDestinationURL: outside
        )
        try "not a skill".write(
            to: outside.appendingPathComponent("SKILL.md"),
            atomically: true,
            encoding: .utf8
        )

        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: root)
        let result = SkillDiscovery(access: access).discover()
        XCTAssertTrue(result.skills.isEmpty)
    }

    private func makeWorkspace() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-skill-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}
