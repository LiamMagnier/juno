import SwiftUI

#if canImport(Charts)
import Charts
#endif

// MARK: Chart

/// A chart bound to formulas, drawn with Swift Charts. Same voice as the web:
/// one accent (the first series), the others in falling ink told apart by
/// dash, and a readout above the plot that rests on the marked x (or the last
/// point) and follows the pointer or a scrub.
struct LiveChartView: View {
    let chart: LiveChartSpec
    let context: LiveUIContext
    @State private var selectedX: Double?
    @State private var selectedLabel: String?
    @ScaledMetric(relativeTo: .body) private var plotHeight: CGFloat = 190

    struct Point: Identifiable {
        let id: Int
        let index: Int
        let x: Double
        let label: String
        let series: Int
        let y: Double
    }

    struct Data {
        var xs: [Double] = []
        var labels: [String] = []
        var ys: [[Double?]] = []
        var numeric = true
        var mark: Double?
        var error: String?
    }

    private func compute() -> Data {
        var data = Data()
        data.ys = chart.series.map { _ in [] }
        let scope = context.scope
        if let range = chart.x {
            guard let from = scope.evaluate(range.from).value.number,
                let to = scope.evaluate(range.to).value.number,
                let step = scope.evaluate(range.step).value.number
            else {
                data.error = "The chart's range could not be worked out."
                return data
            }
            guard let xs = liveRange(from, to, step), xs.count <= 400 else {
                data.error = "The chart's range is too long to draw."
                return data
            }
            data.xs = xs
            data.labels = xs.map { scope.formatter.number($0, format: chart.xFormat ?? .number, currency: context.currency, digits: nil) }
            for x in xs {
                for (i, s) in chart.series.enumerated() {
                    data.ys[i].append(scope.evaluate(s.y, locals: [range.variable: .number(x)]).value.number)
                }
            }
            data.mark = chart.mark.flatMap { scope.evaluate($0).value.number }
            return data
        }
        guard let rows = scope.evaluate(chart.rows ?? "").value.list else {
            data.error = "The chart has no rows to draw."
            return data
        }
        data.numeric = false
        for (index, row) in rows.prefix(400).enumerated() {
            var locals: [String: LiveValue] = ["row": row, "index": .number(Double(index))]
            if case .object(let fields) = row { locals.merge(fields) { a, _ in a } } else { locals["value"] = row }
            let xv = chart.xKey == "index" ? LiveValue.number(Double(index + 1)) : scope.evaluate(chart.xKey ?? "index", locals: locals).value
            data.xs.append(Double(index))
            data.labels.append(xv.number.map { scope.formatter.number($0, format: chart.xFormat ?? .number, currency: context.currency, digits: nil) } ?? liveValueString(xv))
            for (i, s) in chart.series.enumerated() {
                data.ys[i].append(scope.evaluate(s.y, locals: locals).value.number)
            }
        }
        return data
    }

    private static let strokes: [Color] = [.junoAccent, Color.junoForeground.opacity(0.62), Color.junoForeground.opacity(0.42), Color.junoForeground.opacity(0.3)]
    private static let dashes: [[CGFloat]] = [[], [], [4, 3], [1.5, 3]]

    private func readout(_ v: Double) -> String {
        let format = chart.format ?? .number
        if format == .number, v != 0, abs(v) < 1 {
            return context.scope.formatter.number(v, format: .number, currency: nil, digits: min(6, 2 - Int(log10(abs(v)).rounded(.down))))
        }
        return context.format(v, format, unit: nil)
    }

    var body: some View {
        let data = compute()
        VStack(alignment: .leading, spacing: 10) {
            if let error = data.error ?? (data.xs.isEmpty ? "Nothing to draw yet." : nil) {
                if let title = chart.title { Text(title).font(.system(.subheadline, weight: .medium)).junoInk() }
                Text(error).font(.subheadline).foregroundStyle(Color.junoSecondaryInk)
            } else {
                header(data)
                plot(data)
                    .frame(height: plotHeight)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(chart.title ?? "Chart")
                    .accessibilityValue(summary(data))
            }
        }
    }

    private func shownIndex(_ data: Data) -> Int {
        let n = data.xs.count
        if data.numeric, let x = selectedX ?? data.mark {
            return data.xs.indices.min { abs(data.xs[$0] - x) < abs(data.xs[$1] - x) } ?? n - 1
        }
        if !data.numeric, let label = selectedLabel, let i = data.labels.firstIndex(of: label) { return i }
        return n - 1
    }

