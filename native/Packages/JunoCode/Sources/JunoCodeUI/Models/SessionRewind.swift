import Foundation
import JunoCodeCore
import JunoCodeRuntime

/// What a rewind puts back: the three choices Claude Code made familiar.
public enum RewindScope: String, CaseIterable, Identifiable, Sendable {
    case codeAndConversation
    case conversation
    case code

    public var id: String { rawValue }

    public var restoresCode: Bool { self != .conversation }
    public var restoresConversation: Bool { self != .code }

    public var title: String {
        switch self {
        case .codeAndConversation: "Restore code and conversation"
        case .conversation: "Restore conversation"
        case .code: "Restore code"
        }
    }

    /// One sentence on what stays and what goes.
    public var detail: String {
        switch self {
        case .codeAndConversation:
            "Files go back to how they were, and the thread ends before this message."
        case .conversation:
            "The thread ends before this message. Files stay as they are."
        case .code:
            "Files go back to how they were. The thread stays as it is."
        }
    }
}

/// What rewinding to one of the reader's messages would do, for the
/// confirmation that asks.
public struct RewindPreview: Equatable, Sendable {
    public let turn: ConversationTurn
    /// The files a code restore would change. Empty when every file the turns
    /// touched is already as it was.
    public let files: [TurnRestoreFile]
    /// Why code cannot be restored to this message; nil when it can.
    public let codeUnavailable: String?
    /// Why the conversation cannot be rewound to this message; nil when it can.
    public let conversationUnavailable: String?

    public init(
        turn: ConversationTurn,
        files: [TurnRestoreFile],
        codeUnavailable: String?,
        conversationUnavailable: String?
    ) {
        self.turn = turn
        self.files = files
        self.codeUnavailable = codeUnavailable
        self.conversationUnavailable = conversationUnavailable
    }

    /// Why a choice cannot be made, or nil when it can.
    ///
    /// Code and conversation together is all-or-nothing: offering it when
    /// only half can happen would restore files under a thread that still
    /// shows the turns that wrote them.
    public func unavailableReason(_ scope: RewindScope) -> String? {
        switch scope {
        case .codeAndConversation:
            codeUnavailable ?? conversationUnavailable
        case .conversation:
            conversationUnavailable
        case .code:
            codeUnavailable ?? (files.isEmpty ? "No file has changed since this message." : nil)
        }
    }

    /// The line under a choice: why it cannot be made, or what it will do
    /// here — which, with no file to put back, is only the conversation half.
    public func detail(_ scope: RewindScope) -> String {
        if let reason = unavailableReason(scope) { return reason }
        if scope == .codeAndConversation, files.isEmpty {
            return "The thread ends before this message. No file has changed since it."
        }
        return scope.detail
    }

    /// Files holding edits Juno's own tools did not make.
    public var divergedPaths: [String] {
        files.filter(\.hasDiverged).map(\.path.value)
    }
}

/// How a rewind ended.
public enum RewindOutcome: Equatable, Sendable {
    /// Done. `restoredPaths` are the files a code restore changed.
    case rewound(restoredPaths: [String])
    /// These files hold edits Juno's tools did not make, and nothing was
    /// touched. Rewinding again with `force` is the reader's "Restore Anyway".
    case diverged(paths: [String])
    case failed(message: String)
}

/// The sentences a rewind says when it cannot do something. Written for the
/// person reading the confirmation, not for a log.
enum RewindCopy {
    static let noProject = "This conversation has no project, so there are no files to restore."
    static let running = "Juno is working. Stop it before rewinding."
    static let compacting = "Juno is compacting the conversation. Rewind once it has finished, or stop it."
    static let preview = "Preview mode does not rewind."
    /// What a message, a `/compact` or a second rewind is told while a rewind
    /// is cutting the session back.
    static let inProgress = "This session is being rewound. Try again once the rewind has finished."
    /// The limit every rewind shares with Claude Code's: Juno sees the files
    /// its own tools write, and nothing a command writes. The exception is a
    /// file its tools also changed, which goes back whole — a command's edit
    /// to it included, once the divergence question has been answered.
    static let untracked = "Edits made by shell commands aren't tracked and stay as they are, unless Juno's tools also changed that file: restoring it undoes those edits too."

    static func message(for error: TurnCheckpointError) -> String {
        switch error {
        case .notRecorded:
            "Juno has no file snapshots from this message."
        case .incomplete(.pruned):
            "Older file snapshots were cleared to save space, so code can't go back this far."
        case .incomplete(.notCaptured):
            "A file changed after this message was too large to snapshot, so code can't go back this far."
        case let .diverged(paths):
            paths.count == 1
                ? "A file was edited outside Juno."
                : "\(paths.count) files were edited outside Juno."
        case let .restoreFailed(path, message):
            "Could not restore \(path): \(message)"
        }
    }

    static func message(for error: ConversationRewindError) -> String {
        switch error {
        case .turnNotFound:
            "This message is no longer in the conversation."
        case .notRecorded:
            "This message was sent before Juno kept rewind points."
        case .summarized:
            "This message was folded into a summary when the context was compacted."
        case .outOfSync:
            "The saved conversation doesn't line up with the thread here, so it can't be rewound safely."
        }
    }

    static func message(for error: any Error) -> String {
        if let error = error as? ConversationRewindError { return message(for: error) }
        if let error = error as? TurnCheckpointError { return message(for: error) }
        return error.localizedDescription
    }
}
