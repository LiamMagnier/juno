import Foundation
import JunoCodeCore
import JunoCodeRuntime
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// The request protocol a provider model speaks through the backend agent
/// proxy. Every provider except Anthropic is OpenAI-compatible; a subset of
/// OpenAI's own coding/pro models use the Responses API instead of Chat
/// Completions.
public enum CodeModelWireProtocol: String, Sendable {
    case anthropicMessages
    case openAIChat
    case openAIResponses
}

/// The protocol family, retained as a compact presentation/testing surface.
public enum CodeModelProvider: String, Sendable {
    case anthropic
    case openai
}

public enum CodeModelResolutionError: Error, Equatable, Sendable {
    case unsupportedModel(String)
}

public struct CodeModelRoute: Equatable, Sendable {
    public let providerID: String
    public let providerModelID: String
    public let wireProtocol: CodeModelWireProtocol

    public init(
        providerID: String,
        providerModelID: String,
        wireProtocol: CodeModelWireProtocol
    ) {
        self.providerID = providerID
        self.providerModelID = providerModelID
        self.wireProtocol = wireProtocol
    }

    public var provider: CodeModelProvider {
        wireProtocol == .anthropicMessages ? .anthropic : .openai
    }
}

/// Resolves a canonical Juno id (`provider:provider-model`) to the provider
/// path and raw model id expected by `/api/agent`. Keeping this boundary
/// explicit prevents canonical ids such as `anthropic:claude-sonnet-5` from
/// leaking into provider-native request bodies.
public struct CodeModelProviderResolver: Sendable {
    private let resolve: @Sendable (String) -> CodeModelRoute?

    public init(_ resolve: @escaping @Sendable (String) -> CodeModelRoute?) {
        self.resolve = resolve
    }

    public func route(for modelID: String) -> CodeModelRoute? {
        resolve(modelID)
    }

    public func provider(for modelID: String) -> CodeModelProvider? {
        resolve(modelID)?.provider
    }

    /// The current website contract: Anthropic speaks Messages, OpenAI's
    /// Pro/Codex snapshots speak Responses, and every other configured lab
    /// speaks OpenAI-compatible Chat Completions.
    public static let `default` = CodeModelProviderResolver { modelID in
        let lowered = modelID.lowercased()
        if lowered.hasPrefix("claude") {
            return CodeModelRoute(
                providerID: "anthropic",
                providerModelID: modelID,
                wireProtocol: .anthropicMessages
            )
        }

        let separator: Character = lowered.contains(":") ? ":" : "/"
        let components = modelID.split(separator: separator, maxSplits: 1).map(String.init)
        guard components.count == 2 else { return nil }
        let providerID = components[0].lowercased()
        let providerModelID = components[1]
        guard providerID != "juno", !providerModelID.isEmpty else { return nil }

        if providerID == "anthropic" {
            return CodeModelRoute(
                providerID: providerID,
                providerModelID: providerModelID,
                wireProtocol: .anthropicMessages
            )
        }

        let openAICompatibleProviders: Set<String> = [
            "openai", "zhipu", "moonshot", "google", "meta", "deepseek",
            "mistral", "xai", "minimax", "mimo", "qwen", "longcat",
        ]
        guard openAICompatibleProviders.contains(providerID) else { return nil }

        let responseOnly = providerID == "openai"
            && (providerModelID.lowercased().contains("-codex")
                || providerModelID.lowercased().hasSuffix("-pro"))
        return CodeModelRoute(
            providerID: providerID,
            providerModelID: providerModelID,
            wireProtocol: responseOnly ? .openAIResponses : .openAIChat
        )
    }

    /// Models the website's agent proxy can serve. `juno:auto` is deliberately
    /// absent: Auto routes complete chat turns and cannot preserve an agent's
    /// tool-call protocol across iterations.
    public static func supports(_ modelID: String) -> Bool {
        Self.default.route(for: modelID) != nil
    }
}

