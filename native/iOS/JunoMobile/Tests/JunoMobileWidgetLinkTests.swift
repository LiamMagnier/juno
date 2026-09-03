import Foundation
import XCTest
@testable import JunoMobile

/// The widget extension and the Live Activities reach the app through one
/// deep-link space on the auth callback's scheme. The parser is the boundary
/// between anything that can mint a URL — including another app — and a Code
/// command or an approval decision, so every route and every way to fall
/// outside the routes is pinned here.
@MainActor
final class JunoMobileWidgetLinkTests: XCTestCase {
  func testShortcutRoutes() {
    XCTAssertEqual(JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.url(path: "chat")), .newChat)
    XCTAssertEqual(JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.url(path: "voice")), .voice)
    XCTAssertEqual(JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.url(path: "code")), .code)
    XCTAssertEqual(JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.url(path: "dictate")), .dictate)
  }

  func testSessionRouteCarriesBothIDs() {
    let url = JunoMobileWidgetRoute.url(path: "code/session/device-7/session-9")
    XCTAssertEqual(
      JunoMobileLaunchRequests.request(for: url),
      .openRemoteSession(deviceID: "device-7", sessionID: "session-9")
    )
  }

  func testApprovalRouteCarriesTheDecision() {
    let url = JunoMobileWidgetRoute.approvalURL(
      deviceID: "d1", sessionID: "s2", requestID: "r3", approved: true
    )
    XCTAssertEqual(
      JunoMobileLaunchRequests.request(for: url),
      .respondToRemoteApproval(deviceID: "d1", sessionID: "s2", requestID: "r3", approved: true)
    )
    let denied = JunoMobileWidgetRoute.approvalURL(
      deviceID: "d1", sessionID: "s2", requestID: "r3", approved: false
    )
    XCTAssertEqual(
      JunoMobileLaunchRequests.request(for: denied),
      .respondToRemoteApproval(deviceID: "d1", sessionID: "s2", requestID: "r3", approved: false)
    )
  }

  func testApprovalRouteMissingAParameterIsIgnored() {
    // A decision without its request id cannot be acted on safely, so the
    // whole link falls through rather than opening the session half-armed.
    let url = URL(string: "\(JunoMobileWidgetRoute.scheme)://\(JunoMobileWidgetRoute.host)/code/approval?deviceID=d1&sessionID=s2")!
    XCTAssertNil(JunoMobileLaunchRequests.request(for: url))
  }

  func testUnknownPathOnTheJunoHostIsIgnored() {
    XCTAssertNil(JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.url(path: "code/terminate")))
    XCTAssertNil(JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.url(path: "settings/delete-account")))
  }

  func testForeignSchemeAndHostAreIgnored() {
    XCTAssertNil(JunoMobileLaunchRequests.request(for: URL(string: "https://juno/chat")!))
    XCTAssertNil(JunoMobileLaunchRequests.request(for: URL(string: "otherapp://juno/chat")!))
    // The OAuth callback shares the scheme but has its own host; it must
    // never parse as navigation.
    XCTAssertNil(JunoMobileLaunchRequests.request(for: URL(string: "com.liammagnier.juno://auth/callback?code=x")!))
  }

  func testApprovalURLQuerySurvivesIdentifiersWithReservedCharacters() {
    // Session and request ids come from the relay and are opaque; the query
    // form must round-trip whatever they contain.
    let url = JunoMobileWidgetRoute.approvalURL(
      deviceID: "device with space", sessionID: "s&1=2", requestID: "r?3", approved: true
    )
    XCTAssertEqual(
      JunoMobileLaunchRequests.request(for: url),
      .respondToRemoteApproval(
        deviceID: "device with space", sessionID: "s&1=2", requestID: "r?3", approved: true
      )
    )
  }
}
