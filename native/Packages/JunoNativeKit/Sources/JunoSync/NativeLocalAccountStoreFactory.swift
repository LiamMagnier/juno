import Foundation
import JunoAuth
import JunoCore
import JunoStorage

public enum NativeLocalAccountStoreFactoryError: Error, Equatable, Sendable {
    case malformedEncryptionKey
    case missingEncryptionKey
    case encryptionKeyRace
    case archiveDestinationUnavailable
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
        case .archiveDestinationUnavailable:
            "Juno could not find a free name to move the old local database to."
        }
    }
}

/// The outcome of ``NativeLocalAccountStoreFactory/recoverAndOpenRepository()``:
/// a usable store, and where the unreadable one was put if there was one.
public struct NativeLocalAccountStoreRecovery: Sendable {
    public let repository: SQLiteAccountRepository
    /// `nil` when nothing had to be moved — either there was no database, or the
    /// key turned out to be readable after all.
    public let archivedDatabaseURL: URL?
}

/// Opens the shared encrypted SQLite store using a device-local Keychain key.
/// The atomic insert prevents concurrent composition roots from replacing a
/// key after the database has already encrypted data with it.
public struct NativeLocalAccountStoreFactory: Sendable {
    public static let encryptionKeyItem = SecurityKeychainItem(
        service: "com.liammagnier.juno.storage.encryption-key",
        account: "database-v1"
    )

    /// SQLite's own names for the journal and shared-memory files it keeps
    /// beside the database in WAL mode.
    private static let walSuffixes = ["-wal", "-shm"]
    private static let maximumArchiveAttempts = 64

    /// Sortable, and free of the colons a time renders with — Finder still shows
    /// those as path separators.
    private static let archiveTimestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        return formatter
    }()

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
        try openRepository(cipherFor: loadOrCreateKey())
    }

    /// Opens the store, first moving an existing database out of the way if this
    /// build has no key that could unlock it.
    ///
    /// Moved, never deleted. The bytes are unreadable *by this process*, which is
    /// not the same as gone: the key can be stranded in the macOS
    /// data-protection keychain, which needs an `application-identifier`
    /// entitlement that only an embedded provisioning profile supplies, so a
    /// properly provisioned build of the same app can still read both the key and
    /// the database. Destroying someone's conversations to work around a signing
    /// problem is not a decision this code gets to make on their behalf.
    ///
    /// Only ever called for a user who asked for it. ``openRepository()`` keeps
    /// refusing, because a launch path that quietly re-keys an existing database
    /// orphans it every time a Keychain read merely fails.
    public func recoverAndOpenRepository() throws -> NativeLocalAccountStoreRecovery {
        // Re-read rather than trusting the caller's diagnosis. The keychain
        // client falls back to the legacy store on `errSecMissingEntitlement`,
        // so the key can become reachable again between the failed launch and
        // this call — and then there is nothing to recover from and a database
        // that must not be touched.
        if let stored = try? securityClient.read(Self.encryptionKeyItem),
            let key = try? validate(stored)
        {
            return NativeLocalAccountStoreRecovery(
                repository: try openRepository(cipherFor: key),
                archivedDatabaseURL: nil
            )
        }

        let archivedDatabaseURL = try archiveDatabase()
        // Reached only when the stored key is absent or the wrong length; a
        // 32-byte key would have been used above. Either way it cannot open the
        // database that was just archived, and leaving it in place would make
        // `loadOrCreateKey` fail the freshly created store on the same value.
        _ = try? securityClient.delete(Self.encryptionKeyItem)
        return NativeLocalAccountStoreRecovery(
            repository: try openRepository(),
            archivedDatabaseURL: archivedDatabaseURL
        )
    }

    /// - Returns: where the database was moved, or `nil` if there was none.
    private func archiveDatabase() throws -> URL? {
        let manager = FileManager.default
        guard manager.fileExists(atPath: databaseURL.path) else { return nil }

        let destination = try archiveDestination()
        try manager.moveItem(at: databaseURL, to: destination)
        // The write-ahead log and shared-memory files are part of the same
        // database. Left behind, SQLite would replay them into the new store on
        // its first open, which is both a decryption failure and a corruption of
        // the archive this method exists to preserve.
        for suffix in Self.walSuffixes {
            let sibling = URL(fileURLWithPath: databaseURL.path + suffix)
            guard manager.fileExists(atPath: sibling.path) else { continue }
            try manager.moveItem(
                at: sibling,
                to: URL(fileURLWithPath: destination.path + suffix)
            )
        }
        return destination
    }

    /// A timestamped neighbour of the database, disambiguated if one already
    /// exists — a second recovery in the same second must not fail the user's
    /// only way out.
    private func archiveDestination() throws -> URL {
        let manager = FileManager.default
        let directory = databaseURL.deletingLastPathComponent()
        let name = databaseURL.lastPathComponent
        let stamp = Self.archiveTimestampFormatter.string(from: Date())
        for attempt in 0..<Self.maximumArchiveAttempts {
            let suffix = attempt == 0 ? "" : "-\(attempt + 1)"
            let candidate = directory.appendingPathComponent(
                "\(name).unreadable-\(stamp)\(suffix)"
            )
            if !manager.fileExists(atPath: candidate.path) { return candidate }
        }
        throw NativeLocalAccountStoreFactoryError.archiveDestinationUnavailable
    }

    private func openRepository(cipherFor keyData: Data) throws
        -> SQLiteAccountRepository
    {
        let cipher: AESGCMAccountDataCipher
        do {
            cipher = try AESGCMAccountDataCipher(keyData: keyData)
        } catch {
            throw NativeLocalAccountStoreFactoryError.malformedEncryptionKey
        }
        return try SQLiteAccountRepository(databaseURL: databaseURL, cipher: cipher)
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
