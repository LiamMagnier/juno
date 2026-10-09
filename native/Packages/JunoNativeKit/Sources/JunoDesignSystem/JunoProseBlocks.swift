import SwiftUI

#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

// MARK: - Code

/// A fenced code block in the reading style (spec §6.5, brief §6.2).
///
/// An opaque card — `--card` under a 1pt `--border`, radius 12 — with a 32pt
/// header (the language in 11pt mono, and Copy) over the code.
///
/// **One `Text` for the whole listing.** The block it replaces drew a `Text`
/// per line, which made a selection stop at every line break: nobody could
/// select three lines and copy them. One attributed run, highlighted, set in SF
/// Mono 13 on an exact 20pt line, selects like the text it is.
///
/// Lines never wrap — a wrapped line doubles its height and loses the
/// indentation the reader is parsing with — so the code scrolls sideways, under
/// a gutter that stays put. The gutter appears only at eight lines or more,
/// where a line number starts being worth reading. Past 520pt the block scrolls
/// inside itself rather than pushing the answer a screen further down.
public struct JunoProseCodeBlock: View {
    public let language: String?
    public let source: String

    @Environment(\.junoTextScale) private var textScale
    @Environment(\.junoFindHighlight) private var find
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.junoCodeRunner) private var runner
    @State private var copied = false
    @State private var copiedReset: Task<Void, Never>?
    /// Run, as the web has it (code-run.tsx): the output opens under the
    /// code, and every Run bumps the token so the same code runs afresh.
    @State private var runToken = 0
    @State private var outputOpen = false

    public init(language: String?, source: String) {
        self.language = language
        self.source = source
    }

    /// The listing as drawn: a trailing newline is the fence's, not a line.
    private var listing: String {
        source.hasSuffix("\n") ? String(source.dropLast()) : source
    }

    private var lineCount: Int {
        listing.reduce(into: 1) { count, character in if character == "\n" { count += 1 } }
    }

    static let gutterThreshold = 8
    static let lineHeight: CGFloat = 20
    static let maximumBodyHeight: CGFloat = 520
    static let verticalPadding: CGFloat = 12
    static let horizontalPadding: CGFloat = 14
    static let headerHeight: CGFloat = 32

    private var showsGutter: Bool { lineCount >= Self.gutterThreshold }

    /// The code's own height, so the block knows before layout whether it
    /// has to scroll inside itself.
    private var naturalBodyHeight: CGFloat {
        CGFloat(lineCount) * Self.lineHeight * textScale + 2 * Self.verticalPadding
    }

    private var label: String {
        let trimmed = (language ?? "").trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? "code" : trimmed
    }

    /// What Run runs, when this app can run it.
    private var runTarget: JunoCodeRunTarget? {
        runner == nil ? nil : JunoCodeRunTarget.target(for: language)
    }

    @ViewBuilder
    private var output: some View {
        if outputOpen, let runTarget {
            JunoCodeRunOutput(target: runTarget, code: listing, runToken: runToken) {
                outputOpen = false
            }
        }
    }

    public var body: some View {
        #if os(macOS)
        // The Mac's listing (round 2): one quiet filled well, Xcode's and
        // ChatGPT for Mac's — no card edge and no rule under the header, so
        // the code is the only thing with a shape. Increase Contrast keeps
        // the hairline edge.
        VStack(alignment: .leading, spacing: 0) {
            header
            codeBody
            output
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoSecondary)
        )
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .overlay {
            if contrast == .increased {
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label == "code" ? "Code" : "\(label) code")
        #else
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle()
                .fill(Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: contrast == .increased)))
                .frame(height: 1)
            codeBody
            output
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoCard)
        )
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(
                    Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: contrast == .increased)),
                    lineWidth: 1
                )
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label == "code" ? "Code" : "\(label) code")
        #endif
    }

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            // The language is an identifier, so mono is right for it.
            Text(label)
                .junoType(JunoType(size: 11, lineHeight: 1.45, face: .mono, textStyle: .caption))
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: JunoSpace.snug)
            if let runTarget {
                JunoCodeRunButton {
                    outputOpen = true
                    runToken += 1
                }
                .help("Run this \(runTarget.label) here")
                .accessibilityLabel("Run \(runTarget.label)")
            }
            Button(action: copy) {
                JunoProseCopyGlyph(copied: copied)
            }
            .buttonStyle(JunoProseIconButtonStyle())
            .contentShape(.rect)
            .help(copied ? "Copied" : "Copy code")
            .accessibilityLabel(copied ? "Code copied" : "Copy code")
        }
        .padding(.leading, Self.horizontalPadding)
        .padding(.trailing, JunoSpace.hairline)
        .frame(height: Self.headerHeight)
    }

    @ViewBuilder
    private var codeBody: some View {
        if naturalBodyHeight > Self.maximumBodyHeight {
            ScrollView(.vertical) {
                listingRow
            }
            .scrollIndicators(.automatic)
            .frame(height: Self.maximumBodyHeight)
        } else {
            listingRow
        }
    }

    private var listingRow: some View {
        HStack(alignment: .top, spacing: 0) {
            if showsGutter {
                gutter
            }
            ScrollView(.horizontal) {
                Text(highlightedListing)
                    .junoType(.mono)
                    .foregroundStyle(Color.junoForeground)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(.horizontal, Self.horizontalPadding)
                    .padding(.vertical, Self.verticalPadding)
            }
            .scrollIndicators(.automatic)
        }
    }

    /// The numbers, 12pt mono in the secondary ink on the code's own 20pt
    /// line, right-aligned against a full-height rule.
    private var gutter: some View {
        Text((1...lineCount).map(String.init).joined(separator: "\n"))
            .junoType(JunoType(size: 12, lineHeight: Self.lineHeight / 12, face: .mono, textStyle: .footnote))
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
            .foregroundStyle(Color.junoSecondaryInk)
            .fixedSize()
            .padding(.leading, Self.horizontalPadding)
            .padding(.trailing, JunoSpace.close)
            .padding(.vertical, Self.verticalPadding)
            .overlay(alignment: .trailing) {
                Rectangle()
                    .fill(Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: contrast == .increased)))
                    .frame(width: 1)
            }
            .accessibilityHidden(true)
    }

    private var highlightedListing: AttributedString {
        JunoFindText.highlighted(
            JunoSyntaxHighlighter.highlighted(listing, language: language),
            with: find
        )
    }

    /// Copy, confirmed by the check for two seconds — the mark is the whole
    /// feedback, as it is on a reply.
    private func copy() {
        JunoPasteboard.copy(listing)
        copiedReset?.cancel()
        copied = true
        copiedReset = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            copied = false
        }
    }
}

