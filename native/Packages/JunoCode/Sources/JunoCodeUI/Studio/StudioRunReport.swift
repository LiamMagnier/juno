import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// The run report (CODE_AGENT_SPEC §1.10): the run's last row.
//
// Owned by Lane B (verification, self-review and report). The model wrote
// the prose above it; this row carries what the runtime vouches for: the
// outcome sentence, the "Checked" rows (only ledger records render there),
// what was not checked, and what is left. Text only: state in words, no
// icons standing in for them, no pills.

struct StudioRunReportRow: View {
    let event: RunOutcomeEvent

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if let caption = Self.caption(for: event) {
                // The divider, with `command` spans set as code.
                HStack(spacing: JunoSpace.cozy) {
                    Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
                    Text(Self.inlineCode(caption))
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(1)
                    Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
                }
                .padding(.vertical, JunoSpace.hairline)
            }
            if !event.summary.isEmpty {
                Text(event.summary)
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !event.checks.isEmpty {
                section("Checked") {
                    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: JunoSpace.regular, verticalSpacing: JunoSpace.tight) {
                        ForEach(Array(event.checks.enumerated()), id: \.offset) { _, check in
                            GridRow {
                                Text(check.label)
                                    .font(Self.looksLikeCommand(check.label) ? Studio.Font.mono : Studio.Font.meta)
                                    .foregroundStyle(Studio.Ink.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                    .frame(maxWidth: 300, alignment: .leading)
                                Text(check.detail ?? (check.passed ? "passed" : "failed"))
                                    .font(Studio.Font.meta)
                                    .foregroundStyle(check.passed ? Studio.Ink.tertiary : Studio.Ink.danger)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .gridColumnAlignment(.leading)
                            }
                        }
                    }
                }
            }
            if !event.notChecked.isEmpty {
                section("Not checked") { lines(event.notChecked) }
            }
            if !event.left.isEmpty {
                section("Left") { lines(event.left) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(title)
                .font(Studio.Font.caption)
                .foregroundStyle(Studio.Ink.tertiary)
            content()
                .padding(.leading, JunoSpace.cozy)
        }
    }

    private func lines(_ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                Text(item)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Words

    /// The divider's words: what the runtime says about checks, or how the
    /// run ended when that says more.
    static func caption(for event: RunOutcomeEvent) -> String? {
        if let verification = event.verification, !verification.isEmpty { return verification }
        switch event.endReason {
        case .doneChecked, .doneUnchecked: return nil
        case .checksFailing: return "A check still fails"
        case .blocked: return "Blocked"
        case .needsYou: return "Waiting for you"
        case .stepLimit: return "Stopped at the step limit"
        case .budget: return "Used the run's budget"
        case .stalled: return "Stopped: no progress in the last two tries"
        case .waitingOnBackground: return "Waiting for background work to finish"
        case .stopped: return "Stopped"
        case .interrupted: return "Juno quit while this was running"
        case .error: return "Stopped by an error"
        }
    }

    /// `text` with its backtick spans in the monospaced face, as the
    /// runtime writes commands in the end-reason words.
    ///
    /// Never a link: the commands are the model's, and a backtick inside one
    /// would close the code span and let `[words](url)` after it become
    /// something to click in a row the reader trusts as Juno's own.
    static func inlineCode(_ text: String) -> AttributedString {
        var attributed = (try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
        for run in attributed.runs where run.link != nil {
            attributed[run.range].link = nil
        }
        return attributed
    }

    /// Ledger rows for commands read as commands; Preview, Simulator, app
    /// and review rows read as words.
    static func looksLikeCommand(_ label: String) -> Bool {
        !["Preview ", "Simulator ", "App ", "Review"].contains { label.hasPrefix($0) }
    }
}
