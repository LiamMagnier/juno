import Foundation
import JunoCodeCore
import Security

/// What the Connections page shows about one stored key. Never the key.
public struct ByokKeyRecord: Equatable, Sendable, Codable, Identifiable {
    public var id: String { provider.rawValue }
    public var provider: CodeV2.ByokProvider
    /// `sk-ant-…4f2a`.
    public var hint: String
    public var addedAt: Date
    public var lastUsedAt: Date?
    /// "invalid" when the lab refused it at the last check.
    public var isValid: Bool
    public var statusDetail: String?
    /// Where it lives: this Mac's Keychain, or the user's Alevr account.
    public var location: Location

    public enum Location: String, Equatable, Sendable, Codable { case keychain, account }

    public init(
        provider: CodeV2.ByokProvider, hint: String, addedAt: Date, lastUsedAt: Date? = nil,
        isValid: Bool = true, statusDetail: String? = nil, location: Location
    ) {
        self.provider = provider
        self.hint = hint
        self.addedAt = addedAt
        self.lastUsedAt = lastUsedAt
        self.isValid = isValid
        self.statusDetail = statusDetail
        self.location = location
    }
}

public enum ByokKeyStoreError: Error, Equatable, LocalizedError, Sendable {
    case emptyKey
    case wrongShape(String)
    case keychain(OSStatus)
    case rejected(String)
    case unreachable(String)
    case notSignedIn

    public var errorDescription: String? {
        switch self {
        case .emptyKey: "Paste a key first."
        case let .wrongShape(message): message
        case let .keychain(status): "The Keychain refused the key (\(status))."
        case let .rejected(message): message
        case let .unreachable(message): message
        case .notSignedIn: "Sign in to Alevr to keep keys in your account."
        }
    }
}

/// Validates a pasted key's shape before anything stores or sends it.
public enum ByokKeyShape {
    public static func check(_ raw: String, for provider: CodeV2.ByokProvider) -> Result<String, ByokKeyStoreError> {
        let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return .failure(.emptyKey) }
        guard !key.contains(where: { $0.isWhitespace }) else {
            return .failure(.wrongShape("A key is one line with no spaces."))
        }
        guard key.count >= 20, key.count <= 400 else {
            return .failure(.wrongShape("That does not look like a full \(provider.labName) key."))
        }
        if let prefix = provider.keyPrefix, !key.hasPrefix(prefix) {
            return .failure(.wrongShape("\(provider.labName) keys start with \(prefix)"))
        }
        return .success(key)
    }
}

/// Keys kept on this Mac only, for local runs: the secret in the login
/// Keychain (this device only, after first unlock), the facts beside it in
/// user defaults.
public struct ByokKeychainStore: Sendable {
    public static let service = "com.liammagnier.alevr.code.byok"
    private let service: String
    private let defaultsKey: String

    public init(service: String = ByokKeychainStore.service) {
        self.service = service
        self.defaultsKey = service + ".records"
    }

    public func records() -> [ByokKeyRecord] {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let records = try? JSONDecoder().decode([ByokKeyRecord].self, from: data)
        else { return [] }
        return records.filter { secret(for: $0.provider) != nil }
    }

    @discardableResult
    public func save(_ raw: String, for provider: CodeV2.ByokProvider, now: Date = Date()) throws -> ByokKeyRecord {
        let key = try ByokKeyShape.check(raw, for: provider).get()
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.rawValue,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(key.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        add[kSecAttrLabel as String] = "Alevr \(provider.labName) API key"
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw ByokKeyStoreError.keychain(status) }
        let record = ByokKeyRecord(provider: provider, hint: CodeV2.ByokProvider.maskedKey(key), addedAt: now, location: .keychain)
        var all = records().filter { $0.provider != provider }
        all.append(record)
        persist(all)
        return record
    }

