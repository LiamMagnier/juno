import AppKit
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI

// MARK: - Plans

/// A Swift copy of `src/lib/plans.ts`: the names, prices, taglines, message
/// caps and features the Upgrade sheet and Plan & usage draw.
/// `DesktopPlanCatalogTests` pins it to the web's values.
enum DesktopPlanCatalog {
    struct Plan: Identifiable, Equatable {
        let id: String
        let name: String
        /// Whole euros a month, excluding VAT.
        let price: Int
        let tagline: String
        let monthlyMessages: Int?
        let voice: Bool
        let features: [String]
        /// `planRank`.
        let rank: Int
    }

    static let free = Plan(
        id: "FREE", name: "Free", price: 0,
        tagline: "Try Juno with 15 messages a month.",
        monthlyMessages: 15, voice: false,
        features: [
            "15 messages a month to try Juno, free",
            "Everyday models (Claude Sonnet, GPT Mini, Gemini Flash…)",
            "Canvas, artifacts & file uploads",
            "Import your ChatGPT or Claude history",
            "Export everything you own, any time",
        ],
        rank: 0
    )

    static let pro = Plan(
        id: "PRO", name: "Pro", price: 20,
        tagline: "For everyday power use.",
        monthlyMessages: nil, voice: true,
        features: [
            "Access to every model (Claude Opus, GPT-5.5, Gemini Pro, GLM, Kimi)",
            "Monthly usage limit based on tokens",
            "Voice mode & voice-to-chat",
            "Memory across conversations",
            "Canvas, artifacts & file uploads",
            "Priority streaming",
        ],
        rank: 1
    )

    static let max = Plan(
        id: "MAX", name: "Max ×5", price: 100,
        tagline: "For professionals who live in Juno.",
        monthlyMessages: nil, voice: true,
        features: [
            "Access to every model, at highest priority",
            "5× more tokens than Pro every month",
            "Voice mode & voice-to-chat",
            "Memory across conversations",
            "Canvas, artifacts & file uploads",
            "Highest priority access",
        ],
        rank: 2
    )

    static let max20 = Plan(
        id: "MAX20", name: "Max ×10", price: 200,
        tagline: "For teams of one who never stop.",
        monthlyMessages: nil, voice: true,
        features: [
            "Access to every model, at highest priority",
            "The most tokens of any plan — for your heaviest days",
            "Voice mode & voice-to-chat",
            "Memory across conversations",
            "Canvas, artifacts & file uploads",
        ],
        rank: 3
    )

    static let owner = Plan(
        id: "OWNER", name: "Owner", price: 0,
        tagline: "Full, unlimited access to everything.",
        monthlyMessages: nil, voice: true,
        features: [
            "Unlimited messages & tokens",
            "Every model, incl. experimental",
            "No rate limits",
            "Uploads up to 1 GB",
            "All current and future features",
        ],
        rank: 4
    )

    static let all = [free, pro, max, max20, owner]

    static func plan(id: String?) -> Plan? {
        guard let id else { return nil }
        return all.first { $0.id == id.uppercased() }
    }

    /// The web's `formatEurWhole`: "€20".
    static func price(_ euros: Int) -> String {
        euros.formatted(.currency(code: "EUR").precision(.fractionLength(0)).locale(Locale(identifier: "en_US")))
    }

    /// The FAQ, less the Yearly question, which the web shows only when annual
    /// plans are for sale (the Mac offers Monthly only, P3-8).
    static let questions: [(question: String, answer: String)] = [
        ("What does a plan actually buy?", "A monthly budget of real model usage, metered at the providers' own list prices. Every reply shows its cost on the receipt. Light models stretch the budget; frontier models spend it faster — your call, visibly."),
        ("Which models come with each plan?", "Free gets the everyday models — Claude Sonnet, GPT Mini, Gemini Flash and friends. Every paid plan unlocks the whole lineup, flagships included; Max tiers add more monthly headroom and the highest priority."),
        ("Can I change or cancel later?", "Any time. Upgrades apply instantly. If you cancel, paid features stay on until the end of the billing period you have already paid for, and your data stays yours to export."),
        ("What does fair use mean?", "Fair use keeps Juno fast for everyone. If your usage ever looks like it needs a conversation, we reach out first — nothing changes on your account without notice."),
    ]
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

    init() {}

    /// Opens the sheet over the key window.
    func present() {
        present(in: Self.keyWindowIsSettings ? .settings : .chat)
    }

    func present(in host: Host) {
        presented = host
    }

    func dismiss() {
        presented = nil
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
                model: DesktopUpgradeModel(sender: sender, accountID: accountID),
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

    func load() async {
        guard currentPlanID == nil, let sender, let accountID else { return }
        currentPlanID = await NativeUsageClient(sender: sender).loadPlan(for: accountID)?.planID.uppercased()
    }

    func checkout(_ plan: DesktopPlanCatalog.Plan) {
        guard let sender, let accountID, let billingPlan = NativeBillingClient.Plan(rawValue: plan.id) else { return }
        redirecting = plan.id
        failure = nil
        Task {
            do {
                let url = try await NativeBillingClient(sender: sender).checkout(plan: billingPlan, for: accountID)
                NSWorkspace.shared.open(url)
            } catch {
                redirecting = nil
                failure = (plan.id, NativeFailureMessage.presentable(error))
            }
        }
    }

    func manage(from plan: DesktopPlanCatalog.Plan) {
        guard let sender, let accountID else { return }
        failure = nil
        Task {
            do {
                NSWorkspace.shared.open(try await NativeBillingClient(sender: sender).portal(for: accountID))
            } catch {
                failure = (plan.id, NativeFailureMessage.presentable(error))
            }
        }
    }
}

// MARK: - Sheet

/// Upgrade (`src/app/(app)/upgrade/page.tsx`) as a native sheet: Monthly only
/// until the server says which plans and intervals are for sale (P3-8).
///
/// Signature detail: the recommended card is the only one with a coral button,
/// so the choice reads before the prices do.
struct DesktopUpgradeSheet: View {
    @State var model: DesktopUpgradeModel
    let done: () -> Void

