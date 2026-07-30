import Foundation
import JunoCodeCore

/// An ephemeral image sent to a vision-capable model. Screenshot bytes are
/// deliberately stripped before conversation persistence.
public struct ModelImage: Hashable, Codable, Sendable {
    public enum Detail: String, Hashable, Codable, Sendable {
        case low
        case high
        case auto
    }

    public let mediaType: String
    public let data: Data
    public let detail: Detail

    public init(mediaType: String, data: Data, detail: Detail = .auto) {
        self.mediaType = mediaType
        self.data = data
        self.detail = detail
    }

    public var dataURL: String {
        "data:\(mediaType);base64,\(data.base64EncodedString())"
    }
}

/// One message in the model conversation. Persisted so an interrupted
/// session resumes with its exact context.
public enum ModelMessage: Hashable, Codable, Sendable {
    case user(String)
    /// A user turn carrying images the reader attached.
    ///
    /// A separate case rather than images on `.user` so every existing pattern
    /// match over a plain text turn keeps compiling and keeps meaning what it
    /// said. Like ``toolResultWithImages`` the bytes are ephemeral — see
    /// ``persistenceSafe``.
    case userWithImages(String, [ModelImage])
    case assistant(String)
    case toolCall(id: String, name: String, input: JSONValue)
    case toolResult(id: String, content: String, isError: Bool)
    /// Tool output with images for the immediately following model turn.
    /// ``CodeSessionStore`` persists only its redacted text counterpart.
    case toolResultWithImages(
        id: String,
        content: String,
        isError: Bool,
        images: [ModelImage]
    )

    /// The durable form of a message. Screen captures must never land in the
    /// session store, sync records, analytics, or crash diagnostics.
    public var persistenceSafe: ModelMessage {
        switch self {
        case let .userWithImages(text, images):
            // The reader's attachment is *not* retained.
            //
            // Same reasoning as a screen capture below, plus a practical one: the
            // conversation is persisted as JSON, and base64 image bytes in it grow
            // the session record without bound. What survives is the fact that
            // something was attached, so a resumed session neither silently drops
            // the reference nor pretends it still has the picture.
            let noun = images.count == 1 ? "image" : "images"
            return .user(
                text + "\n[\(images.count) attached \(noun) omitted from the session record.]"
            )
        case let .toolResultWithImages(id, content, isError, _):
            return .toolResult(
                id: id,
                content: content + "\n[Ephemeral image omitted; capture a fresh screenshot if needed.]",
                isError: isError
            )
        default:
            return self
        }
    }
}

public struct ModelToolDescriptor: Hashable, Codable, Sendable {
    public let name: String
    public let description: String
    public let inputSchema: JSONValue

    public init(name: String, description: String, inputSchema: JSONValue) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
    }
}

public struct ModelTurnRequest: Sendable {
    public let sessionID: CodeSessionID
    public let systemPrompt: String
    public let messages: [ModelMessage]
    public let tools: [ModelToolDescriptor]
    public let modelID: String
    /// The depth to ask for, or nil to send **no thinking parameter at all**.
    ///
    /// nil is not "use a default": several providers reject the parameter
    /// outright for models that do not reason or that always reason, so an
    /// omitted field is the only correct request for them.
    public let reasoningEffort: ReasoningEffort?

    public init(
        sessionID: CodeSessionID,
        systemPrompt: String,
        messages: [ModelMessage],
        tools: [ModelToolDescriptor],
        modelID: String,
        reasoningEffort: ReasoningEffort?
    ) {
        self.sessionID = sessionID
        self.systemPrompt = systemPrompt
        self.messages = messages
        self.tools = tools
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
    }
}

public enum ModelStopReason: Equatable, Sendable {
    /// The model finished its reply; no tools requested.
    case endTurn
    /// The model requested tool calls and is waiting for their results.
    case toolUse
    case maxTokens
}

public enum ModelStreamEvent: Sendable {
    case textDelta(String)
    /// Product-facing reasoning summary, never raw private reasoning.
    case reasoningSummary(String)
    case toolCallRequested(id: String, name: String, input: JSONValue)
    /// Token accounting for the turn, as the provider reported it.
    ///
    /// `inputTokens` is the whole prompt the provider actually billed — system
    /// prompt, tool schemas and the full conversation so far — so it *is* the
    /// session's current context size, not a delta to accumulate. That is what
    /// makes a context meter possible without Juno re-tokenizing anything itself.
    /// Either field is nil when the provider did not report it.
    case usage(inputTokens: Int?, outputTokens: Int?)
    case turnCompleted(ModelStopReason)
}

public enum AgentModelClientError: Error, Equatable, Sendable {
    case transport(message: String)
    case unauthorized
    case rateLimited
    case invalidResponse(message: String)
}

/// The transport that produces model turns. The production implementation
/// lives behind the Juno backend (composed at the app root through the
/// authenticated HTTP transport); tests use scripted clients. No provider
/// credential ever reaches this package.
public protocol AgentModelClient: Sendable {
    func streamTurn(
        _ request: ModelTurnRequest
    ) -> AsyncThrowingStream<ModelStreamEvent, Error>
}