/// `AgentModelClient` backed by the authenticated Juno backend agent proxy.
///
/// This is the single seam that turns a `ModelTurnRequest` into a real model
/// turn: it builds a provider-native Messages, Chat Completions, or Responses
/// request (with the same tool contracts), streams it through the existing
/// refresh-aware bearer transport, and maps provider SSE onto
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
                    guard let route = resolver.route(for: request.modelID) else {
                        throw AgentModelClientError.invalidResponse(
                            message: "Model \(request.modelID) cannot run the Juno Code tool protocol."
                        )
                    }

                    let bearer: NativeBearerRequest
                    switch route.wireProtocol {
                    case .anthropicMessages:
                        bearer = try NativeBearerRequest(
                            path: "/api/agent/\(route.providerID)/v1/messages",
                            method: .post,
                            headers: try HTTPHeaders([
                                "Accept": "text/event-stream",
                                "Content-Type": "application/json",
                                "anthropic-version": "2023-06-01",
                            ]),
                            body: try JSONEncoder().encode(
                                AnthropicRequestBuilder.body(
                                    for: request,
                                    providerModelID: route.providerModelID,
                                    maxTokens: maxTokens
                                )
                            )
                        )
                    case .openAIChat:
                        bearer = try NativeBearerRequest(
                            path: "/api/agent/\(route.providerID)/chat/completions",
                            method: .post,
                            headers: try HTTPHeaders([
                                "Accept": "text/event-stream",
                                "Content-Type": "application/json",
                            ]),
                            body: try JSONEncoder().encode(
                                OpenAIChatRequestBuilder.body(
                                    for: request,
                                    providerModelID: route.providerModelID,
                                    providerID: route.providerID,
                                    maxTokens: maxTokens
                                )
                            )
                        )
                    case .openAIResponses:
                        bearer = try NativeBearerRequest(
                            path: "/api/agent/openai/responses",
                            method: .post,
                            headers: try HTTPHeaders([
                                "Accept": "text/event-stream",
                                "Content-Type": "application/json",
                            ]),
                            body: try JSONEncoder().encode(
                                OpenAIResponsesRequestBuilder.body(
                                    for: request,
                                    providerModelID: route.providerModelID,
                                    maxTokens: maxTokens
                                )
                            )
                        )
                    }

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

                    var decoder = ProviderStreamDecoder(protocol: route.wireProtocol)
                    var sawCompletion = false
                    for try await byte in response.bytes {
                        for payload in try decoder.consume(byte) {
                            for event in try decoder.events(from: payload) {
                                if case .turnCompleted = event { sawCompletion = true }
                                continuation.yield(event)
                            }
                        }
                    }
                    for payload in try decoder.finish() {
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
    static func body(
        for request: ModelTurnRequest,
        providerModelID: String,
        maxTokens: Int
    ) -> JSONValue {
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
            case let .toolResultWithImages(id, content, isError, images):
                let resultContent: [JSONValue] = [
                    .object([
                        "type": .string("text"),
                        "text": .string(content),
                    ]),
                ] + images.map { image in
                    .object([
                        "type": .string("image"),
                        "source": .object([
                            "type": .string("base64"),
                            "media_type": .string(image.mediaType),
                            "data": .string(image.data.base64EncodedString()),
                        ]),
                    ])
                }
                append(
                    role: "user",
                    block: .object([
                        "type": .string("tool_result"),
                        "tool_use_id": .string(id),
                        "content": .array(resultContent),
                        "is_error": .bool(isError),
                    ])
                )
            }
        }
        flush()

        // Extended thinking, in whichever of Anthropic's two shapes this model
        // takes. `maxTokens` is the adjusted ceiling: thinking tokens come out
        // of the same budget as the answer, so leaving it at the caller's value
        // would buy depth by truncating the reply.
        let bits = CodeThinkingWire.anthropicBits(
            providerModelID: providerModelID,
            maxTokens: maxTokens,
            effort: request.reasoningEffort
        )
        var object: [String: JSONValue] = [
            "model": .string(providerModelID),
            "max_tokens": .number(Double(bits.maxTokens)),
            "system": .string(request.systemPrompt),
            "messages": .array(messages),
            "stream": .bool(true),
        ]
        if let thinking = bits.thinking {
            object["thinking"] = thinking
        }
        if let outputConfig = bits.outputConfig {
            object["output_config"] = outputConfig
        }
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

