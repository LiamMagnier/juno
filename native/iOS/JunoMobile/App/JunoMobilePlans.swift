import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import StoreKit
import SwiftUI

// The iPhone's side of the plan lineup: the account's plan, the gate every
// locked entry point asks (Code, agents, research, voice, web search), and the
// plans page the gate opens. Names, prices and gates come from the shared
// catalogue (`JunoPlans.swift` in JunoCore); purchases go through StoreKit
// (`JunoStoreKit.swift`) and are verified by the server.

// MARK: - Store

/// What the plans page was opened for: a locked feature, or nothing (Settings).
struct JunoMobilePaywallRequest: Identifiable, Equatable {
  let id = UUID()
  let feature: JunoPlanFeature?
}

/// The account's plan as the app last read it, and the plans page's presenter.
///
/// Until a plan has been read the gate is open: the server enforces its own
/// gates, and a paying customer must never meet a paywall because the usage
/// route was slow. A plan id this build does not know is open too.
@MainActor
@Observable
final class JunoMobilePlanStore {
  static let shared = JunoMobilePlanStore()

  private(set) var plan: JunoAccountPlan?
  /// The plans page, when it is up.
  var paywall: JunoMobilePaywallRequest?

  init(plan: JunoAccountPlan? = nil) {
    self.plan = plan
  }

  func update(planID: String?) {
    guard let planID else { return }
    let next = JunoAccountPlan(serverID: planID)
    if next != plan { plan = next }
  }

  func allows(_ feature: JunoPlanFeature) -> Bool {
    plan?.includes(feature) ?? true
  }

  /// True when the plan includes `feature`; otherwise opens the plans page on
  /// the plan that does, and returns false.
  @discardableResult
  func require(_ feature: JunoPlanFeature) -> Bool {
    if allows(feature) { return true }
    paywall = JunoMobilePaywallRequest(feature: feature)
    return false
  }

  func showPlans() {
    paywall = JunoMobilePaywallRequest(feature: nil)
  }

  /// Reads the plan from the usage route.
  func refresh(sender: any NativeAuthenticatedRequestSending, accountID: AccountID) async {
    guard let loaded = await NativeUsageClient(sender: sender).loadPlan(for: accountID) else { return }
    update(planID: loaded.planID)
  }
}

// MARK: - App Store sync

enum JunoMobileAppStoreSync {
  /// Hands a verified purchase to the server (`POST /api/v1/billing/app-store`)
  /// and reads back the plan it granted.
  static func handler(
    sender: any NativeAuthenticatedRequestSending,
    accountID: AccountID
  ) -> @Sendable (String) async throws -> JunoSubscriptionState {
    { jws in
      let body = try JSONSerialization.data(withJSONObject: ["signedTransactionInfo": jws])
      let response = try await sender.send(
        try NativeBearerRequest(
          path: "/api/v1/billing/app-store",
          method: .post,
          headers: try HTTPHeaders(["content-type": "application/json", "accept": "application/json"]),
          body: body
        ),
        for: accountID
      )
      guard (200...299).contains(response.statusCode) else {
        throw NativeWebRouteError(statusCode: response.statusCode, message: "The App Store purchase couldn’t be confirmed.")
      }
      return state(from: response.body)
    }
  }

  /// `{ subscription: { plan, status, productId } }` → a subscription state.
  static func state(from body: Data) -> JunoSubscriptionState {
    let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    let subscription = object?["subscription"] as? [String: Any]
    let plan = JunoAccountPlan(serverID: subscription?["plan"] as? String)
    let productID = subscription?["productId"] as? String
    let status = (subscription?["status"] as? String)?.uppercased()
    return JunoSubscriptionState(
      tier: plan.tier.flatMap(JunoSubscriptionTier.init(planTier:))
        ?? productID.map(JunoStoreKitProductIDs.tier(for:)) ?? .free,
      isActive: status == "ACTIVE" && plan.isPaid,
      productID: productID,
      willAutoRenew: plan.isPaid,
      plan: plan
    )
  }
}

// MARK: - Plans page

