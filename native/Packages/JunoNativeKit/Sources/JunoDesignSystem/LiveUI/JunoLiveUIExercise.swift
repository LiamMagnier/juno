import SwiftUI

// MARK: Exercise

/// A practice card, as the web draws it (`LiveExercise`,
/// src/components/chat/live-ui/live-ui-learning.tsx): the exercise, a box to
/// answer in — a monospace editor when the exercise names a language — hints
/// one at a time, Run for a language this app runs, and Send answer, which
/// posts the answer as the reader's next message so the model corrects it in
/// the conversation. The card never holds the solution.
struct LiveExerciseView: View {
    let exercise: LiveExerciseSpec
    let context: LiveUIContext

    @Environment(\.junoCodeRunner) private var runner
    @Environment(\.colorSchemeContrast) private var contrast
    #if DEBUG
    @Environment(\.junoLiveUIExerciseSeeds) private var seeds
    #endif

    @State private var answer = ""
    @State private var shown = 0
    @State private var sent = false
    @State private var runToken = 0
    @State private var outputOpen = false
    @State private var seeded = false
    @FocusState private var focused: Bool

    private func interp(_ s: String) -> String { liveInterpolate(s, scope: context.scope) }
    private var isCode: Bool { exercise.language != nil }
    private var title: String { interp(exercise.title) }
    /// Run, when this app runs the exercise's language.
    private var runTarget: JunoCodeRunTarget? { runner == nil ? nil : JunoCodeRunTarget.target(for: exercise.language) }
    private var trimmed: String { answer.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { context.onSend != nil && !trimmed.isEmpty && !sent }

    /// What Send posts: the web's `**{title}**\n\n{answer}`, the answer fenced
    /// in its language when it is code.
    static func message(title: String, language: String?, answer: String) -> String {
        let body = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        let fenced = language.map { "```\($0)\n\(body)\n```" } ?? body
        return "**\(title)**\n\n\(fenced)"
    }

    private func send() {
        guard canSend else { return }
        context.onSend?(Self.message(title: title, language: exercise.language, answer: answer))
        focused = false
        withAnimation(JunoMotion.fast) { sent = true }
    }

    private func run() {
        guard !trimmed.isEmpty else { return }
        outputOpen = true
        runToken += 1
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                Text(title)
                    .font(.system(.body, weight: .medium))
                    .junoInk()
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if let tag = exercise.tag {
                    Text(interp(tag))
                        .font(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
            Text(Self.statement(interp(exercise.prompt)))
                .font(.body)
                .foregroundStyle(Color.junoForeground.opacity(0.9))
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            answerSurface
            if shown > 0 { hints }
            actions
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field + 4, style: .continuous)
                .strokeBorder(
                    Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: contrast == .increased)),
                    lineWidth: 1
                )
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
        .onAppear(perform: seed)
    }

    // MARK: The answer and its output, one surface

