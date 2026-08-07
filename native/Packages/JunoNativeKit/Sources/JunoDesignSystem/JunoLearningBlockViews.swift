import SwiftUI

/// The inline learning blocks, as SwiftUI. Ports `src/components/chat/learning/`.
///
/// **The shell is a RULE-BOUNDED FIGURE, not a card.** Two horizontal hairlines
/// and the transcript's own paper: no fill, no radius, no side borders, no
/// shadow. That is the whole reason these read as calm inside a flat transcript —
/// a chat that answers with three nested boxes in a row looks like a dashboard,
/// not like a document. Structure comes from typography (serif titles, one
/// monospaced marginalia voice) and whitespace, never from another container.
///
/// The one deliberate divergence from the web: **Mermaid diagrams are not
/// rendered natively.** The web draws them by handing the source to Mermaid 11 in
/// a sandboxed, opaque-origin iframe. Native has no equivalent it can trust — a
/// `WKWebView` loading a CDN inside the transcript is a different security
/// posture, and drawing "a diagram" from a Mermaid graph without a Mermaid engine
/// would be inventing a picture. A ```mermaid fence therefore stays a labelled
/// code block, which is true.

// MARK: - Shell

/// The only outer chrome any learning block gets.
public struct JunoLessonShell<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            rule
            content
                .padding(.vertical, 16)
            rule
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var rule: some View {
        Rectangle()
            .fill(Color.junoHairline)
            .frame(height: 1)
            .accessibilityHidden(true)
    }
}

/// A monospaced micro-label — "Process", "Quick check", "Verdict".
struct JunoLessonMicrocap: View {
    let text: String
    var tint: Color = .junoMutedForeground

    var body: some View {
        Text(text)
            .junoFont(size: 11, relativeTo: .caption, weight: .semibold, design: .monospaced)
            .foregroundStyle(tint)
    }
}

/// The kicker row: a short tone-coloured dash, then the microcap. The dash is the
/// only place a block spends colour on chrome, and it is what makes a block
/// findable when skimming a long transcript.
struct JunoLessonKicker: View {
    let text: String
    var accent: Color = .junoAccent
    var tint: Color = .junoMutedForeground

    var body: some View {
        HStack(spacing: 8) {
            Capsule(style: .continuous)
                .fill(accent)
                .frame(width: 20, height: 1.5)
                .accessibilityHidden(true)
            JunoLessonMicrocap(text: text, tint: tint)
        }
    }
}

