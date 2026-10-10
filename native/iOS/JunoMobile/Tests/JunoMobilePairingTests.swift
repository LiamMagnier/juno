import Foundation
import JunoCodeKit
import JunoCore
import XCTest
@testable import JunoMobile

/// The iPhone's pairing flow (docs/code-v2/REMOTE-CONTROL.md §1): scanned junk
/// is ignored, a token is inspected, then approved or denied; expired and
/// used offers say to show a new code; the /pair links open the sheet.
@MainActor
final class JunoMobilePairingTests: XCTestCase {
  private static let token = "rcp1.payload.signature"
  private static let summary = RemotePairingSummary(
    id: "offer_1", kind: .phone, deviceId: "mac_1", deviceName: "Liam's MacBook Pro",
    expiresAt: Date().addingTimeInterval(110)
  )

  func testScannedJunkIsIgnoredWithAHint() async {
    let service = FakePairingService()
    let model = JunoMobileRemotePairingModel(service: service)
    await model.scanned("https://example.com/menu")
    XCTAssertEqual(model.phase, .scanning(hint: JunoMobileRemotePairingModel.notAPairingCodeHint))
    await model.scanned("WIFI:S:Cafe;T:WPA;P:secret;;")
    XCTAssertEqual(model.phase, .scanning(hint: JunoMobileRemotePairingModel.notAPairingCodeHint))
    let inspected = await service.inspected
    XCTAssertTrue(inspected.isEmpty, "junk never reaches the server")
  }

  func testScannedTokenIsInspectedThenApproved() async {
    let service = FakePairingService(summary: Self.summary)
    let model = JunoMobileRemotePairingModel(service: service)
    await model.scanned("https://chat.liams.dev/pair?t=\(Self.token)")
    XCTAssertEqual(model.phase, .ready(Self.summary))
    let inspected = await service.inspected
    XCTAssertEqual(inspected, [Self.token])

    await model.approve()
    XCTAssertEqual(model.phase, .paired(macName: "Liam's MacBook Pro"))
    let approved = await service.approved
    XCTAssertEqual(approved, [Self.token])
  }

  func testLinkedTokenOpensStraightOnTheApproveScreen() async {
    let service = FakePairingService(summary: Self.summary)
    let model = JunoMobileRemotePairingModel(service: service, token: Self.token)
    XCTAssertEqual(model.phase, .inspecting)
    await model.start()
    XCTAssertEqual(model.phase, .ready(Self.summary))
  }

  func testDenyConsumesTheOfferAndPairsNothing() async {
    let service = FakePairingService(summary: Self.summary)
    let model = JunoMobileRemotePairingModel(service: service, token: Self.token)
    await model.start()
    await model.deny()
    XCTAssertEqual(model.phase, .denied(macName: "Liam's MacBook Pro"))
    let denied = await service.denied
    let approved = await service.approved
    XCTAssertEqual(denied, [Self.token])
    XCTAssertTrue(approved.isEmpty)
  }

  func testApproveBeforeInspectDoesNothing() async {
    let service = FakePairingService(summary: Self.summary)
    let model = JunoMobileRemotePairingModel(service: service)
    await model.approve()
    XCTAssertEqual(model.phase, .scanning(hint: nil))
    let approved = await service.approved
    XCTAssertTrue(approved.isEmpty)
  }

  func testExpiredAndUsedOffersAskForANewCode() async {
    for code in ["expired", "used"] {
      let service = FakePairingService(
        inspectError: RemotePairingError(status: 410, code: code, message: "This code has expired.")
      )
      let model = JunoMobileRemotePairingModel(service: service, token: Self.token)
      await model.start()
      XCTAssertEqual(model.phase, .failed(.expired), code)
      XCTAssertTrue(JunoMobileRemotePairingModel.Failure.expired.message.contains("Show a new code on your Mac"))
    }
  }

  func testApproveRaceLostToExpiryIsExpired() async {
    let service = FakePairingService(
      summary: Self.summary,
      approveError: RemotePairingError(status: 409, code: "used", message: "Already used.")
    )
    let model = JunoMobileRemotePairingModel(service: service, token: Self.token)
    await model.start()
    await model.approve()
    XCTAssertEqual(model.phase, .failed(.expired))
  }

