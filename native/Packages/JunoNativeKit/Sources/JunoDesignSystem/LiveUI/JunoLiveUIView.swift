import SwiftUI

#if canImport(Charts)
import Charts
#endif
#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

// MARK: Host

/// What a Live UI view needs from the transcript around it: the message it
/// belongs to (adjusted values persist per message) and the send path a prompt
/// button uses — the same one the follow-up strip under a reply uses. The Mac
/// `MessageRow` and the iOS transcript set it; without it a prompt button is
/// shown disabled rather than doing nothing.
public struct JunoLiveUIHost: Sendable {
    public var messageID: String?
    public var onPrompt: (@MainActor @Sendable (String) -> Void)?
    /// Sends a message straight away — an exercise's "Send answer", which
    /// posts the answer as the reader's next turn. Where it is not set (the Mac,
    /// whose `onPrompt` already sends) the exercise uses `onPrompt`.
    public var onSend: (@MainActor @Sendable (String) -> Void)?

    public init(
        messageID: String? = nil,
        onPrompt: (@MainActor @Sendable (String) -> Void)? = nil,
        onSend: (@MainActor @Sendable (String) -> Void)? = nil
    ) {
        self.messageID = messageID
        self.onPrompt = onPrompt
        self.onSend = onSend
    }
}

private struct JunoLiveUIHostKey: EnvironmentKey {
    static let defaultValue = JunoLiveUIHost()
}

public extension EnvironmentValues {
    var junoLiveUIHost: JunoLiveUIHost {
        get { self[JunoLiveUIHostKey.self] }
        set { self[JunoLiveUIHostKey.self] = newValue }
    }
}

// MARK: The view

/// Live UI — an interactive view inside an answer (docs/design/LIVE_UI.md),
/// drawn from a ```live-ui fence by ``JunoMarkdownText``.
///
/// Native controls throughout (Slider, Stepper, TextField with number formats,
/// Picker, Toggle, DatePicker) and Swift Charts for charts, set into the reply
/// as the web sets it: a figure between two hairlines, no card, two weights,
/// the accent on the slider tint and the first chart series only. The one
/// container with material is the explorer's detail card, which takes real
/// Liquid Glass.
public struct JunoLiveUIView: View {
    private let source: String
    private let streaming: Bool

    @State private var memo = LiveUIMemo()
    @State private var touched: [String: LiveValue] = [:]
    @State private var checks: [String: Set<Int>] = [:]
    @State private var loadedKey: String?
    @Environment(\.junoLiveUIHost) private var host
    @Environment(\.locale) private var locale

    public init(source: String, streaming: Bool) {
        self.source = source
        self.streaming = streaming
    }

    public var body: some View {
        let parsed = memo.parse(source)
        if let spec = parsed.spec ?? (streaming ? memo.lastGood : nil) {
            content(spec)
        } else {
            LiveUIFallback(source: source, error: parsed.error)
        }
    }

