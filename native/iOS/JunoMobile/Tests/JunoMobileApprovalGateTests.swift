import Foundation
import XCTest
@testable import JunoMobile

/// The gate between an approval decided outside the in-app card and the Mac.
///
/// `…://juno/code/approval?…&approved=true` can be opened by any app or web
/// page, and the Live Activity's buttons open it too. It used to send the
/// decision on parse; the notification path, meanwhile, asked for Face ID.
/// These tests pin that nothing is sent without the owner's confirmation.
@MainActor
final class JunoMobileApprovalGateTests: XCTestCase {
  private let allow = JunoMobileApprovalDecision(
    deviceID: "d1", sessionID: "s2", requestID: "r3", approved: true
  )
  private let deny = JunoMobileApprovalDecision(
    deviceID: "d1", sessionID: "s2", requestID: "r3", approved: false
  )

  func testAConfirmedOwnerSendsTheDecisionOnce() async {
    let owner = ScriptedOwner(.confirmed)
    let gate = JunoMobileApprovalGate(authenticator: owner)
    var sent = 0

    let didSend = await gate.decide(allow) { sent += 1 }

    XCTAssertTrue(didSend)
    XCTAssertEqual(sent, 1)
    XCTAssertEqual(owner.reasons, [JunoMobileApprovalGate.reason(for: allow)])
  }

  func testARefusedPromptSendsNothing() async {
    let gate = JunoMobileApprovalGate(authenticator: ScriptedOwner(.refused))
    var sent = 0

    let didSend = await gate.decide(allow) { sent += 1 }

    XCTAssertFalse(didSend)
    XCTAssertEqual(sent, 0, "A cancelled Face ID prompt must not approve")
  }

  func testAPhoneThatCannotAskSendsNothing() async {
    // No passcode set, or the app never came to the front: fail closed. The
    // session is already open on its card, where the person decides by hand.
    let gate = JunoMobileApprovalGate(authenticator: ScriptedOwner(.unavailable))
    var sent = 0

    let didSend = await gate.decide(allow) { sent += 1 }

    XCTAssertFalse(didSend)
    XCTAssertEqual(sent, 0)
  }

  func testDenyAsksTooAsTheNotificationsDenyDoes() async {
    let owner = ScriptedOwner(.refused)
    let gate = JunoMobileApprovalGate(authenticator: owner)
    var sent = 0

    await gate.decide(deny) { sent += 1 }

    XCTAssertEqual(owner.reasons, [JunoMobileApprovalGate.reason(for: deny)])
    XCTAssertEqual(sent, 0)
  }

  func testTheReasonSaysWhichDecisionIsBeingConfirmed() {
    let allowReason = JunoMobileApprovalGate.reason(for: allow)
    let denyReason = JunoMobileApprovalGate.reason(for: deny)
    XCTAssertNotEqual(allowReason, denyReason)
    XCTAssertFalse(allowReason.isEmpty)
    XCTAssertFalse(allowReason.contains("Juno"), "The codename never reaches a person")
  }

  func testADoubleTapAsksOnceForOneRequest() async {
    let owner = HeldOwner()
    let gate = JunoMobileApprovalGate(authenticator: owner)
    let sent = SendCount()
    let decision = allow

    let first = Task { await gate.decide(decision) { sent.value += 1 } }
    await owner.waitForPrompt()
    // The same Live Activity button again, while the first prompt is up.
    let second = await gate.decide(decision) { sent.value += 1 }
    owner.answer(.confirmed)
    let firstSent = await first.value

    XCTAssertFalse(second)
    XCTAssertTrue(firstSent)
    XCTAssertEqual(owner.prompts, 1)
    XCTAssertEqual(sent.value, 1)

    // Once settled, a new decision on the same request may ask again.
    owner.next = .refused
    let third = await gate.decide(decision) { sent.value += 1 }
    XCTAssertFalse(third)
    XCTAssertEqual(owner.prompts, 2)
  }

  /// The parsed link is still only a request: the gate is what acts on it.
  func testTheApprovalLinkParsesToARequestNotADecision() {
    let url = JunoMobileWidgetRoute.approvalURL(deviceID: "d1", sessionID: "s2", requestID: "r3", approved: true)
    guard case let .respondToRemoteApproval(deviceID, sessionID, requestID, approved)? =
      JunoMobileLaunchRequests.request(for: url)
    else {
      return XCTFail("The approval route no longer parses")
    }
    XCTAssertEqual(
      JunoMobileApprovalDecision(deviceID: deviceID, sessionID: sessionID, requestID: requestID, approved: approved),
      allow
    )
  }
}

@MainActor
private final class SendCount {
  var value = 0
}

/// Answers every prompt the same way and records what it was asked.
@MainActor
private final class ScriptedOwner: JunoMobileOwnerAuthenticating {
  private let answer: JunoMobileOwnerAuthentication
  private(set) var reasons: [String] = []

  init(_ answer: JunoMobileOwnerAuthentication) { self.answer = answer }

  func authenticate(reason: String) async -> JunoMobileOwnerAuthentication {
    reasons.append(reason)
    return answer
  }
}

/// Holds the first prompt open until the test answers it, so a second
/// decision can arrive while it is up.
@MainActor
private final class HeldOwner: JunoMobileOwnerAuthenticating {
  private(set) var prompts = 0
  var next: JunoMobileOwnerAuthentication?
  private var pending: CheckedContinuation<JunoMobileOwnerAuthentication, Never>?
  private var promptWaiters: [CheckedContinuation<Void, Never>] = []

  func authenticate(reason: String) async -> JunoMobileOwnerAuthentication {
    prompts += 1
    if let next { return next }
    return await withCheckedContinuation { continuation in
      pending = continuation
      promptWaiters.forEach { $0.resume() }
      promptWaiters.removeAll()
    }
  }

  func waitForPrompt() async {
    if pending != nil { return }
    await withCheckedContinuation { promptWaiters.append($0) }
  }

  func answer(_ verdict: JunoMobileOwnerAuthentication) {
    pending?.resume(returning: verdict)
    pending = nil
  }
}