/// Copy's glyph, cross-fading to the check: the reply's own confirmation.
struct JunoProseCopyGlyph: View {
    let copied: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            JunoIconView(.copy, size: 14)
                .opacity(copied ? 0 : 1)
                .scaleEffect(copied ? JunoMotion.scaleFrom(0.8, reduceMotion: reduceMotion) : 1)
            JunoIconView(.check, size: 14)
                .foregroundStyle(Color.junoSuccessInk)
                .opacity(copied ? 1 : 0)
                .scaleEffect(copied ? 1 : JunoMotion.scaleFrom(0.8, reduceMotion: reduceMotion))
        }
        .animation(
            JunoMotion.reduced(copied ? JunoMotion.swapArrive : JunoMotion.swapLeave, when: reduceMotion, tier: .tint),
            value: copied
        )
    }
}

/// A borderless icon control on content: a 28pt circle, the glyph in the
/// secondary ink turning primary under the pointer over the neutral hover
/// fill. Never the accent.
public struct JunoProseIconButtonStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration)
    }

    private struct Face: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovered = false
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .foregroundStyle(hovered && isEnabled ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: 28, height: 28)
                .background(Circle().fill(Color.junoHover).opacity(hovered && isEnabled ? 1 : 0))
                .contentShape(Circle())
                .opacity(isEnabled ? 1 : 0.5)
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1)
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}

// MARK: - Tables

/// A pipe table in the reading style (brief §6.2).
///
/// A `Grid` in the code block's card: the header row on `--secondary` in 13pt
/// medium over a rule of the foreground at 28%, the body in 13pt with
/// `--border` rules between rows and 10 × 8 of padding in each cell.
///
/// **Columns are laid out the way a browser lays out the web's table**, which
/// is `width: 100%` with wrapping cells: each column's single-line width is
/// measured, the table fills the measure, and a column that cannot fit gives
/// up width down to its floor by wrapping. Only when even the floors do not fit
/// does the table scroll sideways — a squeezed numeric column is worse than an
/// off-screen one.
public struct JunoProseTable: View {
    public let header: [String]
    public let rows: [[String]]

