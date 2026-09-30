import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// MARK: - Checklist

/// The agent's `todo_write` checklist, as it last wrote it: one quiet card,
/// a mark per step and the step's words. The step in progress reads in its
/// active form.
struct StudioTodoCard: View {
    let list: TodoListEvent

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack {
                Text("Checklist")
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.primary)
                Spacer()
                Text("\(list.completedCount) of \(list.items.count)")
                    .font(Studio.Font.metaDigits)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                ForEach(list.items) { item in
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        mark(item.status)
                            .frame(width: 12, height: 12)
                            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                        Text(item.status == .inProgress ? (item.activeForm ?? item.content) : item.content)
                            .font(Studio.Font.label)
                            .foregroundStyle(item.status == .completed ? Studio.Ink.tertiary : Studio.Ink.primary)
                            .strikethrough(item.status == .completed, color: Studio.Ink.tertiary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityValue(Self.accessibilityStatus(item.status))
                }
            }
        }
        .padding(JunoSpace.cozy)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .strokeBorder(Studio.Surface.hairline)
        )
    }

    @ViewBuilder
    private func mark(_ status: TodoStatus) -> some View {
        switch status {
        case .completed:
            JunoIconView(.squareCheck, size: 12).foregroundStyle(Studio.Ink.tertiary)
        case .inProgress:
            StudioSpinner(color: Studio.Ink.accent, lineWidth: 1.25).frame(width: 10, height: 10)
        case .pending:
            JunoIconView(.square, size: 12).foregroundStyle(Studio.Ink.tertiary)
        }
    }

    private static func accessibilityStatus(_ status: TodoStatus) -> String {
        switch status {
        case .completed: "Done"
        case .inProgress: "In progress"
        case .pending: "To do"
        }
    }
}

// MARK: - Answered questions

/// A question the reader already dealt with, and what they said.
struct StudioQuestionRow: View {
    let request: QuestionRequest
    let resolution: QuestionResolution

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            ForEach(request.questions) { question in
                VStack(alignment: .leading, spacing: 2) {
                    Text(question.question)
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.secondary)
                    Text(answerText(for: question))
                        .font(Studio.Font.label)
                        .foregroundStyle(Studio.Ink.primary)
                }
            }
        }
        .padding(.leading, 17)
        .accessibilityElement(children: .combine)
    }

    private func answerText(for question: UserQuestion) -> String {
        switch resolution {
        case let .answered(answers):
            guard let answer = answers.first(where: { $0.questionID == question.id }) else { return "No answer" }
            return (answer.selectedOptions + [answer.text].compactMap { $0 }).joined(separator: " — ")
        case .declined: return "Not answered"
        case .expired: return "No answer in time"
        case .cancelled: return "Stopped before an answer"
        }
    }
}

// MARK: - Plan in the thread

/// The plan a Plan-mode run handed over, and what became of it.
struct StudioPlanReviewCard: View {
    let request: PlanApprovalRequest
    let decision: PlanDecision?
    @Binding var isExpanded: Bool

    private var outcome: String? {
        switch decision {
        case nil: nil
        case let .approved(mode)?: "Approved — \(StudioMode(behavior: .code, permission: mode).title)"
        case .keepPlanning?: "Sent back for more planning"
        case .expired?: "Not reviewed in time"
        case .cancelled?: "Stopped"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack {
                Text("Plan")
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.primary)
                Spacer()
                if let outcome {
                    Text(outcome)
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
                Button(isExpanded ? "Less" : "More") { isExpanded.toggle() }
                    .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.tertiary))
                    .contentShape(.rect)
            }
            StudioAssistantMessage(text: request.plan)
                .frame(maxHeight: isExpanded ? nil : 180, alignment: .top)
                .clipped()
        }
        .padding(JunoSpace.cozy)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .strokeBorder(Studio.Surface.hairline)
        )
    }
}

// MARK: - Waiting on the reader

/// The agent's question, above the composer while it waits: each question
/// with its options as buttons, a line for an answer in the reader's own
/// words, and Send or Skip. Answering is not an approval of anything.
struct StudioQuestionPrompt: View {
    let controller: SessionController

    @State private var selections: [String: Set<String>] = [:]
    @State private var notes: [String: String] = [:]

    private var request: QuestionRequest? { controller.pendingQuestions.first }

    var body: some View {
        if let request {
            card(request)
                .id(request.id)
                .transition(.junoInline)
                .task(id: request.id) {
                    selections = [:]
                    notes = [:]
                }
        }
    }

