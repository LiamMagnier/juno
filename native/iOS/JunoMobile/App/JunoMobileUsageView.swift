import JunoAuth
import JunoChatKit
import JunoDesignSystem
import JunoSync
import SwiftUI

/// **Usage** — the account's own spend, across every surface that costs: Chat,
/// Code, scheduled tasks and media.
///
/// The same two routes the Mac reads (`/api/profile/usage/breakdown` and
/// `/api/profile/usage`), through the same shared client, so the phone and the
/// desktop cannot quietly disagree about a number. The layout is the part that
/// is phone-shaped: the Mac lays its cards out side by side at 960pt, and here
/// they stack in one column with the activity grid scrolling horizontally.
///
/// Nothing here is synthesised. An account with no spend gets an empty state,
/// not a plausible-looking shape — every zero on this page is a real zero.
struct JunoMobileUsageView: View {
    let session: NativeAuthenticatedSession
    /// The authenticated transport. Nil on an unconfigured shell, in which case
    /// the page says so rather than showing an empty dashboard.
    var requestSender: (any NativeAuthenticatedRequestSending)?
    /// The signed-in model manifest, used only to render a model's product name
    /// instead of its wire identifier.
    var modelCatalog: [NativeChatModelOption] = []

    @State private var range = NativeUsageRange.month
    @State private var breakdown: NativeUsageBreakdown?
    @State private var plan: NativeUsagePlan?
    @State private var loadError: String?
    /// The server has the plan-meter route but not the breakdown one — explained
    /// to the reader rather than reported as an error, since nothing is wrong
    /// from the app's side and no retry could change it.
    @State private var serverTooOld = false
    @State private var isLoading = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: JunoSpace.cozy) {
                header

                if let loadError {
                    JunoInlineError(message: loadError) {
                        Task { await load(force: true) }
                    }
                } else if let breakdown {
                    if breakdown.totals.requests == 0 {
                        emptyState
                    } else {
                        content(breakdown)
                    }
                } else if isLoading {
                    JunoMobileQuietLoading()
                        .frame(height: 200)
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.bottom, JunoSpace.section)
        }
        .junoScreenCanvas()
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: range) { await load(force: false) }
        .refreshable { await load(force: true) }
        .accessibilityIdentifier("juno.mobile.usage")
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    // The big number is *tokens*, not euros: it is the one
                    // quantity that is meaningful on every plan, including the
                    // unlimited ones where a spend figure has no budget to sit
                    // against.
                    Text(headline)
                        .junoPageHeading(compact: true)
                        .contentTransition(.numericText())
                    if isLoading {
                        ProgressView().controlSize(.small)
                    }
                }
                Text(subhead)
                    .junoFont(size: 13, relativeTo: .footnote)
                    .junoSecondaryInk()
            }

            // Juno's own switch, not `.pickerStyle(.segmented)`. The system
            // control fills its selected segment with the app tint, which put a
            // slab of coral across the top of this page — and the website's
            // equivalent is neutral: `bg-background text-foreground`, with the
            // accent kept for what is actually an action.
            JunoMobileSegmented(
                options: NativeUsageRange.allCases.map {
                    JunoMobileSegmented<NativeUsageRange>.Option($0, $0.label)
                },
                selection: $range,
                accessibilityLabel: "Range"
            )
            .accessibilityIdentifier("juno.mobile.usage.range")
        }
        .padding(.top, JunoSpace.hairline)
        .padding(.bottom, JunoSpace.hairline)
    }

    private var headline: String {
        guard let breakdown else { return "—" }
        return NativeUsageFormat.tokens(breakdown.totals.totalTokens)
    }

    private var subhead: String {
        guard let breakdown else { return "Reading your ledger…" }
        let surfaces = breakdown.surfaces
            .filter { $0.requests > 0 }
            .map(\.displayName)
        let places = surfaces.isEmpty ? "no activity" : surfaces.formatted(.list(type: .and))
        return "Tokens across \(places) · \(range.subtitle)"
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ breakdown: NativeUsageBreakdown) -> some View {
        JunoMobileUsageStats(breakdown: breakdown)
        JunoMobileUsageActivity(breakdown: breakdown)
        JunoMobileUsageSurfaces(breakdown: breakdown)
        JunoMobileUsageTokenMix(totals: breakdown.totals)
        JunoMobileUsageModels(breakdown: breakdown, catalog: modelCatalog)
        if let plan {
            JunoMobileUsagePlanCard(plan: plan)
        }
    }

    private var emptyState: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Nothing yet")
                    .junoFont(size: 16, relativeTo: .headline, weight: .semibold)
                Text("No requests in the \(range.subtitle). Ask Juno something and this fills in.")
                    .junoFont(size: 13, relativeTo: .footnote)
                    .junoSecondaryInk()
            }
        }
    }

    // MARK: Loading

    private func load(force: Bool) async {
        guard let requestSender else {
            loadError = NativeUsageError.unavailable.localizedDescription
            return
        }
        if isLoading { return }
        if !force, breakdown != nil { return }
        isLoading = true
        defer { isLoading = false }

        // `load` no longer throws: the two routes it reads fail for genuinely
        // different reasons, and a server older than the app serves the plan
        // meters while 404ing the breakdown. Collapsing that into one thrown
        // error produced a screen saying Juno couldn't load the usage against a
        // deployment where the limits were readable the whole time.
        let snapshot = await NativeUsageClient(sender: requestSender)
            .load(range: range, for: session.profile.id)
        breakdown = snapshot.breakdown
        plan = snapshot.plan
        serverTooOld = snapshot.isServerTooOld
        // A server that simply predates the breakdown route is explained, not
        // reported as a failure — there is nothing wrong from the app's side and
        // nothing a retry could change.
        loadError = snapshot.isServerTooOld
            ? nil
            : snapshot.breakdownFailure?.localizedDescription
    }
}

