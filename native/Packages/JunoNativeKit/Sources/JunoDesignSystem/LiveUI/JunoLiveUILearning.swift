import SwiftUI

// The Live UI components that teach rather than calculate: a guided
// walkthrough (steps), a self-check (quiz), a key idea (callout) and an ordered
// process (timeline). The Swift side of `live-ui-learning.tsx`, same anatomy:
// no card, hairlines and type, two weights, Newsreader for the one display
// moment in each, the accent only on progress, motion only in answer to the
// reader. docs/design/LIVE_UI.md §2.

// MARK: Shared

/// One short rule per step or question; the current one in the accent.
struct LiveSegments: View {
    enum State { case done, missed, todo }
    let count: Int
    let current: Int
    let state: (Int) -> State
    var onSelect: ((Int) -> Void)?
    var label: (Int) -> String

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<count, id: \.self) { i in
                let bar = Capsule(style: .continuous)
                    .fill(fill(i))
                    .frame(height: 3)
                    .frame(maxWidth: .infinity)
                    .frame(height: 20)
                    .contentShape(Rectangle())
                if let onSelect {
                    Button { onSelect(i) } label: { bar }
                        .buttonStyle(.plain)
                        .accessibilityLabel(label(i))
                        .accessibilityAddTraits(i == current ? .isSelected : [])
                } else {
                    bar.accessibilityHidden(true)
                }
            }
        }
        .animation(JunoMotion.fast, value: current)
    }

    private func fill(_ i: Int) -> Color {
        if i == current { return .junoAccent }
        switch state(i) {
        case .done: return Color.junoForeground.opacity(0.55)
        case .missed: return Color.junoDestructiveInk.opacity(0.5)
        case .todo: return Color.junoForeground.opacity(0.1)
        }
    }
}

/// "More detail" and its kind: a quiet text button with a plus that turns.
struct LiveDisclosure<Content: View>: View {
    let label: String
    @ViewBuilder var content: () -> Content
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(JunoMotion.fast) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text(label)
                    JunoIconView(.plus, size: 12)
                        .rotationEffect(.degrees(open ? 45 : 0))
                }
                .font(.subheadline)
                .foregroundStyle(Color.junoSecondaryInk)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                content().transition(.opacity)
            }
        }
    }
}

private struct LiveNavButton: View {
    enum Kind { case quiet, primary }
    let title: String
    var leading: JunoIcon?
    var trailing: JunoIcon?
    var kind: Kind = .quiet
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let leading { JunoIconView(leading, size: 14) }
                Text(title).lineLimit(1).truncationMode(.tail)
                if let trailing { JunoIconView(trailing, size: 14) }
            }
            .font(.subheadline)
            .padding(.horizontal, 12)
            .frame(minHeight: 34)
            .foregroundStyle(kind == .primary ? Color.junoCanvas : Color.junoSecondaryInk)
            .background {
                if kind == .primary {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.junoForeground)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }
}

// MARK: Steps

/// A guided walkthrough. Beside the stage once there is room, the step list is
/// a map you can jump around; at phone width it folds into the segmented rail.
struct LiveStepsView: View {
    let steps: LiveStepsSpec
    let context: LiveUIContext
    @State private var active = 0
    @State private var reached = 0
    @State private var forward = true
    /// The step list sits beside the stage from 560pt; below it folds into the rail.
    @State private var width: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var total: Int { steps.steps.count }
    private func interp(_ s: String) -> String { liveInterpolate(s, scope: context.scope) }

