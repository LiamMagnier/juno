import SwiftUI

#if canImport(Charts)
import Charts
#endif

/// A structured data block, drawn with Apple's Charts.
///
/// The parsing lives in `JunoChartMarkup.swift`; this file only decides how the
/// numbers look. That split is deliberate — every judgement call about *what the
/// data says* is unit-tested there, and nothing here can quietly reinterpret it.
///
/// **What this view will not do.** It will not plot a missing value as zero, it
/// will not hide a column it could not draw, and it will not caption a chart the
/// author did not title. Each of those would make the picture claim more than
/// the source supports, and a chart is believed faster than a sentence — a
/// reader who skims a bar chart has already accepted its shape before reading a
/// word of the answer around it. So gaps stay gaps, and anything left out is
/// named underneath in the same breath.
public struct InlineChartRenderer: View {
    private let data: JunoChartData

    /// Grows with Dynamic Type rather than staying a fixed slab. At AX5 the axis
    /// labels alone are most of a 220pt frame, which is how a chart becomes an
    /// unreadable smear of overlapping text for exactly the readers who most
    /// need it legible.
    @ScaledMetric(relativeTo: .body) private var plotHeight: CGFloat = 220

    public init(_ data: JunoChartData) {
        self.data = data
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if let title = data.title {
                Text(title)
                    .font(.system(.subheadline, design: .default, weight: .semibold))
                    .junoInk()
                    .accessibilityAddTraits(.isHeader)
            }

            plot
                .frame(height: plotHeight)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(accessibilityLabel)
                .accessibilityValue(accessibilitySummary)

            if !provenance.isEmpty {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    ForEach(provenance, id: \.self) { note in
                        Text(note).junoCaption()
                    }
                }
            }
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoSurface)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
    }

    // MARK: The plot

    @ViewBuilder
    private var plot: some View {
        #if canImport(Charts)
        Chart(points) { point in
            mark(for: point)
        }
        .chartForegroundStyleScale(
            domain: colourDomain,
            range: JunoChartPalette.colours(count: colourDomain.count)
        )
        .chartLegend(colourDomain.count > 1 ? .visible : .hidden)
        .chartXAxis(data.kind == .sector ? .hidden : .automatic)
        .chartYAxis(data.kind == .sector ? .hidden : .automatic)
        #else
        JunoChartTableFallback(table: data.table)
        #endif
    }

    #if canImport(Charts)
    /// One mark family per chart kind, written as four small builders rather
    /// than one clever generic one: the modifiers genuinely differ — a bar
    /// dodges by series, a sector has no axes to dodge along — and a shared
    /// implementation would have to pretend otherwise.
    @ChartContentBuilder
    private func mark(for point: JunoChartPoint) -> some ChartContent {
        switch data.kind {
        case .bar:
            BarMark(
                x: .value(data.table.categoryColumn, point.category),
                y: .value(point.series, point.value)
            )
            .foregroundStyle(by: .value("Series", point.colourKey))
            .position(by: .value("Series", point.series))
            .cornerRadius(JunoRadius.chip / 2)

        case .line:
            LineMark(
                x: .value(data.table.categoryColumn, point.category),
                y: .value(point.series, point.value)
            )
            .foregroundStyle(by: .value("Series", point.colourKey))
            .interpolationMethod(.monotone)
            .symbol(by: .value("Series", point.colourKey))

        case .point:
            PointMark(
                x: .value(data.table.categoryColumn, point.category),
                y: .value(point.series, point.value)
            )
            .foregroundStyle(by: .value("Series", point.colourKey))

        case .sector:
            SectorMark(
                angle: .value(point.series, point.value),
                innerRadius: .ratio(0.55),
                angularInset: 1.5
            )
            .foregroundStyle(by: .value("Series", point.colourKey))
            .cornerRadius(JunoRadius.chip / 2)
        }
    }
    #endif

    // MARK: Data

    /// The flattened marks. **A `nil` value produces no point at all** — the mark
    /// is absent, not zero-height — which is what leaves a visible gap in a line
    /// and a missing bar in a group. That gap is the honest rendering of a gap.
    private var points: [JunoChartPoint] {
        var result: [JunoChartPoint] = []
        let columns = data.chartedColumns
        for (rowIndex, row) in data.table.rows.enumerated() {
            for (columnIndex, column) in columns.enumerated() {
                guard row.values.indices.contains(columnIndex),
                    let value = row.values[columnIndex]
                else { continue }
                result.append(
                    JunoChartPoint(
                        id: rowIndex * max(columns.count, 1) + columnIndex,
                        category: row.category,
                        series: column,
                        value: value,
                        // A sector chart's slices *are* the categories, so the
                        // colour has to vary by category there and by series
                        // everywhere else. Colouring every slice of a pie the
                        // same would make it one circle.
                        colourKey: data.kind == .sector ? row.category : column
                    )
                )
            }
        }
        return result
    }

    private var colourDomain: [String] {
        data.kind == .sector
            ? data.table.rows.map(\.category)
            : data.chartedColumns
    }

    // MARK: Provenance

    /// What the chart is not showing, said out loud.
    ///
    /// Three separate omissions, kept separate because they have different
    /// causes and different fixes: the data did not have the value, the column
    /// held no numbers, or the chart kind can only draw one series. Collapsing
    /// them into one "some data omitted" would tell the reader something is
    /// missing without telling them what — which is the worst of both.
    private var provenance: [String] {
        var notes: [String] = []
        let missing = data.table.missingValueCount
        if missing > 0 {
            notes.append(
                missing == 1
                    ? "1 value was not available and is not plotted."
                    : "\(missing) values were not available and are not plotted."
            )
        }
        if !data.table.ignoredColumns.isEmpty {
            notes.append(
                "Not charted (no numeric values): "
                    + data.table.ignoredColumns.joined(separator: ", ")
            )
        }
        if !data.undrawnColumns.isEmpty {
            notes.append(
                "A \(data.kind.rawValue) chart shows one series: "
                    + data.undrawnColumns.joined(separator: ", ")
                    + " \(data.undrawnColumns.count == 1 ? "is" : "are") not shown."
            )
        }
        return notes
    }

    // MARK: Accessibility

    private var accessibilityLabel: String {
        let name = data.title ?? "\(data.kind.rawValue) chart"
        return "\(name), \(data.table.categoryColumn) against "
            + data.chartedColumns.joined(separator: ", ")
    }

    /// A spoken reading of the numbers.
    ///
    /// Capped, because VoiceOver reading a 400-row table aloud is not
    /// accessibility, it is a trap the reader cannot escape. The cap is stated
    /// in the speech rather than silently truncating, so nobody is left thinking
    /// they heard the whole series.
    private var accessibilitySummary: String {
        let limit = 12
        let spoken = data.table.rows.prefix(limit).map { row -> String in
            let values = zip(data.chartedColumns, row.values)
                .map { column, value in
                    value.map { "\(column) \(JunoChartMarkup.label(for: $0))" }
                        ?? "\(column) not available"
                }
                .joined(separator: ", ")
            return "\(row.category): \(values)"
        }
        let remainder = data.table.rows.count - min(data.table.rows.count, limit)
        let tail = remainder > 0 ? ". \(remainder) further rows not spoken." : ""
        return spoken.joined(separator: ". ") + tail
    }
}

