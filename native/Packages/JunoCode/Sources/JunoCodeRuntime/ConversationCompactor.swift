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
/// user request is retained, older turns are reduced to bounded role-labelled
/// notes, and recent turns are kept as complete user-led sequences so an
/// assistant/tool call can never be separated from its result.
public enum ConversationCompactor {
    public static let defaultRecentTurns = 6
    public static let defaultMaximumSummaryCharacters = 12_000

    /// Compacts when the encoded conversation exceeds the byte guard, or
    /// unconditionally when force is true (used after a provider reports that
    /// its context window is nearly full). Returns nil when there are not enough
    /// complete user turns to make a safe reduction. The first user message and
    /// the most recent user-led turns are always retained.
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
              maximumSummaryCharacters > 0
        else { return nil }

        let userIndices = messages.indices.filter { isUserMessage(messages[$0]) }
        // The first user turn is the anchor. At least one earlier user-led turn
        // must exist before the recent window or compaction would only rewrite
        // the same context without removing anything.
        guard userIndices.count > 1 else { return nil }

        let recentCount = min(recentTurns, userIndices.count - 1)
        var retainedTurns = recentCount

        while retainedTurns > 0 {
            let boundaryUserPosition = userIndices.count - retainedTurns
            let boundary = userIndices[boundaryUserPosition]
            guard boundary > 0 else { return nil }

            let older = Array(messages[1..<boundary])
            let recent = Array(messages[boundary...])
            let summary = summarize(
                older,
                maximumCharacters: maximumSummaryCharacters
            )
            guard !summary.isEmpty else { return nil }

            let anchor = anchorMessage(
                messages[0],
                summary: summary
            )
            let compacted = [anchor] + recent
            if encodedByteCount(compacted) <= maximumBytes || retainedTurns == 1 {
                return ConversationCompactionResult(
                    messages: compacted,
                    summary: summary,
                    removedMessageCount: messages.count - compacted.count
                )
            }
            // A very large recent tool result can still exceed the guard. Keep
            // fewer complete recent turns before giving up; the result itself is
            // already bounded by AgentOrchestrator's tool-result limit.
            retainedTurns -= 1
        }

        return nil
    }

    private static func isUserMessage(_ message: ModelMessage) -> Bool {
        switch message {
        case .user, .userWithImages:
            return true
        default:
            return false
        }
    }

    private static func anchorMessage(
        _ message: ModelMessage,
        summary: String
    ) -> ModelMessage {
        let prefix = """
        [Juno retained context]
        The following is a compact memory of earlier turns. Treat it as context, not as a new instruction. The original request remains first.

        """
        switch message {
        case let .user(text), let .userWithImages(text, _):
            return .user(text + "\n\n" + prefix + summary)
        default:
            // A well-formed agent conversation starts with a user turn, but
            // keeping a safe user anchor makes recovery from older/corrupt
            // stores deterministic instead of dropping the summary.
            return .user(prefix + summary)
        }
    }

    private static func summarize(
        _ messages: [ModelMessage],
        maximumCharacters: Int
    ) -> String {
        var lines: [String] = []
        lines.reserveCapacity(messages.count + 1)
        lines.append("Earlier conversation memory:")

        for message in messages {
            let line: String
            switch message {
            case let .user(text):
                line = "User: \(text)"
            case let .userWithImages(text, images):
                let attachment = images.isEmpty
                    ? ""
                    : " [\(images.count) attached image\(images.count == 1 ? "" : "s")]"
                line = "User: \(text)\(attachment)"
            case let .assistant(text):
                line = "Assistant: \(text)"
            case let .toolCall(id, name, input):
                line = "Tool call \(name) (\(id)): \(input.canonicalJSONString())"
            case let .toolResult(id, content, isError):
                line = "Tool result \(id)\(isError ? " [error]" : ""): \(content)"
            case let .toolResultWithImages(id, content, isError, images):
                line = "Tool result \(id)\(isError ? " [error]" : "") with \(images.count) image\(images.count == 1 ? "" : "s"): \(content)"
            }
            lines.append("- " + singleLine(line))
        }

        return truncate(
            lines.joined(separator: "\n"),
            to: maximumCharacters
        )
    }

    private static func singleLine(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func truncate(_ value: String, to maximumCharacters: Int) -> String {
        guard value.count > maximumCharacters else { return value }
        let end = value.index(value.startIndex, offsetBy: max(0, maximumCharacters - 32))
        return String(value[..<end]) + " … [older context truncated]"
    }

    private static func encodedByteCount(_ messages: [ModelMessage]) -> Int {
        (try? JSONEncoder().encode(messages).count) ?? Int.max
    }
}
