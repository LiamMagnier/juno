import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// What a context provider sees of a call, and where its text lands.
final class ToolResultContextTests: XCTestCase {
    private actor RecordingProvider: ToolResultContextProviding {
        private(set) var seen: [[String]] = []

        func context(forTouchedPaths touchedPaths: [WorkspacePath], sessionID: CodeSessionID) async -> String? {
            seen.append(touchedPaths.map(\.value))
            return touchedPaths.isEmpty ? nil : "<system-reminder>for \(touchedPaths.map(\.value).joined(separator: ","))</system-reminder>"
        }
    }

    private struct EchoTool: CodeTool {
        let name: String
        var fails = false
        let description = "Echo."
        var inputSchema: JSONValue {
            ["type": "object", "properties": ["path": ["type": "string"], "cwd": ["type": "string"]], "required": []]
        }
        func assessRisk(input: JSONValue) -> ActionRisk { .read }
        func summary(input: JSONValue) -> String { name }
        func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
            ToolResult(content: "result", isError: fails)
        }
    }

    private func run(_ registry: ToolRegistry, _ tool: String, _ input: JSONValue) async throws -> ToolResult {
        try await registry.executeAuthorized(
            toolName: tool,
            input: input,
            context: ToolContext(sessionID: CodeSessionID(), toolCallID: "c", emitOutput: { _, _ in })
        )
    }

    func testTheProviderAddsToASuccessfulResultOnly() async throws {
        let provider = RecordingProvider()
        let registry = ToolRegistry(
            tools: [EchoTool(name: "read_file"), EchoTool(name: "write_file", fails: true)],
            contextProvider: provider
        )
        let read = try await run(registry, "read_file", ["path": "app/a.swift"])
        XCTAssertEqual(read.content, "result", "the tool's own answer is left as it was")
        XCTAssertEqual(read.appendedContext, "<system-reminder>for app/a.swift</system-reminder>")
        XCTAssertEqual(read.contentWithContext, "result\n\n<system-reminder>for app/a.swift</system-reminder>")

        let failed = try await run(registry, "write_file", ["path": "app/b.swift"])
        XCTAssertEqual(failed.contentWithContext, "result", "a failed call earns nothing")

        let inspection = try await run(registry.inspectionOnly(), "read_file", ["path": "lib/c.swift"])
        XCTAssertTrue(inspection.contentWithContext.contains("for lib/c.swift"), "an inspection registry keeps its provider")
    }

    func testInstructionsFollowAWholeReadWithoutCuttingIt() throws {
        // A read just under read_file's own budget, and the most a folder's
        // instructions add: together over the result cap.
        let line = String(repeating: "x", count: 99) + "\n"
        let text = String(repeating: line, count: 950)
        let rendered = ReadFileTool.render(
            FileReadResult(
                path: try WorkspacePath("app/big.txt"),
                content: text,
                wasTruncated: false,
                fingerprint: FileFingerprint(of: text),
                byteCount: text.utf8.count,
                lineCount: 950
            ),
            offset: nil,
            limit: nil
        )
        let instructions = "<system-reminder>\n" + String(repeating: "rule\n", count: 8_000) + "</system-reminder>"
        let execution = ToolScheduler.ExecutionResult(
            callID: "c",
            toolName: "read_file",
            input: ["path": "app/big.txt"],
            content: rendered,
            isError: false,
            appendedContext: instructions
        )
        let sent = AgentOrchestrator.modelContent(for: execution, maximumBytes: 128 * 1_024)
        XCTAssertTrue(sent.hasPrefix(rendered), "the read is whole, header and all")
        XCTAssertTrue(sent.contains("\"base_sha256\""), "and still offers its base")
        XCTAssertTrue(sent.hasSuffix(instructions))
    }

    func testTouchedPathsCoverEveryWayACallReachesAFolder() {
        func paths(_ tool: String, _ input: JSONValue) -> [String] {
            ToolTouchedPaths.paths(toolName: tool, input: input).map(\.value)
        }
        XCTAssertEqual(paths("list_directory", ["path": "app"]), ["app"])
        XCTAssertEqual(paths("move_file", ["from": "a/x", "to": "b/x"]), ["a/x", "b/x"])
        XCTAssertEqual(paths("run_command", ["command": "make", "cwd": "app"]), ["app"])
        XCTAssertEqual(
            paths("apply_patch", ["patch": "*** Begin Patch\n*** Add File: lib/n.swift\n+x\n*** End Patch"]),
            ["lib/n.swift"]
        )
        XCTAssertEqual(paths("glob", ["pattern": "**/*.swift"]), [])
        XCTAssertEqual(paths("read_file", ["path": "../escape"]), [], "an unsafe path reaches nothing")
    }
}
