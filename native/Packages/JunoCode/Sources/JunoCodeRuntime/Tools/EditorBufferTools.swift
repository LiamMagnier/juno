import Foundation
import JunoCodeCore

/// Agent-facing Accessibility editor inspection tool ("Work with Apps").
///
/// Non-intrusively inspects active IDE code buffers (Xcode, VS Code, Cursor, Windsurf, JetBrains)
/// using macOS Accessibility AXUIElement APIs without focus-stealing or synthetic keyboard events.
public struct InspectEditorBufferTool: CodeTool {
    private let reader: any EditorBufferReading

    public init(reader: any EditorBufferReading) {
        self.reader = reader
    }

    public let name = "inspect_active_editor"
    public let description =
        "Inspect the active editor or IDE (VS Code, Xcode, Cursor, Windsurf, JetBrains, Sublime) focused document, window title, cursor location, selection, and text buffer non-intrusively."

    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "bundle_identifier": [
                    "type": "string",
                    "description": "Optional bundle identifier of the editor to inspect (e.g. com.microsoft.VSCode, com.apple.dt.Xcode, com.cursor.cursor). If omitted, inspects the frontmost active editor.",
                ],
            ],
            "required": [],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }
    public func summary(input: JSONValue) -> String { "Inspect active editor code buffer" }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard reader.isAccessibilityAuthorized() else {
            return ToolResult(
                content: "macOS Accessibility permission is required to inspect editor buffers non-intrusively. Please grant Accessibility permissions in System Settings -> Privacy & Security -> Accessibility."
            )
        }

        let bundleID = input["bundle_identifier"]?.stringValue
        let inspection: EditorBufferInspection?

        if let bundleID, !bundleID.isEmpty {
            inspection = try await reader.inspectEditor(bundleIdentifier: bundleID)
        } else {
            inspection = try await reader.inspectActiveEditor()
        }

        guard let inspection else {
            let running = reader.runningEditors()
            if running.isEmpty {
                return ToolResult(content: "No supported editor (Xcode, VS Code, Cursor, Windsurf, JetBrains, Sublime Text) is currently running.")
            }
            let list = running.map { "\($0.localizedName) (\($0.bundleIdentifier))" }.joined(separator: ", ")
            return ToolResult(content: "No active editor buffer found. Running supported editors: \(list)")
        }

        var lines: [String] = [
            "Editor: \(inspection.editor.localizedName) (\(inspection.editor.bundleIdentifier), PID \(inspection.editor.processID))",
            "Window Title: \(inspection.windowTitle ?? "Unknown")",
            "Document Path: \(inspection.documentPath ?? "Unknown / Untitled")",
        ]

        if let charCount = inspection.characterCount, let lineCount = inspection.lineCount {
            lines.append("Buffer Metrics: \(lineCount) lines, \(charCount) characters")
        }

        if let cursor = inspection.cursorOffset {
            lines.append("Cursor Offset: \(cursor)")
        }

        if let selected = inspection.selectedText, !selected.isEmpty {
            lines.append("Selected Text:\n```\n\(selected)\n```")
        }

        if let text = inspection.textBuffer, !text.isEmpty {
            lines.append("Buffer Content:\n```\n\(text)\n```")
        } else {
            lines.append("Buffer Content: [Empty or not accessible via AX API]")
        }

        return ToolResult(content: lines.joined(separator: "\n\n"))
    }
}
