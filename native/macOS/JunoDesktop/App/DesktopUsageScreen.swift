import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoDesignSystem
import JunoSync
import SwiftUI

/// The account's own usage, across every surface that spends: Chat, Code,
/// scheduled tasks and media.
///
/// Everything on this page is read from `/api/profile/usage/breakdown`, which
/// aggregates the `ApiSpend` ledger — the same rows the budget gate reads before
/// it lets a turn start. That matters more than it sounds: a usage screen built
/// from anything else (message counts, conversation lengths, a local tally) can
/// disagree with the number that actually stops the user working, and a
/// dashboard that disagrees with the meter is worse than no dashboard.
///
/// Nothing here is synthesised. An account with no spend gets an empty state,
/// not a plausible-looking shape — every zero on this page is a real zero.
struct DesktopUsageScreen: View {
    let session: NativeAuthenticatedSession
    let requestSender: (any NativeAuthenticatedRequestSending)?
    /// The signed-in model manifest, used only to render a model's product name
    /// instead of its wire identifier. A model absent from the manifest (retired
    /// since the spend happened) keeps its identifier rather than being renamed.
    let modelCatalog: [NativeChatModelOption]

    @State private var range = DesktopUsageRange.year
    @State private var breakdown: DesktopUsageBreakdown?
    @State private var plan: DesktopUsagePlan?
    @State private var loadError: String?
    /// The server has the plan-meter route but not the breakdown one. Explained
    /// rather than reported as a failure — nothing is wrong from here.
    @State private var serverTooOld = false
    @State private var isLoading = false

    var body: some View {
        JunoDetailPage(maxWidth: DesktopUsageMetrics.readingWidth) {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                header

                // Whatever arrived is rendered. The two routes fail
                // independently — a server older than the app serves the plan
                // meters but not the breakdown — and blanking the page on the
                // weaker one is what made this screen look broken against a
                // deployment where the limits were readable all along.
                if let breakdown, breakdown.totals.requests > 0 {
                    content(breakdown)
                } else if let breakdown, breakdown.totals.requests == 0 {
                    DesktopUsageEmptyState(range: range)
                } else if isLoading {
                    DesktopUsageLoading()
                }

                if serverTooOld {
                    DesktopUsageNotice(
                        message: NativeUsageError.notSupportedByServer.localizedDescription,
                        symbol: "clock.arrow.circlepath",
                        // Retrying cannot conjure a route the server does not
                        // have; the fix is a deploy, not another request.
                        retry: nil
                    )
                } else if let loadError {
                    DesktopUsageNotice(
                        message: loadError,
                        retry: { Task { await load(force: true) } }
                    )
                }

                // The meters come from the older route, so they are usually the
                // one thing that *does* work when the breakdown does not.
                if let plan {
                    DesktopUsagePlanCard(plan: plan)
                }
            }
        }
        .junoReadingCanvas()
        .navigationTitle("Usage")
        .task(id: range) { await load(force: false) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await load(force: true) }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(isLoading)
                .help("Re-read your usage from the ledger")
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text("Usage")
                        .junoEyebrow()
                    Text(headline)
                        .font(JunoSerif.pageHeading())
                        .contentTransition(.numericText())
                    Text(subhead)
                        .junoCaption()
                }
                Spacer(minLength: JunoSpace.regular)
                if isLoading {
                    ProgressView().controlSize(.small)
                }
            }

            Picker("Range", selection: $range) {
                ForEach(DesktopUsageRange.allCases) { value in
                    Text(value.label).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: DesktopUsageMetrics.rangePickerWidth, alignment: .leading)
            .accessibilityIdentifier("juno.desktop.usage.range")
        }
    }

    /// The big number is *tokens*, not euros: it is the one quantity that is
    /// meaningful on every plan, including the unlimited ones where a spend
    /// figure has no budget to sit against.
    private var headline: String {
        guard let breakdown else { return "—" }
        return DesktopUsageFormat.tokens(breakdown.totals.totalTokens)
    }

    private var subhead: String {
        guard let breakdown else { return "Reading your ledger…" }
        let surfaces = breakdown.surfaces
            .filter { $0.requests > 0 }
            .map(\.displayName)
        let where_ = surfaces.isEmpty ? "no activity" : surfaces.formatted(.list(type: .and))
        return "Tokens across \(where_) · \(range.subtitle)"
    }

    // MARK: - Content

    @ViewBuilder
    private func content(_ breakdown: DesktopUsageBreakdown) -> some View {
        DesktopUsageStatStrip(breakdown: breakdown)

        DesktopUsageActivityCard(breakdown: breakdown, range: range)

        // Surfaces first: "where did it go" is the question this page exists to
        // answer, and it is the one the plan meters below cannot.
        DesktopUsageSurfacesCard(breakdown: breakdown)

        HStack(alignment: .top, spacing: JunoSpace.regular) {
            DesktopUsageTokenMixCard(totals: breakdown.totals)
            DesktopUsagePaceCard(breakdown: breakdown)
        }

        // The plan card is rendered by `body`, not here: it is the half that
        // survives when the breakdown does not, so it cannot live inside the
        // branch that requires a breakdown.
        DesktopUsageModelsCard(breakdown: breakdown, catalog: modelCatalog)
    }

    // MARK: - Loading

    /// Reads the breakdown and the plan meters together, through the shared
    /// client — the phone reads the same two routes the same way.
    private func load(force: Bool) async {
        guard let requestSender else {
            loadError = NativeUsageError.unavailable.localizedDescription
            return
        }
        if isLoading { return }
        if !force, breakdown != nil { return }
        isLoading = true
        defer { isLoading = false }

        let snapshot = await NativeUsageClient(sender: requestSender)
            .load(range: range, for: session.profile.id)
        breakdown = snapshot.breakdown
        plan = snapshot.plan
        serverTooOld = snapshot.isServerTooOld
        // A server that simply predates the breakdown route is not an error to
        // report — `serverTooOld` explains it, and the meters below still work.
        loadError = snapshot.isServerTooOld
            ? nil
            : snapshot.breakdownFailure?.localizedDescription
    }
}

