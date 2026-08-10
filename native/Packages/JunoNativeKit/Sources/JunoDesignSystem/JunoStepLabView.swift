import SwiftUI

/// The Step Lab block — a guided walkthrough with a visual per step.
///
/// Ports `src/components/chat/step-lab-block.tsx`. Every visual keeps the web's
/// grammar: drawn straight onto the transcript's paper, exactly two inks
/// (foreground and coral) plus the sanctioned semantic hues, one monospaced
/// readout line whose empty state is the visual's own action prompt, and motion
/// only as an A→B response to something the reader did.
///
/// The web's entrance choreography — bars growing from zero, a dot hopping
/// between stations, an SVG arrow drawing itself — is deliberately not
/// reproduced. Those are one-shot flourishes tied to a DOM mount, and in a
/// transcript that re-lays-out on every streamed token they would replay on the
/// reader repeatedly. What they communicated (which bar is largest, which
/// station follows which) is carried by the static form instead.
public struct JunoStepLabView: View {
    private let lab: JunoStepLab
    private let error: String?

    @State private var active = 0
    @State private var detailOpen = false
    @State private var quizDone = false
    /// Completion is sticky: once earned, navigating back does not take it away.
    @State private var completedOnce = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(lab: JunoStepLab, error: String? = nil) {
        self.lab = lab
        self.error = error
    }

    private var compact: Bool { lab.density == .compact }
    private var steps: [JunoStepLab.Step] { lab.steps }
    private var selected: JunoStepLab.Step { steps[min(active, steps.count - 1)] }
    private var onLast: Bool { active == steps.count - 1 }
    /// Only a lab with something to DO can be completed. A one-step, quiz-less
    /// lab would otherwise celebrate at mount, before the reader did anything.
    private var completable: Bool { steps.count > 1 || lab.quiz != nil }
    private var completed: Bool {
        completedOnce || (completable && onLast && (lab.quiz == nil || quizDone))
    }

