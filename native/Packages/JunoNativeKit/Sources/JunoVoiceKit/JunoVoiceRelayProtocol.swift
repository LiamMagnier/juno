import Foundation

// MARK: - Juno voice relay wire protocol
//
// Mirror of the relay's own `relay/src/protocol.ts`: one WebSocket carrying JSON
// text frames for control and binary frames for audio — client→relay PCM16 mono
// 16 kHz, relay→client PCM16 mono 24 kHz. Treat it as frozen. The relay and the
// web client already speak exactly this, so a field invented on this side is a
// frame the relay drops without complaint, which reads as "voice is broken" with
// nothing in any log.

/// The realtime model behind a session.
///
/// The provider is chosen per session rather than per account because they are
/// not interchangeable: some do true speech-to-speech, some need this client to
/// supply the user's transcript (see ``JunoVoiceCapabilities``). The relay
/// answers every ``JunoVoiceClientMessage/sessionStart(provider:)`` with the
/// capabilities that actually apply, so nothing here is assumed locally.
public enum JunoVoiceProvider: String, Codable, CaseIterable, Identifiable, Sendable {
    case openai
    case gemini
    case qwen
    case minimax

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .openai: "OpenAI"
        case .gemini: "Gemini"
        case .qwen: "Qwen"
        case .minimax: "MiniMax"
        }
    }
}

/// What the negotiated session can actually do, as reported by the relay.
///
/// Decoded verbatim from the wire, including `videoInput`, which this client
/// never acts on — screen sharing is not part of the native voice surface. The
/// field stays because the payload is required-keyed: silently narrowing the
/// shape here is how a future relay change turns into a decode failure that
/// looks like a dead session.
public struct JunoVoiceCapabilities: Codable, Equatable, Sendable {
    public var videoInput: Bool
    /// True when the provider hears the audio itself. When false the relay only
    /// has text, and this client must run its own recognizer — the one thing
    /// that makes the session need microphone *and* speech authorization.
    public var trueS2S: Bool
    public var needsClientTranscript: Bool
    /// The relay hangs up at this point with ``JunoVoiceCloseReason/sessionLimit``.
    /// Surfacing it is what lets the UI warn before the audio simply stops.
    public var maxSessionSec: Int

    public init(videoInput: Bool, trueS2S: Bool, needsClientTranscript: Bool, maxSessionSec: Int) {
        self.videoInput = videoInput
        self.trueS2S = trueS2S
        self.needsClientTranscript = needsClientTranscript
        self.maxSessionSec = maxSessionSec
    }
}

/// Running cost of the live session, pushed by the relay as it meters.
///
/// The relay is the only honest source: it owns the provider connection and the
/// per-provider pricing. A client-side estimate from elapsed wall time would
/// drift the moment a turn is interrupted or a provider bills differently for
/// input and output audio.
public struct JunoVoiceUsage: Codable, Equatable, Sendable {
    public var provider: JunoVoiceProvider
    public var audioInSec: Double
    public var audioOutSec: Double
    public var estCostUsd: Double

    public init(
        provider: JunoVoiceProvider,
        audioInSec: Double,
        audioOutSec: Double,
        estCostUsd: Double
    ) {
        self.provider = provider
        self.audioInSec = audioInSec
        self.audioOutSec = audioOutSec
        self.estCostUsd = estCostUsd
    }
}

public enum JunoVoiceTranscriptRole: String, Codable, Sendable {
    case user
    case assistant
}

public enum JunoVoiceTurnPhase: String, Codable, Sendable {
    case start
    case end
}

/// Why a session ended, straight from the relay.
///
/// Kept distinct from an error: hitting ``JunoVoiceCapabilities/maxSessionSec``
/// or a clean provider hang-up is an ending, not a failure, and offering
/// "Something went wrong" for a session that simply ran its length trains people
/// to distrust the error copy that matters.
public enum JunoVoiceCloseReason: String, Codable, Sendable {
    case sessionLimit = "session-limit"
    case provider
    case client
    case error
}

// MARK: - Authorization

/// A short-lived credential for one relay session, plus the relay to spend it on.
public struct JunoVoiceRelayToken: Sendable {
    public let token: String
    /// The relay to dial, when the backend names one. It wins over the URL the
    /// client was built with, so the backend can move or shard relays without
    /// shipping a new app.
    public let url: URL?

    public init(token: String, url: URL? = nil) {
        self.token = token
        self.url = url
    }
}

