import Foundation
import JunoWorkCore

// Work in a folder, from chat: the values the chat's folder tools are made
// of. The server names a tool and its arguments (src/lib/chat/local-folder.ts);
// ``ChatFolderExecutor`` runs it against one granted folder, asking the person
// first where it must.

/// The folder tools, by the ids the server sends.
public enum ChatFolderTool: String, CaseIterable, Sendable {
    case listDir = "folder_list_dir"
    case readFile = "folder_read_file"
    case search = "folder_search"
    case writeFile = "folder_write_file"
    case editFile = "folder_edit_file"
    case move = "folder_move"
    case makeDir = "folder_make_dir"
    case delete = "folder_delete"
    case runCommand = "folder_run_command"
    case open = "folder_open"

    /// Whether the tool changes the folder or acts on the Mac.
    public var changesSomething: Bool {
        switch self {
        case .listDir, .readFile, .search, .open: false
        case .writeFile, .editFile, .move, .makeDir, .delete, .runCommand: true
        }
    }
}

/// One argument as the server sent it.
public enum ChatFolderArgument: Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
}

/// One call, as the chat hands it over.
public struct ChatFolderCall: Equatable, Sendable {
    public let id: String
    public let tool: String
    public let arguments: [String: ChatFolderArgument]

    public init(id: String, tool: String, arguments: [String: ChatFolderArgument]) {
        self.id = id
        self.tool = tool
        self.arguments = arguments
    }

    func string(_ key: String) -> String? {
        if case .string(let value)? = arguments[key] { return value }
        return nil
    }

    func integer(_ key: String) -> Int? {
        switch arguments[key] {
        case .number(let value)?: Int(exactly: value.rounded())
        case .string(let value)?: Int(value)
        default: nil
        }
    }

    func flag(_ key: String) -> Bool {
        if case .bool(let value)? = arguments[key] { return value }
        return false
    }
}

/// How the folder was shared. Two answers a person can hold in their head:
/// look only, or look and change.
public enum ChatFolderAccess: String, Codable, CaseIterable, Sendable {
    case read
    case readWrite = "read_write"

    /// The Work mode that enforces it. Read/write includes moving to the
    /// Trash, which every delete still asks about.
    public var workMode: WorkAccessMode {
        switch self {
        case .read: .read
        case .readWrite: .readWrite
        }
    }
}

/// The kinds of action that stop and ask. "Always for this folder" remembers
/// a kind, never a single file or command string — the person is answering
/// "may it do this sort of thing here", which is what they can judge.
public enum ChatFolderApprovalKind: String, Codable, CaseIterable, Sendable {
    /// Replacing or editing a file that already exists.
    case replace
    /// Moving something to the Trash.
    case delete
    /// Running a shell command.
    case command
    /// Opening a file or an app on the Mac.
    case open
}

/// What the person is asked, on the card in the chat.
public struct ChatFolderApprovalRequest: Identifiable, Equatable, Sendable {
    /// The call's id: one card per call.
    public let id: String
    public let kind: ChatFolderApprovalKind
    /// The folder's display name.
    public let folderName: String
    /// The question, one line: "Delete march.csv?".
    public let title: String
    /// What exactly would happen: the folder-relative path, the command and
    /// where it starts, or the start of an edit. Shown verbatim, in mono.
    public let detail: String
    /// One sentence on what it means, for the card's body.
    public let explanation: String

    public init(
        id: String,
        kind: ChatFolderApprovalKind,
        folderName: String,
        title: String,
        detail: String,
        explanation: String
    ) {
        self.id = id
        self.kind = kind
        self.folderName = folderName
        self.title = title
        self.detail = detail
        self.explanation = explanation
    }
}

public enum ChatFolderApprovalDecision: String, Equatable, Sendable {
    case allowOnce
    /// Allow, and stop asking about this kind of action in this folder.
    case allowAlways
    case deny
}

/// How a call ended.
public struct ChatFolderResult: Equatable, Sendable {
    public enum Outcome: String, Equatable, Sendable {
        case succeeded
        case failed
        /// The person said no.
        case denied
    }

    public let outcome: Outcome
    /// What the model reads: the listing, the text, the output, or why not.
    public let output: String

    public init(outcome: Outcome, output: String) {
        self.outcome = outcome
        self.output = output
    }

    static func succeeded(_ output: String) -> Self { Self(outcome: .succeeded, output: output) }
    static func failed(_ output: String) -> Self { Self(outcome: .failed, output: output) }
}

// MARK: - What the Mac provides

/// A command to run in the folder.
public struct ChatFolderCommandRequest: Equatable, Sendable {
    public let command: String
    /// Canonical, and inside the grant.
    public let workingDirectory: URL
    /// The grant root, canonical: the one place the command may write.
    public let folderRoot: URL
    public let timeoutSeconds: Int
    public let outputLimitBytes: Int

    public init(command: String, workingDirectory: URL, folderRoot: URL, timeoutSeconds: Int, outputLimitBytes: Int) {
        self.command = command
        self.workingDirectory = workingDirectory
        self.folderRoot = folderRoot
        self.timeoutSeconds = timeoutSeconds
        self.outputLimitBytes = outputLimitBytes
    }
}

public struct ChatFolderCommandOutcome: Equatable, Sendable {
    public let exitCode: Int32?
    /// Standard output and error, interleaved as they arrived.
    public let output: String
    public let timedOut: Bool
    public let truncated: Bool
    /// False when the command ran without the kernel sandbox (no
    /// `sandbox-exec` on this Mac); the model is told.
    public let contained: Bool

    public init(exitCode: Int32?, output: String, timedOut: Bool, truncated: Bool, contained: Bool) {
        self.exitCode = exitCode
        self.output = output
        self.timedOut = timedOut
        self.truncated = truncated
        self.contained = contained
    }
}

/// The Mac's hands: what the executor cannot do with the file service alone.
/// The app supplies the real one (a contained shell, Launch Services, PDFKit);
/// tests supply a fake.
public protocol ChatFolderSystem: Sendable {
    func run(_ request: ChatFolderCommandRequest) async throws -> ChatFolderCommandOutcome
    /// Opens the item in its default app, or reveals it in Finder.
    func open(_ url: URL, reveal: Bool) async -> Bool
    /// The text of a document that is not plain text (PDF, Word, RTF), or nil.
    func extractText(from url: URL) async -> String?
}
