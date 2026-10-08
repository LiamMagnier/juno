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

    @Environment(\.junoProseStyle) private var style
    @Environment(\.junoTextScale) private var textScale
    @Environment(\.junoFindHighlight) private var find
    @Environment(\.junoCitationCount) private var citations

    public var body: some View {
        switch style {
        case .standard:
            VStack(alignment: .leading, spacing: Self.blockSpacing) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                    JunoMarkdownBlockView(block: block, caret: index == caretIndex)
                        .junoStreamRevealScope(isLast: index == blocks.count - 1)
                        .junoStreamBlockReveal()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // The rendered blocks are decorative structure around text the reader
            // already hears; VoiceOver reads the source once instead of announcing
            // every container.
            .accessibilityElement(children: .contain)
        case .reading:
            readingBody
        }
    }

    /// `.prose-juno`: the reading rung, the 0.85em rhythm, and no caret — the
    /// transcript fades the tail of a reply being written instead
    /// (``SwiftUI/View/junoStreamingTail(_:)``).
    private var readingBody: some View {
        let bases = findBases
        return VStack(alignment: .leading, spacing: JunoProseMetrics.blockGap * textScale) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                JunoReadingBlockView(block: block, isFirst: index == 0)
                    .environment(\.junoFindHighlight, find?.shifted(by: bases[safe: index] ?? 0))
                    .junoStreamRevealScope(isLast: index == blocks.count - 1)
                    .junoStreamBlockReveal()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    /// Where each block's matches start within this run.
    private var findBases: [Int] {
        guard let find, find.isActive else { return [] }
        var running = 0
        return blocks.map { block in
            defer { running += JunoFindText.count(of: find.query, inBlock: block, citations: citations) }
            return running
        }
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
            if JunoLiveUIMarkup.isLiveFence(info: language) {
                // Live UI (docs/design/LIVE_UI.md): drawn progressively from
                // whatever of its JSON has arrived, so — unlike the handlers
                // below — it does not wait for the fence to close.
                JunoLiveUIView(source: source, streaming: !isClosed)
            } else if JunoVisualMarkup.isVisualFence(info: language) {
                // Legacy, history only: an old juno-visual fence drawn as the
                // Live UI view it converts to (JunoLiveUILegacy).
                JunoLiveUIView(source: JunoLiveUILegacy.visualSource(source, streaming: !isClosed), streaming: !isClosed)
            } else if isClosed, JunoMermaidMarkup.isMermaidFence(info: language) {
                MermaidDiagramView(source: source)
            } else if JunoMermaidMarkup.isMermaidFence(info: language) {
                // The web's streaming Mermaid fence: its source, saying what
                // it will become.
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    JunoCodeBlock(language: language, source: source)
                    Text("Diagram renders when complete…")
                        .junoFont(size: 12, relativeTo: .caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.horizontal, JunoSpace.hairline)
                }
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

/// One block in the reading style (``JunoProseStyle/reading``).
private struct JunoReadingBlockView: View {
    let block: JunoMarkdownBlock
    /// The first block takes no heading lead: the web's rhythm is `* + *`.
    let isFirst: Bool

    @Environment(\.junoTextScale) private var textScale
    @Environment(\.junoFindHighlight) private var find
    @Environment(\.junoCitationCount) private var citations
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        switch block {
        case .paragraph(let text):
            JunoInlineText(text)
                .junoType(.reading)
                .junoInk()
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: JunoProseMetrics.measure(scale: textScale), alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .heading(let level, let text):
            JunoInlineText(text, baseSize: JunoProseMetrics.headingSize(level: level))
                .junoType(JunoProseMetrics.headingType(level: level))
                .junoInk()
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: JunoProseMetrics.measure(scale: textScale), alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, isFirst ? 0 : JunoProseMetrics.headingExtraLead(level: level) * textScale)
                .accessibilityAddTraits(.isHeader)

        case .code(let language, let source, let isClosed):
            if JunoLiveUIMarkup.isLiveFence(info: language) {
                JunoLiveUIView(source: source, streaming: !isClosed)
            } else if JunoVisualMarkup.isVisualFence(info: language) {
                JunoLiveUIView(source: JunoLiveUILegacy.visualSource(source, streaming: !isClosed), streaming: !isClosed)
            } else if isClosed, JunoMermaidMarkup.isMermaidFence(info: language) {
                MermaidDiagramView(source: source)
            } else if JunoMermaidMarkup.isMermaidFence(info: language) {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    JunoProseCodeBlock(language: language, source: source)
                    Text("Diagram renders when complete…")
                        .junoFont(size: 12, relativeTo: .caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.horizontal, JunoSpace.hairline)
                }
            } else if isClosed,
                let chart = JunoChartMarkup.data(fenceInfo: language, source: source)
            {
                InlineChartRenderer(chart)
            } else {
                JunoProseCodeBlock(language: language, source: source)
            }

        case .math(let latex, _):
            JunoDisplayMath(latex: latex)

        case .list(let ordered, let start, let items):
            JunoReadingList(ordered: ordered, start: start, items: items)

        case .table(let header, let rows):
            JunoProseTable(header: header, rows: rows)

        case .quote(let text):
            // `border-left: 3px solid var(--border); padding-left: 1em` in the
            // secondary ink.
            HStack(alignment: .top, spacing: JunoProseMetrics.quoteInset * textScale) {
                Rectangle()
                    .fill(Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: contrast == .increased)))
                    .frame(width: JunoProseMetrics.quoteBar)
                    .accessibilityHidden(true)
                JunoInlineText(text)
                    .junoType(.reading)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: JunoProseMetrics.measure(scale: textScale), alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)

        case .thematicBreak:
            Rectangle()
                .fill(Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: contrast == .increased)))
                .frame(height: 1)
                .frame(maxWidth: .infinity)
                .accessibilityHidden(true)
        }
    }
}

