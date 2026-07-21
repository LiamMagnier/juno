import Foundation
import JunoCore
@preconcurrency import Security

public struct SecurityKeychainItem: Equatable, Hashable, Sendable {
    public let service: String
    public let account: String
    public let accessGroup: String?

    public init(service: String, account: String, accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }
}

public enum SecurityKeychainClientError: Error, Equatable, Sendable {
    case unexpectedStatus(Int32)
    case invalidResult
}

/// A narrow, injectable boundary around Security.framework.
public protocol SecurityKeychainClient: Sendable {
    func read(_ item: SecurityKeychainItem) throws -> Data?
    func upsert(_ data: Data, for item: SecurityKeychainItem) throws
    func delete(_ item: SecurityKeychainItem) throws -> Bool
}

/// Stores generic-password items locally on this Apple device. Keychain syncing is disabled.
public struct SystemSecurityKeychainClient: SecurityKeychainClient {
    public init() {}

    public func read(_ item: SecurityKeychainItem) throws -> Data? {
        var query = baseQuery(for: item)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else {
                throw SecurityKeychainClientError.invalidResult
            }
            return data
        case errSecItemNotFound:
            return nil
        default:
            throw SecurityKeychainClientError.unexpectedStatus(Int32(status))
        }
    }

    public func upsert(_ data: Data, for item: SecurityKeychainItem) throws {
        var attributes = baseQuery(for: item)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] =
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        attributes[kSecAttrSynchronizable as String] = false

        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        guard addStatus == errSecDuplicateItem else {
            guard addStatus == errSecSuccess else {
                throw SecurityKeychainClientError.unexpectedStatus(Int32(addStatus))
            }
            return
        }

        let updates: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String:
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(
            baseQuery(for: item) as CFDictionary,
            updates as CFDictionary
        )
        guard updateStatus == errSecSuccess else {
            throw SecurityKeychainClientError.unexpectedStatus(Int32(updateStatus))
        }
    }

    public func delete(_ item: SecurityKeychainItem) throws -> Bool {
        let status = SecItemDelete(baseQuery(for: item) as CFDictionary)
        switch status {
        case errSecSuccess:
            return true
        case errSecItemNotFound:
            return false
        default:
            throw SecurityKeychainClientError.unexpectedStatus(Int32(status))
        }
    }

    private func baseQuery(for item: SecurityKeychainItem) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: item.service,
            kSecAttrAccount as String: item.account,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup = item.accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }
}

public enum KeychainAuthTokenStoreError: Error, Equatable, Sendable {
    case invalidService
    case malformedData
    case accountScopeMismatch
    case deviceScopeMismatch
}

/// A serialized, account-scoped token store backed by a device-local Keychain item.
///
/// The account identifier is part of the Keychain primary key. The device-session
/// identifier is persisted inside the authenticated credential and may not change
/// during a rotating-token compare-and-swap.
public actor KeychainAuthTokenStore: AuthTokenStore {
    public static let defaultService = "com.liammagnier.juno.auth.tokens"

    private let securityClient: any SecurityKeychainClient
    private let service: String
    private let accessGroup: String?

    public init(
        accessGroup: String? = nil,
        securityClient: any SecurityKeychainClient = SystemSecurityKeychainClient()
    ) {
        service = Self.defaultService
        self.accessGroup = accessGroup
        self.securityClient = securityClient
    }

    public init(
        service: String,
        accessGroup: String? = nil,
        securityClient: any SecurityKeychainClient = SystemSecurityKeychainClient()
    ) throws {
        guard !service.isEmpty,
            !service.unicodeScalars.contains(where: {
                CharacterSet.controlCharacters.contains($0)
                    || CharacterSet.whitespacesAndNewlines.contains($0)
            })
        else {
            throw KeychainAuthTokenStoreError.invalidService
        }
        self.service = service
        self.accessGroup = accessGroup
        self.securityClient = securityClient
    }

    public func load(for accountID: AccountID) async throws -> AuthTokenSet? {
        guard let data = try securityClient.read(item(for: accountID)) else {
            return nil
        }
        return try decode(data, expectedAccountID: accountID)
    }

    public func storeInitial(_ tokenSet: AuthTokenSet) async throws {
        let data = try encode(tokenSet)
        try securityClient.upsert(data, for: item(for: tokenSet.accountID))
    }

    public func replace(
        for accountID: AccountID,
        expectedRefreshToken: RefreshToken,
        with tokenSet: AuthTokenSet
    ) async throws -> Bool {
        guard tokenSet.accountID == accountID else {
            throw KeychainAuthTokenStoreError.accountScopeMismatch
        }
        guard let current = try await load(for: accountID) else {
            return false
        }
        guard current.refreshToken == expectedRefreshToken else {
            return false
        }
        guard current.deviceID == tokenSet.deviceID else {
            throw KeychainAuthTokenStoreError.deviceScopeMismatch
        }

        let data = try encode(tokenSet)
        try securityClient.upsert(data, for: item(for: accountID))
        return true
    }

    public func remove(
        for accountID: AccountID,
        ifRefreshTokenMatches refreshToken: RefreshToken?
    ) async throws -> Bool {
        guard let current = try await load(for: accountID) else {
            return false
        }
        if let refreshToken, current.refreshToken != refreshToken {
            return false
        }
        return try securityClient.delete(item(for: accountID))
    }

    private func item(for accountID: AccountID) -> SecurityKeychainItem {
        SecurityKeychainItem(
            service: service,
            account: accountID.rawValue,
            accessGroup: accessGroup
        )
    }

    private func encode(_ tokenSet: AuthTokenSet) throws -> Data {
        do {
            return try JSONEncoder().encode(StoredAuthTokenSet(tokenSet))
        } catch {
            throw KeychainAuthTokenStoreError.malformedData
        }
    }

    private func decode(
        _ data: Data,
        expectedAccountID: AccountID
    ) throws -> AuthTokenSet {
        do {
            let stored = try JSONDecoder().decode(StoredAuthTokenSet.self, from: data)
            guard stored.version == StoredAuthTokenSet.currentVersion else {
                throw KeychainAuthTokenStoreError.malformedData
            }
            let accountID = try AccountID(stored.accountID)
            guard accountID == expectedAccountID else {
                throw KeychainAuthTokenStoreError.accountScopeMismatch
            }
            return try AuthTokenSet(
                accountID: accountID,
                deviceID: DeviceID(stored.deviceID),
                accessToken: AccessToken(stored.accessToken),
                accessTokenExpiresAt: stored.accessTokenExpiresAt,
                refreshToken: RefreshToken(stored.refreshToken),
                refreshTokenExpiresAt: stored.refreshTokenExpiresAt
            )
        } catch let error as KeychainAuthTokenStoreError {
            throw error
        } catch {
            throw KeychainAuthTokenStoreError.malformedData
        }
    }
}

private struct StoredAuthTokenSet: Codable {
    static let currentVersion = 1

    let version: Int
    let accountID: String
    let deviceID: String
    let accessToken: String
    let accessTokenExpiresAt: Date
    let refreshToken: String
    let refreshTokenExpiresAt: Date

    init(_ tokenSet: AuthTokenSet) {
        version = Self.currentVersion
        accountID = tokenSet.accountID.rawValue
        deviceID = tokenSet.deviceID.rawValue
        accessToken = tokenSet.accessToken.reveal()
        accessTokenExpiresAt = tokenSet.accessTokenExpiresAt
        refreshToken = tokenSet.refreshToken.reveal()
        refreshTokenExpiresAt = tokenSet.refreshTokenExpiresAt
    }
}
