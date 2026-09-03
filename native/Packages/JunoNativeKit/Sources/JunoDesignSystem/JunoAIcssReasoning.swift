import SwiftUI

/// REASONING → the lines the AIcss viewport shows.
///
/// A DISPLAY chunker, and the distinction is load-bearing: it decides where to
/// WRAP a trace into 40pt slots. It does not decide, claim or imply where the
/// model's steps were. The website's `src/lib/reasoning-lines.ts` is the same
/// function and carries the same rule, because `reasoning-parts.ts` is explicit
/// that a step boundary is a fact from the wire and must never be re-derived
/// from prose.
///
///   - Provider parts present → one line per part, in the order the API declared.
///     Real boundaries, used as boundaries.
///   - No parts → wrap on the model's OWN blank lines, and only then, if a
///     paragraph is too long to read two lines at a time, at sentence ends inside
///     it. Those are lines, not steps: nothing numbers them or counts them.
public enum JunoAIcssReasoningLines {
    /// Longer than this and a paragraph is broken at sentence ends for display.
    private static let wrapAt = 170

    /// Matches a whole first line that is bold and nothing else — OpenAI's
    /// summary-part title format. Same shape as the web's `TITLE_LINE`.
    private static func title(of part: String) -> String? {
        let first = part.split(separator: "\n", maxSplits: 1).first.map(String.init)?
            .trimmingCharacters(in: .whitespaces) ?? ""
        guard first.hasPrefix("**"), first.hasSuffix("**"), first.count > 4 else { return nil }
        let inner = String(first.dropFirst(2).dropLast(2))
        guard !inner.contains("*"), !inner.isEmpty else { return nil }
        return inner.trimmingCharacters(in: .whitespaces)
    }

