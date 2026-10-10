import Foundation
import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeUI

/// The composer's skills (skills lane): grouping, search, a typed `/name`,
/// the per-thread selection that persists, a `/name` that applies once, and
/// the Swift engine taking the thread's skills in its session state and a
/// `/name` one ahead of the message.
@MainActor
final class CodeSkillsModelTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "code-skills-tests-\(UUID().uuidString)"

    override func setUp() async throws {
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    private func model(thread: String? = "t1") async -> CodeSkillsModel {
        let model = CodeSkillsModel(threadKey: thread, defaults: defaults)
        model.configure(
            listLocal: {
                [
                    .init(name: "repo-rules", description: "The repo's rules", source: .project, origin: .alevr, path: "/p/.alevr/skills/repo-rules/SKILL.md"),
                    .init(name: "design-taste-frontend", description: "Anti-slop frontend", source: .user, origin: .claude, path: "/h/.claude/skills/design-taste-frontend/SKILL.md"),
                    .init(name: "impeccable", description: "Design and polish", source: .plugin, origin: .claude, path: "/h/p/SKILL.md", plugin: "impeccable"),
                ]
            },
            account: CodeAccountSkills(
                list: { [CodeAccountSkill(id: "sk_1", slug: "tidy-commits", name: "Tidy commits", description: "Squash fixups")] },
                instructions: { id in id == "sk_1" ? "TIDY BODY" : nil }
            )
        )
        await model.refresh()
        return model
    }

    func testGroupsYoursThenThisMacThenProject() async {
        let skills = await model()
        XCTAssertEqual(skills.choices.map(\.name), ["tidy-commits", "design-taste-frontend", "impeccable", "repo-rules"])
        XCTAssertEqual(skills.choices.map(\.group), [.yours, .mac, .mac, .project])
        XCTAssertEqual(skills.choices[1].originLabel, "Claude Code")
        XCTAssertEqual(skills.choices[2].originLabel, "impeccable plugin")
        XCTAssertEqual(skills.matches("des").first?.name, "design-taste-frontend", "a name that starts with it first")
        XCTAssertEqual(skills.matches("polish").map(\.name), ["impeccable"], "descriptions are searched")
    }

    func testSlashNameArmsASkillForOneMessage() async {
        let skills = await model()
        XCTAssertNil(skills.invocation(in: "/Users/liam/notes"), "a path is not a skill")
        let typed = skills.invocation(in: "/design-taste-frontend make the hero calmer")
        XCTAssertEqual(typed?.choice.name, "design-taste-frontend")
        XCTAssertEqual(typed?.remainder, "make the hero calmer")

        skills.arm(typed!.choice)
        XCTAssertEqual(skills.chipTitle, "/design-taste-frontend")
        let first = await skills.takeActivations()
        XCTAssertEqual(first.map(\.name), ["design-taste-frontend"])
        XCTAssertEqual(first.first?.once, true)
        XCTAssertEqual(first.first?.path, "/h/.claude/skills/design-taste-frontend/SKILL.md")
        let second = await skills.takeActivations()
        XCTAssertTrue(second.isEmpty, "a /name skill is the next message only")
    }

    func testThreadSelectionPersistsAndCarriesAccountInstructions() async {
        let skills = await model(thread: "thread-a")
        skills.toggle(skills.choices.first { $0.name == "tidy-commits" }!)
        skills.toggle(skills.choices.first { $0.name == "impeccable" }!)
        XCTAssertEqual(skills.chipTitle, "2 skills")
        let sent = await skills.takeActivations()
        XCTAssertEqual(sent.map(\.name), ["tidy-commits", "impeccable"])
        XCTAssertEqual(sent.first?.instructions, "TIDY BODY")
        XCTAssertEqual(sent.first?.source, .account)
        XCTAssertNil(sent.first?.once)
        let again = await skills.takeActivations()
        XCTAssertEqual(again.count, 2, "the thread keeps them")

        let reopened = CodeSkillsModel(threadKey: "thread-a", defaults: defaults)
        XCTAssertEqual(reopened.selectedIDs, ["account:tidy-commits", "plugin:impeccable"])
        let other = CodeSkillsModel(threadKey: "thread-b", defaults: defaults)
        XCTAssertTrue(other.selectedIDs.isEmpty, "per thread")

        // A thread chosen on another device: the env server's snapshot.
        let fromSnapshot = CodeSkillsModel(defaults: defaults)
        fromSnapshot.bind(threadKey: "thread-c", snapshot: [.init(name: "repo-rules", source: .project), .init(name: "x", source: .user, once: true)])
        XCTAssertEqual(fromSnapshot.selectedIDs, ["project:repo-rules"])

        CodeSkillsModel.remember([.init(name: "impeccable", source: .plugin)], thread: "thread-d", defaults: defaults)
        XCTAssertEqual(CodeSkillsModel(threadKey: "thread-d", defaults: defaults).selectedIDs, ["plugin:impeccable"])

        skills.clear()
        XCTAssertEqual(CodeSkillsModel(threadKey: "thread-a", defaults: defaults).selectedIDs, [])
    }

    func testSwiftEngineCarriesSelectedSkillsInSessionStateAndOnceAheadOfTheMessage() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("skills-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let dir = home.appendingPathComponent(".claude/skills/design-taste-frontend", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "---\nname: design-taste-frontend\ndescription: d\n---\nTASTE BODY".write(to: dir.appendingPathComponent("SKILL.md"), atomically: true, encoding: .utf8)

        let controller = SessionController(previewFixture: CodePreviewData.fixture(for: .transcript))
        controller.skillDiscovery = { root in LocalSkillDiscovery(home: home, projectRoot: root) }
        XCTAssertNil(controller.selectedSkillsStateSection(), "nothing selected, nothing sent")

        controller.selectedSkills = [.init(name: "design-taste-frontend", source: .user)]
        let section = try XCTUnwrap(controller.selectedSkillsStateSection())
        XCTAssertEqual(section.name, "selected_skills")
        XCTAssertTrue(section.body.contains("TASTE BODY"))

        controller.selectedSkills = [.init(name: "gone", source: .user)]
        XCTAssertTrue(controller.renderedSkills(controller.selectedSkills).contains("could not be found"))
        let once = controller.renderedSkills([.init(name: "tidy", source: .account, instructions: "ACCOUNT BODY", once: true)])
        XCTAssertTrue(once.contains("<skill name=\"tidy\">\nACCOUNT BODY"))
    }

    // MARK: Live selection

    func testAnotherDevicesSelectionIsAppliedAsItLands() async {
        let skills = await model()
        var sent: [[CodeV2.SkillActivation]] = []
        skills.onSelectionChange = { sent.append($0) }
        skills.applyRemote([.init(name: "repo-rules", source: .project, path: nil, instructions: nil, title: nil, once: nil)])
        XCTAssertEqual(skills.selectedIDs, ["project:repo-rules"])
        XCTAssertEqual(defaults.stringArray(forKey: CodeSkillsModel.storageKey("t1")), ["project:repo-rules"], "kept for the thread")
        // Cleared elsewhere.
        skills.applyRemote(nil)
        XCTAssertEqual(skills.selectedIDs, [])
        // An account skill chosen on the web, its text with it, before this Mac's list knows it.
        let fresh = CodeSkillsModel(threadKey: "t2", defaults: defaults)
        fresh.applyRemote([.init(name: "web-only", source: .account, path: nil, instructions: "WEB TEXT", title: "Web only", once: nil)])
        let active = await fresh.takeActivations()
        XCTAssertEqual(active.first?.instructions, "WEB TEXT", "the env server's activation stands in")
        XCTAssertTrue(sent.isEmpty, "applying a remote change sends nothing back")
    }

    func testAChangeHereIsSentAtOnceAndAFirstSightPushesThisMacsChoice() async throws {
        defaults.set(["user:design-taste-frontend"], forKey: CodeSkillsModel.storageKey("t1"))
        let skills = await model()
        let sent = expectation(description: "sent")
        sent.expectedFulfillmentCount = 2
        var selections: [[String]] = []
        skills.onSelectionChange = { selection in
            selections.append(selection.map(\.name))
            sent.fulfill()
        }
        // The env server knows nothing yet; this Mac chose before the session opened.
        skills.applyRemote([])
        XCTAssertEqual(skills.selectedIDs, ["user:design-taste-frontend"], "kept, not cleared")
        let tidy = try XCTUnwrap(skills.choices.first { $0.name == "tidy-commits" })
        skills.toggle(tidy)
        await fulfillment(of: [sent], timeout: 2)
        XCTAssertEqual(selections.first, ["design-taste-frontend"])
        XCTAssertEqual(selections.last, ["design-taste-frontend", "tidy-commits"])
    }
}
