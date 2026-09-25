#if canImport(UserNotifications)
import UserNotifications

/// When Juno may show what the server pushes.
///
/// Two steps, because a permission prompt before the person has seen what
/// would notify them is the prompt that gets refused. At sign-in the app takes
/// quiet delivery, which iOS and macOS grant without asking: pushes land in
/// Notification Center with a Keep or Turn off choice under them. The real
/// question — banners and sounds — is asked where its answer is obvious: after
/// hiring an agent, or from Settings.
extension NativePushRegistrar {
    /// Takes quiet delivery when nothing has been decided yet. Never prompts,
    /// and never touches a decision the person has already made.
    public func requestQuietAuthorizationIfUndetermined() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge, .provisional])
    }

    /// Asks for banners and sounds when they are not already allowed. Quiet
    /// delivery counts as not yet asked: the system shows the prompt once
    /// from there. A refusal is final until the person changes it in the
    /// system's Settings, so this never asks twice.
    ///
    /// - Returns: whether alerts are allowed now.
    @discardableResult
    public func requestFullAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        switch status {
        case .notDetermined, .provisional:
            let granted = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            return granted ?? false
        case .denied:
            return false
        default:
            // Allowed. Spelled as a default because `.ephemeral`, the App
            // Clip grant, does not exist on the Mac.
            return true
        }
    }
}
#endif
