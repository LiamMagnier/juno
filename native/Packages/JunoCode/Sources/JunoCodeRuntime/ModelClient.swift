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
    public let reasoningEffort: ReasoningEffort

    public init(
        sessionID: CodeSessionID,
        systemPrompt: String,
        messages: [ModelMessage],
        tools: [ModelToolDescriptor],
        modelID: String,
        reasoningEffort: ReasoningEffort
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
