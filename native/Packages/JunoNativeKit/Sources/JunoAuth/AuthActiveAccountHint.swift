import Foundation
import JunoCore

/// A non-secret locator for the account whose credentials were installed last.
///
/// The Keychain is the source of truth for *which* account is active, but a
/// bundle replacement — an app update, a re-signed build, a first launch after
/// restore — can make a single Keychain query transiently unavailable while the
/// items themselves are intact. Without a second locator the app has no account
/// identifier to retry with, so it falls back to the sign-in screen and
/// effectively signs out a user whose credentials were never lost.
///
/// This hint holds only an account identifier: no token, no email, no name.
/// Losing it degrades to "no account remembered", which is the first-launch
/// state every caller already handles, and reading a stale one is harmless
/// because the token item remains the only thing that proves a credential is
/// valid.
///
/// Conformances must be safe to call from any isolation domain; the stores that
/// own one are actors and call it synchronously from inside their isolation.
public protocol AuthActiveAccountHint: Sendable {
    /// The last remembered account, or nil when none has been recorded.
    func load() -> AccountID?

    /// Records the account whose credentials were just installed or read.
    func store(_ accountID: AccountID)

    /// Forgets the remembered account.
    func remove()
}

/// The shipping `AuthActiveAccountHint`, backed by user defaults.
///
/// User defaults rather than the Keychain precisely *because* it fails
/// independently: if it shared a failure mode with the Keychain it could not
/// serve as the fallback locator that motivates the protocol.
public final class UserDefaultsAuthActiveAccountHint: AuthActiveAccountHint,
    @unchecked Sendable
{
    public static let defaultKey = "com.liammagnier.juno.auth.active-account"

    // `@unchecked Sendable` because `UserDefaults` is not annotated `Sendable`
    // in the SDK even though its access is documented as thread-safe, and both
    // stored properties are immutable `let`s. No mutable state is held here;
    // every read and write goes straight to the defaults database.
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
        // A value written by a future or corrupted build is treated as absent
        // rather than propagated: the caller's next step is a Keychain read
        // that does not need this locator to succeed.
        return try? AccountID(rawValue)
    }

    public func store(_ accountID: AccountID) {
        defaults.set(accountID.rawValue, forKey: key)
    }

    public func remove() {
        defaults.removeObject(forKey: key)
    }
}
