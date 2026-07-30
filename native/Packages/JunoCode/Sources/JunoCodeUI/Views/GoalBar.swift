import JunoCodeCore
import JunoDesignSystem
import SwiftUI

/// A compact, fixed affordance for a session's durable completion contract.
///
/// It shows one honest progress value in the reading surface and expands on
/// demand into the ordered steps and evidence. Keeping the detail in a popover
/// avoids turning every transcript into a project-management dashboard.
struct GoalBar: View {
    @Bindable var controller: SessionController
    @State private var showsDetails = false

    private var goal: SessionGoal? { controller.session.goal }

    var body: some View {
        if let goal {
            HStack(spacing: JunoSpace.snug) {
                Image(systemName: lifecycleGlyph(goal.lifecycle))
                    .foregroundStyle(lifecycleTint(goal.lifecycle))
                    .frame(width: 16)

                VStack(alignment: .leading, spacing: 2) {
                    Text(goal.objective)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Text(progressLabel(goal))
                        .junoCaption()
                        .lineLimit(1)
                }

                Spacer(minLength: JunoSpace.regular)

                ProgressView(value: goal.progress.fractionCompleted)
                    .progressViewStyle(.linear)
                    .frame(width: 96)
                    .tint(lifecycleTint(goal.lifecycle))
                    .accessibilityLabel("Goal progress")
                    .accessibilityValue(progressLabel(goal))

                Button {
                    showsDetails.toggle()
                } label: {
                    Label("Goal details", systemImage: "chevron.down")
                        .labelStyle(.iconOnly)
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .help("Show goal details")
                .accessibilityIdentifier("juno.code.goal.details")
                .popover(isPresented: $showsDetails, arrowEdge: .top) {
                    GoalDetails(controller: controller, goal: goal)
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.snug)
            .background(.bar)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(Color.junoHairline)
                    .frame(height: 1)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("juno.code.goal.bar")
        }
    }

    private func progressLabel(_ goal: SessionGoal) -> String {
        let progress = goal.progress
        if progress.blockedSteps > 0 {
            return "\(progress.completedSteps) of \(progress.totalSteps) complete · \(progress.blockedSteps) blocked"
        }
        return "\(progress.completedSteps) of \(progress.totalSteps) complete"
    }
}

private struct GoalDetails: View {
    @Bindable var controller: SessionController
    let goal: SessionGoal

    /// The goal's steps as AIcss to-dos.
    ///
    /// `blocked` survives the crossing: a step that has stopped and cannot
    /// continue is the one thing a reader glancing at a plan most needs told, and
    /// folding it into `pending` would say it is merely waiting its turn.
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
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Text("Goal").junoSidebarSection()
                        Text(goal.objective)
                            .font(.headline)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: JunoSpace.regular)
                    lifecycleControl
                }

                Divider()

                // AIcss's To-do List, driven by the goal's own steps.
                //
                // What it replaced was a numbered list with an SF Symbol per row —
                // correct, and silent about the two things a reader opens this
                // popover to learn. It never said how far along the plan was
                // except by counting glyphs, and the step being worked on right
                // now looked like every other row apart from its symbol. The
                // block's header carries the fraction as a determinate pie, and
                // the running step is the one line that shines.
                JunoAIcssTodoList(items: todoItems, title: "Steps")

                if !goal.verificationEvidence.isEmpty {
                    Divider()
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        Label("Verification", systemImage: "checkmark.seal")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        ForEach(goal.verificationEvidence, id: \.id) { evidence in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(evidence.summary)
                                    .junoCaption()
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(evidenceMetadata(evidence))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
            .padding(JunoSpace.regular)
        }
        .frame(width: 380)
        .frame(maxHeight: 560)
        .accessibilityIdentifier("juno.code.goal.popover")
    }

    private func evidenceMetadata(_ evidence: GoalVerificationEvidence) -> String {
        let source = evidence.source ?? "Juno runtime"
        let recordedAt = evidence.recordedAt.formatted(
            date: .abbreviated,
            time: .shortened
        )
        return "\(source) · \(recordedAt)"
    }

    @ViewBuilder
    private var lifecycleControl: some View {
        switch goal.lifecycle {
        case .active:
            Button("Pause") {
                Task { await controller.setGoalLifecycle(.paused) }
            }
        case .paused, .blocked:
            Button("Resume") {
                Task { await controller.setGoalLifecycle(.active) }
            }
        case .completed:
            Label("Complete", systemImage: "checkmark.seal.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.junoSuccess)
        }
    }
}

private func lifecycleGlyph(_ lifecycle: GoalLifecycle) -> String {
    switch lifecycle {
    case .active: "target"
    case .paused: "pause.circle.fill"
    case .blocked: "exclamationmark.octagon.fill"
    case .completed: "checkmark.seal.fill"
    }
}

private func lifecycleTint(_ lifecycle: GoalLifecycle) -> Color {
    switch lifecycle {
    case .active: Color.accentColor
    case .paused: Color.junoCaution
    case .blocked: Color.junoDanger
    case .completed: Color.junoSuccess
    }
}



