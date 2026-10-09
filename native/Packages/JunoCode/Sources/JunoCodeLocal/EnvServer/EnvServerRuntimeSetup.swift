import Foundation
import JunoCodeCore

/// Runtimes the env server installs and signs in itself (Antigravity): the
/// vendor's own release, downloaded and checked against a pinned size and
/// SHA-256 (`provider.install`), and a browser sign-in the runtime runs on
/// 127.0.0.1 (`provider.auth`). Built against the runtime lane's contract
/// (`ProviderInstance.install` / `.auth`, `provider.install`, `provider.auth`);
/// the state rides on `provider.updated`, which this side reads from the raw
/// frame so an older contract mirror does not drop it.
///
/// Never holds a code or a token: the authorization URL is the vendor's sign-in
/// page, and a pasted redirect URL goes straight back to the env server.
public enum EnvRuntimeSetup {
    /// The contract's own types (`ProviderInstance.install` / `.auth`).
    public typealias InstallState = CodeV2.ProviderInstallState
    public typealias AuthState = CodeV2.ProviderAuthState
    public typealias InstallAction = CodeV2.ProviderInstallAction
    public typealias AuthAction = CodeV2.ProviderAuthAction

    /// One instance's managed-runtime state from a `provider.updated` frame.
    public struct Update: Equatable, Sendable {
        public var instanceId: String
        public var install: InstallState?
        public var auth: AuthState?

        public init(instanceId: String, install: InstallState? = nil, auth: AuthState? = nil) {
            self.instanceId = instanceId
            self.install = install
            self.auth = auth
        }
    }

    /// Reads the managed-runtime fields of a raw `provider.updated` frame, or nil.
    static func update(fromFrame frame: String) -> Update? {
        guard frame.contains("\"provider.updated\"") else { return nil }
        struct Frame: Decodable {
            struct Event: Decodable {
                struct Instance: Decodable {
                    let id: String
                    let install: InstallState?
                    let auth: AuthState?
                }
                let type: String
                let instance: Instance?
            }
            let type: String
            let event: Event?
        }
        guard let data = frame.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(Frame.self, from: data),
              decoded.type == "event", decoded.event?.type == "provider.updated",
              let instance = decoded.event?.instance,
              instance.install != nil || instance.auth != nil
        else { return nil }
        return Update(instanceId: instance.id, install: instance.install, auth: instance.auth)
    }

    /// What a pasted sign-in redirect must look like before it is sent on:
    /// an http(s) address on this Mac's loopback, carrying a query.
    public static func isLoopbackRedirect(_ text: String) -> Bool {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), ["127.0.0.1", "localhost", "[::1]", "::1"].contains(host),
              url.query?.isEmpty == false
        else { return false }
        return true
    }

    /// The vendor's sign-in page is opened only if it is a web page.
    public static func isOpenableAuthorizationURL(_ text: String?) -> URL? {
        guard let text, let url = URL(string: text), url.scheme?.lowercased() == "https", url.host != nil else { return nil }
        return url
    }
}

public extension CodeV2.ProviderInstallState {
    var isRunning: Bool { [.downloading, .extracting, .verifying].contains(phase) }
}

public extension CodeV2.ProviderAuthState {
    var isOpen: Bool { [.starting, .waiting, .verifying].contains(phase) }
}
