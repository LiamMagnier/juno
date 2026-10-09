import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// Settings → Agent → Autonomy (CODE_AGENT_SPEC §1.6, D-018): whether Juno
/// keeps a run going until the work is done and checked, how many times, how
/// it reviews its own diff, which surfaces it looks at, and the run and goal
/// budgets. Written to `autonomy` in the chosen settings file. None of it
/// widens a permission; an unapproved project file may only lower the bounds.
///
/// Owned by Lane A. Functional and plain in the Studio style; the visual
/// redesign comes with the new design system.
struct StudioAutonomySettings: View {
    let scope: CodeSettingsScope
    let settings: CodeSettingsModel

    private var overrides: AutonomySettings.Overrides? { settings.file(scope).autonomy }
    private var resolved: AutonomySettings { settings.resolved.autonomy }

    private func update(_ change: @escaping (inout AutonomySettings.Overrides) -> Void) {
        settings.update(scope) { file in
            var autonomy = file.autonomy ?? AutonomySettings.Overrides()
            change(&autonomy)
            file.autonomy = autonomy
        }
    }

    var body: some View {
        Section {
            StudioScopedToggle(
                title: "Keep working until the work is checked",
                detail: "Alevr sends itself back while todos are open, a check fails or has not run since the last edit, or the diff is unread. Off: it reports and stops when the model does.",
                scope: scope,
                value: overrides?.level.map { $0 == .standard },
                inherited: resolved.level == .standard
            ) { value in update { $0.level = value.map { $0 ? .standard : .off } } }

            let continues = overrides?.maxAutoContinues ?? resolved.maxAutoContinues
            Stepper(
                value: Binding(get: { continues }, set: { value in update { $0.maxAutoContinues = value } }),
                in: AutonomySettings.maxAutoContinuesRange
            ) {
                HStack {
                    Text("Times it may send itself back per run")
                    Spacer()
                    Text("\(continues)").font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
                }
            }

            Picker(selection: Binding(
                get: { overrides?.reviewBeforeFinish ?? resolved.reviewBeforeFinish },
                set: { value in update { $0.reviewBeforeFinish = value } }
            )) {
                Text("Never").tag(ReviewPolicy.off)
                Text("Read the diff").tag(ReviewPolicy.diff)
                Text("Reviewer for larger changes").tag(ReviewPolicy.auto)
                Text("Reviewer every time").tag(ReviewPolicy.always)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Review its own changes")
                    Text("Larger means over \(resolved.reviewThresholdLines) lines or 3 files.")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
            }

            StudioScopedToggle(
                title: "Run checks you already allow without asking",
                detail: "Only commands your rules or a goal's grants let run without a prompt. Anything else still asks.",
                scope: scope,
                value: overrides?.runChecksAutomatically,
                inherited: resolved.runChecksAutomatically
            ) { value in update { $0.runChecksAutomatically = value } }
        } header: {
            Text("Autonomy")
        } footer: {
            Text("Autonomy never changes what Alevr may do without asking: every action still goes through your permissions.")
        }

        Section {
            StudioScopedToggle(
                title: "Web pages, in the Preview",
                scope: scope,
                value: overrides?.autoVerify?.web,
                inherited: resolved.autoVerify.web
            ) { value in update { $0.autoVerify = Self.autoVerify($0.autoVerify, resolved: resolved.autoVerify) { $0.web = value ?? resolved.autoVerify.web } } }
            StudioScopedToggle(
                title: "Mac apps, through screen control",
                detail: "Only apps you granted for the session.",
                scope: scope,
                value: overrides?.autoVerify?.mac,
                inherited: resolved.autoVerify.mac
            ) { value in update { $0.autoVerify = Self.autoVerify($0.autoVerify, resolved: resolved.autoVerify) { $0.mac = value ?? resolved.autoVerify.mac } } }
            StudioScopedToggle(
                title: "iPhone apps, in the Simulator",
                scope: scope,
                value: overrides?.autoVerify?.ios,
                inherited: resolved.autoVerify.ios
            ) { value in update { $0.autoVerify = Self.autoVerify($0.autoVerify, resolved: resolved.autoVerify) { $0.ios = value ?? resolved.autoVerify.ios } } }
        } header: {
            Text("Look at the result after a UI change")
        }

        Section {
            budgetRow("A run without a goal", unit: "minutes", value: overrides?.runBudget?.minutes ?? resolved.runBudget.minutes) { minutes in
                update { $0.runBudget = Budget(minutes: minutes) }
            }
            let goal = overrides?.goalBudget ?? resolved.goalBudget
            budgetRow("A goal", unit: "minutes", value: goal.minutes) { minutes in
                update { $0.goalBudget = Budget(minutes: minutes, turns: goal.turns, tokens: goal.tokens, costUSD: goal.costUSD) }
            }
            budgetRow("A goal", unit: "turns", value: goal.turns) { turns in
                update { $0.goalBudget = Budget(minutes: goal.minutes, turns: turns, tokens: goal.tokens, costUSD: goal.costUSD) }
            }
            StudioScopedToggle(
                title: "Resume interrupted goals when Alevr opens",
                detail: "Off: a goal Alevr quit in the middle of waits for you to press Resume.",
                scope: scope,
                value: overrides?.resumeInterruptedGoalsOnLaunch,
                inherited: resolved.resumeInterruptedGoalsOnLaunch
            ) { value in update { $0.resumeInterruptedGoalsOnLaunch = value } }
        } header: {
            Text("Budgets")
        } footer: {
            Text("At a budget Alevr writes where it got to and stops; Keep going adds the same budget again. A budget is never reported as done.")
        }
    }

    private func budgetRow(_ title: String, unit: String, value: Int?, set: @escaping @MainActor (Int?) -> Void) -> some View {
        HStack {
            Text(title)
            Spacer()
            TextField("no limit", value: Binding(get: { value }, set: set), format: .number)
                .textFieldStyle(.roundedBorder)
                .frame(width: 72)
                .multilineTextAlignment(.trailing)
                .font(Studio.Font.metaDigits)
            Text(unit)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .frame(width: 56, alignment: .leading)
        }
    }

    private static func autoVerify(
        _ current: AutoVerify?,
        resolved: AutoVerify,
        _ change: (inout AutoVerify) -> Void
    ) -> AutoVerify {
        var value = current ?? resolved
        change(&value)
        return value
    }
}