/// A list in the reading style: 1.4em of indent to the text, 0.2em between
/// items, the marker in the secondary ink on the text's own first line.
private struct JunoReadingList: View {
    let ordered: Bool
    let start: Int
    let items: [JunoMarkdownBlock.Item]

    @Environment(\.junoTextScale) private var textScale
    @Environment(\.junoFindHighlight) private var find
    @Environment(\.junoCitationCount) private var citations

    var body: some View {
        let bases = findBases
        VStack(alignment: .leading, spacing: JunoProseMetrics.listItemGap * textScale) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    marker(index: index, item: item)
                        .frame(width: JunoProseMetrics.listIndent * textScale, alignment: .leading)
                        .accessibilityHidden(item.isChecked == nil)
                    JunoInlineText(item.text)
                        .junoType(.reading)
                        .junoInk()
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: JunoProseMetrics.measure(scale: textScale), alignment: .leading)
                        .environment(\.junoFindHighlight, find?.shifted(by: bases[safe: index] ?? 0))
                }
                .padding(.leading, Double(item.depth) * JunoProseMetrics.listIndent * textScale)
                .frame(maxWidth: .infinity, alignment: .leading)
                .junoStreamRevealScope(isLast: index == items.count - 1)
                .junoStreamBlockReveal()
            }
        }
    }

    private var findBases: [Int] {
        guard let find, find.isActive else { return [] }
        var running = 0
        return items.map { item in
            defer {
                running += JunoFindText.count(
                    of: find.query,
                    in: JunoFindText.inlineText(item.text, citations: citations)
                )
            }
            return running
        }
    }

    @ViewBuilder
    private func marker(index: Int, item: JunoMarkdownBlock.Item) -> some View {
        if let isChecked = item.isChecked {
            JunoIconView(isChecked ? .squareCheck : .square, size: 15)
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityLabel(isChecked ? "Done" : "Not done")
        } else if ordered {
            Text("\(start + index).")
                .junoType(.reading)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
        } else {
            // `list-style: disc`, and the printed ladder beneath it.
            Text(item.depth == 0 ? "•" : (item.depth == 1 ? "◦" : "▪"))
                .junoType(.reading)
                .foregroundStyle(Color.junoSecondaryInk)
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
/// Fluid streaming cursor matching the web design system.
public struct JunoStreamingCursor: View {
    @State private var isPulsing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init() {}

    public var body: some View {
        RoundedRectangle(cornerRadius: 1.5)
            .fill(Color.primary.opacity(isPulsing ? 0.9 : 0.35))
            .frame(width: 5, height: 16)
            .shadow(color: Color.junoAccent.opacity(isPulsing ? 0.4 : 0.0), radius: 3, x: 0, y: 0)
            .animation(
                JunoMotion.reduced(
                    JunoMotion.standard.repeatForever(autoreverses: true),
                    when: reduceMotion,
                    tier: .ambient
                ),
                value: isPulsing
            )
            .onAppear {
                isPulsing = true
            }
    }
}

struct JunoInlineText: View {
    private let source: String
    private let caret: Bool
    /// The size inline code and citations are measured against: the run's own
    /// text size in the reading style (`0.875em` of it, `0.72em` of it).
    private let baseSize: CGFloat

    @Environment(\.junoProseStyle) private var style
    @Environment(\.junoTextScale) private var textScale
    @Environment(\.junoFindHighlight) private var find
    @Environment(\.junoCitationCount) private var citations
    @Environment(\.junoCitationPopover) private var citationPopover
    @Environment(\.junoStreamReveal) private var reveal

    init(_ source: String, caret: Bool = false, baseSize: CGFloat = JunoProseMetrics.bodySize) {
        self.source = source
        self.caret = caret
        self.baseSize = baseSize
    }

    var body: some View {
        // The newest words of a paced reply fade in (JunoStreamReveal.swift).
        styled.junoStreamRevealText()
    }

    @ViewBuilder
    private var styled: some View {
        switch style {
        case .standard:
            let attributed = AttributedString.junoInline(source)
            // A paced reply's fading tail says where the writing is; the
            // caret is for text that arrives unpaced.
            if caret, reveal == nil {
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(attributed)
                    JunoStreamingCursor()
                        .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 3 }
                }
                .tint(Color.junoAccent)
            } else {
                Text(attributed)
                    .tint(Color.junoAccent)
            }
        case .reading:
            let attributed = JunoFindText.highlighted(
                JunoProseInline.styled(source, baseSize: baseSize, scale: textScale, citations: citations),
                with: find
            )
            if citations > 0, let citationPopover {
                JunoCitedText(attributed: attributed, popover: citationPopover)
            } else {
                Text(attributed)
                    .tint(Color.junoAccentInk)
            }
        }
    }
}