/// How ``JunoRealtimeVoiceController`` obtains a relay credential.
///
/// Injected rather than reached for. The old app called a
/// `BackendConfiguration.shared` singleton from inside the controller, which
/// meant nothing about the connect path could be exercised without a signed-in
/// account and a live backend. Behind this protocol the account layer keeps
/// owning bearer tokens, refresh and error copy — and this target keeps its
/// existing dependencies, with no import of JunoAPI or JunoAuth.
public protocol JunoVoiceRelayAuthorizing: Sendable {
    /// GETs the relay token. Implementations attach the account's bearer token.
    ///
    /// Whatever is thrown becomes the user-visible failure verbatim via
    /// `localizedDescription`, so throw the human copy: the relay-token 402
    /// carries "budget_exceeded" in its machine `error` slug and the readable
    /// sentence in `message`, and only the latter is worth showing.
    func relayToken() async throws -> JunoVoiceRelayToken
}

/// The `GET /api/voice/relay-token` response body.
///
/// Lives here, next to the rest of the wire, so an authorizer does not have to
/// restate the shape — and so the string→`URL` parse happens in exactly one
/// place. That parse has a trap worth keeping central: a backend that sends
/// `""` for `url` must read as "no override", not as a relay at the empty URL.
public struct JunoVoiceRelayTokenResponse: Decodable, Sendable {
    public let token: String
    public let url: String?

    public init(token: String, url: String? = nil) {
        self.token = token
        self.url = url
    }

    public var resolved: JunoVoiceRelayToken {
        let trimmed = url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return JunoVoiceRelayToken(
            token: token,
            url: trimmed.isEmpty ? nil : URL(string: trimmed)
        )
    }
}

// MARK: - Client → relay

public enum JunoVoiceClientMessage: Encodable, Sendable {
    case sessionStart(provider: JunoVoiceProvider)
    case sessionSwitch(provider: JunoVoiceProvider)
    /// The user's words as text. Only sent for providers that cannot hear the
    /// audio themselves; for everyone else the microphone stream is the input.
    case inputText(String)
    case controlInterrupt
    case ping

    private enum CodingKeys: String, CodingKey {
        case type, provider, text
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .sessionStart(let provider):
            try container.encode("session.start", forKey: .type)
            try container.encode(provider, forKey: .provider)
        case .sessionSwitch(let provider):
            try container.encode("session.switch", forKey: .type)
            try container.encode(provider, forKey: .provider)
        case .inputText(let text):
            try container.encode("input.text", forKey: .type)
            try container.encode(text, forKey: .text)
        case .controlInterrupt:
            try container.encode("control.interrupt", forKey: .type)
        case .ping:
            try container.encode("ping", forKey: .type)
        }
    }

    /// The single text frame for this message, or nil if encoding fails — which
    /// these fixed shapes never do, and which is why callers drop rather than
    /// throw: a failure here would be a programming error, not a session error.
    public var jsonText: String? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

// MARK: - Relay → client

public enum JunoVoiceRelayMessage: Decodable, Sendable {
    case sessionReady(provider: JunoVoiceProvider, capabilities: JunoVoiceCapabilities)
    case transcript(role: JunoVoiceTranscriptRole, text: String, final: Bool)
    case turn(phase: JunoVoiceTurnPhase)
    case interrupted
    case usage(JunoVoiceUsage)
    case sessionClosed(reason: JunoVoiceCloseReason)
    case error(message: String)
    case pong
    /// An unrecognized `type` is carried, not thrown. The relay ships ahead of
    /// the native clients; a new frame type must not end a live conversation.
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, provider, capabilities, role, text, final, speaker, phase
        case audioInSec, audioOutSec, estCostUsd, reason, message
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "session.ready":
            self = .sessionReady(
                provider: try container.decode(JunoVoiceProvider.self, forKey: .provider),
                capabilities: try container.decode(
                    JunoVoiceCapabilities.self, forKey: .capabilities
                )
            )
        case "transcript":
            self = .transcript(
                role: try container.decode(JunoVoiceTranscriptRole.self, forKey: .role),
                text: try container.decode(String.self, forKey: .text),
                final: try container.decode(Bool.self, forKey: .final)
            )
        case "turn":
            self = .turn(phase: try container.decode(JunoVoiceTurnPhase.self, forKey: .phase))
        case "interrupted":
            self = .interrupted
        case "usage":
            self = .usage(
                JunoVoiceUsage(
                    provider: try container.decode(JunoVoiceProvider.self, forKey: .provider),
                    audioInSec: try container.decode(Double.self, forKey: .audioInSec),
                    audioOutSec: try container.decode(Double.self, forKey: .audioOutSec),
                    estCostUsd: try container.decode(Double.self, forKey: .estCostUsd)
                )
            )
        case "session.closed":
            self = .sessionClosed(
                reason: try container.decode(JunoVoiceCloseReason.self, forKey: .reason)
            )
        case "error":
            self = .error(message: try container.decode(String.self, forKey: .message))
        case "pong":
            self = .pong
        default:
            self = .unknown(type: type)
        }
    }

    /// Decodes one inbound text frame, or nil if it is not this protocol at all.
    public static func decode(fromText text: String) -> JunoVoiceRelayMessage? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JunoVoiceRelayMessage.self, from: data)
    }
}
