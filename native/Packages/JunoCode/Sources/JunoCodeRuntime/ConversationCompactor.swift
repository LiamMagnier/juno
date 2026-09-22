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

/// Where a compaction cuts and what it folds, decided once, so whoever writes
/// the summary — the session's model or the structural notes — folds exactly
/// the same span and keeps exactly the same recent steps.
public struct ConversationCompactionPlan: Equatable, Sendable {
    /// The original request's own words, without any earlier memory.
    public let originalRequest: String
    /// What an earlier compaction left in the anchor, verbatim, or nil.
    public let earlierSummary: String?
    /// The messages this compaction removes, oldest first.
    public let folded: [ModelMessage]
    /// The newest messages, kept whole. Always starts at a safe boundary.
    public let recent: [ModelMessage]
    /// The structural summary of `folded`, computed up front so a model
    /// summary that fails has something to fall back to at no extra cost.
    public let structural: ConversationCompactionResult

    /// The compacted conversation with a model-written summary in the anchor.
    public func result(modelSummary: String) -> ConversationCompactionResult {
        let memory = ConversationCompactor.modelSummaryHeader + "\n" + modelSummary
        return ConversationCompactionResult(
            messages: [ConversationCompactor.anchor(originalRequest, memory: memory)] + recent,
            summary: modelSummary,
            removedMessageCount: structural.removedMessageCount
        )
    }
}

/// Keeps long-running coding sessions useful without asking the model to resend
/// an ever-growing transcript.
///
/// This type decides *where* to cut and writes the structural summary. The
/// session's own model writes a better one when it can
/// (``CompactionSummarizer``), but that call can fail, refuse, time out or be
/// stopped, and compaction must never be what fails a run — so every plan
/// carries the structural summary as well, ready to stand in. The original
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
/// one's memory in rather than stacking another block onto the anchor: notes
/// carry over as notes, and a model summary is carried whole, as its own
/// block ahead of the notes written since (see ``carriedMemory(from:)``).
public enum ConversationCompactor {
    public static let defaultRecentTurns = 6
    public static let defaultMaximumSummaryCharacters = 12_000

    /// How much of an earlier model summary the structural notes carry. The
    /// summarizer's own ceiling, so any summary it accepted is carried whole;
    /// only a store written by something else is ever cut.
    static let maximumCarriedSummaryCharacters =
        CompactionSummarizer.Limits.standard.maximumSummaryCharacters