// MARK: - Metrics

private enum DesktopUsageMetrics {
    /// Wider than the 720pt reading measure the settings panes use: this page is
    /// a dashboard of side-by-side cards, not a column of prose.
    static let readingWidth: CGFloat = 960
    static let rangePickerWidth: CGFloat = 280
    /// One day in the activity grid, and the gap between two.
    static let activityCell: CGFloat = 11
    static let activityGap: CGFloat = 3
    static let barHeight: CGFloat = 6
    static let modelMark: CGFloat = 18
}

// MARK: - Stat strip

/// The four numbers worth reading before any chart: how much was asked, how
/// often, how consistently, and how recently.
private struct DesktopUsageStatStrip: View {
    let breakdown: DesktopUsageBreakdown

    var body: some View {
        HStack(spacing: 0) {
            stat(DesktopUsageFormat.count(breakdown.totals.requests), "Requests")
            divider
            stat("\(breakdown.activeDays)", "Active days")
            divider
            stat(
                "\(breakdown.currentStreakDays)",
                breakdown.currentStreakDays == 1 ? "Day streak" : "Day streak"
            )
            divider
            stat(DesktopUsageFormat.count(breakdown.pace.last24h), "Last 24 hours")
        }
        .padding(.vertical, JunoSpace.roomy)
        .frame(maxWidth: .infinity)
        .junoCard()
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: JunoSpace.hairline) {
            Text(value)
                .font(.system(.title2, design: .default, weight: .semibold))
                .contentTransition(.numericText())
            Text(label)
                .junoCaption()
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.junoHairline)
            .frame(width: 1, height: 28)
            .accessibilityHidden(true)
    }
}

// MARK: - Activity grid

/// A year of activity as a contribution grid.
///
/// The grid is laid out on the **UTC** day boundary, because that is the
/// boundary the server buckets on. Re-bucketing into the reader's local zone
/// here would shift every cell by up to a day and quietly disagree with the
/// totals above it; showing the same grid the server computed is the honest
/// choice even for a reader far from UTC.
private struct DesktopUsageActivityCard: View {
    let breakdown: DesktopUsageBreakdown
    let range: DesktopUsageRange

    /// Days ascending, from the start of the window's first week to today.
    private var cells: [DesktopUsageActivityCell] { breakdown.activityCells }