    @State private var maxTier = "MAX"

    private var current: String { model.currentPlanID ?? "FREE" }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.section) {
                    header
                    HStack(alignment: .top, spacing: JunoSpace.regular) {
                        card(DesktopPlanCatalog.free, recommended: false)
                        card(DesktopPlanCatalog.pro, recommended: true)
                        card(maxTier == "MAX20" ? DesktopPlanCatalog.max20 : DesktopPlanCatalog.max, recommended: false, isMax: true)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: JunoSpace.tight) {
                        JunoIconView(.info, size: 13)
                        Text("Fair-use applies to keep Juno fast for everyone; we’ll always reach out before anything changes.")
                    }
                    .junoType(.label.weight(.regular))
                    .foregroundStyle(Color.junoSecondaryInk)
                    questions
                    terms
                }
                .padding(JunoSpace.region)
            }
            Divider()
            HStack {
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
        .frame(width: 760, height: 640)
        .presentationSizing(.page)
        .task {
            await model.load()
            if model.currentPlanID == "MAX20" { maxTier = "MAX20" }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
            model.redirecting = nil
        }
    }

    private var currentName: String {
        current == "OWNER" ? "Owner" : (DesktopPlanCatalog.plan(id: current)?.name ?? "Free")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("Upgrade")
                .junoType(.pageTitle)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            Text("You’re on the \(Text(currentName).foregroundStyle(Color.junoForeground)) plan. Every paid plan unlocks all models with a monthly limit based on tokens — upgrade any time, changes apply instantly.")
                .junoType(.body)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func card(_ plan: DesktopPlanCatalog.Plan, recommended: Bool, isMax: Bool = false) -> some View {
        let isCurrent = plan.id == current
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: JunoSpace.snug) {
                Text(isMax ? "Max" : plan.name)
                    .junoType(JunoType.bodyLarge.weight(.semibold))
                    .foregroundStyle(Color.junoForeground)
                if isCurrent {
                    pill("Current plan")
                } else if recommended {
                    pill("Recommended")
                }
                Spacer(minLength: 0)
                if isMax {
                    JunoSegmented(
                        options: [JunoSegmentedOption("MAX", "×5"), JunoSegmentedOption("MAX20", "×10")],
                        selection: $maxTier,
                        accessibilityLabel: "Max tier"
                    )
                    .fixedSize()
                }
            }
            .frame(minHeight: 32)
            Text(plan.tagline)
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                // Two lines reserved, so the three prices sit on one line.
                .lineLimit(2)
                .frame(height: 40, alignment: .topLeading)
                .padding(.top, JunoSpace.micro)
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                Text("\(plan.price) €")
                    .junoFont(size: 26, relativeTo: .largeTitle, weight: .semibold)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoForeground)
                Text(plan.id == "FREE" ? "/ mo" : "excl. VAT / mo")
                    .junoType(.label.weight(.regular))
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .padding(.top, JunoSpace.cozy)
            action(plan, recommended: recommended)
                .padding(.top, JunoSpace.cozy)
            if let failure = model.failure, failure.planID == plan.id {
                Text(failure.message)
                    .junoType(.label.weight(.regular))
                    .foregroundStyle(Color.junoDestructiveInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, JunoSpace.snug)
            }
            Divider()
                .padding(.vertical, JunoSpace.regular)
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                ForEach(plan.features, id: \.self) { feature in
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        JunoIconView(.check, size: 13)
                            .foregroundStyle(Color.junoSecondaryInk)
                        Text(feature)
                            .junoType(.label.weight(.regular))
                            .foregroundStyle(Color.junoForeground)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(JunoSpace.roomy)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.junoCard, in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
    }

    private func pill(_ text: String) -> some View {
        Text(text)
            .junoType(.label)
            .foregroundStyle(Color.junoSecondaryInk)
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.micro)
            .background(Color.junoSecondary, in: Capsule())
    }

    @ViewBuilder
    private func action(_ plan: DesktopPlanCatalog.Plan, recommended: Bool) -> some View {
        let currentRank = DesktopPlanCatalog.plan(id: current)?.rank ?? 0
        if plan.id == current {
            Button {} label: {
                Text("Current Plan").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(nil)
            .disabled(true)
            .contentShape(.rect)
        } else if plan.id == "FREE" {
            Button { model.manage(from: plan) } label: {
                Text("Downgrade").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(nil)
            .contentShape(.rect)
        } else if plan.rank > currentRank {
            let label = model.redirecting == plan.id ? "Redirecting…" : "Upgrade to \(plan.name)"
            if recommended {
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
            Button { model.manage(from: plan) } label: {
                Text("Manage").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(nil)
            .contentShape(.rect)
        }
    }

    private var questions: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("Questions")
                .junoType(.heading)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            Text("The short version of the terms, before you agree to them.")
                .junoType(.body)
                .foregroundStyle(Color.junoSecondaryInk)
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
                            .junoType(JunoType.ui.weight(.medium))
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
        let markdown = "By subscribing you accept the [terms of service](\(base)/legal/cgu) and the [privacy policy](\(base)/legal/confidentialite)."
        return Text((try? AttributedString(markdown: markdown)) ?? AttributedString(markdown))
            .junoType(.label.weight(.regular))
            .foregroundStyle(Color.junoSecondaryInk)
            .tint(Color.junoAccentInk)
    }
}
