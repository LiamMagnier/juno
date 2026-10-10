import Foundation
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI
import UIKit

/// Apple Handoff on the iPhone (docs/code-v2/REMOTE-CONTROL.md §5): the open
/// Chat or Code thread advertised as a `com.liammagnier.juno.thread`
/// activity, so the Mac (or the browser, through `webpageURL`) picks it up,
/// and the same activity from the Mac continued here.
enum JunoMobileHandoff {
  /// Where the web fallback points: the backend the app talks to.
  static var webBase: URL { JunoBackend.productionURL }

  /// Fills an activity for `handoff`: ids only, the web fallback, a title.
  static func configure(_ activity: NSUserActivity, with handoff: JunoHandoff, base: URL = webBase) {
    activity.title = handoff.title.flatMap { $0.isEmpty ? nil : $0 }
      ?? (handoff.kind == .chat ? "Alevr chat" : "Alevr Code")
    activity.userInfo = handoff.userInfo
    activity.requiredUserInfoKeys = Set(handoff.userInfo.keys)
    activity.webpageURL = handoff.webURL(base: base)
    activity.isEligibleForHandoff = true
    // Ids are not something to find in Spotlight; the conversation index
    // (JunoMobileSpotlight) already does that.
    activity.isEligibleForSearch = false
    activity.needsSave = true
  }

  /// A new activity for `handoff`, as the Mac's app reads it.
  static func activity(for handoff: JunoHandoff, base: URL = webBase) -> NSUserActivity {
    let activity = NSUserActivity(activityType: JunoHandoff.activityType)
    configure(activity, with: handoff, base: base)
    return activity
  }

  /// What continuing a thread opens here.
  static func request(for handoff: JunoHandoff) -> JunoMobileLaunchRequests.Request? {
    switch handoff.kind {
    case .chat:
      return .openConversation(handoff.id)
    case .code:
      guard let deviceID = handoff.deviceID else { return nil }
      return .openLinkSession(deviceID: deviceID, sessionID: handoff.id)
    }
  }

  /// Continues an activity: a thread from the Mac, or a browsing activity
  /// whose page is an Alevr chat (`/chat/<id>`).
  static func request(
    continuing activityType: String,
    userInfo: [AnyHashable: Any]?,
    webpageURL: URL?,
    base: URL = webBase
  ) -> JunoMobileLaunchRequests.Request? {
    if activityType == JunoHandoff.activityType {
      return JunoHandoff(userInfo: userInfo).flatMap(request(for:))
    }
    if activityType == NSUserActivityTypeBrowsingWeb, let webpageURL {
      return request(forWebURL: webpageURL, base: base)
    }
    return nil
  }

  /// `https://<backend>/chat/<id>` → that chat. Anything else is nil.
  static func request(forWebURL url: URL, base: URL = webBase) -> JunoMobileLaunchRequests.Request? {
    guard url.scheme == "https", url.host() == base.host() else { return nil }
    let path = url.pathComponents.filter { $0 != "/" }
    guard path.count == 2, path[0] == "chat",
      let chat = JunoHandoff(userInfo: ["kind": "chat", "id": path[1]])
    else { return nil }
    return .openConversation(chat.id)
  }
}

extension View {
  /// Advertises `handoff` to the person's other devices while this view is on
  /// screen; nil advertises nothing. Code's thread view applies it with
  /// `JunoHandoff.code(deviceID:sessionID:title:conversationID:)`.
  func junoHandoff(_ handoff: JunoHandoff?) -> some View {
    userActivity(JunoHandoff.activityType, element: handoff) { handoff, activity in
      JunoMobileHandoff.configure(activity, with: handoff)
    }
  }

  /// Continues a thread handed off from the Mac, and an Alevr chat link
  /// opened as a browsing activity.
  func junoContinueHandoff(_ open: @escaping (JunoMobileLaunchRequests.Request) -> Void) -> some View {
    onContinueUserActivity(JunoHandoff.activityType) { activity in
      if let request = JunoMobileHandoff.request(
        continuing: activity.activityType, userInfo: activity.userInfo, webpageURL: activity.webpageURL
      ) {
        open(request)
      }
    }
    .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
      if let request = JunoMobileHandoff.request(
        continuing: activity.activityType, userInfo: activity.userInfo, webpageURL: activity.webpageURL
      ) {
        open(request)
      }
    }
  }
}

// MARK: - Continue on

/// "Continue on Mac" and "Open on the web" for a thread's menu, with the
/// answer it got. Chat's conversation menu carries it; Code's thread menu can
/// too: `JunoMobileContinueOnMenu(handoff: .code(deviceID:sessionID:title:))`.
///
/// Mac: the backend sends the Mac a notification that opens this thread.
/// Web: the thread's page in Safari.
struct JunoMobileContinueOnMenu: View {
  let handoff: JunoHandoff
  /// Where the result is shown: the screen holding the menu owns the alert,
  /// because a menu's own state is gone the moment it closes.
  @Binding var notice: JunoMobileHandoffNotice?

  @Environment(\.junoThreadSync) private var threadSync
  @Environment(\.openURL) private var openURL

  var body: some View {
    Section("Continue on") {
      if threadSync != nil {
        Button {
          continueOnMac()
        } label: {
          Label("Continue on Mac", image: JunoIcon.device.assetName(.regular))
        }
        .contentShape(.rect)
        .accessibilityIdentifier("juno.mobile.continue-on-mac")
      }
      Button {
        openURL(handoff.webURL(base: JunoMobileHandoff.webBase))
      } label: {
        Label("Open on the web", image: JunoIcon.web.assetName(.regular))
      }
      .contentShape(.rect)
      .accessibilityIdentifier("juno.mobile.continue-on-web")
    }
  }

  private func continueOnMac() {
    guard let threadSync else { return }
    let handoff = handoff
    Task {
      do {
        try await threadSync.handOff(handoff, to: .macos)
        notice = .sent
      } catch let JunoHandoffError.refused(message) {
        notice = .refused(message)
      } catch {
        notice = .refused("Alevr could not reach your Mac. Try again in a moment.")
      }
    }
  }
}

/// What "Continue on Mac" answered.
enum JunoMobileHandoffNotice: Identifiable, Equatable {
  case sent
  case refused(String)

  var id: String {
    switch self {
    case .sent: "sent"
    case let .refused(message): "refused:\(message)"
    }
  }

  var title: String {
    switch self {
    case .sent: "Sent to your Mac"
    case .refused: "Could not continue on Mac"
    }
  }

  var message: String {
    switch self {
    case .sent: "Open the notification on your Mac to pick up where you left off."
    case let .refused(message): message
    }
  }
}

extension View {
  /// The alert for a ``JunoMobileContinueOnMenu`` result.
  func junoHandoffNotice(_ notice: Binding<JunoMobileHandoffNotice?>) -> some View {
    alert(
      notice.wrappedValue?.title ?? "",
      isPresented: Binding(get: { notice.wrappedValue != nil }, set: { if !$0 { notice.wrappedValue = nil } }),
      presenting: notice.wrappedValue
    ) { _ in
      Button("OK", role: .cancel) {}
    } message: { notice in
      Text(notice.message)
    }
  }
}