    private func header(_ data: Data) -> some View {
        let i = shownIndex(data)
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                titleText
                Spacer(minLength: 8)
                values(data, i)
            }
            VStack(alignment: .leading, spacing: 4) {
                titleText
                values(data, i)
            }
        }
    }

    @ViewBuilder private var titleText: some View {
        if let title = chart.title {
            Text(liveInterpolate(title, scope: context.scope)).font(.system(.subheadline, weight: .medium)).junoInk()
        }
    }

    private func values(_ data: Data, _ i: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(chart.x?.label.map { "\($0) " } ?? "")\(data.labels[i])")
                .foregroundStyle(Color.junoSecondaryInk)
            ForEach(chart.series.indices, id: \.self) { si in
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    if chart.series.count > 1 {
                        Capsule().fill(Self.strokes[si]).frame(width: 12, height: 2).alignmentGuide(.firstTextBaseline) { $0.height + 4 }
                    }
                    if !chart.series[si].label.isEmpty {
                        Text(chart.series[si].label).foregroundStyle(Color.junoSecondaryInk)
                    }
                    Text(data.ys[si][i].map(readout) ?? liveNullText)
                        .fontWeight(.medium)
                        .junoInk()
                }
            }
        }
        .font(.subheadline)
        .monospacedDigit()
        .lineLimit(1)
    }

    private func summary(_ data: Data) -> String {
        let i = shownIndex(data)
        return chart.series.indices.map { si in
            "\(chart.series[si].label.isEmpty ? "Value" : chart.series[si].label) \(data.ys[si][i].map(readout) ?? "unknown") at \(data.labels[i])"
        }.joined(separator: ", ")
    }

    @ViewBuilder private func plot(_ data: Data) -> some View {
        #if canImport(Charts)
        let points: [Point] = data.ys.enumerated().flatMap { si, ys in
            ys.enumerated().compactMap { i, y in
                y.map { Point(id: si * 1000 + i, index: i, x: data.xs[i], label: data.labels[i], series: si, y: $0) }
            }
        }
        let bar = chart.kind == .bar || !data.numeric
        let markX = data.numeric && !bar ? data.mark.flatMap { m in (data.xs.first.map { m >= min($0, data.xs.last!) } ?? false) && m <= max(data.xs.first!, data.xs.last!) ? m : nil } : nil
        let base = Chart {
            ForEach(points) { p in
                if bar {
                    BarMark(x: .value("x", p.label), y: .value("y", p.y))
                        .foregroundStyle(Self.strokes[p.series].opacity(p.series == 0 ? 0.85 : 1))
                        .position(by: .value("series", p.series))
                        .cornerRadius(3)
                } else {
                    if chart.kind == .area && p.series == 0 {
                        AreaMark(x: .value("x", p.x), y: .value("y", p.y), series: .value("area", "base"), stacking: .unstacked)
                            .foregroundStyle(Color.junoAccent.opacity(0.08))
                        if let markX, p.x <= markX {
                            AreaMark(x: .value("x", p.x), y: .value("y", p.y), series: .value("area", "marked"), stacking: .unstacked)
                                .foregroundStyle(Color.junoAccent.opacity(0.2))
                        }
                    }
                    LineMark(x: .value("x", p.x), y: .value("y", p.y), series: .value("series", p.series))
                        .foregroundStyle(Self.strokes[p.series])
                        .lineStyle(StrokeStyle(lineWidth: p.series == 0 ? 2 : 1.5, lineCap: .round, lineJoin: .round, dash: Self.dashes[p.series]))
                        .interpolationMethod(.monotone)
                }
            }
            if let markX {
                RuleMark(x: .value("mark", markX))
                    .foregroundStyle(Color.junoForeground.opacity(0.55))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
            if !bar, let x = selectedX {
                RuleMark(x: .value("selected", x))
                    .foregroundStyle(Color.junoForeground.opacity(0.25))
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine().foregroundStyle(Color.junoHairline)
                AxisValueLabel {
                    if let v = value.as(Double.self) { Text(axisLabel(v)).font(.caption).monospacedDigit() }
                }
            }
        }
        .chartLegend(.hidden)
        if bar {
            base.chartXSelection(value: $selectedLabel)
        } else {
            base
                .chartXScale(domain: (data.xs.first ?? 0)...(data.xs.last ?? 1))
                .chartXSelection(value: $selectedX)
        }
        #else
        EmptyView()
        #endif
    }

    private func axisLabel(_ v: Double) -> String {
        let format = chart.format ?? .number
        let f = context.scope.formatter
        if format == .percent { return f.number(v, format: .percent, currency: nil, digits: 0) }
        if format == .currency, abs(v) < 10_000 { return f.number(v, format: .currency, currency: context.currency, digits: 0) }
        return f.number(v, format: abs(v) >= 10_000 ? .compact : .number, currency: context.currency, digits: nil)
    }
}