  func testWrongKindAndOtherAccount() async {
    let browser = RemotePairingSummary(
      id: "o", kind: .browser, deviceId: "m", deviceName: "Mac", expiresAt: Date().addingTimeInterval(60)
    )
    var model = JunoMobileRemotePairingModel(service: FakePairingService(summary: browser), token: Self.token)
    await model.start()
    XCTAssertEqual(model.phase, .failed(.wrongKind))

    model = JunoMobileRemotePairingModel(
      service: FakePairingService(inspectError: RemotePairingError(status: 404, code: "not_found", message: "Not found.")),
      token: Self.token
    )
    await model.start()
    XCTAssertEqual(model.phase, .failed(.notFound))

    model = JunoMobileRemotePairingModel(
      service: FakePairingService(inspectError: RemotePairingError(status: 400, code: "wrong_kind", message: "Wrong kind.")),
      token: Self.token
    )
    await model.start()
    XCTAssertEqual(model.phase, .failed(.wrongKind))
  }

  func testCountdownRunningOutExpiresTheScreen() async {
    let model = JunoMobileRemotePairingModel(service: FakePairingService(summary: Self.summary), token: Self.token)
    await model.start()
    model.expire()
    XCTAssertEqual(model.phase, .failed(.expired))
    model.rescan()
    XCTAssertEqual(model.phase, .scanning(hint: nil))
    XCTAssertNil(model.token)
  }

  // MARK: Deep links

  func testPairDeepLinkParsesIntoTheRequest() throws {
    let url = try XCTUnwrap(URL(string: "com.liammagnier.juno://juno/pair?t=\(Self.token)"))
    XCTAssertEqual(JunoMobileLaunchRequests.request(for: url), .pairRemote(token: Self.token))
    XCTAssertEqual(RemotePairingLink.appURL(token: Self.token).flatMap(JunoMobileLaunchRequests.request(for:)),
                   .pairRemote(token: Self.token))
  }

  func testPairDeepLinkWithoutAValidTokenOpensTheScanner() throws {
    let bare = try XCTUnwrap(URL(string: "com.liammagnier.juno://juno/pair"))
    XCTAssertEqual(JunoMobileLaunchRequests.request(for: bare), .pairRemote(token: nil))
    let forged = try XCTUnwrap(URL(string: "com.liammagnier.juno://juno/pair?t=notatoken"))
    XCTAssertEqual(JunoMobileLaunchRequests.request(for: forged), .pairRemote(token: nil))
    let otherScheme = try XCTUnwrap(URL(string: "https://evil.example/pair?t=\(Self.token)"))
    XCTAssertNil(JunoMobileLaunchRequests.request(for: otherScheme))
  }
}

actor FakePairingService: JunoMobileRemotePairingService {
  private let summary: RemotePairingSummary?
  private let inspectError: (any Error)?
  private let approveError: (any Error)?
  private(set) var inspected: [String] = []
  private(set) var approved: [String] = []
  private(set) var denied: [String] = []

  init(summary: RemotePairingSummary? = nil, inspectError: (any Error)? = nil, approveError: (any Error)? = nil) {
    self.summary = summary
    self.inspectError = inspectError
    self.approveError = approveError
  }

  func inspect(token: String) async throws -> RemotePairingSummary {
    inspected.append(token)
    if let inspectError { throw inspectError }
    guard let summary else { throw RemotePairingError(status: 404, code: "not_found", message: "Not found.") }
    return summary
  }

  func approve(token: String) async throws -> RemotePair {
    if let approveError { throw approveError }
    approved.append(token)
    return RemotePair(
      id: "pair_1", kind: .phone, name: "iPhone", platform: "iOS", deviceId: summary?.deviceId ?? "mac",
      deviceName: summary?.deviceName, createdAt: Date(), lastUsedAt: Date()
    )
  }

  func deny(token: String) async throws {
    denied.append(token)
  }
}
