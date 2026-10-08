import Charts
import JunoDesignSystem
import SwiftUI

/// Who the profile is about: what the session already knows, before the
/// activity read returns the @handle.
public struct NativeProfileIdentity: Equatable, Sendable {
    public let name: String?
    /// Shown until the activity read brings the server's handle.
    public let fallbackHandle: String
    public let imageData: Data?
    public let imageURL: URL?

    public init(name: String?, fallbackHandle: String, imageData: Data? = nil, imageURL: URL? = nil) {
        self.name = name
        self.fallbackHandle = fallbackHandle
        self.imageData = imageData
        self.imageURL = imageURL
    }

    /// The email's local part, lowercased, "+tag" and anything outside
    /// [a-z0-9._-] dropped (the web's `derivedHandle`).
    public static func derivedHandle(email: String, name: String?) -> String {
        let local = email.split(separator: "@").first.map(String.init) ?? ""
        let base = local.split(separator: "+", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789._-")
        let fromEmail = String(base.lowercased().filter { allowed.contains($0) })
        if !fromEmail.isEmpty { return fromEmail }
        let folded = (name ?? "").folding(options: [.diacriticInsensitive], locale: Locale(identifier: "en_US"))
            .lowercased()
            .trimmingCharacters(in: .whitespaces)
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: ".")
        let fromName = String(folded.filter { allowed.contains($0) })
        return fromName.isEmpty ? "you" : fromName
    }
}

/// The profile (`src/components/profile/profile-view.tsx`): who you are, a
/// strip of five figures, a year of tokens three ways, and the models they
/// went to. Profiles are not public, so there is no Share; Edit goes to the
/// username in Settings › Account.
///
/// One grouped Form on both platforms. The chart is the screen's one colour:
/// a single blue ramp over a neutral well (owner's call, 2026-10-03).
public struct NativeProfileView: View {
    @Bindable private var model: NativeProfileModel
    private let identity: NativeProfileIdentity
    private let onEdit: (() -> Void)?
    private let onStartChat: (() -> Void)?

    public init(
        model: NativeProfileModel,
        identity: NativeProfileIdentity,
        onEdit: (() -> Void)? = nil,
        onStartChat: (() -> Void)? = nil
    ) {
        self.model = model
        self.identity = identity
        self.onEdit = onEdit
        self.onStartChat = onStartChat
    }

    private var handle: String { model.activity?.handle ?? identity.fallbackHandle }

    public var body: some View {
        Form {
            Section {
                header
            }
            switch model.state {
            case .loading:
                Section {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                    .padding(.vertical, JunoSpace.section)
                }
            case .failed(let message):
                Section {
                    ContentUnavailableView {
                        Label("Couldn’t load your activity", image: JunoIcon.warning.assetName)
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try Again") { Task { await model.load() } }
                    }
                }
            case .loaded(let activity):
                stats(activity)
                NativeProfileActivitySection(activity: activity, chart: $model.chart, onStartChat: onStartChat)
                models(activity)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Profile")
        .toolbar {
            if let onEdit {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit", action: onEdit)
                        .accessibilityIdentifier("juno.profile.edit")
                }
            }
        }
        .task { if model.activity == nil { await model.load() } }
        #if os(iOS)
        .refreshable { await model.load() }
        #endif
        .accessibilityIdentifier("juno.profile")
    }

    // MARK: Identity

    private var header: some View {
        VStack(spacing: JunoSpace.snug) {
            JunoAvatar(imageData: identity.imageData, imageURL: identity.imageURL, name: identity.name ?? handle, size: 88)
            Text(identity.name ?? handle)
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
                .padding(.top, JunoSpace.tight)
            Text(verbatim: "@\(handle)")
                .font(.body)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, JunoSpace.regular)
        .accessibilityElement(children: .combine)
    }

    // MARK: Figures

    private func stats(_ activity: NativeProfileActivity) -> some View {
        Section {
            figure("Lifetime tokens", NativeProfileMath.formatTokens(activity.lifetimeTokens),
                   help: "\(NativeProfileMath.formatTokensExact(activity.lifetimeTokens)) tokens")
            figure("Peak day", activity.peakDay.map { NativeProfileMath.formatTokens($0.tokens) } ?? "0",
                   help: activity.peakDay.map {
                       "\(NativeProfileMath.formatTokensExact($0.tokens)) tokens on \(NativeProfileMath.formatDayLong($0.date))"
                   })
            figure("Longest task", activity.longestTask.map { NativeProfileMath.formatDuration(ms: $0.ms) } ?? "None yet",
                   help: activity.longestTask.map { $0.kind == "work" ? "Longest finished Work task" : "Longest finished deep research" })
            figure("Longest streak", NativeProfileMath.formatDays(activity.streak.longest))
            figure("Current streak", NativeProfileMath.formatDays(activity.streak.current))
        }
    }

    private func figure(_ label: String, _ value: String, help: String? = nil) -> some View {
        LabeledContent {
            Text(value)
                .font(.body.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.primary)
        } label: {
            Text(label)
        }
        .help(help ?? "")
        .accessibilityHint(help ?? "")
    }

    // MARK: Models

    @ViewBuilder
    private func models(_ activity: NativeProfileActivity) -> some View {
        Section {
            if activity.models.isEmpty {
                Text("The models you use will be ranked here.")
                    .foregroundStyle(.secondary)
            } else {
                let top = activity.models.first?.share ?? 1
                ForEach(activity.models) { row in
                    NativeProfileModelRow(row: row, relative: top > 0 ? row.share / top : 0)
                }
            }
        } header: {
            Text("Models")
        } footer: {
            if activity.modelCount > 0 {
                Text("\(activity.modelCount) \(activity.modelCount == 1 ? "model" : "models") used, by tokens")
            }
        }
    }
}

// MARK: - Activity

/// "Token activity": the view picker, the reading of the day under the
/// pointer, the chart, and the zone the days were cut in.
struct NativeProfileActivitySection: View {
    let activity: NativeProfileActivity
    @Binding var chart: NativeProfileChartKind
    let onStartChat: (() -> Void)?

