import Foundation
import JunoCodeCore
import JunoCodeRuntime
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// The provider a model id routes to through the backend agent proxy.
public enum CodeModelProvider: String, Sendable {
    case anthropic
    case openai
}

public enum CodeModelResolutionError: Error, Equatable, Sendable {
    case unsupportedModel(String)
}

/// Resolves a Juno model id to the provider path segment used by the existing
/// `/api/agent/<provider>/<path>` proxy. Juno Code defaults to Claude models,
/// which are fully wired; other providers fail closed until their request
/// shape is added.
public struct CodeModelProviderResolver: Sendable {
    private let resolve: @Sendable (String) -> CodeModelProvider?

    public init(_ resolve: @escaping @Sendable (String) -> CodeModelProvider?) {
        self.resolve = resolve
    }

    public func provider(for modelID: String) -> CodeModelProvider? {
        resolve(modelID)
    }

    /// Prefix-based default: `claude*`/`anthropic*` → Anthropic.
    public static let `default` = CodeModelProviderResolver { modelID in
        let lowered = modelID.lowercased()
        if lowered.hasPrefix("claude") || lowered.hasPrefix("anthropic") {
            return .anthropic
        }
        return nil
    }
}

/// `AgentModelClient` backed by the authenticated Juno backend agent proxy.
///
/// This is the single seam that turns a `ModelTurnRequest` into a real model
/// turn: it builds a provider-native Anthropic Messages request (with the tool
/// contracts), streams it through the existing refresh-aware bearer transport
/// to `/api/agent/anthropic/v1/messages`, and maps the native provider SSE onto
/// `ModelStreamEvent`. No provider key ever reaches the app, and no new auth or
/// backend route is introduced.
public struct BackendCodeModelClient: AgentModelClient {
    public static let defaultMaxTokens = 8_192

    private let streamer: any NativeAuthenticatedByteStreaming
    private let accountID: AccountID
    private let resolver: CodeModelProviderResolver
    private let maxTokens: Int

    public init(
        streamer: any NativeAuthenticatedByteStreaming,
        accountID: AccountID,
        resolver: CodeModelProviderResolver = .default,
        maxTokens: Int = BackendCodeModelClient.defaultMaxTokens
    ) {
        self.streamer = streamer
        self.accountID = accountID
        self.resolver = resolver
        self.maxTokens = maxTokens
    }

    public func streamTurn(
        _ request: ModelTurnRequest
    ) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let streamer = self.streamer
            let accountID = self.accountID
            let resolver = self.resolver
            let maxTokens = self.maxTokens
            let relay = Task {
                do {
                    guard let provider = resolver.provider(for: request.modelID) else {
                        throw AgentModelClientError.invalidResponse(
                            message: "Model \(request.modelID) is not available for Juno Code yet."
                        )
                    }
                    guard provider == .anthropic else {
                        throw AgentModelClientError.invalidResponse(
                            message: "\(provider.rawValue) models are not wired for Juno Code yet."
                        )
                    }
                    let body = AnthropicRequestBuilder.body(for: request, maxTokens: maxTokens)
                    let bearer = try NativeBearerRequest(
                        path: "/api/agent/anthropic/v1/messages",
                        method: .post,
                        headers: try HTTPHeaders([
                            "Accept": "text/event-stream",
                            "Content-Type": "application/json",
                            "anthropic-version": "2023-06-01",
                        ]),
                        body: try JSONEncoder().encode(body)
                    )
                    let response = try await streamer.stream(bearer, for: accountID)
                    guard (200...299).contains(response.statusCode) else {
                        throw AgentModelClientError.transport(
                            message: try await Self.errorMessage(from: response)
                        )
                    }
                    guard response.headers["content-type"]?.lowercased()
                        .hasPrefix("text/event-stream") == true
                    else {
                        throw AgentModelClientError.invalidResponse(
                            message: "The model transport did not return an event stream."
                        )
                    }

                    var decoder = AnthropicStreamDecoder()
                    var sawCompletion = false
                    for try await byte in response.bytes {
                        for payload in try decoder.consume(byte) {
                            for event in try decoder.events(from: payload) {
                                if case .turnCompleted = event { sawCompletion = true }
                                continuation.yield(event)
                            }
                        }
                    }
                    for payload in decoder.finish() {
                        for event in try decoder.events(from: payload) {
                            if case .turnCompleted = event { sawCompletion = true }
                            continuation.yield(event)
                        }
                    }
                    // A stream that ends without a terminal event is a dropped
                    // connection, never a completed turn: fail so the loop
                    // retries or ends cleanly instead of a false success.
                    guard sawCompletion else {
                        throw AgentModelClientError.transport(
                            message: "The model response ended before completing."
                        )
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in relay.cancel() }
        }
    }

