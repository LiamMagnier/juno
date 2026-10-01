import Foundation
import JunoScreenControl

/// The reader's standing narrowing of screen control: apps denied, tiers
/// lowered, finance apps allowed to be looked at (Settings → Screen
/// control → Apps).
///
/// User defaults on this Mac, never a project file: a repository must not be
/// able to change what Juno may do to the reader's other apps (CU-08). It
/// can only narrow — the service applies `min(category cap, this)` — and it
/// grants nothing; grants are per session (D-021).
public struct ScreenControlPreferencesStore: @unchecked Sendable {
    private let defaults: UserDefaults
    static let key = "juno.screenControl.preferences"

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public static let standard = ScreenControlPreferencesStore(defaults: .standard)

    public func load() -> ScreenControlPreferences {
        guard let data = defaults.data(forKey: Self.key),
              let preferences = try? JSONDecoder().decode(ScreenControlPreferences.self, from: data)
        else { return .default }
        return preferences
    }

    public func save(_ preferences: ScreenControlPreferences) {
        guard let data = try? JSONEncoder().encode(preferences) else { return }
        defaults.set(data, forKey: Self.key)
    }

    /// Sets one app's tier, or denies it with nil. A tier at or above the
    /// category's cap clears the entry: there is nothing to narrow.
    public func set(_ bundleID: String, tier: AppTier?) -> ScreenControlPreferences {
        var preferences = load()
        let key = bundleID.lowercased()
        let cap = AppCategories.category(bundleID: key).cap
        preferences.denied.remove(key)
        preferences.loweredTiers[key] = nil
        if let tier {
            if let cap, tier < cap { preferences.loweredTiers[key] = tier }
        } else {
            preferences.denied.insert(key)
        }
        save(preferences)
        return preferences
    }

    public func remove(_ bundleID: String) -> ScreenControlPreferences {
        var preferences = load()
        let key = bundleID.lowercased()
        preferences.denied.remove(key)
        preferences.loweredTiers[key] = nil
        preferences.allowedFinance.remove(key)
        save(preferences)
        return preferences
    }
}
