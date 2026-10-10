import Foundation
import Observation

/// Where remote control requests land once the shell has taken them
/// (docs/code-v2/REMOTE-CONTROL.md): the pairing sheet, a session on a paired
/// Mac through the device link, an approval answered from a notification.
///
/// ``JunoMobileLaunchRequests`` is how the system asks (a link, a scanned QR,
/// a notification, Handoff); the root view hands remote requests here, and the
/// surfaces that own them (the pairing sheet, Code's remote) observe this and
/// clear what they act on. One seam, so those surfaces never depend on each
/// other.
@MainActor
@Observable
final class JunoMobileRemoteRouting {
  static let shared = JunoMobileRemoteRouting()

  struct LinkSession: Equatable, Sendable {
    let deviceID: String
    let sessionID: String
  }

  struct LinkApproval: Equatable, Sendable {
    let deviceID: String
    let sessionID: String
    let requestID: String
    let approved: Bool
  }

  /// The pairing sheet should show. `token` is a scanned or linked offer; nil opens the scanner.
  var pairing: PairingRequest?
  /// A session on a paired Mac to open in Code.
  var linkSession: LinkSession?
  /// An approval answered from a notification, while the app was in front.
  var linkApproval: LinkApproval?

  struct PairingRequest: Equatable, Sendable, Identifiable {
    let id = UUID()
    let token: String?
  }

  private init() {}
}
