import Foundation
import JunoCodeCore

/// One message in the model conversation. Persisted so an interrupted
/// session resumes with its exact context.
public enum ModelMessage: Hashable, Codable, Sendable {
    case user(String)
    case assistant(String)
    case toolCall(id: String, name: String, input: JSONValue)
    case toolResult(id: String, content: String, isError: Bool)
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
