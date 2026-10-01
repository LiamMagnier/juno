import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

private struct NoTools: VerifyDiscoveryEnvironment {
    func isInstalled(_: String) async -> Bool { false }
    func run(_: [String], in _: URL) async -> String? { nil }
}

/// Acceptance bound to the recipe's bytes, and "Run these without asking"
/// writing exactly the listed rules to the personal file (§1.8, D-019).
final class VerifyRecipeStoreTests: XCTestCase {
    private var base: URL!
    private var project: URL!
    private var store: VerifyRecipeStore!

    override func setUpWithError() throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-verify-store-\(UUID().uuidString)")
        project = base.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try #"{"scripts": {"test": "vitest run", "typecheck": "tsc --noEmit"}, "devDependencies": {"vitest": "3"}}"#
            .write(to: project.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        store = VerifyRecipeStore(
            workspaceRoot: project,
            approvals: VerifyRecipeApprovalStore(directory: base.appendingPathComponent("approvals")),
            settings: CodeSettingsStore(
                userDirectory: base.appendingPathComponent("home/.juno"),
                approvals: CodeSettingsApprovalStore(directory: base.appendingPathComponent("settings-approvals"))
            ),
            discovery: VerifyRecipeDiscovery(workspaceRoot: project, environment: NoTools())
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
    }

    private func recipe() -> VerifyRecipe {
        VerifyRecipe(checks: [
            VerifyCheck(id: "web-typecheck", kind: .typecheck, run: .shell("npm run typecheck"), paths: ["src/**"]),
            VerifyCheck(id: "web-test", kind: .test, run: .shell("npm test"), targeted: "npx vitest run {tests}", paths: ["src/**"]),
        ])
    }

    func testWithoutAFileTheDiscoveredChecksAreUsable() async {
        guard case let .discovered(found) = await store.status() else {
            return XCTFail("expected discovered checks")
        }
        XCTAssertEqual(found.checks.map(\.commandLine).sorted(), ["npm run typecheck", "npm test"])
        XCTAssertNil(store.acceptedRecipe())
    }

    func testAcceptingWritesTheFileAndBindsTheAcceptanceToItsBytes() async throws {
        let acceptance = try store.accept(recipe(), runWithoutAsking: false)
        XCTAssertTrue(acceptance.wroteRecipe)
        XCTAssertEqual(acceptance.rulesAdded, [])
        XCTAssertEqual(store.acceptedRecipe(), recipe())
        guard case .accepted = await store.status() else { return XCTFail("expected accepted") }

        // Anyone editing the file withdraws the acceptance.
        var edited = recipe()
        edited.checks[1].run = .shell("npm test && curl https://example.com")
        try edited.encoded().write(to: store.recipeURL)
        XCTAssertNil(store.acceptedRecipe())
        guard case let .awaitingAcceptance(changed) = await store.status() else {
            return XCTFail("an edited file asks again")
        }
        XCTAssertEqual(changed, edited)
        XCTAssertNil(VerifyRecipeStatus.awaitingAcceptance(changed).usableRecipe, "its commands are not offered to the model")
    }

    func testAcceptingAChangedFileNeedsTheBytesTheReaderSaw() throws {
        try FileManager.default.createDirectory(at: store.recipeURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try recipe().encoded().write(to: store.recipeURL, options: .atomic)
        guard case let .present(_, digest, false) = store.file() else { return XCTFail("expected an unaccepted file") }
        // Changed again before the click: nothing is accepted.
        var later = recipe()
        later.checks.removeLast()
        try later.encoded().write(to: store.recipeURL, options: .atomic)
        XCTAssertNil(try store.acceptExisting(expectedDigest: digest, runWithoutAsking: true))
        XCTAssertNil(store.acceptedRecipe())
        XCTAssertFalse(FileManager.default.fileExists(atPath: project.appendingPathComponent(".juno/settings.local.json").path))

        guard case let .present(_, current, false) = store.file() else { return XCTFail() }
        XCTAssertNotNil(try store.acceptExisting(expectedDigest: current, runWithoutAsking: false))
        XCTAssertEqual(store.acceptedRecipe(), later)
    }

    func testRunWithoutAskingWritesExactlyTheListedRulesToThePersonalFile() throws {
        let acceptance = try store.accept(recipe(), runWithoutAsking: true)
        XCTAssertEqual(acceptance.rulesAdded.map(\.description), [
            "Bash(npm run typecheck)", "Bash(npm test)", "Bash(npx vitest run *)",
        ])
        let local = store.settings.load(.local, projectRoot: project)
        XCTAssertEqual(local.permissions?.allow, acceptance.rulesAdded)
        XCTAssertTrue(store.settings.isApproved(.local, projectRoot: project), "the reader's own edit is approved as written")
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: project.appendingPathComponent(".juno/settings.json").path),
            "nothing is written to the shared project file"
        )
        let ignore = try String(contentsOf: project.appendingPathComponent(".juno/.gitignore"), encoding: .utf8)
        XCTAssertTrue(ignore.contains("settings.local.json"), "the personal file is never committed")

        // Accepting again adds nothing twice, and keeps the reader's own rules.
        try store.settings.addAllowRule(PermissionRule(tool: "Read"), scope: .local, projectRoot: project)
        XCTAssertEqual(try store.accept(recipe(), runWithoutAsking: true).rulesAdded, [])
        XCTAssertEqual(store.settings.load(.local, projectRoot: project).permissions?.allow?.count, 4)
    }

    func testWithoutTheTickNoRuleIsWritten() throws {
        try store.accept(recipe(), runWithoutAsking: false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: project.appendingPathComponent(".juno/settings.local.json").path))
    }

    func testAnUnreadableFileIsReportedNotUsed() async throws {
        try FileManager.default.createDirectory(at: store.recipeURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "{ nope".write(to: store.recipeURL, atomically: true, encoding: .utf8)
        guard case .invalid = await store.status() else { return XCTFail("expected invalid") }
        XCTAssertNil(store.acceptedRecipe())
    }
}
