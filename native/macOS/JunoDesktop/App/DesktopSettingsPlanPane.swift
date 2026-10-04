import AppKit
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI

/// Settings › Plan & usage (`sections/billing.tsx`, `usage-history.tsx`): the
/// plan and its actions, the three meters, the spend ceiling, and thirty days
/// of history. The Mac's old Usage page is folded in the web's way; its
/// heatmap, token mix, pace and model cards are not carried over (decision 23).
///
/// Signature detail: the thirty day bars, the busiest day lifted into the
/// accent so the month's peak reads before any number does.
struct DesktopSettingsPlanPane: View {
    let context: DesktopSettingsContext

    @State private var presenter = DesktopUpgradePresenter.shared
    @State private var openingPortal = false

    var body: some View {
        DesktopSettingsForm {
            switch context.plan {
            case .loading:
                Section {
                    DesktopSettingRowSkeleton()
                    DesktopSettingRowSkeleton()
                }
            case .failed(let message):
                Section {
                    JunoEmptyState(
                        title: message,
                        message: "Check your connection and try again.",
                        icon: .error,
                        actionLabel: "Try Again",
                        action: { Task { await context.loadPlan() } },
                        size: .panel,
                        tone: .error
                    )
                }
            case .loaded(let plan):
                Section {
                    planBlock(plan)
                }
                Section {
                    usageRows(plan)
                } header: {
                    DesktopSettingsGroupHeader(title: "Usage")
                }
                Section {
                    DesktopSpendCeilingRow(context: context, plan: plan)
                } header: {
                    DesktopSettingsGroupHeader(title: "Spend ceiling")
                }
            }
            Section {
                DesktopUsageHistory(context: context)
            } header: {
                DesktopSettingsGroupHeader(
                    title: "History",
                    note: "Replies per day across chat, code and tasks."
                )
            }
        }
        .task {
            await context.loadPlan()
            await context.loadHistory()
        }
    }

    // MARK: Plan

    private func planBlock(_ plan: NativeUsagePlan) -> some View {
        let id = plan.planID.uppercased()
        let catalog = DesktopPlanCatalog.plan(id: id)
        // Title and actions on one line, then the tagline and the price at
        // the row's full width: squeezed beside the buttons, the sentence
        // wrapped and orphaned its date.
        return VStack(alignment: .leading, spacing: JunoSpace.micro) {
            HStack(alignment: .center, spacing: JunoSpace.snug) {
                Text(catalog?.name ?? plan.planName)
                    .junoType(JunoType.bodyLarge.weight(.semibold))
                    .foregroundStyle(Color.junoForeground)
                Spacer(minLength: JunoSpace.section)
                HStack(spacing: JunoSpace.snug) {
                    if id == "FREE" {
                        Button("Upgrade") { presenter.present(in: .settings) }
                            .buttonStyle(.junoProminent)
                            .contentShape(.rect)
                            .accessibilityIdentifier("juno.desktop.settings.upgrade")
                    } else {
                        DesktopOutlineButton(title: "Change Plan") { presenter.present(in: .settings) }
                        DesktopOutlineButton(title: openingPortal ? "Opening…" : "Manage Billing") { openPortal() }
                            .disabled(openingPortal)
                    }
                }
                .fixedSize()
            }
            if let tagline = catalog?.tagline {
                Text(tagline)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            let price = Self.priceSentence(price: catalog?.priceHT ?? 0, renewsAt: plan.renewsAt, cancelAtPeriodEnd: plan.cancelAtPeriodEnd)
            // "Free." under a plan already named Free says nothing twice.
            if price != "Free." {
                Text(price)
                    .junoType(.ui)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, JunoSpace.tight)
            }
        }
        .padding(.vertical, JunoSpace.snug)
    }

