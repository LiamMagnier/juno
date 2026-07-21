import Foundation
import JunoCore
import XCTest
@testable import JunoAuth

final class KeychainAuthTokenStoreTests: XCTestCase {
    func testRoundTripUsesAccountScopedDeviceLocalItem() async throws {
        let client = RecordingSecurityClient()
        let store = try KeychainAuthTokenStore(
            service: "test.juno.tokens",
            accessGroup: "test.juno.group",
            securityClient: client
        )
        let tokens = try makeTokens(account: "acct_one", device: "device_one")

        try await store.storeInitial(tokens)

        let loaded = try await store.load(for: tokens.accountID)
        XCTAssertEqual(loaded, tokens)
        let item = client.lastItem
        XCTAssertEqual(
            item,
            SecurityKeychainItem(
                service: "test.juno.tokens",
                account: "acct_one",
                accessGroup: "test.juno.group"
            )
        )
    }

    func testStoreInitialReplacesCredentialForSameAccount() async throws {
        let client = RecordingSecurityClient()
        let store = KeychainAuthTokenStore(securityClient: client)
        let first = try makeTokens(suffix: "first")
        let second = try makeTokens(suffix: "second")

        try await store.storeInitial(first)
        try await store.storeInitial(second)

        let loaded = try await store.load(for: first.accountID)
        let upsertCount = client.upsertCount
        XCTAssertEqual(loaded, second)
        XCTAssertEqual(upsertCount, 4)
    }

    func testActiveAccountRestoresAndClearsWithCredential() async throws {
        let client = RecordingSecurityClient()
        let store = KeychainAuthTokenStore(securityClient: client)
        let tokens = try makeTokens()

        let initiallyActive = try await store.loadActive()
        XCTAssertNil(initiallyActive)
        try await store.storeInitial(tokens)
        let restored = try await store.loadActive()
        XCTAssertEqual(restored, tokens)

        let removed = try await store.remove(
            for: tokens.accountID,
            ifRefreshTokenMatches: nil
        )
        let activeAfterRemoval = try await store.loadActive()
        XCTAssertTrue(removed)
        XCTAssertNil(activeAfterRemoval)
    }

    func testAccountSwitchPurgesPreviousCredential() async throws {
        let client = RecordingSecurityClient()
        let store = KeychainAuthTokenStore(securityClient: client)
        let first = try makeTokens(account: "acct_first")
        let second = try makeTokens(account: "acct_second")

        try await store.storeInitial(first)
        try await store.storeInitial(second)

        let restored = try await store.loadActive()
        let firstStored = try await store.load(for: first.accountID)
        XCTAssertEqual(restored, second)
        XCTAssertNil(firstStored)
    }

    func testCompareAndSwapReplacesOnlyMatchingRefreshTokenAndDevice() async throws {
        let client = RecordingSecurityClient()
        let store = KeychainAuthTokenStore(securityClient: client)
        let first = try makeTokens(suffix: "first")
        let stale = try makeTokens(suffix: "stale")
        let rotated = try makeTokens(suffix: "rotated")
        try await store.storeInitial(first)

        let staleResult = try await store.replace(
            for: first.accountID,
            expectedRefreshToken: stale.refreshToken,
            with: rotated
        )
        XCTAssertFalse(staleResult)
        let afterStaleRotation = try await store.load(for: first.accountID)
        XCTAssertEqual(afterStaleRotation, first)

        let replaced = try await store.replace(
            for: first.accountID,
            expectedRefreshToken: first.refreshToken,
            with: rotated
        )
        XCTAssertTrue(replaced)
        let afterRotation = try await store.load(for: first.accountID)
        XCTAssertEqual(afterRotation, rotated)

        let anotherDevice = try makeTokens(suffix: "other", device: "device_other")
        do {
            _ = try await store.replace(
                for: first.accountID,
                expectedRefreshToken: rotated.refreshToken,
                with: anotherDevice
            )
            XCTFail("A token rotation must not change device scope")
        } catch {
            XCTAssertEqual(
                error as? KeychainAuthTokenStoreError,
                .deviceScopeMismatch
            )
        }
    }

    func testMissingItemLoadsNilAndCannotBeDeletedOrReplaced() async throws {
        let client = RecordingSecurityClient()
        let store = KeychainAuthTokenStore(securityClient: client)
        let tokens = try makeTokens()

        let loaded = try await store.load(for: tokens.accountID)
        let removed = try await store.remove(
            for: tokens.accountID,
            ifRefreshTokenMatches: nil
        )
        let replaced = try await store.replace(
            for: tokens.accountID,
            expectedRefreshToken: tokens.refreshToken,
            with: tokens
        )
        XCTAssertNil(loaded)
        XCTAssertFalse(removed)
        XCTAssertFalse(replaced)
    }

