import SwiftUI

/// Renders assistant/user message Markdown as native SwiftUI.
///
/// Content is flat and borderless: no card, no bubble, no background of its
/// own. Only the blocks that genuinely need a container get one — code, tables
/// and quotes — so a long answer reads as a document rather than a stack of
/// panels. The caller owns the surrounding padding and width clamp.
public struct JunoMarkdownText: View {
    private let source: String
    private let blocks: [JunoMarkdownBlock]

    public init(_ source: String) {
        self.source = source
        self.blocks = JunoMarkdown.blocks(from: source)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpacing.control) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                JunoMarkdownBlockView(block: block)
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

    var body: some View {
        switch block {
        case .paragraph(let text):
            JunoInlineText(text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .heading(let level, let text):
            JunoInlineText(text)
                .font(headingFont(level))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, level <= 2 ? JunoSpacing.compact : 0)
                .accessibilityAddTraits(.isHeader)

        case .code(let language, let source, _):
            JunoCodeBlock(language: language, source: source)

        case .list(let ordered, let start, let items):
            JunoMarkdownList(ordered: ordered, start: start, items: items)

        case .table(let header, let rows):
            JunoMarkdownTable(header: header, rows: rows)

        case .quote(let text):
            HStack(alignment: .top, spacing: JunoSpacing.control) {
                Capsule(style: .continuous)
                    .fill(Color.junoAccent.opacity(0.55))
                    .frame(width: 3)
                    .accessibilityHidden(true)
                JunoInlineText(text)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            .fixedSize(horizontal: false, vertical: true)

        case .thematicBreak:
            Divider().padding(.vertical, JunoSpacing.compact)
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

/// Inline Markdown (bold, italic, `code`, links) with a plain-text fallback.
///
/// `AttributedString(markdown:)` throws on malformed input — routine while a
/// message is still streaming and a `[link](` is half-written — so the raw
/// string is shown rather than an error or an empty row.
struct JunoInlineText: View {
    private let attributed: AttributedString

    init(_ source: String) {
        if let parsed = try? AttributedString(
            markdown: source,
            options: .init(
                allowsExtendedAttributes: true,
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ) {
            attributed = parsed
        } else {
            attributed = AttributedString(source)
        }
    }

    var body: some View {
        Text(attributed)
            .tint(Color.junoAccent)
    }
}

/// A fenced code block: monospaced, horizontally scrollable so column alignment
/// survives, with the language and a copy action in a quiet header.
///
/// Wrapping is deliberately off. Soft-wrapped code doubles every long line's
/// height and destroys the indentation the reader is using to parse it.
struct JunoCodeBlock: View {
    let language: String?
    let source: String
    @State private var didCopy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: JunoSpacing.compact) {
                if let language, !language.isEmpty {
                    Text(language)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button {
                    JunoPasteboard.copy(source)
                    didCopy = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.6))
                        didCopy = false
                    }
                } label: {
                    Label(
                        didCopy ? "Copied" : "Copy",
                        systemImage: didCopy ? "checkmark" : "doc.on.doc"
                    )
                    .font(.caption2)
                    .labelStyle(.iconOnly)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help(didCopy ? "Copied" : "Copy code")
                .accessibilityLabel(didCopy ? "Code copied" : "Copy code")
            }
            .padding(.horizontal, JunoSpacing.control)
            .padding(.vertical, JunoSpacing.compact)

            ScrollView(.horizontal) {
                Text(source)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(.horizontal, JunoSpacing.control)
                    .padding(.bottom, JunoSpacing.control)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.automatic)
        }
        .background(
            RoundedRectangle(cornerRadius: JunoCornerRadius.control, style: .continuous)
                .fill(Color.junoCanvas)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoCornerRadius.control, style: .continuous)
                .strokeBorder(Color.junoHairline)
        )
    }
}

private struct JunoMarkdownList: View {
    let ordered: Bool
    let start: Int
    let items: [JunoMarkdownBlock.Item]

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpacing.compact) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: JunoSpacing.compact) {
                    marker(index: index, item: item)
                        .frame(minWidth: 18, alignment: .trailing)
                        .accessibilityHidden(item.isChecked == nil)
                    JunoInlineText(item.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, Double(item.depth) * JunoSpacing.content)
            }
        }
    }

    @ViewBuilder
    private func marker(index: Int, item: JunoMarkdownBlock.Item) -> some View {
        if let isChecked = item.isChecked {
            Image(systemName: isChecked ? "checkmark.square.fill" : "square")
                .font(.callout)
                .foregroundStyle(isChecked ? Color.junoAccent : Color.secondary)
                .accessibilityLabel(isChecked ? "Done" : "Not done")
        } else if ordered {
            Text("\(start + index).")
                .font(.body.monospacedDigit())
                .foregroundStyle(.secondary)
        } else {
            // Nesting changes the glyph the way a printed document would, so
            // depth stays legible even when the indent is subtle.
            Text(item.depth == 0 ? "•" : (item.depth == 1 ? "◦" : "▪"))
                .font(.body)
                .foregroundStyle(.secondary)
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
            Grid(alignment: .leading, horizontalSpacing: JunoSpacing.content, verticalSpacing: 0) {
                GridRow {
                    ForEach(0..<columnCount, id: \.self) { column in
                        Text(cell(header, column))
                            .font(.callout.weight(.semibold))
                            .textSelection(.enabled)
                    }
                }
                .padding(.vertical, JunoSpacing.compact)

                Divider().gridCellUnsizedAxes(.horizontal)

                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(0..<columnCount, id: \.self) { column in
                            JunoInlineText(cell(row, column))
                                .font(.callout)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(.vertical, JunoSpacing.compact)
                    if index < rows.count - 1 {
                        Divider().gridCellUnsizedAxes(.horizontal)
                    }
                }
            }
            .padding(.horizontal, JunoSpacing.control)
        }
        .background(
            RoundedRectangle(cornerRadius: JunoCornerRadius.control, style: .continuous)
                .fill(Color.junoCanvas)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoCornerRadius.control, style: .continuous)
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