    public var body: some View {
        JunoLessonShell {
            VStack(alignment: .leading, spacing: compact ? 12 : 16) {
                header
                stage
                if steps.count > 1 { footer }
            }
            .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: active)
        }
        .onChange(of: active) { _, _ in detailOpen = false }
        .onChange(of: completed) { _, isComplete in
            if isComplete { completedOnce = true }
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                JunoLessonKicker(text: lab.label ?? "Step Lab", tint: .junoAccent)
                Spacer(minLength: 0)
                if steps.count > 1 { rail }
            }
            Text(lab.title)
                .font(JunoSerif.font(size: 21, relativeTo: .title3, face: .medium))
                .fixedSize(horizontal: false, vertical: true)
            if let description = lab.description, !compact {
                Text(description)
                    .junoFont(size: 15, relativeTo: .body)
                    .lineSpacing(6)
                    .foregroundStyle(Color.junoMutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// The numbered rail — the lab's only meta, and its map. Zero-padded so the
    /// numbers hold their width and the rail does not shuffle on step ten.
    private var rail: some View {
        HStack(spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                Button {
                    active = index
                } label: {
                    VStack(spacing: 2) {
                        Text(String(format: "%02d", index + 1))
                            .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                            .monospacedDigit()
                            .foregroundStyle(railTint(index))
                        Capsule(style: .continuous)
                            .fill(Color.junoAccent)
                            .frame(height: 2)
                            .opacity(index == active ? 1 : 0)
                    }
                    .padding(.horizontal, 5)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.junoPress)
                .accessibilityLabel("Step \(index + 1): \(step.title)")
                .accessibilityAddTraits(index == active ? [.isSelected] : [])
            }
        }
    }

    private func railTint(_ index: Int) -> Color {
        if completed || index == active { return .junoAccent }
        return index < active ? .primary : .junoMutedForeground
    }

    // MARK: Stage

    private var stage: some View {
        VStack(alignment: .leading, spacing: compact ? 12 : 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(selected.title)
                    .font(JunoSerif.font(size: 18, relativeTo: .headline, face: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                Text(selected.summary)
                    .junoFont(size: 15, relativeTo: .body)
                    .lineSpacing(6)
                    .foregroundStyle(Color.junoForeground.opacity(0.8))
                    .fixedSize(horizontal: false, vertical: true)
            }

            JunoStepLabVisual(step: selected, compact: compact)
                // Keyed so switching steps rebuilds the visual's own selection
                // state instead of carrying step 1's highlighted cell into step 2.
                .id(selected.id)

            if let notice = selected.notice {
                HStack(alignment: .top, spacing: 8) {
                    JunoLessonMicrocap(text: "Notice", tint: .junoAccent)
                        .padding(.top, 1)
                    Text(notice)
                        .font(JunoSerif.font(size: 14, relativeTo: .subheadline, face: .mediumItalic))
                        .lineSpacing(5)
                        .foregroundStyle(Color.junoForeground.opacity(0.75))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let detail = selected.detail {
                VStack(alignment: .leading, spacing: 2) {
                    JunoLessonToggle(label: "More detail", open: detailOpen) { detailOpen.toggle() }
                    if detailOpen {
                        HStack(alignment: .top, spacing: 0) {
                            Rectangle()
                                .fill(Color.junoHairline)
                                .frame(width: 1)
                                .accessibilityHidden(true)
                            Text(detail)
                                .junoFont(size: 14, relativeTo: .body)
                                .lineSpacing(7)
                                .foregroundStyle(Color.junoForeground.opacity(0.85))
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.leading, 14)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        .transition(.junoInline)
                    }
                }
                .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: detailOpen)
            }

            // The check, shared with the standalone quiz block so the two can
            // never drift apart.
            if let quiz = lab.quiz, onLast {
                VStack(alignment: .leading, spacing: 8) {
                    Rectangle().fill(Color.junoHairline).frame(height: 1)
                    JunoLessonMicrocap(text: "Check", tint: .junoAccent)
                    JunoQuizInteraction(
                        questions: quiz.questions.map {
                            JunoLearningBlocks.QuizQuestion(
                                id: $0.id,
                                question: $0.question,
                                options: $0.options.map { option in
                                    JunoLearningBlocks.QuizOption(
                                        id: option.id,
                                        label: option.label,
                                        correct: option.correct,
                                        explanation: option.explanation
                                    )
                                },
                                explanation: $0.explanation,
                                hint: $0.hint
                            )
                        },
                        onComplete: { _, _ in quizDone = true }
                    )
                }
                .padding(.top, 4)
            }

            if completed, onLast {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: "✓")
                            .junoFont(size: 13, relativeTo: .subheadline, design: .monospaced)
                            .foregroundStyle(Color.junoSuccess)
                        Text("Lab complete")
                            .font(JunoSerif.font(size: 15, relativeTo: .callout, face: .mediumItalic))
                            .foregroundStyle(Color.junoForeground.opacity(0.85))
                    }
                    if let takeaway = lab.takeaway {
                        HStack(alignment: .top, spacing: 0) {
                            Rectangle()
                                .fill(Color.junoAccent.opacity(0.7))
                                .frame(width: 2)
                                .accessibilityHidden(true)
                            Text(takeaway)
                                .font(JunoSerif.font(size: 16, relativeTo: .callout, face: .mediumItalic))
                                .lineSpacing(6)
                                .foregroundStyle(Color.junoForeground.opacity(0.85))
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.leading, 14)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: 10) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)
            HStack(spacing: 12) {
                Button { active = max(0, active - 1) } label: {
                    JunoLessonMicrocap(text: "‹ Previous")
                        .frame(minHeight: JunoLessonMetrics.touchTarget, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.junoPress)
                .disabled(active == 0)
                .opacity(active == 0 ? 0.4 : 1)

                Spacer(minLength: 0)

                // A lab parsed with a complaint still renders; saying it is
                // approximate is the honest alternative to either hiding the
                // problem or refusing to draw the lesson at all.
                if error != nil {
                    JunoLessonMicrocap(text: "approximate")
                }

                Spacer(minLength: 0)

                Button { active = min(steps.count - 1, active + 1) } label: {
                    JunoLessonMicrocap(text: "Next ›", tint: onLast ? .junoMutedForeground : .junoAccent)
                        .frame(minHeight: JunoLessonMetrics.touchTarget, alignment: .trailing)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.junoPress)
                .disabled(onLast)
                .opacity(onLast ? 0.4 : 1)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Step \(active + 1) of \(steps.count) — \(selected.title)")
    }
}

// MARK: - The readout line

/// The figure's single monospaced readout. Interactive visuals report the
/// reader's current selection here; before any interaction it carries the
/// visual's action prompt, in italic, so the line is never empty and the layout
/// below it never shifts when a reading appears.
struct JunoLessonCaption: View {
    let prompt: String
    var reading: String?

    var body: some View {
        Text(reading ?? prompt)
            .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
            .monospacedDigit()
            .italic(reading == nil)
            .foregroundStyle(Color.junoMutedForeground)
            .frame(minHeight: 16, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(reading ?? prompt)
    }
}

// MARK: - Visual dispatcher

struct JunoStepLabVisual: View {
    let step: JunoStepLab.Step
    var compact: Bool = false

    var body: some View {
        switch step.visualType {
        case .tokenization: JunoTokenizationVisual(step: step)
        case .embedding: JunoEmbeddingVisual(step: step)
        case .attention: JunoAttentionVisual(step: step, compact: compact)
        case .transformerProcessing: JunoTransformerVisual(step: step)
        case .probabilityDistribution: JunoProbabilityVisual(step: step)
        case .nextTokenSelection: JunoNextTokenVisual(step: step)
        case .genericProcess: JunoGenericProcessVisual(step: step)
        }
    }
}

// MARK: - Tokenization

/// Tokenisation as typesetting: the same text re-set with visible boundaries.
private struct JunoTokenizationVisual: View {
    let step: JunoStepLab.Step
    @State private var selected: Int?

    var body: some View {
        let data = JunoStepLabData.tokens(step)
        VStack(alignment: .leading, spacing: 10) {
            Text(data.input)
                .junoFont(size: 13, relativeTo: .subheadline)
                .lineSpacing(4)
                .foregroundStyle(Color.junoMutedForeground)
                .fixedSize(horizontal: false, vertical: true)

            JunoChipFlow(spacing: 5, lineSpacing: 6) {
                ForEach(Array(data.tokens.enumerated()), id: \.offset) { index, token in
                    Button {
                        selected = selected == index ? nil : index
                    } label: {
                        // The space glyph is shown, because "a token is not a
                        // word" is exactly what this visual is teaching and the
                        // leading space is usually part of the token.
                        Text(token.text.replacingOccurrences(of: " ", with: "␣"))
                            .junoFont(size: 13, relativeTo: .subheadline, design: .monospaced)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 4)
                            .background(
                                RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                                    .fill(selected == index ? Color.junoAccent.opacity(0.12) : Color.junoMuted)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                                    .strokeBorder(
                                        selected == index ? Color.junoAccent.opacity(0.5) : Color.junoHairline
                                    )
                            )
                            .foregroundStyle(selected == index ? Color.junoAccent : Color.junoForeground)
                    }
                    .buttonStyle(.junoPress)
                    .accessibilityLabel("Token \(index + 1): \(token.text)")
                }
            }

            JunoLessonCaption(prompt: "Select a token", reading: reading(data.tokens))
        }
    }

    private func reading(_ tokens: [JunoStepLabData.Token]) -> String? {
        guard let selected, tokens.indices.contains(selected) else { return nil }
        return "T\(selected + 1) · \u{201C}\(tokens[selected].text)\u{201D} · vocab id \(tokens[selected].id)"
    }
}

// MARK: - Embedding

/// A token's vector as a signed bar per dimension: the point is that meaning is
/// a *shape*, and that two related tokens have similar shapes.
private struct JunoEmbeddingVisual: View {
    let step: JunoStepLab.Step
    @State private var selected = 0

    var body: some View {
        let examples = JunoStepLabData.vectors(step)
        let current = examples.indices.contains(selected) ? examples[selected] : examples[0]
        VStack(alignment: .leading, spacing: 10) {
            JunoChipFlow(spacing: 5, lineSpacing: 6) {
                ForEach(Array(examples.enumerated()), id: \.offset) { index, example in
                    Button { selected = index } label: {
                        Text(example.token)
                            .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .foregroundStyle(index == selected ? Color.junoAccent : Color.junoMutedForeground)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(index == selected ? Color.junoAccent.opacity(0.1) : Color.clear)
                            )
                            .overlay(
                                Capsule(style: .continuous)
                                    .strokeBorder(
                                        index == selected ? Color.junoAccent.opacity(0.4) : Color.junoHairline
                                    )
                            )
                    }
                    .buttonStyle(.junoPress)
                }
            }

            // Signed bars around a shared zero line — a magnitude-only bar would
            // hide the sign, which is half of what a dimension says.
            HStack(alignment: .center, spacing: 6) {
                ForEach(Array(current.vector.enumerated()), id: \.offset) { index, value in
                    VStack(spacing: 3) {
                        ZStack(alignment: .center) {
                            Rectangle()
                                .fill(Color.junoHairline)
                                .frame(height: 1)
                            GeometryReader { proxy in
                                let half = proxy.size.height / 2
                                let magnitude = min(1, abs(value)) * half
                                Rectangle()
                                    .fill(value >= 0 ? Color.junoAccent : Color.junoForeground.opacity(0.35))
                                    .frame(height: max(1, magnitude))
                                    .offset(y: value >= 0 ? half - magnitude : half)
                            }
                        }
                        .frame(height: 44)
                        Text("d\(index)")
                            .junoFont(size: 9, relativeTo: .caption2, design: .monospaced)
                            .foregroundStyle(Color.junoMutedForeground)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .accessibilityHidden(true)

            JunoLessonCaption(
                prompt: "Switch tokens — watch the shape change",
                reading: "\u{201C}\(current.token)\u{201D} · "
                    + current.vector.map { String(format: "%.2f", $0) }.joined(separator: "  ")
            )
        }
    }
}

// MARK: - Attention

/// The attention matrix: one row per query token, one column per key. Cell
/// opacity IS the weight, and the readout names the pair — a heat grid with no
/// way to read an exact number is decoration.
private struct JunoAttentionVisual: View {
    let step: JunoStepLab.Step
    var compact: Bool
    @State private var cell: (row: Int, column: Int)?

    var body: some View {
        let data = JunoStepLabData.attention(step)
        let side: CGFloat = compact ? 22 : 26
        VStack(alignment: .leading, spacing: 10) {
            VStack(spacing: 2) {
                ForEach(Array(data.tokens.enumerated()), id: \.offset) { row, token in
                    HStack(spacing: 2) {
                        Text(token)
                            .junoFont(size: 10, relativeTo: .caption, design: .monospaced)
                            .foregroundStyle(Color.junoMutedForeground)
                            .lineLimit(1)
                            .frame(width: compact ? 46 : 62, alignment: .trailing)
                        ForEach(Array(data.tokens.enumerated()), id: \.offset) { column, _ in
                            let weight = data.matrix.indices.contains(row)
                                && data.matrix[row].indices.contains(column)
                                ? data.matrix[row][column] : 0
                            Button {
                                cell = (cell?.row == row && cell?.column == column) ? nil : (row, column)
                            } label: {
                                RoundedRectangle(cornerRadius: 3, style: .continuous)
                                    .fill(Color.junoAccent.opacity(min(1, max(0.04, weight))))
                                    .frame(width: side, height: side)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                                            .strokeBorder(
                                                cell?.row == row && cell?.column == column
                                                    ? Color.junoAccent : Color.clear,
                                                lineWidth: 1.5
                                            )
                                    )
                            }
                            .buttonStyle(.junoPress)
                            .accessibilityLabel(
                                "\(token) attends to \(data.tokens[column]), \(Int((weight * 100).rounded())) percent"
                            )
                        }
                    }
                }
            }

            JunoLessonCaption(prompt: "Select a query token", reading: reading(data))
        }
    }

    private func reading(_ data: JunoStepLabData.Attention) -> String? {
        guard let cell,
            data.tokens.indices.contains(cell.row),
            data.tokens.indices.contains(cell.column),
            data.matrix.indices.contains(cell.row),
            data.matrix[cell.row].indices.contains(cell.column)
        else { return nil }
        let weight = data.matrix[cell.row][cell.column]
        return "\u{201C}\(data.tokens[cell.row])\u{201D} → \u{201C}\(data.tokens[cell.column])\u{201D} · "
            + String(format: "%.2f", weight)
    }
}

// MARK: - Transformer

/// The transformer block as a vertical flow the reader steps a signal through.
private struct JunoTransformerVisual: View {
    let step: JunoStepLab.Step
    @State private var stage = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Stage {
        let name: String
        let role: String
        let copy: String
    }

    private static let stages = [
        Stage(
            name: "Multi-head attention",
            role: "context exchange",
            copy: "Tokens exchange information in parallel — each one queries the sequence for what matters to it and folds the answers into its own representation."
        ),
        Stage(
            name: "Feed-forward network",
            role: "stored knowledge",
            copy: "Each token's vector passes through deep linear layers where the model's learned facts and associations live, updating the token with what the model knows."
        ),
        Stage(
            name: "Norm + residuals",
            role: "signal stability",
            copy: "Residual connections let the input bypass each block so nothing is lost, and normalization keeps activations in range — this is what makes very deep stacks trainable."
        ),
    ]

    var body: some View {
        let tokens = JunoStepLabData.transformerTokens(step)
        let layers = JunoStepLabData.layers(step)
        VStack(alignment: .leading, spacing: 10) {
            Text(tokens.joined(separator: " · "))
                .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoMutedForeground)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(Self.stages.enumerated()), id: \.offset) { index, item in
                        Button { stage = index } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text(item.name)
                                    .font(JunoSerif.font(size: 14, relativeTo: .subheadline, face: .medium))
                                Spacer(minLength: 0)
                                Text(item.role)
                                    .junoFont(size: 10, relativeTo: .caption, design: .monospaced)
                                    .foregroundStyle(Color.junoMutedForeground)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                                    .fill(stage == index ? Color.junoAccent.opacity(0.08) : .clear)
                            )
                            .overlay(alignment: .leading) {
                                Rectangle()
                                    .fill(stage == index ? Color.junoAccent : Color.clear)
                                    .frame(width: 2)
                            }
                            .overlay(
                                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                                    .strokeBorder(
                                        stage == index ? Color.junoAccent.opacity(0.3) : Color.junoHairline
                                    )
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.junoPress)
                        .accessibilityAddTraits(stage == index ? [.isSelected] : [])
                    }
                }
                // "×12" between two rules: the block the reader is looking at is
                // one of many, and that repetition is the point of the diagram.
                VStack(spacing: 4) {
                    Rectangle().fill(Color.junoHairline).frame(width: 1, height: 22)
                    Text("×\(layers)")
                        .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                        .foregroundStyle(Color.junoMutedForeground)
                    Rectangle().fill(Color.junoHairline).frame(width: 1, height: 22)
                }
                .accessibilityLabel("Repeated \(layers) times")
            }
            .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: stage)

            Text("enriched representations ↓")
                .junoFont(size: 10, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoMutedForeground)
            Text(Self.stages[min(stage, Self.stages.count - 1)].copy)
                .junoFont(size: 14, relativeTo: .body)
                .lineSpacing(5)
                .foregroundStyle(Color.junoMutedForeground)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Probability distribution

/// Probabilities as poll results, plus Sample — the argmax-versus-sampling
/// lesson. Sampling is what makes the same prompt answer differently twice, and
/// pressing the button until a non-top token is drawn is the fastest way to see
/// it.
private struct JunoProbabilityVisual: View {
    let step: JunoStepLab.Step
    @State private var focused: Int?
    @State private var drawn: Int?
    @State private var presses = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let items = JunoStepLabData.candidates(step)
        let peak = max(items.map(\.probability).max() ?? 0.01, 0.01)
        VStack(alignment: .leading, spacing: 8) {
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    row(item, index: index, peak: peak, isLast: index == items.count - 1)
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                JunoLessonCaption(prompt: "Press Sample a few times", reading: reading(items))
                Button {
                    sample(items)
                } label: {
                    JunoLessonMicrocap(text: "Sample", tint: .junoAccent)
                        .frame(minHeight: JunoLessonMetrics.touchTarget, alignment: .trailing)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.junoPress)
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: drawn)
    }

    private func row(
        _ item: JunoStepLabData.Candidate,
        index: Int,
        peak: Double,
        isLast: Bool
    ) -> some View {
        let isTop = index == 0
        let isDrawn = drawn == index
        return Button {
            focused = index
        } label: {
            HStack(alignment: .center, spacing: 12) {
                Text("\(index + 1)")
                    .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 5) {
                    Text("\u{201C}\(item.token)\u{201D}")
                        .junoFont(size: 13, relativeTo: .subheadline, weight: .medium, design: .monospaced)
                        .lineLimit(1)
                    GeometryReader { proxy in
                        Capsule(style: .continuous)
                            .fill(isTop ? Color.junoAccent : Color.junoForeground.opacity(0.2))
                            .frame(width: max(2, proxy.size.width * (item.probability / peak)))
                    }
                    .frame(height: 3)
                }
                Text("\(Int((item.probability * 100).rounded()))%")
                    .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                    .monospacedDigit()
                    .foregroundStyle(isTop || isDrawn ? Color.junoAccent : Color.junoMutedForeground)
                    .frame(width: 44, alignment: .trailing)
            }
            .padding(.vertical, 8)
            .background(alignment: .leading) {
                HStack(spacing: 0) {
                    Rectangle()
                        .fill(isDrawn ? Color.junoAccent.opacity(0.7) : Color.clear)
                        .frame(width: 2)
                    isDrawn ? Color.junoAccent.opacity(0.04) : Color.clear
                }
            }
            .overlay(alignment: .bottom) {
                if !isLast {
                    Rectangle().fill(Color.junoHairline.opacity(0.5)).frame(height: 1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.junoPress)
        .accessibilityLabel(
            "\(item.token), \(Int((item.probability * 100).rounded())) percent" + (isDrawn ? ", sampled" : "")
        )
    }

    private func reading(_ items: [JunoStepLabData.Candidate]) -> String? {
        if let drawn, items.indices.contains(drawn) {
            let item = items[drawn]
            let suffix = drawn == 0 ? "" : " — not the top pick"
            return "sampled \u{201C}\(item.token)\u{201D} · \(Int((item.probability * 100).rounded()))% likely\(suffix)"
        }
        if let focused, items.indices.contains(focused), let note = items[focused].note {
            return note
        }
        return nil
    }

    /// The draw replays identically for a given press count, which is what makes
    /// "press it four times and watch" a repeatable demonstration rather than a
    /// coin flip.
    private func sample(_ items: [JunoStepLabData.Candidate]) {
        presses += 1
        let random = JunoStepLabData.mulberry32(seed: UInt32(truncatingIfNeeded: presses &* 2_654_435_761))
        let total = items.reduce(0) { $0 + $1.probability }
        var cursor = random * total
        var target = 0
        for (index, item) in items.enumerated() {
            cursor -= item.probability
            if cursor <= 0 {
                target = index
                break
            }
        }
        drawn = target
    }
}

// MARK: - Next-token selection

/// The chosen token joining the prompt, and the loop that follows from it.
private struct JunoNextTokenVisual: View {
    let step: JunoStepLab.Step

    var body: some View {
        let data = JunoStepLabData.nextToken(step)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text(data.prompt + " ")
                    .font(JunoSerif.font(size: 16, relativeTo: .callout))
                Text(data.token)
                    .font(JunoSerif.font(size: 16, relativeTo: .callout, face: .medium))
                    .foregroundStyle(Color.junoAccent)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(Color.junoAccent.opacity(0.12))
                    )
            }
            .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 4) {
                JunoLessonMicrocap(text: "Autoregression", tint: .junoAccent)
                Text("\u{201C}\(data.token)\u{201D} joins the prompt; the whole forward pass runs again for the next token.")
                    .junoFont(size: 14, relativeTo: .body)
                    .lineSpacing(5)
                    .foregroundStyle(Color.junoMutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - Generic process

/// Three typographic stations. No box, no arrow graphic on a narrow column —
/// the stations stack behind a single rule, and the order is the causality.
private struct JunoGenericProcessVisual: View {
    let step: JunoStepLab.Step

    var body: some View {
        let stations = JunoStepLabData.stations(step)
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(stations.enumerated()), id: \.offset) { index, station in
                HStack(alignment: .top, spacing: 0) {
                    Rectangle()
                        .fill(index == 1 ? Color.junoAccent.opacity(0.5) : Color.junoHairline)
                        .frame(width: 1)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        JunoLessonMicrocap(
                            text: station.cap,
                            tint: index == 1 ? .junoAccent : .junoMutedForeground
                        )
                        Text(station.value)
                            .font(JunoSerif.font(size: 15, relativeTo: .callout))
                            .lineSpacing(5)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, 14)
                    Spacer(minLength: 0)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
