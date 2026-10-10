import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import UserNotifications

/// An approval answered from a notification's action.
struct JunoMobileLinkApprovalAnswer: Equatable, Sendable {
  let deviceID: String
  let sessionID: String
  let requestID: String
  let approved: Bool
}

/// What a remote-control notification asks for (docs/code-v2/REMOTE-CONTROL.md §4, §5).
///
/// Pure, so the mapping is tested without a notification center:
/// - `ALEVR_CODE_APPROVAL` action (Allow once / Deny) on a `link: "v2"`
///   payload → answer it in the background.
/// - a plain tap on one → open the session on the paired Mac.
/// - `ALEVR_HANDOFF` tap → open the chat or the Code session.
/// Anything else is nil and goes through ``JunoMobileLaunchRequests/handle(notification:)``.
enum JunoMobileRemoteNotificationRoute: Equatable {
  case answer(JunoMobileLinkApprovalAnswer)
  case open(JunoMobileLaunchRequests.Request)

  static let approvalCategory = "ALEVR_CODE_APPROVAL"
  static let handoffCategory = "ALEVR_HANDOFF"
  static let allowOnceAction = "alevr.approval.allow-once"
  static let denyAction = "alevr.approval.deny"

  init?(actionIdentifier: String, categoryIdentifier: String, info: [String: String]) {
    // Hand-off first: its Code payload carries deviceID + sessionID too.
    if categoryIdentifier == Self.handoffCategory || info["handoff"] != nil {
      guard actionIdentifier == UNNotificationDefaultActionIdentifier else { return nil }
      switch info["handoff"] {
      case "chat":
        guard let id = info["conversationId"] ?? info["conversationID"], !id.isEmpty else { return nil }
        self = .open(.openConversation(id))
      case "code":
        guard let deviceID = info["deviceID"] ?? info["deviceId"],
          let sessionID = info["sessionID"] ?? info["sessionId"]
        else { return nil }
        self = .open(.openLinkSession(deviceID: deviceID, sessionID: sessionID))
      default:
        return nil
      }
      return
    }
    guard info["link"] == "v2", let deviceID = info["deviceID"], let sessionID = info["sessionID"] else {
      return nil
    }
    switch actionIdentifier {
    case Self.allowOnceAction, Self.denyAction:
      guard let requestID = info["requestID"] else { return nil }
      self = .answer(
        JunoMobileLinkApprovalAnswer(
          deviceID: deviceID, sessionID: sessionID, requestID: requestID,
          approved: actionIdentifier == Self.allowOnceAction
        )
      )
    case UNNotificationDismissActionIdentifier:
      return nil
    default:
      self = .open(.openLinkSession(deviceID: deviceID, sessionID: sessionID))
    }
  }

  /// The categories this app answers, merged into whatever is registered.
  static var categories: Set<UNNotificationCategory> {
    let allow = UNNotificationAction(
      identifier: allowOnceAction, title: "Allow once", options: [.authenticationRequired]
    )
    let deny = UNNotificationAction(
      identifier: denyAction, title: "Deny", options: [.authenticationRequired, .destructive]
    )
    return [
      UNNotificationCategory(identifier: approvalCategory, actions: [allow, deny], intentIdentifiers: []),
      UNNotificationCategory(identifier: handoffCategory, actions: [], intentIdentifiers: []),
    ]
  }

  /// `existing` with ours added or replaced, nothing else dropped.
  static func merged(_ existing: Set<UNNotificationCategory>) -> Set<UNNotificationCategory> {
    let ours = categories
    let ids = Set(ours.map(\.identifier))
    return existing.filter { !ids.contains($0.identifier) }.union(ours)
  }

  /// The delivered notifications a `clearApproval` push withdraws: those
  /// whose `requestID` is that request (or whose id is, as the push's
  /// collapse id makes it).
  static func deliveredIdentifiers(
    clearing requestID: String, in delivered: [(identifier: String, info: [String: String])]
  ) -> [String] {
    delivered
      .filter { $0.info["requestID"] == requestID || $0.identifier == requestID }
      .map(\.identifier)
  }
}

/// Answers a paired Mac's approval from a notification action without
/// opening the app: `approval.respond` through the device link.
@MainActor
final class JunoMobileLinkApprovalResponder {
  static let shared = JunoMobileLinkApprovalResponder()

  enum Outcome: Equatable {
    case answered
    case failed(String)
    /// Signed out, or not yet restored: nothing to send with.
    case notReady
  }