// MARK: - Stats

/// The four numbers worth reading before any chart: how much was asked, how
/// often, how consistently, and how recently. A 2×2 grid rather than the Mac's
/// single row — four columns on a phone leaves each number about forty points
/// of width, which is where "12,481" starts wrapping mid-thousand.
private struct JunoMobileUsageStats: View {
    let breakdown: NativeUsageBreakdown

    var body: some View {
        JunoCard {
            VStack(spacing: JunoSpace.regular) {
                HStack(spacing: 0) {
                    stat(NativeUsageFormat.count(breakdown.totals.requests), "Requests")
                    divider
                    stat("\(breakdown.activeDays)", "Active days")
                }
                Rectangle()
                    .fill(Color.junoHairline)
                    .frame(height: 1)
                    .accessibilityHidden(true)
                HStack(spacing: 0) {
                    stat("\(breakdown.currentStreakDays)", "Day streak")
                    divider
                    stat(NativeUsageFormat.count(breakdown.pace.last24h), "Last 24 hours")
                }
            }
        }
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .junoFont(size: 22, relativeTo: .title2, weight: .semibold)
                .contentTransition(.numericText())
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .junoFont(size: 12, relativeTo: .caption)
                .junoSecondaryInk()
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.junoHairline)
            .frame(width: 1, height: 30)
            .accessibilityHidden(true)
    }
}

// MARK: - Activity grid

/// A run of days as a contribution grid, scrolling sideways.
///
/// The grid is laid out on the **UTC** day boundary, because that is the
/// boundary the server buckets on. Re-bucketing into the reader's local zone
/// here would shift every cell by up to a day and quietly disagree with the
/// totals above it.
private struct JunoMobileUsageActivity: View {
    let breakdown: NativeUsageBreakdown

    private static let cell: CGFloat = 12
    private static let gap: CGFloat = 3

    /// Days ascending, in columns of seven — one column per week, which is what
    /// makes a row read as "every Tuesday".
    private var columns: [[NativeUsageActivityCell]] {
        stride(from: 0, to: breakdown.activityCells.count, by: 7).map { start in
            Array(breakdown.activityCells[start..<min(start + 7, breakdown.activityCells.count)])
        }
    }

    var body: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                Text("Activity")
                    .junoFont(size: 16, relativeTo: .headline, weight: .semibold)

