import CryptoKit
import Foundation

public struct AccountDataCipherContext: Equatable, Sendable {
    public let accountID: StorageAccountID
    public let recordKey: RecordKey
    public let revision: UInt64
    public let updatedAt: Date

    public init(
        accountID: StorageAccountID,
        recordKey: RecordKey,
        revision: UInt64,
        updatedAt: Date
    ) {
        self.accountID = accountID
        self.recordKey = recordKey
        self.revision = revision
        self.updatedAt = updatedAt
    }
}

public protocol AccountDataCipher: Sendable {
    func seal(_ plaintext: Data, context: AccountDataCipherContext) throws -> Data
    func open(_ sealed: Data, context: AccountDataCipherContext) throws -> Data
}

public enum AccountDataCipherError: Error, Equatable, Sendable {
    case invalidKeyLength
    case encryptionFailed
    case authenticationFailed
}

/// Encrypts record payloads while binding ciphertext to its account, key,
/// revision and timestamp. The 256-bit key must be stored separately from the
/// database, such as in the device-local Keychain.
public struct AESGCMAccountDataCipher: AccountDataCipher, Sendable {
    private let keyData: Data

    public init(keyData: Data) throws {
        guard keyData.count == 32 else {
            throw AccountDataCipherError.invalidKeyLength
        }
        self.keyData = keyData
    }

    public func seal(
        _ plaintext: Data,
        context: AccountDataCipherContext
    ) throws -> Data {
        do {
            let box = try AES.GCM.seal(
                plaintext,
                using: SymmetricKey(data: keyData),
                authenticating: authenticatedData(for: context)
            )
            guard let combined = box.combined else {
                throw AccountDataCipherError.encryptionFailed
            }
            return combined
        } catch let error as AccountDataCipherError {
            throw error
        } catch {
            throw AccountDataCipherError.encryptionFailed
        }
    }

    public func open(
        _ sealed: Data,
        context: AccountDataCipherContext
    ) throws -> Data {
        do {
            return try AES.GCM.open(
                AES.GCM.SealedBox(combined: sealed),
                using: SymmetricKey(data: keyData),
                authenticating: authenticatedData(for: context)
            )
        } catch {
            throw AccountDataCipherError.authenticationFailed
        }
    }

    private func authenticatedData(for context: AccountDataCipherContext) -> Data {
        var data = Data("juno.account-record.v1".utf8)
        append(context.accountID.rawValue, to: &data)
        append(context.recordKey.namespace, to: &data)
        append(context.recordKey.id, to: &data)
        append(context.revision, to: &data)
        append(context.updatedAt.timeIntervalSince1970.bitPattern, to: &data)
        return data
    }

    private func append(_ value: String, to data: inout Data) {
        let bytes = Data(value.utf8)
        append(UInt64(bytes.count), to: &data)
        data.append(bytes)
    }

    private func append(_ value: UInt64, to data: inout Data) {
        var bigEndian = value.bigEndian
        withUnsafeBytes(of: &bigEndian) { bytes in
            data.append(contentsOf: bytes)
        }
    }
}
