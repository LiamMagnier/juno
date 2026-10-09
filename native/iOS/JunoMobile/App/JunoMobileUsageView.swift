import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI

/// **Plan & Usage** — the account's own plan meters and spend, across every
/// surface that costs: Chat, Code, scheduled tasks and media.
///
/// The same two routes the Mac reads (`/api/profile/usage/breakdown` and
/// `/api/profile/usage`), through the same shared client, so the phone and the
/// desktop cannot quietly disagree about a number. Laid out as a stock
/// inset-grouped list: the plan first, then the range, then the numbers as
/// labelled rows.
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
    /// The server has the plan-meter route but not the breakdown one.
    @State private var serverTooOld = false
    @State private var isLoading = false

    var body: some View {
        List {
            if let plan {
                planSection(plan)
            }

            Section {
                Picker("Range", selection: $range) {
                    ForEach(NativeUsageRange.allCases, id: \.self) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
                .accessibilityIdentifier("juno.mobile.usage.range")
            } header: {
                Text("Usage")
            } footer: {
                Text(subhead)
            }

            if let loadError {
                Section {
                    Label(verbatim: loadError, icon: .triangleAlert)
                        .foregroundStyle(.secondary)
                    Button("Try Again") { Task { await load(force: true) } }
                }
            } else if let breakdown {
                if breakdown.totals.requests == 0 {
                    Section {
                        Text("No requests in the \(range.subtitle). Ask Alevr something and this fills in.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    overview(breakdown)
                    surfaces(breakdown)
                    models(breakdown)
                }
            } else if isLoading {
                Section {
                    HStack(spacing: JunoSpace.close) {
                        ProgressView()
                        Text("Reading your usage…").foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .junoGroupedPage()
        .navigationTitle("Plan & Usage")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: range) { await load(force: false, rangeChanged: true) }
        .refreshable { await load(force: true) }
        .accessibilityIdentifier("juno.mobile.usage")
    }

    private var subhead: String {
        guard let breakdown else { return range.subtitle.localizedCapitalized }
        let surfaces = breakdown.surfaces
            .filter { $0.requests > 0 }
            .map(\.displayName)
        let places = surfaces.isEmpty ? "no activity" : surfaces.formatted(.list(type: .and))
        return "\(NativeUsageFormat.tokens(breakdown.totals.totalTokens)) tokens across \(places) in the \(range.subtitle)."
    }

    // MARK: Plan

    private func planSection(_ plan: NativeUsagePlan) -> some View {
        Section {
            LabeledContent("Plan", value: plan.planName)
            if plan.isUnlimited {
                Text("No usage limits on this plan.")
                    .foregroundStyle(.secondary)
            } else if plan.isBrowseOnly {
                Text("Your monthly allowance is used up. A plan opens more models and more usage.")
                    .foregroundStyle(.secondary)
            } else {
                meter("Session", plan.session)
                meter("Weekly", plan.weekly)
            }
            if plan.plan.canUpgrade {
                Button("See Plans") { JunoMobilePlanStore.shared.showPlans() }
                    .accessibilityIdentifier("juno.mobile.usage.plans")
            }
        } footer: {
            if let renewsAt = plan.renewsAt {
                Text("\(plan.renewalLabel) \(renewsAt.formatted(date: .abbreviated, time: .omitted))")
            }
        }
    }

    private func meter(_ title: LocalizedStringKey, _ window: NativeUsagePlan.Window) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            LabeledContent(title) {
                Text(window.fraction.formatted(.percent.precision(.fractionLength(0))))
                    .monospacedDigit()
            }
            // Accent until it is nearly spent, then amber: the colour is a
            // warning only where there is something to warn about.
            ProgressView(value: max(0, min(1, window.fraction)))
                .tint(window.fraction >= 0.9 ? Color.junoCaution : Color.accentColor)
            if let resetsAt = window.resetsAt {
                Text("Resets \(resetsAt.formatted(date: .omitted, time: .shortened))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, JunoSpace.micro)
        .accessibilityElement(children: .combine)
    }

    // MARK: Numbers

    private func overview(_ breakdown: NativeUsageBreakdown) -> some View {
        Section {
            LabeledContent("Requests", value: NativeUsageFormat.count(breakdown.totals.requests))
            LabeledContent("Active days", value: "\(breakdown.activeDays)")
            LabeledContent("Day streak", value: "\(breakdown.currentStreakDays)")
            LabeledContent("Last 24 hours", value: NativeUsageFormat.count(breakdown.pace.last24h))
            LabeledContent("Prompt tokens", value: NativeUsageFormat.tokens(breakdown.totals.promptTokens))
            LabeledContent("Completion tokens", value: NativeUsageFormat.tokens(breakdown.totals.completionTokens))
        }
        .monospacedDigit()
    }

    /// Where the tokens went — the question this page exists to answer.
    @ViewBuilder
    private func surfaces(_ breakdown: NativeUsageBreakdown) -> some View {
        let rows = breakdown.surfaces
            .filter { $0.totalTokens > 0 || $0.requests > 0 }
            .sorted { $0.totalTokens > $1.totalTokens }
        let largest = max(rows.first?.totalTokens ?? 0, 1)
        if !rows.isEmpty {
            Section("By surface") {
                ForEach(rows) { row in
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        LabeledContent {
                            Text(NativeUsageFormat.tokens(row.totalTokens)).monospacedDigit()
                        } label: {
                            Label(verbatim: row.displayName, icon: usageIcon(row.surface), size: 18)
                        }
                        ProgressView(value: Double(row.totalTokens) / Double(largest))
                            .tint(Color.secondary)
                    }
                    .padding(.vertical, JunoSpace.micro)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        "\(row.displayName): \(NativeUsageFormat.tokens(row.totalTokens)) tokens over \(row.requests) requests"
                    )
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
        case "video": .video
        case "voice": .volume
        default: .usage
        }
    }

    /// Which models did the work, named from the signed-in manifest where possible.
    @ViewBuilder
    private func models(_ breakdown: NativeUsageBreakdown) -> some View {
        let rows = breakdown.models
            .filter { $0.totalTokens > 0 }
            .sorted { $0.totalTokens > $1.totalTokens }
            .prefix(8)
        if !rows.isEmpty {
            Section("By model") {
                ForEach(Array(rows)) { row in
                    LabeledContent {
                        Text(NativeUsageFormat.tokens(row.totalTokens)).monospacedDigit()
                    } label: {
                        Text(name(for: row.model))
                        Text("^[\(row.requests) request](inflect: true)")
                    }
                }
            }
        }
    }

    private func name(for id: String) -> String {
        modelCatalog.first { $0.id == id }?.displayName ?? junoDisplayModelName(id)
    }

    // MARK: Loading

    private func load(force: Bool, rangeChanged: Bool = false) async {
        guard let requestSender else {
            loadError = NativeUsageError.unavailable.localizedDescription
            return
        }
        if isLoading { return }
        if !force, !rangeChanged, breakdown != nil { return }
        isLoading = true
        defer { isLoading = false }

        // The two routes fail for genuinely different reasons, and a server
        // older than the app serves the plan meters while 404ing the breakdown.
        let snapshot = await NativeUsageClient(sender: requestSender)
            .load(range: range, for: session.profile.id)
        breakdown = snapshot.breakdown
        plan = snapshot.plan
        JunoMobilePlanStore.shared.update(planID: snapshot.plan?.planID)
        serverTooOld = snapshot.isServerTooOld
        loadError = snapshot.isServerTooOld
            ? nil
            : snapshot.breakdownFailure?.localizedDescription
    }
}

/// One proportion bar. The track stays visible at zero, so a surface with no
/// spend reads as "nothing here" rather than as a missing row.
///
/// Internal rather than private: the Code section draws the same two plan meters
/// in its account row.
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