    /// Cells are laid out column-major (a column is one week, Sunday at top),
    /// which is what the grid idiom expects and what makes the month labels
    /// above line up with real week boundaries.
    private var weeks: [[DesktopUsageActivityCell]] {
        stride(from: 0, to: cells.count, by: 7).map {
            Array(cells[$0..<min($0 + 7, cells.count)])
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack(alignment: .firstTextBaseline) {
                Text("Activity")
                    .junoCardTitle()
                Spacer()
                Text("\(breakdown.activeDays) active days · longest streak \(breakdown.longestStreakDays)")
                    .junoCaption()
            }

            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    monthRuler
                    HStack(alignment: .top, spacing: DesktopUsageMetrics.activityGap) {
                        ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                            VStack(spacing: DesktopUsageMetrics.activityGap) {
                                ForEach(week) { cell in
                                    DesktopUsageActivitySquare(cell: cell)
                                }
                            }
                        }
                    }
                }
                .padding(.bottom, JunoSpace.hairline)
            }
            .scrollIndicators(.hidden)
            // The year grid is wider than the card on a narrow window, so it
            // scrolls; the 30-day grid is not, and must not be stretched to fill.
            .frame(maxWidth: .infinity, alignment: .leading)

            legend
        }
        .padding(JunoSpace.roomy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard()
    }

    /// A month's name above the first week that starts in it.
    private var monthRuler: some View {
        HStack(alignment: .bottom, spacing: DesktopUsageMetrics.activityGap) {
            ForEach(Array(weeks.enumerated()), id: \.offset) { index, week in
                let label = monthLabel(startingWeek: week, at: index)
                Text(label ?? " ")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .frame(width: DesktopUsageMetrics.activityCell, alignment: .leading)
                    .fixedSize()
                    .accessibilityHidden(true)
            }
        }
    }

    /// Labels a week only when it contains the first day of a month, and only
    /// when the previous week did not already carry that month — so the ruler
    /// never prints the same name twice in a row.
    private func monthLabel(startingWeek week: [DesktopUsageActivityCell], at index: Int) -> String? {
        guard index > 0 || range != .year else {
            return week.first.map(DesktopUsageFormat.month)
        }
        guard let first = week.first(where: { DesktopUsageFormat.isFirstOfMonth($0) }) else {
            return nil
        }
        return DesktopUsageFormat.month(first)
    }

    private var legend: some View {
        HStack(spacing: JunoSpace.tight) {
            Spacer()
            Text("Less").junoCaption()
            ForEach(0..<5) { level in
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(DesktopUsageActivityCell.fill(forLevel: level))
                    .frame(
                        width: DesktopUsageMetrics.activityCell,
                        height: DesktopUsageMetrics.activityCell
                    )
            }
            Text("More").junoCaption()
        }
        .accessibilityHidden(true)
    }
}

private struct DesktopUsageActivitySquare: View {
    let cell: DesktopUsageActivityCell

    var body: some View {
        RoundedRectangle(cornerRadius: 2, style: .continuous)
            .fill(cell.fill)
            .frame(
                width: DesktopUsageMetrics.activityCell,
                height: DesktopUsageMetrics.activityCell
            )
            .help(cell.summary)
            .accessibilityLabel(cell.summary)
    }
}

// MARK: - Surfaces

/// Where the tokens went: Chat, Code, scheduled tasks, media.
private struct DesktopUsageSurfacesCard: View {
    let breakdown: DesktopUsageBreakdown

    private var rows: [DesktopUsageSurfaceTotals] {
        breakdown.surfaces.filter { $0.requests > 0 }
    }

    private var maximum: Int {
        max(1, rows.map(\.totalTokens).max() ?? 1)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            Text("Where it went")
                .junoCardTitle()

            ForEach(rows) { row in
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        Image(systemName: row.symbol)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 16)
                            .accessibilityHidden(true)
                        Text(row.displayName)
                            .junoRowLabel()
                        Spacer(minLength: JunoSpace.snug)
                        Text(DesktopUsageFormat.tokens(row.totalTokens))
                            .junoMono()
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    DesktopUsageBar(fraction: Double(row.totalTokens) / Double(maximum))
                    Text("\(DesktopUsageFormat.count(row.requests)) requests")
                        .junoCaption()
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(JunoSpace.roomy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard()
    }
}

// MARK: - Token mix

private struct DesktopUsageTokenMixCard: View {
    let totals: DesktopUsageTotals

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            Text("Token mix")
                .junoCardTitle()

