import SwiftUI
import JunoCodeCore
import JunoCodeRuntime
import JunoDesignSystem

/// The goal sheet (`/goal` with no argument, or the progress row): the
/// objective, each criterion with how it is checked and its evidence, the
/// budget and what it has used, the verdict history, and past goals
/// (CODE_AGENT_SPEC §2.8). Words throughout; no status pills.
struct StudioGoalSheet: View {
    let goal: GoalRun?
    let history: [GoalRun]
    let perform: (GoalRowContent.Action) -> Void
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("Goal")
                    .font(Studio.Font.title)
                    .foregroundStyle(Studio.Ink.primary)
                Spacer()
                Button("Done", action: done)
                    .buttonStyle(StudioSecondaryButtonStyle())
                    .keyboardShortcut(.cancelAction).contentShape(.rect)
            }
            .padding(JunoSpace.regular)
            .studioHairline()

            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    if let goal {
                        current(goal)
                    } else {
                        Text("No goal is set. Type /goal and what should be true when the work is done.")
                            .font(Studio.Font.label)
                            .foregroundStyle(Studio.Ink.secondary)
                    }
                    if !history.isEmpty {
                        section("Earlier goals") {
                            ForEach(history.reversed()) { past in
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(past.objective)
                                        .font(Studio.Font.label)
                                        .foregroundStyle(Studio.Ink.primary)
                                        .lineLimit(2)
                                    Text(Self.historyLine(past))
                                        .font(Studio.Font.meta)
                                        .foregroundStyle(Studio.Ink.tertiary)
                                }
                            }
                        }
                    }
                }
                .padding(JunoSpace.regular)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 520, idealWidth: 600, minHeight: 420, idealHeight: 560)
        .background(Studio.Surface.canvas)
    }

    @ViewBuilder
    private func current(_ goal: GoalRun) -> some View {
        let row = GoalRowContent(goal: goal)
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(goal.objective)
                .font(Studio.Font.labelEmphasis)
                .foregroundStyle(Studio.Ink.primary)
                .fixedSize(horizontal: false, vertical: true)
            Text(studioInline: Self.statusLine(goal))
                .font(Studio.Font.meta)
                .foregroundStyle(goal.status == .needsYou || goal.status == .budgetReached ? Studio.Ink.primary : Studio.Ink.secondary)
            HStack(spacing: JunoSpace.snug) {
                ForEach(Array(row.actions.enumerated()), id: \.element) { index, action in
                    if index > 0 {
                        Text("·").font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
                    }
                    Button(action.rawValue) { perform(action) }
                        .buttonStyle(StudioGoalActionStyle(emphasis: index == 0 && action != .clear)).contentShape(.rect)
                }
            }
        }

        section("Criteria") {
            ForEach(goal.criteria) { criterion in
                VStack(alignment: .leading, spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        Text(criterion.id)
                            .font(Studio.Font.monoSmall)
                            .foregroundStyle(Studio.Ink.tertiary)
                            .frame(width: 22, alignment: .leading)
                        Text(criterion.text)
                            .font(Studio.Font.label)
                            .foregroundStyle(Studio.Ink.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(studioInline: Self.criterionLine(criterion, goal: goal))
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .padding(.leading, 30)
                }
            }
        }

        if !goal.constraints.isEmpty {
            section("Constraints") {
                ForEach(goal.constraints, id: \.self) { constraint in
                    Text(constraint)
                        .font(Studio.Font.label)
                        .foregroundStyle(Studio.Ink.secondary)
                }
            }
        }

        section("Budget") {
            Text(GoalText.budgetLine(goal).map { "Used \($0)" } ?? "No limit")
                .font(Studio.Font.metaDigits)
                .foregroundStyle(Studio.Ink.secondary)
            if !goal.grants.isEmpty {
                Text(studioInline: "May run without asking: " + goal.grants.map { "`\($0.command)`" }.joined(separator: ", "))
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
        }

        if !goal.verdicts.isEmpty {
            section("Checks of the goal") {
                ForEach(Array(goal.verdicts.reversed().enumerated()), id: \.offset) { index, verdict in
                    StudioGoalVerdictRow(
                        event: GoalVerdictEvent(
                            goalID: goal.id,
                            verdict: verdict.kind,
                            reason: verdict.reason,
                            unmetCriteria: verdict.unmetCriteria,
                            revision: verdict.revision
                        ),
                        initiallyExpanded: index == 0
                    )
                }
                if goal.olderVerdictCount > 0 {
                    Text("\(goal.olderVerdictCount) earlier checks")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
            }
        }
    }

    @ViewBuilder
    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(title)
                .font(Studio.Font.caption)
                .foregroundStyle(Studio.Ink.tertiary)
            content()
        }
    }

    static func statusLine(_ goal: GoalRun) -> String {
        switch goal.status {
        case .active: return "Working toward it"
        case .paused: return goal.statusReason ?? "Paused"
        case .needsYou: return goal.statusReason ?? "Waiting for you"
        case .budgetReached: return goal.statusReason ?? "Used its budget"
        case .achieved: return "Met"
        case .impossible: return "Cannot be met: \(goal.statusReason ?? "the judge said so")"
        case .cleared: return "Cleared"
        }
    }

    static func criterionLine(_ criterion: GoalCriterion, goal: GoalRun) -> String {
        var parts = [criterion.checkSentence]
        if let verdict = goal.lastVerdict {
            if verdict.unmetCriteria.contains(criterion.id) {
                parts.append("not met at the last check")
            } else if verdict.kind == .met {
                parts.append("met")
            }
        }
        if !criterion.evidence.isEmpty {
            parts.append("evidence: " + criterion.evidence.suffix(3).joined(separator: ", "))
        }
        return parts.joined(separator: " · ")
    }

    static func historyLine(_ goal: GoalRun) -> String {
        let minutes = Int(goal.usage.minutes.rounded())
        let outcome: String
        switch goal.status {
        case .achieved: outcome = "Met"
        case .impossible: outcome = "Judged impossible"
        default: outcome = goal.status.words.prefix(1).uppercased() + goal.status.words.dropFirst()
        }
        return "\(outcome) · \(minutes) min · \(goal.usage.turns) turn\(goal.usage.turns == 1 ? "" : "s") · "
            + goal.updatedAt.formatted(date: .abbreviated, time: .shortened)
    }
}
