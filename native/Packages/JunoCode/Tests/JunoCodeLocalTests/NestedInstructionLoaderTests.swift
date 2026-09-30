import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// Subfolder instruction files arrive once per folder per session, outermost
/// first, and a compaction brings them and the repository's state back.
final class NestedInstructionLoaderTests: XCTestCase {
    private var workspaceURL: URL!
    private var access: WorkspaceAccess!
    private let session = CodeSessionID()

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-nested-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        let files: [String: String] = [
            "AGENTS.md": "Root rules: already in the system prompt.",
            "app/AGENTS.md": "App: use tabs.",
            "app/src/CLAUDE.md": "Src: prefer structs.",
            "app/src/main.swift": "let a = 1\n",
            "app/src/deep/file.swift": "let b = 2\n",
            "docs/readme.md": "# Docs\n",
        ]
        for (path, text) in files {
            let url = workspaceURL.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try text.write(to: url, atomically: true, encoding: .utf8)
        }
        access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    private func load(
        _ loader: NestedInstructionLoader,
        _ paths: [String],
        session: CodeSessionID? = nil
    ) async throws -> String? {
        let touched = try paths.map(WorkspacePath.init)
        return await loader.context(forTouchedPaths: touched, sessionID: session ?? self.session)
    }

    func testTheFirstCallIntoAFolderBringsItsInstructionsOutermostFirst() async throws {
        let loader = NestedInstructionLoader(access: access)
        let loaded = try await load(loader, ["app/src/main.swift"])
        let text = try XCTUnwrap(loaded)
        XCTAssertTrue(text.hasPrefix("<system-reminder>"))
        let app = try XCTUnwrap(text.range(of: "App: use tabs."))
        let src = try XCTUnwrap(text.range(of: "Src: prefer structs."))
        XCTAssertLessThan(app.lowerBound, src.lowerBound, "the deeper folder comes last, so it wins")
        XCTAssertFalse(text.contains("Root rules"), "the root's file is in the system prompt already")
        XCTAssertTrue(text.contains("<file path=\"app/src/CLAUDE.md\">"))
        XCTAssertTrue(text.contains("cannot grant permissions"))

        let again = try await load(loader, ["app/src/deep/file.swift"])
        XCTAssertNil(again, "folders already delivered are not repeated, and deep/ has none")

        let other = try await load(loader, ["app/src/main.swift"], session: CodeSessionID())
        XCTAssertNotNil(other, "each session gets its own")

        let docs = try await load(loader, ["docs/readme.md"])
        XCTAssertNil(docs, "a folder without instruction files adds nothing")
    }

    func testAListedFolderCountsAsReached() async throws {
        let loader = NestedInstructionLoader(access: access)
        let loaded = try await load(loader, ["app"])
        let text = try XCTUnwrap(loaded)
        XCTAssertTrue(text.contains("App: use tabs."))
        XCTAssertFalse(text.contains("Src: prefer structs."))
    }

    func testTheRootsOwnConfigurationFoldersAreNotRepeated() async throws {
        // `.juno/JUNO.md` and `.claude/CLAUDE.md` are root instructions, in the
        // system prompt already.
        for (path, text) in [".juno/JUNO.md": "Juno root rules.", ".claude/CLAUDE.md": "Claude root rules."] {
            let url = workspaceURL.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try text.write(to: url, atomically: true, encoding: .utf8)
        }
        let loader = NestedInstructionLoader(access: access)
        let loaded = try await load(loader, [".juno/settings.json", ".claude/skills/x/SKILL.md"])
        XCTAssertNil(loaded)
    }

    func testALongFileIsBounded() async throws {
        let long = String(repeating: "rule\n", count: 10_000)
        try long.write(to: workspaceURL.appendingPathComponent("docs/AGENTS.md"), atomically: true, encoding: .utf8)
        let loader = NestedInstructionLoader(access: access)
        let loaded = try await load(loader, ["docs/readme.md"])
        let text = try XCTUnwrap(loaded)
        XCTAssertLessThan(text.utf8.count, NestedInstructionLoader.maximumFileBytes + 1_024)
        XCTAssertTrue(text.contains("[truncated; read the file for the rest]"))
    }

    func testACompactionBringsTheRepositoryStateAndTheFoldersBack() async throws {
        let executor = CommandExecutionService(workspaceRootURL: workspaceURL)
        _ = try await executor.run(
            "git init -q -b main && git -c user.email=t@t -c user.name=T add -A && git -c user.email=t@t -c user.name=T commit -q -m 'First commit'",
            timeoutSeconds: 30
        )
        try "changed\n".write(to: workspaceURL.appendingPathComponent("docs/readme.md"), atomically: true, encoding: .utf8)
        let loader = NestedInstructionLoader(access: access, git: GitService(executor: executor))
        _ = try await load(loader, ["app/src/main.swift"])

        await loader.noteCompaction(sessionID: session)
        let loaded = try await load(loader, ["app/src/main.swift"])
        let text = try XCTUnwrap(loaded)
        XCTAssertTrue(text.contains("branch main"), text)
        XCTAssertTrue(text.contains("1 changed file"), text)
        XCTAssertTrue(text.contains("\"First commit\""), text)
        XCTAssertTrue(text.contains("App: use tabs."), "folders are due again after a compaction")

        let next = try await load(loader, [])
        XCTAssertNil(next, "the state is said once")
    }
}