/// Kicker + serif title + optional description — the shell's fixed anatomy.
struct JunoLessonHeader: View {
    let kicker: String
    var accent: Color = .junoAccent
    var kickerTint: Color = .junoMutedForeground
    var title: String?
    var description: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            JunoLessonKicker(text: kicker, accent: accent, tint: kickerTint)
            if let title, !title.isEmpty {
                Text(title)
                    .font(JunoSerif.font(size: 20, relativeTo: .title3, face: .medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let description, !description.isEmpty {
                Text(description)
                    .junoFont(size: 15, relativeTo: .body)
                    .lineSpacing(6)
                    .foregroundStyle(Color.junoMutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The quiet text-only disclosure control: monospaced microcap plus a `+` that
/// rotates into an `×`. A chevron would read as navigation; this reads as "there
/// is more of this here", which is what it is.
struct JunoLessonToggle: View {
    let label: String
    let open: Bool
    let toggle: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                JunoLessonMicrocap(text: label)
                Text(verbatim: "+")
                    .junoFont(size: 13, relativeTo: .subheadline, design: .monospaced)
                    .foregroundStyle(Color.junoMutedForeground)
                    .rotationEffect(.degrees(open ? 45 : 0))
                    .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: open)
            }
            .contentShape(Rectangle())
            .frame(minHeight: JunoLessonMetrics.touchTarget, alignment: .leading)
        }
        .buttonStyle(.junoPress)
        .accessibilityLabel(label)
        .accessibilityAddTraits(open ? [.isSelected] : [])
    }
}

enum JunoLessonMetrics {
    /// Coarse-pointer minimum. The web spells this `coarse:min-h-11`; on the Mac
    /// a 44pt row would be oversized, so only touch gets it.
    static var touchTarget: CGFloat {
        #if os(macOS)
        22
        #else
        44
        #endif
    }
}

// MARK: - Learning card

/// A margin note, not a card: the kicker in the tone colour, then title and body
/// behind a 2pt tone-coloured left rule — the printed-aside marker. Deliberately
/// inert; there is nothing here to interact with.
public struct JunoLearningCardView: View {
    private let card: JunoLearningBlocks.Card

    public init(card: JunoLearningBlocks.Card) {
        self.card = card
    }

    private var tone: (label: String, color: Color) {
        switch card.tone {
        case .insight: ("Key idea", .junoAccent)
        case .tip: ("Tip", .junoSource)
        case .warning: ("Watch out", .junoCaution)
        case .note: ("Note", .junoMutedForeground)
        }
    }

    public var body: some View {
        JunoLessonShell {
            VStack(alignment: .leading, spacing: 10) {
                JunoLessonKicker(text: tone.label, accent: tone.color, tint: tone.color)
                HStack(alignment: .top, spacing: 0) {
                    Rectangle()
                        .fill(tone.color.opacity(0.7))
                        .frame(width: 2)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(titleLine)
                            .font(JunoSerif.font(size: 19, relativeTo: .title3, face: .medium))
                            .fixedSize(horizontal: false, vertical: true)
                        Text(card.content)
                            .junoFont(size: 15, relativeTo: .body)
                            .lineSpacing(6)
                            .foregroundStyle(Color.junoForeground.opacity(0.8))
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    .padding(.leading, 14)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(tone.label): \(card.title)")
    }

    /// The icon is a character the model wrote, so it is set in the title run
    /// rather than beside it — that keeps it on the title's baseline and lets it
    /// wrap with the words instead of hanging in a fixed gutter.
    private var titleLine: String {
        guard let icon = card.icon else { return card.title }
        return "\(icon) \(card.title)"
    }
}

// MARK: - Process timeline

/// A process the reader walks through. Every stage and its description stay
/// visible at all times — a process is understood by seeing the whole sequence —
/// and the interaction is purely additive EMPHASIS: tap a stage to light it, and
/// the hairline spine fills up to it. Nothing is ever hidden behind the selection.
public struct JunoProcessTimelineView: View {
    private let timeline: JunoLearningBlocks.Timeline
    @State private var active: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(timeline: JunoLearningBlocks.Timeline) {
        self.timeline = timeline
    }

    public var body: some View {
        JunoLessonShell {
            VStack(alignment: .leading, spacing: 8) {
                JunoLessonHeader(
                    kicker: "Process",
                    accent: .junoCaution,
                    kickerTint: .junoCaution,
                    title: timeline.title
                )
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(timeline.steps.enumerated()), id: \.element.id) { index, step in
                        row(step, index: index, isLast: index == timeline.steps.count - 1)
                    }
                }
                .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: active)
            }
        }
    }

    private func row(_ step: JunoLearningBlocks.TimelineStep, index: Int, isLast: Bool) -> some View {
        let isActive = active == index
        let isWalked = (active ?? -1) > index
        return Button {
            active = isActive ? nil : index
        } label: {
            HStack(alignment: .top, spacing: 14) {
                // A hanging numeral and, under it, the spine that fills as the
                // reader walks. The spine is drawn in this row rather than
                // between rows so it cannot fall out of step with the numbers.
                VStack(spacing: 0) {
                    Text("\(index + 1)")
                        .font(JunoSerif.font(size: 24, relativeTo: .title2, face: .medium))
                        .monospacedDigit()
                        .foregroundStyle(
                            isActive ? Color.junoAccent
                                : isWalked ? Color.junoForeground : Color.junoMutedForeground
                        )
                    if !isLast {
                        Rectangle()
                            .fill(isWalked ? Color.junoAccent.opacity(0.5) : Color.junoHairline)
                            .frame(width: 1)
                            .frame(maxHeight: .infinity)
                            .padding(.top, 4)
                    }
                }
                .frame(width: 28)
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 4) {
                    Text(step.label)
                        .font(JunoSerif.font(size: 15, relativeTo: .callout, face: .semibold))
                        .foregroundStyle(isActive ? Color.junoAccent : Color.junoForeground)
                        .fixedSize(horizontal: false, vertical: true)
                    if let description = step.description {
                        Text(description)
                            .junoFont(size: 14, relativeTo: .body)
                            .lineSpacing(5)
                            .foregroundStyle(Color.junoMutedForeground)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 10)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(isActive ? Color.junoAccent.opacity(0.05) : .clear)
            )
        }
        .buttonStyle(.junoPress)
        .accessibilityLabel("Stage \(index + 1): \(step.label)")
        .accessibilityValue(step.description ?? "")
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
    }
}

// MARK: - Comparison

/// A book table: ruled rows, single-ink headers (the differences live in the
/// values, so a coloured header per column would be noise), and one reading aid —
/// tap a column header to focus it, which dims the others so a wall of cells can
/// be read as serial single-column passes.
///
/// Below a regular width it becomes a stack of definition lists, exactly as the
/// web does under `sm:`. A four-column table squeezed into a phone is not a
/// table; it is four columns of hyphens.
public struct JunoComparisonView: View {
    private let comparison: JunoLearningBlocks.Comparison
    @State private var focused: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if !os(macOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    public init(comparison: JunoLearningBlocks.Comparison) {
        self.comparison = comparison
    }

    private var isWide: Bool {
        #if os(macOS)
        true
        #else
        sizeClass != .compact
        #endif
    }

    public var body: some View {
        JunoLessonShell {
            VStack(alignment: .leading, spacing: 10) {
                JunoLessonHeader(kicker: "Comparison", kickerTint: .junoAccent, title: comparison.title)
                if isWide { table } else { stacked }
                if let verdict = comparison.verdict { verdictFooter(verdict) }
            }
            // `.tint`: focus here is drawn as a border and fill colour, not as
            // a ring that grows. See ``JunoMotion/Tier``.
            .animation(
                JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint),
                value: focused
            )
        }
    }

    // MARK: Wide

    private var table: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 12, verticalSpacing: 0) {
            GridRow {
                JunoLessonMicrocap(text: "Focus")
                    .padding(.vertical, 8)
                ForEach(Array(comparison.columns.enumerated()), id: \.offset) { index, column in
                    columnHeader(column, index: index)
                }
            }
            Rectangle()
                .fill(Color.junoHairline)
                .frame(height: 1)
                .gridCellUnsizedAxes(.horizontal)
            ForEach(comparison.rows) { row in
                GridRow {
                    Text(row.label)
                        .junoFont(size: 14, relativeTo: .body, weight: .semibold)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 10)
                    ForEach(Array(comparison.columns.enumerated()), id: \.offset) { index, _ in
                        cell(row.values.indices.contains(index) ? row.values[index] : nil, column: index)
                    }
                }
                if row.id != comparison.rows.last?.id {
                    Rectangle()
                        .fill(Color.junoHairline.opacity(0.5))
                        .frame(height: 1)
                        .gridCellUnsizedAxes(.horizontal)
                }
            }
        }
    }

    private func columnHeader(_ column: String, index: Int) -> some View {
        let isFocused = focused == index
        return Button {
            focused = isFocused ? nil : index
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(column)
                    .junoFont(size: 13, relativeTo: .subheadline, weight: .semibold)
                    .lineLimit(1)
                Capsule(style: .continuous)
                    .fill(Color.junoAccent)
                    .frame(width: 28, height: 2)
                    .opacity(isFocused ? 1 : 0)
                    .scaleEffect(x: isFocused ? 1 : 0.05, anchor: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .opacity(dimmed(index) ? 0.5 : 1)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.junoPress)
        .accessibilityLabel("Column \(column)")
        .accessibilityHint("Focuses this column")
        .accessibilityAddTraits(isFocused ? [.isSelected] : [])
    }

    private func cell(_ value: String?, column: Int) -> some View {
        // An absent cell is an em dash at reduced contrast, never a blank: a gap
        // in a comparison row reads as "the table is broken", and an em dash
        // reads as "this option does not have one", which is what it means.
        Text(value?.isEmpty == false ? value! : "—")
            .junoFont(size: 14, relativeTo: .body)
            .lineSpacing(4)
            .foregroundStyle(
                value?.isEmpty == false
                    ? Color.junoMutedForeground
                    : Color.junoMutedForeground
            )
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .opacity(dimmed(column) ? 0.5 : 1)
            .padding(.vertical, 10)
    }

    private func dimmed(_ column: Int) -> Bool {
        focused != nil && focused != column
    }

    // MARK: Narrow

    private var stacked: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(comparison.rows) { row in
                if row.id != comparison.rows.first?.id {
                    Rectangle().fill(Color.junoHairline.opacity(0.6)).frame(height: 1)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text(row.label)
                        .junoFont(size: 14, relativeTo: .body, weight: .semibold)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(comparison.columns.enumerated()), id: \.offset) { index, column in
                        HStack(alignment: .top, spacing: 12) {
                            Text(column)
                                .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                                .foregroundStyle(Color.junoMutedForeground)
                                .lineLimit(1)
                                .frame(width: 86, alignment: .leading)
                            let value = row.values.indices.contains(index) ? row.values[index] : nil
                            Text(value?.isEmpty == false ? value! : "—")
                                .junoFont(size: 14, relativeTo: .body)
                                .foregroundStyle(
                                    value?.isEmpty == false
                                        ? Color.junoForeground.opacity(0.8)
                                        : Color.junoMutedForeground
                                )
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .padding(.vertical, 12)
            }
        }
    }

    private func verdictFooter(_ verdict: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)
            JunoLessonMicrocap(text: "Verdict", tint: .junoAccent)
                .padding(.top, 6)
            HStack(alignment: .top, spacing: 0) {
                Rectangle()
                    .fill(Color.junoAccent.opacity(0.7))
                    .frame(width: 2)
                    .accessibilityHidden(true)
                Text(verdict)
                    .font(JunoSerif.font(size: 15, relativeTo: .callout, face: .mediumItalic))
                    .lineSpacing(6)
                    .foregroundStyle(Color.junoForeground.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 14)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 4)
    }
}