    private func go(_ next: Int) {
        let clamped = max(0, min(total - 1, next))
        forward = clamped >= active
        withAnimation(reduceMotion ? nil : JunoMotion.base) { active = clamped }
        reached = max(reached, clamped)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Group {
                if width >= 560 {
                    HStack(alignment: .top, spacing: 28) {
                        stepList.frame(width: 176, alignment: .leading)
                        VStack(alignment: .leading, spacing: 12) {
                            if let title = steps.title { titleLine(title, count: false) }
                            stage
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 16) {
                        VStack(alignment: .leading, spacing: 8) {
                            titleLine(steps.title, count: true)
                            LiveSegments(
                                count: total,
                                current: active,
                                state: { $0 <= reached ? .done : .todo },
                                onSelect: go,
                                label: { "Step \($0 + 1): \(steps.steps[$0].title)" }
                            )
                        }
                        stage
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            if total > 1 { footer }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(steps.title.map(interp) ?? "Walkthrough")
    }

    private func titleLine(_ title: String?, count: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            if let title {
                Text(interp(title)).font(.system(.subheadline, weight: .medium)).junoInk()
            }
            Spacer(minLength: 0)
            if count {
                Text("\(active + 1) of \(total)")
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
    }

    private var stepList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(steps.steps.enumerated()), id: \.offset) { i, step in
                let on = i == active
                let done = i != active && i <= reached
                Button { go(i) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Group {
                            if done {
                                JunoIconView(.check, size: 12).foregroundStyle(Color.junoSecondaryInk)
                            } else {
                                Text(String(format: "%02d", i + 1))
                                    .font(.caption)
                                    .monospacedDigit()
                                    .foregroundStyle(on ? Color.junoForeground : Color.junoSecondaryInk)
                            }
                        }
                        .frame(width: 20, alignment: .leading)
                        Text(step.title)
                            .font(.system(.subheadline, weight: on ? .medium : .regular))
                            .foregroundStyle(on ? Color.junoForeground : Color.junoSecondaryInk)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 8)
                    .padding(.leading, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .leading) {
                        Capsule(style: .continuous)
                            .fill(on ? Color.junoAccent : Color.clear)
                            .frame(width: 2)
                            .padding(.vertical, 4)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }

    private var stage: some View {
        let step = steps.steps[min(active, total - 1)]
        return VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Text(step.title)
                    .font(JunoSerif.font(size: 21, relativeTo: .title3))
                    .junoInk()
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let summary = step.summary {
                    Text(interp(summary))
                        .font(.body)
                        .lineSpacing(4)
                        .foregroundStyle(Color.junoForeground.opacity(0.85))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !step.ui.isEmpty {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(step.ui) { LiveNodeView(component: $0, context: context) }
                }
                .padding(.vertical, 2)
            }
            if let notice = step.notice {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    JunoIconView(.eye, size: 13).foregroundStyle(Color.junoSecondaryInk)
                    (Text("Notice ").fontWeight(.medium).foregroundColor(.junoForeground)
                        + Text(interp(notice)).foregroundColor(.junoSecondaryInk))
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let detail = step.detail {
                LiveDisclosure(label: "More detail") {
                    Text(interp(detail))
                        .font(.subheadline)
                        .foregroundStyle(Color.junoForeground.opacity(0.85))
                        .padding(.leading, 12)
                        .overlay(alignment: .leading) { Rectangle().fill(Color.junoHairline).frame(width: 1) }
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let takeaway = steps.takeaway, active == total - 1, reached >= total - 1 {
                Text(interp(takeaway))
                    .font(JunoSerif.font(size: 18, relativeTo: .body, face: .italic))
                    .foregroundStyle(Color.junoForeground.opacity(0.9))
                    .padding(.leading, 14)
                    .overlay(alignment: .leading) { Rectangle().fill(Color.junoAccent.opacity(0.7)).frame(width: 2) }
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
        }
        .id(active)
        .transition(
            reduceMotion
                ? .opacity
                : .asymmetric(insertion: .opacity.combined(with: .offset(x: forward ? 12 : -12)), removal: .opacity)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var footer: some View {
        VStack(spacing: 10) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)
            HStack {
                LiveNavButton(title: "Back", leading: .arrowLeft, disabled: active == 0) { go(active - 1) }
                Spacer(minLength: 12)
                if active == total - 1 {
                    LiveNavButton(title: "Start over", leading: .rotateCcw) { go(0) }
                } else {
                    LiveNavButton(title: "Next: \(steps.steps[active + 1].title)", trailing: .arrowRight, kind: .primary) { go(active + 1) }
                }
            }
        }
    }
}

// MARK: Quiz

/// A self-check, answered in place; it never sends a message.
struct LiveQuizView: View {
    let quiz: LiveQuizSpec
    let context: LiveUIContext
    @State private var current = 0
    @State private var answers: [Int?]
    @State private var finished = false

    init(quiz: LiveQuizSpec, context: LiveUIContext) {
        self.quiz = quiz
        self.context = context
        _answers = State(initialValue: Array(repeating: nil, count: quiz.questions.count))
    }

    private var total: Int { quiz.questions.count }
    private func interp(_ s: String) -> String { liveInterpolate(s, scope: context.scope) }
    private var score: Int { quiz.questions.indices.filter { answers[$0] == quiz.questions[$0].answer }.count }
    private static let letters = Array("ABCDEF")

    private func reset() {
        withAnimation(JunoMotion.fast) {
            answers = Array(repeating: nil, count: total)
            current = 0
            finished = false
        }
    }

    var body: some View {
        if finished { recap } else { question }
    }

    private var recap: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let title = quiz.title {
                Text(interp(title)).font(.system(.subheadline, weight: .medium)).junoInk()
            }
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                (Text("\(score)").foregroundColor(.junoForeground) + Text("/\(total)").foregroundColor(.junoSecondaryInk))
                    .font(JunoSerif.font(size: 34, relativeTo: .largeTitle))
                    .monospacedDigit()
                Text(score == total ? "All correct." : score == 0 ? "Worth another look." : "Correct answers.")
                    .font(.subheadline)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            VStack(alignment: .leading, spacing: 0) {
                Rectangle().fill(Color.junoHairline).frame(height: 1)
                ForEach(Array(quiz.questions.enumerated()), id: \.offset) { i, q in
                    let ok = answers[i] == q.answer
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        JunoIconView(ok ? .check : .close, size: 13)
                            .foregroundStyle(ok ? Color.junoSuccessInk : Color.junoDestructiveInk)
                            .accessibilityLabel(ok ? "Correct" : "Missed")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(interp(q.question)).font(.subheadline).junoInk()
                            if !ok {
                                Text("Answer: \(q.options[q.answer].label)").font(.caption).foregroundStyle(Color.junoSecondaryInk)
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 9)
                    Rectangle().fill(Color.junoHairline).frame(height: 1)
                }
            }
            LiveNavButton(title: "Try again", leading: .rotateCcw) { reset() }
                .padding(.leading, -12)
        }
    }

    private var question: some View {
        let q = quiz.questions[min(current, total - 1)]
        let chosen = answers[current]
        let answered = chosen != nil
        let right = chosen == q.answer
        return VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    if let title = quiz.title ?? (total > 1 ? "Check yourself" : nil) {
                        Text(interp(title)).font(.system(.subheadline, weight: .medium)).junoInk()
                    }
                    Spacer(minLength: 0)
                    if total > 1 {
                        Text("\(current + 1) of \(total)").font(.subheadline).monospacedDigit().foregroundStyle(Color.junoSecondaryInk)
                    }
                }
                if total > 1 {
                    LiveSegments(
                        count: total,
                        current: current,
                        state: { i in answers[i] == nil ? .todo : answers[i] == quiz.questions[i].answer ? .done : .missed },
                        label: { "Question \($0 + 1)" }
                    )
                }
            }
            Text(interp(q.question))
                .font(JunoSerif.font(size: 20, relativeTo: .title3))
                .junoInk()
                .fixedSize(horizontal: false, vertical: true)
                .id("q\(current)")
            VStack(spacing: 6) {
                ForEach(Array(q.options.enumerated()), id: \.offset) { i, option in
                    optionRow(i, option.label, q: q, chosen: chosen)
                }
            }
            if let hint = q.hint, !answered {
                LiveDisclosure(label: "Hint") {
                    Text(interp(hint)).font(.subheadline).italic().foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let chosen {
                VStack(alignment: .leading, spacing: 10) {
                    Rectangle().fill(Color.junoHairline).frame(height: 1)
                    let why = q.options[chosen].explanation ?? q.explanation ?? (right ? "" : "The answer is \(q.options[q.answer].label).")
                    (Text(right ? "Correct. " : "Not quite. ").fontWeight(.medium).foregroundColor(right ? .junoSuccessInk : .junoDestructiveInk)
                        + Text(interp(why)).foregroundColor(Color.junoForeground.opacity(0.85)))
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Spacer()
                        if current < total - 1 {
                            LiveNavButton(title: "Next question", trailing: .arrowRight, kind: .primary) {
                                withAnimation(JunoMotion.fast) { current += 1 }
                            }
                        } else if total > 1 {
                            LiveNavButton(title: "See your score", trailing: .arrowRight, kind: .primary) {
                                withAnimation(JunoMotion.fast) { finished = true }
                            }
                        } else {
                            LiveNavButton(title: "Try again", leading: .rotateCcw) { reset() }
                        }
                    }
                }
                .transition(.opacity)
            }
        }
        .animation(JunoMotion.fast, value: answered)
    }

    private func optionRow(_ i: Int, _ label: String, q: LiveQuizSpec.Question, chosen: Int?) -> some View {
        enum Mark { case idle, right, wrong, dim }
        let mark: Mark = chosen == nil ? .idle : i == q.answer ? .right : i == chosen ? .wrong : .dim
        let edge: Color = switch mark {
        case .right: Color.junoSuccessInk.opacity(0.5)
        case .wrong: Color.junoDestructiveInk.opacity(0.45)
        default: Color.junoBorder
        }
        let fill: Color = switch mark {
        case .right: Color.junoSuccessInk.opacity(0.07)
        case .wrong: Color.junoDestructiveInk.opacity(0.06)
        default: .clear
        }
        return Button {
            guard chosen == nil else { return }
            withAnimation(JunoMotion.fast) { answers[current] = i }
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle().strokeBorder(mark == .right ? Color.junoSuccessInk.opacity(0.6) : mark == .wrong ? Color.junoDestructiveInk.opacity(0.5) : Color.junoBorder, lineWidth: 1)
                    switch mark {
                    case .right: JunoIconView(.check, size: 12).foregroundStyle(Color.junoSuccessInk)
                    case .wrong: JunoIconView(.close, size: 12).foregroundStyle(Color.junoDestructiveInk)
                    default:
                        Text(String(Self.letters[min(i, Self.letters.count - 1)]))
                            .font(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                }
                .frame(width: 24, height: 24)
                Text(label)
                    .font(.subheadline)
                    .junoInk()
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(edge, lineWidth: 1))
            .opacity(mark == .dim ? 0.55 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(i == chosen ? .isSelected : [])
    }
}

// MARK: Callout

/// One idea set apart: a ruled margin, its kind in small type, the idea in Newsreader.
struct LiveCalloutView: View {
    let callout: LiveCalloutSpec
    let context: LiveUIContext

    private var tone: (label: String, icon: JunoIcon, rule: Color) {
        switch callout.tone {
        case .insight: ("Key idea", .target, Color.junoAccent.opacity(0.7))
        case .tip: ("Tip", .star, Color.junoSuccessInk.opacity(0.6))
        case .warning: ("Watch out", .triangleAlert, Color.junoWarning.opacity(0.75))
        case .note: ("Note", .info, Color.junoForeground.opacity(0.25))
        }
    }

    var body: some View {
        let t = tone
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                JunoIconView(t.icon, size: 12)
                Text(callout.title.map { liveInterpolate($0, scope: context.scope) } ?? t.label)
            }
            .font(.caption)
            .foregroundStyle(Color.junoSecondaryInk)
            Text(liveInterpolate(callout.text, scope: context.scope))
                .font(JunoSerif.font(size: 18, relativeTo: .body))
                .lineSpacing(3)
                .junoInk()
                .fixedSize(horizontal: false, vertical: true)
            if let more = callout.more {
                LiveDisclosure(label: "Read more") {
                    Text(liveInterpolate(more, scope: context.scope))
                        .font(.subheadline)
                        .foregroundStyle(Color.junoForeground.opacity(0.85))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.leading, 16)
        .padding(.vertical, 2)
        .overlay(alignment: .leading) { Rectangle().fill(t.rule).frame(width: 2) }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Timeline

/// Ordered stages on one rail; a time, when given, sits right of the label.
struct LiveTimelineView: View {
    let timeline: LiveTimelineSpec
    let context: LiveUIContext

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title = timeline.title {
                Text(liveInterpolate(title, scope: context.scope)).font(.system(.subheadline, weight: .medium)).junoInk()
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(timeline.items.enumerated()), id: \.offset) { i, item in
                    let last = i == timeline.items.count - 1
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(i + 1)")
                            .font(.caption)
                            .monospacedDigit()
                            .junoInk()
                            .frame(width: 28, height: 28)
                            .background(Circle().fill(Color.junoCanvas))
                            .overlay(Circle().strokeBorder(Color.junoForeground.opacity(0.2), lineWidth: 1))
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(liveInterpolate(item.label, scope: context.scope))
                                    .font(.system(.subheadline, weight: .medium))
                                    .junoInk()
                                Spacer(minLength: 8)
                                if let time = item.time {
                                    Text(time).font(.subheadline).monospacedDigit().foregroundStyle(Color.junoSecondaryInk)
                                }
                            }
                            if let detail = item.detail {
                                Text(liveInterpolate(detail, scope: context.scope))
                                    .font(.subheadline)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.top, 4)
                        .padding(.bottom, last ? 0 : 16)
                    }
                    .background(alignment: .topLeading) {
                        if !last {
                            Rectangle().fill(Color.junoBorder).frame(width: 1).padding(.top, 28).padding(.leading, 13.5)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}
