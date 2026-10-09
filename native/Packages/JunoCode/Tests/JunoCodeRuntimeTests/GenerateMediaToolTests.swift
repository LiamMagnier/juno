import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

final class GenerateMediaToolTests: XCTestCase {
    private struct FakeMedia: CodeMediaGenerating {
        var models: [CodeMediaKind: String] = [.image: "openai:gpt-image-2.5-sunburst"]
        var files: [CodeGeneratedFile] = [CodeGeneratedFile(fileName: "image.png", mimeType: "image/png", data: Data([0x89, 0x50, 0x4E, 0x47]))]
        func model(for kind: CodeMediaKind) -> String? { models[kind] }
        func generate(kind _: CodeMediaKind, prompt _: String, model _: String) async throws -> [CodeGeneratedFile] { files }
    }

    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("gen-media-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func context() -> ToolContext {
        ToolContext(sessionID: CodeSessionID(), toolCallID: "t1", emitOutput: { _, _ in })
    }

    func testOnlyKindsWithAModelBecomeTools() {
        let tools = GenerateMediaTool.all(service: FakeMedia(), workspaceRoot: URL(fileURLWithPath: "/tmp"))
        XCTAssertEqual(tools.map(\.name), ["generate_image"])
    }

    func testSavesTheFileWhereAsked() async throws {
        let workspace = try root()
        let tool = GenerateMediaTool(kind: .image, service: FakeMedia(), workspaceRoot: workspace)
        let result = try await tool.execute(input: ["prompt": "a hero image", "path": "public/hero.png"], context: context())
        XCTAssertTrue(result.content.contains("public/hero.png"))
        XCTAssertTrue(result.content.contains("gpt-image-2.5-sunburst"))
        XCTAssertEqual(try Data(contentsOf: workspace.appendingPathComponent("public/hero.png")), Data([0x89, 0x50, 0x4E, 0x47]))
    }

    func testNeverOverwritesOrLeavesTheWorkspace() async throws {
        let workspace = try root()
        try Data([1]).write(to: workspace.appendingPathComponent("taken.png"))
        let tool = GenerateMediaTool(kind: .image, service: FakeMedia(), workspaceRoot: workspace)
        do {
            _ = try await tool.execute(input: ["prompt": "x", "path": "taken.png"], context: context())
            XCTFail("overwrote an existing file")
        } catch {}
        XCTAssertNotNil(tool.precheck(input: ["prompt": "x", "path": "../escape.png"]))
        XCTAssertNotNil(tool.precheck(input: ["prompt": "x", "path": "/etc/escape.png"]))
        XCTAssertNotNil(tool.precheck(input: ["prompt": "  "]))
        XCTAssertEqual(tool.assessRisk(input: ["prompt": "x"]), .critical)
    }

    func testWithoutAPathItSavesUnderGenerated() async throws {
        let workspace = try root()
        let tool = GenerateMediaTool(kind: .image, service: FakeMedia(), workspaceRoot: workspace)
        let result = try await tool.execute(input: ["prompt": "a tile"], context: context())
        XCTAssertTrue(result.content.contains("generated/image-"))
        let made = try FileManager.default.contentsOfDirectory(atPath: workspace.appendingPathComponent("generated").path)
        XCTAssertEqual(made.count, 1)
    }
}