enum OpenAIChatRequestBuilder {
    static func body(
        for request: ModelTurnRequest,
        providerModelID: String,
        providerID: String,
        maxTokens: Int
    ) -> JSONValue {
        var messages: [JSONValue] = [
            .object([
                "role": .string("system"),
                "content": .string(request.systemPrompt),
            ]),
        ]

        for message in request.messages {
            switch message {
            case let .user(text):
                messages.append(.object([
                    "role": .string("user"),
                    "content": .string(text),
                ]))
            case let .assistant(text):
                messages.append(.object([
                    "role": .string("assistant"),
                    "content": .string(text),
                ]))
            case let .toolCall(id, name, input):
                messages.append(.object([
                    "role": .string("assistant"),
                    "content": .null,
                    "tool_calls": .array([
                        .object([
                            "id": .string(id),
                            "type": .string("function"),
                            "function": .object([
                                "name": .string(name),
                                "arguments": .string(jsonString(input)),
                            ]),
                        ]),
                    ]),
                ]))
            case let .toolResult(id, content, _):
                messages.append(.object([
                    "role": .string("tool"),
                    "tool_call_id": .string(id),
                    "content": .string(content),
                ]))
            case let .toolResultWithImages(id, content, _, images):
                messages.append(.object([
                    "role": .string("tool"),
                    "tool_call_id": .string(id),
                    "content": .string(content),
                ]))
                if !images.isEmpty {
                    messages.append(.object([
                        "role": .string("user"),
                        "content": .array(images.map { image in
                            .object([
                                "type": .string("image_url"),
                                "image_url": .object([
                                    "url": .string(image.dataURL),
                                    "detail": .string(image.detail.rawValue),
                                ]),
                            ])
                        }),
                    ]))
                }
            }
        }

        var object: [String: JSONValue] = [
            "model": .string(providerModelID),
            "messages": .array(messages),
            "stream": .bool(true),
            "stream_options": .object(["include_usage": .bool(true)]),
        ]
        if providerID == "openai" {
            object["max_completion_tokens"] = .number(Double(maxTokens))
        } else {
            object["max_tokens"] = .number(Double(maxTokens))
        }
        // Each OpenAI-compatible lab has its own thinking dialect, and several
        // have none at all. Nothing is sent for those rather than a guess.
        for (key, value) in CodeThinkingWire.chatParameters(
            providerID: providerID,
            providerModelID: providerModelID,
            effort: request.reasoningEffort
        ) {
            object[key] = value
        }
        if !request.tools.isEmpty {
            object["tools"] = .array(request.tools.map { tool in
                .object([
                    "type": .string("function"),
                    "function": .object([
                        "name": .string(tool.name),
                        "description": .string(tool.description),
                        "parameters": tool.inputSchema,
                    ]),
                ])
            })
        }
        return .object(object)
    }
}