    private static func errorMessage(from response: HTTPByteStreamResponse) async throws -> String {
        var data = Data()
        for try await byte in response.bytes {
            guard data.count < 32 * 1_024 else { break }
            data.append(byte)
        }
        if let envelope = try? JSONDecoder().decode(ProxyErrorWire.self, from: data),
           let message = envelope.error ?? envelope.message
        {
            return message
        }
        return "The model request failed (HTTP \(response.statusCode))."
    }
}

private struct ProxyErrorWire: Decodable {
    let error: String?
    let message: String?
}

// MARK: - Request building

enum AnthropicRequestBuilder {
    /// Builds the Anthropic Messages body from a turn request. Adjacent
    /// same-role blocks are merged so tool_use/tool_result land in the correct
    /// alternating messages.
    static func body(for request: ModelTurnRequest, maxTokens: Int) -> JSONValue {
        var messages: [JSONValue] = []
        var currentRole: String?
        var currentBlocks: [JSONValue] = []

        func flush() {
            if let role = currentRole, !currentBlocks.isEmpty {
                messages.append(.object(["role": .string(role), "content": .array(currentBlocks)]))
            }
            currentRole = nil
            currentBlocks = []
        }
        func append(role: String, block: JSONValue) {
            if currentRole != role { flush() }
            currentRole = role
            currentBlocks.append(block)
        }

        for message in request.messages {
            switch message {
            case let .user(text):
                append(role: "user", block: .object(["type": "text", "text": .string(text)]))
            case let .assistant(text):
                append(role: "assistant", block: .object(["type": "text", "text": .string(text)]))
            case let .toolCall(id, name, input):
                append(
                    role: "assistant",
                    block: .object([
                        "type": "tool_use",
                        "id": .string(id),
                        "name": .string(name),
                        "input": input,
                    ])
                )
            case let .toolResult(id, content, isError):
                append(
                    role: "user",
                    block: .object([
                        "type": "tool_result",
                        "tool_use_id": .string(id),
                        "content": .string(content),
                        "is_error": .bool(isError),
                    ])
                )
            }
        }
        flush()

        var object: [String: JSONValue] = [
            "model": .string(request.modelID),
            "max_tokens": .number(Double(maxTokens)),
            "system": .string(request.systemPrompt),
            "messages": .array(messages),
            "stream": .bool(true),
        ]
        let tools = request.tools.map { tool -> JSONValue in
            .object([
                "name": .string(tool.name),
                "description": .string(tool.description),
                "input_schema": tool.inputSchema,
            ])
        }
        if !tools.isEmpty {
            object["tools"] = .array(tools)
        }
        return .object(object)
    }
}

// MARK: - Streaming decode

/// Line-based SSE reader that surfaces the JSON payload of each `data:` event.
/// Anthropic includes a `type` field inside every data payload, so the event
/// name lines can be ignored.
struct AnthropicStreamDecoder {
    private static let maximumLineBytes = 6 * 1_024 * 1_024
    private static let maximumEventBytes = 6 * 1_024 * 1_024

    private var line = Data()
    private var dataLines: [Data] = []
    private var eventBytes = 0

    // Tool-call assembly, keyed by content block index.
    private var toolBlocks: [Int: ToolBlock] = [:]
    private var stopReason: ModelStopReason?

    private struct ToolBlock {
        let id: String
        let name: String
        var partialJSON: String
    }

    mutating func consume(_ byte: UInt8) throws -> [Data] {
        guard byte == 0x0A else {
            guard line.count < Self.maximumLineBytes else {
                throw AgentModelClientError.invalidResponse(message: "Event line too large.")
            }
            line.append(byte)
            return []
        }
        return try finishLine()
    }

    mutating func finish() -> [Data] {
        var payloads: [Data] = []
        if !line.isEmpty, let extra = try? finishLine() { payloads.append(contentsOf: extra) }
        if !dataLines.isEmpty { payloads.append(dispatch()) }
        return payloads
    }

