import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// The grep tool's modes and its ripgrep-shaped output.
final class GrepToolTests: XCTestCase {
    private var workspaceURL: URL!
    private var tool: GrepTool!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-grep-\(UUID().uuidString)")
        let files: [String: String] = [
            "a.swift": "alpha\nneedle one\nneedle two\ngamma\ndelta\nepsilon\nneedle three\n",
            "b/b.swift": "needle b\n",
            "b/c.txt": "nothing here\n",
        ]
        for (path, contents) in files {
            let url = workspaceURL.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try contents.write(to: url, atomically: true, encoding: .utf8)
        }
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        tool = GrepTool(index: WorkspaceIndexService(access: access))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    private func grep(_ input: JSONValue) async throws -> String {
        try await tool.execute(
            input: input,
            context: ToolContext(sessionID: CodeSessionID(), toolCallID: "c", emitOutput: { _, _ in })
        ).content
    }

    func testContextIsPrintedOnceWithHunkSeparators() async throws {
        let output = try await grep(["pattern": "needle", "path": "a.swift", "context": 1])
        XCTAssertEqual(output, """
            a.swift-1- alpha
            a.swift:2: needle one
            a.swift:3: needle two
            a.swift-4- gamma
            --
            a.swift-6- epsilon
            a.swift:7: needle three
            """)
    }

    func testPlainContentHasNoSeparators() async throws {
        let output = try await grep(["pattern": "needle"])
        XCTAssertEqual(output, """
            a.swift:2: needle one
            a.swift:3: needle two
            a.swift:7: needle three
            b/b.swift:1: needle b
            """)
    }

    func testFilesAndCounts() async throws {
        let files = try await grep(["pattern": "needle", "output_mode": "files_with_matches"])
        XCTAssertEqual(files, "a.swift\nb/b.swift")
        let counts = try await grep(["pattern": "needle", "output_mode": "count"])
        XCTAssertEqual(counts, "a.swift: 3\nb/b.swift: 1\n4 matches in 2 files.")
        let scoped = try await grep(["pattern": "needle", "output_mode": "count", "path": "b"])
        XCTAssertEqual(scoped, "b/b.swift: 1\n1 match in 1 file.")
    }

    func testRefusesAnUnknownModeOrAnEscapingPath() {
        XCTAssertNotNil(tool.precheck(input: ["pattern": "x", "output_mode": "lines"]))
        XCTAssertNotNil(tool.precheck(input: ["pattern": "x", "path": "../outside"]))
        XCTAssertNil(tool.precheck(input: ["pattern": "x", "path": "."]))
    }
}
