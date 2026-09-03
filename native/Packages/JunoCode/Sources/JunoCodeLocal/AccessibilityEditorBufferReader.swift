import AppKit
import ApplicationServices
import Foundation
import JunoCodeCore

/// macOS Accessibility AXUIElement Editor Buffer Reader ("Work with Apps").
///
/// Non-intrusively inspects active editor (VS Code, Xcode, JetBrains, Cursor, Windsurf)
/// window titles, document paths, and text buffers without injecting keystrokes or moving focus.
public final class AccessibilityEditorBufferReader: EditorBufferReading, @unchecked Sendable {
    public static let shared = AccessibilityEditorBufferReader()
    public static let maxTextBufferChars = 50_000

    public init() {}

    public func isAccessibilityAuthorized() -> Bool {
        AXIsProcessTrusted()
    }

    public func runningEditors() -> [EditorApplicationInfo] {
        let apps = NSWorkspace.shared.runningApplications
        var results: [EditorApplicationInfo] = []

        for app in apps {
            guard let bundleID = app.bundleIdentifier else { continue }
            if let kind = classifyEditor(bundleID: bundleID) {
                results.append(
                    EditorApplicationInfo(
                        bundleIdentifier: bundleID,
                        localizedName: app.localizedName ?? kind.displayName,
                        processID: app.processIdentifier,
                        kind: kind
                    )
                )
            }
        }

        return results
    }

    public func inspectActiveEditor() async throws -> EditorBufferInspection? {
        guard isAccessibilityAuthorized() else {
            throw EditorBufferError.accessibilityPermissionDenied
        }

        // Check frontmost application first
        if let frontmost = NSWorkspace.shared.frontmostApplication,
           let bundleID = frontmost.bundleIdentifier,
           let kind = classifyEditor(bundleID: bundleID) {
            let info = EditorApplicationInfo(
                bundleIdentifier: bundleID,
                localizedName: frontmost.localizedName ?? kind.displayName,
                processID: frontmost.processIdentifier,
                kind: kind
            )
            return try inspectApplication(info)
        }

        // Otherwise check running editors
        let editors = runningEditors()
        guard let firstEditor = editors.first else {
            return nil
        }

        return try inspectApplication(firstEditor)
    }

    public func inspectEditor(bundleIdentifier: String) async throws -> EditorBufferInspection? {
        guard isAccessibilityAuthorized() else {
            throw EditorBufferError.accessibilityPermissionDenied
        }

        let editors = runningEditors()
        guard let match = editors.first(where: { $0.bundleIdentifier == bundleIdentifier }) else {
            throw EditorBufferError.editorNotFound("Editor with bundle identifier '\(bundleIdentifier)' is not running.")
        }

        return try inspectApplication(match)
    }

    // MARK: - AX Inspection Implementation

    private func inspectApplication(_ info: EditorApplicationInfo) throws -> EditorBufferInspection {
        let appRef = AXUIElementCreateApplication(info.processID)

        // Find active/focused window
        var windowRef: AXUIElement?
        if let focusedWin: AXUIElement = copyAXValue(appRef, attribute: kAXFocusedWindowAttribute) {
            windowRef = focusedWin
        } else if let mainWin: AXUIElement = copyAXValue(appRef, attribute: kAXMainWindowAttribute) {
            windowRef = mainWin
        } else if let windows: [AXUIElement] = copyAXValue(appRef, attribute: kAXWindowsAttribute), let first = windows.first {
            windowRef = first
        }

        guard let window = windowRef else {
            throw EditorBufferError.windowNotFound("No active window found for \(info.localizedName).")
        }

        // Window Title
        let windowTitle: String? = copyAXValue(window, attribute: kAXTitleAttribute)

        // Document URL/path
        var documentPath: String?
        if let docValue: String = copyAXValue(window, attribute: kAXDocumentAttribute) {
            if let url = URL(string: docValue), url.isFileURL {
                documentPath = url.path
            } else {
                documentPath = docValue
            }
        }

        // Focused element / Text Buffer
        var textBuffer: String?
        var selectedText: String?
        var cursorOffset: Int?

        let focusedElement: AXUIElement? = copyAXValue(appRef, attribute: kAXFocusedUIElementAttribute)
        let elementToRead = focusedElement ?? findFirstTextArea(in: window, maxDepth: 12)

        if let element = elementToRead {
            // Selected text
            if let sel: String = copyAXValue(element, attribute: kAXSelectedTextAttribute), !sel.isEmpty {
                selectedText = sel
            }

            // Selection range / cursor offset
            if let rangeVal = copyAXRef(element, attribute: kAXSelectedTextRangeAttribute) {
                if CFGetTypeID(rangeVal) == AXValueGetTypeID() {
                    let axVal = rangeVal as! AXValue
                    if AXValueGetType(axVal) == .cfRange {
                        var range = CFRange()
                        if AXValueGetValue(axVal, .cfRange, &range) {
                            cursorOffset = range.location != kCFNotFound ? range.location : nil
                        }
                    }
                }
            }

            // Full or visible text buffer
            if let rawText: String = copyAXValue(element, attribute: kAXValueAttribute) {
                let clamped = String(rawText.prefix(Self.maxTextBufferChars))
                textBuffer = clamped
            }
        }

        let charCount = textBuffer?.count
        let lineCount = textBuffer.map { buf in
            buf.split(separator: "\n", omittingEmptySubsequences: false).count
        }

        return EditorBufferInspection(
            editor: info,
            windowTitle: windowTitle,
            documentPath: documentPath,
            textBuffer: textBuffer,
            selectedText: selectedText,
            cursorOffset: cursorOffset,
            characterCount: charCount,
            lineCount: lineCount,
            timestamp: Date()
        )
    }

    private func findFirstTextArea(in element: AXUIElement, maxDepth: Int) -> AXUIElement? {
        guard maxDepth > 0 else { return nil }

        if let role: String = copyAXValue(element, attribute: kAXRoleAttribute) {
            if role == (kAXTextAreaRole as String) || role == (kAXTextFieldRole as String) {
                return element
            }
        }

        guard let children: [AXUIElement] = copyAXValue(element, attribute: kAXChildrenAttribute) else {
            return nil
        }

        for child in children {
            if let match = findFirstTextArea(in: child, maxDepth: maxDepth - 1) {
                return match
            }
        }

        return nil
    }

    // MARK: - Attribute Helpers

    private func copyAXValue<T>(_ element: AXUIElement, attribute: String) -> T? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard result == .success, let value else { return nil }
        return value as? T
    }

    private func copyAXRef(_ element: AXUIElement, attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard result == .success, let value else { return nil }
        return value
    }

    // MARK: - Editor Classifier

    private func classifyEditor(bundleID: String) -> EditorApplicationKind? {
        let id = bundleID.lowercased()

        if id == "com.apple.dt.xcode" {
            return .xcode
        }
        if id == "com.microsoft.vscode" || id == "com.microsoft.vscodeinsiders" || id == "com.vscodium" {
            return .vscode
        }
        if id == "com.cursor.cursor" || id.contains("cursor") {
            return .cursor
        }
        if id.contains("windsurf") {
            return .windsurf
        }
        if id.contains("jetbrains") || id.contains("intellij") || id.contains("pycharm") ||
           id.contains("webstorm") || id.contains("clion") || id.contains("goland") ||
           id.contains("rider") || id.contains("android.studio") {
            let parts = id.components(separatedBy: ".")
            let name = parts.last?.capitalized ?? "IDE"
            return .jetbrains(name)
        }
        if id.contains("sublimetext") {
            return .sublime
        }

        return nil
    }
}
