import Foundation
import JunoCodeCore
import JunoCodeRuntime

/// Prompt caching on the OpenAI-compatible routes, and the byte-stable
/// encoding every provider's prefix cache depends on.
///
/// A prefix cache matches bytes (or the tokens they make), so a request is
/// only cheaper than the last one if it begins exactly the same way.
/// `JSONValue.object` holds a Swift dictionary, whose order changes between
/// instances and between launches; without sorted keys the tool schemas and
/// replayed tool inputs came out in a different order on most requests, and
/// every cache missed from the first tool onward. Anthropic's breakpoints
/// (`AnthropicRequestBuilder`) are wasted the same way.
///
/// Per lab, as the web's lab-checked request builders send it
/// (`src/lib/openai-compat.ts`, `src/lib/llm/compat-loop.ts`):
/// - OpenAI, Mistral: `prompt_cache_key` routes a session's requests to the
///   same cache (Mistral caches only when it is set).
/// - xAI: the `x-grok-conv-id` header on Chat Completions, which has no body
///   field for it; `prompt_cache_key` on Responses.
/// - Qwen explicit-cache models: `cache_control` markers on the system
///   prompt and the newest message (Model Studio context cache).
/// - DeepSeek, Zhipu, Moonshot, MiniMax, MiMo, LongCat: automatic on stable
///   prefixes; nothing to send.
enum PromptCacheWire {
    /// Encodes a request body or a replayed call's arguments with sorted keys,
    /// so the same value is always the same bytes.
    static func encode(_ value: JSONValue) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }

    /// OpenAI's documented limit on `prompt_cache_key`.
    static let maximumKeyLength = 64

    /// The session's id: stable across every request of a conversation, its
    /// compaction summary included, and distinct between conversations.
    static func key(for request: ModelTurnRequest) -> String? {
        let value = request.sessionID.value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        return String(value.prefix(maximumKeyLength))
    }

    /// Labs whose Chat Completions take `prompt_cache_key`.
    static let chatKeyProviders: Set<String> = ["openai", "mistral"]
    /// Labs whose Responses API takes `prompt_cache_key`.
    static let responsesKeyProviders: Set<String> = ["openai", "xai"]
    /// xAI's conversation routing header on Chat Completions.
    static let grokConversationHeader = "x-grok-conv-id"

    /// Labs that read a repeated prefix from a cache, on their own or with the
    /// routing above. Meta and Google are absent: nothing Juno sends makes
    /// their caching something to count on.
    static let cachingProviders: Set<String> = [
        "openai", "xai", "deepseek", "zhipu", "moonshot", "minimax",
        "qwen", "mistral", "mimo", "longcat",
    ]

    /// The Qwen models that cache only where a request marks it (Model Studio
    /// explicit cache: at most four markers, 1,024-token minimum, 5 minutes).
    static let qwenExplicitCacheModels = ["qwen3.7-plus", "qwen3.8-max", "qwen3.8-flash"]

    static func usesQwenExplicitCache(providerID: String, providerModelID: String) -> Bool {
        guard providerID.lowercased() == "qwen" else { return false }
        let model = providerModelID.lowercased()
        return qwenExplicitCacheModels.contains { model.hasPrefix($0) }
    }

    /// Extra request headers for a Chat Completions call.
    static func chatHeaders(providerID: String, key: String?) -> [String: String] {
        guard let key, providerID.lowercased() == "xai" else { return [:] }
        return [grokConversationHeader: key]
    }

    /// A Chat Completions body with the lab's cache routing applied.
    static func chat(
        _ body: JSONValue,
        providerID: String,
        providerModelID: String,
        key: String?
    ) -> JSONValue {
        guard case var .object(object) = body else { return body }
        if let key, chatKeyProviders.contains(providerID.lowercased()) {
            object["prompt_cache_key"] = .string(key)
        }
        if usesQwenExplicitCache(providerID: providerID, providerModelID: providerModelID),
           case var .array(messages)? = object["messages"]
        {
            markQwen(&messages)
            object["messages"] = .array(messages)
        }
        return .object(object)
    }

    /// A Responses body with the lab's cache routing applied.
    static func responses(_ body: JSONValue, providerID: String, key: String?) -> JSONValue {
        guard let key, responsesKeyProviders.contains(providerID.lowercased()),
              case var .object(object) = body
        else { return body }
        object["prompt_cache_key"] = .string(key)
        return .object(object)
    }

    /// Two markers: the system prompt, which every request of the session
    /// shares, and the newest message, so each request writes the prefix the
    /// next one reads — the same rolling pattern as Anthropic's breakpoints.
    static func markQwen(_ messages: inout [JSONValue]) {
        guard !messages.isEmpty else { return }
        let systemIndex = messages.firstIndex { $0["role"]?.stringValue == "system" }
        if let systemIndex {
            _ = markLastBlock(of: &messages[systemIndex])
        }
        for index in messages.indices.reversed() where index != systemIndex {
            if markLastBlock(of: &messages[index]) { return }
        }
    }

    private static let ephemeral: JSONValue = .object(["type": .string("ephemeral")])

    /// Puts the marker on a message's last content block, turning plain-string
    /// content into the one text block it stands for. False when the message
    /// has no content to carry one (an assistant message of only tool calls).
    private static func markLastBlock(of message: inout JSONValue) -> Bool {
        guard case var .object(fields) = message else { return false }
        switch fields["content"] {
        case let .string(text)? where !text.isEmpty:
            fields["content"] = .array([
                .object([
                    "type": .string("text"),
                    "text": .string(text),
                    "cache_control": ephemeral,
                ]),
            ])
        case var .array(parts)? where !parts.isEmpty:
            guard case var .object(last) = parts[parts.count - 1] else { return false }
            last["cache_control"] = ephemeral
            parts[parts.count - 1] = .object(last)
            fields["content"] = .array(parts)
        default:
            return false
        }
        message = .object(fields)
        return true
    }
}