    /// "€24 a month incl. VAT. Renews Oct 3, 2026." or "Free." `price` is the
    /// plan's HT price; the sentence shows what the reader pays.
    static func priceSentence(price: Int, renewsAt: Date?, cancelAtPeriodEnd: Bool, locale: Locale = .current) -> String {
        let ttc = JunoPlanPrice(ht: price)
        var sentence = price > 0 ? "\(ttc.monthly(locale: locale)) a month incl. VAT." : "Free."
        if let renewsAt {
            // Non-breaking spaces, so a wrap can never split the date.
            let date = renewsAt.formatted(.dateTime.month(.abbreviated).day().year())
                .replacingOccurrences(of: " ", with: "\u{00A0}")
            sentence += " \(cancelAtPeriodEnd ? "Access ends" : "Renews") \(date)."
        }
        return sentence
    }

    private func openPortal() {
        guard let billing = context.services.billing else { return }
        openingPortal = true
        Task {
            defer { openingPortal = false }
            do {
                NSWorkspace.shared.open(try await billing.portal(for: context.accountID))
            } catch {
                context.toasts.post(.error("Couldn’t open the billing portal.", detail: NativeFailureMessage.presentable(error)))
            }
        }
    }

    // MARK: Usage

    @ViewBuilder
    private func usageRows(_ plan: NativeUsagePlan) -> some View {
        if plan.budgetMicroUsd == nil {
            DesktopSettingsNote(text: "Nothing is metering this account. A task Juno starts on its own still stops at a small backstop ceiling, so an unattended loop can’t run all night.")
        } else if plan.isBrowseOnly {
            // No budget at all (a server from before Free's allowance): there
            // is nothing to meter, only the way out. Free with its small
            // allowance meters like every other plan.
            DesktopSettingsNote(text: "This plan has no usage included. Lite opens the everyday models; Pro opens every model, Code and agents.")
        } else {
            TimelineView(.periodic(from: .now, by: 30)) { timeline in
                VStack(spacing: 0) {
                    if let month = DesktopPlanMeters.month(plan) {
                        DesktopMeterRow(title: "This month", description: month.description, share: month.share)
                        Divider()
                    }
                    DesktopMeterRow(
                        title: "Current session",
                        description: DesktopPlanMeters.sessionSentence(resetsAt: plan.session.resetsAt, now: timeline.date),
                        share: plan.session.fraction
                    )
                    Divider()
                    DesktopMeterRow(
                        title: "This week",
                        description: DesktopPlanMeters.weekSentence(resetsAt: plan.weekly.resetsAt, now: timeline.date),
                        share: plan.weekly.fraction
                    )
                }
            }
        }
    }
}

/// The meters' words and numbers, as the web's billing section computes them.
enum DesktopPlanMeters {
    /// "€12.40 left of €20.00", and the month's share with held spend counted.
    static func month(_ plan: NativeUsagePlan) -> (description: String, share: Double)? {
        guard let budgetMicro = plan.spend.budgetMicroUsd else { return nil }
        let rate = (plan.spend.eurPerUsd ?? 1) > 0 ? (plan.spend.eurPerUsd ?? 1) : 1
        let spent = plan.spend.spentMicroUsd / 1_000_000 * rate
        let held = (plan.spend.reservedMicroUsd ?? 0) / 1_000_000 * rate
        let budget = budgetMicro / 1_000_000 * rate
        let remaining = Swift.max(0, budget - spent - held)
        let share = budget > 0 ? Swift.min(1, (spent + held) / budget) : 0
        return ("\(eur(remaining)) left of \(eur(budget))", share)
    }

    /// The web's `formatEur`: two decimals, and "<€0.01" for a sliver.
    static func eur(_ amount: Double) -> String {
        let format = FloatingPointFormatStyle<Double>.Currency(code: "EUR").locale(Locale(identifier: "en_US"))
        if amount > 0, amount < 0.01 { return "<\(0.01.formatted(format))" }
        return amount.formatted(format)
    }