// MARK: - Deep dive

/// An appendix entry: collapsed, it promises exactly what opening delivers —
/// title, one-line summary, a quiet `+`. Open, the content reads behind a
/// tone-coloured quotation rule that tells the eye it has entered supplementary
/// material. Honest progressive disclosure at minimum visual cost.
public struct JunoDeepDiveView: View {
    private let deepDive: JunoLearningBlocks.DeepDive
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(deepDive: JunoLearningBlocks.DeepDive) {
        self.deepDive = deepDive
    }

    public var body: some View {
        JunoLessonShell {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    open.toggle()
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            JunoLessonKicker(text: "Deep dive", accent: .junoSource, tint: .junoSource)
                            Text(deepDive.title)
                                .font(JunoSerif.font(size: 16, relativeTo: .callout, face: .medium))
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if deepDive.summary != deepDive.title, !open {
                                Text(deepDive.summary)
                                    .junoFont(size: 13, relativeTo: .subheadline)
                                    .foregroundStyle(Color.junoMutedForeground)
                                    .lineLimit(1)
                            }
                        }
                        Text(verbatim: "+")
                            .junoFont(size: 16, relativeTo: .body, design: .monospaced)
                            .foregroundStyle(Color.junoMutedForeground)
                            .rotationEffect(.degrees(open ? 45 : 0))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.junoPress)