    private mutating func finishLine() throws -> [Data] {
        if line.last == 0x0D { line.removeLast() }
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            return dataLines.isEmpty ? [] : [dispatch()]
        }
        if line.first == 0x3A { return [] } // comment line
        let separator = line.firstIndex(of: 0x3A)
        let field = separator.map { line[..<$0] } ?? line[...]
        guard field.elementsEqual(Data("data".utf8)) else { return [] }
        var value = separator.map { Data(line[line.index(after: $0)...]) } ?? Data()
        if value.first == 0x20 { value.removeFirst() }
        eventBytes += value.count
        guard eventBytes <= Self.maximumEventBytes else {
            throw AgentModelClientError.invalidResponse(message: "Event payload too large.")
        }
        dataLines.append(value)
        return []
    }

    private mutating func dispatch() -> Data {
        var payload = Data()
        for (index, value) in dataLines.enumerated() {
            if index > 0 { payload.append(0x0A) }
            payload.append(value)
        }
        dataLines.removeAll(keepingCapacity: true)
        eventBytes = 0
        return payload
    }

    /// Maps one Anthropic streaming payload to zero or more model events.
    mutating func events(from payload: Data) throws -> [ModelStreamEvent] {
        guard !payload.isEmpty else { return [] }
        let wire: StreamEventWire
        do {
            wire = try JSONDecoder().decode(StreamEventWire.self, from: payload)
        } catch {
            throw AgentModelClientError.invalidResponse(message: "Malformed model event.")
        }
        switch wire.type {
        case "message_start", "ping", "content_block_stop" where wire.index == nil:
            return []
        case "content_block_start":
            guard let index = wire.index, let block = wire.contentBlock else { return [] }
            if block.type == "tool_use", let id = block.id, let name = block.name {
                toolBlocks[index] = ToolBlock(id: id, name: name, partialJSON: "")
            }
            return []
        case "content_block_delta":
            guard let index = wire.index, let delta = wire.delta else { return [] }
            switch delta.type {
            case "text_delta":
                if let text = delta.text, !text.isEmpty {
                    return [.textDelta(text)]
                }
                return []
            case "thinking_delta":
                if let thinking = delta.thinking, !thinking.isEmpty {
                    return [.reasoningSummary(thinking)]
                }
                return []
            case "input_json_delta":
                if let fragment = delta.partialJSON {
                    toolBlocks[index]?.partialJSON += fragment
                }
                return []
            default:
                return []
            }
        case "content_block_stop":
            guard let index = wire.index, let block = toolBlocks.removeValue(forKey: index) else {
                return []
            }
            let input = Self.parseToolInput(block.partialJSON)
            return [.toolCallRequested(id: block.id, name: block.name, input: input)]
        case "message_delta":
            if let reason = wire.delta?.stopReason {
                stopReason = Self.mapStopReason(reason)
            }
            return []
        case "message_stop":
            return [.turnCompleted(stopReason ?? .endTurn)]
        case "error":
            let message = wire.error?.message ?? "The model returned an error."
            throw AgentModelClientError.transport(message: message)
        default:
            return []
        }
    }

    private static func parseToolInput(_ json: String) -> JSONValue {
        let trimmed = json.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .object([:]) }
        guard let data = trimmed.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data)
        else {
            return .object([:])
        }
        return value
    }

    private static func mapStopReason(_ reason: String) -> ModelStopReason {
        switch reason {
        case "tool_use": return .toolUse
        case "max_tokens": return .maxTokens
        default: return .endTurn
        }
    }
}

private struct StreamEventWire: Decodable {
    struct ContentBlock: Decodable {
        let type: String
        let id: String?
        let name: String?
    }
    struct Delta: Decodable {
        let type: String?
        let text: String?
        let thinking: String?
        let partialJSON: String?
        let stopReason: String?

        private enum CodingKeys: String, CodingKey {
            case type, text, thinking
            case partialJSON = "partial_json"
            case stopReason = "stop_reason"
        }
    }
    struct ErrorBody: Decodable {
        let type: String?
        let message: String?
    }

    let type: String
    let index: Int?
    let contentBlock: ContentBlock?
    let delta: Delta?
    let error: ErrorBody?

    private enum CodingKeys: String, CodingKey {
        case type, index, delta, error
        case contentBlock = "content_block"
    }
}
