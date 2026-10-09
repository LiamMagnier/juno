import Foundation
import JunoCodeCore
import JunoCodeLocal
import Observation

/// The user's own API keys for Connections › Your API keys (DESIGN §5.13).
///
/// Two homes, one list: keys kept in the Alevr account (encrypted server
/// side with `src/lib/crypto.ts`, usable from any device and by the web) when
/// signed in, else keys kept in this Mac's Keychain for local runs only.
@MainActor
@Observable
public final class CodeV2KeysModel {
    public private(set) var records: [ByokKeyRecord] = []
    public private(set) var isWorking: Set<CodeV2.ByokProvider> = []
    public var errors: [CodeV2.ByokProvider: String] = [:]
    /// The record just removed, for the undo line.
    public private(set) var lastRemoved: (record: ByokKeyRecord, secret: String?)?

    @ObservationIgnored private let keychain: ByokKeychainStore?
    @ObservationIgnored private let account: ByokAccountStore?

    public init(keychain: ByokKeychainStore? = ByokKeychainStore(), account: ByokAccountStore? = nil) {
        self.keychain = keychain
        self.account = account
    }

    /// Snapshots and previews: a fixed list that never touches a store.
    public init(preview records: [ByokKeyRecord]) {
        self.keychain = nil
        self.account = nil
        self.records = records
    }

    public var providers: Set<CodeV2.ByokProvider> { Set(records.filter(\.isValid).map(\.provider)) }

    public func record(for provider: CodeV2.ByokProvider) -> ByokKeyRecord? {
        records.first { $0.provider == provider }
    }

    public func reload() async {
        var merged: [ByokKeyRecord] = []
        if let account, let remote = try? await account.records() { merged += remote }
        if let keychain {
            for local in keychain.records() where !merged.contains(where: { $0.provider == local.provider }) {
                merged.append(local)
            }
        }
        records = merged.sorted { $0.provider.rawValue < $1.provider.rawValue }
    }

    /// Validates the shape here, then stores: in the account when signed in
    /// (the server validates with a one-token call), else in the Keychain.
    @discardableResult
    public func save(_ raw: String, for provider: CodeV2.ByokProvider) async -> Bool {
        isWorking.insert(provider)
        defer { isWorking.remove(provider) }
        do {
            let record: ByokKeyRecord
            if let account {
                record = try await account.save(raw, for: provider)
            } else if let keychain {
                record = try keychain.save(raw, for: provider)
            } else {
                return false
            }
            records.removeAll { $0.provider == provider }
            records.append(record)
            records.sort { $0.provider.rawValue < $1.provider.rawValue }
            errors[provider] = nil
            return true
        } catch {
            errors[provider] = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return false
        }
    }

    public func remove(_ provider: CodeV2.ByokProvider) async {
        guard let record = record(for: provider) else { return }
        let secret = record.location == .keychain ? keychain?.secret(for: provider) : nil
        isWorking.insert(provider)
        defer { isWorking.remove(provider) }
        do {
            if record.location == .account { try await account?.remove(provider) } else { keychain?.remove(provider) }
            records.removeAll { $0.provider == provider }
            lastRemoved = (record, secret)
        } catch {
            errors[provider] = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Undo a removal: possible for a Keychain key (the secret is still in
    /// memory); an account key has to be pasted again.
    public func undoRemove() async {
        guard let removed = lastRemoved, let secret = removed.secret else { return }
        lastRemoved = nil
        await save(secret, for: removed.record.provider)
    }

    public var canUndo: Bool { lastRemoved?.secret != nil }
}
