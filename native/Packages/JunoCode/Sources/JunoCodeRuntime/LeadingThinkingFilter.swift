import Foundation

/// Only leading provider envelopes are reasoning. Tags inside an answer or
/// a code example are literal text, even when split across stream deltas.
struct LeadingThinkingFilter {
    private enum State { case prefix, thinking, answer }
    private var state = State.prefix
    private var pending = ""
    private var closing = ""

    mutating func push(_ text: String) -> (text: String, reasoning: String) {
        pending += text
        var reasoning = ""
        if state == .prefix {
            let candidate = String(pending.drop(while: { $0.isWhitespace }))
            let tags = ["<think>", "<thinking>", "<analysis>"]
            if let opening = tags.first(where: { candidate.hasPrefix($0) }) {
                pending = String(candidate.dropFirst(opening.count))
                closing = "</" + opening.dropFirst()
                state = .thinking
            } else if !candidate.isEmpty && !tags.contains(where: { $0.hasPrefix(candidate) }) {
                state = .answer
            } else { return ("", "") }
        }
        if state == .thinking {
            if let range = pending.range(of: closing) {
                reasoning = String(pending[..<range.lowerBound])
                pending = String(pending[range.upperBound...])
                state = .answer
            } else {
                var keep = 0
                for count in 1..<closing.count where pending.hasSuffix(String(closing.prefix(count))) { keep = count }
                reasoning = String(pending.dropLast(keep))
                pending = keep > 0 ? String(pending.suffix(keep)) : ""
            }
        }
        if state == .answer {
            let answer = pending
            pending = ""
            return (answer, reasoning)
        }
        return ("", reasoning)
    }

    mutating func finish() -> (text: String, reasoning: String) {
        let text = pending
        pending = ""
        return state == .answer || (state == .prefix && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            ? (text, "") : ("", text)
    }
}