    private func content(_ spec: LiveSpec) -> some View {
        let finished = !(spec.streaming && streaming)
        let defaults = spec.defaults
        let values = defaults.merging(touched) { _, new in new }
        let scope = LiveScope(
            inputs: values,
            lets: spec.lets,
            data: spec.data,
            formatter: LivePlatformFormatter(locale: locale),
            currency: spec.currency
        )
        let dirty = touched.contains { defaults[$0.key] != nil && defaults[$0.key] != $0.value } || checks.values.contains { !$0.isEmpty }
        let key = finished ? LiveSpecParser.storageKey(messageID: host.messageID, source: source) : nil
        let context = LiveUIContext(
            scope: scope,
            spec: spec,
            values: values,
            checks: checks,
            setValue: { id, value in touched[id] = value },
            toggleCheck: { id, index in
                var set = checks[id] ?? []
                if set.contains(index) { set.remove(index) } else { set.insert(index) }
                checks[id] = set
            },
            onPrompt: host.onPrompt,
            onSend: host.onSend ?? host.onPrompt
        )

        return VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)
            VStack(alignment: .leading, spacing: 22) {
                if spec.title != nil || spec.streaming || streaming || dirty {
                HStack(alignment: .center, spacing: 12) {
                    if let title = spec.title {
                        Text(title)
                            .font(.system(.body, weight: .medium))
                            .junoInk()
                            .accessibilityAddTraits(.isHeader)
                    } else if spec.streaming || streaming {
                        JunoSkeleton(height: 14, width: 160)
                    }
                    Spacer(minLength: 0)
                    if dirty {
                        Button {
                            touched = [:]
                            checks = [:]
                        } label: {
                            HStack(spacing: 6) {
                                JunoIconView(.rotateCcw, size: 13)
                                Text("Reset")
                            }
                            .font(.subheadline)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .transition(.opacity)
                    }
                }
                }
                if spec.ui.isEmpty && (spec.streaming || streaming) {
                    VStack(alignment: .leading, spacing: 10) {
                        JunoSkeleton(height: 12, width: 140)
                        JunoSkeleton(height: 32)
                    }
                }
                ForEach(spec.ui) { component in
                    LiveNodeView(component: component, context: context)
                }
            }
            .padding(.vertical, 20)
            Rectangle().fill(Color.junoHairline).frame(height: 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(JunoMotion.fast, value: dirty)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(spec.title ?? "Interactive view")
        .task(id: key) { restore(spec: spec, key: key) }
        .onChange(of: touched) { persist(key: key, defaults: defaults) }
        .onChange(of: checks) { persist(key: key, defaults: defaults) }
    }

    // MARK: Persistence (UserDefaults, per message and block)

    private func restore(spec: LiveSpec, key: String?) {
        guard let key, loadedKey != key else { return }
        loadedKey = key
        guard let stored = UserDefaults.standard.dictionary(forKey: key) else { return }
        let inputs = Dictionary(spec.inputs.map { ($0.id, $0.value) }, uniquingKeysWith: { a, _ in a })
        var restored: [String: LiveValue] = [:]
        for (id, raw) in stored["v"] as? [String: Any] ?? [:] {
            guard let def = inputs[id] else { continue }
            switch (def, raw) {
            case (.bool, let b as Bool): restored[id] = .bool(b)
            case (.number, let n as NSNumber): restored[id] = .number(n.doubleValue)
            case (.string, let s as String): restored[id] = .string(s)
            default: break
            }
        }
        var restoredChecks: [String: Set<Int>] = [:]
        for (id, raw) in stored["c"] as? [String: [Int]] ?? [:] { restoredChecks[id] = Set(raw.prefix(40)) }
        touched = restored.merging(touched) { _, new in new }
        checks = restoredChecks.merging(checks) { _, new in new }
    }

    private func persist(key: String?, defaults: [String: LiveValue]) {
        guard let key, loadedKey == key else { return }
        var v: [String: Any] = [:]
        for (id, value) in touched where defaults[id] != value {
            switch value {
            case .bool(let b): v[id] = b
            case .number(let n): v[id] = n
            case .string(let s): v[id] = s
            default: break
            }
        }
        let c = checks.filter { !$0.value.isEmpty }.mapValues { Array($0).sorted() }
        if v.isEmpty && c.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else {
            UserDefaults.standard.set(["v": v, "c": c], forKey: key)
        }
    }
}

/// Parse cache, and the last good parse while a stream briefly does not.
@MainActor
final class LiveUIMemo {
    private var source: String?
    private var result: (spec: LiveSpec?, error: String?) = (nil, nil)
    private(set) var lastGood: LiveSpec?

    func parse(_ text: String) -> (spec: LiveSpec?, error: String?) {
        if text != source {
            source = text
            result = LiveSpecParser.parse(text)
            if let spec = result.spec { lastGood = spec }
        }
        return result
    }
}

struct LiveUIContext {
    let scope: LiveScope
    let spec: LiveSpec
    let values: [String: LiveValue]
    let checks: [String: Set<Int>]
    let setValue: (String, LiveValue) -> Void
    let toggleCheck: (String, Int) -> Void
    let onPrompt: (@MainActor @Sendable (String) -> Void)?
    var onSend: (@MainActor @Sendable (String) -> Void)? = nil

    var currency: String { spec.currency }

    func format(_ value: Double, _ format: LiveFormat?, unit: String?, mode: Mode = .cell) -> String {
        let whole = format == .currency && ((mode == .input && value == value.rounded()) || (mode != .cell && abs(value) >= 10_000))
        let text = scope.formatter.number(value, format: format ?? .number, currency: currency, digits: whole ? 0 : nil)
        return unit.map { "\(text) \($0)" } ?? text
    }

