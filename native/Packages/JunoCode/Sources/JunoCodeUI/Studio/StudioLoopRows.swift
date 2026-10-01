import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// The loop's rows in the thread: continuation captions and goal verdicts.
//
// Owned by Lane A (loop, stop check and goal). Placeholders from the seams
// commit (CODE_AGENT_SPEC §6.0): plain words in the Studio style, which Lane A
// replaces with the designed rows (§1.5, §2.8).

/// "Kept going: 2 todos were open". A quiet divider caption, never a message
/// from the reader.
struct StudioContinuedRow: View {
    let event: RunContinuedEvent

    var body: some View {
        StudioDividerCaption(text: Self.caption(for: event))
    }

    static func caption(for event: RunContinuedEvent) -> String {
        let detail = event.detail.trimmingCharacters(in: .whitespacesAndNewlines)
        switch event.reason {
        case .retry:
            return "Tried again"
        case .afterQuit:
            return "Resumed after Juno quit"
        case .keepGoing:
            return "Kept going"
        default:
            return detail.isEmpty ? "Kept going" : "Kept going: \(detail)"
        }
    }
}

/// "Checked the goal: not yet — c2 has no Preview evidence".
struct StudioGoalVerdictRow: View {
    let event: GoalVerdictEvent

    var body: some View {
        Text(Self.caption(for: event))
            .font(Studio.Font.meta)
            .foregroundStyle(Studio.Ink.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 17)
    }

    static func caption(for event: GoalVerdictEvent) -> String {
        let reason = event.reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let suffix = reason.isEmpty ? "" : " — \(reason)"
        switch event.verdict {
        case .met: return "Checked the goal: met" + suffix
        case .notMet, .gateBlocked: return "Checked the goal: not yet" + suffix
        case .impossible: return "Checked the goal: it cannot be met" + suffix
        }
    }
}
