import SwiftUI

/// A `$$ … $$` block, centred and given air.
///
/// **Set in a serif.** Maths has been set in a serif since Computer Modern, and
/// the convention is not decoration: SF Pro's italic is a slanted grotesque
/// whose `x` and `n` look like ordinary lowercase letters, so a variable set in
/// it reads as a word. `JunoSerif` (Newsreader) is reserved for editorial
/// moments and is not a maths face either, which is why this uses the system
/// serif rather than the brand one — the reader should register "this is a
/// formula", not "this is a pull quote".
///
/// **Slightly larger than body.** Display maths is the one thing in an answer
/// that is genuinely harder to read at body size, because subscripts and
/// superscripts are already a size down from whatever surrounds them.
struct JunoDisplayMath: View {
    let latex: String

    @State private var showsSource = false

    private var rendering: JunoMathRendering {
        JunoMathMarkup.render(latex: latex)
    }

    var body: some View {
        let rendering = rendering
        VStack(alignment: .center, spacing: JunoSpace.snug) {
            Text(rendering.text)
                .font(.system(.title3, design: .serif))
                .junoInk()
                .lineSpacing(JunoMarkdownText.lineSpacing)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .center)

            // The escape hatch, and it only appears when it is earned. A "show
            // source" control under every formula would train the reader to
            // ignore it; under the formulas that did NOT fully convert, it is
            // the difference between a partial reading and the actual maths.
            if !rendering.isFaithful {
                unconvertedNotice(rendering)
            }
        }
        .padding(.vertical, JunoSpace.tight)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Formula")
        .accessibilityValue(rendering.text)
    }

    @ViewBuilder
    private func unconvertedNotice(_ rendering: JunoMathRendering) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Button {
                withAnimation(JunoMotion.fast) { showsSource.toggle() }
            } label: {
                Label(
                    showsSource ? "Hide LaTeX" : "Show LaTeX",
                    icon: showsSource ? .chevronDown : .chevronRight
                )
                .junoCaption()
            }
            .buttonStyle(.plain)
            .accessibilityHint("This formula did not convert completely to text.")

            if showsSource {
                Text(latex)
                    .junoCode()
                    .junoSecondaryInk()
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(
                    "Not converted: "
                        + Set(rendering.unconverted).sorted().joined(separator: ", ")
                )
                .junoCaption()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Inline maths

extension AttributedString {
    /// Inline Markdown *and* inline maths, in one attributed run.
    ///
    /// Order matters and only one order works: maths comes out **first**, before
    /// `AttributedString(markdown:)` sees the string. `$P(A|B) = \frac{x_1}{y^2}$`
    /// is full of characters Markdown claims — `_` and `*` are emphasis, `|` is a
    /// table pipe — so a formula parsed as Markdown loses its subscripts to
    /// italics. Extracting first means the parser never sees them.
    ///
    /// The cost, stated plainly: emphasis cannot *wrap* a formula. `**$x$ is
    /// bold**` splits into three runs and the `**` no longer pairs, so it renders
    /// literally. Emphasis *beside* a formula — `**Force**: $F = ma$`, which is
    /// the shape that actually occurs — is unaffected, because the split falls
    /// outside the emphasis rather than through it.
    ///
    /// Maths runs are marked ``InlinePresentationIntent/emphasized`` rather than
    /// given a font. That is the load-bearing choice in this method: a font
    /// attribute is *absolute*, so pinning `.body` here would shrink a formula
    /// inside an `H2` to body size and blow one inside a table cell up to it.
    /// The intent is *relative* — SwiftUI italicises whatever face is inherited —
    /// so a formula stays the size of the text it sits in.
    static func junoInline(_ source: String) -> AttributedString {
        let segments = JunoMathMarkup.segments(in: source)
        let carriesMath = segments.contains { segment in
            if case .math = segment { return true }
            return false
        }
        guard carriesMath else { return junoMarkdown(source) }

        var result = AttributedString()
        for segment in segments {
            switch segment {
            case .text(let text):
                result += junoMarkdown(text)
            case .math(let latex, _):
                var run = AttributedString(JunoMathMarkup.render(latex: latex).text)
                run.inlinePresentationIntent = .emphasized
                result += run
            }
        }
        return result
    }

    /// Inline Markdown with a plain-text fallback.
    ///
    /// `AttributedString(markdown:)` throws on malformed input — routine while a
    /// message is still streaming and a `[link](` is half-written — so the raw
    /// string is shown rather than an error or an empty row.
    static func junoMarkdown(_ source: String) -> AttributedString {
        guard !source.isEmpty else { return AttributedString() }
        if let parsed = try? AttributedString(
            markdown: source,
            options: .init(
                allowsExtendedAttributes: true,
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ) {
            return parsed
        }
        return AttributedString(source)
    }
}
