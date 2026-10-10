import Foundation
import JunoCore
import UserNotifications
import XCTest
@testable import JunoMobile

/// Apple Handoff payloads both ways, and what each remote-control
/// notification asks for (docs/code-v2/REMOTE-CONTROL.md §4, §5).
@MainActor
final class JunoMobileHandoffTests: XCTestCase {
  private let base = URL(string: "https://chat.liams.dev")!

  // MARK: NSUserActivity

  func testChatActivityCarriesIdsAndTheWebFallback() {
    let activity = JunoMobileHandoff.activity(for: .chat("conv_123", title: "Trip plan"), base: base)
    XCTAssertEqual(activity.activityType, "com.liammagnier.juno.thread")
    XCTAssertEqual(activity.userInfo as? [String: String], ["v": "1", "kind": "chat", "id": "conv_123", "title": "Trip plan"])
    XCTAssertEqual(activity.webpageURL?.absoluteString, "https://chat.liams.dev/chat/conv_123")
    XCTAssertEqual(activity.title, "Trip plan")
    XCTAssertTrue(activity.isEligibleForHandoff)
    XCTAssertFalse(activity.isEligibleForSearch)
  }

  func testCodeActivityCarriesTheMacAndSession() {
    let handoff = JunoHandoff.code(deviceID: "mac_1", sessionID: "sess_9", title: nil, conversationID: "conv_7")
    let activity = JunoMobileHandoff.activity(for: handoff, base: base)
    let info = activity.userInfo as? [String: String]
    XCTAssertEqual(info?["kind"], "code")
    XCTAssertEqual(info?["id"], "sess_9")
    XCTAssertEqual(info?["deviceID"], "mac_1")
    XCTAssertEqual(info?["conversationID"], "conv_7")
    XCTAssertEqual(activity.webpageURL?.absoluteString, "https://chat.liams.dev/code/conv_7")
    XCTAssertEqual(activity.title, "Alevr Code")
  }

  func testContinuingAnActivityOpensTheSameThread() {
    let chat = JunoMobileHandoff.activity(for: .chat("conv_123"), base: base)
    XCTAssertEqual(
      JunoMobileHandoff.request(continuing: chat.activityType, userInfo: chat.userInfo, webpageURL: chat.webpageURL, base: base),
      .openConversation("conv_123")
    )
    let code = JunoMobileHandoff.activity(for: .code(deviceID: "mac_1", sessionID: "sess_9"), base: base)
    XCTAssertEqual(
      JunoMobileHandoff.request(continuing: code.activityType, userInfo: code.userInfo, webpageURL: nil, base: base),
      .openLinkSession(deviceID: "mac_1", sessionID: "sess_9")
    )
  }

  func testMalformedActivitiesOpenNothing() {
    let type = JunoHandoff.activityType
    XCTAssertNil(JunoMobileHandoff.request(continuing: type, userInfo: ["kind": "chat"], webpageURL: nil, base: base))
    XCTAssertNil(JunoMobileHandoff.request(continuing: type, userInfo: ["kind": "code", "id": "s"], webpageURL: nil, base: base))
    XCTAssertNil(JunoMobileHandoff.request(continuing: type, userInfo: ["kind": "chat", "id": "../etc"], webpageURL: nil, base: base))
    XCTAssertNil(JunoMobileHandoff.request(continuing: "other.type", userInfo: ["kind": "chat", "id": "c"], webpageURL: nil, base: base))
  }

  func testBrowsingAnAlevrChatLinkOpensThatChat() {
    let web = NSUserActivityTypeBrowsingWeb
    XCTAssertEqual(
      JunoMobileHandoff.request(continuing: web, userInfo: nil, webpageURL: URL(string: "https://chat.liams.dev/chat/conv_5"), base: base),
      .openConversation("conv_5")
    )
    XCTAssertNil(JunoMobileHandoff.request(continuing: web, userInfo: nil, webpageURL: URL(string: "https://evil.example/chat/conv_5"), base: base))
    XCTAssertNil(JunoMobileHandoff.request(continuing: web, userInfo: nil, webpageURL: URL(string: "https://chat.liams.dev/settings"), base: base))
  }

