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

  func testNotificationPagesOpenByLink() {
    XCTAssertEqual(
      JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.url(path: "agents/agent_1")),
      .openAgent("agent_1")
    )
    XCTAssertEqual(
      JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.url(path: "chat/conv_2")),
      .openConversation("conv_2")
    )
    XCTAssertEqual(
      JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.url(path: "work/session_3")),
      .openWorkSession("session_3")
    )
    // Bare `chat` is still a new chat, not a conversation.
    XCTAssertEqual(JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.url(path: "chat")), .newChat)
  }

  func testNoLinkDecidesAWorkApproval() {
    // A link can open a task; it can never answer one of its approvals. The
    // approval is a card, read before it is decided.
    for path in [
      "work/session_3/approve",
      "work/approvals/ap_1/decision",
      "agents/agent_1/tasks",
      "agents",
    ] {
      XCTAssertNil(JunoMobileLaunchRequests.request(for: JunoMobileWidgetRoute.url(path: path)), path)
    }
    let decision = URL(string: "\(JunoMobileWidgetRoute.scheme)://\(JunoMobileWidgetRoute.host)/work/session_3?decision=allowed")!
    XCTAssertEqual(JunoMobileLaunchRequests.request(for: decision), .openWorkSession("session_3"))
  }

  func testNotificationPayloadsRoute() {
    let requests = JunoMobileLaunchRequests.shared
    requests.pending = nil

    requests.handle(notification: ["path": "/agents/agent_1", "kind": "agent", "agentId": "agent_1"])
    XCTAssertEqual(requests.pending, .openAgent("agent_1"))

    requests.handle(notification: ["path": "/work/session_3", "kind": "work", "sessionId": "session_3"])
    XCTAssertEqual(requests.pending, .openWorkSession("session_3"))

    // Code's local notifications keep working, by their own keys.
    requests.handle(notification: ["deviceID": "device-7", "sessionID": "session-9"])
    XCTAssertEqual(requests.pending, .openRemoteSession(deviceID: "device-7", sessionID: "session-9"))

    // A payload with nowhere safe to go requests nothing.
    requests.pending = nil
    requests.handle(notification: ["path": "https://evil.example/agents/agent_1"])
    XCTAssertNil(requests.pending)
    // A Code approval push names a Code session under `sessionId`; it is not a Work task.
    requests.handle(notification: ["sessionId": "code_session", "approvalId": "ap_1"])
    XCTAssertNil(requests.pending)
  }

  func testNotificationUserInfoKeepsOnlyStrings() {
    let info: [AnyHashable: Any] = [
      "aps": ["alert": ["title": "Quill needs you"]],
      "path": "/chat/conv_2",
      "count": 3,
    ]
    XCTAssertEqual(JunoMobileLaunchRequests.stringValues(of: info), ["path": "/chat/conv_2"])
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
