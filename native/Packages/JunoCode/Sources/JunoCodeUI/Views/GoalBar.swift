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
                JunoIconView(lifecycleIcon(goal.lifecycle), size: 16)
                    .foregroundStyle(lifecycleTint(goal.lifecycle))
                    .frame(width: 16)

                Text(goal.objective)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: JunoSpace.regular)

                Text(progressLabel(goal))
                    .junoCodeSmall()
                    .junoSecondaryInk()
                    .lineLimit(1)

                ProgressView(value: goal.progress.fractionCompleted)
                    .progressViewStyle(.linear)
                    .frame(width: 84)
                    .tint(lifecycleTint(goal.lifecycle))
                    .accessibilityLabel("Goal progress")
                    .accessibilityValue(progressLabel(goal))

                Button {
                    showsDetails.toggle()
                } label: {
                    JunoIconView(.chevronDown, size: 13)
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .help("Show goal details")
                .accessibilityLabel("Goal details")
                .accessibilityIdentifier("juno.code.goal.details")
                .popover(isPresented: $showsDetails, arrowEdge: .top) {
                    GoalDetails(controller: controller, goal: goal)
                }
                // The anchor for this popover lives inside `if let goal`, and the
                // goal can go nil without anyone clicking anything — the agent
                // completes it, or the session is switched underneath us. A
                // popover whose anchor leaves the hierarchy while it is still
                // presented makes SwiftUI re-run `updatePresentations` and call
                // `showRelativeToRect:` against a window that is already being
                // ordered, which raises an uncaught `NSRemoteView` exception and
                // takes the process with SIGTRAP. Same defence as
                // `JunoThinkingControl`; the difference here is that there is no
                // outside click to dismiss it first.
                .onDisappear { showsDetails = false }
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.snug)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(Color.junoRaised.opacity(0.55))
            )
            .frame(maxWidth: CodeSessionLayout.measure, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, CodeSessionLayout.inset)
            .padding(.vertical, JunoSpace.tight)
            .background(Color.junoCanvas)
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
                        JunoIconLabel("Verification", icon: .check)
                            .font(.caption.weight(.semibold))
                            .junoSecondaryInk()
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
            JunoIconLabel("Complete", icon: .check)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.junoSuccess)
        }
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
    // `Color.junoAccent`, never `Color.accentColor`: the latter resolves to the
    // asset catalogue's accent and so ignores the accent the reader picked,
    // leaving this one glyph a different coral from every other accented mark in
    // the window.
    case .active: Color.junoAccent
    case .paused: Color.junoCaution
    case .blocked: Color.junoDanger
    case .completed: Color.junoSuccess
    }
}