// MARK: Explorer

private struct HotspotPosition: LayoutValueKey {
    static let defaultValue = CGPoint(x: 0.5, y: 0.5)
}

/// Places each subview centred on its fractional position.
private struct HotspotLayout: Layout {
    /// The fraction of the 2:1 field the parts actually use, top to bottom.
    var span: Double = 1

    /// 2:1 (cropped to `span`) and at most 560pt wide, whatever height is offered.
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let w = min(proposal.width ?? 480, 560)
        return CGSize(width: w, height: w / 2 * span)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for s in subviews {
            let p = s[HotspotPosition.self]
            s.place(
                at: CGPoint(x: bounds.minX + p.x * bounds.width, y: bounds.minY + p.y * bounds.height),
                anchor: .center,
                proposal: .unspecified
            )
        }
    }
}

/// The bike-diagram case: parts on a schematic (or a list), each one a real
/// button, and the selected part's detail on a Liquid Glass card.
struct LiveExplorerView: View {
    let explorer: LiveExplorerSpec
    @State private var selected: String?

    private var part: LiveExplorerPart { explorer.parts.first { $0.id == selected } ?? explorer.parts[0] }
    private var placed: Bool { explorer.parts.allSatisfy { $0.at != nil } }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let title = explorer.title {
                Text(title).font(.system(.subheadline, weight: .medium)).junoInk()
            }
            if placed {
                schematic
                detail
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 20) {
                        list.frame(width: 200)
                        detail
                    }
                    VStack(alignment: .leading, spacing: 16) {
                        list
                        detail
                    }
                }
            }
        }
    }

    private var schematic: some View {
        let byID = Dictionary(explorer.parts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // Crop the field to the band the parts occupy (the web does the same),
        // so a schematic drawn in the top two-thirds leaves no empty band.
        let ys = explorer.parts.compactMap { $0.at?.y }
        let lo = max(0, (ys.min() ?? 0) - 10), hi = min(100, (ys.max() ?? 100) + 14)
        let span = max(0.2, (hi - lo) / 100)
        let fy = { (y: Double) in (y - lo) / (hi - lo) }
        return HotspotLayout(span: span) {
            ForEach(explorer.parts) { p in
                hotspot(p).layoutValue(key: HotspotPosition.self, value: CGPoint(x: (p.at?.x ?? 50) / 100, y: fy(p.at?.y ?? 50)))
            }
        }
        .background {
            Canvas { ctx, size in
                for (a, b) in explorer.links {
                    guard let pa = byID[a]?.at, let pb = byID[b]?.at else { continue }
                    var path = Path()
                    path.move(to: CGPoint(x: pa.x / 100 * size.width, y: fy(pa.y) * size.height))
                    path.addLine(to: CGPoint(x: pb.x / 100 * size.width, y: fy(pb.y) * size.height))
                    let lit = a == part.id || b == part.id
                    ctx.stroke(path, with: .color(Color.junoForeground.opacity(lit ? 0.55 : 0.18)), lineWidth: lit ? 1.5 : 1)
                }
            }
            .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private func hotspot(_ p: LiveExplorerPart) -> some View {
        let on = p.id == part.id
        let below = (p.at?.y ?? 50) < 78
        let dot = Circle()
            .strokeBorder(on ? Color.junoForeground : Color.junoForeground.opacity(0.45), lineWidth: 1.5)
            .background(Circle().fill(on ? Color.junoForeground : Color.junoCanvas))
            .frame(width: 13, height: 13)
            .scaleEffect(on ? 1.1 : 1)
        let label = Text(p.label)
            .font(.system(.caption, weight: on ? .medium : .regular))
            .foregroundStyle(on ? Color.junoForeground : Color.junoSecondaryInk)
            .padding(.horizontal, 3)
            .background(Color.junoCanvas.opacity(0.85), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        return Button {
            withAnimation(JunoMotion.fast) { selected = p.id }
        } label: {
            VStack(spacing: 3) {
                if below { dot; label } else { label; dot }
            }
            .padding(4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(p.label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(explorer.parts) { p in
                let on = p.id == part.id
                Button {
                    withAnimation(JunoMotion.fast) { selected = p.id }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.label).font(.system(.subheadline, weight: on ? .medium : .regular)).junoInk()
                        if let s = p.summary {
                            Text(s).font(.caption).foregroundStyle(Color.junoSecondaryInk).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(on ? Color.junoForeground.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(part.label).font(.system(.body, weight: .medium)).junoInk()
            if let s = part.summary, s != part.detail {
                Text(s).font(.subheadline).foregroundStyle(Color.junoSecondaryInk)
            }
            if !part.detail.isEmpty {
                Text(part.detail).font(.subheadline).junoInk().lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            }
            if !part.facts.isEmpty {
                Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 6) {
                    ForEach(part.facts.indices, id: \.self) { i in
                        GridRow {
                            Text(part.facts[i].label).foregroundStyle(Color.junoSecondaryInk)
                            Text(part.facts[i].value).monospacedDigit().junoInk()
                        }
                    }
                }
                .font(.subheadline)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .id(part.id)
        .transition(.opacity)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Stops

/// An ordered route. The only URLs a view opens are Apple Maps and Google
/// Maps, built here from the stop's own text — never a URL the model wrote.
struct LiveStopsView: View {
    let stops: LiveStopsSpec

    static func appleMaps(_ query: String) -> URL? {
        var c = URLComponents(string: "https://maps.apple.com/")
        c?.queryItems = [URLQueryItem(name: "q", value: query)]
        return c?.url
    }

    static func googleRoute(_ queries: [String]) -> URL? {
        guard queries.count >= 2, queries.count <= 10 else { return nil }
        var c = URLComponents(string: "https://www.google.com/maps/dir/")
        var items = [
            URLQueryItem(name: "api", value: "1"),
            URLQueryItem(name: "origin", value: queries[0]),
            URLQueryItem(name: "destination", value: queries[queries.count - 1]),
        ]
        if queries.count > 2 { items.append(URLQueryItem(name: "waypoints", value: queries.dropFirst().dropLast().joined(separator: "|"))) }
        c?.queryItems = items
        return c?.url
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title = stops.title {
                Text(title).font(.system(.subheadline, weight: .medium)).junoInk()
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(stops.stops.indices, id: \.self) { i in
                    let stop = stops.stops[i]
                    let last = i == stops.stops.count - 1
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(i + 1)")
                            .font(.system(.caption, weight: .medium))
                            .monospacedDigit()
                            .junoInk()
                            .frame(width: 26, height: 26)
                            .background(Circle().fill(Color.junoCanvas))
                            .overlay(Circle().strokeBorder(Color.junoForeground.opacity(0.2), lineWidth: 1))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(stop.name).font(.system(.subheadline, weight: .medium)).junoInk()
                            if let note = stop.note {
                                Text(note).font(.subheadline).foregroundStyle(Color.junoSecondaryInk).fixedSize(horizontal: false, vertical: true)
                            }
                            if let url = Self.appleMaps(stop.query) {
                                Link(destination: url) {
                                    Label { Text("Open in Maps") } icon: { JunoIconView(.externalLink, size: 11) }
                                        .labelStyle(.titleAndIcon)
                                        .font(.caption)
                                }
                                .foregroundStyle(Color.junoSecondaryInk)
                            }
                        }
                        .padding(.bottom, last ? 0 : 16)
                        Spacer(minLength: 8)
                        if let time = stop.time {
                            Text(time).font(.subheadline).monospacedDigit().foregroundStyle(Color.junoSecondaryInk).padding(.top, 3)
                        }
                    }
                    .background(alignment: .topLeading) {
                        if !last {
                            Rectangle().fill(Color.junoBorder).frame(width: 1).padding(.top, 26).offset(x: 12.5)
                        }
                    }
                }
            }
            if let route = Self.googleRoute(stops.stops.map(\.query)) {
                Link(destination: route) {
                    Label { Text("Open the whole route") } icon: { JunoIconView(.externalLink, size: 13) }.font(.subheadline)
                }
                .foregroundStyle(Color.junoForeground)
            }
        }
    }
}

// MARK: Checklist

struct LiveChecklistView: View {
    let checklist: LiveChecklistSpec
    let checked: Set<Int>
    let toggle: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(checklist.title ?? "Checklist").font(.system(.subheadline, weight: .medium)).junoInk()
                Spacer()
                Text("\(checklist.items.indices.filter { checked.contains($0) }.count) of \(checklist.items.count) done")
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .contentTransition(.numericText())
            }
            ForEach(checklist.items.indices, id: \.self) { i in
                let on = checked.contains(i)
                Button {
                    withAnimation(JunoMotion.fast) { toggle(i) }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        JunoIconView(on ? .squareCheck : .square, size: 16)
                            .foregroundStyle(on ? Color.junoForeground : Color.junoForeground.opacity(0.4))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(checklist.items[i].label)
                                .font(.subheadline)
                                .strikethrough(on, color: Color.junoForeground.opacity(0.3))
                                .foregroundStyle(on ? Color.junoSecondaryInk : Color.junoForeground)
                            if let note = checklist.items[i].note {
                                Text(note).font(.caption).foregroundStyle(Color.junoSecondaryInk)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }
}
