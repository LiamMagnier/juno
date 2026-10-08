import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The goal start card (CODE_AGENT_SPEC §2.3): the objective and the criteria
/// Juno drafted from it, each saying how it will be checked, the budget, and
/// the commands the goal may run without asking — each unticked until the
/// reader ticks it. Typing `/goal` was the approval of the goal itself, so the
/// card needs one click: Start. The same card edits a goal.
struct StudioGoalStartCard: View {
    @Binding var draft: GoalDraft
    let isEditing: Bool
    let isDrafting: Bool
    let replacesCurrent: Bool
    let errorMessage: String?
    let start: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.primary)
                Spacer()
                if isDrafting {
                    Text("Drafting criteria…")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
            }

            field("Objective") {
                TextField("What should be true when this is done?", text: $draft.objective, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(Studio.Font.label)
                    .lineLimit(1...4)
                    .accessibilityIdentifier("juno.code.goal.objective")
            }

            field("Done when") {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    ForEach($draft.criteria) { $criterion in
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                            Text(criterion.id)
                                .font(Studio.Font.monoSmall)
                                .foregroundStyle(Studio.Ink.tertiary)
                                .frame(width: 22, alignment: .leading)
                            VStack(alignment: .leading, spacing: 1) {
                                TextField("A criterion a reviewer could check", text: $criterion.text, axis: .vertical)
                                    .textFieldStyle(.plain)
                                    .font(Studio.Font.label)
                                    .lineLimit(1...3)
                                Text(studioInline: criterion.checkSentence)
                                    .font(Studio.Font.meta)
                                    .foregroundStyle(Studio.Ink.tertiary)
                            }
                            Spacer(minLength: 0)
                            if draft.criteria.count > 1 {
                                Button("Remove") { remove(criterion.id) }
                                    .buttonStyle(StudioGoalActionStyle()).contentShape(.rect)
                            }
                        }
                    }
                    if draft.criteria.count < GoalRun.maximumCriteria {
                        Button("Add a criterion", action: addCriterion)
                            .buttonStyle(StudioGoalActionStyle()).contentShape(.rect)
                    }
                }
            }

            field("Budget") {
                HStack(spacing: JunoSpace.regular) {
                    budgetField("minutes", value: $draft.budget.minutes)
                    budgetField("turns", value: $draft.budget.turns)
                    costField
                    Spacer(minLength: 0)
                }
            }

            if !draft.offeredGrants.isEmpty, !isEditing {
                field("Without asking") {
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        ForEach(draft.offeredGrants, id: \.self) { command in
                            Toggle(isOn: grantBinding(command)) {
                                Text("May run `\(command)` without asking while this goal is active")
                                    .font(Studio.Font.meta)
                                    .foregroundStyle(Studio.Ink.secondary)
                            }
                            .toggleStyle(.checkbox)
                        }
                        Text("Anything else still asks as it does now. A goal never changes the permission mode.")
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.tertiary)
                    }
                }
            }

            if replacesCurrent {
                Text("Starting this goal replaces the current one, which moves to the goal's history.")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
            }

            HStack(spacing: JunoSpace.snug) {
                Spacer()
                Button(isEditing ? "Cancel" : "Not now", action: cancel)
                    .buttonStyle(StudioSecondaryButtonStyle())
                    .keyboardShortcut(.cancelAction).contentShape(.rect)
                Button(isEditing ? "Save" : (replacesCurrent ? "Replace and start" : "Start"), action: start)
                    .buttonStyle(StudioPrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .disabled(draft.objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("juno.code.goal.start").contentShape(.rect)
            }
        }
        .padding(JunoSpace.cozy)
        .modifier(StudioGoalSurface())
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }

    private var title: String {
        if isEditing { return "Edit the goal" }
        return draft.origin == .proposedByModel ? "Alevr suggests a goal" : "Start a goal"
    }

    @ViewBuilder
    private func field(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(label)
                .font(Studio.Font.caption)
                .foregroundStyle(Studio.Ink.tertiary)
            content()
        }
    }

    private func budgetField(_ unit: String, value: Binding<Int?>) -> some View {
        HStack(spacing: JunoSpace.tight) {
            TextField("no limit", value: value, format: .number)
                .textFieldStyle(.roundedBorder)
                .frame(width: 64)
                .font(Studio.Font.metaDigits)
            Text(unit)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
        }
    }

    private var costField: some View {
        HStack(spacing: JunoSpace.tight) {
            Text("$")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
            TextField("no limit", value: $draft.budget.costUSD, format: .number.precision(.fractionLength(0...2)))
                .textFieldStyle(.roundedBorder)
                .frame(width: 64)
                .font(Studio.Font.metaDigits)
        }
    }

    private func grantBinding(_ command: String) -> Binding<Bool> {
        Binding(
            get: { draft.selectedGrants.contains(command) },
            set: { ticked in
                if ticked { draft.selectedGrants.insert(command) } else { draft.selectedGrants.remove(command) }
            }
        )
    }

    private func addCriterion() {
        let next = (draft.criteria.compactMap { Int($0.id.dropFirst()) }.max() ?? 0) + 1
        draft.criteria.append(GoalCriterion(id: "c\(next)", text: ""))
    }

    private func remove(_ id: String) {
        draft.criteria.removeAll { $0.id == id }
    }
}