                // Anchored to the trailing edge: the newest week is the one
                // worth landing on, and a year-long grid opening on last January
                // is a scroll the reader has to undo every time.
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: Self.gap) {
                        ForEach(Array(columns.enumerated()), id: \.offset) { _, week in
                            VStack(spacing: Self.gap) {
                                ForEach(week) { day in
                                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                                        .fill(day.fill)
                                        .frame(width: Self.cell, height: Self.cell)
                                        .accessibilityLabel(day.summary)
                                }
                            }
                        }
                    }
                    .padding(.vertical, JunoSpace.hairline)
                }
                .defaultScrollAnchor(.trailing)
                .scrollIndicators(.hidden)

                legend
            }
        }
    }

    private var legend: some View {
        HStack(spacing: JunoSpace.tight) {
            if let busiest = breakdown.busiestDay, busiest.requests > 0 {
                Text("Busiest \(NativeUsageFormat.day(busiest.dayMs)) · \(busiest.requests)")
                    .junoFont(size: 12, relativeTo: .caption)
                    .monospacedDigit()
                    .junoSecondaryInk()
            }
            Spacer(minLength: 4)
            Text("Less")
                .junoFont(size: 12, relativeTo: .caption)
                .junoSecondaryInk()
            ForEach(0..<5, id: \.self) { level in
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(NativeUsageActivityCell.fill(forLevel: level))
                    .frame(width: 9, height: 9)
            }
            Text("More")
                .junoFont(size: 12, relativeTo: .caption)
                .junoSecondaryInk()
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Surfaces

/// Where the tokens went. "Where did it go" is the question this page exists to
/// answer, and it is the one the plan meters below cannot.
private struct JunoMobileUsageSurfaces: View {
    let breakdown: NativeUsageBreakdown

    private var rows: [NativeUsageSurfaceTotals] {
        breakdown.surfaces
            .filter { $0.totalTokens > 0 || $0.requests > 0 }
            .sorted { $0.totalTokens > $1.totalTokens }
    }

    private var largest: Int {
        max(rows.first?.totalTokens ?? 0, 1)
    }

    var body: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                Text("By surface")
                    .junoFont(size: 16, relativeTo: .headline, weight: .semibold)

                if rows.isEmpty {
                    Text("No surface has spent anything in this window.")
                        .junoFont(size: 13, relativeTo: .footnote)
                        .junoSecondaryInk()
                } else {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: JunoSpace.tight) {
                            HStack(spacing: JunoSpace.snug) {
                                JunoIconView(usageIcon(row.surface), size: 13)
                                    .frame(width: 18)
                                    .junoSecondaryInk()
                                Text(row.displayName)
                                    .junoFont(size: 15, relativeTo: .subheadline)
                                Spacer(minLength: 6)
                                Text(NativeUsageFormat.tokens(row.totalTokens))
                                    .junoFont(size: 13, relativeTo: .footnote)
                                    .monospacedDigit()
                                    .junoSecondaryInk()
                            }
                            JunoMobileUsageBar(
                                fraction: Double(row.totalTokens) / Double(largest)
                            )
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(
                            "\(row.displayName): \(NativeUsageFormat.tokens(row.totalTokens)) tokens over \(row.requests) requests"
                        )
                    }
                }
            }
        }
    }

    private func usageIcon(_ surface: String) -> JunoIcon {
        switch surface {
        case "chat": .conversation
        case "code": .code
        case "task": .tasks
        case "image": .photos
        case "video": .artifacts
        case "voice": .volume
        default: .usage
        }
    }
}

/// One proportion bar. The track stays visible at zero, so a surface with no
/// spend reads as "nothing here" rather than as a missing row.
///
/// Internal rather than private: the Code section draws the same two plan meters
/// in its account row, and a second bar built to look like this one is a bar
/// free to stop looking like it.
struct JunoMobileUsageBar: View {
    let fraction: Double
    var tint: Color = .junoAccent

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.junoMuted)
                Capsule()
                    .fill(tint)
                    .frame(width: max(0, min(1, fraction)) * geometry.size.width)
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

// MARK: - Token mix

/// What the tokens were: the question asked, or the answer written. A prompt-
/// heavy account and a completion-heavy one cost the same on this page's
/// headline and very different amounts in reality, which is why the split is
/// here at all.
private struct JunoMobileUsageTokenMix: View {
    let totals: NativeUsageTotals

    private var promptShare: Double {
        guard totals.totalTokens > 0 else { return 0 }
        return Double(totals.promptTokens) / Double(totals.totalTokens)
    }

