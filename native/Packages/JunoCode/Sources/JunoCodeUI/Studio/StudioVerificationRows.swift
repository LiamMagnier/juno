import SwiftUI
import JunoCodeCore
import JunoCodeRuntime
import JunoDesignSystem

// Recorded checks and self-reviews in the thread (CODE_AGENT_SPEC §1.8, §1.9).
//
// Owned by Lane B (verification, self-review and report). State is said in
// words: "passed", "failed", "Must fix". No status dots, no pills, no badges.

/// One check the runtime recorded: "`swift test` passed · 38 tests · 9 s",
/// and on failure the headline and the last lines the check printed.
struct StudioVerificationRow: View {
    let record: VerificationRecord

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                Text(record.command)
                    .font(Studio.Font.mono)
                    .foregroundStyle(Studio.Ink.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
                Text(record.passed ? "passed" : "failed")
                    .font(Studio.Font.metaEmphasis)
                    .foregroundStyle(record.passed ? Studio.Ink.secondary : Studio.Ink.danger)
                Text(Self.meta(for: record))
                    .font(Studio.Font.metaDigits)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            if !record.passed {
                let lines = Self.failureLines(of: record)
                if !lines.isEmpty {
                    Text(lines.joined(separator: "\n"))
                        .font(Studio.Font.monoSmall)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .lineLimit(4)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.leading, 17)
        .accessibilityElement(children: .combine)
    }

    /// "· 38 tests · 9 s", "· exit 1 · 2 s", with the recipe check's name.
    static func meta(for record: VerificationRecord) -> String {
        var parts: [String] = []
        let headline = CheckEvidence.headline(of: record)
        if record.kind == .test, headline.contains("test") {
            parts.append(record.passed ? headline.replacingOccurrences(of: " passed", with: "") : headline)
        } else if !record.passed {
            parts.append("exit \(record.exitCode)")
        }
        parts.append(StudioFormat.duration(Double(record.durationMs) / 1_000))
        if let checkID = record.checkID { parts.append(checkID) }
        return "· " + parts.joined(separator: " · ")
    }

    /// The end of a failing check's output: the lines after its headline,
    /// last four that say something.
    static func failureLines(of record: VerificationRecord) -> [String] {
        let lines = record.excerpt
            .split(separator: "\n", omittingEmptySubsequences: true)
            .dropFirst()
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return Array(lines.suffix(4))
    }
}

/// A self-review of the diff: "Reviewed the diff: no correctness findings",
/// or each finding with its priority and confidence in words.
struct StudioReviewFindingsRow: View {
    let record: ReviewRecord

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(Self.caption(for: record))
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
            ForEach(Array(Self.ordered(record.findings).enumerated()), id: \.offset) { _, finding in
                VStack(alignment: .leading, spacing: 1) {
                    Text(Self.heading(for: finding))
                        .font(Studio.Font.meta)
                        // In the danger ink exactly when it sends the run back.
                        .foregroundStyle(record.blockingFindings.contains(finding) ? Studio.Ink.danger : Studio.Ink.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(finding.title)
                        .font(Studio.Font.label)
                        .foregroundStyle(Studio.Ink.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    if !finding.body.isEmpty {
                        Text(finding.body)
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.tertiary)
                            .lineLimit(2)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 17)
    }

    static func caption(for record: ReviewRecord) -> String {
        let prefix = record.round > 1 ? "Reviewed the diff again: " : "Reviewed the diff: "
        let blocking = record.blockingFindings.count
        let notes = record.findings.count - blocking
        switch (blocking, notes) {
        case (0, 0): return prefix + "no correctness findings"
        case (0, _): return prefix + "no correctness findings, " + StudioFormat.plural(notes, "note")
        case (_, 0): return prefix + "\(blocking) to fix"
        default: return prefix + "\(blocking) to fix, " + StudioFormat.plural(notes, "note")
        }
    }

    /// Blocking findings first, then by priority.
    static func ordered(_ findings: [ReviewFinding]) -> [ReviewFinding] {
        findings.enumerated().sorted { lhs, rhs in
            lhs.element.priority == rhs.element.priority ? lhs.offset < rhs.offset : lhs.element.priority < rhs.element.priority
        }.map(\.element)
    }

    /// "Must fix · high confidence · src/a.tsx:41".
    static func heading(for finding: ReviewFinding) -> String {
        var parts = [priorityWords(finding.priority)]
        parts.append(confidenceWords(finding.confidence))
        if let criterion = finding.criterion { parts.append("criterion \(criterion)") }
        if let path = finding.path { parts.append(path + (finding.line.map { ":\($0)" } ?? "")) }
        return parts.joined(separator: " · ")
    }

    static func priorityWords(_ priority: ReviewPriority) -> String {
        switch priority {
        case .p0: "Critical"
        case .p1: "Must fix"
        case .p2: "Worth fixing"
        case .p3: "Note"
        }
    }

    static func confidenceWords(_ confidence: Double) -> String {
        switch confidence {
        case 0.8...: "high confidence"
        case 0.6..<0.8: "medium confidence"
        default: "low confidence"
        }
    }
}
