import Foundation
import JunoCore

/// A non-secret locator for the account whose bearer credentials live in the
/// Keychain.
///
/// The credentials themselves never leave ``SecurityKeychainClient``. This
/// small hint exists because macOS can temporarily lose access to one
/// Keychain item while an app bundle is being replaced or re-signed, even
/// though the account-scoped credential item remains available. Keeping the
/// locator in the app's normal preferences lets the next launch find that
/// credential and repair the Keychain pointer instead of treating the user as
/// signed out.
public protocol AuthActiveAccountHint: Sendable {
    func load() -> AccountID?
    func store(_ accountID: AccountID)
    func remove()
}

/// The production locator. An account ID is not a credential or an access
/// token, so it is safe to keep as a preference. ``UserDefaults.standard`` is
/// scoped to the app's bundle identifier and therefore survives app updates
/// without being shared with another Juno target.
public final class UserDefaultsAuthActiveAccountHint: AuthActiveAccountHint,
    @unchecked Sendable
{
    public static let defaultKey = "juno.auth.active-account-id"

    private let defaults: UserDefaults
    private let key: String

    public init(
        defaults: UserDefaults = .standard,
        key: String = UserDefaultsAuthActiveAccountHint.defaultKey
    ) {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> AccountID? {
        guard let rawValue = defaults.string(forKey: key) else { return nil }
        return try? AccountID(rawValue)
    }

    public func store(_ accountID: AccountID) {
        defaults.set(accountID.rawValue, forKey: key)
    }

    public func remove() {
        defaults.removeObject(forKey: key)
    }
}