  private var sender: (any NativeAuthenticatedRequestSending)?
  private var accountID: AccountID?

  init() {}

  /// Set once signed in; nil when signed out.
  func attach(sender: (any NativeAuthenticatedRequestSending)?, accountID: AccountID?) {
    self.sender = sender
    self.accountID = accountID
  }

  /// The link command's request body.
  nonisolated static func body(for answer: JunoMobileLinkApprovalAnswer, commandID: String) throws -> Data {
    let object: [String: Any] = [
      "kind": "rpc",
      "command": [
        "id": commandID,
        "type": "approval.respond",
        "params": [
          "sessionId": answer.sessionID,
          "requestId": answer.requestID,
          "decision": answer.approved ? "accept" : "decline",
        ],
      ],
    ]
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  nonisolated static func path(for deviceID: String) -> String {
    let segment = deviceID.addingPercentEncoding(
      withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
    ) ?? deviceID
    return "/api/code/v2/link/\(segment)"
  }

  /// Reads the link's reply: the response with our command id, ok or not.
  nonisolated static func outcome(statusCode: Int, body: Data, commandID: String) -> Outcome {
    let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    guard (200..<300).contains(statusCode) else {
      return .failed(object?["message"] as? String ?? object?["error"] as? String ?? "Alevr could not reach your Mac.")
    }
    if object?["offline"] as? Bool == true {
      return .failed(object?["message"] as? String ?? "Your Mac is offline.")
    }
    let responses = object?["responses"] as? [[String: Any]] ?? []
    guard let mine = responses.first(where: { $0["id"] as? String == commandID }) else {
      return .failed("Your Mac did not answer.")
    }
    if mine["ok"] as? Bool == true { return .answered }
    let error = mine["error"] as? [String: Any]
    return .failed(error?["message"] as? String ?? "Your Mac refused the answer.")
  }

  /// Sends the answer, giving up after `timeout`.
  func respond(_ answer: JunoMobileLinkApprovalAnswer, timeout: Duration = .seconds(25)) async -> Outcome {
    guard let sender, let accountID else { return .notReady }
    let commandID = UUID().uuidString.lowercased()
    let request: NativeBearerRequest
    do {
      request = try NativeBearerRequest(
        path: Self.path(for: answer.deviceID),
        method: .post,
        headers: try HTTPHeaders(["accept": "application/json", "content-type": "application/json"]),
        body: try Self.body(for: answer, commandID: commandID)
      )
    } catch {
      return .failed("Alevr could not send the answer.")
    }
    return await withTaskGroup(of: Outcome.self) { group in
      group.addTask {
        do {
          let response = try await sender.send(request, for: accountID)
          return Self.outcome(statusCode: response.statusCode, body: response.body, commandID: commandID)
        } catch {
          return .failed("Alevr could not reach your Mac.")
        }
      }
      group.addTask {
        try? await Task.sleep(for: timeout)
        return .failed("Your Mac took too long to answer.")
      }
      let first = await group.next() ?? .failed("Alevr could not reach your Mac.")
      group.cancelAll()
      return first
    }
  }

  /// A notification action: answer in the background; with no account
  /// ready, open the app on the session and let Code answer it.
  func answerFromNotification(_ answer: JunoMobileLinkApprovalAnswer) async {
    switch await respond(answer) {
    case .answered:
      JunoMobileLiveActivityCoordinator.shared.resolveApproval(requestID: answer.requestID)
    case .notReady:
      JunoMobileLaunchRequests.shared.request(
        .respondToLinkApproval(
          deviceID: answer.deviceID, sessionID: answer.sessionID, requestID: answer.requestID,
          approved: answer.approved
        )
      )
    case let .failed(message):
      await Self.notifyFailure(answer, message: message)
    }
  }

  /// The answer did not reach the Mac: say so, and let a tap open the session.
  private static func notifyFailure(_ answer: JunoMobileLinkApprovalAnswer, message: String) async {
    let content = UNMutableNotificationContent()
    content.title = "Your answer did not reach the Mac"
    content.body = "\(message) Tap to answer in Alevr."
    content.categoryIdentifier = JunoMobileRemoteNotificationRoute.approvalCategory
    content.userInfo = [
      "link": "v2", "deviceID": answer.deviceID, "sessionID": answer.sessionID, "requestID": answer.requestID,
    ]
    content.threadIdentifier = answer.deviceID
    try? await UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: "\(answer.requestID)-retry", content: content, trigger: nil)
    )
  }
}
