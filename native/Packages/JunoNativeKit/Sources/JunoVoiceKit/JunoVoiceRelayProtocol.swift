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
/// Both video flags are acted on now: ``videoInput`` gates every
/// ``JunoVoiceClientMessage/videoFrame(jpegBase64:)`` this client sends, and
/// ``screenInput`` gates the Mac's screen share specifically — the two are not
/// the same permission, because OpenAI takes camera frames and images but not a
/// screen.
///
/// `screenInput` is the one key the relay omits rather than sends as `false`,
/// which is why decoding is hand-written. Every other key is required, and a
/// synthesized decoder would therefore fail the whole `session.ready` frame the
/// moment a provider left it out — a session that connects, goes quiet, and logs
/// nothing anywhere.
public struct JunoVoiceCapabilities: Codable, Equatable, Sendable {
    /// The provider accepts JPEG frames at all: the iPhone's camera, and images
    /// attached to a turn on either platform.
    public var videoInput: Bool
    /// Narrower than ``videoInput``: the provider accepts a *screen*. Absent on
    /// the wire means false, not unknown.
    public var screenInput: Bool
    /// True when the provider hears the audio itself. When false the relay only
    /// has text, and this client must run its own recognizer — the one thing
    /// that makes the session need microphone *and* speech authorization.
    public var trueS2S: Bool
    public var needsClientTranscript: Bool
    /// The relay hangs up at this point with ``JunoVoiceCloseReason/sessionLimit``.
    /// Surfacing it is what lets the UI warn before the audio simply stops.
    public var maxSessionSec: Int

    public init(
        videoInput: Bool,
        screenInput: Bool = false,
        trueS2S: Bool,
        needsClientTranscript: Bool,
        maxSessionSec: Int
    ) {
        self.videoInput = videoInput
        self.screenInput = screenInput
        self.trueS2S = trueS2S
        self.needsClientTranscript = needsClientTranscript
        self.maxSessionSec = maxSessionSec
    }

    private enum CodingKeys: String, CodingKey {
        case videoInput, screenInput, trueS2S, needsClientTranscript, maxSessionSec
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        videoInput = try container.decode(Bool.self, forKey: .videoInput)
        screenInput = try container.decodeIfPresent(Bool.self, forKey: .screenInput) ?? false
        trueS2S = try container.decode(Bool.self, forKey: .trueS2S)
        needsClientTranscript = try container.decode(Bool.self, forKey: .needsClientTranscript)
        maxSessionSec = try container.decode(Int.self, forKey: .maxSessionSec)
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
    /// ``estCostUsd`` split into what the user's speech cost and what the
    /// model's did. Optional on the wire, and optional here for the same reason:
    /// not every provider reports token counts the relay can price, and a `0`
    /// would read as "this turn was free" rather than "nobody knows".
    public var estCostInUsd: Double?
    public var estCostOutUsd: Double?

    public init(
        provider: JunoVoiceProvider,
        audioInSec: Double,
        audioOutSec: Double,
        estCostUsd: Double,
        estCostInUsd: Double? = nil,
        estCostOutUsd: Double? = nil
    ) {
        self.provider = provider
        self.audioInSec = audioInSec
        self.audioOutSec = audioOutSec
        self.estCostUsd = estCostUsd
        self.estCostInUsd = estCostInUsd
        self.estCostOutUsd = estCostOutUsd
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
    /// The user's words as text — from the on-device recognizer for providers
    /// that cannot hear the audio themselves, or from a composed turn.
    ///
    /// `turnId` and `displayText` only travel with a composed turn, and both
    /// default to absent so the recognizer's call site stays a bare
    /// `.inputText(text)`. The relay echoes `turnId` back on its `transcript`
    /// frame, which is how a typed turn lands in the conversation once instead
    /// of twice; `displayText` is what the reader sees when what was actually
    /// sent to the model is the stand-in prompt for shared images rather than
    /// anything they wrote.
    case inputText(_ text: String, turnId: String? = nil, displayText: String? = nil)
    case controlInterrupt
    /// One JPEG screen or camera frame, base64 with no `data:` prefix.
    ///
    /// The relay forwards a frame only while its base64 payload is non-empty and
    /// under 2,000,000 characters, and every provider that takes video expects
    /// about one frame a second — send faster and the frames are billed and
    /// discarded rather than looked at.
    case videoFrame(jpegBase64: String)
    case ping

    private enum CodingKeys: String, CodingKey {
        case type, provider, text, turnId, displayText, jpegBase64
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
        case .inputText(let text, let turnId, let displayText):
            try container.encode("input.text", forKey: .type)
            try container.encode(text, forKey: .text)
            // Encoded only when present: the relay reads `turnId` as "this turn
            // is already on screen", so a null one would suppress the echo that
            // the recognizer path depends on.
            try container.encodeIfPresent(turnId, forKey: .turnId)
            try container.encodeIfPresent(displayText, forKey: .displayText)
        case .controlInterrupt:
            try container.encode("control.interrupt", forKey: .type)
        case .videoFrame(let jpegBase64):
            try container.encode("video.frame", forKey: .type)
            try container.encode(jpegBase64, forKey: .jpegBase64)
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
        case audioInSec, audioOutSec, estCostUsd, estCostInUsd, estCostOutUsd
        case reason, message
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
                    estCostUsd: try container.decode(Double.self, forKey: .estCostUsd),
                    // Leniently, because the split is only present for providers
                    // whose token counts the relay can price — and a usage frame
                    // that fails to decode takes the running total with it.
                    estCostInUsd: try container.decodeIfPresent(
                        Double.self, forKey: .estCostInUsd
                    ),
                    estCostOutUsd: try container.decodeIfPresent(
                        Double.self, forKey: .estCostOutUsd
                    )
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
