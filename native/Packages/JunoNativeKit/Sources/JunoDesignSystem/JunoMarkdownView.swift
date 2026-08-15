import SwiftUI

/// Renders assistant/user message Markdown as native SwiftUI.
///
/// Content is flat and borderless: no card, no bubble, no background of its
/// own. Only the blocks that genuinely need a container get one — code, tables
/// and quotes — so a long answer reads as a document rather than a stack of
/// panels. The caller owns the surrounding padding and width clamp.
///
/// The metrics come from the web's `.prose-juno` (`src/app/globals.css`), which is
/// the only place either client states what an answer should read like:
/// `line-height: 1.65` and `> * + * { margin-top: 0.85em }`. Native was running
/// the platform default leading at a 10pt block gap, so answers were tighter
/// between lines and looser between paragraphs than the same reply in the
/// browser — the two clients disagreeing about the same text.
public struct JunoMarkdownText: View {
    /// `line-height: 1.65` on a 16pt body: ~26.4pt of line box, so ~7pt of extra
    /// leading over the glyph height.
    static let lineSpacing: Double = 7
    /// `> * + * { margin-top: 0.85em }` at the body size.
    static let blockSpacing: Double = 13

    private let source: String
    private let blocks: [JunoMarkdownBlock]
    private let streaming: Bool

    /// - Parameter streaming: whether tokens are still arriving, which puts
    ///   AIcss's caret at the end of the last paragraph. See `JunoInlineText` for
    ///   why it is a glyph in the text run rather than a shape beside it.
    public init(_ source: String, streaming: Bool = false) {
        self.source = source
        self.blocks = JunoMarkdown.blocks(from: source)
        self.streaming = streaming
    }

    /// The caret rides the LAST PARAGRAPH, and only a paragraph.
    ///
    /// It has to sit on the text's own baseline, immediately after the final
    /// glyph — a caret on its own row underneath is a rectangle, not a cursor. So
    /// it is appended to the paragraph's text run rather than stacked below it,
    /// which also means it inherits the line's wrapping and moves with the last
    /// word instead of being pinned to a corner.
    ///
    /// When the answer currently ends in a code block, a table or a list, there
    /// is no paragraph to ride and no caret is drawn. That is the right answer
    /// rather than a limitation: the thing being written is a structure, and a
    /// text cursor hanging off the bottom of a table says nothing true about it.
    private var caretIndex: Int? {
        guard streaming else { return nil }
        guard case .paragraph = blocks.last else { return nil }
        return blocks.count - 1
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Self.blockSpacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                JunoMarkdownBlockView(block: block, caret: index == caretIndex)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The rendered blocks are decorative structure around text the reader
        // already hears; VoiceOver reads the source once instead of announcing
        // every container.
        .accessibilityElement(children: .contain)
    }
}

private struct JunoMarkdownBlockView: View {
    let block: JunoMarkdownBlock
    /// Append the streaming caret to this block. Only ever true for the last
    /// paragraph — see `JunoMarkdownText.caretIndex`.
    var caret: Bool = false

    var body: some View {
        switch block {
        case .paragraph(let text):
            JunoInlineText(text, caret: caret)
                .lineSpacing(JunoMarkdownText.lineSpacing)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .heading(let level, let text):
            // `margin-top: 1.3em` on every level, not just the first two: a run of
            // `###` sub-headings needs the same air above it as an `##` does, and
            // without it a sub-heading crowded the paragraph it was breaking away
            // from. The gap is stated net of the stack's own block spacing.
            JunoInlineText(text)
                .font(headingFont(level))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 8)
                .accessibilityAddTraits(.isHeader)

        case .code(let language, let source, let isClosed):
            // The rich handlers only take over once the fence has CLOSED, and
            // that gate is the whole reason streaming answers do not flicker. A
            // half-written Mermaid graph is a syntax error on every keystroke,
            // so a diagram that rendered eagerly would spend the entire stream
            // flipping between an error state and a partial picture; a half-read
            // CSV would chart a real-looking bar chart of the first two rows and
            // then redraw it four times. While the fence is open the block is
            // what it demonstrably is — source — and it becomes a diagram or a
            // chart in one step when the author has finished writing it.
            if isClosed, JunoMermaidMarkup.isMermaidFence(info: language) {
                MermaidDiagramView(source: source)
            } else if isClosed,
                let chart = JunoChartMarkup.data(fenceInfo: language, source: source)
            {
                InlineChartRenderer(chart)
            } else {
                JunoCodeBlock(language: language, source: source)
            }

        case .math(let latex, _):
            JunoDisplayMath(latex: latex)

        case .list(let ordered, let start, let items):
            JunoMarkdownList(ordered: ordered, start: start, items: items)

        case .table(let header, let rows):
            JunoMarkdownTable(header: header, rows: rows)

        case .quote(let text):
            // The rule is `--border`, not coral. A quote is not an active or
            // selected thing, and the accent is reserved for what is — a coral
            // bar down every blockquote made the model quoting itself the
            // brightest mark on the screen.
            HStack(alignment: .top, spacing: JunoSpace.regular) {
                Capsule(style: .continuous)
                    .fill(Color.junoHairline)
                    .frame(width: 3)
                    .accessibilityHidden(true)
                JunoInlineText(text)
                    .lineSpacing(JunoMarkdownText.lineSpacing)
                    .foregroundStyle(Color.junoMutedForeground)
                    .textSelection(.enabled)
            }
            .fixedSize(horizontal: false, vertical: true)

        case .thematicBreak:
            Divider().padding(.vertical, JunoSpace.tight)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2.weight(.semibold)
        case 2: .title3.weight(.semibold)
        case 3: .headline
        default: .subheadline.weight(.semibold)
        }
    }
}

