import AppKit
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI

// MARK: - Plans

/// The Mac's names for the shared plan catalogue (`JunoPlanCatalog` in
/// JunoCore, a Swift copy of `src/lib/plans.ts`): the names, prices, taglines
/// and features the Upgrade sheet and Plan & usage draw.
enum DesktopPlanCatalog {
    typealias Plan = JunoPlanInfo

    static let free = JunoPlanCatalog.free
    static let lite = JunoPlanCatalog.lite
    static let pro = JunoPlanCatalog.pro
    static let plus = JunoPlanCatalog.plus
    static let max = JunoPlanCatalog.max
    static let max20 = JunoPlanCatalog.max20
    static let ultra = JunoPlanCatalog.ultra
    static let owner = JunoPlanCatalog.owner

    static let all = JunoPlanCatalog.all

    /// The everyday plans, the sheet's first group.
    static let everyday: [Plan] = [lite, pro, plus]
    /// The plans that buy more of Pro, the sheet's second group.
    static let moreUsage: [Plan] = [max, max20, ultra]

    /// A known plan for a server id, however it is cased; nil otherwise.
    static func plan(id: String?) -> Plan? {
        JunoPlanTier(serverID: id)?.info
    }

    /// A tax-included amount: "€24", "€10.80" — "24 €" in French.
    static func price(cents: Int, locale: Locale = .current) -> String {
        JunoPlanPrice.format(cents: cents, locale: locale)
    }

    /// The FAQ under the plans.
    static let questions: [(question: String, answer: String)] = [
        ("What does a plan actually buy?", "A monthly budget of real model usage, metered at the providers’ own list prices. Every reply shows its cost on the receipt. Light models stretch the budget; frontier models spend it faster — your call, visibly."),
        ("Which models come with each plan?", "Free has a small monthly allowance on the fastest models. Lite opens the everyday models and web search. Pro and every plan above it open every model, Code, agents, deep research and voice; Plus, Max and Ultra add more monthly usage and priority."),
        ("What does yearly billing save?", "A year costs ten months: two months free, billed once. You can switch between monthly and yearly from the billing portal."),
        ("Is VAT included?", JunoPlanPrice.vatNote),
        ("Can I change or cancel later?", "Any time. Upgrades apply instantly. If you cancel, paid features stay on until the end of the billing period you have already paid for, and your data stays yours to export."),
    ]
}

// MARK: - Plan gate

/// The account's plan as the Mac last read it, and the one gate every locked
/// entry point asks: Code, agents, research, voice and web search.
///
/// Until a plan has been read the gate is open — the server enforces its own
/// gates, and a paying customer must never meet an upgrade prompt because the
/// usage route was slow. A plan id this build does not know is open too
/// (`JunoAccountPlan.includes`).
@MainActor
@Observable
final class DesktopPlanGate {
    static let shared = DesktopPlanGate()

    private(set) var plan: JunoAccountPlan?

    init(plan: JunoAccountPlan? = nil) {
        self.plan = plan
    }

    /// Records a plan read from the usage route.
    func update(planID: String?) {
        guard let planID else { return }
        let next = JunoAccountPlan(serverID: planID)
        if next != plan { plan = next }
    }

    func allows(_ feature: JunoPlanFeature) -> Bool {
        plan?.includes(feature) ?? true
    }

    /// True when the plan includes `feature`; otherwise opens the Upgrade
    /// sheet on the plan that does, and returns false.
    @discardableResult
    func require(_ feature: JunoPlanFeature, presenter: DesktopUpgradePresenter = .shared) -> Bool {
        if allows(feature) { return true }
        presenter.present(for: feature)
        return false
    }
}

/// A page whose feature the plan does not include: what it is, the plan that
/// unlocks it, and the one button that opens the Upgrade sheet there. Shown in
/// place of the page, never instead of the row that leads to it — a locked
/// destination stays in the sidebar.
struct DesktopPlanLockedPage: View {
    let feature: JunoPlanFeature
    let title: String
    let icon: JunoIcon
    var presenter: DesktopUpgradePresenter = .shared

    var body: some View {
        JunoEmptyState(
            title: title,
            message: feature.upgradePrompt,
            icon: icon
        ) {
            Button(feature.upgradeAction) { presenter.present(for: feature) }
                .buttonStyle(.junoProminent)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.desktop.locked.\(feature.rawValue)")
        }
    }
}

// MARK: - Presenter

