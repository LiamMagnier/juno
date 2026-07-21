import Foundation
import JunoCore

public enum AuthTokenCoordinatorError: Error, Equatable, Sendable {
    case noCredentials
    case locallyRevoked
    case credentialsChanged
    case refreshCancelled
    case refreshCredentialExpired
}

/// Coalesces access-token refreshes per account and fails closed across revocation races.
public actor AuthTokenCoordinator {
    private struct Flight: Sendable {
        let id: UUID
        let generation: UInt64
        let task: Task<AuthTokenSet, any Error>
        var waiterCount: Int
    }

    private struct UnauthorizedFlight: Sendable {
        let id: UUID
        let rejectedAccessToken: AccessToken
        let task: Task<AccessToken, any Error>
    }

    private let clock: any JunoClock
    private let refreshClient: any AuthRefreshClient
    private let store: any AuthTokenStore

    private var flights: [AccountID: Flight] = [:]
    private var generations: [AccountID: UInt64] = [:]
    private var locallyRevokedAccounts: Set<AccountID> = []
    private var unauthorizedFlights: [AccountID: UnauthorizedFlight] = [:]

    public init(
        store: any AuthTokenStore,
        refreshClient: any AuthRefreshClient,
        clock: any JunoClock = SystemJunoClock()
    ) {
        self.store = store
        self.refreshClient = refreshClient
        self.clock = clock
    }

    public func install(_ tokenSet: AuthTokenSet) async throws {
        incrementGeneration(for: tokenSet.accountID)
        flights.removeValue(forKey: tokenSet.accountID)?.task.cancel()
        unauthorizedFlights.removeValue(forKey: tokenSet.accountID)?.task.cancel()
        try await store.storeInitial(tokenSet)
        locallyRevokedAccounts.remove(tokenSet.accountID)
    }

    public func accessToken(
        for accountID: AccountID,
        minimumValidity: TimeInterval = 60
    ) async throws -> AccessToken {
        guard !locallyRevokedAccounts.contains(accountID) else {
            throw AuthTokenCoordinatorError.locallyRevoked
        }
        guard let tokens = try await store.load(for: accountID) else {
            throw AuthTokenCoordinatorError.noCredentials
        }
        guard !locallyRevokedAccounts.contains(accountID) else {
            throw AuthTokenCoordinatorError.locallyRevoked
        }
        let now = await clock.now()
        if tokens.hasUsableAccessToken(at: now, minimumValidity: minimumValidity) {
            return tokens.accessToken
        }
        return try await refresh(for: accountID).accessToken
    }

    /// Rotates once for a rejected access token, including callers that observe
    /// the same 401 after the first rotation has already completed.
    public func accessTokenAfterUnauthorized(
        for accountID: AccountID,
        rejectedAccessToken: AccessToken
    ) async throws -> AccessToken {
        guard !locallyRevokedAccounts.contains(accountID) else {
            throw AuthTokenCoordinatorError.locallyRevoked
        }
        guard let current = try await store.load(for: accountID) else {
            throw AuthTokenCoordinatorError.noCredentials
        }
        guard !locallyRevokedAccounts.contains(accountID) else {
            throw AuthTokenCoordinatorError.locallyRevoked
        }
        if current.accessToken != rejectedAccessToken {
            return current.accessToken
        }
        let flight: UnauthorizedFlight
        if let currentFlight = unauthorizedFlights[accountID],
            currentFlight.rejectedAccessToken == rejectedAccessToken
        {
            flight = currentFlight
        } else {
            let flightID = UUID()
            let task = Task<AccessToken, any Error> {
                try await self.refresh(for: accountID).accessToken
            }
            flight = UnauthorizedFlight(
                id: flightID,
                rejectedAccessToken: rejectedAccessToken,
                task: task
            )
            unauthorizedFlights[accountID] = flight
        }

        do {
            return try await flight.task.value
        } catch {
            if unauthorizedFlights[accountID]?.id == flight.id {
                unauthorizedFlights.removeValue(forKey: accountID)
            }
            throw error
        }
    }

    public func refresh(for accountID: AccountID) async throws -> AuthTokenSet {
        guard !locallyRevokedAccounts.contains(accountID) else {
            throw AuthTokenCoordinatorError.locallyRevoked
        }

        let flight: Flight
        if var current = flights[accountID] {
            current.waiterCount += 1
            flights[accountID] = current
            flight = current
        } else {
            let generation = generations[accountID, default: 0]
            let flightID = UUID()
            let store = self.store
            let refreshClient = self.refreshClient
            let clock = self.clock

            let task = Task<AuthTokenSet, any Error> {
                try Task.checkCancellation()
                guard let current = try await store.load(for: accountID) else {
                    throw AuthTokenCoordinatorError.noCredentials
                }
                let now = await clock.now()
                guard current.refreshTokenExpiresAt > now else {
                    throw AuthTokenCoordinatorError.refreshCredentialExpired
                }

                let credential = RefreshCredential(
                    accountID: current.accountID,
                    deviceID: current.deviceID,
                    refreshToken: current.refreshToken
                )
                let refreshed: RefreshedTokens
                do {
                    refreshed = try await refreshClient.refresh(credential: credential)
                } catch let failure as AuthRefreshFailure {
                    throw failure
                }
                try Task.checkCancellation()

                let replacement = try AuthTokenSet(
                    accountID: current.accountID,
                    deviceID: current.deviceID,
                    accessToken: refreshed.accessToken,
                    accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
                    refreshToken: refreshed.refreshToken,
                    refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt
                )
                guard try await store.replace(
                    for: accountID,
                    expectedRefreshToken: current.refreshToken,
                    with: replacement
                ) else {
                    throw AuthTokenCoordinatorError.credentialsChanged
                }
                return replacement
            }
            flight = Flight(
                id: flightID,
                generation: generation,
                task: task,
                waiterCount: 1
            )
            flights[accountID] = flight
        }

        do {
            let tokens = try await flight.task.value
            guard generations[accountID, default: 0] == flight.generation,
                !locallyRevokedAccounts.contains(accountID)
            else {
                clearFlight(flight, for: accountID)
                throw AuthTokenCoordinatorError.locallyRevoked
            }
            clearFlight(flight, for: accountID)
            return tokens
        } catch {
            let wasRevoked = generations[accountID, default: 0] != flight.generation
                || locallyRevokedAccounts.contains(accountID)
            clearFlight(flight, for: accountID)
            if wasRevoked {
                throw AuthTokenCoordinatorError.locallyRevoked
            }
            if error is CancellationError {
                throw AuthTokenCoordinatorError.refreshCancelled
            }
            throw error
        }
    }

    public func revokeLocally(for accountID: AccountID) async throws {
        locallyRevokedAccounts.insert(accountID)
        unauthorizedFlights.removeValue(forKey: accountID)?.task.cancel()
        incrementGeneration(for: accountID)
        flights.removeValue(forKey: accountID)?.task.cancel()
        _ = try await store.remove(for: accountID, ifRefreshTokenMatches: nil)
    }

    private func incrementGeneration(for accountID: AccountID) {
        generations[accountID, default: 0] &+= 1
    }

    private func clearFlight(_ flight: Flight, for accountID: AccountID) {
        guard flights[accountID]?.id == flight.id else { return }
        flights.removeValue(forKey: accountID)
    }

    // Internal diagnostics keep concurrency tests deterministic without timing sleeps.
    func refreshWaiterCount(for accountID: AccountID) -> Int {
        flights[accountID]?.waiterCount ?? 0
    }
}
