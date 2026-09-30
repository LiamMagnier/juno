import XCTest
@testable import JunoCodeCore

/// Which tool calls may share a wave, and the multi-path permission subject.
final class ToolEffectClassifierTests: XCTestCase {
    private func effect(_ name: String, _ input: JSONValue = [:]) -> ToolConflictEffect {
        ToolEffectClassifier.classify(toolName: name, input: input)
    }

    func testReadsRunTogetherAndWritesSerializePerPath() {
        for name in ["read_file", "list_directory", "grep", "glob", "find_files", "web_fetch", "use_skill"] {
            guard case .readOnly = effect(name, ["path": "a"]) else {
                return XCTFail("\(name) should be a read")
            }
        }
        XCTAssertEqual(effect("multi_edit", ["path": "a.swift"]), .fileMutation(paths: ["a.swift"]))
        XCTAssertEqual(effect("create_file", ["path": "b.swift"]), .fileMutation(paths: ["b.swift"]))
        XCTAssertEqual(
            effect("move_file", ["from": "a", "to": "b"]),
            .fileMutation(paths: ["a", "b"])
        )
        XCTAssertFalse(
            effect("multi_edit", ["path": "a"]).conflicts(with: effect("write_file", ["path": "b"]))
        )
        XCTAssertTrue(
            effect("move_file", ["from": "a", "to": "b"]).conflicts(with: effect("read_file", ["path": "b"]))
        )
    }

    func testAMultiFilePatchClaimsEveryFileItTouches() {
        let patch = """
            *** Begin Patch
            *** Update File: src/a.swift
            *** Move to: src/b.swift
            @@
            -x
            +y
            *** Delete File: c.txt
            *** End Patch
            """
        XCTAssertEqual(
            effect("apply_patch", ["patch": .string(patch)]),
            .fileMutation(paths: ["src/a.swift", "src/b.swift", "c.txt"])
        )
        XCTAssertTrue(effect("apply_patch", ["patch": .string(patch)]).conflicts(with: effect("read_file", ["path": "c.txt"])))
        XCTAssertFalse(effect("apply_patch", ["patch": .string(patch)]).conflicts(with: effect("read_file", ["path": "d.txt"])))
    }

    func testSessionToolsOnlyOrderAgainstTheirOwnState() {
        let todo = effect("todo_write")
        XCTAssertTrue(todo.conflicts(with: effect("todo_write")))
        XCTAssertFalse(todo.conflicts(with: effect("read_file", ["path": "a"])))
        XCTAssertFalse(todo.conflicts(with: effect("write_file", ["path": "a"])))
        XCTAssertTrue(effect("ask_user").conflicts(with: effect("exit_plan")))

        XCTAssertTrue(effect("shell_kill", ["id": "s1"]).conflicts(with: effect("shell_output", ["id": "s1"])))
        XCTAssertFalse(effect("shell_kill", ["id": "s1"]).conflicts(with: effect("shell_output", ["id": "s2"])))
        XCTAssertEqual(effect("shell_start", ["command": "npm run dev"]), .exclusive)
        // Typed into a shell, text edits files and runs programs: a write
        // keeps a command's place in the order, beside nothing.
        XCTAssertEqual(effect("shell_write", ["id": "s1"]), .exclusive)
        XCTAssertTrue(effect("shell_write", ["id": "s1"]).conflicts(with: effect("write_file", ["path": "a"])))
    }

    func testNamesThatNoToolUsesAreGone() {
        // These used to be special-cased although nothing registers them; they
        // now fall to the default like any unknown tool.
        for stale in ["fetch_url", "git_checkout", "git_branch", "terminal_command", "computer_action"] {
            XCTAssertEqual(effect(stale), .exclusive, stale)
        }
    }

    // MARK: - Multi-path rule subjects

    func testADenyOnEitherEndOfAMoveApplies() {
        let rules = PermissionRuleSet(
            allow: [PermissionRule(tool: "Edit", specifier: "src/**")],
            deny: [PermissionRule(tool: "Edit", specifier: "secrets/**")]
        )
        let out = rules.evaluate(toolName: "move_file", subject: .paths(["secrets/key.pem", "src/key.pem"]))
        XCTAssertEqual(out, .deny(PermissionRule(tool: "Edit", specifier: "secrets/**")))
    }

    func testAnAllowMustCoverEveryPath() {
        let rules = PermissionRuleSet(allow: [PermissionRule(tool: "Edit", specifier: "src/**")])
        XCTAssertEqual(
            rules.evaluate(toolName: "apply_patch", subject: .paths(["src/a.swift", "src/b.swift"])),
            .allow(PermissionRule(tool: "Edit", specifier: "src/**"))
        )
        XCTAssertNil(rules.evaluate(toolName: "apply_patch", subject: .paths(["src/a.swift", "docs/b.md"])))
        XCTAssertEqual(
            PermissionRuleSet.suggestedRule(toolName: "apply_patch", subject: .paths(["a", "b"])),
            PermissionRule(tool: "Edit")
        )
    }

    func testAShellSessionIsABashCommandToTheRules() {
        let rules = PermissionRuleSet(deny: [PermissionRule(tool: "Bash", specifier: "rm *")])
        XCTAssertEqual(
            rules.evaluate(toolName: "shell_start", subject: .command("rm -rf build")),
            .deny(PermissionRule(tool: "Bash", specifier: "rm *"))
        )
    }
}
