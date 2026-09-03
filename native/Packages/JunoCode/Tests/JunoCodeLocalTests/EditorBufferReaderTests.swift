import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class EditorBufferReaderTests: XCTestCase {
    func testEditorApplicationKindDisplayNames() {
        XCTAssertEqual(EditorApplicationKind.xcode.displayName, "Xcode")
        XCTAssertEqual(EditorApplicationKind.vscode.displayName, "VS Code")
        XCTAssertEqual(EditorApplicationKind.cursor.displayName, "Cursor")
        XCTAssertEqual(EditorApplicationKind.windsurf.displayName, "Windsurf")
        XCTAssertEqual(EditorApplicationKind.jetbrains("IntelliJ").displayName, "JetBrains IntelliJ")
        XCTAssertEqual(EditorApplicationKind.sublime.displayName, "Sublime Text")
        XCTAssertEqual(EditorApplicationKind.other("CustomEditor").displayName, "CustomEditor")
    }

    func testEditorApplicationInfoIdentifiable() {
        let info = EditorApplicationInfo(
            bundleIdentifier: "com.apple.dt.Xcode",
            localizedName: "Xcode",
            processID: 12345,
            kind: .xcode
        )
        XCTAssertEqual(info.id, "com.apple.dt.Xcode:12345")
        XCTAssertEqual(info.kind, .xcode)
    }

    func testEditorBufferInspectionProperties() {
        let editor = EditorApplicationInfo(
            bundleIdentifier: "com.microsoft.VSCode",
            localizedName: "Visual Studio Code",
            processID: 9999,
            kind: .vscode
        )
        let sampleBuffer = "function helloWorld() {\n    console.log('hello');\n}\n"
        let inspection = EditorBufferInspection(
            editor: editor,
            windowTitle: "hello.ts — juno",
            documentPath: "/Users/dev/juno/src/hello.ts",
            textBuffer: sampleBuffer,
            selectedText: "helloWorld",
            cursorOffset: 9,
            characterCount: sampleBuffer.count,
            lineCount: 4
        )

        XCTAssertEqual(inspection.windowTitle, "hello.ts — juno")
        XCTAssertEqual(inspection.documentPath, "/Users/dev/juno/src/hello.ts")
        XCTAssertEqual(inspection.selectedText, "helloWorld")
        XCTAssertEqual(inspection.cursorOffset, 9)
        XCTAssertEqual(inspection.characterCount, sampleBuffer.count)
        XCTAssertEqual(inspection.lineCount, 4)
    }

    func testAccessibilityEditorBufferReaderDoesNotCrash() {
        let reader = AccessibilityEditorBufferReader.shared
        _ = reader.isAccessibilityAuthorized()
        let editors = reader.runningEditors()
        XCTAssertNotNil(editors)
    }

    func testCustomMockReaderImplementsEditorBufferReading() async throws {
        struct MockReader: EditorBufferReading {
            func isAccessibilityAuthorized() -> Bool { true }
            func runningEditors() -> [EditorApplicationInfo] {
                [
                    EditorApplicationInfo(
                        bundleIdentifier: "com.apple.dt.Xcode",
                        localizedName: "Xcode",
                        processID: 4321,
                        kind: .xcode
                    )
                ]
            }
            func inspectActiveEditor() async throws -> EditorBufferInspection? {
                EditorBufferInspection(
                    editor: runningEditors()[0],
                    windowTitle: "JunoNativeKit — Package.swift",
                    documentPath: "/Users/dev/juno/native/Packages/JunoNativeKit/Package.swift",
                    textBuffer: "// swift-tools-version: 6.0\n",
                    lineCount: 2
                )
            }
            func inspectEditor(bundleIdentifier: String) async throws -> EditorBufferInspection? {
                try await inspectActiveEditor()
            }
        }

        let mock = MockReader()
        XCTAssertTrue(mock.isAccessibilityAuthorized())
        let inspection = try await mock.inspectActiveEditor()
        XCTAssertEqual(inspection?.editor.bundleIdentifier, "com.apple.dt.Xcode")
        XCTAssertEqual(inspection?.windowTitle, "JunoNativeKit — Package.swift")
        XCTAssertEqual(inspection?.lineCount, 2)
    }
}
