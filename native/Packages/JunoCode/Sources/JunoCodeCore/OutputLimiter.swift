import Foundation

/// Bounds tool and command output so a single action can never flood the
/// transcript, the model context, or memory.
public struct OutputLimit: Sendable, Equatable {
    public let maximumBytes: Int
    public let truncationNotice: String

    public init(maximumBytes: Int, truncationNotice: String = "… [output truncated]") {
        self.maximumBytes = max(0, maximumBytes)
        self.truncationNotice = truncationNotice
    }

    /// Default cap for file reads returned to the agent.
    public static let fileRead = OutputLimit(maximumBytes: 1 * 1_024 * 1_024)
    /// Default cap for a whole command's captured output.
    public static let commandOutput = OutputLimit(maximumBytes: 2 * 1_024 * 1_024)
    /// Default cap for one streamed chunk event.
    public static let streamChunk = OutputLimit(maximumBytes: 64 * 1_024)
}

public struct LimitedOutput: Sendable, Equatable {
    public let text: String
    public let wasTruncated: Bool
    public let originalByteCount: Int

    public init(text: String, wasTruncated: Bool, originalByteCount: Int) {
        self.text = text
        self.wasTruncated = wasTruncated
        self.originalByteCount = originalByteCount
    }
}

public enum OutputLimiter {
    /// Truncates on a valid UTF-8 / character boundary, never mid-scalar.
    public static func apply(_ limit: OutputLimit, to text: String) -> LimitedOutput {
        let byteCount = text.utf8.count
        guard byteCount > limit.maximumBytes else {
            return LimitedOutput(text: text, wasTruncated: false, originalByteCount: byteCount)
        }
        var used = 0
        var end = text.startIndex
        for index in text.indices {
            let characterBytes = text[index].utf8.count
            if used + characterBytes > limit.maximumBytes { break }
            used += characterBytes
            end = text.index(after: index)
        }
        let truncated = String(text[..<end]) + limit.truncationNotice
        return LimitedOutput(text: truncated, wasTruncated: true, originalByteCount: byteCount)
    }

    /// Keeps the beginning *and* the end, dropping the middle.
    ///
    /// For command output the end is usually the part that matters: a build
    /// prints thousands of progress lines and then the one error, and a
    /// head-only cut threw that error away. A quarter of the budget goes to the
    /// head for context, the rest to the tail.
    public static func applyKeepingEnds(_ limit: OutputLimit, to text: String) -> LimitedOutput {
        let byteCount = text.utf8.count
        guard byteCount > limit.maximumBytes else {
            return LimitedOutput(text: text, wasTruncated: false, originalByteCount: byteCount)
        }
        let headBudget = limit.maximumBytes / 4
        let tailBudget = limit.maximumBytes - headBudget

        var used = 0
        var headEnd = text.startIndex
        for index in text.indices {
            let characterBytes = text[index].utf8.count
            if used + characterBytes > headBudget { break }
            used += characterBytes
            headEnd = text.index(after: index)
        }
        used = 0
        var tailStart = text.endIndex
        for index in text.indices.reversed() {
            let characterBytes = text[index].utf8.count
            if used + characterBytes > tailBudget || index < headEnd { break }
            used += characterBytes
            tailStart = index
        }
        let omitted = byteCount - text[..<headEnd].utf8.count - text[tailStart...].utf8.count
        let joined = String(text[..<headEnd])
            + "\n… [\(omitted) bytes omitted] …\n"
            + String(text[tailStart...])
        return LimitedOutput(text: joined, wasTruncated: true, originalByteCount: byteCount)
    }
}
