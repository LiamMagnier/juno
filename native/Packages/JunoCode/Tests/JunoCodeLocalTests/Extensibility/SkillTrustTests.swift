import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// Repository skills are untrusted until the reader trusts them as they read
/// now; identifiers follow the file's place, trust follows its content.
final class SkillTrustTests: XCTestCase {
    private var root: URL!
    private var workspaceURL: URL!
    private var access: WorkspaceAccess!
    private var policy: SkillPolicyStore!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-skill-trust-\(UUID().uuidString)")
        workspaceURL = root.appendingPathComponent("workspace")
        try write("""
            ---
            name: deploy
            description: "Ship to staging with the release checklist"
            ---
            # Deploy

            1. Run the checklist.
            """, to: ".claude/skills/deploy/SKILL.md")
        try write("Review pull requests for missing tests.\n", to: ".juno/skills/review/SKILL.md")
        access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        policy = SkillPolicyStore(storageRoot: root.appendingPathComponent("storage"), workspaceID: access.workspaceID)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func write(_ text: String, to path: String) throws {
        let url = workspaceURL.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func skill(_ name: String) throws -> SkillDefinition {
        try XCTUnwrap(SkillDiscovery(access: access).discover().skills.first { $0.name == name })
    }

    func testFrontMatterGivesTheDescriptionAndIsNotPartOfTheBody() throws {
        let deploy = try skill("deploy")
        XCTAssertEqual(deploy.description, "Ship to staging with the release checklist")
        XCTAssertEqual(deploy.instructions, "# Deploy\n\n1. Run the checklist.")
        XCTAssertEqual(try skill("review").description, "Review pull requests for missing tests.")
    }

    func testAnEditKeepsTheIdentifierButNotTheTrust() throws {
        let before = try skill("deploy")
        XCTAssertEqual(before.id, SkillDefinition.identifier(source: .claude, path: ".claude/skills/deploy/SKILL.md"))
        XCTAssertEqual(policy.state(of: before), .untrusted, "a repository skill starts untrusted")

        try policy.setTrusted(before, trusted: true)
        XCTAssertEqual(policy.state(of: before), .trusted)

        try write("---\ndescription: Ship\n---\nNow also push to production.\n", to: ".claude/skills/deploy/SKILL.md")
        let after = try skill("deploy")
        XCTAssertEqual(after.id, before.id, "a switched-off skill stays switched off when edited")
        XCTAssertNotEqual(after.contentDigest, before.contentDigest)
        XCTAssertEqual(policy.state(of: after), .changedSinceTrusted)

        try policy.setTrusted(after, trusted: false)
        XCTAssertEqual(policy.state(of: after), .untrusted)
    }

    func testOnlyTrustedEnabledSkillsAreOfferedAndLoaded() async throws {
        let deploy = try skill("deploy")
        let review = try skill("review")
        try policy.setTrusted(deploy, trusted: true)
        try policy.setTrusted(review, trusted: true)

        let provider = WorkspaceSkillProvider(access: access, policy: policy, disabledIDs: [review.id])
        let offered = await provider.availableSkills()
        XCTAssertEqual(offered.map(\.name), ["deploy"])
        XCTAssertEqual(offered.first?.description, "Ship to staging with the release checklist")

        let loaded = try await provider.loadSkill(named: "Deploy")
        XCTAssertEqual(loaded.body, "# Deploy\n\n1. Run the checklist.")

        do {
            _ = try await provider.loadSkill(named: "review")
            XCTFail("a switched-off skill is not loadable")
        } catch let error as SkillLoadError {
            guard case .unknown = error else { return XCTFail("\(error)") }
        }

        try write("Tampered.\n", to: ".claude/skills/deploy/SKILL.md")
        do {
            _ = try await provider.loadSkill(named: "deploy")
            XCTFail("an edited skill needs trusting again")
        } catch let error as SkillLoadError {
            XCTAssertEqual(error, .changedSinceTrusted(name: "deploy"))
        }
        let afterEdit = await provider.availableSkills()
        XCTAssertTrue(afterEdit.isEmpty)
    }

    func testTheTrustStoreLivesOutsideTheRepository() throws {
        try policy.setTrusted(try skill("deploy"), trusted: true)
        let inRepository = try FileManager.default.subpathsOfDirectory(atPath: workspaceURL.path)
        XCTAssertFalse(inRepository.contains { $0.contains("skill-policies") })
        XCTAssertNotEqual(policy.fingerprint(), SkillPolicyStore(
            storageRoot: root.appendingPathComponent("other"), workspaceID: access.workspaceID
        ).fingerprint())
    }
}
