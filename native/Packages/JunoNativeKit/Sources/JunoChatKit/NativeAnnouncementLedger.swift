import Foundation

/// Which announcements this device has already shown and had closed, so each
/// one opens once (`announcement-popup.tsx` keeps the same list in local
/// storage beside the server's own dismissal).
///
/// The key and shape are the Mac's (`DesktopFirstRunPresenter`): a string
/// array under `juno.dismissedAnnouncements`, newest last, kept to the last
/// 200 ids.
public struct NativeAnnouncementLedger: @unchecked Sendable {
    public static let dismissedKey = "juno.dismissedAnnouncements"
    public static let capacity = 200

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var dismissed: Set<String> {
        Set(defaults.stringArray(forKey: Self.dismissedKey) ?? [])
    }

    /// Whether this announcement should open: it exists and was not closed
    /// here before.
    public func shouldShow(_ announcement: NativeAnnouncement?) -> Bool {
        guard let announcement else { return false }
        return !dismissed.contains(announcement.id)
    }

    public func markDismissed(_ id: String) {
        var list = defaults.stringArray(forKey: Self.dismissedKey) ?? []
        guard !list.contains(id) else { return }
        list.append(id)
        defaults.set(Array(list.suffix(Self.capacity)), forKey: Self.dismissedKey)
    }
}