  // MARK: Notifications

  private let approvalInfo = ["link": "v2", "deviceID": "mac_1", "sessionID": "sess_9", "requestID": "req_4"]

  func testAllowOnceAndDenyAnswerInTheBackground() {
    let allow = JunoMobileRemoteNotificationRoute(
      actionIdentifier: "alevr.approval.allow-once", categoryIdentifier: "ALEVR_CODE_APPROVAL", info: approvalInfo
    )
    XCTAssertEqual(allow, .answer(.init(deviceID: "mac_1", sessionID: "sess_9", requestID: "req_4", approved: true)))
    let deny = JunoMobileRemoteNotificationRoute(
      actionIdentifier: "alevr.approval.deny", categoryIdentifier: "ALEVR_CODE_APPROVAL", info: approvalInfo
    )
    XCTAssertEqual(deny, .answer(.init(deviceID: "mac_1", sessionID: "sess_9", requestID: "req_4", approved: false)))
  }

  func testTappingAnApprovalOpensTheSession() {
    let tap = JunoMobileRemoteNotificationRoute(
      actionIdentifier: UNNotificationDefaultActionIdentifier, categoryIdentifier: "ALEVR_CODE_APPROVAL", info: approvalInfo
    )
    XCTAssertEqual(tap, .open(.openLinkSession(deviceID: "mac_1", sessionID: "sess_9")))
    XCTAssertNil(JunoMobileRemoteNotificationRoute(
      actionIdentifier: UNNotificationDismissActionIdentifier, categoryIdentifier: "ALEVR_CODE_APPROVAL", info: approvalInfo
    ))
  }

  func testV1CodeNotificationsAreLeftToTheOldPath() {
    let v1 = ["deviceID": "mac_1", "sessionID": "sess_9"]
    XCTAssertNil(JunoMobileRemoteNotificationRoute(
      actionIdentifier: UNNotificationDefaultActionIdentifier, categoryIdentifier: "juno.code.approval", info: v1
    ))
  }

  func testHandoffTapsOpenTheChatOrTheSession() {
    let chat = JunoMobileRemoteNotificationRoute(
      actionIdentifier: UNNotificationDefaultActionIdentifier, categoryIdentifier: "ALEVR_HANDOFF",
      info: ["handoff": "chat", "conversationId": "conv_1"]
    )
    XCTAssertEqual(chat, .open(.openConversation("conv_1")))
    let code = JunoMobileRemoteNotificationRoute(
      actionIdentifier: UNNotificationDefaultActionIdentifier, categoryIdentifier: "ALEVR_HANDOFF",
      info: ["handoff": "code", "deviceID": "mac_1", "sessionID": "sess_2"]
    )
    XCTAssertEqual(code, .open(.openLinkSession(deviceID: "mac_1", sessionID: "sess_2")))
    XCTAssertNil(JunoMobileRemoteNotificationRoute(
      actionIdentifier: UNNotificationDefaultActionIdentifier, categoryIdentifier: "ALEVR_HANDOFF", info: ["handoff": "chat"]
    ))
  }

  func testApprovalAnswerRequestBody() throws {
    let answer = JunoMobileLinkApprovalAnswer(deviceID: "mac_1", sessionID: "sess_9", requestID: "req_4", approved: true)
    let body = try JunoMobileLinkApprovalResponder.body(for: answer, commandID: "cmd-1")
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(object["kind"] as? String, "rpc")
    let command = try XCTUnwrap(object["command"] as? [String: Any])
    XCTAssertEqual(command["id"] as? String, "cmd-1")
    XCTAssertEqual(command["type"] as? String, "approval.respond")
    XCTAssertEqual(
      command["params"] as? [String: String],
      ["sessionId": "sess_9", "requestId": "req_4", "decision": "accept"]
    )
    let declined = try JunoMobileLinkApprovalResponder.body(
      for: .init(deviceID: "mac_1", sessionID: "sess_9", requestID: "req_4", approved: false), commandID: "cmd-2"
    )
    XCTAssertTrue(String(decoding: declined, as: UTF8.self).contains("\"decision\":\"decline\""))
    XCTAssertEqual(JunoMobileLinkApprovalResponder.path(for: "mac_1"), "/api/code/v2/link/mac_1")
  }

