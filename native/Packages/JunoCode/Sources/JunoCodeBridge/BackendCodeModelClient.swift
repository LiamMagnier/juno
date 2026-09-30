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
        let trimmed = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowered = trimmed.lowercased()

        // Short aliases and tier names that subagents or callers might supply
        if lowered == "max" {
            return CodeModelRoute(
                providerID: "qwen",
                providerModelID: "qwen3.8-max",
                wireProtocol: .openAIChat
            )
        }
        if lowered == "pro" {
            return CodeModelRoute(
                providerID: "anthropic",
                providerModelID: "claude-sonnet-5",
                wireProtocol: .anthropicMessages
            )
        }
        if lowered == "flash" || lowered == "fast" {
            return CodeModelRoute(
                providerID: "google",
                providerModelID: "gemini-3.8-flash",
                wireProtocol: .openAIChat
            )
        }
        if lowered == "haiku" {
            return CodeModelRoute(
                providerID: "anthropic",
                providerModelID: "claude-haiku-4-5",
                wireProtocol: .anthropicMessages
            )
        }
        if lowered == "sonnet" {
            return CodeModelRoute(
                providerID: "anthropic",
                providerModelID: "claude-sonnet-5",
                wireProtocol: .anthropicMessages
            )
        }
        if lowered == "opus" {
            return CodeModelRoute(
                providerID: "anthropic",
                providerModelID: "claude-opus-5-5",
                wireProtocol: .anthropicMessages
            )
        }
        if lowered.hasPrefix("claude") {
            return CodeModelRoute(
                providerID: "anthropic",
                providerModelID: trimmed,
                wireProtocol: .anthropicMessages
            )
        }

        let separator: Character = lowered.contains(":") ? ":" : "/"
        let components = trimmed.split(separator: separator, maxSplits: 1).map(String.init)
        if components.count == 2 {
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
            if openAICompatibleProviders.contains(providerID) {
                let responseOnly = providerID == "openai"
                    && (providerModelID.lowercased().contains("-codex")
                        || providerModelID.lowercased().hasSuffix("-pro"))
                return CodeModelRoute(
                    providerID: providerID,
                    providerModelID: providerModelID,
                    wireProtocol: responseOnly ? .openAIResponses : .openAIChat
                )
            }
        }

        return nil
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
    /// Keep the client ceiling aligned with the largest supported backend
    /// output window. Providers still apply their own model-specific caps in
    /// `CodeThinkingWire`; this removes the old, app-imposed 8k truncation.
    public static let defaultMaxTokens = 128_000

    /// Provider streams are long-lived, but they must never be unbounded. A
    /// connection that never completes would otherwise leave the session in a
    /// running state forever and keep the model picker/composer attached to a
    /// dead turn. These values are deliberately generous for large code tasks;
    /// the idle limit only trips when no byte arrives at all.
    public struct Timeouts: Equatable, Sendable {
        public let connectionSeconds: TimeInterval
        public let idleSeconds: TimeInterval
        public let overallSeconds: TimeInterval

        public init(
            connectionSeconds: TimeInterval = 30,
            idleSeconds: TimeInterval = 90,
            overallSeconds: TimeInterval = 15 * 60
        ) {
            self.connectionSeconds = connectionSeconds
            self.idleSeconds = idleSeconds
            self.overallSeconds = overallSeconds
        }

        public static let production = Timeouts()
    }

    private let streamer: any NativeAuthenticatedByteStreaming
    private let accountID: AccountID
    private let resolver: CodeModelProviderResolver
    private let maxTokens: Int
    private let timeouts: Timeouts

    public init(
        streamer: any NativeAuthenticatedByteStreaming,
        accountID: AccountID,
        resolver: CodeModelProviderResolver = .default,
        maxTokens: Int = BackendCodeModelClient.defaultMaxTokens,
        timeouts: Timeouts = .production
    ) {
        self.streamer = streamer
        self.accountID = accountID
        self.resolver = resolver
        self.maxTokens = maxTokens
        self.timeouts = timeouts
    }

    /// Anthropic reads the prefix up to the breakpoints this client marks;
    /// OpenAI caches any long prefix on its own. The other labs' caching, where
    /// they have any, is not something Juno can count on.
    public func cachesPromptPrefix(for modelID: String) -> Bool {
        guard let route = resolver.route(for: modelID) else { return false }
        return route.wireProtocol == .anthropicMessages || route.providerID == "openai"
    }

    public func streamTurn(
        _ request: ModelTurnRequest
    ) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let streamer = self.streamer
            let accountID = self.accountID
            let resolver = self.resolver
            // A request may ask for less than the client allows, never more.
            let maxTokens = request.maximumOutputTokens.map { max(1, min($0, self.maxTokens)) }
                ?? self.maxTokens
            let timeouts = self.timeouts
            let relay = Task {
                do {
                    guard let route = resolver.route(for: request.modelID) else {
                        throw AgentModelClientError.unavailable(
                            message: "Model \(request.modelID) cannot run the Juno Code tool protocol."
                        )
                    }

                    let bearer: NativeBearerRequest
                    switch route.wireProtocol {
                    case .anthropicMessages:
                        let body = AnthropicRequestBuilder.body(
                            for: request,
                            providerModelID: route.providerModelID,
                            maxTokens: maxTokens
                        )
                        var headers = [
                            "Accept": "text/event-stream",
                            "Content-Type": "application/json",
                            "anthropic-version": "2023-06-01",
                        ]
                        // The proxy forwards this header to Anthropic as is.
                        let betas = AnthropicRequestBuilder.betas(for: body)
                        if !betas.isEmpty {
                            headers["anthropic-beta"] = betas.joined(separator: ",")
                        }
                        bearer = try NativeBearerRequest(
                            path: "/api/agent/\(route.providerID)/v1/messages",
                            method: .post,
                            headers: try HTTPHeaders(headers),
                            body: try JSONEncoder().encode(body)
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

                    let response = try await Self.withTimeout(
                        seconds: timeouts.connectionSeconds,
                        message: "The model connection timed out."
                    ) {
                        try await streamer.stream(bearer, for: accountID)
                    }
                    guard (200...299).contains(response.statusCode) else {
                        throw Self.classify(
                            status: response.statusCode,
                            headers: response.headers,
                            failure: try await Self.errorBody(from: response)
                        )
                    }
                    guard response.headers["content-type"]?.lowercased()
                        .hasPrefix("text/event-stream") == true
                    else {
                        throw AgentModelClientError.invalidResponse(
                            message: "The model transport did not return an event stream."
                        )
                    }

                    try await Self.withTimeout(
                        seconds: timeouts.overallSeconds,
                        message: "The model turn exceeded its time limit."
                    ) {
                        try await Self.consume(
                            response: response,
                            protocol: route.wireProtocol,
                            idleSeconds: timeouts.idleSeconds,
                            continuation: continuation
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

    /// Races one asynchronous operation against a cancellable deadline. The
    /// child task is cancelled when the operation wins, and the operation is
    /// cancelled when the deadline wins; this matters for URLSession-backed
    /// streams because leaving the losing task alive would leak its socket.
    private static func withTimeout<T: Sendable>(
        seconds: TimeInterval,
        message: String,
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        guard seconds > 0 else { return try await operation() }
        return try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(for: .seconds(seconds))
                throw AgentModelClientError.transport(message: message)
            }
            defer { group.cancelAll() }
            guard let value = try await group.next() else {
                throw AgentModelClientError.transport(message: message)
            }
            return value
        }
    }

    /// Decodes and forwards the stream while a second child watches for a
    /// provider that has gone quiet. Keeping the event forwarding inside the
    /// winning child preserves token-by-token UI updates instead of buffering a
    /// whole turn just to make the timeout race possible.
    private static func consume(
        response: HTTPByteStreamResponse,
        protocol wireProtocol: CodeModelWireProtocol,
        idleSeconds: TimeInterval,
        continuation: AsyncThrowingStream<ModelStreamEvent, Error>.Continuation
    ) async throws {
        let activity = StreamActivity()
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                var decoder = ProviderStreamDecoder(protocol: wireProtocol)
                var sawCompletion = false
                for try await byte in response.bytes {
                    await activity.touch()
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
                // connection, never a completed turn: fail so the loop retries
                // or ends cleanly instead of a false success.
                guard sawCompletion else {
                    throw AgentModelClientError.transport(
                        message: "The model response ended before completing."
                    )
                }
            }
            if idleSeconds > 0 {
                group.addTask {
                    while true {
                        try await Task.sleep(for: .seconds(idleSeconds))
                        if await activity.isIdle(for: idleSeconds) {
                            throw AgentModelClientError.transport(
                                message: "The model stream became idle."
                            )
                        }
                    }
                }
            }
            defer { group.cancelAll() }
            _ = try await group.next()
        }
    }

    private actor StreamActivity {
        private var lastByteAt = Date()

        func touch() { lastByteAt = Date() }

        func isIdle(for seconds: TimeInterval) -> Bool {
            Date().timeIntervalSince(lastByteAt) >= seconds
        }
    }

    /// What a failed response said, and the machine-readable `code` beside
    /// it when there was one.
    struct ErrorBody: Equatable {
        let message: String
        /// The Juno proxy's own code, at the top level.
        let code: String?
        /// The provider's error type or code: Anthropic's `error.type`
        /// (`overloaded_error`), OpenAI's `error.code`
        /// (`context_length_exceeded`).
        let providerType: String?

        init(message: String, code: String?, providerType: String? = nil) {
            self.message = message
            self.code = code
            self.providerType = providerType
        }
    }

    static func errorBody(from response: HTTPByteStreamResponse) async throws -> ErrorBody {
        var data = Data()
        for try await byte in response.bytes {
            guard data.count < 32 * 1_024 else { break }
            data.append(byte)
        }
        if let json = try? JSONDecoder().decode(JSONValue.self, from: data) {
            let object = json.objectValue ?? json.arrayValue?.first?.objectValue
            if let object,
               let error = object["error"]?["message"]?.stringValue
                ?? object["error"]?.stringValue
                ?? object["message"]?.stringValue
            {
                return ErrorBody(
                    message: error,
                    code: object["code"]?.stringValue,
                    providerType: object["error"]?["type"]?.stringValue
                        ?? object["error"]?["code"]?.stringValue
                )
            }
        }
        if let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            return ErrorBody(message: text, code: nil)
        }
        return ErrorBody(message: "The model request failed (HTTP \(response.statusCode)).", code: nil)
    }

    /// A failed response as the error the agent loop acts on.
    ///
    /// The status decides first, then the provider's own type, then its
    /// words — the same order the cloud runner settled on
    /// (`runner/agent-core/src/providers/errors.ts`): labs disagree on the
    /// status for "out of credit" and for "too long", but not on what they
    /// call it.
    static func classify(status: Int, headers: HTTPHeaders, failure: ErrorBody) -> AgentModelClientError {
        let message = failure.message
        let lowerMessage = message.lowercased()
        let type = failure.providerType?.lowercased() ?? ""
        let retryAfter = retryAfterSeconds(headers)
        if status == 401 || status == 403 {
            return .unauthorized
        }
        if status == 402, failure.code == "QUOTA_EXCEEDED" {
            // The Juno proxy's budget and usage-window wall, which it marks
            // with this code. The proxy passes a provider's own status through
            // unchanged, so a bare 402 is the provider's billing (DeepSeek's
            // "Insufficient Balance"), which another model can still serve.
            return .planLimitReached(message: message)
        }
        if status == 402
            || lowerMessage.contains("quota")
            || lowerMessage.contains("insufficient balance")
            || lowerMessage.contains("credit balance is too low")
        {
            return .quotaExhausted(message: message)
        }
        if status == 413 || isContextOverflow(type: type, message: lowerMessage) {
            return .contextWindowExceeded(message: message)
        }
        if status == 429 || type == "rate_limit_error" || lowerMessage.contains("rate limit") {
            return .rateLimited(retryAfter: retryAfter)
        }
        if status == 529 || status == 503 || type == "overloaded_error" || lowerMessage.contains("overloaded") {
            return .overloaded(retryAfter: retryAfter)
        }
        return .transport(message: message)
    }

    /// "Too long for the window", in the words each lab uses: Anthropic's
    /// "prompt is too long", OpenAI's `context_length_exceeded` and "maximum
    /// context length", and the compatible labs' variations on both.
    static func isContextOverflow(type: String, message: String) -> Bool {
        type == "context_length_exceeded"
            || type == "request_too_large"
            || message.contains("prompt is too long")
            || message.contains("maximum context length")
            || message.contains("context_length_exceeded")
            || message.contains("context window")
            || message.contains("too many tokens")
            || message.contains("input is too long")
    }

    /// How long the provider asked to be left alone: OpenAI's exact
    /// `retry-after-ms` when present, else the standard `retry-after` in
    /// seconds or as an HTTP date. The loop decides what it will honour.
    static func retryAfterSeconds(_ headers: HTTPHeaders, now: Date = Date()) -> TimeInterval? {
        if let raw = headers["retry-after-ms"], let milliseconds = Double(raw.trimmingCharacters(in: .whitespaces)),
           milliseconds.isFinite, milliseconds >= 0
        {
            return milliseconds / 1_000
        }
        guard let raw = headers["retry-after"]?.trimmingCharacters(in: .whitespaces) else { return nil }
        if let seconds = Double(raw), seconds.isFinite, seconds >= 0 {
            return seconds
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: raw) else { return nil }
        return max(0, date.timeIntervalSince(now))
    }

    /// An error a provider reported inside an event stream, where there is no
    /// status to go by.
    static func streamError(type: String?, message: String) -> AgentModelClientError {
        let lowerType = type?.lowercased() ?? ""
        let lowerMessage = message.lowercased()
        if lowerType == "overloaded_error" || lowerMessage.contains("overloaded") {
            return .overloaded(retryAfter: nil)
        }
        if lowerType == "rate_limit_error" || lowerMessage.contains("rate limit") {
            return .rateLimited(retryAfter: nil)
        }
        if isContextOverflow(type: lowerType, message: lowerMessage) {
            return .contextWindowExceeded(message: message)
        }
        return .transport(message: message)
    }
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
            case let .userWithImages(text, images):
                // Images first, then the text: Anthropic's own guidance is that a
                // question placed after the picture it is about answers better.
                for image in images {
                    append(
                        role: "user",
                        block: .object([
                            "type": "image",
                            "source": .object([
                                "type": .string("base64"),
                                "media_type": .string(image.mediaType),
                                "data": .string(image.data.base64EncodedString()),
                            ]),
                        ])
                    )
                }
                if !text.isEmpty {
                    append(
                        role: "user",
                        block: .object(["type": "text", "text": .string(text)])
                    )
                }
            case let .assistant(text):
                // An empty text block is a 400; a turn that was only reasoning
                // and tool calls has nothing to say here.
                guard !text.isEmpty else { continue }
                append(role: "assistant", block: .object(["type": "text", "text": .string(text)]))
            case let .assistantThinking(text, signature):
                append(
                    role: "assistant",
                    block: .object([
                        "type": "thinking",
                        "thinking": .string(text),
                        "signature": .string(signature),
                    ])
                )
            case let .assistantRedactedThinking(data):
                append(
                    role: "assistant",
                    block: .object(["type": "redacted_thinking", "data": .string(data)])
                )
            case let .toolCall(id, name, input), let .toolCallWithExtra(id, name, input, _):
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
        // Prompt caching. An agent loop resends the same prefix — tool schemas,
        // system prompt, every earlier turn — on each of its dozens of
        // requests, so without breakpoints every step is billed and processed
        // from token zero. All four allowed breakpoints:
        //
        // 1. the last tool: schemas change only when the tool set does;
        // 2. the system prompt: fixed for the session, since everything that
        //    changes during one rides in `<session_state>` blocks instead;
        // 3. the newest block of the conversation: each request writes the
        //    prefix the next one reads, which is the incremental pattern
        //    Anthropic documents for multi-turn tool use;
        // 4. the previous request's newest block, the end of the user turn
        //    before the latest reply. A breakpoint finds an earlier write only
        //    within about twenty blocks of itself, and a step with ten parallel
        //    calls adds more than that between (3) and the last write; this
        //    one lands exactly on it.
        //
        // Below the model's minimum cacheable length a breakpoint is a no-op,
        // so short sessions pay nothing for it.
        let ephemeral: JSONValue = .object(["type": .string("ephemeral")])
        Self.markLastCacheableBlock(in: &messages, with: ephemeral)
        Self.markPreviousTail(in: &messages, with: ephemeral)
        var object: [String: JSONValue] = [
            "model": .string(providerModelID),
            "max_tokens": .number(Double(bits.maxTokens)),
            "system": .array([
                .object([
                    "type": .string("text"),
                    "text": .string(request.systemPrompt),
                    "cache_control": ephemeral,
                ]),
            ]),
            "messages": .array(messages),
            "stream": .bool(true),
        ]
        if let thinking = Self.bindingTolerant(bits.thinking, providerModelID: providerModelID) {
            object["thinking"] = thinking
        }
        if let outputConfig = bits.outputConfig {
            object["output_config"] = outputConfig
        }
        var tools = request.tools.map { tool -> [String: JSONValue] in
            [
                "name": .string(tool.name),
                "description": .string(tool.description),
                "input_schema": tool.inputSchema,
            ]
        }
        if !tools.isEmpty {
            tools[tools.count - 1]["cache_control"] = ephemeral
            object["tools"] = .array(tools.map(JSONValue.object))
        }
        return .object(object)
    }

    /// The beta that lets a request say what happens to a thinking block whose
    /// conversation has changed since it was produced.
    static let thinkingBindingBeta = "thinking-binding-controls-2026-08-01"

    /// The `thinking` object, told to drop a replayed block whose conversation
    /// no longer matches rather than fail the request.
    ///
    /// Opus 5.5 and Fable 5.1 bind each thinking signature to the system
    /// prompt, the tools and every earlier message as they were when the block
    /// was produced; for accounts created on or after 2026-08-31 a replay after
    /// any of those changed is a 400 that no retry clears. The runtime changes
    /// them on purpose — attached images and screenshots become text once a
    /// turn has used them, compaction folds old turns into a memory while
    /// keeping recent reasoning, and a change of mode, computer use or MCP
    /// servers rebuilds the tools and system prompt for the same conversation —
    /// so one such rewrite failed the run and every later turn of the session.
    /// `drop_block` has the API drop the stale block and every thinking block
    /// after it for that request only, so it is sent on every request. Models
    /// that do not enforce the check accept it.
    ///
    /// A model that thinks when `thinking` is omitted still replays signed
    /// blocks, so it is sent an explicit `adaptive`, which is what it runs
    /// with anyway, to carry the setting. Disabled or absent thinking on any
    /// other model has nothing to bind.
    static func bindingTolerant(_ thinking: JSONValue?, providerModelID: String) -> JSONValue? {
        var thinking = thinking
        if thinking == nil, CodeThinkingWire.thinksWhenOmitted(providerModelID) {
            thinking = .object(["type": .string("adaptive")])
        }
        guard case var .object(fields)? = thinking,
              let type = fields["type"]?.stringValue,
              type == "adaptive" || type == "enabled"
        else { return thinking }
        fields["block_binding"] = .object(["prefix_mismatch_behavior": .string("drop_block")])
        return .object(fields)
    }

    /// The `anthropic-beta` values a body built here needs.
    ///
    /// Read off the body rather than decided beside it: `block_binding`
    /// without its beta is a 400, and so is the beta's absence with the field.
    static func betas(for body: JSONValue) -> [String] {
        body["thinking"]?["block_binding"] == nil ? [] : [thinkingBindingBeta]
    }

    /// Puts the rolling breakpoint on the conversation's final block.
    ///
    /// Walks back past blocks that cannot carry one — thinking blocks refuse
    /// `cache_control` — so a turn that ends in reasoning still caches.
    static func markLastCacheableBlock(in messages: inout [JSONValue], with marker: JSONValue) {
        markLastCacheableBlock(in: &messages, before: messages.count, with: marker)
    }

    /// Puts a breakpoint where the previous request's rolling one was: the
    /// last block of the user message before the newest assistant message.
    /// Nothing is marked when there is no such pair, as on a first request.
    static func markPreviousTail(in messages: inout [JSONValue], with marker: JSONValue) {
        func role(_ index: Int) -> String? { messages[index]["role"]?.stringValue }
        guard let assistant = messages.indices.last(where: { role($0) == "assistant" }),
              let user = messages[..<assistant].indices.last(where: { role($0) == "user" })
        else { return }
        markLastCacheableBlock(in: &messages, before: user + 1, with: marker)
    }

    /// Marks the last block that can carry a breakpoint among the messages
    /// before `end`.
    private static func markLastCacheableBlock(
        in messages: inout [JSONValue],
        before end: Int,
        with marker: JSONValue
    ) {
        for messageIndex in messages[..<end].indices.reversed() {
            guard case var .object(message) = messages[messageIndex],
                  case var .array(blocks) = message["content"]
            else { continue }
            for blockIndex in blocks.indices.reversed() {
                guard case var .object(block) = blocks[blockIndex] else { continue }
                if case let .string(type) = block["type"],
                   type == "thinking" || type == "redacted_thinking"
                {
                    continue
                }
                block["cache_control"] = marker
                blocks[blockIndex] = .object(block)
                message["content"] = .array(blocks)
                messages[messageIndex] = .object(message)
                return
            }
        }
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

        // One assistant message per model turn: its text and *all* of its tool
        // calls together. Chat Completions requires every `tool` message to
        // answer a call on the assistant message immediately before it, so a
        // turn of three parallel calls written as three assistant messages
        // is rejected outright.
        var pendingText = ""
        var pendingCalls: [JSONValue] = []
        func flushAssistant() {
            guard !pendingText.isEmpty || !pendingCalls.isEmpty else { return }
            var assistant: [String: JSONValue] = [
                "role": .string("assistant"),
                "content": pendingText.isEmpty ? .null : .string(pendingText),
            ]
            if !pendingCalls.isEmpty {
                assistant["tool_calls"] = .array(pendingCalls)
            }
            messages.append(.object(assistant))
            pendingText = ""
            pendingCalls = []
        }

        // Screenshots returned by tools ride on a user message, which may only
        // follow the *whole* run of tool results — one wedged between two
        // results orphans the second.
        var pendingImageMessages: [JSONValue] = []

        for message in request.messages {
            switch message {
            case .assistant, .assistantThinking, .assistantRedactedThinking,
                 .toolCall, .toolCallWithExtra:
                messages.append(contentsOf: pendingImageMessages)
                pendingImageMessages = []
            case .toolResult, .toolResultWithImages:
                flushAssistant()
            case .user, .userWithImages:
                flushAssistant()
                messages.append(contentsOf: pendingImageMessages)
                pendingImageMessages = []
            }
            switch message {
            case let .user(text):
                messages.append(.object([
                    "role": .string("user"),
                    "content": .string(text),
                ]))
            case let .userWithImages(text, images):
                // A parts array rather than a bare string, which is how the
                // OpenAI-compatible schema carries anything but plain text.
                var parts: [JSONValue] = images.map { image in
                    .object([
                        "type": .string("image_url"),
                        "image_url": .object([
                            "url": .string(image.dataURL),
                            "detail": .string(image.detail.rawValue),
                        ]),
                    ])
                }
                if !text.isEmpty {
                    parts.append(.object([
                        "type": .string("text"),
                        "text": .string(text),
                    ]))
                }
                messages.append(.object([
                    "role": .string("user"),
                    "content": .array(parts),
                ]))
            case let .assistant(text):
                pendingText += pendingText.isEmpty ? text : "\n\n" + text
            case .assistantThinking, .assistantRedactedThinking:
                // Anthropic's signed reasoning means nothing to these labs.
                break
            case let .toolCall(id, name, input):
                pendingCalls.append(.object([
                    "id": .string(id),
                    "type": .string("function"),
                    "function": .object([
                        "name": .string(name),
                        "arguments": .string(jsonString(input)),
                    ]),
                ]))
            case let .toolCallWithExtra(id, name, input, extraContent):
                var toolCallDict: [String: JSONValue] = [
                    "id": .string(id),
                    "type": .string("function"),
                    "function": .object([
                        "name": .string(name),
                        "arguments": .string(jsonString(input)),
                    ]),
                ]
                // Only pass extra_content to Google/Gemini endpoints when the payload is specifically
                // google-namespaced (e.g. google.thought_signature). Non-Google providers (Codestral,
                // Mistral, DeepSeek, OpenAI, etc.) strictly reject extra_content with extra_forbidden.
                if providerID == "google", let obj = extraContent.objectValue, obj["google"] != nil {
                    toolCallDict["extra_content"] = extraContent
                }
                pendingCalls.append(.object(toolCallDict))
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
                    pendingImageMessages.append(.object([
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
        flushAssistant()
        messages.append(contentsOf: pendingImageMessages)

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
            case let .userWithImages(text, images):
                var parts: [JSONValue] = images.map { image in
                    .object([
                        "type": .string("input_image"),
                        "image_url": .string(image.dataURL),
                        "detail": .string(image.detail.rawValue),
                    ])
                }
                if !text.isEmpty {
                    parts.append(
                        .object(["type": .string("input_text"), "text": .string(text)])
                    )
                }
                input.append(.object([
                    "role": .string("user"),
                    "content": .array(parts),
                ]))
            case let .user(text):
                input.append(.object([
                    "role": .string("user"),
                    "content": .array([
                        .object(["type": .string("input_text"), "text": .string(text)]),
                    ]),
                ]))
            case let .assistant(text):
                guard !text.isEmpty else { continue }
                input.append(.object([
                    "role": .string("assistant"),
                    "content": .array([
                        .object(["type": .string("output_text"), "text": .string(text)]),
                    ]),
                ]))
            case .assistantThinking, .assistantRedactedThinking:
                break
            case let .toolCall(id, name, arguments), let .toolCallWithExtra(id, name, arguments, _):
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
    // Reasoning assembly, keyed the same way. The text streams out as it
    // arrives for the reader; the block is emitted whole at its stop, with the
    // signature, because that is the form the next request must carry back.
    private var thinkingBlocks: [Int: ThinkingBlock] = [:]
    private var stopReason: ModelStopReason?

    private struct ThinkingBlock {
        var text: String
        var signature: String
    }

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
            return [.usage(inputTokens: usage.promptTokens, outputTokens: usage.outputTokens)]
        case "ping":
            return []
        case "content_block_start":
            guard let index = wire.index, let block = wire.contentBlock else { return [] }
            switch block.type {
            case "tool_use":
                if let id = block.id, let name = block.name {
                    toolBlocks[index] = ToolBlock(id: id, name: name, partialJSON: "")
                }
            case "thinking":
                thinkingBlocks[index] = ThinkingBlock(
                    text: block.thinking ?? "",
                    signature: block.signature ?? ""
                )
            case "redacted_thinking":
                // Arrives complete; there are no deltas to wait for.
                if let data = block.data, !data.isEmpty {
                    return [.redactedThinking(data: data)]
                }
            default:
                break
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
                    thinkingBlocks[index]?.text += thinking
                    return [.reasoningSummary(thinking)]
                }
                return []
            case "signature_delta":
                if let signature = delta.signature {
                    thinkingBlocks[index]?.signature += signature
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
            guard let index = wire.index else { return [] }
            if let thinking = thinkingBlocks.removeValue(forKey: index) {
                // A block without a signature cannot be replayed, and sending
                // one back unsigned is a 400. Its text already reached the reader.
                guard !thinking.signature.isEmpty else { return [] }
                return [.thinkingBlock(text: thinking.text, signature: thinking.signature)]
            }
            guard let block = toolBlocks.removeValue(forKey: index) else { return [] }
            let input = Self.parseToolInput(block.partialJSON)
            return [.toolCallRequested(id: block.id, name: block.name, input: input)]
        case "message_delta":
            if let reason = wire.delta?.stopReason {
                stopReason = Self.mapStopReason(reason)
            }
            guard let usage = wire.usage else { return [] }
            return [.usage(inputTokens: usage.promptTokens, outputTokens: usage.outputTokens)]
        case "message_stop":
            return [.turnCompleted(stopReason ?? .endTurn)]
        case "error":
            let message = wire.error?.message ?? "The model returned an error."
            throw BackendCodeModelClient.streamError(type: wire.error?.type, message: message)
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

    /// Each reason the loop must act on differently gets its own case; the
    /// rest (`end_turn`, `stop_sequence`) are a finished reply.
    static func mapStopReason(_ reason: String) -> ModelStopReason {
        switch reason {
        case "tool_use": return .toolUse
        case "max_tokens": return .maxTokens
        case "refusal": return .refusal
        case "pause_turn": return .pauseTurn
        case "model_context_window_exceeded": return .contextWindowExceeded
        default: return .endTurn
        }
    }
}

private struct StreamEventWire: Decodable {
    struct ContentBlock: Decodable {
        let type: String
        let id: String?
        let name: String?
        let thinking: String?
        let signature: String?
        /// The encrypted payload of a `redacted_thinking` block.
        let data: String?
    }
    struct Delta: Decodable {
        let type: String?
        let text: String?
        let thinking: String?
        let signature: String?
        let partialJSON: String?
        let stopReason: String?

        private enum CodingKeys: String, CodingKey {
            case type, text, thinking, signature
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
        let cacheReadInputTokens: Int?
        let cacheCreationInputTokens: Int?

        private enum CodingKeys: String, CodingKey {
            case inputTokens = "input_tokens"
            case outputTokens = "output_tokens"
            case cacheReadInputTokens = "cache_read_input_tokens"
            case cacheCreationInputTokens = "cache_creation_input_tokens"
        }

        /// The whole prompt this turn carried.
        ///
        /// With caching on, `input_tokens` counts only the uncached tail, so on
        /// its own it would tell the context meter a 150K conversation weighs
        /// a few hundred tokens — and compaction would never trigger.
        var promptTokens: Int? {
            guard inputTokens != nil || cacheReadInputTokens != nil
                || cacheCreationInputTokens != nil
            else { return nil }
            return (inputTokens ?? 0) + (cacheReadInputTokens ?? 0)
                + (cacheCreationInputTokens ?? 0)
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
        var extraContent: JSONValue?
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
        let rootValue = try decodeObject(payload)
        let root: [String: JSONValue]
        if let obj = rootValue.objectValue {
            root = obj
        } else if let array = rootValue.arrayValue, let first = array.first?.objectValue {
            root = first
        } else {
            return []
        }

        if let error = root["error"]?["message"]?.stringValue ?? root["error"]?.stringValue {
            throw BackendCodeModelClient.streamError(
                type: root["error"]?["type"]?.stringValue ?? root["error"]?["code"]?.stringValue,
                message: error
            )
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
            } else if let parts = delta["content"]?.arrayValue {
                for part in parts {
                    let type = part["type"]?.stringValue ?? ""
                    if type == "text", let text = part["text"]?.stringValue, !text.isEmpty {
                        events.append(.textDelta(text))
                    } else if (type == "thinking" || type == "reasoning"),
                              let text = (part["thinking"]?.stringValue ?? part["text"]?.stringValue),
                              !text.isEmpty {
                        events.append(.reasoningSummary(text))
                    }
                }
            }

            if let reasoning = delta["reasoning_content"]?.stringValue, !reasoning.isEmpty {
                events.append(.reasoningSummary(reasoning))
            } else if let reasoning = delta["reasoning"]?.stringValue, !reasoning.isEmpty {
                events.append(.reasoningSummary(reasoning))
            } else if let thought = delta["thought"]?.stringValue, !thought.isEmpty {
                events.append(.reasoningSummary(thought))
            } else if let thinking = delta["thinking"]?.stringValue, !thinking.isEmpty {
                events.append(.reasoningSummary(thinking))
            } else if let details = delta["reasoning_details"]?.arrayValue {
                for detail in details {
                    if let text = detail["text"]?.stringValue, !text.isEmpty {
                        events.append(.reasoningSummary(text))
                    }
                }
            }

            for call in delta["tool_calls"]?.arrayValue ?? [] {
                guard let index = call["index"]?.intValue ?? (delta["tool_calls"]?.arrayValue?.count == 1 ? 0 : nil) else { continue }
                var block = toolBlocks[index] ?? ToolBlock()
                if let id = call["id"]?.stringValue { block.id = id }
                if let name = call["function"]?["name"]?.stringValue {
                    block.name = name
                }
                if let arguments = call["function"]?["arguments"]?.stringValue {
                    block.arguments += arguments
                }
                if let extra = call["extra_content"] {
                    block.extraContent = extra
                } else if let extra = delta["extra_content"] {
                    block.extraContent = extra
                }
                toolBlocks[index] = block
            }
        }
        if let finishReason = choice["finish_reason"]?.stringValue, !completed {
            completed = true
            var sawTools = false
            for (_, block) in toolBlocks.sorted(by: { $0.key < $1.key })
                where !block.id.isEmpty && !block.name.isEmpty
            {
                sawTools = true
                if let extra = block.extraContent, !extra.isNull {
                    events.append(.toolCallRequestedWithExtra(
                        id: block.id,
                        name: block.name,
                        input: parseToolInput(block.arguments),
                        extraContent: extra
                    ))
                } else {
                    events.append(.toolCallRequested(
                        id: block.id,
                        name: block.name,
                        input: parseToolInput(block.arguments)
                    ))
                }
            }
            let reason: ModelStopReason
            if sawTools {
                reason = .toolUse
            } else {
                switch finishReason {
                case "tool_calls", "function_call": reason = .toolUse
                case "length": reason = .maxTokens
                // The provider's own filter stopped the reply part-way.
                case "content_filter": reason = .refusal
                default: reason = .endTurn
                }
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
            switch root["response"]?["incomplete_details"]?["reason"]?.stringValue {
            case "max_output_tokens":
                return [.turnCompleted(.maxTokens)]
            case "content_filter":
                return [.turnCompleted(.refusal)]
            default:
                return [.turnCompleted(.endTurn)]
            }
        case "response.failed":
            let message = root["response"]?["error"]?["message"]?.stringValue
                ?? "The Responses API run failed."
            throw BackendCodeModelClient.streamError(
                type: root["response"]?["error"]?["code"]?.stringValue,
                message: message
            )
        case "error":
            let message = root["message"]?.stringValue
                ?? root["error"]?["message"]?.stringValue
                ?? "The Responses API stream failed."
            throw BackendCodeModelClient.streamError(
                type: root["code"]?.stringValue ?? root["error"]?["code"]?.stringValue,
                message: message
            )
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