/// Presents the one Upgrade sheet over the window that asked for it — the
/// Chat window (through `.desktopFirstRunSheets(_:)`) or Settings. `present()`
/// is what every seam calls (brief §2.3, seams 4 and 12).
@MainActor
@Observable
final class DesktopUpgradePresenter {
    static let shared = DesktopUpgradePresenter()

    enum Host: Equatable {
        case chat
        case settings
    }

    /// Which window's sheet is up, or nil.
    var presented: Host?
    /// The locked feature that opened the sheet, when one did: the sheet
    /// leads with it and with the plan that unlocks it.
    var reason: JunoPlanFeature?

    init() {}

    /// Opens the sheet over the key window.
    func present() {
        present(in: Self.keyWindowIsSettings ? .settings : .chat)
    }

    func present(in host: Host) {
        reason = nil
        presented = host
    }

    /// Opens the sheet because `feature` is locked on this plan.
    func present(for feature: JunoPlanFeature) {
        present(in: Self.keyWindowIsSettings ? .settings : .chat)
        reason = feature
    }

    func dismiss() {
        presented = nil
        reason = nil
    }

    func binding(for host: Host) -> Binding<Bool> {
        Binding(
            get: { self.presented == host },
            set: { if !$0, self.presented == host { self.presented = nil } }
        )
    }

    private static var keyWindowIsSettings: Bool {
        NSApp.keyWindow?.identifier?.rawValue.localizedCaseInsensitiveContains("settings") == true
    }
}

extension View {
    /// Attaches the Upgrade sheet to a window. `host` says which window this is.
    func desktopUpgradeSheet(
        host: DesktopUpgradePresenter.Host,
        sender: (any NativeAuthenticatedRequestSending)?,
        accountID: AccountID?
    ) -> some View {
        modifier(DesktopUpgradeSheetModifier(host: host, sender: sender, accountID: accountID))
    }
}

private struct DesktopUpgradeSheetModifier: ViewModifier {
    let host: DesktopUpgradePresenter.Host
    let sender: (any NativeAuthenticatedRequestSending)?
    let accountID: AccountID?

    @State private var presenter = DesktopUpgradePresenter.shared

    func body(content: Content) -> some View {
        content.sheet(isPresented: presenter.binding(for: host)) {
            DesktopUpgradeSheet(
                model: DesktopUpgradeModel(
                    sender: sender,
                    accountID: accountID,
                    currentPlanID: DesktopPlanGate.shared.plan?.id
                ),
                reason: presenter.reason,
                done: { presenter.dismiss() }
            )
        }
    }
}

// MARK: - Model

/// The current plan, and checkout or the portal for one card at a time.
@MainActor
@Observable
final class DesktopUpgradeModel {
    let sender: (any NativeAuthenticatedRequestSending)?
    let accountID: AccountID?

    var currentPlanID: String?
    /// The card whose checkout is opening in the browser.
    var redirecting: String?
    /// A failure, under the card it belongs to (no toasts in a sheet).
    var failure: (planID: String, message: String)?

    init(sender: (any NativeAuthenticatedRequestSending)?, accountID: AccountID?, currentPlanID: String? = nil) {
        self.sender = sender
        self.accountID = accountID
        self.currentPlanID = currentPlanID
    }

    /// Monthly or yearly — what every price on the sheet and checkout use.
    var interval: JunoBillingInterval = .month

    var currentPlan: JunoAccountPlan { JunoAccountPlan(serverID: currentPlanID) }

    func load() async {
        guard let sender, let accountID else { return }
        guard let id = await NativeUsageClient(sender: sender).loadPlan(for: accountID)?.planID else { return }
        currentPlanID = id.uppercased()
        DesktopPlanGate.shared.update(planID: id)
    }

    func checkout(_ plan: DesktopPlanCatalog.Plan) {
        guard let sender, let accountID, let billingPlan = NativeBillingClient.Plan(rawValue: plan.id) else { return }
        let interval: NativeBillingClient.Interval = self.interval == .year ? .year : .month
        redirecting = plan.id
        failure = nil
        Task {
            do {
                let url = try await NativeBillingClient(sender: sender).checkout(plan: billingPlan, interval: interval, for: accountID)
                NSWorkspace.shared.open(url)
            } catch {
                redirecting = nil
                failure = (plan.id, NativeFailureMessage.presentable(error))
            }
        }
    }

    /// The billing portal, where a subscription is changed, moved to yearly
    /// or cancelled. A failure lands under `planID`'s row, or nowhere visible
    /// but the footer's own button when nil.
    func manage(planID: String? = nil) {
        guard let sender, let accountID else { return }
        failure = nil
        Task {
            do {
                NSWorkspace.shared.open(try await NativeBillingClient(sender: sender).portal(for: accountID))
            } catch {
                failure = (planID ?? "", NativeFailureMessage.presentable(error))
            }
        }
    }
}