  func testApprovalAnswerReadsTheLinkReply() {
    let ok = #"{"responses":[{"type":"response","id":"cmd-1","ok":true,"result":{}}]}"#
    XCTAssertEqual(JunoMobileLinkApprovalResponder.outcome(statusCode: 200, body: Data(ok.utf8), commandID: "cmd-1"), .answered)
    let refused = #"{"responses":[{"type":"response","id":"cmd-1","ok":false,"error":{"code":"not_found","message":"No such request."}}]}"#
    XCTAssertEqual(
      JunoMobileLinkApprovalResponder.outcome(statusCode: 200, body: Data(refused.utf8), commandID: "cmd-1"),
      .failed("No such request.")
    )
    let offline = #"{"offline":true,"message":"Liam's Mac is offline."}"#
    XCTAssertEqual(
      JunoMobileLinkApprovalResponder.outcome(statusCode: 200, body: Data(offline.utf8), commandID: "cmd-1"),
      .failed("Liam's Mac is offline.")
    )
    let unpaired = #"{"code":"not_paired","message":"Pair this iPhone on your Mac first."}"#
    XCTAssertEqual(
      JunoMobileLinkApprovalResponder.outcome(statusCode: 403, body: Data(unpaired.utf8), commandID: "cmd-1"),
      .failed("Pair this iPhone on your Mac first.")
    )
  }

  func testRespondingWithoutAnAccountFallsBackToTheApp() async {
    let responder = JunoMobileLinkApprovalResponder()
    let outcome = await responder.respond(.init(deviceID: "m", sessionID: "s", requestID: "r", approved: true))
    XCTAssertEqual(outcome, .notReady)
  }

  func testClearApprovalMatchesByRequestID() {
    let delivered: [(identifier: String, info: [String: String])] = [
      ("req_4", ["link": "v2", "requestID": "req_4"]),
      ("other", ["link": "v2", "requestID": "req_5"]),
      ("req_4-retry", ["link": "v2", "requestID": "req_4"]),
      ("research-1", ["runId": "r"]),
    ]
    XCTAssertEqual(
      JunoMobileRemoteNotificationRoute.deliveredIdentifiers(clearing: "req_4", in: delivered),
      ["req_4", "req_4-retry"]
    )
  }

  func testCategoriesAreMergedNotReplaced() {
    let existing = UNNotificationCategory(identifier: "juno.code.approval", actions: [], intentIdentifiers: [])
    let stale = UNNotificationCategory(identifier: "ALEVR_HANDOFF", actions: [], intentIdentifiers: [], options: [.customDismissAction])
    let merged = JunoMobileRemoteNotificationRoute.merged([existing, stale])
    XCTAssertEqual(Set(merged.map(\.identifier)), ["juno.code.approval", "ALEVR_CODE_APPROVAL", "ALEVR_HANDOFF"])
    let approval = merged.first { $0.identifier == "ALEVR_CODE_APPROVAL" }
    XCTAssertEqual(approval?.actions.map(\.identifier), ["alevr.approval.allow-once", "alevr.approval.deny"])
    XCTAssertEqual(approval?.actions.map(\.title), ["Allow once", "Deny"])
    XCTAssertEqual(approval?.actions.first?.options, [.authenticationRequired])
    XCTAssertEqual(approval?.actions.last?.options, [.authenticationRequired, .destructive])
    XCTAssertFalse(approval?.actions.contains { $0.options.contains(.foreground) } ?? true)
  }
}
