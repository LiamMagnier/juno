import JunoCodeCore
import JunoCodeKit
import JunoCodeRemote
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI
import UIKit
import XCTest
@testable import JunoMobile

/// Code's home after Codex's remote (owner, Oct 11): scopes, one Recents list
/// across Cloud and every computer, the docked composer. The ordering rules
/// as unit tests; with `JUNO_SNAPSHOT_DIR`, offscreen stills light and dark.
@MainActor
final class JunoMobileCodeHomeTests: XCTestCase {
  // MARK: Rules

  private func recent(_ id: String, _ status: CodeLinkSessionStatus, minutesAgo: Double, cloud: Bool = false) -> JunoMobileCodeRecent {
    let summary = CodeV2.SessionSummary(
      id: id, cwd: "/x", title: id, state: .idle, selection: CodeV2.ModelSelection(instanceId: "a", model: "m"),
      updatedAt: "2026-10-10T09:00:00Z", lastSequence: 0
    )
    return JunoMobileCodeRecent(
      source: cloud ? .cloud(taskID: id, deviceID: nil) : .link(deviceID: "mac1", session: summary),
      title: id, place: cloud ? "Cloud" : "Studio", date: Date().addingTimeInterval(-minutesAgo * 60), status: status
    )
  }

  func testNeedsYouComesFirstThenNewestFirst() {
    let rows = [
      recent("old", .idle, minutesAgo: 90),
      recent("working", .working, minutesAgo: 30),
      recent("waiting", .needsYou, minutesAgo: 120),
      recent("new", .idle, minutesAgo: 1, cloud: true),
    ]
    XCTAssertEqual(JunoMobileCodeRecent.visible(rows, scope: .all, query: "").map(\.title), ["waiting", "new", "working", "old"])
    XCTAssertEqual(JunoMobileCodeRecent.visible(rows, scope: .cloud, query: "").map(\.title), ["new"])
    XCTAssertEqual(JunoMobileCodeRecent.visible(rows, scope: .device("mac1"), query: "").map(\.title), ["waiting", "working", "old"])
    XCTAssertEqual(JunoMobileCodeRecent.visible(rows, scope: .all, query: "WORK").map(\.title), ["working"])
  }

  func testScopesAndTargetsRoundTripThroughStorage() {
    for scope in [JunoMobileCodeScope.all, .cloud, .device("dev-mbp")] {
      XCTAssertEqual(JunoMobileCodeScope(stored: scope.stored), scope)
    }
    XCTAssertNil(JunoMobileCodeScope(stored: "device:"))
    XCTAssertEqual(JunoMobileCodeTarget(stored: "device:mac1"), .device("mac1"))
    XCTAssertEqual(JunoMobileCodeTarget(stored: "cloud"), .cloud)
    XCTAssertNil(JunoMobileCodeTarget(stored: "all"))
  }

  func testCloudAndRelayStatesReadInTheSameWords() {
    XCTAssertEqual(CodeLinkSessionStatus(cloud: .awaitingApproval), .needsYou)
    XCTAssertEqual(CodeLinkSessionStatus(cloud: .queued), .working)
    XCTAssertEqual(CodeLinkSessionStatus(cloud: .done), .idle)
    XCTAssertEqual(CodeLinkSessionStatus(cloud: .failed), .failed)
  }

  // MARK: Snapshots

  /// A Mac paired over the device link, with the same id as the preview
  /// world's first computer (so it is listed once), and the session list.
  private static func linkModel(empty: Bool = false) -> CodeLinkRemoteModel {
    let pair = RemotePair(
      id: "p1", kind: .phone, name: "iPhone", platform: "ios", deviceId: "dev-mbp", deviceName: "Liam\u{2019}s MacBook Pro",
      createdAt: Date(), lastUsedAt: Date()
    )
    let mac = CodeLinkMac(
      pair: pair,
      info: CodeV2.HostInfo(name: "Liam\u{2019}s MacBook Pro", sharedFolders: ["/Users/liam/Developer"], terminal: true, captures: []),
      reachability: .online
    )
    let selection = JunoMobileLinkSnapshotTests.sonnet
    func ago(_ minutes: Double) -> String { CodeV2Dates.string(Date().addingTimeInterval(-minutes * 60)) }
    let sessions = empty ? [] : [
      CodeV2.SessionSummary(id: "s1", cwd: "/Users/liam/Developer/shop", title: "Fix the cart total rounding", state: .waiting, selection: selection, updatedAt: ago(6), lastSequence: 40),
      CodeV2.SessionSummary(id: "s2", cwd: "/Users/liam/Developer/alevr", title: "Add retries to the sync client", state: .running, selection: selection, updatedAt: ago(2), lastSequence: 12),
      CodeV2.SessionSummary(id: "s3", cwd: "/Users/liam/Developer/site", title: "Move the blog to MDX", state: .idle, selection: selection, updatedAt: ago(52), lastSequence: 80),
      CodeV2.SessionSummary(id: "s4", cwd: "/Users/liam/Developer/alevr", title: "Explain the pairing flow", state: .idle, selection: selection, updatedAt: ago(60 * 26), lastSequence: 9),
    ]
    return CodeLinkRemoteModel.preview(macs: [mac], sessions: sessions)
  }

  private func home(
    _ name: String, scope: JunoMobileCodeScope, scenario: PreviewScenario = .normal, emptyLink: Bool = false,
    prompt: String? = nil
  ) async throws {
    guard ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil else {
      throw XCTSkip("Set JUNO_SNAPSHOT_DIR (TEST_RUNNER_JUNO_SNAPSHOT_DIR) to draw Code's home.")
    }
    let world = try PreviewWorld(scenario: scenario)
    await world.codeModel.start(for: world.accountID)
    let remote = world.remoteCodeModel
    remote.start(for: world.accountID)
    remote.updateHosts(from: world.codeModel.devices)
    await remote.refreshAllSessions()
    let link = Self.linkModel(empty: emptyLink)
    try await JunoMobileLinkSnapshotTests.shoot(name, settle: 1.4) {
      NavigationStack {
        JunoMobileCodeView(
          model: world.codeModel, remoteModel: remote, linkModelOverride: link, startConversation: { _ in },
          accountID: world.accountID, previewScope: scope, previewPrompt: prompt
        )
      }
      .environment(\.junoStartCodeVoice, { _ in })
    }
    world.codeModel.stop()
  }

  func testHomeAll() async throws { try await home("code-home-all", scope: .all) }
  func testHomeCloud() async throws { try await home("code-home-cloud", scope: .cloud) }
  func testHomeDevice() async throws { try await home("code-home-device", scope: .device("dev-mbp")) }
  func testHomeEmpty() async throws { try await home("code-home-empty", scope: .all, scenario: .empty, emptyLink: true) }
  func testHomeNotPaired() async throws { try await home("code-home-not-paired", scope: .device("dev-studio")) }
  func testHomeComposerExpanded() async throws {
    try await home("code-home-composer", scope: .cloud, prompt: "Add a test for the cart totals")
  }
}
