import Foundation
import Observation
import JunoCodeCore

/// A note the reader wrote on one line of the diff, waiting to go to Juno
/// with their next message (CODE_AGENT_SPEC §5.10).
public struct QueuedReviewComment: Identifiable, Hashable, Codable, Sendable {
    public let id: UUID
    public let path: String
    /// The line in the new file; the old file's for a removed line.
    public let line: Int?
    /// Whether `line` counts in the old file (a removed line).
    public let isOldLine: Bool
    /// The line as it reads, quoted so the agent finds it without a read.
    public let quotedLine: String?
    public let text: String
    public let createdAt: Date

    public init(
        id: UUID = UUID(),
        path: String,
        line: Int?,
        isOldLine: Bool = false,
        quotedLine: String?,
        text: String,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.path = path
        self.line = line
        self.isOldLine = isOldLine
        self.quotedLine = quotedLine
        self.text = text
        self.createdAt = createdAt
    }

    /// `path:line`, the way the model and the reader both name a place.
    public var location: String {
        guard let line else { return path }
        return isOldLine ? "\(path):\(line) (removed line)" : "\(path):\(line)"
    }
}

/// Which changes the review shows.
public enum ReviewScope: String, CaseIterable, Identifiable, Sendable {
    /// The files Juno changed in this session, against what they were.
    case session
    /// Everything not committed, against `HEAD`.
    case uncommitted
    /// What is staged.
    case staged
    /// The branch, against its merge base with the default branch.
    case branch
    /// What the last turn changed.
    case lastTurn

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .session: "This session"
        case .uncommitted: "Uncommitted"
        case .staged: "Staged"
        case .branch: "Branch"
        case .lastTurn: "Last turn"
        }
    }
}

/// One file's diff in a review scope other than the session's own.
public struct ScopedReviewFile: Identifiable, Hashable, Sendable {
    public let path: String
    public let status: String
    public let diff: TextDiff
    public var id: String { path }

    public init(path: String, status: String, diff: TextDiff) {
        self.path = path
        self.status = status
        self.diff = diff
    }
}

/// The reader's review queue for a session: line comments waiting to be
/// sent, the reviewer's findings shown in the diff, the review scope, and the
/// pull request and its CI (CODE_AGENT_SPEC §5.10, §5.3). Held as
/// `SessionController.reviewQueue`; `SessionController.review` is the older
/// document-review state.
///
/// The comments and dismissed findings are saved with the session
/// (`review-queue.json`), so a note written before a relaunch is still
/// queued after it. Owned by Lane E (review, ship, sessions and away).
@MainActor
@Observable
public final class ReviewQueueModel {
    /// Notes waiting for the next message, in the order they were written.
    public private(set) var comments: [QueuedReviewComment] = []
    /// Findings the reader dismissed, by ``InlineFinding/key``.
    public private(set) var dismissedFindings: Set<String> = []
    /// Which changes the review shows.
    public var scope: ReviewScope = .session
    /// The files of a scope other than ``ReviewScope/session``, once loaded.
    public internal(set) var scopedFiles: [ScopedReviewFile] = []
    public internal(set) var isLoadingScope = false
    /// The last thing a review action has to say, in words: a failure, or
    /// what Keep did.
    public internal(set) var message: String?
    /// Hunks kept (staged) this session, by path and hunk identifier, so the
    /// diff can say so.
    public internal(set) var keptHunks: Set<String> = []
    /// The session's pull request and its CI.
    public let pullRequest = PullRequestModel()
    /// What the session can ask of its workbench (fork, archive), set when
    /// the workbench builds its controller; nil in a preview.
    @ObservationIgnored public var sessionActions: ShipSessionActions?

    @ObservationIgnored private var fileURL: URL?

    public init() {}

    public var hasComments: Bool { !comments.isEmpty }

    public func comments(for path: String) -> [QueuedReviewComment] {
        comments.filter { $0.path == path }
    }

    public func comments(for path: String, line: Int?, isOldLine: Bool) -> [QueuedReviewComment] {
        comments.filter { $0.path == path && $0.line == line && $0.isOldLine == isOldLine }
    }