                if open {
                    HStack(alignment: .top, spacing: 0) {
                        Rectangle()
                            .fill(Color.junoSource.opacity(0.4))
                            .frame(width: 1)
                            .accessibilityHidden(true)
                        Text(deepDive.content)
                            .junoFont(size: 15, relativeTo: .body)
                            .lineSpacing(6)
                            .foregroundStyle(Color.junoForeground.opacity(0.85))
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .padding(.leading, 14)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.junoInline)
                }
            }
            .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: open)
        }
        .accessibilityHint(open ? "Collapses this deep dive" : "Expands this deep dive")
    }
}

// MARK: - Quiz

/// A self-contained quiz: answer → learn → advance, ending on a recap that scores
/// the run. One question degrades to the plain single-question form (no progress
/// rail, no recap). Purely local — it never sends a message, so an answer costs
/// nothing and can be tried again.
///
/// Shared by the standalone `:::quiz` block and the Step Lab's closing check, so
/// the two cannot drift.
public struct JunoQuizInteraction: View {
    private let questions: [JunoLearningBlocks.QuizQuestion]
    private let onComplete: ((Int, Int) -> Void)?

    @State private var current = 0
    @State private var answers: [Int?]
    @State private var showRecap = false
    @State private var hintOpen = false
    @State private var fired = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let letters = Array("ABCDEFGH")