    @Environment(\.junoTextScale) private var textScale
    @Environment(\.junoFindHighlight) private var find
    @Environment(\.junoCitationCount) private var citations
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var available: CGFloat = 0

    public init(header: [String], rows: [[String]]) {
        self.header = header
        self.rows = rows
    }

    static let cellHorizontalPadding: CGFloat = 10
    static let cellVerticalPadding: CGFloat = 8
    /// Below this a column wraps no further; the table scrolls instead.
    static let columnFloor: CGFloat = 120
    static let textSize: CGFloat = 13

    private var columnCount: Int {
        max(header.count, rows.map(\.count).max() ?? 0)
    }

    private var hairline: Double { JunoHairline.opacity(increaseContrast: contrast == .increased) }

    public var body: some View {
        let widths = JunoProseTableLayout.columnWidths(
            natural: naturalWidths,
            available: available,
            floor: Self.columnFloor * textScale
        )
        // Always inside a sideways scroll view: it takes the width the prose
        // proposes and never grows with what it holds, so that width is what
        // the columns are laid out against. It scrolls only when even the
        // columns' floors do not fit.
        return ScrollView(.horizontal) {
            grid(widths: widths)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .scrollIndicators(.automatic)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { available = $0 }
        .modifier(JunoProseTableSurface(hairline: hairline))
    }

    private func grid(widths: [CGFloat]) -> some View {
        let counts = findCounts
        return Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(0..<columnCount, id: \.self) { column in
                    cell(Self.cell(header, column), width: widths[safe: column], isHeader: true)
                        .environment(\.junoFindHighlight, find?.shifted(by: counts.base(row: -1, column: column)))
                        // The whole row's height, so a header that wraps in
                        // one column leaves no gap in the fill of the others.
                        .frame(maxHeight: .infinity, alignment: .topLeading)
                        .background(Self.headerFill)
                }
            }
            Rectangle()
                .fill(Color.junoForeground.opacity(Self.headerRuleOpacity))
                .frame(height: 1)
                .gridCellUnsizedAxes(.horizontal)
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                GridRow {
                    ForEach(0..<columnCount, id: \.self) { column in
                        cell(Self.cell(row, column), width: widths[safe: column], isHeader: false)
                            .environment(\.junoFindHighlight, find?.shifted(by: counts.base(row: index, column: column)))
                    }
                }
                if index < rows.count - 1 {
                    Rectangle()
                        .fill(Color.junoBorder.opacity(hairline))
                        .frame(height: 1)
                        .gridCellUnsizedAxes(.horizontal)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    #if os(macOS)
    /// The Mac's table (round 2) is open, as Notes and ChatGPT for Mac draw
    /// one: no card and no header band — the header is set apart by its ink
    /// and a slightly firmer rule, the rows by hairlines.
    static let headerFill = Color.clear
    static let headerRuleOpacity = 0.16
    static let headerInk = Color.junoSecondaryInk
    #else
    static let headerFill = Color.junoSecondary
    static let headerRuleOpacity = 0.28
    static let headerInk = Color.junoForeground
    #endif

    private func cell(_ text: String, width: CGFloat?, isHeader: Bool) -> some View {
        JunoInlineText(text, baseSize: Self.textSize)
            .junoType(
                isHeader
                    ? JunoType(size: Self.textSize, weight: .medium, lineHeight: 1.5, textStyle: .callout)
                    : .ui
            )
            .foregroundStyle(isHeader ? Self.headerInk : Color.junoForeground)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(
                width: width.map { max(0, $0 - 2 * Self.cellHorizontalPadding * textScale) },
                alignment: .topLeading
            )
            .padding(.horizontal, Self.cellHorizontalPadding * textScale)
            .padding(.vertical, Self.cellVerticalPadding * textScale)
            .accessibilityAddTraits(isHeader ? .isHeader : [])
    }

    /// Rows shorter than the header are common in hand-written tables; render
    /// the gap rather than dropping the row.
    static func cell(_ row: [String], _ column: Int) -> String {
        column < row.count ? row[column] : ""
    }

    /// Each column's single-line width, with its padding.
    private var naturalWidths: [CGFloat] {
        (0..<columnCount).map { column in
            let cells = [Self.cell(header, column)] + rows.map { Self.cell($0, column) }
            let widest = cells.enumerated().map { index, text in
                JunoProseTableLayout.textWidth(
                    String(JunoProseInline.styled(text, baseSize: Self.textSize, scale: textScale, citations: citations).characters),
                    size: Self.textSize * textScale,
                    medium: index == 0
                )
            }.max() ?? 0
            return (widest + 2 * Self.cellHorizontalPadding * textScale).rounded(.up) + 1
        }
    }

    /// Where each cell's matches start, in the order ``JunoFindText`` counts
    /// them: the header's cells, then each row's.
    private var findCounts: JunoProseTableFindBases {
        JunoProseTableFindBases(header: header, rows: rows, columns: columnCount, query: find?.query, citations: citations)
    }
}

/// The table's ground: the iPhone's card, or — on the Mac — nothing at all,
/// with the first and last cells kept on the prose's own left edge.
private struct JunoProseTableSurface: ViewModifier {
    let hairline: Double

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .padding(.horizontal, -JunoProseTable.cellHorizontalPadding)
        #else
        content
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .fill(Color.junoCard)
            )
            .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(Color.junoBorder.opacity(hairline), lineWidth: 1)
            )
        #endif
    }
}

