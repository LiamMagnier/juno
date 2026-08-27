import JunoCodeCore
import JunoDesignSystem
import SwiftUI

/// The durable completion contract for the selected task.
///
/// This is a strip rather than a dashboard card: the transcript is still the
/// work surface and the goal is context that should remain readable without
/// competing with it. The whole strip is one large target into the ordered
/// steps and verification evidence.
struct GoalBar: View {
    @Bindable var controller: SessionController
    @State private var showsDetails = false

    private var goal: SessionGoal? { controller.session.goal }

    var body: some View {
        if let goal {
            Button {
                showsDetails.toggle()
            } label: {
                HStack(spacing: JunoSpace.snug) {
                    JunoIconView(lifecycleIcon(goal.lifecycle), size: 15)
                        .foregroundStyle(lifecycleTint(goal.lifecycle))
                        .frame(width: 18)

                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Text(goal.objective)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        HStack(spacing: JunoSpace.tight) {
                            Text(progressLabel(goal))
                                .junoCaption()
                                .junoSecondaryInk()
                                .lineLimit(1)
                            if !goal.verificationEvidence.isEmpty {
                                Text("·")
                                    .junoCaption()
                                    .junoMetaInk()
                                JunoIconView(.check, size: 11)
                                    .foregroundStyle(Color.junoSuccess)
                                Text(verificationLabel(goal))
                                    .junoCaption()
                                    .foregroundStyle(Color.junoSuccess)
                                    .lineLimit(1)
                            }
                        }
                    }

                    Spacer(minLength: JunoSpace.regular)

                    ProgressView(value: goal.progress.fractionCompleted)
                        .progressViewStyle(.linear)
                        .frame(width: 72)
                        .tint(lifecycleTint(goal.lifecycle))
                        .accessibilityHidden(true)

                    JunoIconView(.chevronDown, size: 12)
                        .junoMetaInk()
                        .frame(width: 18)
                }
                .padding(.horizontal, JunoSpace.regular)
                .frame(minHeight: 48)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: CodeSessionLayout.measure)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, CodeSessionLayout.inset)
            .background(Color.junoCanvas)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(Color.junoSeparator)
                    .frame(height: 1)
                    .padding(.horizontal, CodeSessionLayout.inset)
            }
            .help("Show task goal, steps and verification")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Goal: \(goal.objective)")
            .accessibilityValue(accessibilityProgress(goal))
            .accessibilityIdentifier("juno.code.goal.details")
            .popover(isPresented: $showsDetails, arrowEdge: .top) {
                GoalDetails(controller: controller, goal: goal)
            }
            // The anchor can disappear because the agent may complete/remove a
            // goal while the popover is open. Close before AppKit tries to keep a
            // presentation attached to a view that has left the hierarchy.
            .onDisappear { showsDetails = false }
        }
    }

    private func progressLabel(_ goal: SessionGoal) -> String {
        let progress = goal.progress
        if progress.blockedSteps > 0 {
            return "\(progress.completedSteps)/\(progress.totalSteps) steps · \(progress.blockedSteps) blocked"
        }
        return "\(progress.completedSteps)/\(progress.totalSteps) steps"
    }

    private func verificationLabel(_ goal: SessionGoal) -> String {
        let count = goal.verificationEvidence.count
        return "\(count) verification\(count == 1 ? "" : "s")"
    }

    private func accessibilityProgress(_ goal: SessionGoal) -> String {
        let progress = goal.progress
        var parts = ["\(progress.completedSteps) of \(progress.totalSteps) steps complete"]
        if progress.blockedSteps > 0 {
            parts.append("\(progress.blockedSteps) blocked")
        }
        if !goal.verificationEvidence.isEmpty {
            parts.append(verificationLabel(goal))
        }
        return parts.joined(separator: ", ")
    }
}

private struct GoalDetails: View {
    @Bindable var controller: SessionController
    let goal: SessionGoal

    private var todoItems: [JunoAIcssTodoItem] {
        goal.steps.map { step in
            let state: JunoAIcssTodoItem.State =
                switch step.status {
                case .pending: .pending
                case .inProgress: .active
                case .completed: .done
                case .blocked: .blocked
                }
            return JunoAIcssTodoItem(id: step.id, label: step.title, state: state)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                header
                Divider().overlay(Color.junoSeparator)

                JunoAIcssTodoList(items: todoItems, title: "Steps")

                if !goal.verificationEvidence.isEmpty {
                    Divider().overlay(Color.junoSeparator)
                    verification
                }
            }
            .padding(JunoSpace.regular)
        }
        .frame(width: 400)
        .frame(maxHeight: 600)
        .accessibilityIdentifier("juno.code.goal.popover")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(lifecycleIcon(goal.lifecycle), size: 15)
                    .foregroundStyle(lifecycleTint(goal.lifecycle))
                Text(lifecycleLabel(goal.lifecycle))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(lifecycleTint(goal.lifecycle))
                Spacer(minLength: JunoSpace.regular)
                lifecycleControl
            }

            Text(goal.objective)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)

            Text(goalProgressSentence(goal))
                .junoCaption()
                .junoSecondaryInk()
        }
    }

    private var verification: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.tight) {
                JunoIconView(.check, size: 13)
                    .foregroundStyle(Color.junoSuccess)
                Text("Verification")
                    .font(.caption.weight(.semibold))
                    .junoSecondaryInk()
                Spacer(minLength: 0)
                Text("\(goal.verificationEvidence.count)")
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .junoMetaInk()
            }

            ForEach(goal.verificationEvidence, id: \.id) { evidence in
                VStack(alignment: .leading, spacing: 2) {
                    Text(evidence.summary)
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                    Text(evidenceMetadata(evidence))
                        .font(.caption2)
                        .junoSecondaryInk()
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .padding(.vertical, JunoSpace.hairline)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func evidenceMetadata(_ evidence: GoalVerificationEvidence) -> String {
        let source = evidence.source ?? "Juno runtime"
        let recordedAt = evidence.recordedAt.formatted(date: .abbreviated, time: .shortened)
        return "\(source) · \(recordedAt)"
    }

    private func goalProgressSentence(_ goal: SessionGoal) -> String {
        let progress = goal.progress
        if progress.blockedSteps > 0 {
            return "\(progress.completedSteps) of \(progress.totalSteps) steps complete, with \(progress.blockedSteps) blocked."
        }
        return "\(progress.completedSteps) of \(progress.totalSteps) steps complete."
    }

    @ViewBuilder
    private var lifecycleControl: some View {
        switch goal.lifecycle {
        case .active:
            Button("Pause") {
                Task { await controller.setGoalLifecycle(.paused) }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
        case .paused, .blocked:
            Button("Resume") {
                Task { await controller.setGoalLifecycle(.active) }
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
        case .completed:
            JunoIconLabel("Complete", icon: .check)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.junoSuccess)
        }
    }
}

private func lifecycleLabel(_ lifecycle: GoalLifecycle) -> String {
    switch lifecycle {
    case .active: "Active goal"
    case .paused: "Paused"
    case .blocked: "Blocked"
    case .completed: "Complete"
    }
}

private func lifecycleIcon(_ lifecycle: GoalLifecycle) -> JunoIcon {
    switch lifecycle {
    case .active: .pin
    case .paused: .stop
    case .blocked: .error
    case .completed: .check
    }
}

private func lifecycleTint(_ lifecycle: GoalLifecycle) -> Color {
    switch lifecycle {
    case .active: Color.junoAccent
    case .paused: Color.junoCaution
    case .blocked: Color.junoDanger
    case .completed: Color.junoSuccess
    }
}
