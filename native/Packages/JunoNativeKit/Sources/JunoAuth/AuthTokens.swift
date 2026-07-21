import Foundation
import JunoCore

public enum AuthTokenValidationError: Error, Equatable, Sendable {
    case empty
    case tooShort(minimumUTF8Bytes: Int)
    case tooLarge(maximumUTF8Bytes: Int)
    case containsWhitespaceOrControl
    case invalidExpiryOrder
}

public struct AccessToken: Hashable, Sendable, CustomStringConvertible,
    CustomDebugStringConvertible
{
    private static let maximumUTF8Bytes = 16 * 1_024
    private let secret: String

    public init(_ secret: String) throws {
        try Self.validate(secret)
        self.secret = secret
    }

    /// Explicit access prevents tokens from leaking through ordinary descriptions.
    public func reveal() -> String { secret }
    public var description: String { "<access-token>" }
    public var debugDescription: String { description }

    private static func validate(_ value: String) throws {
        guard !value.isEmpty else { throw AuthTokenValidationError.empty }
        guard value.utf8.count <= maximumUTF8Bytes else {
            throw AuthTokenValidationError.tooLarge(maximumUTF8Bytes: maximumUTF8Bytes)
        }
        guard !value.unicodeScalars.contains(where: {
            CharacterSet.whitespacesAndNewlines.contains($0)
                || CharacterSet.controlCharacters.contains($0)
        }) else {
            throw AuthTokenValidationError.containsWhitespaceOrControl
        }
    }
}

public struct RefreshToken: Hashable, Sendable, CustomStringConvertible,
    CustomDebugStringConvertible
{
    private static let maximumUTF8Bytes = 16 * 1_024
    private let secret: String

    public init(_ secret: String) throws {
        guard !secret.isEmpty else { throw AuthTokenValidationError.empty }
        guard secret.utf8.count >= 32 else {
            throw AuthTokenValidationError.tooShort(minimumUTF8Bytes: 32)
        }
        guard secret.utf8.count <= Self.maximumUTF8Bytes else {
            throw AuthTokenValidationError.tooLarge(
                maximumUTF8Bytes: Self.maximumUTF8Bytes
            )
        }
        guard !secret.unicodeScalars.contains(where: {
            CharacterSet.whitespacesAndNewlines.contains($0)
                || CharacterSet.controlCharacters.contains($0)
        }) else {
            throw AuthTokenValidationError.containsWhitespaceOrControl
        }
        self.secret = secret
    }

    public func reveal() -> String { secret }
    public var description: String { "<refresh-token>" }
    public var debugDescription: String { description }
}

public struct AuthTokenSet: Equatable, Sendable {
    public let accountID: AccountID
    public let deviceID: DeviceID
    public let accessToken: AccessToken
    public let accessTokenExpiresAt: Date
    public let refreshToken: RefreshToken
    public let refreshTokenExpiresAt: Date

    public init(
        accountID: AccountID,
        deviceID: DeviceID,
        accessToken: AccessToken,
        accessTokenExpiresAt: Date,
        refreshToken: RefreshToken,
        refreshTokenExpiresAt: Date
    ) throws {
        guard accessTokenExpiresAt <= refreshTokenExpiresAt else {
            throw AuthTokenValidationError.invalidExpiryOrder
        }
        self.accountID = accountID
        self.deviceID = deviceID
        self.accessToken = accessToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        self.refreshToken = refreshToken
        self.refreshTokenExpiresAt = refreshTokenExpiresAt
    }

    public func hasUsableAccessToken(at date: Date, minimumValidity: TimeInterval) -> Bool {
        accessTokenExpiresAt.timeIntervalSince(date) > max(0, minimumValidity)
    }
}

public struct RefreshCredential: Equatable, Sendable {
    public let accountID: AccountID
    public let deviceID: DeviceID
    public let refreshToken: RefreshToken

    public init(accountID: AccountID, deviceID: DeviceID, refreshToken: RefreshToken) {
        self.accountID = accountID
        self.deviceID = deviceID
        self.refreshToken = refreshToken
    }
}

public struct RefreshedTokens: Equatable, Sendable {
    public let accessToken: AccessToken
    public let accessTokenExpiresAt: Date
    public let refreshToken: RefreshToken
    public let refreshTokenExpiresAt: Date

    public init(
        accessToken: AccessToken,
        accessTokenExpiresAt: Date,
        refreshToken: RefreshToken,
        refreshTokenExpiresAt: Date
    ) throws {
        guard accessTokenExpiresAt <= refreshTokenExpiresAt else {
            throw AuthTokenValidationError.invalidExpiryOrder
        }
        self.accessToken = accessToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        self.refreshToken = refreshToken
        self.refreshTokenExpiresAt = refreshTokenExpiresAt
    }
}
