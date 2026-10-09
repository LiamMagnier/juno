import Charts
import JunoDesignSystem
import SwiftUI

/// A spreadsheet, document or deck drawn from its model — the native half of
/// the web's `SemanticArtifactView` (`src/components/semantic/*`).
///
/// Read-only: the web edits these through `<juno:artifact-ops>` operations
/// and the ops route; here the chat is where they change. A body that does
/// not open says so in one quiet line instead of showing its JSON.
public struct SemanticArtifactView: View {
    public enum Presentation: Sendable {
        /// The canvas, the artifact page and the phone's sheet.
        case full
        /// Inside a transcript card: tighter margins, the same reader.
        case inline
    }

    private let kind: NativeArtifactKind
    private let content: String
    private let presentation: Presentation

    public init(kind: NativeArtifactKind, content: String, presentation: Presentation = .full) {
        self.kind = kind
        self.content = content
        self.presentation = presentation
    }

    private var parsed: Result<SemanticArtifact, Error> {
        Result { try SemanticArtifact.parse(kind: kind, content: content) }
    }

    public var body: some View {
        switch parsed {
        case .success(.workbook(let book)):
            // Keyed on the body: the engine's computed values are per workbook.
            SemanticWorkbookView(workbook: book, presentation: presentation)
                .id(content.hashValue)
        case .success(.document(let document)):
            SemanticDocumentView(document: document, presentation: presentation)
        case .success(.deck(let deck)):
            SemanticDeckView(deck: deck, presentation: presentation)
        case .failure(let error):
            VStack(spacing: JunoSpace.snug) {
                Image(JunoIcon.warning.assetName)
                    .foregroundStyle(Color.junoWarningInk)
                    .accessibilityHidden(true)
                Text((error as? LocalizedError)?.errorDescription ?? "This version could not be opened.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(JunoSpace.section)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Spreadsheet

/// A sheet as a scrollable grid: column letters across the top (pinned),
/// row numbers down the side, computed values in their number formats.
struct SemanticWorkbookView: View {
    let workbook: SemanticWorkbook
    let presentation: SemanticArtifactView.Presentation

    @State private var sheetIndex = 0
    @State private var engine: SemanticWorkbookEngine

    /// Enough to read any sheet a chat makes; a bigger one says how much is shown.
    static let maxRows = 500
    static let maxColumns = 40

    init(workbook: SemanticWorkbook, presentation: SemanticArtifactView.Presentation) {
        self.workbook = workbook
        self.presentation = presentation
        _engine = State(initialValue: SemanticWorkbookEngine(workbook: workbook))
    }

    private var sheet: SemanticSheet { workbook.sheets[min(sheetIndex, workbook.sheets.count - 1)] }
    private var rows: Int { max(1, min(sheet.rowCount, Self.maxRows)) }
    private var columns: Int { max(1, min(sheet.columnCount, Self.maxColumns)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if workbook.sheets.count > 1 {
                Picker("Sheet", selection: $sheetIndex) {
                    ForEach(Array(workbook.sheets.enumerated()), id: \.offset) { index, sheet in
                        Text(sheet.name).tag(index)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
            }
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    Section {
                        ForEach(1...rows, id: \.self) { row in
                            rowView(row)
                        }
                    } header: {
                        headerRow
                    }
                }
            }
            .accessibilityLabel("\(sheet.name), \(sheet.rowCount) rows, \(sheet.columnCount) columns")
            if let footnote {
                Text(footnote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug)
            }
        }
    }

    private var footnote: String? {
        var parts: [String] = []
        if sheet.rowCount > Self.maxRows || sheet.columnCount > Self.maxColumns {
            parts.append("Showing the first \(rows) rows and \(columns) columns")
        }
        if sheet.chartCount > 0 {
            parts.append("\(sheet.chartCount) chart\(sheet.chartCount == 1 ? "" : "s") on this sheet draw on the web")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func width(_ column: Int) -> CGFloat {
        if let characters = sheet.columnWidths[column] { return max(48, min(360, CGFloat(characters) * 7.5)) }
        return 104
    }

    private static let rowHeight: CGFloat = 30
    private static let gutter: CGFloat = 44

    private var headerRow: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: Self.gutter, height: 26)
            ForEach(1...columns, id: \.self) { column in
                Text(SemanticCellAddress.columnName(column))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: width(column), height: 26)
                    .overlay(alignment: .trailing) { hairline(vertical: true) }
            }
        }
        .background(Color.junoSecondary)
        .overlay(alignment: .bottom) { hairline(vertical: false) }
        .accessibilityHidden(true)
    }

    private func rowView(_ row: Int) -> some View {
        HStack(spacing: 0) {
            Text(String(row))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: Self.gutter, height: Self.rowHeight)
                .background(Color.junoSecondary)
                .overlay(alignment: .trailing) { hairline(vertical: true) }
                .accessibilityHidden(true)
            ForEach(1...columns, id: \.self) { column in
                cellView(SemanticCellAddress(row: row, column: column))
            }
        }
        .background(row <= sheet.frozenRows ? Color.junoSecondary.opacity(0.5) : Color.clear)
        .overlay(alignment: .bottom) { hairline(vertical: false) }
    }

    private func cellView(_ address: SemanticCellAddress) -> some View {
        let display = engine.display(sheet: min(sheetIndex, workbook.sheets.count - 1), address: address)
        let cell = sheet.cells[address]
        return Text(display.text)
            .font(display.isUncomputed ? .caption.monospaced() : .callout)
            .fontWeight(cell?.bold == true ? .semibold : .regular)
            .monospacedDigit()
            .foregroundStyle(display.isError ? AnyShapeStyle(Color.junoDestructiveInk)
                : display.isUncomputed ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, JunoSpace.snug)
            .frame(width: width(address.column), height: Self.rowHeight,
                   alignment: display.isNumeric ? .trailing : .leading)
            .overlay(alignment: .trailing) { hairline(vertical: true) }
            .help(cell?.formula.map { "=" + $0 } ?? "")
            .accessibilityLabel("\(address.a1), \(display.text.isEmpty ? "empty" : display.text)")
    }

    private func hairline(vertical: Bool) -> some View {
        Rectangle()
            .fill(Color.junoHairline)
            .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

// MARK: - Document

/// The document as a page of headed text blocks. Open comments and pending
/// suggestions sit quietly under the block they belong to, references at the
/// foot.
struct SemanticDocumentView: View {
    let document: SemanticDocument
    let presentation: SemanticArtifactView.Presentation

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                if presentation == .full {
                    Text(document.title)
                        .font(.title2)
                        .fontWeight(.semibold)
                        .accessibilityAddTraits(.isHeader)
                        .padding(.bottom, JunoSpace.snug)
                }
                ForEach(document.blocks) { block in
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        blockView(block)
                        annotations(block)
                    }
                }
                if !document.sources.isEmpty {
                    references
                }
            }
            .textSelection(.enabled)
            .frame(maxWidth: 680, alignment: .leading)
            .padding(presentation == .full ? JunoSpace.section : JunoSpace.regular)
            .frame(maxWidth: .infinity)
        }
    }

