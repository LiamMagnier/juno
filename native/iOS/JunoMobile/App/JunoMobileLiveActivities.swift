@preconcurrency import ActivityKit
import Foundation

/// The immutable identity and changing state shown outside Juno while a voice
/// conversation is live. Kept in the app target *and* the widget extension so
/// ActivityKit has one Codable contract at both ends.
struct JunoVoiceActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var phase: String
    var muted: Bool
  }

  var title: String
}

/// The precise approval that a remote Code session is waiting for. `requestID`
/// is deliberately part of the immutable attributes: an Allow tap can never be
/// replayed against a later request from the same session.
struct JunoCodeApprovalActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var summary: String
    var risk: String
  }

  var deviceID: String
  var sessionID: String
  var requestID: String
}

/// One live agent run (a Code session on a paired Mac, or a Work task on a Mac
/// or a cloud computer) on the Lock Screen and in the Dynamic Island.
///
/// Updated locally by the app while it is in the foreground or inside its
/// background execution time (`JunoMobileRunActivities`), and ended when the
/// run leaves the server's live list. `startedAt` is immutable so the elapsed
/// clock is drawn by the system (`Text(timerInterval:)`) and keeps ticking
/// between updates, even when no update can be sent.
struct JunoAgentRunActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var statusLine: String
    var steps: Int
    var currentAction: String?
    var costUSD: Double?
    var pendingApprovals: Int
    var needsYou: Bool
    var usesComputer: Bool
    /// Set on the final update, so the dismissed card says how it ended.
    var finished: Bool
  }

  var runKey: String
  var title: String
  var hostName: String?
  var startedAt: Date
}

/// The deep-link space the widget extension and the Live Activities live in:
/// the auth callback scheme, namespaced under a `juno` host so an OAuth
/// callback is never mistaken for navigation. The builder runs in the
/// extension, the parser (in ``JunoMobileLaunchRequests``) runs in the app,
/// and both sides compile this file, so the routes cannot drift apart.
enum JunoMobileWidgetRoute {
  static let scheme = "com.liammagnier.juno"
  static let host = "juno"

  static func url(path: String) -> URL {
    URL(string: "\(scheme)://\(host)/\(path)")!
  }

  /// The Runs screen, optionally focused on one run, and optionally with that
  /// run's Stop confirmation up. A link only ever opens the screen: the Stop
  /// itself is a second, deliberate tap there, so a forged link can do no more
  /// than show a question.
  static func runsURL(runKey: String? = nil, stop: Bool = false) -> URL {
    var components = URLComponents(url: url(path: "runs"), resolvingAgainstBaseURL: false)!
    var items: [URLQueryItem] = []
    if let runKey { items.append(URLQueryItem(name: "run", value: runKey)) }
    if stop { items.append(URLQueryItem(name: "stop", value: "1")) }
    components.queryItems = items.isEmpty ? nil : items
    return components.url!
  }

  static func approvalURL(
    deviceID: String, sessionID: String, requestID: String, approved: Bool
  ) -> URL {
    var components = URLComponents(url: url(path: "code/approval"), resolvingAgainstBaseURL: false)!
    components.queryItems = [
      URLQueryItem(name: "deviceID", value: deviceID),
      URLQueryItem(name: "sessionID", value: sessionID),
      URLQueryItem(name: "requestID", value: requestID),
      URLQueryItem(name: "approved", value: approved ? "true" : "false"),
    ]
    return components.url!
  }
}

/// What the quick-actions widget offers at each size.
///
/// WidgetKit follows exactly one destination in a small widget and in every
/// Lock Screen accessory: the widget's own URL. Links inside are ignored, so
/// the small square that used to draw four tiles opened the app wherever it
/// was tapped, and the tiles (about 200pt of them) were clipped by a square
/// that is about 160pt tall. Those sizes now offer one action and say so; only
/// the medium widget, where links work, offers the row. Shared with the app so
/// its tests hold every destination to the deep-link parser.
enum JunoMobileQuickAction: String, CaseIterable, Sendable {
  case chat
  case voice
  case code
  case dictate

  /// How many destinations the size can honour.
  enum Room: Sendable {
    /// `systemSmall` and the Lock Screen accessories: the widget URL alone.
    case single
    /// `systemMedium`: a row of links.
    case row
  }

  static func actions(for room: Room) -> [JunoMobileQuickAction] {
    switch room {
    case .single: [.chat]
    case .row: allCases
    }
  }

  var url: URL { JunoMobileWidgetRoute.url(path: rawValue) }
}

#if !WIDGET_EXTENSION
@MainActor
final class JunoMobileLiveActivityCoordinator {
  static let shared = JunoMobileLiveActivityCoordinator()

  private var voiceActivity: Activity<JunoVoiceActivityAttributes>?
  private var approvals: [String: Activity<JunoCodeApprovalActivityAttributes>] = [:]

  private init() {}

  func beginVoice() {
    guard ActivityAuthorizationInfo().areActivitiesEnabled, voiceActivity == nil else { return }
    let attributes = JunoVoiceActivityAttributes(title: "Voice conversation")
    let content = ActivityContent(
      state: JunoVoiceActivityAttributes.ContentState(phase: "Connecting…", muted: false),
      staleDate: nil
    )
    voiceActivity = try? Activity.request(attributes: attributes, content: content)
  }

  /// Mirrors the call's visible state onto the Lock Screen card: the phase the
  /// full-screen view and the dock already show, plus the mute toggle. An
  /// activity that said "Listening" through a muted minute would be lying.
  func updateVoice(phase: String, muted: Bool) {
    guard let voiceActivity else { return }
    let content = ActivityContent(
      state: JunoVoiceActivityAttributes.ContentState(phase: phase, muted: muted), staleDate: nil
    )
    Task { await voiceActivity.update(content) }
  }

  func endVoice() {
    guard let voiceActivity else { return }
    Task {
      await voiceActivity.end(
        ActivityContent(
          state: JunoVoiceActivityAttributes.ContentState(phase: "Ended", muted: false),
          staleDate: nil
        ),
        dismissalPolicy: .immediate
      )
    }
    self.voiceActivity = nil
  }

  func presentApproval(
    deviceID: String, sessionID: String, requestID: String, summary: String, risk: String
  ) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled, approvals[requestID] == nil else { return }
    let attributes = JunoCodeApprovalActivityAttributes(
      deviceID: deviceID, sessionID: sessionID, requestID: requestID
    )
    let content = ActivityContent(
      state: JunoCodeApprovalActivityAttributes.ContentState(summary: summary, risk: risk),
      staleDate: nil
    )
    approvals[requestID] = try? Activity.request(attributes: attributes, content: content)
  }

  func resolveApproval(requestID: String) {
    guard let activity = approvals.removeValue(forKey: requestID) else { return }
    Task {
      await activity.end(
        ActivityContent(
          state: JunoCodeApprovalActivityAttributes.ContentState(
            summary: "Decision sent", risk: ""
          ), staleDate: nil
        ), dismissalPolicy: .immediate
      )
    }
  }
}
#endif
