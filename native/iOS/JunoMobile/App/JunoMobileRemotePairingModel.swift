import Foundation
import JunoCodeKit
import JunoCore
import JunoSync
import Observation

/// The three pairing calls the phone makes, so the flow is tested without a
/// backend.
protocol JunoMobileRemotePairingService: Sendable {
  func inspect(token: String) async throws -> RemotePairingSummary
  func approve(token: String) async throws -> RemotePair
  func deny(token: String) async throws
}

/// ``RemotePairingClient`` bound to the signed-in account.
struct JunoMobileRemotePairingClientService: JunoMobileRemotePairingService {
  let client: RemotePairingClient
  let accountID: AccountID

  func inspect(token: String) async throws -> RemotePairingSummary {
    try await client.inspect(token: token, for: accountID)
  }

  func approve(token: String) async throws -> RemotePair {
    try await client.approve(token: token, for: accountID)
  }

  func deny(token: String) async throws {
    try await client.deny(token: token, for: accountID)
  }
}

/// The iPhone's half of pairing (docs/code-v2/REMOTE-CONTROL.md §1): scan or
/// open an offer, show who is asking, approve or deny.
///
/// Nothing is approved until the person taps Approve: scanning only inspects.
@MainActor
@Observable
final class JunoMobileRemotePairingModel {
  enum Failure: Equatable, Sendable {
    /// Expired or already used: the Mac has to show a new code.
    case expired
    /// A browser's offer opened on the phone.
    case wrongKind
    /// Another account's offer, or one that does not exist.
    case notFound
    case other(String)

    var title: String {
      switch self {
      case .expired: "This code has expired"
      case .wrongKind: "This code is for a browser"
      case .notFound: "This code is not for this account"
      case .other: "Pairing did not finish"
      }
    }

    var message: String {
      switch self {
      case .expired:
        "Codes last two minutes and work once. Show a new code on your Mac and scan it again."
      case .wrongKind:
        "On your Mac, choose Phone in Control this Mac remotely, then scan the code it shows."
      case .notFound:
        "Sign in to the same Alevr account on this iPhone and your Mac, then show a new code."
      case let .other(message):
        message
      }
    }
  }

  enum Phase: Equatable {
    /// The camera is looking for a code. `hint` answers a QR that was not one.
    case scanning(hint: String?)
    case inspecting
    case ready(RemotePairingSummary)
    case approving(RemotePairingSummary)
    case denying(RemotePairingSummary)
    case paired(macName: String)
    case denied(macName: String)
    case failed(Failure)
  }

  static let notAPairingCodeHint = "That is not an Alevr pairing code. Scan the code on your Mac."

  private(set) var phase: Phase
  private(set) var token: String?
  private let service: any JunoMobileRemotePairingService

  init(service: any JunoMobileRemotePairingService, token: String? = nil) {
    self.service = service
    self.token = token
    phase = token == nil ? .scanning(hint: nil) : .inspecting
  }

  /// The summary on screen, while there is one.
  var summary: RemotePairingSummary? {
    switch phase {
    case let .ready(summary), let .approving(summary), let .denying(summary): summary
    default: nil
    }
  }

  /// Opens the offer the sheet was presented with.
  func start() async {
    guard let token, phase == .inspecting else { return }
    await inspect(token)
  }

  /// A QR the camera read, or a pasted link. Not an Alevr offer: a hint, and
  /// the camera keeps looking.
  func scanned(_ text: String) async {
    guard case .scanning = phase else { return }
    guard let token = RemotePairingLink.token(from: text) else {
      phase = .scanning(hint: Self.notAPairingCodeHint)
      return
    }
    self.token = token
    phase = .inspecting
    await inspect(token)
  }

  func approve() async {
    guard case let .ready(summary) = phase, let token else { return }
    phase = .approving(summary)
    do {
      let pair = try await service.approve(token: token)
      phase = .paired(macName: pair.deviceName ?? summary.deviceName)
    } catch {
      phase = .failed(Self.failure(for: error))
    }
  }

  func deny() async {
    guard case let .ready(summary) = phase, let token else { return }
    phase = .denying(summary)
    do {
      try await service.deny(token: token)
    } catch {
      // A deny that did not land changes nothing: the offer expires on its
      // own in two minutes, and no pair was made.
    }
    phase = .denied(macName: summary.deviceName)
  }

  /// "Scan again" after a failure.
  func rescan() {
    token = nil
    phase = .scanning(hint: nil)
  }

  /// The offer's two minutes ran out while the screen was up.
  func expire() {
    guard case .ready = phase else { return }
    phase = .failed(.expired)
  }

  private func inspect(_ token: String) async {
    do {
      let summary = try await service.inspect(token: token)
      guard summary.kind == .phone else {
        phase = .failed(.wrongKind)
        return
      }
      phase = summary.expiresAt <= Date() ? .failed(.expired) : .ready(summary)
    } catch {
      phase = .failed(Self.failure(for: error))
    }
  }

  static func failure(for error: any Error) -> Failure {
    guard let error = error as? RemotePairingError else {
      return .other("Alevr could not reach the server. Check the connection and try again.")
    }
    if error.isExpiredOrUsed { return .expired }
    switch error.code {
    case "wrong_kind": return .wrongKind
    case "not_found": return .notFound
    default:
      if error.status == 404 { return .notFound }
      if error.status == 410 { return .expired }
      return .other(error.message)
    }
  }
}
