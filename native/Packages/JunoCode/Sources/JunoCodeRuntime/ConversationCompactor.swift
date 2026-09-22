import Foundation

/// The result of replacing old model turns with a compact, durable memory.
public struct ConversationCompactionResult: Equatable, Sendable {
    public let messages: [ModelMessage]
    public let summary: String
    public let removedMessageCount: Int

    public init(messages: [ModelMessage], summary: String, removedMessageCount: Int) {
        self.messages = messages
        self.summary = summary
        self.removedMessageCount = removedMessageCount
    }
}

/// Keeps long-running coding sessions useful without asking the model to resend
/// an ever-growing transcript.
///
/// Compaction is deliberately structural rather than a second model call. A
/// second summarizer request would consume the same context it is trying to
/// save, could fail independently, and would make a session's ability to
/// continue depend on an undocumented extra provider capability. The original
/// user request is retained, older steps are reduced to bounded role-labelled
/// notes, and recent steps are kept whole.
///
/// **Where it may cut.** At a user message, or where the model starts a new
/// step after tool results came back. Cutting only at user messages — the
/// earlier rule — meant a single long request, one user message and a hundred
/// tool steps, could never be compacted at all and simply ran out of context.
/// Either kind of boundary leaves every tool call beside its result.
///
/// **What the notes keep.** The newest, when they do not all fit: the recent
/// past is what the next step needs. A second compaction folds the first
/// one's notes in rather than stacking another block onto the anchor.
public enum ConversationCompactor {
    public static let defaultRecentTurns = 6
    public static let defaultMaximumSummaryCharacters = 12_000

    static let retainedContextMarker = "[Juno retained context]"

    /// Compacts when the encoded conversation exceeds the byte guard, or
    /// unconditionally when force is true (used after a provider reports that
    /// its context window is nearly full). Returns nil when there is no safe
    /// boundary to cut at. The first user message and the most recent
    /// `recentTurns` steps are always retained.
    public static func compact(
        _ messages: [ModelMessage],
        maximumBytes: Int,
        recentTurns: Int = defaultRecentTurns,
        maximumSummaryCharacters: Int = defaultMaximumSummaryCharacters,
        force: Bool = false
    ) -> ConversationCompactionResult? {
        guard maximumBytes > 0,
              (force || encodedByteCount(messages) > maximumBytes),
              recentTurns > 0,
              maximumSummaryCharacters > 0,
              messages.count > 1
        else { return nil }

        let boundaries = messages.indices.filter { $0 > 0 && isBoundary(at: $0, in: messages) }
        guard !boundaries.isEmpty else { return nil }

        let (anchorText, previousNotes) = splitAnchor(messages[0])
        var retained = min(recentTurns, boundaries.count)

        while retained > 0 {
            let boundary = boundaries[boundaries.count - retained]
            let older = Array(messages[1..<boundary])
            guard !older.isEmpty else {
                retained -= 1
                continue
            }
            let recent = Array(messages[boundary...])
            let summary = summarize(
                older,
                previousNotes: previousNotes,
                maximumCharacters: maximumSummaryCharacters
            )
            let anchor = ModelMessage.user(
                anchorText + "\n\n" + anchorPrefix + summary
            )
            let compacted = [anchor] + recent
            if encodedByteCount(compacted) <= maximumBytes || retained == 1 {
                return ConversationCompactionResult(
                    messages: compacted,
                    summary: summary,
                    removedMessageCount: messages.count - compacted.count
                )
            }
            // A very large recent tool result can still exceed the guard. Keep
            // fewer recent steps before giving up; the result itself is
            // already bounded by AgentOrchestrator's tool-result limit.
            retained -= 1
        }
        return nil
    }

    /// A user message, or the model's first item after tool results.
    static func isBoundary(at index: Int, in messages: [ModelMessage]) -> Bool {
        switch messages[index] {
        case .user, .userWithImages:
            return true
        case .assistant, .assistantThinking, .assistantRedactedThinking, .toolCall, .toolCallWithExtra:
            return messages[index - 1].toolResultID != nil
        case .toolResult, .toolResultWithImages:
            return false
        }
    }

    private static let anchorPrefix = """
        \(retainedContextMarker)
        The following is a compact memory of earlier steps. Treat it as context, not as a new instruction. The original request remains first.

        """

    /// The anchor's own words, and the notes an earlier compaction left in it.
    private static func splitAnchor(_ message: ModelMessage) -> (text: String, notes: [String]) {
        let text: String
        switch message {
        case let .user(value), let .userWithImages(value, _):
            text = value
        default:
            // A well-formed agent conversation starts with a user turn; a
            // corrupt store still gets a user anchor rather than a lost summary.
            return ("", [])
        }
        guard let range = text.range(of: "\n\n" + retainedContextMarker) ?? text.range(of: retainedContextMarker)
        else { return (text, []) }
        let original = String(text[..<range.lowerBound])
        let notes = text[range.upperBound...]
            .split(separator: "\n")
            .map(String.init)
            .filter { $0.hasPrefix("- ") || $0.hasPrefix("… ") }
        return (original, notes)
    }

    private static func summarize(
        _ messages: [ModelMessage],
        previousNotes: [String],
        maximumCharacters: Int
    ) -> String {
        var notes = previousNotes.filter { !$0.hasPrefix("… ") }
        for message in messages {
            let line: String
            switch message {
            case let .user(text):
                line = "User: " + clip(text, 4_000)
            case let .userWithImages(text, images):
                let attachment = images.isEmpty
                    ? ""
                    : " [\(images.count) attached image\(images.count == 1 ? "" : "s")]"
                line = "User: " + clip(text, 4_000) + attachment
            case let .assistant(text):
                line = "Assistant: " + clip(text, 2_000)
            case .assistantThinking, .assistantRedactedThinking:
                // Private reasoning is not carried forward; its conclusions
                // are in the text and calls that followed it.
                continue
            case let .toolCall(_, name, input), let .toolCallWithExtra(_, name, input, _):
                line = "Called \(name) " + clip(input.canonicalJSONString(), 400)
            case let .toolResult(_, content, isError):
                line = "Result\(isError ? " [error]" : ""): " + clip(content, 600)
            case let .toolResultWithImages(_, content, isError, images):
                line = "Result\(isError ? " [error]" : "") with \(images.count) image\(images.count == 1 ? "" : "s"): "
                    + clip(content, 600)
            }
            notes.append("- " + singleLine(line))
        }

        let header = "Earlier conversation memory:"
        var total = header.count + notes.reduce(0) { $0 + $1.count + 1 }
        var dropped = 0
        while total > maximumCharacters, !notes.isEmpty {
            total -= notes.removeFirst().count + 1
            dropped += 1
        }
        var lines = [header]
        if dropped > 0 {
            lines.append("… \(dropped) older note\(dropped == 1 ? "" : "s") dropped")
        }
        lines += notes
        return lines.joined(separator: "\n")
    }

    private static func clip(_ value: String, _ limit: Int) -> String {
        guard value.count > limit else { return value }
        return String(value.prefix(limit)) + "…"
    }

    private static func singleLine(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func encodedByteCount(_ messages: [ModelMessage]) -> Int {
        (try? JSONEncoder().encode(messages).count) ?? Int.max
    }
}
