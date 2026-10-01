import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// The run report: the model's outcome and the checks the runtime recorded.
//
// Owned by Lane B (verification, self-review and report). A placeholder from
// the seams commit (CODE_AGENT_SPEC §6.0): plain words in the Studio style,
// which Lane B replaces with the designed report (§1.10).

/// The outcome sentence, the divider's words about checks, and the "Checked"
/// rows, which come only from the ledger.
struct StudioRunReportRow: View {
    let event: RunOutcomeEvent

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            if let verification = event.verification {
                StudioDividerCaption(text: verification)
            }
            if !event.summary.isEmpty {
                Text(event.summary)
                    .font(Studio.Font.label)
                    .foregroundStyle(Studio.Ink.primary)
            }
            ForEach(Array(event.checks.enumerated()), id: \.offset) { _, check in
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(check.passed ? .check : .close, size: 11)
                        .foregroundStyle(check.passed ? Studio.Ink.success : Studio.Ink.danger)
                    Text(check.label)
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.secondary)
                    if let detail = check.detail {
                        Text(detail)
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.tertiary)
                    }
                }
            }
            ForEach(event.notChecked, id: \.self) { line in
                Text("Not checked: \(line)")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