            row("Input", totals.promptTokens)
            row("Output", totals.completionTokens)
        }
        .padding(JunoSpace.roomy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard()
    }

    /// Both bars are scaled against the *larger* of the two, not against the
    /// total — input outweighs output by one to two orders of magnitude on an
    /// agentic workload, and a shared total scale renders output as an
    /// invisible sliver that looks like a rendering bug.
    private func row(_ label: String, _ value: Int) -> some View {
        let peak = max(1, max(totals.promptTokens, totals.completionTokens))
        return VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).junoRowLabel()
                Spacer(minLength: JunoSpace.snug)
                Text(DesktopUsageFormat.tokens(value))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            DesktopUsageBar(fraction: Double(value) / Double(peak))
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(DesktopUsageFormat.tokens(value)) tokens")
    }
}

// MARK: - Pace

private struct DesktopUsagePaceCard: View {
    let breakdown: DesktopUsageBreakdown

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            Text("Pace")
                .junoCardTitle()

            HStack(alignment: .top, spacing: JunoSpace.roomy) {
                figure(DesktopUsageFormat.count(breakdown.pace.lastHour), "Last hour")
                figure(DesktopUsageFormat.count(breakdown.pace.last24h), "Last 24 hours")
            }

            if let busiest = breakdown.busiestDay {
                Divider()
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text("Busiest day")
                        .junoCaption()
                    Text(
                        "\(DesktopUsageFormat.day(busiest.dayMs)) · \(DesktopUsageFormat.count(busiest.requests)) requests"
                    )
                    .junoRowLabel()
                }
            }
        }
        .padding(JunoSpace.roomy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard()
    }

    private func figure(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(value)
                .font(.system(.title3, design: .default, weight: .semibold))
                .contentTransition(.numericText())
            Text(label).junoCaption()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}

// MARK: - Models

private struct DesktopUsageModelsCard: View {
    let breakdown: DesktopUsageBreakdown
    let catalog: [NativeChatModelOption]

    private var maximum: Int {
        max(1, breakdown.models.map(\.totalTokens).max() ?? 1)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack(alignment: .firstTextBaseline) {
                Text("Most used models")
                    .junoCardTitle()
                Spacer()
                Text("\(breakdown.models.count) shown")
                    .junoCaption()
            }

            ForEach(breakdown.models) { model in
                let identity = DesktopUsageModelIdentity(id: model.model, catalog: catalog)
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    HStack(spacing: JunoSpace.snug) {
                        JunoProviderMark(
                            providerID: identity.providerID,
                            providerName: identity.providerName,
                            size: DesktopUsageMetrics.modelMark
                        )
                        Text(identity.displayName)
                            .junoRowLabel()
                            .lineLimit(1)
                        Spacer(minLength: JunoSpace.snug)
                        Text(DesktopUsageFormat.tokens(model.totalTokens))
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    DesktopUsageBar(fraction: Double(model.totalTokens) / Double(maximum))
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "\(identity.displayName): \(DesktopUsageFormat.tokens(model.totalTokens)) tokens"
                )
            }
        }
        .padding(JunoSpace.roomy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard()
    }
}

/// A ledger model identifier, resolved against the signed-in manifest.
///
/// The ledger stores the canonical `provider:model` identifier at the moment of
/// the request, so it can name a model the account can no longer select. Such a
/// row keeps its identifier rather than being renamed or dropped — the spend was
/// real and hiding it would make the totals stop adding up.
struct DesktopUsageModelIdentity {
    let providerID: String
    let providerName: String
    let displayName: String

    init(id: String, catalog: [NativeChatModelOption]) {
        if let known = catalog.first(where: { $0.id == id }) {
            providerID = known.providerID
            providerName = known.providerName
            displayName = known.displayName
            return
        }
        let parts = id.split(separator: ":", maxSplits: 1).map(String.init)
        let provider = parts.count == 2 ? parts[0] : ""
        providerID = provider
        providerName = provider.isEmpty ? "Model" : provider.capitalized
        displayName = parts.count == 2 ? parts[1] : id
    }
}