    enum Mode { case input, metric, cell }

    func text(_ value: LiveValue, _ format: LiveFormat?, unit: String?, mode: Mode = .cell) -> String {
        switch value {
        case .number(let n): self.format(n, format, unit: unit, mode: mode)
        case .null: liveNullText
        case .list(let l) where l.isEmpty: liveNullText
        default: liveValueString(value)
        }
    }
}

// MARK: Nodes

struct LiveNodeView: View {
    let component: LiveComponent
    let context: LiveUIContext

    var body: some View {
        switch component {
        case .pending:
            JunoSkeleton(height: 32)
                .accessibilityHidden(true)
        case .layout(let layout):
            LiveLayoutView(layout: layout, context: context)
        case .input(let input):
            LiveInputView(input: input, context: context)
        case .metric(let metric):
            LiveMetricView(metric: metric, context: context)
        case .text(let block):
            LiveTextView(text: liveInterpolate(block.text, scope: context.scope), tone: block.tone)
        case .progress(let progress):
            LiveProgressView(progress: progress, context: context)
        case .chart(let chart):
            LiveChartView(chart: chart, context: context)
        case .table(let table):
            LiveTableView(table: table, context: context)
        case .explorer(let explorer):
            LiveExplorerView(explorer: explorer)
        case .stops(let stops):
            LiveStopsView(stops: stops)
        case .checklist(let checklist):
            LiveChecklistView(checklist: checklist, checked: context.checks[checklist.id] ?? []) {
                context.toggleCheck(checklist.id, $0)
            }
        case .button(let button):
            LiveButtonView(button: button, context: context)
        case .exercise(let exercise):
            LiveExerciseView(exercise: exercise, context: context)
        case .steps(let steps):
            LiveStepsView(steps: steps, context: context)
        case .quiz(let quiz):
            LiveQuizView(quiz: quiz, context: context)
        case .callout(let callout):
            LiveCalloutView(callout: callout, context: context)
        case .timeline(let timeline):
            LiveTimelineView(timeline: timeline, context: context)
        }
    }
}

struct LiveLayoutView: View {
    let layout: LiveLayout
    let context: LiveUIContext

    var body: some View {
        switch layout.kind {
        case .row:
            if !layout.pending, layout.children.allSatisfy({ if case .button = $0 { true } else { false } }) {
                LiveColumns(maxColumns: layout.children.count, minColumnWidth: 120, hugging: true) { children }
            } else {
                LiveColumns(maxColumns: max(1, layout.children.count), minColumnWidth: 180) { children }
            }
        case .grid:
            LiveColumns(maxColumns: layout.columns, minColumnWidth: 180) { children }
        case .section:
            VStack(alignment: .leading, spacing: 16) {
                Rectangle().fill(Color.junoHairline).frame(height: 1)
                if let title = layout.title {
                    Text(liveInterpolate(title, scope: context.scope))
                        .font(.system(.subheadline, weight: .medium))
                        .junoInk()
                }
                ForEach(layout.children) { LiveNodeView(component: $0, context: context) }
            }
        }
    }

    @ViewBuilder private var children: some View {
        ForEach(layout.children) { child in
            AnyView(LiveNodeView(component: child, context: context))
        }
    }
}

/// Equal columns that fall back to one column when each would be narrower
/// than `minColumnWidth` — the web's `@container` row, without a GeometryReader.
/// `hugging` lays children at their own width, wrapping (a row of buttons).
struct LiveColumns: Layout {
    var maxColumns: Int
    var minColumnWidth: CGFloat
    var hugging = false
    var spacing: CGFloat = 24
    var rowSpacing: CGFloat = 20

