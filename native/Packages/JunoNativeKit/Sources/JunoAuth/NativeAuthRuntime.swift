import Foundation
import JunoAPI
import JunoCore

public protocol NativeAccountDataPurging: Sendable {
    func wipe(accountID: AccountID) async throws
}

public enum NativeAuthRuntimeError: Error, Equatable, LocalizedError, Sendable {
    case localDataPurgeFailed

    public var errorDescription: String? {
        "Juno could not securely remove the local account data."
    }
}

public actor NativeAuthRuntime {
    private let tokenStore: KeychainAuthTokenStore
    private let installationStore: KeychainInstallationIDStore
    private let planner: NativeAuthorizationPlanner
    private let apiClient: NativeAuthAPIClient
    private let coordinator: AuthTokenCoordinator
    private let device: NativeDeviceMetadata
    private let accountDataPurger: (any NativeAccountDataPurging)?

    public init(
        tokenStore: KeychainAuthTokenStore,
        installationStore: KeychainInstallationIDStore,
        planner: NativeAuthorizationPlanner,
        apiClient: NativeAuthAPIClient,
        device: NativeDeviceMetadata,
        accountDataPurger: (any NativeAccountDataPurging)? = nil
    ) {
        self.tokenStore = tokenStore
        self.installationStore = installationStore
        self.planner = planner
        self.apiClient = apiClient
        coordinator = AuthTokenCoordinator(store: tokenStore, refreshClient: apiClient)
        self.device = device
        self.accountDataPurger = accountDataPurger
    }

    public static func live(
        origin: APIOrigin,
        device: NativeDeviceMetadata,
        accountDataPurger: (any NativeAccountDataPurging)? = nil
    ) throws -> NativeAuthRuntime {
        let securityClient = SystemSecurityKeychainClient()
        let tokenStore = KeychainAuthTokenStore(securityClient: securityClient)
        let installationStore = KeychainInstallationIDStore(
            securityClient: securityClient
        )
        let apiClient = NativeAuthAPIClient(
            origin: origin,
            transport: try URLSessionHTTPTransport()
        )
        return try NativeAuthRuntime(
            tokenStore: tokenStore,
            installationStore: installationStore,
            planner: NativeAuthorizationPlanner(origin: origin),
            apiClient: apiClient,
            device: device,
            accountDataPurger: accountDataPurger
        )
    }

    public func beginAuthorization() async throws -> NativeAuthorizationAttempt {
        let installationID = try await installationStore.loadOrCreate()
        return try planner.makeAttempt(installationID: installationID)
    }

    public func completeAuthorization(
        _ attempt: NativeAuthorizationAttempt,
        callbackURL: URL
    ) async throws -> NativeAuthenticatedSession {
        let code = try planner.authorizationCode(from: callbackURL, for: attempt)
        let issued = try await apiClient.exchangeAuthorizationCode(
            code: code,
            verifier: attempt.verifier,
            redirectURI: attempt.redirectURI,
            installationID: attempt.installationID,
            device: device
        )
        do {
            let session = try await apiClient.session(accessToken: issued.accessToken)
            guard session.deviceID == issued.deviceID else {
                throw NativeAuthAPIError.deviceSessionMismatch
            }
            let tokens = try AuthTokenSet(
                accountID: session.profile.id,
                deviceID: issued.deviceID,
                accessToken: issued.accessToken,
                accessTokenExpiresAt: issued.accessTokenExpiresAt,
                refreshToken: issued.refreshToken,
                refreshTokenExpiresAt: issued.refreshTokenExpiresAt
            )
            if let previous = try await tokenStore.loadActive(),
                previous.accountID != tokens.accountID
            {
                try await purgeLocalData(for: previous.accountID)
            }
            try await coordinator.install(tokens)
            return session
        } catch {
            // The code exchange already created a server device session. Revoke it
            // if any subsequent validation or secure-persistence step fails.
            try? await apiClient.logout(accessToken: issued.accessToken)
            throw error
        }
    }

    public func restore() async throws -> NativeAuthenticatedSession? {
        guard let stored = try await tokenStore.loadActive() else {
            return nil
        }
        do {
            let accessToken = try await coordinatedAccessToken(
                for: stored.accountID
            )
            let session = try await apiClient.session(accessToken: accessToken)
            guard session.profile.id == stored.accountID,
                session.deviceID == stored.deviceID
            else {
                throw NativeAuthAPIError.deviceSessionMismatch
            }
            return session
        } catch let error as NativeAuthAPIError {
            if error.invalidatesLocalCredentials {
                try await invalidateLocalAccount(stored.accountID)
            }
            throw error
        }
    }

    /// Sends one same-origin bearer request and performs at most one rotating
    /// refresh when the server rejects the access token.
    public func send(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPResponse {
        let initialAccessToken = try await coordinatedAccessToken(for: accountID)
        let initialResponse = try await apiClient.sendBearer(
            request,
            accessToken: initialAccessToken
        )
        guard initialResponse.statusCode == 401 else {
            return initialResponse
        }

        let refreshedAccessToken = try await coordinatedAccessTokenAfterUnauthorized(
            for: accountID,
            rejectedAccessToken: initialAccessToken
        )
        let retryResponse = try await apiClient.sendBearer(
            request,
            accessToken: refreshedAccessToken
        )
        if retryResponse.statusCode == 401 {
            try await invalidateLocalAccount(accountID)
        }
        return retryResponse
    }

    public func signOut() async throws {
        guard let stored = try await tokenStore.loadActive() else {
            return
        }
        var remoteError: (any Error)?
        do {
            // Logout does not need a refresh. Using the stored access token
            // keeps the local credential available until secure data wiping
            // succeeds, even when the server considers that token expired.
            try await apiClient.logout(accessToken: stored.accessToken)
        } catch {
            remoteError = error
        }
        try await purgeLocalData(for: stored.accountID)
        try await coordinator.revokeLocally(for: stored.accountID)
        if let remoteError {
            throw remoteError
        }
    }

    private func invalidateLocalAccount(_ accountID: AccountID) async throws {
        try await purgeLocalData(for: accountID)
        try await coordinator.revokeLocally(for: accountID)
    }

    private func coordinatedAccessToken(
        for accountID: AccountID
    ) async throws -> AccessToken {
        do {
            return try await coordinator.accessToken(for: accountID)
        } catch {
            try await purgeAfterTerminalRefresh(error, for: accountID)
            throw error
        }
    }

    private func coordinatedAccessTokenAfterUnauthorized(
        for accountID: AccountID,
        rejectedAccessToken: AccessToken
    ) async throws -> AccessToken {
        do {
            return try await coordinator.accessTokenAfterUnauthorized(
                for: accountID,
                rejectedAccessToken: rejectedAccessToken
            )
        } catch {
            try await purgeAfterTerminalRefresh(error, for: accountID)
            throw error
        }
    }

    private func purgeAfterTerminalRefresh(
        _ error: any Error,
        for accountID: AccountID
    ) async throws {
        if let failure = error as? AuthRefreshFailure,
            failure.invalidatesStoredCredentials
        {
            try await invalidateLocalAccount(accountID)
        } else if let coordinatorError = error as? AuthTokenCoordinatorError,
            coordinatorError == .refreshCredentialExpired
        {
            try await invalidateLocalAccount(accountID)
        }
    }

    private func purgeLocalData(for accountID: AccountID) async throws {
        guard let accountDataPurger else { return }
        do {
            try await accountDataPurger.wipe(accountID: accountID)
        } catch {
            throw NativeAuthRuntimeError.localDataPurgeFailed
        }
    }
}

private extension NativeAuthAPIError {
    var invalidatesLocalCredentials: Bool {
        guard case .server(let statusCode, let code) = self,
            statusCode == 401
        else {
            return self == .deviceSessionMismatch
        }
        return [
            "unauthenticated",
            "token_expired",
            "device_revoked",
            "token_reuse_detected",
            "invalid_grant",
        ].contains(code)
    }
}