// MARK: - Point

/// One plotted observation. `id` is positional and stable within a parse, which
/// is all `Chart(_:)` needs — the whole series is rebuilt whenever the block's
/// source changes.
private struct JunoChartPoint: Identifiable {
    let id: Int
    let category: String
    let series: String
    let value: Double
    let colourKey: String
}

// MARK: - Palette

/// The categorical series palette.
///
/// **Deliberately not the status ramp.** `junoSuccess`, `junoCaution` and
/// `junoDanger` mean *passed*, *waiting* and *failed*, and a chart borrowing
/// them says a series called "Churn" failed and one called "Signups" passed. A
/// data series has no state; it needs colours that are only telling categories
/// apart. So these are their own tokens, warm-biased to sit on Juno's paper, and
/// ordered so the first two — the overwhelmingly common one- and two-series
/// cases — are the brand's own accent and the citation teal.
///
/// Light and dark are tuned separately rather than by lightening one ramp: dark
/// mode lifts lightness instead of pushing chroma, the same rule the status
/// colours follow, so a series stays legible on the warm near-black without
/// glowing.
enum JunoChartPalette {
    /// The accent leads, so a single-series chart is on brand and follows the
    /// account's chosen accent rather than pinning coral.
    static func colours(count: Int) -> [Color] {
        guard count > 0 else { return [] }
        var result: [Color] = [.junoAccent, .junoSource]
        result += supplementary.map { Color.junoAdaptive(light: $0.light, dark: $0.dark) }
        // Cycling beats running out: a 9-series chart with three grey series is
        // less readable than one where colour 7 repeats colour 1, and the legend
        // disambiguates either way.
        guard count > result.count else { return Array(result.prefix(count)) }
        return (0..<count).map { result[$0 % result.count] }
    }

    private static let supplementary: [(light: JunoColorToken, dark: JunoColorToken)] = [
        // Amber. Not `cautionLight`: this one is free to sit brighter because it
        // is never read as text.
        (JunoColorToken(unchecked: 0.639, 0.435, 0.031), JunoColorToken(unchecked: 0.933, 0.714, 0.318)),
        // Violet.
        (JunoColorToken(unchecked: 0.412, 0.302, 0.663), JunoColorToken(unchecked: 0.678, 0.596, 0.918)),
        // Sage.
        (JunoColorToken(unchecked: 0.208, 0.451, 0.310), JunoColorToken(unchecked: 0.451, 0.749, 0.549)),
        // Clay.
        (JunoColorToken(unchecked: 0.478, 0.325, 0.239), JunoColorToken(unchecked: 0.804, 0.624, 0.478)),
    ]
}

// MARK: - Fallback

/// The data as a table, for a platform with no Charts framework.
///
/// Shown instead of nothing, and instead of an apology. The numbers are the
/// point; the chart was only ever a faster way to read them.
struct JunoChartTableFallback: View {
    let table: JunoChartTable

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            Grid(alignment: .leading, horizontalSpacing: JunoSpace.regular, verticalSpacing: 0) {
                GridRow {
                    Text(table.categoryColumn)
                        .font(.callout.weight(.semibold))
                    ForEach(table.valueColumns, id: \.self) { column in
                        Text(column).font(.callout.weight(.semibold))
                    }
                }
                .padding(.vertical, JunoSpace.tight)

                Divider().gridCellUnsizedAxes(.horizontal)

                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        Text(row.category).font(.callout)
                        ForEach(Array(row.values.enumerated()), id: \.offset) { _, value in
                            // "—" for absent, never "0". The dash is the whole
                            // reason the model carries optionals.
                            Text(value.map(JunoChartMarkup.label(for:)) ?? "—")
                                .font(.callout.monospacedDigit())
                                .junoSecondaryInk()
                        }
                    }
                    .padding(.vertical, JunoSpace.tight)
                }
            }
        }
    }
}
