import Foundation
import JunoCore
import XCTest
@testable import JunoAuth

final class AuthTokenCoordinatorTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 2_000_000_000)

    func testConcurrentRefreshIsSingleFlightAndPersistsOneRotation() async throws {
        let fixture = try await makeFixture()
        let refreshed = try makeRefreshedTokens(suffix: "next")
        let tasks = (0..<24).map { _ in
            Task { try await fixture.coordinator.refresh(for: fixture.accountID) }
        }

        let joined = await waitForWaiters(
            count: tasks.count,
            coordinator: fixture.coordinator,
            accountID: fixture.accountID
        )
        XCTAssertTrue(joined)
        let refreshStarted = await waitForRefreshCalls(
            count: 1,
            client: fixture.client
        )
        XCTAssertTrue(refreshStarted)
        await fixture.client.succeed(with: refreshed)

        for task in tasks {
            let result = try await task.value
            XCTAssertEqual(result.refreshToken, refreshed.refreshToken)
        }
        let calls = await fixture.client.callCount
        let replacements = await fixture.store.replaceCount
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(replacements, 1)
    }

    func testConcurrentTransientFailureIsSharedAndKeepsCredential() async throws {
        let fixture = try await makeFixture()
        let tasks = (0..<16).map { _ in
            Task { try await fixture.coordinator.refresh(for: fixture.accountID) }
        }
        let joined = await waitForWaiters(
            count: tasks.count,
            coordinator: fixture.coordinator,
            accountID: fixture.accountID
        )
        XCTAssertTrue(joined)
        await fixture.client.fail(with: .transient)

        for task in tasks {
            do {
                _ = try await task.value
                XCTFail("Expected shared refresh failure")
            } catch {
                XCTAssertEqual(error as? AuthRefreshFailure, .transient)
            }
        }
        let calls = await fixture.client.callCount
        let stored = try await fixture.store.load(for: fixture.accountID)
        XCTAssertEqual(calls, 1)
        XCTAssertNotNil(stored)
    }

    func testTerminalFailureAtomicallyClearsOnlyMatchingCredential() async throws {
        let fixture = try await makeFixture()
        let task = Task { try await fixture.coordinator.refresh(for: fixture.accountID) }
        let joined = await waitForWaiters(
            count: 1,
            coordinator: fixture.coordinator,
            accountID: fixture.accountID
        )
        XCTAssertTrue(joined)
        await fixture.client.fail(with: .refreshTokenReused)

        do {
            _ = try await task.value
            XCTFail("Expected refresh reuse failure")
        } catch {
            XCTAssertEqual(error as? AuthRefreshFailure, .refreshTokenReused)
        }
        let stored = try await fixture.store.load(for: fixture.accountID)
        let removals = await fixture.store.removeCount
        XCTAssertNil(stored)
        XCTAssertEqual(removals, 1)
    }

    func testRevocationDuringRefreshFailsClosedAndCannotRestoreTokens() async throws {
        let fixture = try await makeFixture()
        let refreshed = try makeRefreshedTokens(suffix: "late")
        let task = Task { try await fixture.coordinator.refresh(for: fixture.accountID) }
        let joined = await waitForWaiters(
            count: 1,
            coordinator: fixture.coordinator,
            accountID: fixture.accountID
        )
        XCTAssertTrue(joined)

        try await fixture.coordinator.revokeLocally(for: fixture.accountID)
        await fixture.client.succeed(with: refreshed)

        do {
            _ = try await task.value
            XCTFail("Expected local revocation")
        } catch {
            XCTAssertEqual(error as? AuthTokenCoordinatorError, .locallyRevoked)
        }
        let stored = try await fixture.store.load(for: fixture.accountID)
        XCTAssertNil(stored)
        do {
            _ = try await fixture.coordinator.accessToken(for: fixture.accountID)
            XCTFail("A revoked account must stay closed")
        } catch {
            XCTAssertEqual(error as? AuthTokenCoordinatorError, .locallyRevoked)
        }
    }

    func testAccessTokenRefreshesUsingInjectedClock() async throws {
        let fixture = try await makeFixture(accessExpiry: now.addingTimeInterval(30))
        let refreshed = try makeRefreshedTokens(suffix: "clock")
        let task = Task {
            try await fixture.coordinator.accessToken(
                for: fixture.accountID,
                minimumValidity: 60
            )
        }
        let joined = await waitForWaiters(
            count: 1,
            coordinator: fixture.coordinator,
            accountID: fixture.accountID
        )
        XCTAssertTrue(joined)
        await fixture.client.succeed(with: refreshed)

        let token = try await task.value
        XCTAssertEqual(token, refreshed.accessToken)
    }

    func testConcurrentAndLateUnauthorizedCallersShareOneRotation() async throws {
        let fixture = try await makeFixture(
            accessExpiry: now.addingTimeInterval(3_600)
        )
        let rejected = try AccessToken("access-initial")
        let refreshed = try makeRefreshedTokens(suffix: "unauthorized")
        let requests = (0..<24).map { _ in
            Task {
                try await fixture.coordinator.accessTokenAfterUnauthorized(
                    for: fixture.accountID,
                    rejectedAccessToken: rejected
                )
            }
        }
        let joined = await waitForWaiters(
            count: 1,
            coordinator: fixture.coordinator,
            accountID: fixture.accountID
        )
        XCTAssertTrue(joined)
        let refreshStarted = await waitForRefreshCalls(
            count: 1,
            client: fixture.client
        )
        XCTAssertTrue(refreshStarted)
        await fixture.client.succeed(with: refreshed)
        for request in requests {
            let result = try await request.value
            XCTAssertEqual(result, refreshed.accessToken)
        }

        let late = try await fixture.coordinator.accessTokenAfterUnauthorized(
            for: fixture.accountID,
            rejectedAccessToken: rejected
        )
        let calls = await fixture.client.callCount
        XCTAssertEqual(late, refreshed.accessToken)
        XCTAssertEqual(calls, 1)
    }

    func testTokenDescriptionsAreRedacted() throws {
        let access = try AccessToken("access-secret")
        let refresh = try RefreshToken("refresh-secret-000000000000000000")

        XCTAssertEqual(String(describing: access), "<access-token>")
        XCTAssertEqual(String(reflecting: refresh), "<refresh-token>")
    }

    private func makeFixture(
        accessExpiry: Date? = nil
    ) async throws -> Fixture {
        let accountID = try AccountID("acct_test")
        let deviceID = try DeviceID("device_test")
        let initial = try AuthTokenSet(
            accountID: accountID,
            deviceID: deviceID,
            accessToken: try AccessToken("access-initial"),
            accessTokenExpiresAt: accessExpiry ?? now.addingTimeInterval(-1),
            refreshToken: try RefreshToken("refresh-initial-0000000000000000"),
            refreshTokenExpiresAt: now.addingTimeInterval(86_400)
        )
        let store = MemoryTokenStore()
        try await store.storeInitial(initial)
        let client = ControlledRefreshClient()
        let coordinator = AuthTokenCoordinator(
            store: store,
            refreshClient: client,
            clock: FixedClock(now: now)
        )
        return Fixture(
            accountID: accountID,
            store: store,
            client: client,
            coordinator: coordinator
        )
    }

    private func makeRefreshedTokens(suffix: String) throws -> RefreshedTokens {
        try RefreshedTokens(
            accessToken: AccessToken("access-\(suffix)"),
            accessTokenExpiresAt: now.addingTimeInterval(3_600),
            refreshToken: RefreshToken("refresh-\(suffix)-000000000000000000000000"),
            refreshTokenExpiresAt: now.addingTimeInterval(86_400)
        )
    }

    private func waitForWaiters(
        count: Int,
        coordinator: AuthTokenCoordinator,
        accountID: AccountID
    ) async -> Bool {
        for _ in 0..<20_000 {
            if await coordinator.refreshWaiterCount(for: accountID) == count {
                return true
            }
            await Task.yield()
        }
        return false
    }

    private func waitForRefreshCalls(
        count: Int,
        client: ControlledRefreshClient
    ) async -> Bool {
        for _ in 0..<20_000 {
            if await client.callCount == count {
                return true
            }
            await Task.yield()
        }
        return false
    }
}