    // MARK: Editing

    public func add(_ comment: QueuedReviewComment) {
        let text = comment.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        comments.append(QueuedReviewComment(
            id: comment.id,
            path: comment.path,
            line: comment.line,
            isOldLine: comment.isOldLine,
            quotedLine: comment.quotedLine,
            text: text,
            createdAt: comment.createdAt
        ))
        save()
    }

    public func remove(id: UUID) {
        comments.removeAll { $0.id == id }
        save()
    }

    public func discardAll() {
        comments.removeAll()
        save()
    }

    public func dismiss(_ finding: InlineFinding) {
        dismissedFindings.insert(finding.key)
        save()
    }

    public func clearMessage() {
        message = nil
    }

    // MARK: Sending

    /// What the next message carries: the reader's own text, then the queued
    /// comments as `path:line` blocks with the quoted line. The draft itself
    /// is not touched; the caller clears the queue with ``markSent(_:)`` once
    /// the message went.
    public struct Outgoing: Equatable, Sendable {
        public let prompt: String
        public let modelPrompt: String
        public let commentIDs: [UUID]
    }

    public func outgoing(prompt: String, modelPrompt: String) -> Outgoing {
        guard !comments.isEmpty else {
            return Outgoing(prompt: prompt, modelPrompt: modelPrompt, commentIDs: [])
        }
        let block = Self.render(comments)
        func joined(_ text: String) -> String {
            text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? block : text + "\n\n" + block
        }
        return Outgoing(prompt: joined(prompt), modelPrompt: joined(modelPrompt), commentIDs: comments.map(\.id))
    }

    /// Takes the sent comments off the queue; a comment written meanwhile
    /// stays for the next message.
    public func markSent(_ ids: [UUID]) {
        guard !ids.isEmpty else { return }
        let sent = Set(ids)
        comments.removeAll { sent.contains($0.id) }
        save()
    }

    /// The comments as the model reads them, grouped by file in the order they
    /// were written:
    ///
    /// ```
    /// Review comments on the diff:
    ///
    /// src/menu.tsx:41
    /// > onClick={toggle}
    /// Open on pointerdown instead.
    /// ```
    public static func render(_ comments: [QueuedReviewComment]) -> String {
        var lines = ["Review comments on the diff:"]
        var paths: [String] = []
        for comment in comments where !paths.contains(comment.path) {
            paths.append(comment.path)
        }
        for path in paths {
            for comment in comments where comment.path == path {
                lines.append("")
                lines.append(comment.location)
                if let quoted = comment.quotedLine,
                   !quoted.trimmingCharacters(in: .whitespaces).isEmpty
                {
                    lines.append("> \(quoted)")
                }
                lines.append(comment.text)
            }
        }
        return lines.joined(separator: "\n")
    }

    // MARK: Persistence

    private struct Saved: Codable {
        var comments: [QueuedReviewComment]
        var dismissedFindings: [String]
    }

    /// Reads the session's saved queue. Binding again to the same file does
    /// nothing, so the comments in memory are never overwritten by an older
    /// read.
    func bind(fileURL url: URL) {
        guard fileURL != url else { return }
        fileURL = url
        guard let data = try? Data(contentsOf: url),
              let saved = try? Self.decoder.decode(Saved.self, from: data)
        else {
            if !comments.isEmpty { save() }
            return
        }
        // Comments written before the bind, if any, follow the saved ones.
        let unsaved = comments.filter { comment in !saved.comments.contains { $0.id == comment.id } }
        comments = saved.comments + unsaved
        dismissedFindings.formUnion(saved.dismissedFindings)
        if !unsaved.isEmpty { save() }
    }

    var isBound: Bool { fileURL != nil }

    private func save() {
        guard let fileURL else { return }
        let saved = Saved(comments: comments, dismissedFindings: dismissedFindings.sorted())
        guard let data = try? Self.encoder.encode(saved) else { return }
        try? FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: fileURL, options: .atomic)
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