// MARK: - Plan meters

/// The plan's rolling windows, from the same route the website's own meters and
/// the Settings pane read.
private struct DesktopUsagePlanCard: View {
    let plan: DesktopUsagePlan

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack(alignment: .firstTextBaseline) {
                Text("Plan")
                    .junoCardTitle()
                Spacer()
                Text(plan.planName)
                    .font(.callout.weight(.medium))
            }

            if plan.isUnlimited {
                Text("No usage limits on this plan.")
                    .junoCaption()
            } else if plan.isBrowseOnly {
                Text("Free is a browse-only tier. Upgrade to start using models.")
                    .junoCaption()
            } else {
                meter("Current session", plan.session)
                Divider()
                meter("This week, all models", plan.weekly)
                if let renewsAt = plan.renewsAt {
                    Text("\(plan.renewalLabel) \(renewsAt.formatted(date: .abbreviated, time: .omitted))")
                        .junoCaption()
                }
            }
        }
        .padding(JunoSpace.roomy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard()
    }

    private func meter(_ label: String, _ window: DesktopUsagePlan.Window) -> some View {
        let percent = Int((min(1, max(0, window.fraction)) * 100).rounded())
        return VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).junoRowLabel()
                Spacer(minLength: JunoSpace.snug)
                Text("\(percent)% used")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            DesktopUsageBar(
                fraction: window.fraction,
                // Past 90% the bar stops being information and starts being a
                // warning, which is the one place this page spends colour.
                tint: window.fraction >= 0.9 ? Color.junoCaution : Color.junoAccent
            )
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(percent) percent used")
    }
}

// MARK: - Shared furniture

/// One horizontal proportion bar. The track is always drawn, so a near-zero
/// value reads as "almost none" rather than as a missing row.
private struct DesktopUsageBar: View {
    let fraction: Double
    var tint: Color = .junoAccent

    var body: some View {
        GeometryReader { proxy in
            let clamped = min(1, max(0, fraction.isFinite ? fraction : 0))
            ZStack(alignment: .leading) {
                Capsule(style: .continuous)
                    .fill(Color.junoMuted)
                Capsule(style: .continuous)
                    .fill(tint)
                    // A visible floor: a real but tiny value must still draw
                    // something, or the row looks like it failed to load.
                    .frame(width: max(clamped > 0 ? 3 : 0, proxy.size.width * clamped))
            }
        }
        .frame(height: DesktopUsageMetrics.barHeight)
        .animation(JunoMotion.standard, value: fraction)
        .accessibilityHidden(true)
    }
}

private struct DesktopUsageLoading: View {
    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            ProgressView().controlSize(.small)
            Text("Reading your usage…").junoCaption()
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, JunoSpace.region)
    }
}

private struct DesktopUsageEmptyState: View {
    let range: DesktopUsageRange

    var body: some View {
        JunoEmptyState(
            title: "No usage yet",
            message: "Nothing was spent in the \(range.subtitle). Start a chat or a Code session and it will show up here.",
            symbol: "chart.line.uptrend.xyaxis"
        )
        .frame(maxWidth: .infinity)
        .padding(.vertical, JunoSpace.region)
    }
}

private struct DesktopUsageNotice: View {
    let message: String
    var symbol: String = "exclamationmark.triangle"
    /// Nil where retrying cannot help — a route the server does not have is
    /// fixed by deploying, not by asking again, and a button that cannot
    /// succeed is worse than no button.
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Image(systemName: symbol)
                .foregroundStyle(Color.junoCaution)
                .accessibilityHidden(true)
            Text(message)
                .junoCaption()
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: JunoSpace.snug)
            if let retry {
                Button("Retry", action: retry)
                    .controlSize(.small)
            }
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard()
    }
}

private extension View {
    /// A card's own heading — a step below the page title, and the same on every
    /// card so the dashboard reads as one grid rather than as stacked widgets.
    func junoCardTitle() -> some View {
        font(.system(.headline, design: .default, weight: .semibold))
    }

    /// The small caps label above a page title, matching the web's `eyebrow`.
    func junoEyebrow() -> some View {
        font(.system(.caption, design: .monospaced, weight: .medium))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
    }
}
