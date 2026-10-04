import JunoAPI
import JunoCore
import SwiftUI
import UIKit
import XCTest
@testable import JunoMobile

/// The plan gate, the plans page's choices, and the App Store sync's reading of
/// the server — plus, with `JUNO_SNAPSHOT_DIR` set, pictures of the plans page.
@MainActor
final class JunoMobilePlansTests: XCTestCase {
  // MARK: - Gate

  func testTheGateIsOpenUntilAPlanIsRead() {
    let store = JunoMobilePlanStore()
    XCTAssertTrue(JunoPlanFeature.allCases.allSatisfy(store.allows))
    XCTAssertTrue(store.require(.code))
    XCTAssertNil(store.paywall)
  }

  func testLiteIsAskedToUpgradeToProForCodeAgentsResearchAndVoice() {
    let store = JunoMobilePlanStore()
    store.update(planID: "lite")
    for feature in [JunoPlanFeature.code, .agents, .research, .voice] {
      store.paywall = nil
      XCTAssertFalse(store.require(feature), "\(feature)")
      XCTAssertEqual(store.paywall?.feature, feature)
      XCTAssertEqual(feature.minimumTier, .pro)
    }
    XCTAssertTrue(store.allows(.webSearch))
  }

  func testFreeIsAskedForLiteForWebSearch() {
    let store = JunoMobilePlanStore()
    store.update(planID: "FREE")
    XCTAssertFalse(store.require(.webSearch))
    XCTAssertEqual(store.paywall?.feature?.minimumTier, .lite)
  }

  func testAnUnknownPlanIsNeverLockedOut() {
    let store = JunoMobilePlanStore()
    store.update(planID: "STUDIO")
    XCTAssertTrue(JunoPlanFeature.allCases.allSatisfy(store.allows))
    store.update(planID: nil)
    XCTAssertEqual(store.plan?.id, "STUDIO", "a failed read keeps the last plan")
  }

  func testResearchCannotBeArmedWithoutThePlan() {
    let suite = "juno.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = JunoMobilePlanStore()
    store.update(planID: "LITE")
    let tools = JunoMobileComposerTools(defaults: defaults)
    tools.planStore = store
    tools.deepResearch = true
    XCTAssertFalse(tools.deepResearch)
    XCTAssertEqual(store.paywall?.feature, .research)

    store.update(planID: "FREE")
    tools.webSearch = true
    XCTAssertFalse(tools.consumeForSend().webSearch, "Free does not ask for web search")

    store.update(planID: "PRO")
    tools.deepResearch = true
    XCTAssertTrue(tools.deepResearch)
  }

  // MARK: - Plans page

  func testThePageOpensOnThePlanThatUnlocksTheReason() {
    XCTAssertEqual(JunoMobilePlansView.initialSelection(current: .free, reason: nil), .pro)
    XCTAssertEqual(JunoMobilePlansView.initialSelection(current: .free, reason: .webSearch), .lite)
    XCTAssertEqual(JunoMobilePlansView.initialSelection(current: JunoAccountPlan(tier: .lite), reason: .code), .pro)
    XCTAssertEqual(JunoMobilePlansView.initialSelection(current: JunoAccountPlan(tier: .pro), reason: nil), .plus)
    XCTAssertNil(JunoMobilePlansView.initialSelection(current: JunoAccountPlan(tier: .ultra), reason: nil))
  }

  func testEveryPlanForSaleHasAHighlightsLine() {
    for tier in JunoPlanTier.forSale {
      XCTAssertFalse(JunoMobilePlansView.highlights(tier.info).isEmpty, "\(tier)")
    }
  }

  // MARK: - App Store sync

  func testTheServersAnswerBecomesAState() {
    let ultra = JunoMobileAppStoreSync.state(from: Data(#"{"success":true,"subscription":{"plan":"ULTRA","status":"ACTIVE","productId":"com.liammagnier.juno.ultra.yearly"}}"#.utf8))
    XCTAssertEqual(ultra.tier, .ultra)
    XCTAssertTrue(ultra.isActive)
    let newer = JunoMobileAppStoreSync.state(from: Data(#"{"success":true,"subscription":{"plan":"STUDIO","status":"ACTIVE","productId":"com.liammagnier.juno.studio.monthly"}}"#.utf8))
    XCTAssertTrue(newer.isActive, "a plan this build does not know is still paid")
    XCTAssertEqual(newer.plan.displayName, "Studio")
  }

  // MARK: - Snapshots

  /// Draws the plans page in a real window (so Liquid Glass renders) in both
  /// appearances. Off unless `JUNO_SNAPSHOT_DIR` is set.
  func testSnapshotsOfThePlansPage() throws {
    guard let dir = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
      throw XCTSkip("Set JUNO_SNAPSHOT_DIR (TEST_RUNNER_JUNO_SNAPSHOT_DIR) to draw the plans page.")
    }
    let english = Locale(identifier: "en_IE")
    let cases: [(String, JunoAccountPlan, JunoPlanFeature?)] = [
      ("plans-free", .free, nil),
      ("plans-lite-code-locked", JunoAccountPlan(tier: .lite), .code),
    ]
    for (name, plan, reason) in cases {
      for style in [UIUserInterfaceStyle.light, .dark] {
        let store = JunoMobilePlanStore(plan: plan)
        let view = JunoMobilePlansView(reason: reason, store: store, purchaser: nil, locale: english, done: {})
        try render(view, name: "\(name)-\(style == .dark ? "dark" : "light")", style: style, into: dir)
      }
    }
    for style in [UIUserInterfaceStyle.light, .dark] {
      try render(
        JunoMobilePlanLockedView(feature: .code, title: "Code", icon: .code, store: JunoMobilePlanStore(plan: .free)),
        name: "locked-code-\(style == .dark ? "dark" : "light")", style: style, into: dir
      )
    }
  }

  private func render(_ view: some View, name: String, style: UIUserInterfaceStyle, into dir: String) throws {
    let size = CGSize(width: 402, height: 874)
    // A window in the test host's own scene: one without a scene draws nothing.
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(origin: .zero, size: size)
    window.overrideUserInterfaceStyle = style
    let host = UIHostingController(rootView: view)
    window.rootViewController = host
    window.makeKeyAndVisible()
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(1.0))
    let image = UIGraphicsImageRenderer(size: size).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try XCTUnwrap(image.pngData()).write(to: url)
    window.isHidden = true
  }
}
