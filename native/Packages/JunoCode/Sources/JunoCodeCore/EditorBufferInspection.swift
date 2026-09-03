import Foundation

/// Supported editor families recognized by Juno's "Work with Apps" accessibility reader.
public enum EditorApplicationKind: Hashable, Codable, Sendable {
    case xcode
    case vscode
    case cursor
    case windsurf
    case jetbrains(String)
    case sublime
    case other(String)

    public var displayName: String {
        switch self {
        case .xcode: return "Xcode"
        case .vscode: return "VS Code"
        case .cursor: return "Cursor"
        case .windsurf: return "Windsurf"
        case .jetbrains(let name): return "JetBrains \(name)"
        case .sublime: return "Sublime Text"
        case .other(let name): return name
        }
    }
}

/// Metadata identifying a running editor application process.
public struct EditorApplicationInfo: Hashable, Codable, Sendable, Identifiable {
    public var id: String { "\(bundleIdentifier):\(processID)" }
    public let bundleIdentifier: String
    public let localizedName: String
    public let processID: pid_t
    public let kind: EditorApplicationKind

    public init(
        bundleIdentifier: String,
        localizedName: String,
        processID: pid_t,
        kind: EditorApplicationKind
    ) {
        self.bundleIdentifier = bundleIdentifier
        self.localizedName = localizedName
        self.processID = processID
        self.kind = kind
    }
}

/// A non-intrusive snapshot of an active editor window and text buffer.
public struct EditorBufferInspection: Hashable, Codable, Sendable {
    public let editor: EditorApplicationInfo
    public let windowTitle: String?
    public let documentPath: String?
    public let textBuffer: String?
    public let selectedText: String?
    public let cursorOffset: Int?
    public let characterCount: Int?
    public let lineCount: Int?
    public let timestamp: Date

    public init(
        editor: EditorApplicationInfo,
        windowTitle: String? = nil,
        documentPath: String? = nil,
        textBuffer: String? = nil,
        selectedText: String? = nil,
        cursorOffset: Int? = nil,
        characterCount: Int? = nil,
        lineCount: Int? = nil,
        timestamp: Date = Date()
    ) {
        self.editor = editor
        self.windowTitle = windowTitle
        self.documentPath = documentPath
        self.textBuffer = textBuffer
        self.selectedText = selectedText
        self.cursorOffset = cursorOffset
        self.characterCount = characterCount
        self.lineCount = lineCount
        self.timestamp = timestamp
    }
}

public enum EditorBufferError: Error, Equatable, Sendable {
    case accessibilityPermissionDenied
    case editorNotFound(String)
    case windowNotFound(String)
    case bufferUnavailable(String)
}

/// Non-intrusive reader for active editor buffers and window state.
public protocol EditorBufferReading: Sendable {
    /// Returns true if macOS Accessibility API permissions are currently granted.
    func isAccessibilityAuthorized() -> Bool

    /// Discovers all running supported editor applications.
    func runningEditors() -> [EditorApplicationInfo]

    /// Inspects the frontmost / active editor buffer non-intrusively.
    func inspectActiveEditor() async throws -> EditorBufferInspection?

    /// Inspects an editor identified by its bundle identifier.
    func inspectEditor(bundleIdentifier: String) async throws -> EditorBufferInspection?
}