enum OpenAIResponsesRequestBuilder {
    static func body(
        for request: ModelTurnRequest,
        providerModelID: String,
        maxTokens: Int
    ) -> JSONValue {
        var input: [JSONValue] = []
        for message in request.messages {
            switch message {
            case let .user(text):
                input.append(.object([
                    "role": .string("user"),
                    "content": .array([
                        .object(["type": .string("input_text"), "text": .string(text)]),
                    ]),
                ]))
            case let .assistant(text):
                input.append(.object([
                    "role": .string("assistant"),
                    "content": .array([
                        .object(["type": .string("output_text"), "text": .string(text)]),
                    ]),
                ]))
            case let .toolCall(id, name, arguments):
                input.append(.object([
                    "type": .string("function_call"),
                    "call_id": .string(id),
                    "name": .string(name),
                    "arguments": .string(jsonString(arguments)),
                ]))
            case let .toolResult(id, content, _):
                input.append(.object([
                    "type": .string("function_call_output"),
                    "call_id": .string(id),
                    "output": .string(content),
                ]))
            case let .toolResultWithImages(id, content, _, images):
                input.append(.object([
                    "type": .string("function_call_output"),
                    "call_id": .string(id),
                    "output": .string(content),
                ]))
                if !images.isEmpty {
                    input.append(.object([
                        "role": .string("user"),
                        "content": .array(images.map { image in
                            .object([
                                "type": .string("input_image"),
                                "image_url": .string(image.dataURL),
                                "detail": .string(image.detail.rawValue),
                            ])
                        }),
                    ]))
                }
            }
        }

        var object: [String: JSONValue] = [
            "model": .string(providerModelID),
            "instructions": .string(request.systemPrompt),
            "input": .array(input),
            "stream": .bool(true),
            "store": .bool(false),
            "max_output_tokens": .number(Double(maxTokens)),
        ]
        // Omitted entirely for a model that publishes no depths, rather than sent
        // with a default the model may reject.
        if let effort = CodeThinkingWire.responsesEffort(
            providerModelID: providerModelID,
            effort: request.reasoningEffort
        ) {
            object["reasoning"] = .object([
                "effort": .string(effort),
                "summary": .string("detailed"),
            ])
        }
        if !request.tools.isEmpty {
            object["tools"] = .array(request.tools.map { tool in
                .object([
                    "type": .string("function"),
                    "name": .string(tool.name),
                    "description": .string(tool.description),
                    "parameters": tool.inputSchema,
                    "strict": .bool(false),
                ])
            })
        }
        return .object(object)
    }
}

private func jsonString(_ value: JSONValue) -> String {
    guard let data = try? JSONEncoder().encode(value),
          let string = String(data: data, encoding: .utf8)
    else { return "{}" }
    return string
}

// MARK: - Streaming decode

private struct ProviderStreamDecoder {
    private enum Storage {
        case anthropic(AnthropicStreamDecoder)
        case chat(OpenAIChatStreamDecoder)
        case responses(OpenAIResponsesStreamDecoder)
    }

    private var storage: Storage

    init(protocol wireProtocol: CodeModelWireProtocol) {
        switch wireProtocol {
        case .anthropicMessages:
            storage = .anthropic(AnthropicStreamDecoder())
        case .openAIChat:
            storage = .chat(OpenAIChatStreamDecoder())
        case .openAIResponses:
            storage = .responses(OpenAIResponsesStreamDecoder())
        }
    }

    mutating func consume(_ byte: UInt8) throws -> [Data] {
        switch storage {
        case .anthropic(var decoder):
            let payloads = try decoder.consume(byte)
            storage = .anthropic(decoder)
            return payloads
        case .chat(var decoder):
            let payloads = try decoder.consume(byte)
            storage = .chat(decoder)
            return payloads
        case .responses(var decoder):
            let payloads = try decoder.consume(byte)
            storage = .responses(decoder)
            return payloads
        }
    }

    mutating func finish() throws -> [Data] {
        switch storage {
        case .anthropic(var decoder):
            let payloads = decoder.finish()
            storage = .anthropic(decoder)
            return payloads
        case .chat(var decoder):
            let payloads = try decoder.finish()
            storage = .chat(decoder)
            return payloads
        case .responses(var decoder):
            let payloads = try decoder.finish()
            storage = .responses(decoder)
            return payloads
        }
    }

