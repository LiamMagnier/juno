import Foundation
import JunoCodeCore

/// One model Alevr's backend serves (`EnvBackendModel` in the contract): what
/// the env server's Alevr engine may call through `/api/agent/<provider>`,
/// and what a paired phone's picker shows for it.
public struct EnvBackendModel: Codable, Sendable, Hashable {
    /// The path segment under `/api/agent` ("anthropic", "openai", "zhipu"…).
    public var provider: String
    public var providerName: String?
    /// "anthropic" (Messages) or "openai" (Chat Completions / Responses).
    public var kind: String
    /// The provider's own id, without the lab prefix.
    public var model: String
    public var label: String
    public var available: Bool
    public var contextWindow: Int?
    /// "responses" for OpenAI's Responses-only models; nil is Chat Completions.
    public var api: String?
    public var effortLevels: [CodeV2.EffortLevel]?
    public var defaultEffort: CodeV2.EffortLevel?
    public var isDefault: Bool?

    public init(
        provider: String, providerName: String? = nil, kind: String, model: String, label: String,
        available: Bool = true, contextWindow: Int? = nil, api: String? = nil,
        effortLevels: [CodeV2.EffortLevel]? = nil, defaultEffort: CodeV2.EffortLevel? = nil, isDefault: Bool? = nil
    ) {
        self.provider = provider
        self.providerName = providerName
        self.kind = kind
        self.model = model
        self.label = label
        self.available = available
        self.contextWindow = contextWindow
        self.api = api
        self.effortLevels = effortLevels
        self.defaultEffort = defaultEffort
        self.isDefault = isDefault
    }
}

/// `env.configure`'s `backend` (`EnvBackendConfig` in the contract): the
/// signed-in Alevr session the env server's Alevr engine calls the backend
/// with, so a phone driving this Mac can run Alevr's API models too, billed
/// to the same plan as on the Mac.
///
/// Local only: the device link refuses `env.configure` from a remote, and
/// the env server never sends the session back out (provider.list carries
/// only the models). Its description hides the session.
public struct EnvBackendConfig: Codable, Sendable, Hashable, CustomStringConvertible {
    /// `https://<origin>/api/agent`, no trailing slash.
    public var baseUrl: String
    /// The whole `Authorization` value ("Bearer …").
    public var authorization: String
    public var models: [EnvBackendModel]?
    /// This Mac's paired device id (cross-conversation replies come back to it).
    public var deviceId: String?

    public init(baseUrl: String, authorization: String, models: [EnvBackendModel]? = nil, deviceId: String? = nil) {
        self.baseUrl = baseUrl
        self.authorization = authorization
        self.models = models
        self.deviceId = deviceId
    }

    public var description: String {
        "EnvBackendConfig(baseUrl: \(baseUrl), models: \(models?.count ?? 0), deviceId: \(deviceId ?? "nil"))"
    }

    /// The agent proxy under an origin ("https://alevr.com" → ".../api/agent").
    public static func agentBaseURL(origin: URL) -> String {
        var text = origin.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text + "/api/agent"
    }
}

extension EnvServerConnection {
    /// `env.configure` with the backend only (keys are never sent from here).
    public func configure(backend: EnvBackendConfig) async throws {
        struct P: Encodable { let backend: EnvBackendConfig }
        _ = try await send(.envConfigure, params: P(backend: backend))
    }
}