    private func columns(for width: CGFloat) -> Int {
        guard width.isFinite, width > 0 else { return 1 }
        return max(1, min(maxColumns, Int((width + spacing) / (minColumnWidth + spacing))))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 560
        return CGSize(width: width, height: arrange(width: width, subviews: subviews).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = arrange(width: bounds.width, subviews: subviews).frames
        for (index, subview) in subviews.enumerated() {
            let f = frames[index]
            subview.place(at: CGPoint(x: bounds.minX + f.minX, y: bounds.minY + f.minY), proposal: ProposedViewSize(width: f.width, height: f.height))
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (frames: [CGRect], height: CGFloat) {
        var frames: [CGRect] = []
        if hugging {
            let gap: CGFloat = 8
            var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0
            for s in subviews {
                let size = s.sizeThatFits(.unspecified)
                let w = min(size.width, width)
                if x > 0, x + w > width { x = 0; y += line + gap; line = 0 }
                frames.append(CGRect(x: x, y: y, width: w, height: size.height))
                x += w + gap
                line = max(line, size.height)
            }
            return (frames, y + line)
        }
        let cols = columns(for: width)
        let colWidth = (width - spacing * CGFloat(cols - 1)) / CGFloat(cols)
        var y: CGFloat = 0
        var index = 0
        while index < subviews.count {
            let rowItems = subviews[index..<min(index + cols, subviews.count)]
            let heights = rowItems.map { $0.sizeThatFits(ProposedViewSize(width: colWidth, height: nil)).height }
            let rowHeight = heights.max() ?? 0
            for (offset, h) in heights.enumerated() {
                frames.append(CGRect(x: CGFloat(offset) * (colWidth + spacing), y: y, width: colWidth, height: h))
            }
            y += rowHeight + rowSpacing
            index += cols
        }
        return (frames, max(0, y - rowSpacing))
    }
}

// MARK: Inputs

private struct FieldHead: View {
    let label: String
    var value: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
            Spacer(minLength: 0)
            if let value {
                Text(value)
                    .font(.system(.subheadline, weight: .medium))
                    .monospacedDigit()
                    .junoInk()
                    .contentTransition(.numericText())
            }
        }
    }
}

struct LiveInputView: View {
    let input: LiveInput
    let context: LiveUIContext

    private var current: LiveValue { context.values[input.id] ?? input.value }
    private var number: Double { current.number ?? input.value.number ?? 0 }