    static func sessionSentence(resetsAt: Date?, now: Date) -> String {
        guard let resetsAt else { return "A rolling 5-hour window." }
        if resetsAt <= now { return "Resetting now." }
        return "Resets in \(countdown(resetsAt.timeIntervalSince(now)))"
    }

    static func weekSentence(resetsAt: Date?, now: Date) -> String {
        guard let resetsAt else { return "A rolling 7-day window." }
        if resetsAt <= now { return "Resetting now." }
        return "Resets \(resetsAt.formatted(.dateTime.weekday(.abbreviated).hour().minute()))"
    }

    /// The web's `formatCountdown`: "2 hr 14 min", "45 min", "3 days".
    static func countdown(_ seconds: TimeInterval) -> String {
        guard seconds > 0 else { return "now" }
        let totalMinutes = Int(seconds / 60)
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours >= 24 {
            let days = Int((Double(hours) / 24).rounded())
            return days == 1 ? "1 day" : "\(days) days"
        }
        if hours > 0 { return "\(hours) hr \(minutes) min" }
        return "\(minutes) min"
    }

    /// Accent, then the warning ink from 90%, then the destructive ink at the
    /// limit (the web's `meterTone`).
    static func tone(_ share: Double) -> Color {
        if share >= 1 { return .junoDestructiveInk }
        if share >= 0.9 { return .junoWarning }
        return .junoAccent
    }
}

/// One meter row: the label and its sentence, a bar and the percentage.
struct DesktopMeterRow: View {
    let title: String
    let description: String
    let share: Double

    var body: some View {
        let shown = Swift.min(100, Int((share * 100).rounded()))
        DesktopSettingRow(title: title, description: description) {
            HStack(spacing: JunoSpace.cozy) {
                DesktopMeterBar(fraction: Double(shown) / 100, tone: DesktopPlanMeters.tone(share))
                    .frame(width: 176)
                    .accessibilityElement()
                    .accessibilityLabel(title)
                    .accessibilityValue("\(shown) percent")
                Text("\(shown)%")
                    .junoType(.ui)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 40, alignment: .trailing)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, JunoSpace.hairline)
    }
}

/// A meter: the system's own linear progress bar in the row's tone. Native
/// rather than drawn, because it measures something (premium pass): the
/// platform's track, its Increase Contrast edge and its accessibility value.
struct DesktopMeterBar: View {
    let fraction: Double
    let tone: Color

    var body: some View {
        ProgressView(value: Swift.min(1, Swift.max(0, fraction)))
            .progressViewStyle(.linear)
            .tint(tone)
    }
}

// MARK: - Spend ceiling

/// The account's own monthly ceiling: whole euros, empty for the default.
struct DesktopSpendCeilingRow: View {
    let context: DesktopSettingsContext
    let plan: NativeUsagePlan

    @State private var draft = ""
    @State private var baseline: Int??

    private var stored: Int? { context.settings?.monthlySpendCapEur }