private struct Fixture: Sendable {
    let accountID: AccountID
    let store: MemoryTokenStore
    let client: ControlledRefreshClient
    let coordinator: AuthTokenCoordinator
}

private struct FixedClock: JunoClock {
    let nowValue: Date

    init(now: Date) {
        nowValue = now
    }

    func now() async -> Date { nowValue }

    func sleep(for duration: Duration) async throws {}
}

private actor MemoryTokenStore: AuthTokenStore {
    private var tokens: [AccountID: AuthTokenSet] = [:]
    private(set) var replaceCount = 0
    private(set) var removeCount = 0

    func load(for accountID: AccountID) async throws -> AuthTokenSet? {
        tokens[accountID]
    }

    func storeInitial(_ tokenSet: AuthTokenSet) async throws {
        tokens[tokenSet.accountID] = tokenSet
    }

    func replace(
        for accountID: AccountID,
        expectedRefreshToken: RefreshToken,
        with tokenSet: AuthTokenSet
    ) async throws -> Bool {
        guard tokens[accountID]?.refreshToken == expectedRefreshToken,
            tokenSet.accountID == accountID
        else {
            return false
        }
        replaceCount += 1
        tokens[accountID] = tokenSet
        return true
    }

    func remove(
        for accountID: AccountID,
        ifRefreshTokenMatches refreshToken: RefreshToken?
    ) async throws -> Bool {
        guard let current = tokens[accountID] else { return false }
        if let refreshToken, current.refreshToken != refreshToken {
            return false
        }
        removeCount += 1
        tokens.removeValue(forKey: accountID)
        return true
    }
}

private actor ControlledRefreshClient: AuthRefreshClient {
    private var continuation: CheckedContinuation<RefreshedTokens, any Error>?
    private(set) var callCount = 0

    func refresh(credential: RefreshCredential) async throws -> RefreshedTokens {
        callCount += 1
        return try await withCheckedThrowingContinuation { continuation in
            guard self.continuation == nil else {
                continuation.resume(throwing: TestHarnessError.overlappingRefreshCalls)
                return
            }
            self.continuation = continuation
        }
    }

    func succeed(with tokens: RefreshedTokens) {
        let continuation = continuation
        self.continuation = nil
        continuation?.resume(returning: tokens)
    }

    func fail(with error: AuthRefreshFailure) {
        let continuation = continuation
        self.continuation = nil
        continuation?.resume(throwing: error)
    }
}

private enum TestHarnessError: Error {
    case overlappingRefreshCalls
}