    /// A day key for daily and cumulative, a column index for weekly.
    @State private var active: String?
    @State private var width: CGFloat = 0
    @Environment(\.colorScheme) private var colorScheme

    private var weeks: [NativeProfileMath.Week] { NativeProfileMath.buildWeeks(activity.days, today: activity.today) }

    var body: some View {
        let weeks = self.weeks
        let cells = weeks.flatMap { $0 }.compactMap { $0 }
        let thresholds = NativeProfileMath.heatThresholds(cells.map(\.tokens))
        let weekly = NativeProfileMath.weeklyTotals(weeks)
        let start = NativeProfileMath.gridStart(weeks) ?? activity.today
        let cumulative = NativeProfileMath.cumulativeSeries(activity.days, start: start, today: activity.today)
        let metrics = NativeProfileGridMetrics(width: width)
        Section {
            Picker("Activity view", selection: $chart) {
                ForEach(NativeProfileChartKind.allCases) { kind in
                    Text(kind.label).tag(kind)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .onChange(of: chart) { _, _ in active = nil }

            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                Text(reading(cells: cells, weekly: weekly, cumulative: cumulative))
                    .font(.callout)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading)
                    .accessibilityHidden(true)

                ScrollView(.horizontal) {
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        HStack(alignment: .top, spacing: 0) {
                            weekdayColumn(metrics)
                            plot(weeks: weeks, thresholds: thresholds, weekly: weekly, cumulative: cumulative, metrics: metrics)
                        }
                        monthRow(weeks: weeks, metrics: metrics)
                    }
                    .padding(.vertical, JunoSpace.micro)
                }
                .defaultScrollAnchor(.trailing)
                .scrollIndicators(.hidden)
                .background {
                    Color.clear.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
                }
            }
            .padding(.vertical, JunoSpace.tight)
        } header: {
            Text("Token activity")
        } footer: {
            footer
        }
    }

    // MARK: Plot

    @ViewBuilder
    private func plot(
        weeks: [NativeProfileMath.Week],
        thresholds: (Double, Double, Double),
        weekly: [NativeProfileMath.WeekTotal],
        cumulative: [NativeProfileMath.CumulativePoint],
        metrics: NativeProfileGridMetrics
    ) -> some View {
        let ramp = NativeProfileRamp(colorScheme: colorScheme)
        switch chart {
        case .daily:
            NativeProfileDailyGrid(weeks: weeks, thresholds: thresholds, today: activity.today, ramp: ramp, metrics: metrics, active: $active)
                .accessibilityElement()
                .accessibilityLabel("Tokens per day over the last year")
                .accessibilityValue(active.map { daySentence($0, cells: weeks.flatMap { $0 }.compactMap { $0 }) } ?? "")
                .accessibilityAdjustableAction { direction in
                    step(direction == .increment ? 1 : -1, start: NativeProfileMath.gridStart(weeks) ?? activity.today)
                }
        case .weekly:
            NativeProfileWeeklyBars(weekly: weekly, ramp: ramp, metrics: metrics, active: $active)
                .accessibilityElement()
                .accessibilityLabel("Tokens per week over the last year")
                .accessibilityValue(active.flatMap(Int.init).map { weekSentence(weekly[$0]) } ?? "")
                .accessibilityAdjustableAction { direction in
                    let at = active.flatMap(Int.init) ?? (weekly.count - 1)
                    let next = min(weekly.count - 1, max(0, at + (direction == .increment ? 1 : -1)))
                    active = String(next)
                }
        case .cumulative:
            NativeProfileCumulativeLine(points: cumulative, ramp: ramp, metrics: metrics, active: $active)
                .accessibilityElement()
                .accessibilityLabel("Running total of tokens over the last year")
                .accessibilityValue(active.map { cumulativeSentence($0, points: cumulative) } ?? "")
                .accessibilityAdjustableAction { direction in
                    step(direction == .increment ? 1 : -1, start: cumulative.first?.date ?? activity.today)
                }
        }
    }

