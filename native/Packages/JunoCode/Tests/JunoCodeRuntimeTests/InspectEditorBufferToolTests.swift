import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

final class InspectEditorBufferToolTests: XCTestCase {
    private struct MockEditorReader: EditorBufferReading {
        var authorized: Bool = true
        var inspectionResult: EditorBufferInspection? = nil
        var editors: [EditorApplicationInfo] = []

        func isAccessibilityAuthorized() -> Bool { authorized }
        func runningEditors() -> [EditorApplicationInfo] { editors }
        func inspectActiveEditor() async throws -> EditorBufferInspection? { inspectionResult }
        func inspectEditor(bundleIdentifier: String) async throws -> EditorBufferInspection? { inspectionResult }
    }

    func testInspectEditorBufferToolProperties() {
        let tool = InspectEditorBufferTool(reader: MockEditorReader())
        XCTAssertEqual(tool.name, "inspect_active_editor")
        XCTAssertEqual(tool.assessRisk(input: [:]), .read)
        XCTAssertEqual(tool.summary(input: [:]), "Inspect active editor code buffer")
    }

    func testExecuteReturnsPermissionNoticeWhenUnauthorized() async throws {
        let tool = InspectEditorBufferTool(reader: MockEditorReader(authorized: false))
        let context = ToolContext(
            sessionID: CodeSessionID(),
            toolCallID: "call_1",
            emitOutput: { _, _ in }
        )
        let result = try await tool.execute(input: [:], context: context)
        XCTAssertTrue(result.content.contains("Accessibility permission is required"))
    }

    func testExecuteFormatsBufferInspectionOutput() async throws {
        let editor = EditorApplicationInfo(
            bundleIdentifier: "com.apple.dt.Xcode",
            localizedName: "Xcode",
            processID: 100,
            kind: .xcode
        )
        let sampleInspection = EditorBufferInspection(
            editor: editor,
            windowTitle: "ContentView.swift — JunoDesktop",
            documentPath: "/Users/dev/JunoDesktop/ContentView.swift",
            textBuffer: "struct ContentView: View {\n    var body = Text(\"hi\")\n}\n",
            selectedText: "var body",
            cursorOffset: 31,
            characterCount: 54,
            lineCount: 3
        )

        let tool = InspectEditorBufferTool(
            reader: MockEditorReader(authorized: true, inspectionResult: sampleInspection, editors: [editor])
        )
        let context = ToolContext(
            sessionID: CodeSessionID(),
            toolCallID: "call_2",
            emitOutput: { _, _ in }
        )

        let result = try await tool.execute(input: [:], context: context)
        XCTAssertTrue(result.content.contains("Editor: Xcode (com.apple.dt.Xcode, PID 100)"))
        XCTAssertTrue(result.content.contains("Window Title: ContentView.swift — JunoDesktop"))
        XCTAssertTrue(result.content.contains("Document Path: /Users/dev/JunoDesktop/ContentView.swift"))
        XCTAssertTrue(result.content.contains("Buffer Metrics: 3 lines, 54 characters"))
        XCTAssertTrue(result.content.contains("Cursor Offset: 31"))
        XCTAssertTrue(result.content.contains("Selected Text:\n```\nvar body\n```"))
        XCTAssertTrue(result.content.contains("Buffer Content:\n```\nstruct ContentView: View"))
    }
}