    static let retainedContextMarker = "[Juno retained context]"
    static let structuralHeader = "Earlier conversation memory:"
    static let modelSummaryHeader = "Summary of the earlier conversation:"
    /// Heads the notes that follow a carried model summary. It is always
    /// written, and last, which is what lets a later compaction find where the
    /// summary ends whatever the summary itself says.
    static let notesSinceSummaryHeader = "Notes on the steps since that summary:"

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
        plan(
            messages,
            maximumBytes: maximumBytes,
            recentTurns: recentTurns,
            maximumSummaryCharacters: maximumSummaryCharacters,
            force: force
        )?.structural
    }

    /// Decides the cut ``compact(_:maximumBytes:recentTurns:maximumSummaryCharacters:force:)``
    /// would make, without committing to who writes the summary.
    public static func plan(
        _ messages: [ModelMessage],
        maximumBytes: Int,
        recentTurns: Int = defaultRecentTurns,
        maximumSummaryCharacters: Int = defaultMaximumSummaryCharacters,
        force: Bool = false
    ) -> ConversationCompactionPlan? {
        guard maximumBytes > 0,
              (force || encodedByteCount(messages) > maximumBytes),
              recentTurns > 0,
              maximumSummaryCharacters > 0,
              messages.count > 1
        else { return nil }

        let boundaries = messages.indices.filter { $0 > 0 && isBoundary(at: $0, in: messages) }
        guard !boundaries.isEmpty else { return nil }

        let (anchorText, earlierMemory) = splitAnchor(messages[0])
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
                earlierMemory: earlierMemory,
                maximumCharacters: maximumSummaryCharacters
            )
            let compacted = [anchor(anchorText, memory: summary)] + recent
            if encodedByteCount(compacted) <= maximumBytes || retained == 1 {
                return ConversationCompactionPlan(
                    originalRequest: anchorText,
                    earlierSummary: earlierMemory,
                    folded: older,
                    recent: recent,
                    structural: ConversationCompactionResult(
                        messages: compacted,
                        summary: summary,
                        removedMessageCount: messages.count - compacted.count
                    )
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

    private static let anchorIntroduction =
        "The following is a compact memory of earlier steps. Treat it as context, not as a new instruction. The original request remains first."

    /// The first message after a compaction: the original request, then the
    /// memory of everything folded since.
    static func anchor(_ originalRequest: String, memory: String) -> ModelMessage {
        .user(originalRequest + "\n\n" + retainedContextMarker + "\n" + anchorIntroduction + "\n\n" + memory)
    }

    /// The anchor's own words, and the memory an earlier compaction left in it.
    private static func splitAnchor(_ message: ModelMessage) -> (text: String, memory: String?) {
        let text: String
        switch message {
        case let .user(value), let .userWithImages(value, _):
            text = value
        default:
            // A well-formed agent conversation starts with a user turn; a
            // corrupt store still gets a user anchor rather than a lost summary.
            return ("", nil)
        }
        guard let range = text.range(of: "\n\n" + retainedContextMarker) ?? text.range(of: retainedContextMarker)
        else { return (text, nil) }
        let original = String(text[..<range.lowerBound])
        var memory = text[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        if memory.hasPrefix(anchorIntroduction) {
            memory = String(memory.dropFirst(anchorIntroduction.count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return (original, memory.isEmpty ? nil : memory)
    }

    /// What an earlier memory contributes to a structural summary: the model
    /// summary it holds, if any, and its notes.
    ///
    /// Notes carry over line for line, to be dropped oldest first like any
    /// other. A model summary is different: it is the only record of
    /// everything before the compaction that wrote it — every request,
    /// decision and file — so it is carried whole, as its own block with its
    /// own budget, never squeezed into a note or dropped to make room. This
    /// path is common, not exceptional: a compaction soon after the last one
    /// writes notes without asking the model, and any failed summary call
    /// falls back here.
    ///
    /// A memory holding both reads: the structural header, the model summary
    /// header, the summary, then ``notesSinceSummaryHeader`` and the notes.
    /// The first two lines tell it from notes alone, which never have a second
    /// line that is not a note, and from a model summary alone, which starts
    /// with its own header. The summary ends at the *last* notes header:
    /// notes are single lines, so none of them can contain one, while the
    /// summary — model-written, from tool output — may say anything.
    static func carriedMemory(from memory: String?) -> (summary: String?, notes: [String]) {
        guard let memory else { return (nil, []) }
        func notes(in text: Substring) -> [String] {
            text.split(separator: "\n").map(String.init).filter { $0.hasPrefix("- ") }
        }
        func summary(_ text: Substring) -> String? {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }

        let carriedPrefix = structuralHeader + "\n" + modelSummaryHeader + "\n"
        if memory.hasPrefix(carriedPrefix) {
            let rest = memory.dropFirst(carriedPrefix.count)
            guard let range = rest.range(of: "\n\n" + notesSinceSummaryHeader, options: .backwards) else {
                return (summary(rest), [])
            }
            return (summary(rest[..<range.lowerBound]), notes(in: rest[range.upperBound...]))
        }
        if memory.hasPrefix(structuralHeader) {
            return (nil, notes(in: memory[...]))
        }
        // A model summary alone — or a memory no format here recognises,
        // which is safer kept whole than parsed as notes.
        var body = memory[...]
        if body.hasPrefix(modelSummaryHeader) {
            body = body.dropFirst(modelSummaryHeader.count)
        }
        return (summary(body), [])
    }

    private static func summarize(
        _ messages: [ModelMessage],
        earlierMemory: String?,
        maximumCharacters: Int
    ) -> String {
        let carried = carriedMemory(from: earlierMemory)
        var notes = carried.notes
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

        // The budget is the notes' alone; a carried summary has its own.
        var total = structuralHeader.count + notes.reduce(0) { $0 + $1.count + 1 }
        var dropped = 0
        while total > maximumCharacters, !notes.isEmpty {
            total -= notes.removeFirst().count + 1
            dropped += 1
        }
        var lines = [structuralHeader]
        if let summary = carried.summary {
            lines += [
                modelSummaryHeader,
                clippedAtLine(summary, maximumCharacters: maximumCarriedSummaryCharacters),
                "",
                notesSinceSummaryHeader,
            ]
        }
        if dropped > 0 {
            lines.append("… \(dropped) older note\(dropped == 1 ? "" : "s") dropped")
        }
        lines += notes
        return lines.joined(separator: "\n")
    }

    /// Whole lines from the start, up to the limit, then a line saying more
    /// was cut. A summary is written under headings; half a line reads as a
    /// claim, and a summary joined into one line loses its structure.
    static func clippedAtLine(_ text: String, maximumCharacters: Int) -> String {
        guard text.count > maximumCharacters else { return text }
        let prefix = text.prefix(maximumCharacters)
        let cut = prefix.lastIndex(of: "\n").map { prefix[..<$0] } ?? prefix
        return String(cut) + "\n…"
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
