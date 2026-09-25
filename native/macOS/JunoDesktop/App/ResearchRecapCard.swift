import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The receipt for a finished research run whose report lives only on the
/// run — today's web background runs, which write no chat message (the web's
/// `ResearchRecap`, Phase 5 B6).
///
/// An opaque card at radius 16 under a hairline, placed in the transcript at
/// the run's creation: how it ended, with the time and money it took; the
/// report's title; what it read and how much of the plan it answered; the
/// citation check; and the door into the report. "Inspect methodology &
/// sources" opens the Research panel on Sources; ✕ hides the receipt for
/// this run, remembered on this Mac.
///
/// **Signature detail:** the audit line — the one place a report says
/// whether its claims hold — set apart under a shield in the check's tone.
struct ResearchRecapCard: View {
    let run: NativeResearchRun
    /// Opens the report window; nil when the run wrote no report.
    let openReport: (() -> Void)?
    let inspect: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Text(run.displayTitle)
                .junoFont(size: 15, relativeTo: .body, weight: .semibold)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, JunoSpace.cozy)
            Text(ResearchRecapWords.provenance(run))
                .junoFont(size: 13, relativeTo: .callout)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.tight)
            if let audit = run.audit {
                auditLine(audit)
                    .padding(.top, JunoSpace.cozy)
            }
            if let error = run.error {
                Text(error)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoDestructiveInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.top, JunoSpace.cozy)
            }
            actions
                .padding(.top, JunoSpace.comfy)
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoCard, in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Research report")
        .accessibilityIdentifier("juno.chat.research-recap")
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.tight) {
                if let glyph = ResearchRecapWords.verdictGlyph(run.state) {
                    JunoIconView(glyph.icon, size: 12)
                        .foregroundStyle(glyph.tint)
                        .accessibilityHidden(true)
                }
                Text(ResearchRecapWords.verdict(run.state))
                    .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: JunoSpace.snug)
            if let figures = ResearchRecapWords.figures(run) {
                // Time and money are figures, so mono.
                Text(figures)
                    .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize()
            }
            Button(action: dismiss) {
                JunoIconView(.close, size: 12)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 28, height: 28)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Hide this research receipt")
            .accessibilityLabel("Hide this research receipt")
            .accessibilityIdentifier("juno.chat.research-recap.dismiss")
        }
        .frame(minHeight: 28)
    }

    // MARK: The citation check

    private func auditLine(_ audit: NativeResearchRun.AuditSummary) -> some View {
        HStack(alignment: .center, spacing: JunoSpace.snug) {
            JunoIconView(.shieldCheck, size: 12)
                .foregroundStyle(audit.isClean ? Color.junoSuccessInk : Color.junoWarningInk)
                .accessibilityHidden(true)
            Text(audit.headline)
                .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
                .monospacedDigit()
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.chat.research-recap.audit")
    }

    // MARK: Actions

    private var actions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: JunoSpace.cozy) { actionRow }
            VStack(alignment: .leading, spacing: JunoSpace.snug) { actionRow }
        }
    }

    @ViewBuilder
    private var actionRow: some View {
        if let openReport {
            Button(action: openReport) {
                HStack(spacing: JunoSpace.tight) {
                    Text("Read the full report")
                    JunoIconView(.arrowRight, size: 12)
                }
                .frame(minHeight: 20)
                .contentShape(.rect)
            }
            .buttonStyle(.bordered)
            .tint(nil)
            .controlSize(.small)
            .frame(minHeight: 28)
            .fixedSize()
            .accessibilityIdentifier("juno.chat.research-recap.open")
        } else {
            Text("This run stopped before it wrote a report.")
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
        Button(action: inspect) {
            Text("Inspect methodology & sources")
                .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(minHeight: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityIdentifier("juno.chat.research-recap.inspect")
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