    private func inline(_ text: String) -> Text {
        let markdown = document.inlineMarkdown(text)
        if let attributed = try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return Text(attributed)
        }
        return Text(markdown)
    }

    @ViewBuilder
    private func blockView(_ block: SemanticDocument.Block) -> some View {
        let deleting = document.pendingRevisions(on: block.id).contains { $0.kind == "delete" }
        Group {
            switch block.kind {
            case .heading(let level, let text):
                inline(text)
                    .font(level == 1 ? .title2 : level == 2 ? .title3 : .headline)
                    .fontWeight(.semibold)
                    .padding(.top, level <= 2 ? JunoSpace.snug : 0)
                    .accessibilityAddTraits(.isHeader)
            case .paragraph(let text, let style):
                if style == "quote" {
                    inline(text)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.leading, JunoSpace.cozy)
                        .overlay(alignment: .leading) {
                            Rectangle().fill(Color.junoHairline).frame(width: 2)
                        }
                } else {
                    inline(text).font(style == "lead" ? .title3 : .body)
                }
            case .list(let ordered, let items):
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                            Text(ordered ? "\(index + 1)." : "•")
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                            inline(item.text)
                        }
                        .font(.body)
                        .padding(.leading, CGFloat(item.level) * 18)
                    }
                }
            case .table(let header, let rows, let caption):
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    ScrollView(.horizontal) {
                        Grid(alignment: .leading, horizontalSpacing: JunoSpace.regular, verticalSpacing: JunoSpace.snug) {
                            GridRow {
                                ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                                    inline(cell).fontWeight(.semibold)
                                }
                            }
                            Divider().gridCellUnsizedAxes(.horizontal)
                            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                                GridRow {
                                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                        inline(cell)
                                    }
                                }
                            }
                        }
                        .font(.callout)
                    }
                    if let caption {
                        Text(caption).font(.caption).foregroundStyle(.secondary)
                    }
                }
            case .callout(let tone, let title, let text):
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Label {
                        Text(title.map { "\(tone.capitalized) · \($0)" } ?? tone.capitalized)
                    } icon: {
                        Image((tone == "warning" ? JunoIcon.warning : JunoIcon.info).assetName)
                    }
                    .font(.caption)
                    .foregroundStyle(tone == "warning" ? AnyShapeStyle(Color.junoWarningInk) : AnyShapeStyle(.secondary))
                    inline(text).font(.body)
                }
                .padding(.leading, JunoSpace.cozy)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Color.junoHairline).frame(width: 2)
                }
            case .figure(let alt, let caption):
                Label(caption ?? alt, image: JunoIcon.image.assetName)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            case .pageBreak:
                Divider().padding(.vertical, JunoSpace.snug)
            }
        }
        .strikethrough(deleting, color: .secondary)
        .opacity(deleting ? 0.6 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func annotations(_ block: SemanticDocument.Block) -> some View {
        let comments = document.openComments(on: block.id)
        let suggestions = document.pendingRevisions(on: block.id)
        if !comments.isEmpty || !suggestions.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                ForEach(suggestions) { revision in
                    Label {
                        // The suggested text is markdown, as the block's own text is.
                        Text((try? AttributedString(markdown: suggestionLine(revision))) ?? AttributedString(suggestionLine(revision)))
                    } icon: {
                        Image(JunoIcon.pencil.assetName)
                    }
                }
                ForEach(comments) { comment in
                    Label {
                        Text("\(comment.author): \(comment.text)")
                    } icon: {
                        Image(JunoIcon.message.assetName)
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
        }
    }

    private func suggestionLine(_ revision: SemanticDocument.Revision) -> String {
        switch revision.kind {
        case "insert": "\(revision.author) suggested adding: \(revision.text)"
        case "delete": "\(revision.author) suggested deleting this"
        default: "\(revision.author) suggested: \(revision.text)"
        }
    }

    private var references: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Divider().padding(.vertical, JunoSpace.snug)
            Text("References")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(Array(document.sources.enumerated()), id: \.offset) { index, source in
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Text("\(index + 1).").monospacedDigit().foregroundStyle(.secondary)
                    if let raw = source.url, let url = URL(string: raw), url.scheme == "https" || url.scheme == "http" {
                        Link(source.title, destination: url)
                    } else {
                        Text(source.title)
                    }
                    if let publisher = source.publisher {
                        Text(publisher).foregroundStyle(.secondary)
                    }
                }
                .font(.callout)
            }
        }
    }
}