    var body: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                Text("In and out")
                    .junoFont(size: 16, relativeTo: .headline, weight: .semibold)
                JunoMobileUsageBar(fraction: promptShare)
                HStack(spacing: 0) {
                    label("Prompt", NativeUsageFormat.tokens(totals.promptTokens))
                    Spacer(minLength: 8)
                    label("Completion", NativeUsageFormat.tokens(totals.completionTokens))
                }
            }
        }
    }

    private func label(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
                .monospacedDigit()
            Text(title)
                .junoFont(size: 12, relativeTo: .caption)
                .junoSecondaryInk()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(value) tokens")
    }
}

// MARK: - Models

/// Which models did the work. Named from the signed-in manifest where possible —
/// a model absent from it (retired since the spend happened) keeps its wire
/// identifier rather than being renamed into something it was not.
private struct JunoMobileUsageModels: View {
    let breakdown: NativeUsageBreakdown
    let catalog: [NativeChatModelOption]

    private var rows: [NativeUsageModelTotals] {
        breakdown.models
            .filter { $0.totalTokens > 0 }
            .sorted { $0.totalTokens > $1.totalTokens }
            .prefix(8)
            .map { $0 }
    }

    private func name(for id: String) -> String {
        catalog.first { $0.id == id }?.displayName ?? junoDisplayModelName(id)
    }

    var body: some View {
        if !rows.isEmpty {
            JunoCard {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    Text("By model")
                        .junoFont(size: 16, relativeTo: .headline, weight: .semibold)
                    ForEach(rows) { row in
                        HStack(spacing: JunoSpace.snug) {
                            Text(name(for: row.model))
                                .junoFont(size: 15, relativeTo: .subheadline)
                                .lineLimit(1)
                            Spacer(minLength: 6)
                            Text("\(NativeUsageFormat.count(row.requests))×")
                                .junoFont(size: 12, relativeTo: .caption)
                                .monospacedDigit()
                                .junoMetaInk()
                            Text(NativeUsageFormat.tokens(row.totalTokens))
                                .junoFont(size: 13, relativeTo: .footnote)
                                .monospacedDigit()
                                .junoSecondaryInk()
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(
                            "\(name(for: row.model)): \(row.requests) requests, \(NativeUsageFormat.tokens(row.totalTokens)) tokens"
                        )
                    }
                }
            }
        }
    }
}

// MARK: - Plan

/// The two meters that actually stop a turn starting, and when they reset.
private struct JunoMobileUsagePlanCard: View {
    let plan: NativeUsagePlan

    var body: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                HStack {
                    Text("Plan")
                        .junoFont(size: 16, relativeTo: .headline, weight: .semibold)
                    Spacer(minLength: 6)
                    JunoStatusPill(text: plan.planName, tint: .junoAccent)
                }

                if plan.isUnlimited {
                    Text("No usage limits on this plan.")
                        .junoFont(size: 13, relativeTo: .footnote)
                        .junoSecondaryInk()
                } else if plan.isBrowseOnly {
                    Text("Free is a browse-only tier. Upgrade to start using models.")
                        .junoFont(size: 13, relativeTo: .footnote)
                        .junoSecondaryInk()
                } else {
                    meter("Session", plan.session)
                    meter("Weekly", plan.weekly)
                }

                if let renewsAt = plan.renewsAt {
                    Text("\(plan.renewalLabel) \(renewsAt.formatted(date: .abbreviated, time: .omitted))")
                        .junoFont(size: 12, relativeTo: .caption)
                        .junoSecondaryInk()
                }
            }
        }
    }

    private func meter(_ title: String, _ window: NativeUsagePlan.Window) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.tight) {
                Text(title)
                    .junoFont(size: 14, relativeTo: .subheadline)
                Spacer(minLength: 6)
                Text(window.fraction.formatted(.percent.precision(.fractionLength(0))))
                    .junoFont(size: 13, relativeTo: .footnote)
                    .monospacedDigit()
                    .junoSecondaryInk()
            }
            // Coral until it is nearly spent, then amber: the colour is a
            // warning only where there is something to warn about.
            JunoMobileUsageBar(
                fraction: window.fraction,
                tint: window.fraction >= 0.9 ? .junoCaution : .junoAccent
            )
            if let resetsAt = window.resetsAt {
                Text("Resets \(resetsAt.formatted(date: .omitted, time: .shortened))")
                    .junoFont(size: 12, relativeTo: .caption)
                    .junoMetaInk()
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(title) window: \(window.fraction.formatted(.percent.precision(.fractionLength(0)))) used"
        )
    }
}