// MARK: - Sheet

/// Upgrade (`src/app/(app)/upgrade/page.tsx`) as a native sheet: the six plans
/// for sale as a ledger in two groups — the everyday plans, then the ones that
/// buy more of Pro — with Monthly and Yearly over both.
///
/// Calm on purpose (owner rules): no status pills or dots, two weights, the
/// system sheet's own glass. The current plan is said in the header and on its
/// own disabled button.
///
/// Signature detail: one coral button on the whole sheet — the plan the
/// reader most likely wants (Pro, or the plan that unlocks the feature that
/// opened the sheet) — so the choice reads before the prices do, and the
/// prices sit in one right-aligned column of tabular figures so the ladder
/// from Lite to Ultra reads as a single scale.
struct DesktopUpgradeSheet: View {
    @State var model: DesktopUpgradeModel
    var reason: JunoPlanFeature?
    let done: () -> Void

    /// Fixed for the snapshot tests; the reader's own otherwise.
    var locale: Locale = .current
    /// The sheet's height; a snapshot draws it taller to show every row.
    var height: CGFloat = 680

    private var current: JunoAccountPlan { model.currentPlan }

    /// The plan that gets the sheet's one prominent button.
    private var recommended: JunoPlanTier? {
        let target = reason?.minimumTier ?? .pro
        // Already there or above: nothing is pushed.
        if current.isAtLeast(target) {
            return current.upgrades.first
        }
        return target
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.section) {
                    header
                    intervalRow
                    group("Everyday", plans: DesktopPlanCatalog.everyday)
                    group("More usage", note: "The same plan as Pro, with more of it every month.", plans: DesktopPlanCatalog.moreUsage)
                    Text(JunoPlanPrice.vatNote)
                        .junoType(.label.weight(.regular))
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                    questions
                    terms
                }
                .padding(JunoSpace.region)
            }
            Divider()
            HStack(spacing: JunoSpace.snug) {
                if current.isPaid {
                    Button("Manage Billing") { model.manage() }
                        .buttonStyle(.bordered)
                        .tint(nil)
                        .contentShape(.rect)
                }
                Spacer()
                Button("Done", action: done)
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
            }
            .padding(.horizontal, JunoSpace.section)
            .padding(.vertical, JunoSpace.regular)
        }
        .frame(width: 720, height: height)
        .presentationSizing(.page)
        .task { await model.load() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
            model.redirecting = nil
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(reason.map { "\($0.title) comes with \($0.minimumTier.info.name)" } ?? "Plans")
                .junoType(.pageTitle)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            Text(headerSentence)
                .junoType(.body)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var headerSentence: AttributedString {
        var sentence = AttributedString("You’re on ")
        var name = AttributedString(current.displayName)
        name.foregroundColor = Color.junoForeground
        sentence += name
        sentence += AttributedString(". ")
        if let reason {
            sentence += AttributedString("\(reason.upgradePrompt) Upgrades apply the moment checkout completes.")
        } else {
            sentence += AttributedString("Every plan is a monthly budget of real model usage. Upgrades apply the moment checkout completes.")
        }
        return sentence
    }

    private var intervalRow: some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoSegmented(
                options: [JunoSegmentedOption(JunoBillingInterval.month, "Monthly"), JunoSegmentedOption(JunoBillingInterval.year, "Yearly")],
                selection: $model.interval,
                accessibilityLabel: "Billing"
            )
            .fixedSize()
            Text(JunoPlanPrice.annualOffer.prefix(1).uppercased() + JunoPlanPrice.annualOffer.dropFirst() + " on yearly billing")
                .junoType(.label.weight(.regular))
                .foregroundStyle(model.interval == .year ? Color.junoForeground : Color.junoSecondaryInk)
        }
    }

    // MARK: Groups

    private func group(_ title: String, note: String? = nil, plans: [DesktopPlanCatalog.Plan]) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(title)
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                if let note {
                    Text(note)
                        .junoType(.label.weight(.regular))
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
            VStack(spacing: 0) {
                ForEach(plans) { plan in
                    row(plan)
                    if plan.id != plans.last?.id {
                        Divider().padding(.horizontal, JunoSpace.roomy)
                    }
                }
            }
            .background(Color.junoCard, in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
        }
    }

    private func row(_ plan: DesktopPlanCatalog.Plan) -> some View {
        HStack(alignment: .center, spacing: JunoSpace.section) {
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(plan.name)
                    .junoType(JunoType.bodyLarge.weight(.semibold))
                    .foregroundStyle(Color.junoForeground)
                Text(plan.tagline)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                Text(Self.highlights(plan))
                    .junoType(.label.weight(.regular))
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, JunoSpace.micro)
                if let failure = model.failure, failure.planID == plan.id {
                    Text(failure.message)
                        .junoType(.label.weight(.regular))
                        .foregroundStyle(Color.junoDestructiveInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, JunoSpace.micro)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            price(plan)
                .frame(width: 170, alignment: .trailing)
            action(plan)
                .frame(width: 148)
        }
        .padding(.horizontal, JunoSpace.roomy)
        .padding(.vertical, JunoSpace.regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.upgrade.\(plan.id.lowercased())")
    }

    /// The row's third line: what this plan adds, in a few words.
    static func highlights(_ plan: DesktopPlanCatalog.Plan) -> String {
        switch plan.tier {
        case .lite: "Everyday models · Web search"
        case .pro: "Every model · Code, agents, research"
        case .plus: "2.5× Pro’s usage · Higher priority"
        case .max: "5× Pro’s usage · Highest priority"
        case .max20: "10× Pro’s usage · Highest priority"
        case .ultra: "25× Pro’s usage · Uploads up to 200 MB"
        case .free, .owner: plan.features.prefix(2).joined(separator: " · ")
        }
    }

    private func price(_ plan: DesktopPlanCatalog.Plan) -> some View {
        let yearly = model.interval == .year
        let amount = yearly ? plan.price.yearlyPerMonth(locale: locale) : plan.price.monthly(locale: locale)
        return VStack(alignment: .trailing, spacing: JunoSpace.micro) {
            Text(amount)
                .junoFont(size: 22, relativeTo: .title, weight: .semibold)
                .monospacedDigit()
                .foregroundStyle(Color.junoForeground)
                .contentTransition(.numericText())
            Text(yearly ? "a month · \(plan.price.yearly(locale: locale)) a year" : "a month")
                .junoType(.label.weight(.regular))
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
        }
        .animation(JunoMotion.fast, value: yearly)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func action(_ plan: DesktopPlanCatalog.Plan) -> some View {
        let tier = plan.tier
        if current.tier == tier {
            Button {} label: {
                Text("Current Plan").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(nil)
            .disabled(true)
            .contentShape(.rect)
        } else if current.upgrades.contains(tier) {
            let label = model.redirecting == plan.id ? "Redirecting…" : "Upgrade"
            if tier == recommended {
                Button { model.checkout(plan) } label: {
                    Text(label).frame(maxWidth: .infinity)
                }
                .buttonStyle(.junoProminent)
                .contentShape(.rect)
                .disabled(model.redirecting != nil)
            } else {
                Button { model.checkout(plan) } label: {
                    Text(label).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(nil)
                .disabled(model.redirecting != nil)
                .contentShape(.rect)
            }
        } else {
            // Below the current plan, or any plan when this build does not
            // know the current one: the portal changes a subscription.
            Button { model.manage(planID: plan.id) } label: {
                Text("Switch").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(nil)
            .contentShape(.rect)
        }
    }

    // MARK: Questions

    private var questions: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("Questions")
                .junoType(.heading)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(DesktopPlanCatalog.questions, id: \.question) { entry in
                    DisclosureGroup {
                        Text(entry.answer)
                            .junoType(.ui)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.vertical, JunoSpace.tight)
                    } label: {
                        Text(entry.question)
                            .junoType(.ui)
                            .foregroundStyle(Color.junoForeground)
                    }
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.close)
                    if entry.question != DesktopPlanCatalog.questions.last?.question {
                        Divider().padding(.horizontal, JunoSpace.cozy)
                    }
                }
            }
            .background(Color.junoSecondary, in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        }
    }

    private var terms: some View {
        let base = JunoBackend.productionURLString
        let markdown = "By subscribing you accept the [terms of service](\(base)/legal/cgu) and the [privacy policy](\(base)/legal/confidentialite), and ask for your subscription to start at once: the 14-day right of withdrawal ends when it does."
        return Text((try? AttributedString(markdown: markdown)) ?? AttributedString(markdown))
            .junoType(.label.weight(.regular))
            .foregroundStyle(Color.junoSecondaryInk)
            .tint(Color.junoAccentInk)
            .fixedSize(horizontal: false, vertical: true)
    }
}
