import Foundation

/// What was on screen, small enough to write every few seconds: which product
/// the window showed, the conversation or Code session it was on, and the
/// words typed and not yet sent.
///
/// Read back only after an unclean exit. A clean quit opens the app on its
/// ordinary launch surface, as it always has.
///
/// A private (incognito) chat is never recorded: not its id, not its draft.
public struct JunoSessionSnapshot: Codable, Sendable, Equatable {
    /// Bumped when the shape changes; an older or newer file is ignored
    /// rather than half-read.
    public static let currentVersion = 1
    /// The longest draft kept. A larger one is cut, never dropped.
    public static let draftLimit = 20_000

    public enum Product: String, Codable, Sendable {
        case chat
        case code
    }

    public var version: Int
    public var savedAt: Date
    public var product: Product
    /// The conversation open in Chat, or nil for a new chat.
    public var conversationID: String?
    /// The Code session selected in Code.
    public var codeSessionID: String?
    /// The unsent draft, and the conversation it belongs to (nil: a new chat).
    public var draft: Draft?

    public struct Draft: Codable, Sendable, Equatable {
        public var conversationID: String?
        public var text: String

        public init(conversationID: String?, text: String) {
            self.conversationID = conversationID
            self.text = String(text.prefix(JunoSessionSnapshot.draftLimit))
        }
    }

    public init(
        savedAt: Date = Date(timeIntervalSince1970: 0),
        product: Product = .chat,
        conversationID: String? = nil,
        codeSessionID: String? = nil,
        draft: Draft? = nil
    ) {
        self.version = Self.currentVersion
        self.savedAt = savedAt
        self.product = product
        self.conversationID = conversationID
        self.codeSessionID = codeSessionID
        self.draft = draft
    }

    /// Whether there is anything worth restoring.
    public var isEmpty: Bool {
        product == .chat && conversationID == nil && codeSessionID == nil && !hasDraft
    }

    public var hasDraft: Bool {
        guard let draft else { return false }
        return !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The draft for this conversation (nil: a new chat), if one was kept.
    public func draftText(for conversationID: String?) -> String? {
        guard hasDraft, let draft, draft.conversationID == conversationID else { return nil }
        return draft.text
    }

    /// The same snapshot with `savedAt` cleared: two snapshots that differ
    /// only in when they were taken are the same state.
    var state: JunoSessionSnapshot {
        var copy = self
        copy.savedAt = Date(timeIntervalSince1970: 0)
        return copy
    }

    /// Whether `other` moved somewhere — another product, conversation or
    /// session — rather than only changing the draft.
    func navigates(from other: JunoSessionSnapshot) -> Bool {
        product != other.product
            || conversationID != other.conversationID
            || codeSessionID != other.codeSessionID
    }
}

/// Writes the snapshot as the session changes, without writing on every
/// keystroke.
///
/// - A navigation (product, conversation, session) is written at once.
/// - A draft-only change is written if ``draftInterval`` has passed since the
///   last write; otherwise it is held, and ``flushIfDirty()`` (on a timer, and
///   when the app backgrounds or quits) writes it.
/// - Nothing is written when nothing changed.
///
/// Not thread-safe: the apps own one on the main actor.
public final class JunoSessionSnapshotRecorder {
    public static let defaultDraftInterval: TimeInterval = 3

    private let location: JunoRecoveryLocation
    private let fileSystem: any JunoRecoveryFileSystem
    private let now: @Sendable () -> Date
    private let draftInterval: TimeInterval

    public private(set) var current = JunoSessionSnapshot()
    private var written: JunoSessionSnapshot?
    private var lastWrite: Date?
    /// Off when the snapshot must not be touched — a test host, a preview.
    public var isEnabled = true

    public init(
        location: JunoRecoveryLocation,
        fileSystem: any JunoRecoveryFileSystem = JunoLiveRecoveryFileSystem(),
        draftInterval: TimeInterval = JunoSessionSnapshotRecorder.defaultDraftInterval,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.location = location
        self.fileSystem = fileSystem
        self.draftInterval = draftInterval
        self.now = now
    }

    /// Whether the latest state has not reached the disk yet.
    public var isDirty: Bool { written?.state != current.state }

    /// Applies a change and writes it if the rules above say so. Returns
    /// whether it wrote.
    @discardableResult
    public func update(_ change: (inout JunoSessionSnapshot) -> Void) -> Bool {
        var next = current
        change(&next)
        guard next.state != current.state else { return false }
        let navigated = next.navigates(from: current)
        current = next
        if navigated { return write() }
        guard let lastWrite else { return write() }
        return now().timeIntervalSince(lastWrite) >= draftInterval ? write() : false
    }

    /// Starts from the snapshot already on disk — the one a launch after an
    /// unclean exit is restoring — so the restored draft is kept by the next
    /// write instead of being lost to the empty launch surface.
    public func seed(_ snapshot: JunoSessionSnapshot) {
        current = snapshot
        written = snapshot
    }

    /// Writes the held change, if there is one.
    @discardableResult
    public func flushIfDirty() -> Bool {
        isDirty ? write() : false
    }

    private func write() -> Bool {
        guard isEnabled else { return false }
        var snapshot = current
        snapshot.savedAt = now()
        guard let data = try? JunoRecoveryCoding.encoder.encode(snapshot),
            (try? fileSystem.write(data, to: location.snapshot)) != nil
        else { return false }
        written = current
        lastWrite = snapshot.savedAt
        return true
    }
}

enum JunoRecoveryCoding {
    static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }
}
