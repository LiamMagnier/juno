import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The three settings files as a session reads them, on a real disk.
final class CodeSettingsStoreTests: XCTestCase {
    private var root: URL!
    private var userDirectory: URL!
    private var project: URL!
    private var store: CodeSettingsStore!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-settings-store-\(UUID().uuidString)")
        userDirectory = root.appendingPathComponent("home/.juno", isDirectory: true)
        project = root.appendingPathComponent("cloned-repo", isDirectory: true)
        try FileManager.default.createDirectory(
            at: project.appendingPathComponent(".juno"),
            withIntermediateDirectories: true
        )
        store = CodeSettingsStore(userDirectory: userDirectory)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func write(_ json: String, to scope: CodeSettingsStore.Scope) throws {
        let url = try XCTUnwrap(store.url(for: scope, projectRoot: project))
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(json.utf8).write(to: url)
    }

    private static let allowsScreenInput = """
    {"permissions":{"allow":["computer_click","computer_type","computer_press_key","computer_scroll",
                             "Bash(npm test *)"]}}
    """

    func testNoFileInsideAProjectCanAllowScreenInput() throws {
        // A repository that arrives with both project files allowing every
        // input tool. Neither may silence the question a click asks, however
        // the files got there.
        try write(Self.allowsScreenInput, to: .project)
        try write(Self.allowsScreenInput, to: .local)

        let rules = store.resolved(projectRoot: project).rules
        for name in ComputerUseToolName.input {
            XCTAssertNil(rules.evaluate(toolName: name, subject: nil), name)
        }
        // Everything else the files say still applies.
        XCTAssertEqual(
            rules.evaluate(toolName: "run_command", subject: .command("npm test --watch")),
            .allow(PermissionRule(tool: "Bash", specifier: "npm test *"))
        )
    }

    func testAProjectMayStillAskOrRefuseScreenInput() throws {
        try write(#"{"permissions":{"ask":["computer_click"],"deny":["computer_type"]}}"#, to: .project)
        try write(#"{"permissions":{"allow":["computer_click","computer_type"]}}"#, to: .user)

        let rules = store.resolved(projectRoot: project).rules
        XCTAssertEqual(
            rules.evaluate(toolName: ComputerUseToolName.click, subject: nil),
            .ask(PermissionRule(tool: "computer_click"))
        )
        XCTAssertEqual(
            rules.evaluate(toolName: ComputerUseToolName.type, subject: nil),
            .deny(PermissionRule(tool: "computer_type"))
        )
    }

    func testTheReadersOwnFileCanAllowScreenInputInEveryProject() throws {
        try write(#"{"permissions":{"allow":["computer_click"]}}"#, to: .user)

        XCTAssertEqual(
            store.resolved(projectRoot: project).rules.evaluate(toolName: ComputerUseToolName.click, subject: nil),
            .allow(PermissionRule(tool: "computer_click"))
        )
        XCTAssertEqual(
            store.resolved(projectRoot: nil).rules.evaluate(toolName: ComputerUseToolName.click, subject: nil),
            .allow(PermissionRule(tool: "computer_click"))
        )
    }

    func testAlwaysAllowSavesScreenInputWhereItWillBeHonoured() throws {
        // Saved to the project's personal file, an Always allow for a click
        // would be dropped on the next run and the reader asked again, after
        // being told the answer was remembered.
        let click = PermissionRule(tool: ComputerUseToolName.click)
        try store.rememberAllowRule(click, projectRoot: project)
        XCTAssertEqual(store.load(.user, projectRoot: nil).permissions?.allow, [click])
        XCTAssertNil(store.load(.local, projectRoot: project).permissions)
        XCTAssertEqual(
            store.resolved(projectRoot: project).rules.evaluate(toolName: click.tool, subject: nil),
            .allow(click)
        )

        // Every other answer stays with the project, and out of Git.
        let lint = PermissionRule(tool: "Bash", specifier: "npm run *")
        try store.rememberAllowRule(lint, projectRoot: project)
        XCTAssertEqual(store.load(.local, projectRoot: project).permissions?.allow, [lint])
        XCTAssertEqual(store.load(.user, projectRoot: nil).permissions?.allow, [click])
        let ignore = try String(
            contentsOf: project.appendingPathComponent(".juno/.gitignore"),
            encoding: .utf8
        )
        XCTAssertTrue(ignore.contains("settings.local.json"))

        XCTAssertEqual(CodeSettingsStore.alwaysAllowScope(for: lint, projectRoot: nil), .user)
    }
}
