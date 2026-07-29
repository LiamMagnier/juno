import Foundation
import JunoCore

/// The last account profile the server confirmed, cached so a launch that
/// cannot reach Juno can still open the app instead of showing the sign-in
/// screen.
///
/// Deliberately a **separate** Keychain item from `KeychainAuthTokenStore`
/// rather than another field on `StoredAuthTokenSet`. That record is
/// version-pinned (`stored.version == currentVersion`, anything else is
/// `malformedData`), so widening it would make every already-installed app fail
/// to read its own credentials on the next launch — signing out exactly the
/// users this cache exists to keep signed in. A separate item degrades to
/// "no cache yet" instead, which is a first-launch state the caller already
/// handles.
///
/// The profile carries an email address, so it lives in the Keychain with the
/// tokens rather than in UserDefaults, and it is deleted whenever the account's
/// credentials are.
public actor KeychainSessionCacheStore {
    public static let defaultService = "com.liammagnier.juno.auth.session-cache"

    private let securityClient: any SecurityKeychainClient
    private let service: String
    private let accessGroup: String?

    public init(
        securityClient: any SecurityKeychainClient,
        service: String = KeychainSessionCacheStore.defaultService,
        accessGroup: String? = nil
    ) {
        self.securityClient = securityClient
        self.service = service
        self.accessGroup = accessGroup
    }

    /// Records a session the server has just confirmed. Best-effort by
    /// contract: a cache write must never fail a sign-in that already worked.
    public func store(_ session: NativeAuthenticatedSession) {
        guard let data = try? JSONEncoder().encode(StoredSession(session)) else { return }
        try? securityClient.upsert(data, for: item(for: session.profile.id))
    }

    /// Returns the cached session for an account, or nil when there is none —
    /// including when the stored blob is from an older, unreadable shape.
    public func load(for accountID: AccountID) -> NativeAuthenticatedSession? {
        guard let data = try? securityClient.read(item(for: accountID)),
            let stored = try? JSONDecoder().decode(StoredSession.self, from: data),
            stored.version == StoredSession.currentVersion,
            stored.accountID == accountID.rawValue,
            let profileID = try? AccountID(stored.accountID),
            let deviceID = try? DeviceID(stored.deviceID)
        else {
            return nil
        }
        let profile = NativeAccountProfile(
            id: profileID,
            name: stored.name,
            email: stored.email,
            image: stored.image
        )
        return NativeAuthenticatedSession(profile: profile, deviceID: deviceID)
    }

    public func remove(for accountID: AccountID) {
        _ = try? securityClient.delete(item(for: accountID))
    }

    private func item(for accountID: AccountID) -> SecurityKeychainItem {
        SecurityKeychainItem(
            service: service,
            account: accountID.rawValue,
            accessGroup: accessGroup
        )
    }
}

private struct StoredSession: Codable {
    static let currentVersion = 1

    let version: Int
    let accountID: String
    let deviceID: String
    let name: String?
    let email: String
    let image: String?

    init(_ session: NativeAuthenticatedSession) {
        version = Self.currentVersion
        accountID = session.profile.id.rawValue
        deviceID = session.deviceID.rawValue
        name = session.profile.name
        email = session.profile.email
        image = session.profile.image
    }
}