/// The plans page: the six plans for sale in two groups, Monthly or Yearly
/// over both, one selected row and one button.
///
/// Calm on purpose (owner rules): native Liquid Glass for the button and the
/// rows, no status pills or dots, two weights. The selected row is told by its
/// accent hairline and a check, never by a badge.
///
/// Signature detail: the button carries the whole decision — plan, price and
/// interval in one line ("Continue with Pro · €24 a month") — so nothing has
/// to be read twice.
struct JunoMobilePlansView: View {
  var reason: JunoPlanFeature?
  var store: JunoMobilePlanStore = .shared
  /// Nil in previews and snapshots: prices come from the catalogue and the
  /// button explains that purchases are unavailable.
  var purchaser: (any JunoStoreKitManaging)? = JunoStoreKitManager.shared
  var locale: Locale = .current
  let done: () -> Void

  @State private var interval: JunoBillingInterval = .month
  @State private var selected: JunoPlanTier?
  @State private var products: [String: Product] = [:]
  @State private var purchasing = false
  @State private var message: String?

  private var current: JunoAccountPlan { store.plan ?? .free }

  /// The row selected when the page opens: the plan that unlocks the reason,
  /// else Pro, else the next plan up.
  static func initialSelection(current: JunoAccountPlan, reason: JunoPlanFeature?) -> JunoPlanTier? {
    let target = reason?.minimumTier ?? .pro
    if current.isAtLeast(target) { return current.upgrades.first }
    return target
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
          header
          Picker("Billing", selection: $interval) {
            Text("Monthly").tag(JunoBillingInterval.month)
            Text("Yearly · 2 months free").tag(JunoBillingInterval.year)
          }
          .pickerStyle(.segmented)
          .accessibilityIdentifier("juno.mobile.plans.interval")
          group("Everyday", tiers: [.lite, .pro, .plus])
          group("More usage", tiers: [.max, .max20, .ultra])
          fineprint
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, JunoSpace.snug)
        .padding(.bottom, 120)
      }
      .scrollIndicators(.hidden)
      .safeAreaInset(edge: .bottom) { action }
      .background(Color.junoCanvas.ignoresSafeArea())
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Close", action: done)
            .accessibilityIdentifier("juno.mobile.plans.close")
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Restore") { restore() }
            .disabled(purchaser == nil || purchasing)
        }
      }
    }
    .onAppear {
      if selected == nil { selected = Self.initialSelection(current: current, reason: reason) }
    }
    .task { await loadProducts() }
  }

  // MARK: Header

  private var header: some View {
    VStack(alignment: .leading, spacing: JunoSpace.tight) {
      Text(reason.map { "\($0.title) comes with \($0.minimumTier.info.name)" } ?? "Plans")
        .junoMobileDisplay(34)
        .accessibilityAddTraits(.isHeader)
      Text(subtitle)
        .font(.subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var subtitle: String {
    let on = "You’re on \(current.displayName)."
    if let reason { return "\(on) \(reason.upgradePrompt)" }
    return "\(on) Every plan is a monthly budget of real model usage."
  }

  // MARK: Rows

  private func group(_ title: String, tiers: [JunoPlanTier]) -> some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      JunoMobileSectionLabel(LocalizedStringKey(title))
      VStack(spacing: JunoSpace.snug) {
        ForEach(tiers, id: \.self) { row($0.info) }
      }
    }
  }

  private func row(_ plan: JunoPlanInfo) -> some View {
    let isSelected = selected == plan.tier
    let isCurrent = current.tier == plan.tier
    let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
    return Button {
      selected = plan.tier
    } label: {
      HStack(alignment: .center, spacing: JunoSpace.cozy) {
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
          Text(plan.name)
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.junoForeground)
          Text(isCurrent ? "Your plan" : plan.tagline)
            .font(.footnote)
            .foregroundStyle(Color.junoSecondaryInk)
          Text(Self.highlights(plan))
            .font(.footnote)
            .foregroundStyle(Color.junoSecondaryInk)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, JunoSpace.micro)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .trailing, spacing: JunoSpace.micro) {
          Text(priceText(plan))
            .font(.title3.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(Color.junoForeground)
            .contentTransition(.numericText())
          Text(interval == .year ? yearlyText(plan) : "a month")
            .font(.footnote)
            .monospacedDigit()
            .foregroundStyle(Color.junoSecondaryInk)
        }
        JunoIconView(.check, size: 15)
          .foregroundStyle(Color.junoAccentInk)
          .opacity(isSelected ? 1 : 0)
          .accessibilityHidden(true)
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.vertical, JunoSpace.cozy)
      .frame(minHeight: 64)
      .contentShape(shape)
    }
    .buttonStyle(JunoMobilePressStyle(scale: 0.98))
    // Content is opaque (the native glass gate): the rows are raised cards on
    // the canvas; the glass is the sheet's, the toolbar's and the button's.
    .junoMobileRaised(cornerRadius: 22)
    .overlay {
      shape.strokeBorder(Color.junoAccent, lineWidth: isSelected ? 1.5 : 0)
    }
    .animation(JunoMotion.reduced(JunoMotion.standard, when: false, tier: .tint), value: isSelected)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
    .accessibilityIdentifier("juno.mobile.plans.\(plan.id.lowercased())")
  }

  /// The row's third line, as on the Mac.
  static func highlights(_ plan: JunoPlanInfo) -> String {
    switch plan.tier {
    case .lite: "Everyday models · Web search"
    case .pro: "Every model · Code, agents, research"
    case .plus: "2.5× Pro’s usage · Higher priority"
    case .max: "5× Pro’s usage · Highest priority"
    case .max20: "10× Pro’s usage · Highest priority"
    case .ultra: "25× Pro’s usage · 200 MB uploads"
    case .free, .owner: plan.features.prefix(2).joined(separator: " · ")
    }
  }

  // MARK: Prices

  private func product(_ tier: JunoPlanTier) -> Product? {
    guard let subscription = JunoSubscriptionTier(planTier: tier),
      let id = JunoStoreKitProductIDs.productID(for: subscription, interval: interval)
    else { return nil }
    return products[id]
  }

  /// The App Store's own price when StoreKit has it (tax included, in the
  /// storefront's currency); the catalogue's TTC price otherwise. On yearly
  /// billing, what a year costs per month.
  private func priceText(_ plan: JunoPlanInfo) -> String {
    if let product = product(plan.tier) {
      if interval == .year {
        return (product.price / 12).formatted(product.priceFormatStyle.precision(.fractionLength(0...2)))
      }
      return product.displayPrice
    }
    return interval == .year ? plan.price.yearlyPerMonth(locale: locale) : plan.price.monthly(locale: locale)
  }

  private func yearlyText(_ plan: JunoPlanInfo) -> String {
    let year = product(plan.tier)?.displayPrice ?? plan.price.yearly(locale: locale)
    return "a month · \(year) a year"
  }

  // MARK: Action

  private var action: some View {
    VStack(spacing: JunoSpace.tight) {
      if let message {
        Text(message)
          .font(.footnote)
          .foregroundStyle(Color.junoSecondaryInk)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
      JunoGlass {
        Button {
          purchase()
        } label: {
          Text(actionTitle)
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(.rect)
        }
        .junoProminentAction()
        .disabled(!canPurchase)
        .accessibilityIdentifier("juno.mobile.plans.continue")
      }
    }
    .padding(.horizontal, JunoSpace.regular)
    .padding(.top, JunoSpace.regular)
    .padding(.bottom, JunoSpace.snug)
    // The rows scroll away under the button rather than through it: the
    // canvas fades in over the top of the bar and holds behind the button.
    .background {
      VStack(spacing: 0) {
        LinearGradient(colors: [Color.junoCanvas.opacity(0), Color.junoCanvas], startPoint: .top, endPoint: .bottom)
          .frame(height: JunoSpace.regular)
        Color.junoCanvas
      }
      .ignoresSafeArea(edges: .bottom)
    }
  }

  private var actionTitle: String {
    guard let selected else { return "Choose a plan" }
    if purchasing { return "Confirming…" }
    if current.tier == selected { return "You’re on \(selected.info.name)" }
    let price = priceText(selected.info)
    return "Continue with \(selected.info.name) · \(price) a month"
  }

  private var canPurchase: Bool {
    guard let selected, !purchasing, current.tier != selected else { return false }
    return purchaser != nil && product(selected) != nil
  }

  private var fineprint: some View {
    VStack(alignment: .leading, spacing: JunoSpace.tight) {
      Text(JunoPlanPrice.vatNote)
      Text("Payment is charged to your Apple Account. A subscription renews automatically unless it is cancelled at least 24 hours before the end of the period; manage or cancel it in Settings › Apple Account › Subscriptions.")
      if purchaser != nil, products.isEmpty {
        Text("In-app subscriptions aren’t available in this build. A plan bought on the web works here as soon as you sign in.")
      }
    }
    .font(.footnote)
    .foregroundStyle(Color.junoSecondaryInk)
    .fixedSize(horizontal: false, vertical: true)
  }

  // MARK: StoreKit

  private func loadProducts() async {
    guard let purchaser else { return }
    guard let loaded = try? await purchaser.loadProducts() else { return }
    products = Dictionary(loaded.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
  }

  private func purchase() {
    guard let purchaser, let selected,
      let subscription = JunoSubscriptionTier(planTier: selected),
      let id = JunoStoreKitProductIDs.productID(for: subscription, interval: interval)
    else { return }
    purchasing = true
    message = nil
    Task {
      defer { purchasing = false }
      do {
        switch try await purchaser.purchase(productID: id) {
        case .success(let tier, _):
          store.update(planID: tier.rawValue)
          done()
        case .pending:
          message = "Your purchase is waiting for approval. Your plan changes as soon as it goes through."
        case .userCancelled:
          break
        case .failed(let reason):
          message = reason
        }
      } catch {
        message = error.localizedDescription
      }
    }
  }

  private func restore() {
    guard let purchaser else { return }
    purchasing = true
    Task {
      defer { purchasing = false }
      let state = (try? await purchaser.restorePurchases()) ?? JunoSubscriptionState()
      if state.isActive {
        store.update(planID: state.plan.id)
        message = "Restored \(state.plan.displayName)."
      } else {
        message = "No App Store subscription to restore on this Apple Account."
      }
    }
  }
}

// MARK: - Locked page

/// A destination whose feature the plan does not include: what it is, the
/// plan that unlocks it, and one button to the plans page. Shown in place of
/// the page; the row that leads to it stays where it is.
struct JunoMobilePlanLockedView: View {
  let feature: JunoPlanFeature
  let title: String
  let icon: JunoIcon
  var store: JunoMobilePlanStore = .shared

  var body: some View {
    VStack(spacing: JunoSpace.regular) {
      JunoIconView(icon, size: 28)
        .foregroundStyle(Color.junoSecondaryInk)
      VStack(spacing: JunoSpace.tight) {
        Text(title)
          .junoMobileDisplay(28)
          .accessibilityAddTraits(.isHeader)
        Text(feature.upgradePrompt)
          .font(.subheadline)
          .foregroundStyle(Color.junoSecondaryInk)
          .multilineTextAlignment(.center)
      }
      JunoGlass {
        Button {
          store.require(feature)
        } label: {
          Text(feature.upgradeAction)
            .font(.body.weight(.semibold))
            .padding(.horizontal, JunoSpace.snug)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
        }
        .junoProminentAction()
        .accessibilityIdentifier("juno.mobile.locked.\(feature.rawValue)")
      }
    }
    .padding(JunoSpace.section)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.junoCanvas.ignoresSafeArea())
  }
}

extension View {
  /// Presents the plans page whenever the store asks for it.
  func junoMobilePlansSheet(_ store: JunoMobilePlanStore = .shared) -> some View {
    modifier(JunoMobilePlansSheet(store: store))
  }
}

private struct JunoMobilePlansSheet: ViewModifier {
  @Bindable var store: JunoMobilePlanStore

  func body(content: Content) -> some View {
    content.sheet(item: $store.paywall) { request in
      JunoMobilePlansView(reason: request.feature, store: store, done: { store.paywall = nil })
        .presentationDragIndicator(.visible)
    }
  }
}
