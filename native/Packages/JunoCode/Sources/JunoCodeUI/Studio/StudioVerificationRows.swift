import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// Recorded checks and self-reviews in the thread.
//
// Owned by Lane B (verification, self-review and report). Placeholders from
// the seams commit (CODE_AGENT_SPEC §6.0): plain words in the Studio style,
// which Lane B replaces with the designed rows (§1.8–§1.10).

/// "`swift test` passed · 9 s".
struct StudioVerificationRow: View {
    let record: VerificationRecord

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(record.passed ? .check : .close, size: 11)
                .foregroundStyle(record.passed ? Studio.Ink.success : Studio.Ink.danger)
            Text(record.command)
                .font(Studio.Font.mono)
                .foregroundStyle(Studio.Ink.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(record.passed ? "passed" : "failed, exit \(record.exitCode)")
                .font(Studio.Font.meta)
                .foregroundStyle(record.passed ? Studio.Ink.tertiary : Studio.Ink.danger)
            Spacer()
            Text(StudioFormat.duration(Double(record.durationMs) / 1_000))
                .font(Studio.Font.metaDigits)
                .foregroundStyle(Studio.Ink.tertiary)
        }
        .padding(.leading, 17)
    }
}

/// "Reviewed the diff: no correctness findings", or the findings in words.
struct StudioReviewFindingsRow: View {
    let record: ReviewRecord

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(Self.caption(for: record))
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
            ForEach(Array(record.findings.enumerated()), id: \.offset) { _, finding in
                Text(Self.line(for: finding))
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 17)
    }

    static func caption(for record: ReviewRecord) -> String {
        guard !record.findings.isEmpty else { return "Reviewed the diff: no correctness findings" }
        return "Reviewed the diff: " + StudioFormat.plural(record.findings.count, "finding")
    }

    static func line(for finding: ReviewFinding) -> String {
        var place = ""
        if let path = finding.path {
            place = finding.line.map { " at \(path):\($0)" } ?? " in \(path)"
        }
        return "\(finding.priority.rawValue.uppercased())\(place): \(finding.title)"
    }
}
