import Foundation
import Security

/// The Preview's secrets, in the Keychain and never in a file the repository
/// holds (CODE_AGENT_SPEC §4.2, §4.3, PV-25):
///
/// - **Server secrets**: environment values a configuration's server needs
///   (`DATABASE_URL`, an API key). Injected into that child process only;
///   never shown to the model, logged, or written to `.juno/launch.json`.
/// - **Sign-in secrets**: test credentials the agent types into a password
///   field by name (`secret: "admin"`); the value never reaches the model or
///   the transcript, which shows `••••`.
public enum PreviewSecrets {
    public enum Kind: String, Sendable {
        case server = "com.liammagnier.juno.preview-env"
        case signIn = "com.liammagnier.juno.preview-secrets"
    }

    /// The account a secret is filed under: checkout, scope (a configuration
    /// name for server secrets) and name.
    static func account(checkoutRoot: URL, scope: String?, name: String) -> String {
        let root = checkoutRoot.resolvingSymlinksInPath().standardizedFileURL.path
        return [root, scope, name].compactMap { $0 }.joined(separator: "#")
    }

    public static func value(_ kind: Kind, checkoutRoot: URL, scope: String? = nil, name: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: kind.rawValue,
            kSecAttrAccount as String: account(checkoutRoot: checkoutRoot, scope: scope, name: name),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    public static func save(_ value: String, _ kind: Kind, checkoutRoot: URL, scope: String? = nil, name: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: kind.rawValue,
            kSecAttrAccount as String: account(checkoutRoot: checkoutRoot, scope: scope, name: name),
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    public static func delete(_ kind: Kind, checkoutRoot: URL, scope: String? = nil, name: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: kind.rawValue,
            kSecAttrAccount as String: account(checkoutRoot: checkoutRoot, scope: scope, name: name),
        ]
        SecItemDelete(query as CFDictionary)
    }

    /// The names saved for a checkout (and scope). Values are not read.
    public static func names(_ kind: Kind, checkoutRoot: URL, scope: String? = nil) -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: kind.rawValue,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var items: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess,
              let list = items as? [[String: Any]]
        else { return [] }
        let prefix = account(checkoutRoot: checkoutRoot, scope: scope, name: "")
        return list.compactMap { $0[kSecAttrAccount as String] as? String }
            .filter { $0.hasPrefix(prefix) }
            .map { String($0.dropFirst(prefix.count)) }
            .filter { !$0.isEmpty && !$0.contains("#") }
            .sorted()
    }
}

/// Server secrets for a configuration's child process.
public protocol PreviewSecretEnvironmentProviding: Sendable {
    func environment(for configuration: ResolvedPreviewConfiguration, checkoutRoot: URL) -> [String: String]
}

/// The Keychain's server secrets.
public struct KeychainPreviewEnvironment: PreviewSecretEnvironmentProviding {
    public init() {}

    public func environment(for configuration: ResolvedPreviewConfiguration, checkoutRoot: URL) -> [String: String] {
        var environment: [String: String] = [:]
        for name in PreviewSecrets.names(.server, checkoutRoot: checkoutRoot, scope: configuration.name) {
            if let value = PreviewSecrets.value(.server, checkoutRoot: checkoutRoot, scope: configuration.name, name: name) {
                environment[name] = value
            }
        }
        return environment
    }
}

/// No secrets: tests.
public struct NoPreviewEnvironmentSecrets: PreviewSecretEnvironmentProviding {
    public init() {}
    public func environment(for _: ResolvedPreviewConfiguration, checkoutRoot _: URL) -> [String: String] { [:] }
}