    func testConditionalDeletionDoesNotRemoveNewerCredential() async throws {
        let client = RecordingSecurityClient()
        let store = KeychainAuthTokenStore(securityClient: client)
        let current = try makeTokens(suffix: "current")
        let stale = try makeTokens(suffix: "stale")
        try await store.storeInitial(current)

        let staleRemoval = try await store.remove(
            for: current.accountID,
            ifRefreshTokenMatches: stale.refreshToken
        )
        let afterStaleRemoval = try await store.load(for: current.accountID)
        let matchingRemoval = try await store.remove(
            for: current.accountID,
            ifRefreshTokenMatches: current.refreshToken
        )
        let afterMatchingRemoval = try await store.load(for: current.accountID)
        XCTAssertFalse(staleRemoval)
        XCTAssertEqual(afterStaleRemoval, current)
        XCTAssertTrue(matchingRemoval)
        XCTAssertNil(afterMatchingRemoval)
    }

    func testMalformedAndCrossAccountPayloadsFailClosed() async throws {
        let client = RecordingSecurityClient()
        let store = KeychainAuthTokenStore(securityClient: client)
        let requestedAccount = try AccountID("acct_requested")
        client.seed(
            Data("not-json".utf8),
            for: SecurityKeychainItem(
                service: KeychainAuthTokenStore.defaultService,
                account: requestedAccount.rawValue
            )
        )

        do {
            _ = try await store.load(for: requestedAccount)
            XCTFail("Malformed data must not be treated as a signed-out state")
        } catch {
            XCTAssertEqual(error as? KeychainAuthTokenStoreError, .malformedData)
        }

        let otherAccountTokens = try makeTokens(account: "acct_other")
        let otherStore = KeychainAuthTokenStore(securityClient: client)
        try await otherStore.storeInitial(otherAccountTokens)
        let storedOtherData = client.data(
            for: SecurityKeychainItem(
                service: KeychainAuthTokenStore.defaultService,
                account: otherAccountTokens.accountID.rawValue
            )
        )
        let otherData = try XCTUnwrap(storedOtherData)
        client.seed(
            otherData,
            for: SecurityKeychainItem(
                service: KeychainAuthTokenStore.defaultService,
                account: requestedAccount.rawValue
            )
        )

        do {
            _ = try await store.load(for: requestedAccount)
            XCTFail("A credential must not cross account scope")
        } catch {
            XCTAssertEqual(
                error as? KeychainAuthTokenStoreError,
                .accountScopeMismatch
            )
        }
    }

    func testSecurityAccessFailurePropagatesWithoutMutation() async throws {
        let client = RecordingSecurityClient()
        let store = KeychainAuthTokenStore(securityClient: client)
        let tokens = try makeTokens()
        client.setFailure(.accessDenied)

        do {
            try await store.storeInitial(tokens)
            XCTFail("Expected Keychain access failure")
        } catch {
            XCTAssertEqual(error as? TestSecurityError, .accessDenied)
        }
        let upsertCount = client.upsertCount
        XCTAssertEqual(upsertCount, 0)
    }

    func testRejectsInvalidServiceName() {
        XCTAssertThrowsError(
            try KeychainAuthTokenStore(service: "bad service")
        ) { error in
            XCTAssertEqual(error as? KeychainAuthTokenStoreError, .invalidService)
        }
    }

    private func makeTokens(
        suffix: String = "one",
        account: String = "acct_one",
        device: String = "device_one"
    ) throws -> AuthTokenSet {
        try AuthTokenSet(
            accountID: AccountID(account),
            deviceID: DeviceID(device),
            accessToken: AccessToken("access-\(suffix)"),
            accessTokenExpiresAt: Date(timeIntervalSince1970: 2_000_003_600),
            refreshToken: RefreshToken(
                "refresh-\(suffix)-00000000000000000000000000000000"
            ),
            refreshTokenExpiresAt: Date(timeIntervalSince1970: 2_002_592_000)
        )
    }
}

private final class RecordingSecurityClient: SecurityKeychainClient,
    @unchecked Sendable
{
    private struct State {
        var items: [SecurityKeychainItem: Data] = [:]
        var failure: TestSecurityError?
        var lastItem: SecurityKeychainItem?
        var upsertCount = 0
    }

    private let lock = NSLock()
    private var state = State()

    var lastItem: SecurityKeychainItem? {
        lock.withLock { state.lastItem }
    }

    var upsertCount: Int {
        lock.withLock { state.upsertCount }
    }

    func read(_ item: SecurityKeychainItem) throws -> Data? {
        try lock.withLock {
            try throwIfNeeded()
            state.lastItem = item
            return state.items[item]
        }
    }

    func upsert(_ data: Data, for item: SecurityKeychainItem) throws {
        try lock.withLock {
            try throwIfNeeded()
            state.lastItem = item
            state.upsertCount += 1
            state.items[item] = data
        }
    }

    func delete(_ item: SecurityKeychainItem) throws -> Bool {
        try lock.withLock {
            try throwIfNeeded()
            state.lastItem = item
            return state.items.removeValue(forKey: item) != nil
        }
    }

    func seed(_ data: Data, for item: SecurityKeychainItem) {
        lock.withLock { state.items[item] = data }
    }

    func data(for item: SecurityKeychainItem) -> Data? {
        lock.withLock { state.items[item] }
    }

    func setFailure(_ failure: TestSecurityError?) {
        lock.withLock { state.failure = failure }
    }

    private func throwIfNeeded() throws {
        if let failure = state.failure {
            throw failure
        }
    }
}

private enum TestSecurityError: Error, Equatable, Sendable {
    case accessDenied
}