    private var parsed: Int?? {
        let trimmed = draft.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return .some(nil) }
        guard let value = Int(trimmed), (0...100_000).contains(value) else { return nil }
        return .some(value)
    }

    private var isValid: Bool { parsed != nil }
    private var isDirty: Bool {
        guard let parsed else { return false }
        return parsed != stored
    }

    var body: some View {
        if plan.spend.capDisabled == true {
            DesktopSettingsNote(
                text: "The spend ceiling is switched off for this account, so nothing caps what it can spend on models. Turn it back on before using the account normally.",
                tone: .warning
            )
        } else {
            DesktopSettingRow(
                title: "Monthly ceiling",
                description: description,
                status: context.saves.status("cap")
            ) {
                HStack(spacing: JunoSpace.snug) {
                    TextField("Monthly ceiling", text: $draft, prompt: Text("Default"))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .monospacedDigit()
                        .frame(width: 96)
                        .onSubmit(save)
                        .accessibilityLabel("Monthly ceiling in euros")
                    DesktopOutlineButton(title: "Save", action: save)
                        .disabled(!isValid || !isDirty)
                }
            }
            .task(id: stored) {
                let text = stored.map(String.init) ?? ""
                let last: Int? = baseline ?? nil
                if baseline == nil || draft == (last.map(String.init) ?? "") { draft = text }
                baseline = .some(stored)
            }
        }
    }

    private var description: String {
        guard isValid else { return "Enter a whole number of euros from 0 to 100,000." }
        var sentence = "\(Self.sourceNote(plan.spend.capSource))."
        if let month = plan.spend.budgetMicroUsd {
            let rate = (plan.spend.eurPerUsd ?? 1) > 0 ? (plan.spend.eurPerUsd ?? 1) : 1
            sentence += " Juno stops at \(DesktopPlanMeters.eur(month / 1_000_000 * rate)) this period. Leave the field empty to use the default; the lower of the two applies."
        }
        return sentence
    }

    /// The web's `describeCapSource`.
    static func sourceNote(_ source: String?) -> String {
        switch source {
        case "user": "Set by you"
        case "personal-default": "Juno's default for accounts without a plan budget"
        case "disabled": "Enforcement is switched off"
        default: "Set by your plan"
        }
    }

    private func save() {
        guard let parsed, isDirty else { return }
        let model = context.settingsModel
        let toasts = context.toasts
        let reload = context
        Task {
            let ok = await context.saves.track("cap") {
                let result = await model.saveSettings(NativeSettingsPatch(monthlySpendCapEur: .some(parsed)))
                if case .failed = result { toasts.post(.error("Couldn’t save the spend ceiling.")) }
                return result.succeeded
            }
            if ok { await reload.loadPlan() }
        }
    }
}

// MARK: - History

/// Thirty day bars of replies, with arrow keys (and VoiceOver's adjustable
/// action) to read a day (`usage-history.tsx`).
struct DesktopUsageHistory: View {
    let context: DesktopSettingsContext

    @State private var active: Int?
    @FocusState private var focused: Bool

    static let chartHeight: CGFloat = 72
    static let dayCount = 30

    struct Day: Equatable {
        let dayMs: Double
        let requests: Int
        let costMicroUsd: Int
    }

    /// Thirty days from the range's first, with empty days filled in.
    static func days(_ breakdown: NativeUsageBreakdown) -> [Day] {
        let dayMs = 86_400_000.0
        let byDay = Dictionary(breakdown.daily.map { ($0.dayMs, $0) }, uniquingKeysWith: { first, _ in first })
        let start = (breakdown.startMs / dayMs).rounded(.down) * dayMs
        return (0..<dayCount).map { index in
            let ms = start + Double(index) * dayMs
            let day = byDay[ms]
            return Day(dayMs: ms, requests: day?.requests ?? 0, costMicroUsd: day?.costMicroUsd ?? 0)
        }
    }

    private var showsCost: Bool { context.planID != "FREE" }

    private var rate: Double {
        let value = context.plan.value?.spend.eurPerUsd ?? 1
        return value > 0 ? value : 1
    }

