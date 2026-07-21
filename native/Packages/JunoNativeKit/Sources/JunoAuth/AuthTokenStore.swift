import JunoCore

/// Secure persistence is injected. Its compare-and-swap operations must be atomic.
public protocol AuthTokenStore: Sendable {
    func load(for accountID: AccountID) async throws -> AuthTokenSet?

    func storeInitial(_ tokenSet: AuthTokenSet) async throws

    /// Replaces a rotating token only if no refresh, sign-out, or account switch won first.
    func replace(
        for accountID: AccountID,
        expectedRefreshToken: RefreshToken,
        with tokenSet: AuthTokenSet
    ) async throws -> Bool

    /// A nil match removes any credential. A token match prevents stale work deleting a new session.
    func remove(
        for accountID: AccountID,
        ifRefreshTokenMatches refreshToken: RefreshToken?
    ) async throws -> Bool
}

public protocol AuthRefreshClient: Sendable {
    func refresh(credential: RefreshCredential) async throws -> RefreshedTokens
}

public enum AuthRefreshFailure: Error, Equatable, Sendable {
    case invalidGrant
    case expired
    case refreshTokenReused
    case accountBanned
    case deviceRevoked
    case sessionInvalidated
    case rateLimited(retryAfterMilliseconds: Int?)
    case transient
    case malformedResponse

    public var invalidatesStoredCredentials: Bool {
        switch self {
        case .invalidGrant, .expired, .refreshTokenReused, .accountBanned,
            .deviceRevoked, .sessionInvalidated:
            true
        case .rateLimited, .transient, .malformedResponse:
            false
        }
    }
}
