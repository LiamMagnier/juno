import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// The loop's rows in the thread: continuation captions and goal verdicts
// (CODE_AGENT_SPEC §1.5, §2.8). Owned by Lane A. Plain words in the Studio
// style: no pills, no dots, never a message from the reader.

/// "Kept going: 2 todos were still open". A quiet divider caption.
struct StudioContinuedRow: View {
    let event: RunContinuedEvent

    var body: some View {
        StudioDividerCaption(text: Self.caption(for: event))
            .help(event.detail)
            .accessibilityLabel(Self.caption(for: event))
    }

    /// The longest caption the divider shows; the full fact is in the help.
    static let maximumCaption = 96

    static func caption(for event: RunContinuedEvent) -> String {
        let detail = event.detail.trimmingCharacters(in: .whitespacesAndNewlines)
        let text: String
        switch event.reason {
        case .retry:
            text = "Tried again"
        case .afterQuit:
            text = "Resumed after Juno quit"
        case .keepGoing:
            text = "Kept going"
        case .wrapUp:
            text = detail.isEmpty ? "Wrapping up" : detail
        case .checkIn:
            text = detail.isEmpty ? "Checked in on background work" : "Checked in: \(detail)"
        case .other("goal_resumed"):
            text = "Resumed the goal"
        case .gate(.goalNotMet):
            text = detail.isEmpty ? "Kept working toward the goal" : "Kept working toward the goal: \(detail)"
        default:
            text = detail.isEmpty ? "Kept going" : "Kept going: \(detail)"
        }
        return text.count > maximumCaption ? String(text.prefix(maximumCaption - 1)) + "…" : text
    }
}

/// "Checked the goal: not yet — c2 has no Preview evidence". Collapsed to one
/// line; opening it shows the full reason and the unmet criteria.
struct StudioGoalVerdictRow: View {
    let event: GoalVerdictEvent
    var initiallyExpanded = false
    @State private var isExpanded: Bool?

    private var expanded: Bool { isExpanded ?? initiallyExpanded }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Button {
                withAnimation(JunoMotion.fast) { isExpanded = !expanded }
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(expanded ? .chevronDown : .chevronRight, size: 10)
                        .foregroundStyle(Studio.Ink.tertiary)
                    // Open, the reason has its own line below.
                    Text(studioInline: expanded ? Self.caption(for: event, withReason: false) : Self.caption(for: event))
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Self.caption(for: event))
            .accessibilityHint(expanded ? "Hides the reason" : "Shows the reason")
            if expanded {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    if !event.reason.isEmpty {
                        Text(studioInline: event.reason)
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !event.unmetCriteria.isEmpty {
                        Text("Not met yet: \(event.unmetCriteria.joined(separator: ", "))")
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.secondary)
                    }
                    Text("At workspace revision \(event.revision)")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
                .padding(.leading, 17)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func caption(for event: GoalVerdictEvent, withReason: Bool = true) -> String {
        let reason = event.reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let suffix = reason.isEmpty || !withReason ? "" : " — \(reason)"
        switch event.verdict {
        case .met: return "Checked the goal: met" + suffix
        case .notMet: return "Checked the goal: not yet" + suffix
        case .gateBlocked: return "Checked the goal: evidence missing" + suffix
        case .impossible: return "Checked the goal: it cannot be met" + suffix
        }
    }
}

// MARK: - How a run ended

/// The words after "Worked for 4m 12s" in a run's divider, and whether they
/// ask for the reader (§1.3). Words only: the tone changes the ink, never adds
/// a mark.
enum StudioRunEnd {
    enum Tone: Equatable {
        case quiet
        case attention
    }

    static func tone(for reason: RunEndReason?) -> Tone {
        guard let reason else { return .quiet }
        switch reason.notification {
        case .needsYou, .failed: return .attention
        case .done, .none: return .quiet
        }
    }

    /// The divider's words for a run, from its end reason and detail; nil for
    /// a run recorded before end reasons existed, which says only how long it
    /// worked.
    static func words(for run: RunCompletedEvent) -> String? {
        guard let reason = run.endReason else { return nil }
        if let detail = run.endDetail?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty {
            return detail
        }
        switch reason {
        case .doneChecked: return "Checked"
        case .doneUnchecked: return nil
        case .checksFailing: return "A check still fails"
        case .blocked: return "Blocked"
        case .needsYou: return "Waiting for you"
        case .stepLimit: return "Stopped at the step limit. Keep going?"
        case .budget: return "Used the budget. Keep going?"
        case .stalled: return "Stopped: no progress in the last two tries"
        case .waitingOnBackground: return "Waiting for background work to finish"
        case .stopped: return "Stopped"
        case .interrupted: return "Juno quit while this was running"
        case .error: return nil
        }
    }
}

// MARK: - Inline code in words

extension Text {
    /// `text` with its backtick spans set as code, the way the agent and the
    /// runtime write commands and paths ("Checked with `swift test`").
    /// Anything else in it is shown as written.
    init(studioInline text: String) {
        guard text.contains("`"),
              let attributed = try? AttributedString(
                  markdown: text,
                  options: AttributedString.MarkdownParsingOptions(
                      allowsExtendedAttributes: false,
                      interpretedSyntax: .inlineOnlyPreservingWhitespace,
                      failurePolicy: .returnPartiallyParsedIfPossible
                  )
              )
        else {
            self.init(verbatim: text)
            return
        }
        self.init(attributed)
    }
}
