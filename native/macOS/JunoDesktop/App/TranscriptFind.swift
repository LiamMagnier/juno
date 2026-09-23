import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// What ⌘F, ⌘G and ⇧⌘G ask the conversation column to do.
struct DesktopFindCommand: Equatable {
    enum Kind: Equatable { case open, next, previous }
    let id = UUID()
    let kind: Kind
}

/// Find in this conversation: the query, every match in reading order, and
/// which one is current.
///
/// **Counted over what is drawn**, message by message, through the same
/// functions the prose highlights with (``JunoFindText``) — the reader's
/// bubble as its plain text, a reply's prose runs as the reading style renders
/// them (inline Markdown resolved, citations as their chips). Artifacts,
/// diagrams and the run's own words are not searched: they are not the
/// conversation's text.
@MainActor
@Observable
final class TranscriptFindModel {
    struct Match: Equatable {
        let messageID: String
        /// This match's place among its message's matches.
        let ordinal: Int
    }

    var isOpen = false
    var query = ""
    private(set) var matches: [Match] = []
    private(set) var current: Int?
    /// Bumped by ⌘F while the bar is open, to put the caret back in it.
    private(set) var focusRequest = 0
    /// The messages last counted, so a query change can recount them.
    @ObservationIgnored private var messages: [NativeChatMessage] = []

    var currentMatch: Match? {
        current.flatMap { matches.indices.contains($0) ? matches[$0] : nil }
    }

    func open() {
        if isOpen { focusRequest += 1 }
        isOpen = true
    }

    func close() {
        isOpen = false
        query = ""
        matches = []
        current = nil
    }

    /// Recounts when the query or the transcript changes. The current match
    /// stays on its message where it can.
    func update(messages: [NativeChatMessage]) {
        self.messages = messages
        recount()
    }

    func recount() {
        let previous = currentMatch
        guard isOpen, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            matches = []
            current = nil
            return
        }
        var found: [Match] = []
        for message in messages {
            let count = Self.count(of: query, in: message)
            found += (0..<count).map { Match(messageID: message.id, ordinal: $0) }
        }
        matches = found
        if found.isEmpty {
            current = nil
        } else if let previous, let same = found.firstIndex(of: previous) {
            current = same
        } else {
            current = 0
        }
    }

    func next() {
        guard !matches.isEmpty else { return }
        current = ((current ?? -1) + 1) % matches.count
    }

    func previous() {
        guard !matches.isEmpty else { return }
        current = ((current ?? 0) - 1 + matches.count) % matches.count
    }

    /// The highlight a message's text is drawn with.
    func highlight(for messageID: String) -> JunoFindHighlight? {
        guard isOpen, !matches.isEmpty else { return nil }
        let currentOrdinal = currentMatch.flatMap { $0.messageID == messageID ? $0.ordinal : nil }
        return JunoFindHighlight(query: query, current: currentOrdinal)
    }

    /// Matches in one message, in the order its row draws them.
    static func count(of query: String, in message: NativeChatMessage) -> Int {
        switch message.role {
        case .user:
            return JunoFindText.count(of: query, in: NativeMessageContent.plainText(of: message.content))
        case .assistant:
            let citations = DesktopMessageRow.citationCount(of: message)
            return DesktopMessageRow.textParts(of: message).reduce(0) { total, text in
                total + JunoFindText.count(of: query, inLesson: text, citations: citations)
            }
        case .system, .tool:
            return 0
        }
    }
}
