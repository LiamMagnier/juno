import Foundation
import JunoCodeCore

/// One reviewer finding, placed on its line in the diff (CODE_AGENT_SPEC
/// §5.10): its priority in words, never a badge, with Fix this and Dismiss.
public struct InlineFinding: Identifiable, Hashable, Sendable {
    /// Stable across reloads: the review it came from and where it points.
    public let key: String
    public let path: String?
    public let line: Int?
    public let priority: ReviewPriority
    public let confidence: Double
    /// "Correctness, high confidence".
    public let words: String
    public let title: String
    public let body: String
    public let criterion: String?

    public var id: String { key }
}

/// Places the latest self-review's findings (`reviewCompleted`, from Lane B's
/// reviewer pass or `/review`) on the lines they are about.
public enum ReviewFindingsProjection {
    /// The newest review's findings the reader has not dismissed, most
    /// serious first.
    public static func findings(in events: [SessionEvent], dismissed: Set<String> = []) -> [InlineFinding] {
        guard let record = events.lazy.reversed().compactMap({ event -> ReviewRecord? in
            if case let .reviewCompleted(record) = event.payload { return record }
            return nil
        }).first else { return [] }
        return record.findings.enumerated().compactMap { index, finding in
            let key = "\(record.id):\(index):\(finding.path ?? ""):\(finding.line.map(String.init) ?? "")"
            guard !dismissed.contains(key) else { return nil }
            return InlineFinding(
                key: key,
                path: finding.path,
                line: finding.line,
                priority: finding.priority,
                confidence: finding.confidence,
                words: words(priority: finding.priority, confidence: finding.confidence, criterion: finding.criterion),
                title: finding.title,
                body: finding.body,
                criterion: finding.criterion
            )
        }
        .sorted { lhs, rhs in
            lhs.priority != rhs.priority ? lhs.priority < rhs.priority : lhs.confidence > rhs.confidence
        }
    }

    /// The findings that sit on one file, by line.
    public static func findings(_ all: [InlineFinding], path: String) -> [InlineFinding] {
        all.filter { $0.path == path }
    }

    /// A finding's priority and confidence in words: "Correctness, high
    /// confidence", "Requirement c2, medium confidence".
    public static func words(priority: ReviewPriority, confidence: Double, criterion: String? = nil) -> String {
        let kind: String
        if let criterion {
            kind = "Requirement \(criterion)"
        } else {
            switch priority {
            case .p0: kind = "Must fix"
            case .p1: kind = "Correctness"
            case .p2: kind = "Worth fixing"
            case .p3: kind = "Minor"
            }
        }
        let level = confidence >= 0.8 ? "high" : confidence >= 0.6 ? "medium" : "low"
        return "\(kind), \(level) confidence"
    }

    /// The comment Fix this queues: the finding, at its line, for the next
    /// message.
    public static func comment(for finding: InlineFinding, quotedLine: String?) -> QueuedReviewComment {
        var text = "Fix this (\(finding.words)): \(finding.title)"
        if !finding.body.isEmpty { text += "\n\(finding.body)" }
        return QueuedReviewComment(
            path: finding.path ?? "the change",
            line: finding.line,
            quotedLine: quotedLine,
            text: text
        )
    }
}