    var body: some View {
        switch context.history {
        case .loading:
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                JunoSkeleton(height: 12, width: 240)
                JunoSkeleton(height: Self.chartHeight, cornerRadius: JunoRadius.control)
                JunoSkeleton(height: 10)
            }
            .padding(.vertical, JunoSpace.snug)
            .accessibilityHidden(true)
        case .failed:
            HStack(spacing: JunoSpace.cozy) {
                DesktopSettingsNote(text: "Your usage history couldn’t be loaded.")
                DesktopOutlineButton(title: "Try Again") { Task { await context.loadHistory() } }
            }
        case .loaded(let breakdown):
            chart(breakdown)
        }
    }

    private func chart(_ breakdown: NativeUsageBreakdown) -> some View {
        let days = Self.days(breakdown)
        let peak = Swift.max(1, days.map(\.requests).max() ?? 1)
        let busiest = days.enumerated().max { $0.element.requests < $1.element.requests }
        let busiestIndex = (busiest?.element.requests ?? 0) > 0 ? busiest?.offset : nil
        return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            summary(breakdown, days: days)
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(Array(days.enumerated()), id: \.offset) { index, day in
                    let isActive = active == index
                    let isBusiest = active == nil && busiestIndex == index
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(fill(day: day, active: isActive, busiest: isBusiest))
                        .frame(height: day.requests == 0 ? 2 : Swift.max(3, (Double(day.requests) / Double(peak) * Self.chartHeight).rounded()))
                        .frame(maxWidth: .infinity, maxHeight: Self.chartHeight, alignment: .bottom)
                        .contentShape(.rect)
                        .onHover { inside in
                            if inside { active = index } else if active == index { active = nil }
                        }
                }
            }
            .frame(height: Self.chartHeight)
            .animation(JunoMotion.fast, value: active)
            .focusable()
            .focused($focused)
            .onKeyPress(.leftArrow) { move(-1, count: days.count); return .handled }
            .onKeyPress(.rightArrow) { move(1, count: days.count); return .handled }
            .onChange(of: focused) { _, isFocused in if !isFocused { active = nil } }
            .accessibilityElement()
            .accessibilityLabel("Replies per day, last 30 days. Use the arrow keys to read a day.")
            .accessibilityValue(active.map { daySentence(days[$0]) } ?? "")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: move(1, count: days.count)
                case .decrement: move(-1, count: days.count)
                @unknown default: break
                }
            }
            HStack {
                Text(Self.shortDay(days.first?.dayMs ?? breakdown.startMs))
                Spacer()
                Text("Today")
            }
            .junoType(.caption)
            .foregroundStyle(Color.junoSecondaryInk)
            .accessibilityHidden(true)
        }
        .padding(.vertical, JunoSpace.snug)
    }

    private func fill(day: Day, active: Bool, busiest: Bool) -> Color {
        if day.requests == 0 { return .junoBorder }
        if active || busiest { return .junoAccent }
        return Color.junoSecondaryInk.opacity(self.active == nil ? 0.45 : 0.35)
    }

    private func move(_ delta: Int, count: Int) {
        let at = active ?? (count - 1)
        active = Swift.min(count - 1, Swift.max(0, at + delta))
    }

    @ViewBuilder
    private func summary(_ breakdown: NativeUsageBreakdown, days: [Day]) -> some View {
        Group {
            if let active, days.indices.contains(active) {
                Text(daySentence(days[active]))
            } else if breakdown.totals.requests == 0 {
                Text("Nothing in the last 30 days.")
            } else {
                Text(totalsSentence(breakdown))
            }
        }
        .junoType(.ui)
        .monospacedDigit()
        .foregroundStyle(Color.junoSecondaryInk)
        .frame(minHeight: 20, alignment: .leading)
    }

    private func daySentence(_ day: Day) -> String {
        var parts = [Self.shortDay(day.dayMs), "\(day.requests.formatted()) \(day.requests == 1 ? "reply" : "replies")"]
        if showsCost { parts.append(DesktopPlanMeters.eur(Double(day.costMicroUsd) / 1_000_000 * rate)) }
        return parts.joined(separator: " · ")
    }

    private func totalsSentence(_ breakdown: NativeUsageBreakdown) -> String {
        let totals = breakdown.totals
        var parts = [
            "\(totals.requests.formatted()) \(totals.requests == 1 ? "reply" : "replies")",
            "\(totals.totalTokens.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))) tokens",
        ]
        if showsCost { parts.append(DesktopPlanMeters.eur(Double(totals.costMicroUsd) / 1_000_000 * rate)) }
        parts.append("last 30 days")
        return parts.joined(separator: " · ")
    }

    static func shortDay(_ ms: Double) -> String {
        var style = Date.FormatStyle.dateTime.month(.abbreviated).day()
        style.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return Date(timeIntervalSince1970: ms / 1000).formatted(style)
    }
}