    private func card(_ request: QuestionRequest) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.circleHelp, size: 14)
                    .foregroundStyle(Studio.Ink.accent)
                    .frame(width: 28, height: 28)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                            .fill(Studio.Ink.accent.opacity(0.12))
                    )
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(request.questions.count == 1 ? "Juno has a question" : "Juno has \(request.questions.count) questions")
                        .font(Studio.Font.labelEmphasis)
                        .foregroundStyle(Studio.Ink.primary)
                    Text("It is waiting for your answer before it continues.")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
                Spacer()
            }

            ForEach(request.questions) { question in
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    if let header = question.header {
                        Text(header.uppercased())
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.tertiary)
                    }
                    Text(question.question)
                        .font(Studio.Font.label)
                        .foregroundStyle(Studio.Ink.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        ForEach(question.options, id: \.label) { option in
                            optionButton(option, in: question)
                        }
                    }
                    TextField("Or answer in your own words", text: noteBinding(question.id), axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .font(Studio.Font.label)
                        .lineLimit(1...3)
                        .accessibilityIdentifier("juno.code.question.text.\(question.id)")
                }
            }

            HStack(spacing: JunoSpace.snug) {
                Button("Skip") {
                    Task { await controller.declineQuestion(request.id) }
                }
                .buttonStyle(StudioQuietButtonStyle())
                .contentShape(.rect)
                .accessibilityIdentifier("juno.code.question.skip")
                Spacer()
                Button("Send answer") {
                    let answers = request.questions.map { question in
                        QuestionAnswer(
                            questionID: question.id,
                            selectedOptions: question.options.map(\.label)
                                .filter { selections[question.id, default: []].contains($0) },
                            text: notes[question.id]
                        )
                    }
                    Task { await controller.answerQuestion(request.id, answers: answers) }
                }
                .buttonStyle(StudioPrimaryButtonStyle())
                .contentShape(.rect)
                .disabled(!hasAnswer(request))
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("juno.code.question.send")
            }
        }
        .padding(JunoSpace.regular)
        .junoLiftedSurface(cornerRadius: Studio.Radius.composer)
        .overlay(
            RoundedRectangle(cornerRadius: Studio.Radius.composer, style: .continuous)
                .strokeBorder(Studio.Ink.accent.opacity(0.5), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }

    private func optionButton(_ option: UserQuestionOption, in question: UserQuestion) -> some View {
        let selected = selections[question.id, default: []].contains(option.label)
        return Button {
            var current = selections[question.id, default: []]
            if question.allowsMultipleSelection {
                if selected { current.remove(option.label) } else { current.insert(option.label) }
            } else {
                current = selected ? [] : [option.label]
            }
            selections[question.id] = current
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                JunoIconView(
                    question.allowsMultipleSelection
                        ? (selected ? .squareCheck : .square)
                        : (selected ? .circleCheck : .circle),
                    size: 12
                )
                .foregroundStyle(selected ? Studio.Ink.accent : Studio.Ink.tertiary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(option.label)
                        .font(Studio.Font.label)
                        .foregroundStyle(Studio.Ink.primary)
                    if let detail = option.description {
                        Text(detail)
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                    .fill(selected ? Studio.Ink.accent.opacity(0.08) : Studio.Surface.muted)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func noteBinding(_ id: String) -> Binding<String> {
        Binding(get: { notes[id, default: ""] }, set: { notes[id] = $0 })
    }

    private func hasAnswer(_ request: QuestionRequest) -> Bool {
        request.questions.contains { question in
            !selections[question.id, default: []].isEmpty
                || !(notes[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        }
    }
}

/// A plan waiting for the reader: Approve and implement, at a permission
/// level the reader picks here, or Keep planning with a note. Approving
/// never picks a level for them — the button says which one it will use.
struct StudioPlanApprovalPrompt: View {
    let controller: SessionController

    @State private var mode: StudioMode = .askBeforeEdits
    @State private var feedback = ""
    @State private var showsFeedback = false

    private var request: PlanApprovalRequest? { controller.pendingPlans.first }

    /// The levels a plan can be implemented at: the ladder minus Plan itself.
    private static let choices: [StudioMode] = [.askBeforeEdits, .autoEdit, .fullAccess]

    var body: some View {
        if let request {
            card(request)
                .id(request.id)
                .transition(.junoInline)
                .task(id: request.id) {
                    feedback = ""
                    showsFeedback = false
                    // Start from the level the session had before Plan, when
                    // it had one, but never pick for the reader beyond it.
                    let stored = controller.session.configuration.permissionMode
                    mode = Self.choices.first { $0.permission == stored } ?? .askBeforeEdits
                }
        }
    }

    private func card(_ request: PlanApprovalRequest) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.listChecks, size: 14)
                    .foregroundStyle(Studio.Ink.accent)
                    .frame(width: 28, height: 28)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                            .fill(Studio.Ink.accent.opacity(0.12))
                    )
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Implement this plan?")
                        .font(Studio.Font.labelEmphasis)
                        .foregroundStyle(Studio.Ink.primary)
                    Text("The plan is in the thread above. Approving switches to Code at the level you pick.")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
                Spacer()
            }

            if showsFeedback {
                TextField("What should change?", text: $feedback, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .font(Studio.Font.label)
                    .lineLimit(1...4)
                    .accessibilityIdentifier("juno.code.plan.feedback")
            }

            HStack(spacing: JunoSpace.snug) {
                Button(showsFeedback ? "Send back" : "Keep planning") {
                    if showsFeedback {
                        let note = feedback
                        Task { await controller.keepPlanning(request.id, feedback: note) }
                    } else {
                        showsFeedback = true
                    }
                }
                .buttonStyle(StudioQuietButtonStyle())
                .contentShape(.rect)
                .accessibilityIdentifier("juno.code.plan.keep")
                Spacer(minLength: JunoSpace.snug)
                Picker("Level", selection: $mode) {
                    ForEach(Self.choices) { choice in
                        Text(choice.title).tag(choice)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .fixedSize()
                .accessibilityLabel("Permission level for implementing the plan")
                .accessibilityIdentifier("juno.code.plan.level")
                Button("Approve") {
                    let chosen = mode.permission
                    Task { await controller.approvePlan(request.id, mode: chosen) }
                }
                .buttonStyle(StudioPrimaryButtonStyle())
                .contentShape(.rect)
                .help("Switch to \(mode.title) and implement the plan")
                .accessibilityIdentifier("juno.code.plan.approve")
            }
        }
        .padding(JunoSpace.regular)
        .junoLiftedSurface(cornerRadius: Studio.Radius.composer)
        .overlay(
            RoundedRectangle(cornerRadius: Studio.Radius.composer, style: .continuous)
                .strokeBorder(Studio.Ink.accent.opacity(0.5), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }
}