/// The table's column arithmetic, kept pure so it can be tested.
public enum JunoProseTableLayout {
    /// The width each column gets: its natural width with the slack shared out
    /// when everything fits; otherwise shrunk toward `floor` in proportion to
    /// how much each has to give; otherwise the floors, and the table scrolls.
    public static func columnWidths(natural: [CGFloat], available: CGFloat, floor: CGFloat) -> [CGFloat] {
        guard !natural.isEmpty else { return [] }
        guard available > 0 else { return natural }
        let total = natural.reduce(0, +)
        if total <= available {
            let slack = available - total
            return fillingOut(natural.map { ($0 + slack * $0 / total).rounded(.down) }, to: available)
        }
        let minimums = natural.map { min($0, floor) }
        let minimumTotal = minimums.reduce(0, +)
        guard minimumTotal < available else { return minimums }
        let flexible = zip(natural, minimums).map { $0 - $1 }
        let flexibleTotal = flexible.reduce(0, +)
        let share = (available - minimumTotal) / max(flexibleTotal, 1)
        return fillingOut(zip(minimums, flexible).map { ($0 + $1 * share).rounded(.down) }, to: available)
    }

    /// The points lost to rounding go to the last column, so the rules and
    /// the header fill reach the card's edge.
    private static func fillingOut(_ widths: [CGFloat], to available: CGFloat) -> [CGFloat] {
        guard var last = widths.last else { return widths }
        last += max(0, (available - widths.reduce(0, +)).rounded(.down))
        return widths.dropLast() + [last]
    }

    /// One line of `text` at `size`, in points.
    static func textWidth(_ text: String, size: CGFloat, medium: Bool) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
        let font = NSFont.systemFont(ofSize: size, weight: medium ? .medium : .regular)
        #elseif canImport(UIKit)
        let font = UIFont.systemFont(ofSize: size, weight: medium ? .medium : .regular)
        #endif
        #if canImport(AppKit) || canImport(UIKit)
        return (text as NSString).size(withAttributes: [.font: font]).width
        #else
        return CGFloat(text.count) * size * 0.55
        #endif
    }
}

/// The ordinal each table cell's matches start from.
struct JunoProseTableFindBases {
    private var bases: [Int: Int] = [:]

    init(header: [String], rows: [[String]], columns: Int, query: String?, citations: Int) {
        guard let query, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        var running = 0
        let allRows = [header] + rows
        for (rowIndex, row) in allRows.enumerated() {
            // Only the cells the source actually has count, as
            // ``JunoFindText/blockTexts(_:citations:)`` reads them.
            for column in 0..<columns {
                bases[(rowIndex - 1) * 1_000 + column] = running
                if column < row.count {
                    running += JunoFindText.count(of: query, in: JunoFindText.inlineText(row[column], citations: citations))
                }
            }
        }
    }

    func base(row: Int, column: Int) -> Int {
        bases[row * 1_000 + column] ?? 0
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
