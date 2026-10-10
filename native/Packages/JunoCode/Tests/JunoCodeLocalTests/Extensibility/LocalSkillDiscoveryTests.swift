import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The Mac's skills (skills lane): SKILL.md front matter, the project > user >
/// plugin precedence, enabled Claude Code plugins only, activation by name
/// (a client's path never opens a file), and the watched catalog. The env
/// server's `runner/env-server/test/skills.test.ts` checks the same rules.
final class LocalSkillDiscoveryTests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("skills-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    @discardableResult
    private func skill(_ root: URL, _ folder: String, _ frontMatter: String, _ body: String) throws -> URL {
        let dir = root.appendingPathComponent(folder, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("SKILL.md")
        try "---\n\(frontMatter)\n---\n\n\(body)\n".write(to: file, atomically: true, encoding: .utf8)
        return file
    }

    private func write(_ text: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    /// A home with user, Codex and plugin skills, and a project with its own.
    private func fixture() throws -> (home: URL, project: URL) {
        let home = scratch.appendingPathComponent("home", isDirectory: true)
        let project = scratch.appendingPathComponent("project", isDirectory: true)
        try skill(home.appendingPathComponent(".claude/skills"), "design-taste-frontend", "name: design-taste-frontend\ndescription: Anti-slop frontend.", "USER TASTE BODY")
        try skill(home.appendingPathComponent(".claude/skills"), "shared", "name: shared\ndescription: user copy", "USER SHARED BODY")
        try skill(home.appendingPathComponent(".codex/skills"), "codex-only", "name: codex-only\ndescription: From Codex", "CODEX BODY")
        try skill(project.appendingPathComponent(".claude/skills"), "shared", "name: shared\ndescription: project copy", "PROJECT SHARED BODY")
        try skill(project.appendingPathComponent(".alevr/skills"), "repo-rules", "description: The repo's rules", "REPO RULES BODY")
        let plugin = home.appendingPathComponent(".claude/plugins/cache/mkt/impeccable/4.3.1", isDirectory: true)
        try skill(plugin.appendingPathComponent("skills"), "impeccable", "name: impeccable\ndescription: >\n  Design, critique\n  and polish.", "PLUGIN BODY")
        try skill(plugin.appendingPathComponent("skills"), "shared", "name: shared\ndescription: plugin copy", "PLUGIN SHARED BODY")
        try skill(plugin.appendingPathComponent("extra-skills"), "declared", "name: declared\ndescription: in the manifest", "DECLARED BODY")
        try write(#"{"name":"impeccable","skills":["./extra-skills","../../../escape"]}"#, to: plugin.appendingPathComponent(".claude-plugin/plugin.json"))
        let off = home.appendingPathComponent(".claude/plugins/cache/mkt/disabled/1.0.0", isDirectory: true)
        try skill(off.appendingPathComponent("skills"), "nope", "name: nope\ndescription: off", "OFF BODY")
        try write("""
            {"version":2,"plugins":{
              "impeccable@mkt":[{"installPath":"\(plugin.path)","lastUpdated":"2026-09-21T00:00:00Z"}],
              "disabled@mkt":[{"installPath":"\(off.path)"}]}}
            """, to: home.appendingPathComponent(".claude/plugins/installed_plugins.json"))
        try write(#"{"enabledPlugins":{"impeccable@mkt":true,"disabled@mkt":false}}"#, to: home.appendingPathComponent(".claude/settings.json"))
        return (home, project)
    }

    func testParsesFrontMatterNameDescriptionAndBlockScalars() {
        let plain = LocalSkillDiscovery.parse("---\nname: tidy-commits\ndescription: \"Squash fixups: before a PR\"\n---\n\n# Tidy\nDo it.\n")
        XCTAssertEqual(plain.name, "tidy-commits")
        XCTAssertEqual(plain.description, "Squash fixups: before a PR")
        XCTAssertEqual(plain.body, "# Tidy\nDo it.")

        let folded = LocalSkillDiscovery.parse("---\nname: x\ndescription: >-\n  Line one\n  line two\nallowed-tools: Read\n---\nBody")
        XCTAssertEqual(folded.description, "Line one line two")
        XCTAssertEqual(folded.body, "Body")

        let none = LocalSkillDiscovery.parse("# Heading\n\nFirst prose line.\nMore.")
        XCTAssertNil(none.name)
        XCTAssertEqual(none.description, "First prose line.")

        XCTAssertEqual(LocalSkillDiscovery.skillName(.init(name: "Design Taste", body: ""), folder: "x"), "design-taste")
        XCTAssertEqual(LocalSkillDiscovery.skillName(.init(name: "../evil", body: ""), folder: "good-folder"), "good-folder")
        XCTAssertNil(LocalSkillDiscovery.skillName(.init(name: nil, body: ""), folder: ".hidden"))
    }

    func testProjectBeatsUserBeatsPluginAndOnlyEnabledPluginsCount() throws {
        let (home, project) = try fixture()
        let discovery = LocalSkillDiscovery(home: home, projectRoot: project)
        let list = discovery.discover()
        let by = Dictionary(uniqueKeysWithValues: list.map { ($0.name, $0) })

        XCTAssertEqual(by["shared"]?.source, .project)
        XCTAssertEqual(by["shared"]?.description, "project copy")
        XCTAssertEqual(discovery.discoverAll().filter { $0.name == "shared" }.count, 3, "shadowed copies stay discoverable")
        XCTAssertEqual(by["design-taste-frontend"]?.source, .user)
        XCTAssertEqual(by["design-taste-frontend"]?.origin, .claude)
        XCTAssertEqual(by["codex-only"]?.origin, .codex)
        XCTAssertEqual(by["repo-rules"]?.origin, .alevr)
        XCTAssertEqual(by["impeccable"]?.source, .plugin)
        XCTAssertEqual(by["impeccable"]?.plugin, "impeccable")
        XCTAssertEqual(by["impeccable"]?.description, "Design, critique and polish.")
        XCTAssertNotNil(by["declared"], "a manifest's own folder is read")
        XCTAssertNil(by["nope"], "a plugin switched off in Claude Code is skipped")

        let order: [CodeV2.SkillSource] = [.project, .user, .plugin]
        let ranks = list.map { order.firstIndex(of: $0.source)! }
        XCTAssertEqual(ranks, ranks.sorted(), "nearest tier first")

        let encoded = String(decoding: try JSONEncoder().encode(list), as: UTF8.self)
        XCTAssertFalse(encoded.contains("BODY"), "a summary never carries a body")

        let homeOnly = LocalSkillDiscovery(home: home).discover()
        XCTAssertEqual(homeOnly.first { $0.name == "shared" }?.source, .user)
        XCTAssertFalse(homeOnly.contains { $0.name == "repo-rules" })
    }

    func testActivationResolvesByNameAndNeverOpensAClientsPath() throws {
        let (home, project) = try fixture()
        let discovery = LocalSkillDiscovery(home: home, projectRoot: project)
        let userShared = discovery.discoverAll().first { $0.name == "shared" && $0.source == .user }!
        let resolved = discovery.resolve([
            .init(name: "shared", source: .project, path: "/etc/passwd"),
            .init(name: "shared", source: .user, path: userShared.path),
            .init(name: "ghost", source: .user),
            .init(name: "tidy", source: .account, instructions: "ACCOUNT BODY", once: true),
            .init(name: "empty", source: .account),
        ])
        XCTAssertEqual(resolved.skills.map(\.instructions), ["PROJECT SHARED BODY", "USER SHARED BODY", "ACCOUNT BODY"])
        XCTAssertEqual(resolved.skills.last?.once, true)
        XCTAssertEqual(resolved.missing, ["ghost", "empty"])

        let text = LocalSkillDiscovery.render(resolved.skills)
        XCTAssertTrue(text.contains("<skill name=\"shared\" folder=\""))
        XCTAssertTrue(text.contains("Files this skill mentions are relative to"))
        XCTAssertEqual(LocalSkillDiscovery.render([]), "")
    }

    func testCatalogNoticesANewSkill() throws {
        let (home, project) = try fixture()
        let catalog = LocalSkillCatalog(home: home)
        let changed = expectation(description: "changed")
        changed.assertForOverFulfill = false
        catalog.onChange { changed.fulfill() }
        XCTAssertFalse(catalog.list(projectRoot: project).contains { $0.name == "fresh" })
        try skill(home.appendingPathComponent(".claude/skills"), "fresh", "name: fresh\ndescription: new", "FRESH")
        wait(for: [changed], timeout: 5)
        XCTAssertTrue(catalog.list(projectRoot: project).contains { $0.name == "fresh" })
    }

    /// Waits for the catalog's next change, failing after `seconds`.
    private func expectChange(_ catalog: LocalSkillCatalog, within seconds: TimeInterval = 1, _ change: () throws -> Void) throws {
        let changed = expectation(description: "skills changed")
        changed.assertForOverFulfill = false
        let id = catalog.onChange { changed.fulfill() }
        defer { catalog.removeListener(id) }
        try change()
        wait(for: [changed], timeout: seconds)
    }

    private func description(_ name: String, in catalog: LocalSkillCatalog, project: URL) -> String? {
        catalog.list(projectRoot: project).first { $0.name == name }?.description
    }

    func testEditingASkillFileInvalidatesWithinASecond() throws {
        let (home, project) = try fixture()
        let catalog = LocalSkillCatalog(home: home)
        let file = try XCTUnwrap(catalog.list(projectRoot: project).first { $0.name == "design-taste-frontend" }).path
        XCTAssertGreaterThan(catalog.watchedFileCount, 0, "each SKILL.md is watched itself")

        // An in-place write: no folder changes, only the file.
        let handle = try XCTUnwrap(FileHandle(forWritingAtPath: file))
        try expectChange(catalog) {
            try handle.truncate(atOffset: 0)
            try handle.write(contentsOf: Data("---\nname: design-taste-frontend\ndescription: Edited in place.\n---\nUSER TASTE BODY\n".utf8))
            try handle.synchronize()
        }
        try handle.close()
        XCTAssertEqual(description("design-taste-frontend", in: catalog, project: project), "Edited in place.")
    }

    func testAnAtomicSaveIsSeenAndTheReplacedFileIsWatchedAgain() throws {
        let (home, project) = try fixture()
        let catalog = LocalSkillCatalog(home: home)
        let path = try XCTUnwrap(catalog.list(projectRoot: project).first { $0.name == "design-taste-frontend" }).path
        let file = URL(fileURLWithPath: path)

        // `write(atomically:)` writes a temporary file and renames it over SKILL.md.
        try expectChange(catalog) {
            try "---\nname: design-taste-frontend\ndescription: Saved atomically.\n---\nBODY\n".write(to: file, atomically: true, encoding: .utf8)
        }
        XCTAssertEqual(description("design-taste-frontend", in: catalog, project: project), "Saved atomically.")

        // The rescan re-armed a watcher on the new file: an in-place edit of it is seen too.
        let rearmed = Date().addingTimeInterval(2)
        while Date() < rearmed, catalog.watchedFileCount == 0 { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        Thread.sleep(forTimeInterval: 0.3)
        let handle = try XCTUnwrap(FileHandle(forWritingAtPath: path))
        try expectChange(catalog) {
            try handle.truncate(atOffset: 0)
            try handle.write(contentsOf: Data("---\nname: design-taste-frontend\ndescription: Third edit.\n---\nBODY\n".utf8))
            try handle.synchronize()
        }
        try handle.close()
        XCTAssertEqual(description("design-taste-frontend", in: catalog, project: project), "Third edit.")
    }

    func testAProjectSkillEditAndARemovalAreSeen() throws {
        let (home, project) = try fixture()
        let catalog = LocalSkillCatalog(home: home)
        let listed = catalog.list(projectRoot: project)
        let rules = try XCTUnwrap(listed.first { $0.source == .project }).path
        try expectChange(catalog) {
            try "---\ndescription: Revised rules\n---\nBODY\n".write(toFile: rules, atomically: false, encoding: .utf8)
        }
        _ = catalog.list(projectRoot: project)
        Thread.sleep(forTimeInterval: 0.3)
        let gone = try XCTUnwrap(listed.first { $0.name == "codex-only" }).path
        try expectChange(catalog) {
            try FileManager.default.removeItem(at: URL(fileURLWithPath: gone).deletingLastPathComponent())
        }
        XCTAssertFalse(catalog.list(projectRoot: project).contains { $0.name == "codex-only" })
    }
}