    private static func wrap(_ paragraph: String) -> [String] {
        guard paragraph.count > wrapAt else { return [paragraph] }
        var out: [String] = []
        var current = ""
        for clause in sentences(of: paragraph) {
            // Start a new line once this clause would take the current one past
            // the budget — unless the line is empty, in which case the clause is
            // itself oversized and gets a line of its own rather than being cut.
            if !current.isEmpty, current.count + clause.count + 1 > wrapAt {
                out.append(current)
                current = clause
            } else {
                current = current.isEmpty ? clause : "\(current) \(clause)"
            }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    /// Split after a sentence terminator followed by whitespace, keeping the
    /// terminator with its clause.
    private static func sentences(of paragraph: String) -> [String] {
        var out: [String] = []
        var current = ""
        var previousWasTerminator = false
        for character in paragraph {
            if previousWasTerminator, character.isWhitespace {
                if !current.isEmpty { out.append(current) }
                current = ""
                previousWasTerminator = false
                continue
            }
            previousWasTerminator = character == "." || character == "!" || character == "?" || character == "…"
            current.append(character)
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    /// - Parameters:
    ///   - text: the flat reasoning trace, as persisted on the message.
    ///   - parts: the provider's own summary parts, or empty when it sent none.
    public static func lines(text: String?, parts: [String] = []) -> [String] {
        let usable = parts.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if !usable.isEmpty {
            // A title-only part is real and common, and its title IS the line. A
            // part with no title falls back to its opening line verbatim — the
            // model's own words either way.
            return usable.compactMap { part in
                let line = title(of: part)
                    ?? part.split(separator: "\n").first.map(String.init)
                    ?? part
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
        }

        let trace = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trace.isEmpty else { return [] }
        return trace
            .components(separatedBy: "\n\n")
            .map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
            .filter { !$0.isEmpty }
            .flatMap(wrap)
    }
}

/// AIcss "Thinking + Reasoning" — the live trace.
///
/// WHY A TRANSCRIPT CAN CARRY THIS AT ALL. Both clients used to refuse to preview
/// streaming reasoning, and the reason was sound: provider summaries arrive as
/// half-finished sentences, stray code and media queries, and a raw growing block
/// of that above the answer reflowed the transcript on every delta and made the
/// reply look broken. The refusal was about the CONTAINER. This is the container
/// that answers it — a fixed 40pt slot per line, clamped to two lines, capping at
/// 180pt and then scrolling behind a soft fade. Nothing under the reader moves,
/// nothing unbounded arrives, and a half-finished sentence is the last of six
/// quiet grey lines rather than a wall.
///
/// AIcss ships this as a self-running demo: six hardcoded sentences on a timer,
/// with an elapsed time computed from the sum of the delays. That is a film of a
/// component. This takes the geometry, the easing and the masking, and shows the
/// lines that actually arrived.
public struct JunoAIcssReasoningStream: View {
    /// Geometry, from the web's `.aicss-tr-*`.
    private static let slot: Double = 40 // two lines × 20pt
    private static let gap: Double = 4
    private static let maximum: Double = 180
    private static let fade: Double = 16

    private let lines: [String]
    private let streaming: Bool
    /// Preformatted by the caller, so this is never a second opinion on how long
    /// the run took. See `JunoMobileRunCopy.span`.
    private let duration: String?
    private let label: String
    private let showsHeader: Bool

    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        lines: [String],
        streaming: Bool,
        duration: String? = nil,
        label: String = "Thinking…",
        showsHeader: Bool = true
    ) {
        self.lines = lines
        self.streaming = streaming
        self.duration = duration
        self.label = label
        self.showsHeader = showsHeader
    }

    private var contentHeight: Double {
        lines.isEmpty ? 0 : Double(lines.count) * Self.slot + Double(lines.count - 1) * Self.gap
    }

    private var capped: Bool { contentHeight > Self.maximum }
    private var viewportHeight: Double { capped ? Self.maximum : contentHeight }
    /// Headless has no control to fold it with, so it is never folded.
    private var expanded: Bool { showsHeader ? (streaming || open) : true }
    /// Scrolling belongs to the reader, so it is armed only once nothing is
    /// arriving. While streaming the stack is offset instead, which pins the
    /// newest line without fighting a scroll position.
    private var scrollable: Bool { !streaming && expanded }
    private var offset: Double {
        scrollable ? 0 : (capped ? Self.maximum - Self.fade - contentHeight : 0)
    }

    public var body: some View {
        // No lines is no block. A header alone would claim a trace that never
        // arrived, and headless it would be an empty viewport holding a gap open.
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                if showsHeader { header }
                if expanded { viewport.padding(.top, 6) }
            }
            .animation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion), value: expanded)
            .animation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion), value: lines.count)
        }
    }

    @ViewBuilder
    private var header: some View {
        if streaming {
            JunoAIcssThinkingLabel(label)
                .frame(minHeight: 20)
        } else {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: 6) {
                    // The caller owns the semantic label. The default keeps the
                    // compact Chat wording, while Code can call this provenance
                    // "Reasoning" without the interface pretending the trace is
                    // a mysterious thought bubble.
                    Text(label == "Thinking…" ? "Thought" : label)
                        .foregroundStyle(Color.junoMutedForeground)
                        + Text(duration.map { " for \($0)" } ?? "")
                        .foregroundStyle(Color.junoMutedForeground)
                    JunoIconView(.chevronUp)
                        .junoFont(size: 9, relativeTo: .caption2, weight: .semibold)
                        .foregroundStyle(Color.junoMutedForeground)
                        .rotationEffect(.degrees(open ? 0 : 180))
                }
                .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                .frame(minHeight: 20)
            }
            .buttonStyle(.junoPress)
            .accessibilityLabel("Toggle \(label == "Thinking…" ? "thought" : label.lowercased())")
        }
    }

    private var viewport: some View {
        stream
            .frame(height: viewportHeight, alignment: .top)
            .clipped()
            // The fade exists only once the viewport is capped: an uncapped
            // stream has nothing hidden above or below it to dissolve into.
            .mask(capped ? AnyView(fadeMask) : AnyView(Rectangle()))
    }

    @ViewBuilder
    private var stream: some View {
        let rows = VStack(alignment: .leading, spacing: Self.gap) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .junoFont(size: 13, relativeTo: .subheadline, weight: .regular)
                    .lineSpacing(3)
                    .foregroundStyle(Color.junoMutedForeground)
                    // Two lines in a fixed box: the clamp is what makes the slot
                    // a constant, and the constant is what stops the transcript
                    // reflowing while a sentence is still being written.
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .frame(height: Self.slot, alignment: .topLeading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .offset(y: offset)

        if scrollable {
            ScrollView(.vertical) { rows }
                .scrollIndicators(.hidden)
        } else {
            rows
        }
    }

    private var fadeMask: some View {
        LinearGradient(
            stops: [
                .init(color: .clear, location: 0),
                .init(color: .black, location: Self.fade / viewportHeight),
                .init(color: .black, location: 1 - Self.fade / viewportHeight),
                .init(color: .clear, location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

#if DEBUG
#Preview("AIcss reasoning") {
    let lines = [
        "Reading the request and the current selection, then locating the jwt.verify call inside the auth middleware.",
        "The verify call sets no algorithms allowlist, so a token signed with 'none' or a weak cipher could be accepted.",
        "Tracing where the signing secret is loaded from and confirming it is never logged or sent back to the client.",
        "Planning to pin the algorithm to HS256 and to validate the issuer and audience claims on every request.",
        "Scanning the existing tests around the middleware so the fix stays covered and nothing downstream regresses.",
        "Drafting the patch with a focused regression test that rejects tampered, expired, and unsigned tokens.",
    ]
    return ScrollView {
        VStack(alignment: .leading, spacing: 28) {
            JunoAIcssReasoningStream(lines: lines, streaming: true, showsHeader: false)
            JunoAIcssReasoningStream(lines: lines, streaming: false, duration: "5.0s")
            JunoAIcssReasoningStream(lines: Array(lines.prefix(2)), streaming: true)
        }
        .padding(20)
        .frame(maxWidth: 360, alignment: .leading)
    }
    .background(Color.junoCanvas)
}
#endif