    public func secret(for provider: CodeV2.ByokProvider) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.rawValue,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func remove(_ provider: CodeV2.ByokProvider) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.rawValue,
        ]
        SecItemDelete(query as CFDictionary)
        persist(records().filter { $0.provider != provider })
    }

    public func markUsed(_ provider: CodeV2.ByokProvider, at date: Date = Date()) {
        var all = records()
        guard let index = all.firstIndex(where: { $0.provider == provider }) else { return }
        all[index].lastUsedAt = date
        persist(all)
    }

    private func persist(_ records: [ByokKeyRecord]) {
        guard let data = try? JSONEncoder().encode(records) else { return }
        UserDefaults.standard.set(data, forKey: defaultsKey)
    }
}

/// Keys kept in the user's Alevr account (`/api/provider-keys`, encrypted at
/// rest by the server's keyring), so the web and every Mac use them.
public struct ByokAccountStore: Sendable {
    /// Performs an authenticated request against the Alevr API and returns
    /// the status and body. Supplied by the app, which owns the session.
    public typealias Perform = @Sendable (_ method: String, _ path: String, _ body: Data?) async throws -> (Int, Data)

    private let perform: Perform

    public init(perform: @escaping Perform) {
        self.perform = perform
    }

    struct KeyView: Decodable {
        let provider: String
        let keyHint: String
        let status: String
        let statusDetail: String?
        let lastUsedAt: String?
        let createdAt: String
    }

    struct ListWire: Decodable { let keys: [KeyView] }
    struct AddWire: Decodable { let key: KeyView }
    struct ErrorWire: Decodable { let error: String? }

    public func records() async throws -> [ByokKeyRecord] {
        let (status, data) = try await perform("GET", "/api/provider-keys", nil)
        guard status != 401 else { throw ByokKeyStoreError.notSignedIn }
        guard (200..<300).contains(status) else { throw ByokKeyStoreError.unreachable(Self.message(data) ?? "Could not load your keys.") }
        return try JSONDecoder().decode(ListWire.self, from: data).keys.compactMap(Self.record)
    }

    /// Validates the key with the lab (server side) and stores it.
    public func save(_ raw: String, for provider: CodeV2.ByokProvider) async throws -> ByokKeyRecord {
        let key = try ByokKeyShape.check(raw, for: provider).get()
        let body = try JSONSerialization.data(withJSONObject: ["provider": provider.rawValue, "key": key])
        let (status, data) = try await perform("POST", "/api/provider-keys", body)
        switch status {
        case 200..<300:
            guard let record = Self.record(try JSONDecoder().decode(AddWire.self, from: data).key) else {
                throw ByokKeyStoreError.unreachable("The key was saved but could not be read back.")
            }
            return record
        case 401: throw ByokKeyStoreError.notSignedIn
        case 400, 422: throw ByokKeyStoreError.rejected(Self.message(data) ?? "The provider refused this key.")
        default: throw ByokKeyStoreError.unreachable(Self.message(data) ?? "Couldn't reach the provider to check this key. Try again.")
        }
    }

    public func remove(_ provider: CodeV2.ByokProvider) async throws {
        let (status, data) = try await perform("DELETE", "/api/provider-keys/\(provider.rawValue)", nil)
        guard (200..<300).contains(status) || status == 404 else {
            throw ByokKeyStoreError.unreachable(Self.message(data) ?? "Could not remove the key.")
        }
    }

    static func record(_ view: KeyView) -> ByokKeyRecord? {
        guard let provider = CodeV2.ByokProvider(rawValue: view.provider) else { return nil }
        return ByokKeyRecord(
            provider: provider,
            hint: view.keyHint,
            addedAt: CodeV2Dates.parse(view.createdAt) ?? Date(),
            lastUsedAt: view.lastUsedAt.flatMap(CodeV2Dates.parse),
            isValid: view.status != "invalid",
            statusDetail: view.statusDetail,
            location: .account
        )
    }

    static func message(_ data: Data) -> String? {
        (try? JSONDecoder().decode(ErrorWire.self, from: data))?.error
    }
}
