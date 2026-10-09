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
    public struct InstallState: Codable, Equatable, Sendable {
        public enum Phase: String, Codable, Sendable {
            case idle, downloading, extracting, verifying, succeeded, failed, cancelled
        }
        public var phase: Phase
        public var operationId: String?
        public var downloadedBytes: Int?
        public var totalBytes: Int?
        public var version: String?
        public var installedVersion: String?
        public var message: String?

        public init(
            phase: Phase, operationId: String? = nil, downloadedBytes: Int? = nil, totalBytes: Int? = nil,
            version: String? = nil, installedVersion: String? = nil, message: String? = nil
        ) {
            self.phase = phase
            self.operationId = operationId
            self.downloadedBytes = downloadedBytes
            self.totalBytes = totalBytes
            self.version = version
            self.installedVersion = installedVersion
            self.message = message
        }

        public var isRunning: Bool { [.downloading, .extracting, .verifying].contains(phase) }
    }

    public struct AuthState: Codable, Equatable, Sendable {
        public enum Phase: String, Codable, Sendable {
            case idle, starting, waiting, verifying, succeeded, failed, cancelled
        }
        public var phase: Phase
        public var flowId: String?
        public var authorizationUrl: String?
        public var expiresAt: String?
        public var message: String?
        public var method: String?

        public init(
            phase: Phase, flowId: String? = nil, authorizationUrl: String? = nil, expiresAt: String? = nil,
            message: String? = nil, method: String? = nil
        ) {
            self.phase = phase
            self.flowId = flowId
            self.authorizationUrl = authorizationUrl
            self.expiresAt = expiresAt
            self.message = message
            self.method = method
        }

        public var isOpen: Bool { [.starting, .waiting, .verifying].contains(phase) }
    }

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

    public enum InstallAction: String, Sendable { case start, cancel, remove }
    public enum AuthAction: String, Sendable { case start, complete, cancel, logout }

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

public extension EnvServerConnection {
    private struct InstallResult: Decodable { let install: EnvRuntimeSetup.InstallState }
    private struct AuthResult: Decodable { let auth: EnvRuntimeSetup.AuthState }

    func providerInstall(
        _ instanceId: String, action: EnvRuntimeSetup.InstallAction, operationId: String? = nil
    ) async throws -> EnvRuntimeSetup.InstallState {
        struct P: Encodable { let instanceId: String; let action: String; let operationId: String? }
        let value = try await send(rawType: "provider.install", params: P(instanceId: instanceId, action: action.rawValue, operationId: operationId))
        return try Self.decode(InstallResult.self, value, type: "provider.install").install
    }

    func providerAuth(
        _ instanceId: String, action: EnvRuntimeSetup.AuthAction, flowId: String? = nil, callbackUrl: String? = nil
    ) async throws -> EnvRuntimeSetup.AuthState {
        struct P: Encodable { let instanceId: String; let action: String; let flowId: String?; let callbackUrl: String? }
        let value = try await send(
            rawType: "provider.auth",
            params: P(instanceId: instanceId, action: action.rawValue, flowId: flowId, callbackUrl: callbackUrl)
        )
        return try Self.decode(AuthResult.self, value, type: "provider.auth").auth
    }

    private static func decode<T: Decodable>(_: T.Type, _ value: JSONValue?, type: String) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value ?? .object([:])))
        } catch {
            throw EnvServerConnectionError.malformedResult(type)
        }
    }
}