// MARK: - Presentation

/// The deck as a vertical list of slides: each one a 16:9 frame with its
/// title, subtitle and bullets, tables and charts drawn plainly, and its
/// speaker notes under it.
struct SemanticDeckView: View {
    let deck: SemanticDeck
    let presentation: SemanticArtifactView.Presentation

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: JunoSpace.section) {
                ForEach(Array(deck.slides.enumerated()), id: \.element.id) { index, slide in
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        Text("Slide \(index + 1) of \(deck.slides.count)")
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        SemanticSlideView(slide: slide)
                        if let notes = slide.notes, presentation == .full {
                            Text(notes)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(presentation == .full ? JunoSpace.section : JunoSpace.regular)
            .frame(maxWidth: .infinity)
        }
    }
}

struct SemanticSlideView: View {
    let slide: SemanticDeck.Slide

    private var isTitleSlide: Bool { slide.layout == "title" || slide.layout == "section" }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if isTitleSlide { Spacer(minLength: 0) }
            if let title = slide.title {
                Text(title)
                    .font(isTitleSlide ? .title : .title2)
                    .fontWeight(.semibold)
                    .lineLimit(3)
                    .minimumScaleFactor(0.7)
                    .accessibilityAddTraits(.isHeader)
            }
            if let subtitle = slide.subtitle {
                Text(subtitle)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            elementsView
            if !isTitleSlide { Spacer(minLength: 0) }
        }
        .padding(JunoSpace.section)
        .frame(maxWidth: .infinity, alignment: .leading)
        .aspectRatio(16 / 9, contentMode: .fit)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var elementsView: some View {
        let columns = slide.layout == "two-column"
        if columns {
            HStack(alignment: .top, spacing: JunoSpace.section) {
                region(slide.elements.filter { if case .text(let region, _) = $0 { region != "right" } else { true } })
                region(slide.elements.filter { if case .text(let region, _) = $0 { region == "right" } else { false } })
            }
        } else {
            region(slide.elements)
        }
    }