/// Inline Markdown (bold, italic, `code`, links) and inline maths, with a
/// plain-text fallback.
///
/// Every inline site in the renderer funnels through here — paragraphs, headings,
/// list items, table cells, quotes — which is why maths belongs *in* it rather
/// than beside it. A formula in a table cell and a formula in a sentence are the
/// same thing to the reader, and the alternative to one shared entry point is
/// five call sites that each decide separately whether `$…$` counts.
///
/// See ``AttributedString/junoInline(_:)`` for the two decisions that matter:
/// why maths is extracted before Markdown parsing, and why its runs carry a
/// presentation *intent* instead of a font.
struct JunoInlineText: View {
    private let attributed: AttributedString
    private let caret: Bool

    init(_ source: String, caret: Bool = false) {
        attributed = .junoInline(source)
        self.caret = caret
    }

    /// AIcss's caret as a glyph rather than a `Rectangle`, because it has to be
    /// part of the text run: only then does it sit on the baseline, follow the
    /// last word as the line rewraps, and scale with Dynamic Type. A shape in an
    /// `HStack` beside the paragraph would pin itself to the block's trailing
    /// edge and drift away from the words on every wrap.
    ///
    /// Solid, never blinking — which is AIcss's rule and is only visible here in
    /// the state that rule is about: text is arriving, so a second moving thing
    /// would compete with the text itself for the reader's eye.
    var body: some View {
        Group {
            if caret {
                Text(attributed) + Text(verbatim: "\u{2588}").foregroundColor(.primary)
            } else {
                Text(attributed)
            }
        }
        .tint(Color.junoAccent)
    }
}

/// A fenced code block, in AIcss's numbered-gutter shell.
///
/// What that replaced: a quiet header with the language and a copy glyph over one
/// `Text` of the whole source. The header and the one action survive; the gutter is
/// new, and it is the reason for the change — a model that says "line 14" is now
/// pointing at something the reader can find without counting.
///
/// Wrapping stays off for the reason the previous block gave and which still
/// holds: soft-wrapping code doubles a long line's height and destroys the
/// indentation the reader is using to parse it.
struct JunoCodeBlock: View {
    let language: String?
    let source: String

    var body: some View {
        JunoAIcssCodeBlock(
            label: language?.isEmpty == false ? language! : "code",
            source: source
        )
    }
}

private struct JunoMarkdownList: View {
    let ordered: Bool
    let start: Int
    let items: [JunoMarkdownBlock.Item]

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                    marker(index: index, item: item)
                        .frame(minWidth: 18, alignment: .trailing)
                        .accessibilityHidden(item.isChecked == nil)
                    JunoInlineText(item.text)
                        .lineSpacing(JunoMarkdownText.lineSpacing)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, Double(item.depth) * JunoSpace.regular)
            }
        }
    }

    @ViewBuilder
    private func marker(index: Int, item: JunoMarkdownBlock.Item) -> some View {
        if let isChecked = item.isChecked {
            Image(systemName: isChecked ? "checkmark.square.fill" : "square")
                .font(.callout)
                .foregroundStyle(isChecked ? Color.junoAccent : Color.junoMutedForeground)
                .accessibilityLabel(isChecked ? "Done" : "Not done")
        } else if ordered {
            Text("\(start + index).")
                .font(.body.monospacedDigit())
                .junoSecondaryInk()
        } else {
            // Nesting changes the glyph the way a printed document would, so
            // depth stays legible even when the indent is subtle.
            Text(item.depth == 0 ? "•" : (item.depth == 1 ? "◦" : "▪"))
                .font(.body)
                .junoSecondaryInk()
        }
    }
}

/// A pipe table. Scrolls horizontally rather than compressing columns, because
/// a squeezed numeric column is worse than an off-screen one.
private struct JunoMarkdownTable: View {
    let header: [String]
    let rows: [[String]]

    private var columnCount: Int {
        max(header.count, rows.map(\.count).max() ?? 0)
    }

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: JunoSpace.regular, verticalSpacing: 0) {
                GridRow {
                    ForEach(0..<columnCount, id: \.self) { column in
                        Text(cell(header, column))
                            .font(.callout.weight(.semibold))
                            .textSelection(.enabled)
                    }
                }
                .padding(.vertical, JunoSpace.tight)

                Divider().gridCellUnsizedAxes(.horizontal)

                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(0..<columnCount, id: \.self) { column in
                            JunoInlineText(cell(row, column))
                                .font(.callout)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(.vertical, JunoSpace.tight)
                    if index < rows.count - 1 {
                        Divider().gridCellUnsizedAxes(.horizontal)
                    }
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(Color.junoCanvas)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .strokeBorder(Color.junoHairline)
        )
    }

    /// Rows shorter than the header are common in hand-written tables; render
    /// the gap rather than dropping the row.
    private func cell(_ row: [String], _ column: Int) -> String {
        column < row.count ? row[column] : ""
    }
}

/// One place that knows how each platform copies text, so views don't carry
/// `#if canImport(AppKit)` around every copy button.
public enum JunoPasteboard {
    public static func copy(_ string: String) {
        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        #elseif canImport(UIKit)
        UIPasteboard.general.string = string
        #endif
    }
}

#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif
