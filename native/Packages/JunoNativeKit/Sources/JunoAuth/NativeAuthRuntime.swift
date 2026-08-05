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

/// The outcome of restoring a stored session at launch.
public enum NativeRestoredSession: Equatable, Sendable {
    /// The server confirmed the credentials and returned this session.
    case verified(NativeAuthenticatedSession)
    /// The credentials are still in the Keychain but the server could not be
    /// asked about them — it was unreachable, erroring, or speaking a contract
    /// this build does not understand. The session is the last one the server
    /// *did* confirm, so the app can open on its local data instead of throwing
    /// the user back to a sign-in screen it cannot even complete while the
    /// backend is down.
    case unverified(NativeAuthenticatedSession, cause: String)

    public var session: NativeAuthenticatedSession {
        switch self {
        case .verified(let session), .unverified(let session, _): session
        }
    }
}

public actor NativeAuthRuntime {
    private let tokenStore: KeychainAuthTokenStore
    private let installationStore: KeychainInstallationIDStore
    private let sessionCache: KeychainSessionCacheStore
    private let planner: NativeAuthorizationPlanner
    private let apiClient: NativeAuthAPIClient
    private let coordinator: AuthTokenCoordinator
    private let device: NativeDeviceMetadata
    private let accountDataPurger: (any NativeAccountDataPurging)?

    public init(
        tokenStore: KeychainAuthTokenStore,
        installationStore: KeychainInstallationIDStore,
        sessionCache: KeychainSessionCacheStore,
        planner: NativeAuthorizationPlanner,
        apiClient: NativeAuthAPIClient,
        device: NativeDeviceMetadata,
        accountDataPurger: (any NativeAccountDataPurging)? = nil
    ) {
        self.tokenStore = tokenStore
        self.installationStore = installationStore
        self.sessionCache = sessionCache
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
            transport: try URLSessionHTTPTransport(),
            streamingTransport: try URLSessionHTTPStreamingTransport()
        )
        return try NativeAuthRuntime(
            tokenStore: tokenStore,
            installationStore: installationStore,
            sessionCache: KeychainSessionCacheStore(securityClient: securityClient),
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
        return try await establishSession(
            from: try await apiClient.exchangeAuthorizationCode(
                code: code,
                verifier: attempt.verifier,
                redirectURI: attempt.redirectURI,
                installationID: attempt.installationID,
                device: device
            )
        )
    }

    /// Signs in from an email/password pair, with no system-browser hand-off.
    ///
    /// The credentials are used for exactly this one call and are never stored;
    /// what persists is the same device token set the browser flow produces.
    public func signIn(
        email: String,
        password: String
    ) async throws -> NativeAuthenticatedSession {
        let installationID = try await installationStore.loadOrCreate()
        return try await establishSession(
            from: try await apiClient.exchangePassword(
                email: email,
                password: password,
                installationID: installationID,
                device: device
            )
        )
    }

    /// Validates freshly issued credentials, then stores them. Shared by both
    /// sign-in routes so they cannot drift on device binding, account switching
    /// or the revoke-on-failure rule.
    private func establishSession(
        from issued: NativeIssuedTokens
    ) async throws -> NativeAuthenticatedSession {
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
                await sessionCache.remove(for: previous.accountID)
            }
            try await coordinator.install(tokens)
            await sessionCache.store(session)
            return session
        } catch {
            // Issuing the credentials already created a server device session.
            // Revoke it if any later validation or secure-persistence step fails.
            try? await apiClient.logout(accessToken: issued.accessToken)
            throw error
        }
    }

    /// Restores the stored session, distinguishing "this account is no longer
    /// valid" from "Juno could not be reached".
    ///
    /// Only the first case may sign the user out. Previously *every* thrown
    /// error mapped to a signed-out app, so an outage — or a contract-version
    /// bump on the server — logged the user out of a client whose Keychain
    /// credentials were still perfectly good, and which they then could not
    /// sign back in to because sign-in needs the same server.
    public func restore() async throws -> NativeRestoredSession? {
        let stored: AuthTokenSet
        do {
            guard let active = try await tokenStore.loadActive() else {
                return nil
            }
            stored = active
        } catch let error as SecurityKeychainClientError {
            // A Keychain read can be transiently unavailable while macOS is
            // replacing or re-signing the app bundle. Keep the last confirmed
            // account open locally and let the normal retry path reconnect it;
            // showing sign-in here would make an update look like a logout.
            if let cached = await sessionCache.loadLast() {
                return .unverified(cached, cause: error.localizedDescription)
            }
            throw error
        } catch {
            // Malformed or cross-account credential data is not a transient
            // update condition. Preserve the fail-closed behavior for corrupt
            // credentials and only use the cached session for Security.framework
            // access failures.
            throw error
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
            await sessionCache.store(session)
            return .verified(session)
        } catch {
            if let apiError = error as? NativeAuthAPIError,
                apiError.invalidatesLocalCredentials
            {
                try await invalidateLocalAccount(stored.accountID)
                throw error
            }
            // A terminal refresh failure purges the credentials inside
            // `coordinatedAccessToken` before rethrowing. If they are gone the
            // account really was invalidated, whatever the error looks like.
            guard try await tokenStore.loadActive() != nil else { throw error }
            guard let cached = await sessionCache.load(for: stored.accountID),
                cached.deviceID == stored.deviceID
            else {
                // Credentials survive but this install has never completed a
                // session fetch, so there is no profile to open the app with.
                throw error
            }
            return .unverified(cached, cause: error.localizedDescription)
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

    /// Opens one same-origin bearer byte stream, applying the same single
    /// rotating-refresh rule as ordinary native requests before returning it.
    public func stream(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPByteStreamResponse {
        let initialAccessToken = try await coordinatedAccessToken(for: accountID)
        let initialResponse = try await apiClient.streamBearer(
            request,
            accessToken: initialAccessToken
        )
        guard initialResponse.statusCode == 401 else { return initialResponse }
        let refreshedAccessToken = try await coordinatedAccessTokenAfterUnauthorized(
            for: accountID,
            rejectedAccessToken: initialAccessToken
        )
        let retryResponse = try await apiClient.streamBearer(
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
        await sessionCache.remove(for: stored.accountID)
        try await coordinator.revokeLocally(for: stored.accountID)
        if let remoteError {
            throw remoteError
        }
    }

    private func invalidateLocalAccount(_ accountID: AccountID) async throws {
        try await purgeLocalData(for: accountID)
        await sessionCache.remove(for: accountID)
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