    private func region(_ elements: [SemanticDeck.Element]) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            ForEach(Array(elements.enumerated()), id: \.offset) { _, element in
                elementView(element)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func elementView(_ element: SemanticDeck.Element) -> some View {
        switch element {
        case .text(_, let paragraphs):
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        if paragraph.bullet {
                            Text("•").foregroundStyle(.secondary)
                        }
                        Text(paragraph.text)
                            .fontWeight(paragraph.bold ? .semibold : .regular)
                    }
                    .font(paragraph.level == 0 ? .body : .callout)
                    .padding(.leading, CGFloat(paragraph.level) * 18)
                }
            }
        case .image(let alt):
            Label(alt, image: JunoIcon.image.assetName)
                .font(.callout)
                .foregroundStyle(.secondary)
        case .shape(let text):
            if let text, !text.isEmpty {
                Text(text).font(.callout)
            }
        case .table(let header, let rows):
            Grid(alignment: .leading, horizontalSpacing: JunoSpace.regular, verticalSpacing: JunoSpace.tight) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                        Text(cell).fontWeight(.semibold)
                    }
                }
                Divider().gridCellUnsizedAxes(.horizontal)
                ForEach(Array(rows.prefix(8).enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in Text(cell) }
                    }
                }
            }
            .font(.caption)
        case .chart(let type, let title, let categories, let series):
            SemanticSlideChart(type: type, title: title, categories: categories, series: series)
        }
    }
}

/// A deck chart, drawn plainly with Swift Charts in the system palette.
struct SemanticSlideChart: View {
    let type: String
    let title: String?
    let categories: [String]
    let series: [SemanticDeck.ChartSeries]

    private struct Point: Identifiable {
        let id: String
        let category: String
        let series: String
        let value: Double
    }

    private var points: [Point] {
        series.flatMap { line in
            line.values.enumerated().compactMap { index, value -> Point? in
                guard categories.indices.contains(index) else { return nil }
                return Point(id: "\(line.name)#\(index)", category: categories[index], series: line.name, value: value)
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            if let title {
                Text(title).font(.caption).foregroundStyle(.secondary)
            }
            Chart(points) { point in
                switch type {
                case "line":
                    LineMark(x: .value("Category", point.category), y: .value("Value", point.value))
                        .foregroundStyle(by: .value("Series", point.series))
                case "area":
                    AreaMark(x: .value("Category", point.category), y: .value("Value", point.value))
                        .foregroundStyle(by: .value("Series", point.series))
                case "pie":
                    SectorMark(angle: .value("Value", point.value))
                        .foregroundStyle(by: .value("Category", point.category))
                case "bar":
                    BarMark(x: .value("Value", point.value), y: .value("Category", point.category))
                        .foregroundStyle(by: .value("Series", point.series))
                default:
                    BarMark(x: .value("Category", point.category), y: .value("Value", point.value))
                        .foregroundStyle(by: .value("Series", point.series))
                }
            }
            .chartLegend(series.count > 1 || type == "pie" ? .visible : .hidden)
            .frame(minHeight: 120, maxHeight: 220)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title ?? "Chart")
    }
}
