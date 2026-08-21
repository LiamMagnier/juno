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

    /// The provider this deployment can actually fund and operate. Voice is a
    /// separate realtime product from the selected text model, so silently
    /// mapping a Gemini chat to an unpaid Gemini Live credential only adds a
    /// 15-second timeout before the working Qwen session can begin.
    public static let productionDefault: Self = .qwen

    public var displayName: String {
        switch self {
        case .openai: "OpenAI"
        case .gemini: "Gemini"
        case .qwen: "Qwen"
        case .minimax: "MiniMax"
        }
    }

    /// Resolves the corresponding voice provider from any model identifier.
    public static func from(modelID: String) -> JunoVoiceProvider {
        let lower = modelID.lowercased()
        if lower.contains("openai") || lower.contains("gpt") {
            return .openai
        } else if lower.contains("qwen") || lower.contains("dashscope") || lower.contains("alibaba") {
            return .qwen
        } else if lower.contains("minimax") {
            return .minimax
        } else {
            return .gemini
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

/// One finalized turn of the chat that was already on screen, handed to the
/// relay when a call opens.
///
/// Without this a call started from an existing conversation begins with the
/// model knowing nothing about it — the reader says "so about that second
/// option" and is answered by something that has never heard of the first. The
/// relay seeds it into the provider's item history exactly once, on
/// `session.start`; a provider switch mid-call reuses the relay's own running
/// transcript instead, which is why ``JunoVoiceClientMessage/sessionSwitch(provider:)``
/// carries nothing.
public struct JunoVoiceHistoryEntry: Codable, Equatable, Sendable {
    public var role: JunoVoiceTranscriptRole
    public var text: String
    /// Bounded document context for a composed user turn. This is reference
    /// material for provider reseeding, never a replacement for the visible
    /// transcript text.
    public var context: String?

    public init(role: JunoVoiceTranscriptRole, text: String, context: String? = nil) {
        self.role = role
        self.text = text
        self.context = context
    }

    /// The relay's `sanitizeHistory` bounds, restated. Three numbers rather than
    /// one, because a chat can be long in either direction: many short turns, or
    /// one enormous pasted document.
    public static let maximumTurns = 20
    public static let maximumTurnCharacters = 2_000
    public static let maximumContextCharacters = 8_000
    public static let maximumTotalCharacters = 12_000

    /// Trims a chat to what may travel on `session.start`.
    ///
    /// The relay repeats every one of these checks at its trust boundary and
    /// truncates silently, so this is not a validation — it is what stops a long
    /// conversation from becoming a WebSocket frame large enough to be rejected
    /// by the transport before any of it is read.
    ///
    /// **Newest first, oldest dropped.** The budget is spent walking backwards
    /// from the most recent turn, because the turn the reader is about to talk
    /// about is the last one, not the first.
    public static func bounded(_ entries: [JunoVoiceHistoryEntry]) -> [JunoVoiceHistoryEntry] {
        var result: [JunoVoiceHistoryEntry] = []
        var remaining = maximumTotalCharacters

        for entry in entries.suffix(maximumTurns).reversed() {
            guard remaining > 0 else { break }
            let text = truncated(
                entry.text.trimmingCharacters(in: .whitespacesAndNewlines),
                to: min(maximumTurnCharacters, remaining)
            )
            guard !text.isEmpty else { continue }
            let contextBudget = max(0, min(maximumContextCharacters, remaining - text.utf16.count))
            let context = entry.context.map {
                truncated($0.trimmingCharacters(in: .whitespacesAndNewlines), to: contextBudget)
            }.flatMap { $0.isEmpty ? nil : $0 }
            result.insert(
                JunoVoiceHistoryEntry(role: entry.role, text: text, context: context),
                at: 0
            )
            remaining -= text.utf16.count + (context?.utf16.count ?? 0)
        }

        return result
    }

    /// Counted in UTF-16 units because that is what the relay's `String.slice`
    /// counts, but cut on a `Character` boundary — a limit landing in the middle
    /// of an emoji or a family sequence must shorten the text, never split it
    /// into replacement characters the model then has to read.
    private static func truncated(_ text: String, to limit: Int) -> String {
        guard text.utf16.count > limit else { return text }
        var result = ""
        var used = 0
        for character in text {
            let width = String(character).utf16.count
            guard used + width <= limit else { break }
            result.append(character)
            used += width
        }
        return result
    }
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
    /// Opens the session, optionally seeded with the chat already on screen.
    ///
    /// `history` defaults to empty so a call started from nowhere stays a bare
    /// `.sessionStart(provider:)`. Bound it with
    /// ``JunoVoiceHistoryEntry/bounded(_:)`` before it gets here: the relay
    /// truncates whatever it is given without saying so, and a frame built from
    /// an unbounded chat can be large enough for the transport to refuse before
    /// the relay ever parses it.
    case sessionStart(provider: JunoVoiceProvider, history: [JunoVoiceHistoryEntry] = [])
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
    case inputText(
        _ text: String,
        turnId: String? = nil,
        displayText: String? = nil,
        context: String? = nil,
        attachmentIDs: [String] = []
    )
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
        case type, provider, history, text, turnId, displayText, context, attachmentIds, jpegBase64
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .sessionStart(let provider, let history):
            try container.encode("session.start", forKey: .type)
            try container.encode(provider, forKey: .provider)
            // Optional on the wire, so a call with no chat behind it sends the
            // same two-key frame it always has — which is also the frame every
            // existing relay smoke test was written against.
            try container.encodeIfPresent(history.isEmpty ? nil : history, forKey: .history)
        case .sessionSwitch(let provider):
            try container.encode("session.switch", forKey: .type)
            try container.encode(provider, forKey: .provider)
        case .inputText(let text, let turnId, let displayText, let context, let attachmentIDs):
            try container.encode("input.text", forKey: .type)
            try container.encode(text, forKey: .text)
            // Encoded only when present: the relay reads `turnId` as "this turn
            // is already on screen", so a null one would suppress the echo that
            // the recognizer path depends on.
            try container.encodeIfPresent(turnId, forKey: .turnId)
            try container.encodeIfPresent(displayText, forKey: .displayText)
            try container.encodeIfPresent(context, forKey: .context)
            let boundedIDs = Array(
                attachmentIDs
                    .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                    .prefix(4)
            )
            try container.encodeIfPresent(
                boundedIDs.isEmpty ? nil : boundedIDs,
                forKey: .attachmentIds
            )
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
    /// One line of the conversation.
    ///
    /// `turnId` comes back only on the echo of a composed turn — the relay
    /// repeats whatever ``JunoVoiceClientMessage/inputText(_:turnId:displayText:)``
    /// sent it. It is the only thing tying the images a reader attached to the
    /// line they end up on, because the images travelled as anonymous
    /// `video.frame`s and the text arrived separately; without it a saved voice
    /// conversation cannot say which turn the pictures belonged to.
    case transcript(role: JunoVoiceTranscriptRole, text: String, final: Bool, turnId: String?)
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
        case type, provider, capabilities, role, text, final, turnId, speaker, phase
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
                final: try container.decode(Bool.self, forKey: .final),
                // Absent on every spoken line, which is most of them.
                turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
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
