import Foundation
import JunoCodeCore

/// Counts consecutive identical tool calls (the tool's name and its arguments
/// with keys sorted, a `justification` ignored) and, at the third, fifth and
/// eighth in a row, answers a reminder to append to the call's result
/// (Alevr Code v2 SPEC §3.10, after DeepSeek Harness's guards, MIT).
///
/// Advisory: the call still runs. A model that reads the same file or runs the
/// same failing command over and over is told so in the result it is reading,
/// which is where it will notice, rather than stopped outright.
public struct RepeatCallGuard: Sendable {
    public static let defaultThresholds = [3, 5, 8]

    public let thresholds: [Int]
    private var lastKey: String?
    private var count = 0

    public init(thresholds: [Int] = RepeatCallGuard.defaultThresholds) {
        self.thresholds = thresholds.filter { $0 > 1 }.sorted()
    }

    /// The canonical form of `input`: keys sorted, `justification` dropped.
    public static func canonicalArguments(_ input: JSONValue) -> String {
        var value = input
        if case var .object(fields) = value {
            fields.removeValue(forKey: "justification")
            value = .object(fields)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else {
            return String(describing: value)
        }
        return text
    }

    /// Records one call, in call order. Returns the reminder to append to its
    /// result, or nil.
    public mutating func observe(toolName: String, input: JSONValue) -> String? {
        let arguments = Self.canonicalArguments(input)
        let key = toolName + "\u{0}" + arguments
        if key == lastKey {
            count += 1
        } else {
            lastKey = key
            count = 1
        }
        guard thresholds.contains(count) else { return nil }
        if count == thresholds.first {
            return "Reminder: you are repeating the exact same tool call with identical arguments. "
                + "Read the previous result carefully; if the task is not done, try a different approach "
                + "or different arguments instead of repeating the call."
        }
        let preview = arguments.count > 500 ? String(arguments.prefix(500)) + "…" : arguments
        return [
            "Repeated tool call detected:",
            "- tool: \(toolName)",
            "- consecutive_calls: \(count)",
            "- arguments: \(preview)",
            "These calls are not making progress. Do not call this tool with these exact arguments again. "
                + "Inspect the latest result and choose a different action or different arguments, "
                + "or finish if you have enough evidence.",
        ].joined(separator: "\n")
    }

    /// Forgets the streak: after a compaction or a new prompt the model is
    /// working from a different history.
    public mutating func reset() {
        lastKey = nil
        count = 0
    }
}