    public init(
        questions: [JunoLearningBlocks.QuizQuestion],
        onComplete: ((Int, Int) -> Void)? = nil
    ) {
        self.questions = questions
        self.onComplete = onComplete
        _answers = State(initialValue: Array(repeating: nil, count: questions.count))
    }

    private var total: Int { questions.count }
    private var multi: Bool { total > 1 }
    private var score: Int {
        zip(answers, questions).reduce(into: 0) { total, pair in
            guard let choice = pair.0, pair.1.options.indices.contains(choice) else { return }
            if pair.1.options[choice].correct { total += 1 }
        }
    }

    public var body: some View {
        Group {
            if showRecap {
                recap
            } else if questions.indices.contains(current) {
                question(questions[current])
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: current)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: showRecap)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: answers)
        // Grow-only, and deliberately not a reset: the initial value handed to
        // `_answers` is discarded once this view has an identity, so a quiz that
        // gains a question leaves `answers` short and `record(answer:)` silently
        // dropping every answer past the old end. Padding keeps what the reader
        // already answered; rebuilding the array would throw it away to fix a
        // bookkeeping problem they never saw.
        .onChange(of: questions.count) { _, count in
            if answers.count < count {
                answers.append(contentsOf: Array(repeating: nil, count: count - answers.count))
            } else if answers.count > count {
                answers.removeLast(answers.count - count)
            }
        }
    }

    // MARK: One question

    /// The answer recorded for a question, or nil when there is none — including
    /// when there is no such slot.
    ///
    /// `answers` is `@State` sized once from `questions.count`, and SwiftUI keeps
    /// the first value for the life of the view's identity. `questions` is a
    /// plain `let` the parent can replace. So the two can disagree about how many
    /// questions there are, and every raw `answers[index]` keyed off a
    /// `questions` index is an out-of-range trap waiting for a longer quiz to
    /// land on an established identity. The other accessors in this file already
    /// guard; these two did not.
    private func answer(at index: Int) -> Int? {
        answers.indices.contains(index) ? answers[index] : nil
    }

    @ViewBuilder
    private func question(_ q: JunoLearningBlocks.QuizQuestion) -> some View {
        let selected = answer(at: current)
        let answered = selected != nil
        let chosen = selected.flatMap { q.options.indices.contains($0) ? q.options[$0] : nil }
        let correctIndex = q.options.firstIndex(where: \.correct) ?? 0

        VStack(alignment: .leading, spacing: 12) {
            if multi { progressRow }

            Text(q.question)
                .font(JunoSerif.font(size: 17, relativeTo: .body, face: .medium))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            VStack(spacing: 0) {
                ForEach(Array(q.options.enumerated()), id: \.element.id) { index, option in
                    if index > 0 {
                        Rectangle().fill(Color.junoHairline.opacity(0.6)).frame(height: 1)
                    }
                    optionRow(option, index: index, selected: selected, answered: answered)
                }
            }

            if let hint = q.hint, !answered {
                VStack(alignment: .leading, spacing: 2) {
                    JunoLessonToggle(label: "Hint", open: hintOpen) { hintOpen.toggle() }
                    if hintOpen {
                        Text(hint)
                            .font(JunoSerif.font(size: 14, relativeTo: .subheadline, face: .mediumItalic))
                            .lineSpacing(5)
                            .foregroundStyle(Color.junoMutedForeground)
                            .fixedSize(horizontal: false, vertical: true)
                            .transition(.junoInline)
                    }
                }
                .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: hintOpen)
            }

            if answered {
                answerKey(q, chosen: chosen, correctIndex: correctIndex)
                    .transition(.junoInline)
            }
        }
    }

    private var progressRow: some View {
        HStack {
            JunoLessonMicrocap(text: "Question \(current + 1) of \(total)")
            Spacer(minLength: 12)
            HStack(spacing: 4) {
                ForEach(questions.indices, id: \.self) { index in
                    Capsule(style: .continuous)
                        .fill(
                            index == current
                                ? Color.junoAccent
                                : answer(at: index) != nil
                                    ? Color.junoAccent.opacity(0.45)
                                    : Color.junoMutedForeground.opacity(0.25)
                        )
                        .frame(width: index == current ? 16 : 6, height: 4)
                }
            }
            .accessibilityHidden(true)
        }
    }

    /// Idle → correct / wrong / reveal / dim. The reveal state is what makes a
    /// wrong answer teach: the right option lights up alongside it rather than
    /// the reader being told only that they were wrong.
    private func optionRow(
        _ option: JunoLearningBlocks.QuizOption,
        index: Int,
        selected: Int?,
        answered: Bool
    ) -> some View {
        let isChosen = selected == index
        let state: OptionState = !answered
            ? .idle
            : isChosen ? (option.correct ? .correct : .wrong) : (option.correct ? .reveal : .dim)

        return Button {
            choose(index)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Text(marker(state, index: index))
                    .junoFont(size: 12, relativeTo: .footnote, weight: .semibold, design: .monospaced)
                    .foregroundStyle(state.markerColor)
                    .frame(width: 18)
                Text(option.label)
                    .font(JunoSerif.font(size: 15, relativeTo: .callout))
                    .lineSpacing(5)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 8)
            .frame(minHeight: JunoLessonMetrics.touchTarget)
            .opacity(state == .dim ? 0.5 : 1)
            .background(alignment: .leading) {
                HStack(spacing: 0) {
                    Rectangle()
                        .fill(state.railColor)
                        .frame(width: 2)
                    state.fillColor
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.junoPress)
        .disabled(answered)
        .accessibilityLabel(option.label)
        .accessibilityValue(state.accessibilityValue)
    }

    private func answerKey(
        _ q: JunoLearningBlocks.QuizQuestion,
        chosen: JunoLearningBlocks.QuizOption?,
        correctIndex: Int
    ) -> some View {
        let isCorrect = chosen?.correct ?? false
        let explanation = chosen?.explanation ?? q.explanation
        let fallback = isCorrect
            ? "well spotted."
            : "the answer is \(Self.letters.indices.contains(correctIndex) ? String(Self.letters[correctIndex]) : "\(correctIndex + 1)")."

        // Verdict and explanation are ONE text run, not two stacked lines: the
        // sentence is "Not quite — the answer is B", and breaking it in two
        // would read as a label above an unrelated remark.
        let verdict = Text(isCorrect ? "Correct — " : "Not quite — ")
            .font(JunoSerif.font(size: 15, relativeTo: .callout, face: .mediumItalic))
            .foregroundStyle(isCorrect ? Color.junoSuccess : Color.junoDanger)
        let body = Text(explanation ?? fallback)
            .font(.junoBody)
            .foregroundStyle(Color.junoMutedForeground)

        return VStack(alignment: .leading, spacing: 10) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)
            (verdict + body)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            if multi {
                Button {
                    advance()
                } label: {
                    JunoLessonMicrocap(
                        text: current == total - 1 ? "See results →" : "Next question →",
                        tint: .junoAccent
                    )
                    .frame(minHeight: JunoLessonMetrics.touchTarget, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.junoPress)
            } else {
                Button(action: reset) {
                    JunoLessonMicrocap(text: "Try again")
                        .frame(minHeight: JunoLessonMetrics.touchTarget, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.junoPress)
            }
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: Recap

    private var recap: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                JunoLessonMicrocap(text: "Recap", tint: .junoAccent)
                Text(recapLine)
                    .font(JunoSerif.font(size: 18, relativeTo: .title3, face: .medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(questions.enumerated()), id: \.element.id) { index, question in
                    if index > 0 {
                        Rectangle().fill(Color.junoHairline.opacity(0.5)).frame(height: 1)
                    }
                    recapRow(question, answer: answer(at: index))
                }
            }
            Button(action: reset) {
                JunoLessonMicrocap(text: "Start over")
                    .frame(minHeight: JunoLessonMetrics.touchTarget, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.junoPress)
        }
    }

    private var recapLine: String {
        score == total
            ? "You got \(score) of \(total) correct — nothing missed."
            : "You got \(score) of \(total) correct."
    }

    private func recapRow(_ question: JunoLearningBlocks.QuizQuestion, answer: Int?) -> some View {
        let right = answer.map { question.options.indices.contains($0) && question.options[$0].correct } ?? false
        let correctLabel = question.options.first(where: \.correct)?.label
        return HStack(alignment: .top, spacing: 10) {
            Text(right ? "✓" : "✕")
                .junoFont(size: 13, relativeTo: .subheadline, weight: .semibold, design: .monospaced)
                .foregroundStyle(right ? Color.junoSuccess : Color.junoDanger)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(question.question)
                    .font(JunoSerif.font(size: 15, relativeTo: .callout))
                    .foregroundStyle(Color.junoForeground.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
                if !right, let correctLabel {
                    Text("Answer: \(correctLabel)")
                        .junoFont(size: 13, relativeTo: .subheadline)
                        .foregroundStyle(Color.junoMutedForeground)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    // MARK: Behaviour

    private func choose(_ index: Int) {
        guard answers.indices.contains(current), answers[current] == nil else { return }
        answers[current] = index
        if !multi {
            fire(questions[current].options.indices.contains(index)
                && questions[current].options[index].correct ? 1 : 0)
        }
    }

    private func advance() {
        if current == total - 1 {
            showRecap = true
            fire(score)
        } else {
            current += 1
            hintOpen = false
        }
    }

    private func reset() {
        answers = Array(repeating: nil, count: total)
        current = 0
        showRecap = false
        hintOpen = false
        fired = false
    }

    /// Fires once per run. Without the latch, re-entering the recap (Start over →
    /// finish again) would report a second, unrelated completion to the caller.
    private func fire(_ final: Int) {
        guard !fired else { return }
        fired = true
        onComplete?(final, total)
    }

    private func marker(_ state: OptionState, index: Int) -> String {
        switch state {
        case .correct, .reveal: "✓"
        case .wrong: "✕"
        case .idle, .dim:
            Self.letters.indices.contains(index) ? String(Self.letters[index]) : "\(index + 1)"
        }
    }

    private enum OptionState {
        case idle, correct, wrong, reveal, dim

        var markerColor: Color {
            switch self {
            case .correct, .reveal: .junoSuccess
            case .wrong: .junoDanger
            case .idle, .dim: .junoMutedForeground
            }
        }

        var railColor: Color {
            switch self {
            case .correct, .reveal: .junoSuccess.opacity(0.7)
            case .wrong: .junoDanger.opacity(0.6)
            case .idle, .dim: .clear
            }
        }

        var fillColor: Color {
            switch self {
            case .correct: .junoSuccess.opacity(0.08)
            case .wrong: .junoDanger.opacity(0.06)
            case .idle, .reveal, .dim: .clear
            }
        }

        var accessibilityValue: String {
            switch self {
            case .idle: ""
            case .correct: "Correct, your answer"
            case .wrong: "Wrong, your answer"
            case .reveal: "Correct answer"
            case .dim: ""
            }
        }
    }
}

/// The standalone `:::quiz` block — a magazine quiz. The kicker and optional
/// title head the shell; ``JunoQuizInteraction`` owns the run.
public struct JunoQuizBlockView: View {
    private let quiz: JunoLearningBlocks.Quiz

    public init(quiz: JunoLearningBlocks.Quiz) {
        self.quiz = quiz
    }

    public var body: some View {
        JunoLessonShell {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    JunoLessonKicker(text: "Quick check", tint: .junoAccent)
                    if let title = quiz.title {
                        Text(title)
                            .font(JunoSerif.font(size: 19, relativeTo: .title3, face: .medium))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                JunoQuizInteraction(questions: quiz.questions)
            }
        }
    }
}

// MARK: - Dispatcher

/// Renders one parsed learning block.
///
/// `messageStreaming` lets a trailing unclosed block stay a placeholder while
/// tokens arrive, then be salvage-parsed the moment the reply finishes — so a
/// truncated lesson still renders instead of a placeholder that waits forever.
public struct JunoLearningBlockView: View {
    private let parsed: JunoLearningBlocks.Parsed
    private let messageStreaming: Bool

    public init(parsed: JunoLearningBlocks.Parsed, messageStreaming: Bool) {
        self.parsed = parsed
        self.messageStreaming = messageStreaming
    }

    public var body: some View {
        let block = parsed.streaming && !messageStreaming
            ? JunoLearningBlocks.salvage(parsed)
            : parsed

        if block.streaming {
            placeholder(kind: block.kind)
        } else if let payload = block.payload {
            switch payload {
            case .stepLab(let lab):
                JunoStepLabView(lab: lab, error: block.error)
            case .learningCard(let card):
                JunoLearningCardView(card: card)
            case .processTimeline(let timeline):
                JunoProcessTimelineView(timeline: timeline)
            case .comparison(let comparison):
                JunoComparisonView(comparison: comparison)
            case .quiz(let quiz):
                JunoQuizBlockView(quiz: quiz)
            case .deepDive(let deepDive):
                JunoDeepDiveView(deepDive: deepDive)
            }
        } else {
            fallback(kind: block.kind, error: block.error)
        }
    }

    /// The one sanctioned loop in this file: the block genuinely is being written
    /// right now, and the dot matrix is what says so everywhere else in Juno.
    private func placeholder(kind: JunoLearningBlocks.Kind) -> some View {
        JunoLessonShell {
            HStack(spacing: 12) {
                JunoThinkingMatrix()
                    .foregroundStyle(Color.junoMutedForeground)
                JunoLessonMicrocap(text: "Building \(kind.label)")
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Building \(kind.label)")
        .accessibilityAddTraits(.updatesFrequently)
    }

    /// A block that could not be parsed says so, in one line, and names the
    /// reason when it has one. It does NOT print the YAML — the reader did not
    /// write it and cannot fix it, and a wall of source in the middle of an
    /// answer is the failure looking worse than it is.
    private func fallback(kind: JunoLearningBlocks.Kind, error: String?) -> some View {
        let claim = Text("This \(kind.label.lowercased()) couldn't be rendered")
            .font(.junoBody)
            .foregroundStyle(Color.junoForeground.opacity(0.85))
        let reason = Text(error.map { ". \($0)" } ?? ".")
            .font(.junoBody)
            .foregroundStyle(Color.junoMutedForeground)

        return JunoLessonShell {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .junoFont(size: 13, relativeTo: .subheadline)
                    .foregroundStyle(Color.junoCaution)
                (claim + reason)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

#if DEBUG
/// The whole family on one page. Kept as a preview rather than a gallery screen
/// because these are only ever seen inside a transcript, and the thing worth
/// checking is exactly that: that four figures in a row still read as a document.
#Preview("Learning blocks") {
    let source = """
    Here is the short version.

    :::learning-card
    title: Indexes are not free
    tone: warning
    icon: ⚠️
    content: Every index is another write on every insert. Add them for reads you actually make.
    :::

    :::process-timeline
    title: A request
    steps:
      - label: Receive
        description: Parse the body and authenticate.
      - label: Route
        description: Pick the handler.
      - label: Answer
        description: Serialize and send.
    :::

    :::comparison
    columns: [Postgres, SQLite]
    rows:
      - label: Concurrency
        values: [Many writers, One writer]
      - label: Operations
        values: [A server to run, A file to copy]
    verdict: SQLite until the second writer.
    :::

    :::quiz
    question: Which HTTP method is idempotent?
    options:
      - label: POST
      - label: PUT
        correct: true
        explanation: Repeating a PUT lands on the same state.
    hint: Think about repeating the request.
    :::

    :::deep-dive
    title: Why VACUUM exists
    summary: Dead tuples are not reclaimed on delete.
    content: Postgres keeps old row versions until nothing can still see them.
    :::
    """
    return ScrollView {
        JunoLessonText(source)
            .padding(24)
            .frame(maxWidth: 640)
    }
    .background(Color.junoCanvas)
}
#endif