    private var answerSurface: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topLeading) {
                if answer.isEmpty {
                    Text(exercise.placeholder ?? (isCode ? "-- Your query" : "Your answer"))
                        .font(editorFont)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                TextEditor(text: $answer)
                    .font(editorFont)
                    .foregroundStyle(sent ? Color.junoSecondaryInk : Color.junoForeground)
                    .scrollContentBackground(.hidden)
                    .autocorrectionDisabled(isCode)
                    #if os(iOS)
                    .textInputAutocapitalization(isCode ? .never : .sentences)
                    #endif
                    .disabled(sent)
                    .focused($focused)
                    .padding(.horizontal, editorInset.width)
                    .padding(.vertical, editorInset.height)
                    .frame(minHeight: isCode ? 112 : 84, alignment: .topLeading)
                    .accessibilityLabel("Your answer to \(title)")
                    .onKeyPress(.return, phases: .down) { press in
                        guard press.modifiers.contains(.command) else { return .ignored }
                        send()
                        return .handled
                    }
            }
            if outputOpen, let runTarget {
                JunoCodeRunOutput(target: runTarget, code: answer, runToken: runToken) {
                    outputOpen = false
                }
            }
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoSecondary)
        )
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
    }

    private var editorFont: Font {
        isCode ? .system(.callout, design: .monospaced) : .callout
    }

    /// TextEditor sets its text a few points in from its frame; the placeholder
    /// is drawn where the text will start.
    private var editorInset: CGSize {
        #if os(macOS)
        CGSize(width: 11, height: 12)
        #else
        CGSize(width: 11, height: 4)
        #endif
    }

    // MARK: Hints

    private var hints: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(exercise.hints.prefix(shown).enumerated()), id: \.offset) { i, hint in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    JunoIconView(.info, size: 13)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .accessibilityHidden(true)
                    (exercise.hints.count > 1
                        ? Text("Hint \(i + 1). ").foregroundColor(Color.junoForeground.opacity(0.8))
                        : Text(""))
                        + Text(interp(hint)).foregroundColor(Color.junoSecondaryInk)
                }
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    // MARK: Actions

    private var actions: some View {
        HStack(spacing: 8) {
            if shown < exercise.hints.count && !sent {
                Button {
                    withAnimation(JunoMotion.fast) { shown += 1 }
                } label: {
                    HStack(spacing: 6) {
                        JunoIconView(.eye, size: 13)
                        Text(shown == 0 ? "Show a hint" : "Another hint")
                    }
                    .font(.callout)
                    .contentShape(Capsule())
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.junoSecondaryInk)
            }
            Spacer(minLength: 0)
            if sent {
                HStack(spacing: 6) {
                    JunoIconView(.check, size: 13)
                    Text("Sent for correction")
                }
                .font(.callout)
                .foregroundStyle(Color.junoSecondaryInk)
                .transition(.opacity)
                .accessibilityElement(children: .combine)
            } else {
                if runTarget != nil {
                    JunoCodeRunButton(action: run)
                        .disabled(trimmed.isEmpty)
                        .help("Run your answer here")
                }
                Button(action: send) {
                    Text("Send answer")
                        .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
                        .contentShape(Capsule())
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(Color.junoForeground)
                .disabled(!canSend)
                .help(context.onSend == nil ? "Available in a conversation" : "Send your answer for correction (⌘↩)")
            }
        }
    }

    // MARK: The statement

    /// `**bold**` and `` `code` `` in a statement, as the web's `Statement` reads them.
    static func statement(_ text: String) -> AttributedString {
        var out = AttributedString()
        var rest = Substring(text)
        while !rest.isEmpty {
            let bold = rest.range(of: "**")
            let tick = rest.range(of: "`")
            let next = [bold, tick].compactMap { $0 }.min { $0.lowerBound < $1.lowerBound }
            guard let next else {
                out += AttributedString(String(rest))
                break
            }
            let isBold = next == bold
            let marker = isBold ? "**" : "`"
            let inner = rest[next.upperBound...]
            guard let close = inner.range(of: marker), close.lowerBound > inner.startIndex,
                !inner[..<close.lowerBound].contains(isBold ? "*" : "`")
            else {
                out += AttributedString(String(rest[..<next.upperBound]))
                rest = rest[next.upperBound...]
                continue
            }
            out += AttributedString(String(rest[..<next.lowerBound]))
            var piece = AttributedString(String(inner[..<close.lowerBound]))
            if isBold {
                piece.inlinePresentationIntent = .stronglyEmphasized
                piece.foregroundColor = Color.junoForeground
            } else {
                piece.font = .system(.callout, design: .monospaced)
                piece.backgroundColor = Color.junoForeground.opacity(0.06)
            }
            out += piece
            rest = inner[close.upperBound...]
        }
        return out
    }

    private func seed() {
        #if DEBUG
        guard !seeded, let seed = seeds[exercise.id] else { return }
        seeded = true
        answer = seed.answer
        shown = min(seed.hintsShown, exercise.hints.count)
        sent = seed.sent
        if seed.runOpen {
            outputOpen = true
            runToken = 1
        }
        #endif
    }
}

#if DEBUG
/// A card's state, set for a snapshot: the answer typed, hints shown, sent,
/// and whether Run has opened the output.
public struct LiveExerciseSeed: Sendable {
    public var answer: String
    public var hintsShown: Int
    public var sent: Bool
    public var runOpen: Bool

    public init(answer: String = "", hintsShown: Int = 0, sent: Bool = false, runOpen: Bool = false) {
        self.answer = answer
        self.hintsShown = hintsShown
        self.sent = sent
        self.runOpen = runOpen
    }
}

public extension EnvironmentValues {
    /// Exercise states by exercise id, for the snapshot and preview harnesses.
    @Entry var junoLiveUIExerciseSeeds: [String: LiveExerciseSeed] = [:]
}
#endif
