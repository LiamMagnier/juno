import Foundation
import JunoAuth
import JunoCore
import JunoStorage

public enum NativeLocalAccountStoreFactoryError: Error, Equatable, Sendable {
    case malformedEncryptionKey
    case missingEncryptionKey
    case encryptionKeyRace
}

extension NativeLocalAccountStoreFactoryError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .malformedEncryptionKey:
            "Juno found an invalid local encryption key."
        case .missingEncryptionKey:
            "Juno cannot unlock the existing local account database."
        case .encryptionKeyRace:
            "Juno could not finish creating its local encryption key."
        }
    }
}

/// Opens the shared encrypted SQLite store using a device-local Keychain key.
/// The atomic insert prevents concurrent composition roots from replacing a
/// key after the database has already encrypted data with it.
public struct NativeLocalAccountStoreFactory: Sendable {
    public static let encryptionKeyItem = SecurityKeychainItem(
        service: "com.liammagnier.juno.storage.encryption-key",
        account: "database-v1"
    )

    private let databaseURL: URL
    private let securityClient: any SecurityKeychainClient
    private let randomGenerator: any SecureRandomDataGenerating

    public init(
        databaseURL: URL,
        securityClient: any SecurityKeychainClient = SystemSecurityKeychainClient(),
        randomGenerator: any SecureRandomDataGenerating =
            SystemSecureRandomDataGenerator()
    ) {
        self.databaseURL = databaseURL
        self.securityClient = securityClient
        self.randomGenerator = randomGenerator
    }

    public func openRepository() throws -> SQLiteAccountRepository {
        let keyData = try loadOrCreateKey()
        let cipher: AESGCMAccountDataCipher
        do {
            cipher = try AESGCMAccountDataCipher(keyData: keyData)
        } catch {
            throw NativeLocalAccountStoreFactoryError.malformedEncryptionKey
        }
        return try SQLiteAccountRepository(
            databaseURL: databaseURL,
            cipher: cipher
        )
    }

    private func loadOrCreateKey() throws -> Data {
        if let stored = try securityClient.read(Self.encryptionKeyItem) {
            return try validate(stored)
        }
        if FileManager.default.fileExists(atPath: databaseURL.path) {
            throw NativeLocalAccountStoreFactoryError.missingEncryptionKey
        }

        let candidate = try validate(randomGenerator.generate(count: 32))
        if try securityClient.insertIfAbsent(
            candidate,
            for: Self.encryptionKeyItem
        ) {
            return candidate
        }
        guard let winner = try securityClient.read(Self.encryptionKeyItem) else {
            throw NativeLocalAccountStoreFactoryError.encryptionKeyRace
        }
        return try validate(winner)
    }

    private func validate(_ data: Data) throws -> Data {
        guard data.count == 32 else {
            throw NativeLocalAccountStoreFactoryError.malformedEncryptionKey
        }
        return data
    }
}

public struct RepositoryAccountDataPurger<Repository: AccountScopedRepository>:
    NativeAccountDataPurging
{
    private let repository: Repository

    public init(repository: Repository) {
        self.repository = repository
    }

    public func wipe(accountID: AccountID) async throws {
        try await repository.wipe(
            accountID: StorageAccountID(accountID.rawValue)
        )
    }
}