    mutating func events(from payload: Data) throws -> [ModelStreamEvent] {
        switch storage {
        case .anthropic(var decoder):
            let events = try decoder.events(from: payload)
            storage = .anthropic(decoder)
            return events
        case .chat(var decoder):
            let events = try decoder.events(from: payload)
            storage = .chat(decoder)
            return events
        case .responses(var decoder):
            let events = try decoder.events(from: payload)
            storage = .responses(decoder)
            return events
        }
    }
}

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
        case "message_start":
            // The prompt size, once, at the top of the turn. This is the whole
            // billed prompt — system, tools and the conversation so far — which is
            // exactly the number a context meter wants.
            guard let usage = wire.message?.usage else { return [] }
            return [.usage(inputTokens: usage.inputTokens, outputTokens: usage.outputTokens)]
        case "ping":
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
            guard let usage = wire.usage else { return [] }
            return [.usage(inputTokens: usage.inputTokens, outputTokens: usage.outputTokens)]
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
    /// Anthropic reports the prompt size once, on `message_start`, and the
    /// completion size on `message_delta`.
    struct Usage: Decodable {
        let inputTokens: Int?
        let outputTokens: Int?

        private enum CodingKeys: String, CodingKey {
            case inputTokens = "input_tokens"
            case outputTokens = "output_tokens"
        }
    }
    struct Message: Decodable {
        let usage: Usage?
    }

    let type: String
    let index: Int?
    let contentBlock: ContentBlock?
    let delta: Delta?
    let error: ErrorBody?
    let usage: Usage?
    let message: Message?

    private enum CodingKeys: String, CodingKey {
        case type, index, delta, error, usage, message
        case contentBlock = "content_block"
    }
}

/// Shared bounded SSE framing for the two OpenAI-compatible protocols.
private struct RawSSEDecoder {
    private static let maximumLineBytes = 6 * 1_024 * 1_024
    private static let maximumEventBytes = 6 * 1_024 * 1_024

    private var line = Data()
    private var dataLines: [Data] = []
    private var eventBytes = 0

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

    mutating func finish() throws -> [Data] {
        var payloads: [Data] = []
        if !line.isEmpty {
            payloads.append(contentsOf: try finishLine())
        }
        if !dataLines.isEmpty {
            payloads.append(dispatch())
        }
        return payloads
    }

    private mutating func finishLine() throws -> [Data] {
        if line.last == 0x0D { line.removeLast() }
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            return dataLines.isEmpty ? [] : [dispatch()]
        }
        if line.first == 0x3A { return [] }
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
}

/// Internal rather than private so the decode of the usage-only chunk can be
/// tested directly; `AnthropicStreamDecoder` alongside it is internal already.
struct OpenAIChatStreamDecoder {
    private struct ToolBlock {
        var id = ""
        var name = ""
        var arguments = ""
    }

    private var sse = RawSSEDecoder()
    private var toolBlocks: [Int: ToolBlock] = [:]
    private var completed = false

    mutating func consume(_ byte: UInt8) throws -> [Data] {
        try sse.consume(byte)
    }

    mutating func finish() throws -> [Data] {
        try sse.finish()
    }

    mutating func events(from payload: Data) throws -> [ModelStreamEvent] {
        guard !payload.isEmpty, payload != Data("[DONE]".utf8) else { return [] }
        let root = try decodeObject(payload)
        if let error = root["error"]?["message"]?.stringValue {
            throw AgentModelClientError.transport(message: error)
        }
        // Read usage *before* the choices guard.
        //
        // `stream_options.include_usage` makes the provider send a final chunk whose
        // `choices` array is empty and whose only payload is `usage`. Guarding on a
        // first choice therefore dropped the one chunk that carries the token
        // accounting, on every OpenAI-compatible provider.
        var events: [ModelStreamEvent] = []
        if let usage = root["usage"], !usage.isNull {
            events.append(.usage(
                inputTokens: usage["prompt_tokens"]?.intValue,
                outputTokens: usage["completion_tokens"]?.intValue
            ))
        }
        guard let choice = root["choices"]?.arrayValue?.first else { return events }
        if let delta = choice["delta"] {
            if let text = delta["content"]?.stringValue, !text.isEmpty {
                events.append(.textDelta(text))
            }
            if let reasoning = delta["reasoning_content"]?.stringValue,
               !reasoning.isEmpty
            {
                events.append(.reasoningSummary(reasoning))
            }
            for call in delta["tool_calls"]?.arrayValue ?? [] {
                guard let index = call["index"]?.intValue else { continue }
                var block = toolBlocks[index] ?? ToolBlock()
                if let id = call["id"]?.stringValue { block.id = id }
                if let name = call["function"]?["name"]?.stringValue {
                    block.name = name
                }
                if let arguments = call["function"]?["arguments"]?.stringValue {
                    block.arguments += arguments
                }
                toolBlocks[index] = block
            }
        }
        if let finishReason = choice["finish_reason"]?.stringValue, !completed {
            completed = true
            for (_, block) in toolBlocks.sorted(by: { $0.key < $1.key })
                where !block.id.isEmpty && !block.name.isEmpty
            {
                events.append(.toolCallRequested(
                    id: block.id,
                    name: block.name,
                    input: parseToolInput(block.arguments)
                ))
            }
            let reason: ModelStopReason
            switch finishReason {
            case "tool_calls": reason = .toolUse
            case "length": reason = .maxTokens
            default: reason = .endTurn
            }
            events.append(.turnCompleted(reason))
        }
        return events
    }
}