/// A run with citations in it: a click on a chip opens its source's popover,
/// anchored where the chip was clicked.
///
/// `Text` cannot say where one of its runs is drawn, so the anchor is the
/// pointer: the run tracks where the pointer is over it, and the popover opens
/// at that point when the chip's `juno-cite://n` link is followed.
private struct JunoCitedText: View {
    let attributed: AttributedString
    let popover: JunoCitationPopover

    @State private var pointer: CGPoint = .zero
    @State private var size: CGSize = .zero
    @State private var open: Int?

    var body: some View {
        Text(attributed)
            .tint(Color.junoAccentInk)
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
            .onContinuousHover(coordinateSpace: .local) { phase in
                if case .active(let location) = phase { pointer = location }
            }
            .environment(\.openURL, OpenURLAction { url in
                guard let number = JunoProseInline.citationNumber(url) else { return .systemAction }
                open = number
                return .handled
            })
            .popover(
                isPresented: Binding(get: { open != nil }, set: { if !$0 { open = nil } }),
                attachmentAnchor: .point(anchor),
                arrowEdge: .top
            ) {
                if let open {
                    popover.content(open)
                }
            }
    }

    private var anchor: UnitPoint {
        guard size.width > 0, size.height > 0 else { return .center }
        return UnitPoint(
            x: min(max(pointer.x / size.width, 0), 1),
            y: min(max(pointer.y / size.height, 0), 1)
        )
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
                .junoStreamRevealScope(isLast: index == items.count - 1)
                .junoStreamBlockReveal()
            }
        }
    }

    @ViewBuilder
    private func marker(index: Int, item: JunoMarkdownBlock.Item) -> some View {
        if let isChecked = item.isChecked {
            JunoIconView(isChecked ? .squareCheck : .square)
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
