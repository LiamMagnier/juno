import Foundation
import XCTest
@testable import JunoMobile

/// The Runs screen's way in (REA 8): the Live Activity, its Stop button and
/// the approval notification all reach the app as a `runs` link, and that
/// link may only ever navigate.
@MainActor
final class JunoMobileRunsTests: XCTestCase {
  func testTheRunsLinkOpensTheListOrOneRun() {
    XCTAssertEqual(
      JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.runsURL()),
      .openRuns(runKey: nil, confirmStop: false)
    )
    XCTAssertEqual(
      JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.runsURL(runKey: "code:mac-1:s-1")),
      .openRuns(runKey: "code:mac-1:s-1", confirmStop: false)
    )
  }

  /// The Live Activity's Stop opens the question; it never stops anything.
  func testStopFromTheLockScreenOnlyAsks() {
    XCTAssertEqual(
      JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.runsURL(runKey: "work:run-1", stop: true)),
      .openRuns(runKey: "work:run-1", confirmStop: true)
    )
  }

  /// A key that is not a run key focuses nothing, and a Stop question needs a
  /// run to be about.
  func testAMadeUpRunKeyFocusesNothing() {
    let forged = URL(string: "com.liammagnier.juno://juno/runs?run=agent:everything&stop=1")!
    XCTAssertEqual(JunoMobileLaunchRequests.request(for: forged), .openRuns(runKey: nil, confirmStop: false))
    let spaced = URL(string: "com.liammagnier.juno://juno/runs?run=code:a%20b")!
    XCTAssertEqual(JunoMobileLaunchRequests.request(for: spaced), .openRuns(runKey: nil, confirmStop: false))
  }

  func testTheApprovalNotificationOpensItsRun() {
    let requests = JunoMobileLaunchRequests.shared
    requests.pending = nil
    requests.handle(notification: ["runKey": "code:mac-1:s-1"])
    XCTAssertEqual(requests.pending, .openRuns(runKey: "code:mac-1:s-1", confirmStop: false))
    requests.pending = nil
  }

  func testNotificationIdentifiersAreKeyedOnTheApproval() {
    XCTAssertEqual(JunoMobileRunsCoordinator.notificationID("req-1"), "run-approval-req-1")
  }

  /// No push entitlement on a free account, and no server sending Live
  /// Activity pushes yet: every update is local.
  func testRemoteLiveActivityUpdatesAreOffUntilPushExists() {
    XCTAssertFalse(JunoMobileRunActivityPush.serverSendsActivityPushes)
    XCTAssertFalse(JunoMobileRunActivityPush.isAvailable)
  }
}