    var body: some View {
        switch input.kind {
        case .slider:
            let lo = input.min ?? 0, hi = input.max ?? 100, step = input.step ?? (hi - lo) / 100
            VStack(alignment: .leading, spacing: 8) {
                FieldHead(label: input.label, value: context.format(number, input.format, unit: input.unit, mode: .input))
                Slider(
                    value: Binding(
                        get: { number },
                        set: { context.setValue(input.id, .number(LiveSpecParser.snap($0, min: lo, max: hi, step: step))) }
                    ),
                    in: lo...hi
                )
                .tint(Color.junoAccent)
                .accessibilityLabel(input.label)
                .accessibilityValue(context.format(number, input.format, unit: input.unit, mode: .input))
            }
        case .stepper:
            let lo = input.min ?? 0, hi = input.max ?? 100, step = input.step ?? 1
            VStack(alignment: .leading, spacing: 8) {
                FieldHead(label: input.label)
                HStack(spacing: 12) {
                    Text(context.format(number, .number, unit: input.unit))
                        .font(.system(.body, weight: .medium))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .frame(minWidth: 28, alignment: .leading)
                    Stepper(
                        input.label,
                        value: Binding(
                            get: { number },
                            set: { context.setValue(input.id, .number(LiveSpecParser.snap($0, min: lo, max: hi, step: step))) }
                        ),
                        in: lo...hi,
                        step: step
                    )
                    .labelsHidden()
                }
            }
        case .number:
            LiveNumberField(input: input, value: number, currency: context.currency) { context.setValue(input.id, .number($0)) }
        case .select:
            let index = input.options.firstIndex { $0.value == current } ?? 0
            let binding = Binding<Int>(
                get: { index },
                set: { if input.options.indices.contains($0) { context.setValue(input.id, input.options[$0].value) } }
            )
            VStack(alignment: .leading, spacing: 8) {
                FieldHead(label: input.label)
                if input.segmented {
                    Picker(input.label, selection: binding) {
                        ForEach(input.options.indices, id: \.self) { Text(input.options[$0].label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                } else {
                    Picker(input.label, selection: binding) {
                        ForEach(input.options.indices, id: \.self) { Text(input.options[$0].label).tag($0) }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .fixedSize()
                }
            }
        case .toggle:
            Toggle(
                input.label,
                isOn: Binding(get: { current == .bool(true) }, set: { context.setValue(input.id, .bool($0)) })
            )
            .toggleStyle(.switch)
            .tint(Color.junoAccent)
            .font(.subheadline)
        case .date:
            VStack(alignment: .leading, spacing: 8) {
                FieldHead(label: input.label)
                DatePicker(
                    input.label,
                    selection: Binding(
                        get: { LiveUIDate.date(from: current.string ?? "") ?? Date() },
                        set: { context.setValue(input.id, .string(LiveUIDate.iso(from: $0))) }
                    ),
                    displayedComponents: .date
                )
                .labelsHidden()
                .fixedSize()
            }
        case .input:
            VStack(alignment: .leading, spacing: 8) {
                FieldHead(label: input.label)
                TextField(
                    input.placeholder ?? input.label,
                    text: Binding(get: { current.string ?? "" }, set: { context.setValue(input.id, .string(String($0.prefix(200)))) })
                )
                .textFieldStyle(.roundedBorder)
            }
        }
    }
}

enum LiveUIDate {
    static var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC") ?? .current
        return c
    }

    static func date(from iso: String) -> Date? {
        guard let p = LiveDates.parse(iso) else { return nil }
        return utc.date(from: DateComponents(year: p.year, month: p.month, day: p.day))
    }

    static func iso(from date: Date) -> String {
        let c = utc.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 2026, c.month ?? 1, c.day ?? 1)
    }
}

/// A typed number. Currency and percent use Foundation's own formats, so the
/// reader types "12" in a percent field and the view stores 0.12.
struct LiveNumberField: View {
    let input: LiveInput
    let value: Double
    let currency: String
    let commit: (Double) -> Void

    private var binding: Binding<Double> {
        Binding(
            get: { value },
            set: { new in
                var v = new
                if let lo = input.min { v = max(lo, v) }
                if let hi = input.max { v = min(hi, v) }
                commit(v)
            }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            FieldHead(label: input.label)
            HStack(spacing: 6) {
                field
                    .textFieldStyle(.roundedBorder)
                    .monospacedDigit()
                    .frame(maxWidth: 200)
                    #if os(iOS)
                    .keyboardType(.decimalPad)
                    #endif
                if let unit = input.unit, input.format != .percent {
                    Text(unit).foregroundStyle(Color.junoSecondaryInk)
                }
            }
        }
    }

    @ViewBuilder private var field: some View {
        switch input.format {
        case .currency:
            TextField(input.label, value: binding, format: .currency(code: currency).precision(.fractionLength(0...2)))
        case .percent:
            TextField(input.label, value: binding, format: .percent.precision(.fractionLength(0...2)))
        default:
            TextField(input.label, value: binding, format: .number.precision(.fractionLength(0...6)))
        }
    }
}

// MARK: Outputs

struct LiveMetricView: View {
    let metric: LiveMetric
    let context: LiveUIContext

    var body: some View {
        let value = context.scope.evaluate(metric.value).value
        VStack(alignment: .leading, spacing: 4) {
            if !metric.label.isEmpty {
                Text(liveInterpolate(metric.label, scope: context.scope))
                    .font(.subheadline)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Text(context.text(value, metric.format, unit: metric.unit, mode: .metric))
                .junoFont(size: metric.emphasis ? 34 : 22, relativeTo: metric.emphasis ? .largeTitle : .title2, weight: .medium)
                .monospacedDigit()
                .junoInk()
                .contentTransition(.numericText())
                .lineLimit(2)
                .minimumScaleFactor(0.7)
            if let hint = metric.hint {
                Text(liveInterpolate(hint, scope: context.scope))
                    .font(.subheadline)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct LiveTextView: View {
    let text: String
    let tone: LiveTextBlock.Tone

    var body: some View {
        let attributed = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        Text(attributed)
            .font(tone == .heading ? .system(.body, weight: .medium) : .subheadline)
            .foregroundStyle(tone == .muted ? Color.junoSecondaryInk : Color.junoForeground)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct LiveProgressView: View {
    let progress: LiveProgress
    let context: LiveUIContext

    var body: some View {
        let v = context.scope.evaluate(progress.value).value.number
        let m = context.scope.evaluate(progress.max).value.number
        let ratio = (v != nil && m != nil && m! > 0) ? min(1, max(0, v! / m!)) : 0
        VStack(alignment: .leading, spacing: 8) {
            FieldHead(
                label: liveInterpolate(progress.label, scope: context.scope),
                value: v.map { context.format($0, progress.format, unit: nil) } ?? liveNullText
            )
            Capsule()
                .fill(Color.junoForeground.opacity(0.08))
                .frame(height: 4)
                .overlay(alignment: .leading) {
                    Capsule().fill(Color.junoForeground.opacity(0.7)).scaleEffect(x: ratio, anchor: .leading)
                }
                .animation(JunoMotion.base, value: ratio)
        }
        .accessibilityElement(children: .combine)
    }
}

struct LiveTableView: View {
    let table: LiveTableSpec
    let context: LiveUIContext

    var body: some View {
        let rows = context.scope.evaluate(table.rows).value.list ?? []
        let shown = Array(rows.prefix(100))
        let cells: [[LiveValue]] = shown.enumerated().map { index, row in
            var locals: [String: LiveValue] = ["row": row, "index": .number(Double(index))]
            if case .object(let fields) = row { locals.merge(fields) { a, _ in a } } else { locals["value"] = row }
            return table.columns.map { context.scope.evaluate($0.value, locals: locals).value }
        }
        let numeric = table.columns.indices.map { ci in cells.allSatisfy { r in r[ci].number != nil || r[ci] == .null } }
        if shown.isEmpty {
            Text("No rows.").font(.subheadline).foregroundStyle(Color.junoSecondaryInk)
        } else {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 0) {
                GridRow {
                    ForEach(table.columns.indices, id: \.self) { ci in
                        Text(table.columns[ci].label)
                            .font(.system(.subheadline, weight: table.highlight == ci ? .medium : .regular))
                            .foregroundStyle(table.highlight == ci ? Color.junoForeground : Color.junoSecondaryInk)
                            .gridColumnAlignment(numeric[ci] ? .trailing : .leading)
                            .padding(.bottom, 8)
                    }
                }
                Rectangle().fill(Color.junoBorder).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                ForEach(cells.indices, id: \.self) { ri in
                    GridRow {
                        ForEach(table.columns.indices, id: \.self) { ci in
                            let lead = table.rowHeader && ci == 0
                            Text(context.text(cells[ri][ci], table.columns[ci].format, unit: table.columns[ci].unit))
                                // The first column takes the slack, so the table spans the reply;
                                // a comparison spreads its columns instead.
                                .frame(maxWidth: (ci == 0 && !table.rowHeader) || (table.rowHeader && ci > 0) ? .infinity : nil, alignment: .leading)
                                .font(.system(.subheadline, weight: lead ? .medium : .regular))
                                .monospacedDigit()
                                .foregroundStyle(lead || table.highlight == ci || !table.rowHeader ? Color.junoForeground : Color.junoForeground.opacity(0.85))
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.vertical, 8)
                                .background(table.highlight == ci ? Color.junoForeground.opacity(0.035) : .clear)
                                .accessibilityAddTraits(lead ? .isHeader : [])
                        }
                    }
                    if ri < cells.count - 1 {
                        Rectangle().fill(Color.junoHairline).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                    }
                }
            }
        }
    }
}

struct LiveButtonView: View {
    let button: LiveButtonSpec
    let context: LiveUIContext
    @State private var copied = false

    var body: some View {
        let prompt = button.prompt.map { liveInterpolate($0, scope: context.scope) }
        Button {
            if let prompt {
                context.onPrompt?(prompt)
                return
            }
            let value = context.scope.evaluate(button.copy ?? "").value
            LiveUIPasteboard.copy(liveValueString(value))
            copied = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1.6))
                copied = false
            }
        } label: {
            HStack(spacing: 6) {
                Text(copied ? "Copied" : button.label)
                JunoIconView(prompt != nil ? .externalLink : (copied ? .check : .copy), size: 13)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .font(.subheadline)
        }
        .buttonStyle(.bordered)
        .disabled(prompt != nil && context.onPrompt == nil)
        .help(prompt ?? button.label)
    }
}

enum LiveUIPasteboard {
    @MainActor static func copy(_ text: String) {
        #if canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #elseif canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }
}

struct LiveUIFallback: View {
    let source: String
    let error: String?
    @State private var shown = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)
            Text("This interactive view couldn't be shown\(error.map { " (\($0))" } ?? "").")
                .font(.subheadline)
                .junoInk()
            Button(shown ? "Hide its source" : "Show its source") { shown.toggle() }
                .buttonStyle(.borderless)
                .font(.subheadline)
            if shown {
                Text(source)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Rectangle().fill(Color.junoHairline).frame(height: 1)
        }
    }
}
