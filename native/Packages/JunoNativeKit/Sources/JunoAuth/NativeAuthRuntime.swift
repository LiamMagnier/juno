import Foundation
import JunoAPI

public actor NativeAuthRuntime {
    private let tokenStore: KeychainAuthTokenStore
    private let installationStore: KeychainInstallationIDStore
    private let planner: NativeAuthorizationPlanner
    private let apiClient: NativeAuthAPIClient
    private let coordinator: AuthTokenCoordinator
    private let device: NativeDeviceMetadata

    public init(
        tokenStore: KeychainAuthTokenStore,
        installationStore: KeychainInstallationIDStore,
        planner: NativeAuthorizationPlanner,
        apiClient: NativeAuthAPIClient,
        device: NativeDeviceMetadata
    ) {
        self.tokenStore = tokenStore
        self.installationStore = installationStore
        self.planner = planner
        self.apiClient = apiClient
        coordinator = AuthTokenCoordinator(store: tokenStore, refreshClient: apiClient)
        self.device = device
    }

    public static func live(
        origin: APIOrigin,
        device: NativeDeviceMetadata
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
            device: device
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
            let accessToken = try await coordinator.accessToken(for: stored.accountID)
            let session = try await apiClient.session(accessToken: accessToken)
            guard session.profile.id == stored.accountID,
                session.deviceID == stored.deviceID
            else {
                try await coordinator.revokeLocally(for: stored.accountID)
                throw NativeAuthAPIError.deviceSessionMismatch
            }
            return session
        } catch let error as NativeAuthAPIError {
            if error.invalidatesLocalCredentials {
                try? await coordinator.revokeLocally(for: stored.accountID)
            }
            throw error
        }
    }

    public func signOut() async throws {
        guard let stored = try await tokenStore.loadActive() else {
            return
        }
        var remoteError: (any Error)?
        do {
            let accessToken = try await coordinator.accessToken(for: stored.accountID)
            try await apiClient.logout(accessToken: accessToken)
        } catch {
            remoteError = error
        }
        try await coordinator.revokeLocally(for: stored.accountID)
        if let remoteError {
            throw remoteError
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
