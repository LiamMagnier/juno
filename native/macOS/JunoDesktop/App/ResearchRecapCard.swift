import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The receipt for a finished research run whose report lives only on the
/// run — today's web background runs, which write no chat message (the web's
/// `ResearchRecap`, Phase 5 B6).
///
/// With a report it is the report's card — the same door an in-chat report
/// has — under the run's verdict and what it took, then one quiet line: the
/// citation check in words, "Inspect sources" (the Research panel on Sources)
/// and "Hide" (remembered on this Mac). With none, how it ended, its title
/// and what it found before it stopped.
struct ResearchRecapCard: View {
    let run: NativeResearchRun
    /// Opens the report window; nil when the run wrote no report.
    let openReport: (() -> Void)?
    let inspect: () -> Void
    let dismiss: () -> Void

    private var verdictIsWarning: Bool {
        run.state != "completed" && run.state != "cancelled"
    }

    private var verdict: String {
        var line = ResearchRecapWords.verdict(run.state)
        if let figures = ResearchRecapWords.figures(run) { line += " \u{00B7} " + figures }
        return line
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let report = NativeResearchReport(run: run) {
                NativeResearchReportCard(
                    content: .report(report),
                    verdict: verdict,
                    verdictIsWarning: verdictIsWarning,
                    open: openReport
                )
            } else {
                stopped
            }
            footer
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Research report")
        .accessibilityIdentifier("juno.chat.research-recap")
    }

    /// A run that ended before it wrote anything.
    private var stopped: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.tight) {
                if let glyph = ResearchRecapWords.verdictGlyph(run.state), verdictIsWarning {
                    JunoIconView(glyph.icon, size: 11)
                        .foregroundStyle(glyph.tint)
                        .accessibilityHidden(true)
                }
                Text(verdict)
                    .foregroundStyle(verdictIsWarning ? Color.junoWarningInk : Color.junoSecondaryInk)
            }
            .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
            Text(run.displayTitle)
                .font(JunoSerif.font(size: 22, relativeTo: .title2))
                .foregroundStyle(Color.junoForeground)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            ResearchEvidenceLedger(run: run)
            Text(run.error ?? "This run stopped before it wrote a report.")
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(run.error == nil ? Color.junoSecondaryInk : Color.junoWarningInk)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(JunoSpace.roomy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoCard, in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
    }

    private var footer: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.regular) {
            if let audit = run.audit {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                    JunoIconView(audit.isClean ? .shield : .warning, size: 11)
                        .foregroundStyle(audit.isClean ? Color.junoSecondaryInk : Color.junoWarningInk)
                        .accessibilityHidden(true)
                    Text(audit.headline)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .monospacedDigit()
                        .lineLimit(1)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("juno.chat.research-recap.audit")
            }
            Spacer(minLength: JunoSpace.snug)
            Button(action: inspect) {
                Text("Inspect sources")
                    .frame(minHeight: 28)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.junoSecondaryInk)
            .fixedSize()
            .accessibilityIdentifier("juno.chat.research-recap.inspect")
            Button(action: dismiss) {
                Text("Hide")
                    .frame(minHeight: 28)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.junoSecondaryInk)
            .fixedSize()
            .help("Hide this research receipt on this Mac")
            .accessibilityIdentifier("juno.chat.research-recap.dismiss")
        }
        .junoFont(size: 12, relativeTo: .caption)
        .padding(.horizontal, JunoSpace.tight)
    }
}

/// The recap's words: the web's `RECAP_COPY`, `runDuration` and
/// `formatMicroUsd`.
enum ResearchRecapWords {
    /// "Research complete", "Cancelled", or the state's sentence.
    static func verdict(_ state: String) -> String {
        switch state {
        case "completed": "Research complete"
        case "cancelled": "Cancelled"
        default: NativeResearchRun.stateSentence(state)
        }
    }

    /// The verdict's glyph, in the state's tone: a real state, never
    /// decoration. A cancelled run has none.
    static func verdictGlyph(_ state: String) -> (icon: JunoIcon, tint: Color)? {
        switch state {
        case "completed": (.circleCheck, .junoSuccessInk)
        case "cancelled": nil
        case "partially_completed": (.warning, .junoWarningInk)
        default: (.error, .junoDestructiveInk)
        }
    }

    /// "12 sources read · 31 found · 3/4 objectives answered".
    static func provenance(_ run: NativeResearchRun) -> String {
        let read = run.readSourceCount
        var line = "\(read) \(read == 1 ? "source read" : "sources read") \u{00B7} \(run.sources.count) found"
        if let answered = run.objectivesAnswered {
            line += " \u{00B7} \(answered.covered)/\(answered.total) objectives answered"
        }
        return line
    }

    /// "4 min · $0.38", or whichever of the two the server sent.
    static func figures(_ run: NativeResearchRun) -> String? {
        var parts: [String] = []
        if let created = run.createdAt, let duration = duration(from: created, to: run.finishedAt) {
            parts.append(duration)
        }
        if let cost = run.costMicroUsd { parts.append(money(microUsd: cost)) }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    /// `runDuration`: "9s", "14 min", "1h 12m".
    static func duration(from start: Date, to end: Date?) -> String? {
        guard let end else { return nil }
        let interval = end.timeIntervalSince(start)
        guard interval >= 0 else { return nil }
        let seconds = Int(interval.rounded())
        if seconds < 60 { return "\(max(1, seconds))s" }
        let minutes = Int((Double(seconds) / 60).rounded())
        if minutes < 60 { return "\(minutes) min" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    /// `formatMicroUsd`: "$0.00", "<$0.01", "$0.38".
    static func money(microUsd: Int) -> String {
        let usd = Double(microUsd) / 1_000_000
        guard usd > 0 else { return "$0.00" }
        return usd < 0.01 ? "<$0.01" : String(format: "$%.2f", usd)
    }
}

/// What the transcript's research surfaces reach outside themselves.
struct ChatResearchActions {
    /// Opens the report's own window, by run id.
    var openReport: ((String) -> Void)? = nil
    /// Opens the Research panel on Sources, by run id.
    var inspect: ((String) -> Void)? = nil
    /// Hides a run's recap on this Mac, by run id.
    var dismissRecap: ((String) -> Void)? = nil
    /// The recaps hidden on this Mac.
    var dismissed: Set<String> = []
}
