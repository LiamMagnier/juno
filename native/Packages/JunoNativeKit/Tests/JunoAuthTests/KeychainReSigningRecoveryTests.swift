import Foundation
import JunoCore
import XCTest
@testable import JunoAuth

/*
 * Signing in again after the running build lost access to the saved credential.
 *
 * Keychain ACLs name the *code signature*, not the bundle id. An app re-signed
 * with a different certificate — a development build replacing a Developer ID
 * one, or the reverse — is a different application as far as the ACL is
 * concerned, and macOS answers `errSecAuthFailed` (-25293) rather than "not
 * found". Juno 0.5.0 shipped that way and users upgrading from an earlier
 * build met "Keychain error -25293 — authentication failed".
 *
 * The *read* side of that is already handled deliberately elsewhere: the
 * runtime keeps the cached session visible as `.unverified` with a cause
 * instead of signing the user out, because the same status also covers
 * transient conditions (see `NativeAuthRuntimeTests`). What was missing is the
 * way out. Signing in again went to `SecItemAdd`, came back
 * `errSecDuplicateItem`, fell through to `SecItemUpdate`, and hit the same ACL
 * — so the user could never get back to a working state by any action
 * available to them.
 */
final class KeychainReSigningRecoveryTests: XCTestCase {
    func testSigningInReplacesACredentialThisBuildCannotRead() async throws {
        let client = ResignedSecurityClient()
        let store = KeychainAuthTokenStore(securityClient: client)
        let tokens = try makeResignTokens()
        client.seedUnreadable(for: tokens.accountID)

        try await store.storeInitial(tokens)

        // The whole point: without clear-then-write this throws, and the user
        // is stuck at sign-in permanently with no action that helps.
        let loaded = try await store.load(for: tokens.accountID)
        XCTAssertEqual(loaded, tokens)
    }

    func testTheStaleCredentialIsRemovedRatherThanUpdatedInPlace() async throws {
        let client = ResignedSecurityClient()
        let store = KeychainAuthTokenStore(securityClient: client)
        let tokens = try makeResignTokens()
        client.seedUnreadable(for: tokens.accountID)

        try await store.storeInitial(tokens)

        // Updating cannot work — the ACL refuses it. Deleting can, because
        // removing an item does not require decrypting its value.
        XCTAssertTrue(client.deleted.contains { $0.account == tokens.accountID.rawValue })
    }

    func testAnOrdinarySignInDoesNotDeleteAnything() async throws {
        let client = ResignedSecurityClient()
        let store = KeychainAuthTokenStore(securityClient: client)
        let tokens = try makeResignTokens()

        try await store.storeInitial(tokens)

        // Recovery must stay on the failure path. A delete-then-add on the
        // ordinary path would open a window where the credential is simply
        // gone if the add then fails.
        XCTAssertTrue(client.deleted.isEmpty)
        let loaded = try await store.load(for: tokens.accountID)
        XCTAssertEqual(loaded, tokens)
    }

    func testAFailureThatIsNotAnACLWallStillPropagates() async throws {
        let client = ResignedSecurityClient()
        client.writeStatus = errSecNotAvailable
        let store = KeychainAuthTokenStore(securityClient: client)
        let tokens = try makeResignTokens()
        client.seedUnreadable(for: tokens.accountID)

        // No keychain at all is not something deleting fixes. Swallowing it
        // would report a sign-in that did not persist.
        do {
            try await store.storeInitial(tokens)
            XCTFail("an unavailable Keychain should not report success")
        } catch {
            // Surfaced as itself, not converted into the re-signing story —
            // the cause reaches a bug report, and the two need different fixes.
            let loaded = try? await store.load(for: tokens.accountID)
            XCTAssertNil(loaded ?? nil)
        }
    }

    private func makeResignTokens() throws -> AuthTokenSet {
        try AuthTokenSet(
            accountID: AccountID("acct_resigned"),
            deviceID: DeviceID("device_resigned"),
            accessToken: AccessToken("access-resigned"),
            accessTokenExpiresAt: Date(timeIntervalSince1970: 2_000_003_600),
            refreshToken: RefreshToken(
                "refresh-resigned-0000000000000000000000000000"
            ),
            refreshTokenExpiresAt: Date(timeIntervalSince1970: 2_002_592_000)
        )
    }
}

/// A keychain holding items written by a differently-signed build.
///
/// Writes to those items fail the way macOS fails them; deletes succeed,
/// because removing an item does not require decrypting its value. That
/// asymmetry is the only reason recovery is possible, so the double models it.
private final class ResignedSecurityClient: SecurityKeychainClient, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [SecurityKeychainItem: Data] = [:]
    private var unreadable: Set<SecurityKeychainItem> = []
    private var deletedItems: [SecurityKeychainItem] = []

    /// How writes to an inaccessible item fail. Overridable to cover failures
    /// that are *not* a re-signing and that deleting would not fix.
    var writeStatus: OSStatus = errSecAuthFailed

    var deleted: [SecurityKeychainItem] { lock.withLock { deletedItems } }

    func seedUnreadable(for accountID: AccountID) {
        lock.withLock {
            let item = SecurityKeychainItem(
                service: KeychainAuthTokenStore.defaultService,
                account: accountID.rawValue,
                accessGroup: nil
            )
            items[item] = Data("written by another signature".utf8)
            unreadable.insert(item)
        }
    }

    func read(_ item: SecurityKeychainItem) throws -> Data? {
        try lock.withLock {
            if unreadable.contains(item) {
                throw SecurityKeychainClientError.unexpectedStatus(Int32(errSecAuthFailed))
            }
            return items[item]
        }
    }

    func upsert(_ data: Data, for item: SecurityKeychainItem) throws {
        try lock.withLock {
            if unreadable.contains(item) {
                // SecItemAdd answers errSecDuplicateItem, and the SecItemUpdate
                // behind it meets the same ACL. The double just fails, as macOS
                // does; recovering is the store's job, and `delete` below is
                // the only thing that clears `unreadable`.
                throw SecurityKeychainClientError.unexpectedStatus(Int32(writeStatus))
            }
            items[item] = data
        }
    }

    func insertIfAbsent(_ data: Data, for item: SecurityKeychainItem) throws -> Bool {
        try lock.withLock {
            if unreadable.contains(item) {
                throw SecurityKeychainClientError.unexpectedStatus(Int32(writeStatus))
            }
            guard items[item] == nil else { return false }
            items[item] = data
            return true
        }
    }

    func delete(_ item: SecurityKeychainItem) throws -> Bool {
        lock.withLock {
            deletedItems.append(item)
            unreadable.remove(item)
            return items.removeValue(forKey: item) != nil
        }
    }
}
