import Foundation
import LocalAuthentication
import UIKit

/// One Code approval decided somewhere other than a tap on the in-app card: a
/// Live Activity's Allow or Deny, a deep link, or a notification answer that
/// had to be handed to the app.
struct JunoMobileApprovalDecision: Equatable, Sendable {
  let deviceID: String
  let sessionID: String
  let requestID: String
  let approved: Bool
}

/// What asking the owner to confirm came to.
enum JunoMobileOwnerAuthentication: Equatable, Sendable {
  /// Face ID, Touch ID or the passcode succeeded.
  case confirmed
  /// The person cancelled, or the check failed.
  case refused
  /// The phone cannot ask: no passcode is set, or the app never came to the
  /// front to show the prompt.
  case unavailable
}

/// Proves the person deciding is the phone's owner.
@MainActor
protocol JunoMobileOwnerAuthenticating: AnyObject {
  func authenticate(reason: String) async -> JunoMobileOwnerAuthentication
}

/// The gate every approval decided outside the in-app card passes through.
///
/// A notification's Allow once and Deny are marked `.authenticationRequired`,
/// so iOS asks for Face ID or the passcode before the action runs. The other
/// ways in did not ask at all: `…://juno/code/approval?…&approved=true` —
/// which any app or web page can open, and which the Live Activity's buttons
/// produce — sent the decision the moment the app parsed it. Now each of them
/// asks for the same device-owner authentication first (Face ID or Touch ID,
/// then the passcode), and nothing is sent unless it succeeds.
///
/// It fails closed. A cancelled prompt, a failed check or a phone without a
/// passcode sends nothing; the session is already open on its approval card,
/// where the person can read the request and decide it by hand.
@MainActor
final class JunoMobileApprovalGate {
  static let shared = JunoMobileApprovalGate()

  private let authenticator: any JunoMobileOwnerAuthenticating
  /// Requests with a prompt already up, so a double tap on a Live Activity
  /// button asks once rather than stacking two prompts for one decision.
  private var inFlight: Set<String> = []

  init(authenticator: any JunoMobileOwnerAuthenticating = JunoMobileDeviceOwnerAuthenticator()) {
    self.authenticator = authenticator
  }

  /// Sends `decision` through `send` only once the owner has confirmed it.
  ///
  /// Allow and Deny both ask, exactly as the notification's two actions both
  /// do: a forged link that denies is a forged decision too.
  ///
  /// - Returns: whether the decision was sent.
  @discardableResult
  func decide(
    _ decision: JunoMobileApprovalDecision,
    send: @MainActor () async -> Void
  ) async -> Bool {
    guard inFlight.insert(decision.requestID).inserted else { return false }
    defer { inFlight.remove(decision.requestID) }
    let verdict = await authenticator.authenticate(reason: Self.reason(for: decision))
    guard verdict == .confirmed else { return false }
    await send()
    return true
  }

  /// The line under Touch ID and on the passcode screen. Face ID shows the
  /// app's `NSFaceIDUsageDescription` instead.
  static func reason(for decision: JunoMobileApprovalDecision) -> String {
    decision.approved
      ? String(
        localized: "approval.gate.allow",
        defaultValue: "Confirm it's you to allow this request from Alevr Code on your Mac."
      )
      : String(
        localized: "approval.gate.deny",
        defaultValue: "Confirm it's you to deny this request from Alevr Code on your Mac."
      )
  }
}

/// Face ID, Touch ID or the passcode, through LocalAuthentication.
@MainActor
final class JunoMobileDeviceOwnerAuthenticator: JunoMobileOwnerAuthenticating {
  init() {}

  func authenticate(reason: String) async -> JunoMobileOwnerAuthentication {
    // A link can arrive while the app is still coming to the front (a Live
    // Activity tap, another app's link). The prompt can only show once it
    // is active.
    guard await Self.waitUntilActive() else { return .unavailable }
    let context = LAContext()
    // Never accept the unlock as the answer: a link opened a moment after the
    // phone was unlocked must still ask.
    context.touchIDAuthenticationAllowableReuseDuration = 0
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
      return .unavailable
    }
    do {
      let confirmed = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
      return confirmed ? .confirmed : .refused
    } catch {
      return .refused
    }
  }

  /// Waits, briefly, for the app to be active. A request that arrives while
  /// it never comes to the front is dropped rather than prompting later about
  /// something the person has forgotten.
  static func waitUntilActive(timeout: Duration = .seconds(20)) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while UIApplication.shared.applicationState != .active {
      guard clock.now < deadline, !Task.isCancelled else { return false }
      try? await Task.sleep(for: .milliseconds(150))
    }
    return true
  }
}
