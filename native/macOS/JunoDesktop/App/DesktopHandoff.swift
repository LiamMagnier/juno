import AppKit
import Foundation
import JunoAuth
import JunoCodeCore
import JunoCodeKit
import JunoCodeUI
import JunoCore
import JunoSync
import SwiftUI

/// Apple Handoff and "Continue on…" for the open Chat or Code thread
/// (docs/code-v2/REMOTE-CONTROL.md §5).
///
/// While a thread is on screen the Mac advertises it as an `NSUserActivity`
/// of ``JunoHandoff/activityType`` (declared under `NSUserActivityTypes`),
/// ids only, with the thread's web address as the fallback. Continuing one
/// here, or tapping an `ALEVR_HANDOFF` notification, opens the same thread.
enum DesktopHandoff {
    /// The web fallback's origin.
    static var webBase: URL { JunoBackend.productionURL }

    /// Fills an activity SwiftUI hands `.userActivity(_:isActive:_:)`.
    static func configure(_ activity: NSUserActivity, with handoff: JunoHandoff, base: URL = webBase) {
        activity.title = handoff.title.flatMap { $0.isEmpty ? nil : $0 }
            ?? (handoff.kind == .chat ? "Alevr chat" : "Alevr Code")
        activity.userInfo = handoff.userInfo
        activity.requiredUserInfoKeys = Set(handoff.userInfo.keys)
        activity.webpageURL = handoff.webURL(base: base)
        activity.isEligibleForHandoff = true
        // Nothing about a thread belongs in Spotlight or a public index.
        activity.isEligibleForSearch = false
        activity.isEligibleForPublicIndexing = false
    }

    // MARK: Continuing here

    /// Where a continued thread lands on this Mac.
    enum Destination: Equatable {
        case conversation(String)
        /// A Code session this Mac runs, by its Code thread id.
        case codeSession(String)
        /// Code, as it was: the session is another Mac's, or this Mac no
        /// longer has it.
        case code
    }

    /// `threadID` maps an env-server session to this Mac's Code thread.
    static func destination(
        for handoff: JunoHandoff, thisDeviceID: String?, threadID: (String) -> String?
    ) -> Destination {
        switch handoff.kind {
        case .chat:
            return .conversation(handoff.id)
        case .code:
            guard let thisDeviceID, handoff.deviceID == thisDeviceID else { return .code }
            return threadID(handoff.id).map(Destination.codeSession) ?? .code
        }
    }

    /// An `ALEVR_HANDOFF` notification's payload (`handoff` = chat or code).
    static func handoff(fromNotification info: [String: String]) -> JunoHandoff? {
        switch info["handoff"] {
        case "chat":
            guard let id = info["conversationId"] ?? info["conversationID"] else { return nil }
            return JunoHandoff(userInfo: ["kind": "chat", "id": id, "title": info["title"] ?? ""])
        case "code":
            guard let device = info["deviceID"] ?? info["deviceId"], let session = info["sessionID"] ?? info["sessionId"]
            else { return nil }
            var payload = ["kind": "code", "id": session, "deviceID": device]
            if let title = info["title"] { payload["title"] = title }
            return JunoHandoff(userInfo: payload)
        default:
            return nil
        }
    }

    /// The device id this Mac registered with, for telling its own Code
    /// sessions from another Mac's. Set by the root view while signed in.
    @MainActor static var thisDeviceID: @MainActor () -> String? = { nil }

    /// Continues a thread here: brings the main window forward on it.
    @MainActor
    static func open(_ handoff: JunoHandoff) {
        let destination = destination(for: handoff, thisDeviceID: thisDeviceID()) {
            CodeV2SessionBindings.shared.threadID(forEnvSession: $0)
        }
        perform(destination)
    }

    @MainActor
    static func perform(_ destination: Destination) {
        switch destination {
        case .conversation(let id):
            JunoDesktopWindow.follow(.conversation(id: id))
        case .codeSession(let threadID):
            DesktopWorkbenchRegistry.shared.request(.openSession(CodeSessionID(value: threadID)))
            JunoDesktopWindow.presentMainWindow()
        case .code:
            DesktopWorkbenchRegistry.shared.request(.showCode)
            JunoDesktopWindow.presentMainWindow()
        }
    }

    /// An activity the system handed the app, from the delegate or a scene.
    @MainActor
    @discardableResult
    static func continueActivity(_ activity: NSUserActivity) -> Bool {
        guard activity.activityType == JunoHandoff.activityType,
            let handoff = JunoHandoff(userInfo: activity.userInfo)
        else { return false }
        // The delegate and the scene can both be offered the same activity.
        let now = Date()
        if lastContinued?.handoff == handoff, let at = lastContinued?.at, now.timeIntervalSince(at) < 2 { return true }
        lastContinued = (handoff, now)
        open(handoff)
        return true
    }

    @MainActor private static var lastContinued: (handoff: JunoHandoff, at: Date)?

    // MARK: Continue on…

    enum ContinueResult: Equatable {
        case sent(String)
        case openedWeb
        case failed(String)
    }

    /// "Continue on iPhone" asks the backend to ring the account's iPhones;
    /// "Continue on the web" opens the thread's web address here.
    @MainActor
    static func continueOn(
        _ target: JunoHandoff.Target,
        _ handoff: JunoHandoff,
        client: ThreadSyncClient?,
        accountID: AccountID?,
        openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    ) async -> ContinueResult {
        if target == .web {
            openURL(handoff.webURL(base: webBase))
            return .openedWeb
        }
        guard let client, let accountID else {
            return .failed("Sign in to send this thread to your iPhone.")
        }
        do {
            try await client.handOff(handoff, to: target, for: accountID)
            return .sent(target == .ios ? "Sent to your iPhone. Tap the notification to carry on there." : "Sent.")
        } catch let error as JunoHandoffError {
            return .failed(error.errorDescription ?? "Alevr could not send this thread.")
        } catch {
            return .failed("Alevr could not reach your iPhone. Check your connection, then try again.")
        }
    }
}

extension View {
    /// Advertises `handoff` for Apple Handoff while it is non-nil.
    func desktopHandoff(_ handoff: JunoHandoff?) -> some View {
        userActivity(JunoHandoff.activityType, isActive: handoff != nil) { activity in
            guard let handoff else { return }
            DesktopHandoff.configure(activity, with: handoff)
        }
    }
}