    private func step(_ delta: Int, start: String) {
        let next = NativeProfileDays.addDays(active ?? activity.today, delta)
        active = next < start ? start : next > activity.today ? activity.today : next
    }

    private func weekdayColumn(_ metrics: NativeProfileGridMetrics) -> some View {
        VStack(alignment: .leading, spacing: metrics.gap) {
            ForEach(Array(["Mon", "", "Wed", "", "Fri", "", ""].enumerated()), id: \.offset) { _, day in
                Text(day)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(height: metrics.cell, alignment: .leading)
            }
        }
        .frame(width: NativeProfileGridMetrics.weekdayWidth, alignment: .leading)
        .opacity(chart == .daily ? 1 : 0)
        .accessibilityHidden(true)
    }

    private func monthRow(weeks: [NativeProfileMath.Week], metrics: NativeProfileGridMetrics) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(NativeProfileMath.monthLabels(weeks), id: \.column) { label in
                Text(label.label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .offset(x: NativeProfileGridMetrics.weekdayWidth + CGFloat(label.column) * metrics.pitch)
            }
        }
        .frame(width: NativeProfileGridMetrics.weekdayWidth + metrics.plotWidth, height: 14, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    // MARK: Words

    private func reading(
        cells: [NativeProfileMath.Cell],
        weekly: [NativeProfileMath.WeekTotal],
        cumulative: [NativeProfileMath.CumulativePoint]
    ) -> String {
        if let active {
            switch chart {
            case .daily: return daySentence(active, cells: cells)
            case .weekly: if let i = Int(active), weekly.indices.contains(i) { return weekSentence(weekly[i]) }
            case .cumulative: return cumulativeSentence(active, points: cumulative)
            }
        }
        if activity.isEmpty { return "Nothing yet this year" }
        return "\(NativeProfileMath.formatTokens(activity.yearTokens)) tokens in the last year"
    }

    private func daySentence(_ date: String, cells: [NativeProfileMath.Cell]) -> String {
        let tokens = cells.first { $0.date == date }?.tokens ?? 0
        return "\(NativeProfileMath.formatDayLong(date)) · \(NativeProfileMath.formatTokensExact(tokens)) tokens"
    }

    private func weekSentence(_ week: NativeProfileMath.WeekTotal) -> String {
        "\(NativeProfileMath.formatDayShort(week.start)) – \(NativeProfileMath.formatDayShort(week.end)) · \(NativeProfileMath.formatTokensExact(week.tokens)) tokens"
    }

    private func cumulativeSentence(_ date: String, points: [NativeProfileMath.CumulativePoint]) -> String {
        guard let point = points.first(where: { $0.date == date }) else { return "" }
        return "\(NativeProfileMath.formatDayShort(date)) · \(NativeProfileMath.formatTokens(point.total)) total, \(NativeProfileMath.formatTokensExact(point.tokens)) that day"
    }

    @ViewBuilder
    private var footer: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.tight) {
                Text(activity.isEmpty
                    ? "Each day you chat, research or run a task fills a square."
                    : "Days in \(activity.timeZone.replacingOccurrences(of: "_", with: " ")) time")
                Spacer(minLength: JunoSpace.snug)
                if chart == .daily {
                    legend
                }
            }
            if activity.isEmpty, let onStartChat {
                Button("Start a chat", action: onStartChat)
                    .contentShape(.rect)
            }
        }
    }

    private var legend: some View {
        let ramp = NativeProfileRamp(colorScheme: colorScheme)
        return HStack(spacing: 3) {
            Text("Less").padding(.trailing, 2)
            ForEach(0..<5, id: \.self) { level in
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(ramp.level(level))
                    .frame(width: 10, height: 10)
            }
            Text("More").padding(.leading, 2)
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Geometry and colour

/// One set of columns for all three views, so a switch changes the marks and
/// nothing else moves (the web's `--pf-cell`: clamp(11px, fit, 20px)).
struct NativeProfileGridMetrics: Equatable {
    static let weekdayWidth: CGFloat = 30
    static let columns = NativeProfileMath.gridWeeks
    let gap: CGFloat = 3
    let cell: CGFloat

    init(width: CGFloat) {
        let fit = (width - Self.weekdayWidth - CGFloat(Self.columns - 1) * 3) / CGFloat(Self.columns)
        cell = min(18, max(11, fit.isFinite ? fit.rounded(.down) : 11))
    }

    var pitch: CGFloat { cell + gap }
    var plotWidth: CGFloat { CGFloat(Self.columns) * cell + CGFloat(Self.columns - 1) * gap }
    var plotHeight: CGFloat { cell * 7 + gap * 6 }

    func column(atX x: CGFloat) -> Int? {
        guard x >= 0 else { return nil }
        let c = Int(x / pitch)
        return c < Self.columns ? c : nil
    }
}

/// The one blue, light to deep, over a neutral well for quiet days.
struct NativeProfileRamp {
    let colorScheme: ColorScheme

    private static func rgb(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    func level(_ level: Int) -> Color {
        let dark = colorScheme == .dark
        switch level {
        case 1: return Self.rgb(dark ? 0x1B3366 : 0xC9DCFF)
        case 2: return Self.rgb(dark ? 0x1F55B8 : 0x7FB0FF)
        case 3: return Self.rgb(dark ? 0x3B82F6 : 0x2F7CF6)
        case 4: return Self.rgb(dark ? 0x8FBCFF : 0x1747B8)
        default: return Color.primary.opacity(dark ? 0.075 : 0.06)
        }
    }

    /// Weekly bars and the cumulative line.
    var ink: Color { Self.rgb(colorScheme == .dark ? 0x5C9BFF : 0x2F7CF6) }
    var well: Color { level(0) }
}

// MARK: - Marks

/// 53 columns of seven squares, drawn in one Canvas (371 views would be a
/// lot of rows for a list cell). Hover on the Mac, a tap on the iPhone.
struct NativeProfileDailyGrid: View {
    let weeks: [NativeProfileMath.Week]
    let thresholds: (Double, Double, Double)
    let today: String
    let ramp: NativeProfileRamp
    let metrics: NativeProfileGridMetrics
    @Binding var active: String?

    var body: some View {
        Canvas { context, _ in
            for (c, column) in weeks.enumerated() {
                for (r, cell) in column.enumerated() {
                    guard let cell else { continue }
                    let rect = CGRect(x: CGFloat(c) * metrics.pitch, y: CGFloat(r) * metrics.pitch, width: metrics.cell, height: metrics.cell)
                    let path = Path(roundedRect: rect, cornerRadius: 2.5, style: .continuous)
                    context.fill(path, with: .color(ramp.level(NativeProfileMath.heatLevel(cell.tokens, thresholds))))
                    if cell.date == active {
                        context.stroke(Path(roundedRect: rect.insetBy(dx: -1.5, dy: -1.5), cornerRadius: 3.5, style: .continuous), with: .color(.primary), lineWidth: 1.5)
                    } else if cell.date == today {
                        context.stroke(Path(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 2, style: .continuous), with: .color(.primary.opacity(0.45)), lineWidth: 1)
                    }
                }
            }
        }
        .frame(width: metrics.plotWidth, height: metrics.plotHeight)
        .contentShape(.rect)
        .onContinuousHover { phase in
            switch phase {
            case .active(let point): active = date(at: point)
            case .ended: active = nil
            }
        }
        .gesture(SpatialTapGesture().onEnded { value in
            let hit = date(at: value.location)
            active = hit == active ? nil : hit
        })
    }

    private func date(at point: CGPoint) -> String? {
        guard let c = metrics.column(atX: point.x), point.y >= 0 else { return nil }
        let r = Int(point.y / metrics.pitch)
        guard r < 7, weeks.indices.contains(c) else { return nil }
        return weeks[c][r]?.date
    }
}

/// The same 53 columns, each a bar of its week's total.
struct NativeProfileWeeklyBars: View {
    let weekly: [NativeProfileMath.WeekTotal]
    let ramp: NativeProfileRamp
    let metrics: NativeProfileGridMetrics
    @Binding var active: String?

    var body: some View {
        let peak = max(1, weekly.map(\.tokens).max() ?? 1)
        let activeIndex = active.flatMap(Int.init)
        Canvas { context, size in
            for (i, week) in weekly.enumerated() {
                let x = CGFloat(i) * metrics.pitch
                let isActive = activeIndex == i
                if week.tokens == 0 {
                    let line = CGRect(x: x, y: size.height - 1, width: metrics.cell, height: 1)
                    context.fill(Path(line), with: .color(isActive ? .primary.opacity(0.6) : ramp.well))
                    continue
                }
                let height = max(2, CGFloat(week.tokens) / CGFloat(peak) * size.height)
                let rect = CGRect(x: x, y: size.height - height, width: metrics.cell, height: height)
                let tint: Color = isActive ? .primary : (activeIndex == nil ? ramp.ink : ramp.ink.opacity(0.55))
                context.fill(Path(roundedRect: rect, cornerRadius: 2, style: .continuous), with: .color(tint))
            }
        }
        .frame(width: metrics.plotWidth, height: metrics.plotHeight)
        .contentShape(.rect)
        .onContinuousHover { phase in
            switch phase {
            case .active(let point): active = metrics.column(atX: point.x).map(String.init)
            case .ended: active = nil
            }
        }
        .gesture(SpatialTapGesture().onEnded { value in
            let hit = metrics.column(atX: value.location.x).map(String.init)
            active = hit == active ? nil : hit
        })
    }
}

/// The running total as a line across the same width (Swift Charts), its
/// selection the day under the pointer.
struct NativeProfileCumulativeLine: View {
    let points: [NativeProfileMath.CumulativePoint]
    let ramp: NativeProfileRamp
    let metrics: NativeProfileGridMetrics
    @Binding var active: String?

    @State private var selection: Int?

    var body: some View {
        Chart {
            ForEach(Array(points.enumerated()), id: \.offset) { index, point in
                AreaMark(x: .value("Day", index), y: .value("Total", point.total))
                    .foregroundStyle(Color.primary.opacity(0.06))
                LineMark(x: .value("Day", index), y: .value("Total", point.total))
                    .foregroundStyle(ramp.ink)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            if let selection, points.indices.contains(selection) {
                RuleMark(x: .value("Day", selection))
                    .foregroundStyle(Color.primary.opacity(0.25))
                PointMark(x: .value("Day", selection), y: .value("Total", points[selection].total))
                    .foregroundStyle(ramp.ink)
                    .symbolSize(40)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .chartXScale(domain: 0...max(1, points.count - 1))
        .chartXSelection(value: $selection)
        .frame(width: metrics.plotWidth, height: metrics.plotHeight)
        .onChange(of: selection) { _, index in
            active = index.flatMap { points.indices.contains($0) ? points[$0].date : nil }
        }
        .onChange(of: active) { _, date in
            let index = date.flatMap { key in points.firstIndex { $0.date == key } }
            if index != selection { selection = index }
        }
    }
}

/// One model: its lab's mark, its name, its share as a bar, tokens and percent.
struct NativeProfileModelRow: View {
    let row: NativeProfileActivity.Model
    /// The share against the top model's, 0...1, for the bar's length.
    let relative: Double
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.cozy) {
                Group {
                    if let provider = row.provider {
                        JunoProviderMark(providerID: provider, providerName: row.label, size: 16)
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 16, height: 16)
                Text(row.label)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: JunoSpace.snug)
                Text(NativeProfileMath.formatTokens(row.tokens))
                    .monospacedDigit()
                Text(NativeProfileMath.formatShare(row.share))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 40, alignment: .trailing)
            }
            GeometryReader { proxy in
                Capsule()
                    .fill(NativeProfileRamp(colorScheme: colorScheme).ink)
                    .frame(width: max(3, proxy.size.width * min(1, max(0, relative))))
            }
            .frame(height: 4)
            .padding(.leading, 16 + JunoSpace.cozy)
            .accessibilityHidden(true)
        }
        .padding(.vertical, JunoSpace.micro)
        .help("\(NativeProfileMath.formatTokensExact(row.tokens)) tokens across \(NativeProfileMath.formatTokensExact(row.requests)) \(row.requests == 1 ? "request" : "requests")")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.label)
        .accessibilityValue("\(NativeProfileMath.formatTokens(row.tokens)) tokens, \(NativeProfileMath.formatShare(row.share))")
    }
}