private struct OpenAIResponsesStreamDecoder {
    private var sse = RawSSEDecoder()
    private var sawToolCall = false
    private var completed = false

    mutating func consume(_ byte: UInt8) throws -> [Data] {
        try sse.consume(byte)
    }

    mutating func finish() throws -> [Data] {
        try sse.finish()
    }

    mutating func events(from payload: Data) throws -> [ModelStreamEvent] {
        guard !payload.isEmpty, payload != Data("[DONE]".utf8) else { return [] }
        let root = try decodeObject(payload)
        guard let type = root["type"]?.stringValue else {
            throw AgentModelClientError.invalidResponse(
                message: "Malformed Responses API event."
            )
        }
        switch type {
        case "response.output_text.delta":
            guard let text = root["delta"]?.stringValue, !text.isEmpty else { return [] }
            return [.textDelta(text)]
        case "response.reasoning_summary_text.delta":
            guard let text = root["delta"]?.stringValue, !text.isEmpty else { return [] }
            return [.reasoningSummary(text)]
        case "response.output_item.done":
            guard let item = root["item"],
                  item["type"]?.stringValue == "function_call",
                  let id = item["call_id"]?.stringValue,
                  let name = item["name"]?.stringValue
            else { return [] }
            sawToolCall = true
            return [.toolCallRequested(
                id: id,
                name: name,
                input: parseToolInput(item["arguments"]?.stringValue ?? "{}")
            )]
        case "response.completed":
            guard !completed else { return [] }
            completed = true
            var events: [ModelStreamEvent] = []
            // The Responses API reports the turn's accounting on the completed
            // envelope rather than as its own chunk.
            if let usage = root["response"]?["usage"], !usage.isNull {
                events.append(.usage(
                    inputTokens: usage["input_tokens"]?.intValue,
                    outputTokens: usage["output_tokens"]?.intValue
                ))
            }
            events.append(.turnCompleted(sawToolCall ? .toolUse : .endTurn))
            return events
        case "response.incomplete":
            guard !completed else { return [] }
            completed = true
            let reason = root["response"]?["incomplete_details"]?["reason"]?.stringValue
            return [.turnCompleted(reason == "max_output_tokens" ? .maxTokens : .endTurn)]
        case "response.failed":
            let message = root["response"]?["error"]?["message"]?.stringValue
                ?? "The Responses API run failed."
            throw AgentModelClientError.transport(message: message)
        case "error":
            let message = root["message"]?.stringValue
                ?? root["error"]?["message"]?.stringValue
                ?? "The Responses API stream failed."
            throw AgentModelClientError.transport(message: message)
        default:
            return []
        }
    }
}

private func decodeObject(_ payload: Data) throws -> JSONValue {
    do {
        return try JSONDecoder().decode(JSONValue.self, from: payload)
    } catch {
        throw AgentModelClientError.invalidResponse(message: "Malformed model event.")
    }
}

private func parseToolInput(_ json: String) -> JSONValue {
    let trimmed = json.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty,
          let data = trimmed.data(using: .utf8),
          let value = try? JSONDecoder().decode(JSONValue.self, from: data)
    else { return .object([:]) }
    return value
}
