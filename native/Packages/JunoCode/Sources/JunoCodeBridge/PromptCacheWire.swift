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
/// - OpenAI, Mistral, Meta: `prompt_cache_key` routes a session's requests
///   to the same cache (Mistral caches only when it is set). OpenAI GPT-5.6+
///   also takes `prompt_cache_options` and an explicit breakpoint on the
///   system prompt; the older models OpenAI lists take 24h retention
///   (`src/lib/openai-prompt-cache.ts`).
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
    static let chatKeyProviders: Set<String> = ["openai", "mistral", "meta"]
    /// Labs whose Responses API takes `prompt_cache_key`.
    static let responsesKeyProviders: Set<String> = ["openai", "xai"]
    /// xAI's conversation routing header on Chat Completions.
    static let grokConversationHeader = "x-grok-conv-id"

    /// Labs that read a repeated prefix from a cache, on their own or with the
    /// routing above. Google is absent: its implicit cache is best-effort.
    static let cachingProviders: Set<String> = [
        "openai", "xai", "deepseek", "zhipu", "moonshot", "minimax",
        "qwen", "mistral", "meta", "mimo", "longcat",
    ]

    /// GPT-5.6 and later: `prompt_cache_options` and explicit breakpoints.
    static func isOpenAIModernCacheModel(_ providerModelID: String) -> Bool {
        let model = providerModelID.lowercased()
        return model.range(of: #"gpt-5\.(6|7|8|9|[1-9]\d)"#, options: .regularExpression) != nil
            || model.range(of: #"^gpt-[6-9]"#, options: .regularExpression) != nil
    }

    /// The pre-5.6 models OpenAI documents for `prompt_cache_retention:
    /// "24h"`: exact ids (a dated snapshot counts as its model) and the whole
    /// gpt-5.1 family. Others reject or ignore the field.
    static func usesOpenAIRetention(_ providerModelID: String) -> Bool {
        guard !isOpenAIModernCacheModel(providerModelID) else { return false }
        var model = providerModelID.lowercased()
        if let dated = model.range(of: #"-\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) {
            model.removeSubrange(dated)
        }
        let listed: Set<String> = ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.2", "gpt-5", "gpt-5-codex", "gpt-4.1"]
        return listed.contains(model) || model == "gpt-5.1" || model.hasPrefix("gpt-5.1-")
    }

    /// OpenAI's cache fields for a model, on either wire.
    static func applyOpenAICacheFields(_ object: inout [String: JSONValue], providerModelID: String) {
        if isOpenAIModernCacheModel(providerModelID) {
            object["prompt_cache_options"] = .object(["mode": .string("implicit"), "ttl": .string("30m")])
        } else if usesOpenAIRetention(providerModelID) {
            object["prompt_cache_retention"] = .string("24h")
        }
    }

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
        if providerID.lowercased() == "openai" {
            applyOpenAICacheFields(&object, providerModelID: providerModelID)
            if isOpenAIModernCacheModel(providerModelID), case var .array(messages)? = object["messages"],
               let systemIndex = messages.firstIndex(where: { $0["role"]?.stringValue == "system" })
            {
                markLastBlock(of: &messages[systemIndex], with: "prompt_cache_breakpoint", explicitBreakpoint)
                object["messages"] = .array(messages)
            }
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
    /// The system prompt rides in `instructions` there, which takes no
    /// breakpoint; GPT-5.6+ still places its implicit one on the newest input.
    static func responses(
        _ body: JSONValue,
        providerID: String,
        providerModelID: String,
        key: String?
    ) -> JSONValue {
        guard case var .object(object) = body else { return body }
        if let key, responsesKeyProviders.contains(providerID.lowercased()) {
            object["prompt_cache_key"] = .string(key)
        }
        if providerID.lowercased() == "openai" {
            applyOpenAICacheFields(&object, providerModelID: providerModelID)
        }
        return .object(object)
    }

    /// Two markers: the system prompt, which every request of the session
    /// shares, and the newest message, so each request writes the prefix the
    /// next one reads — the same rolling pattern as Anthropic's breakpoints.
    static func markQwen(_ messages: inout [JSONValue]) {
        guard !messages.isEmpty else { return }
        let systemIndex = messages.firstIndex { $0["role"]?.stringValue == "system" }
        if let systemIndex {
            _ = markLastBlock(of: &messages[systemIndex], with: "cache_control", ephemeral)
        }
        for index in messages.indices.reversed() where index != systemIndex {
            if markLastBlock(of: &messages[index], with: "cache_control", ephemeral) { return }
        }
    }

    private static let ephemeral: JSONValue = .object(["type": .string("ephemeral")])
    private static let explicitBreakpoint: JSONValue = .object(["mode": .string("explicit")])

    /// Puts the marker on a message's last content block, turning plain-string
    /// content into the one text block it stands for. False when the message
    /// has no content to carry one (an assistant message of only tool calls).
    @discardableResult
    private static func markLastBlock(of message: inout JSONValue, with field: String, _ marker: JSONValue) -> Bool {
        guard case var .object(fields) = message else { return false }
        switch fields["content"] {
        case let .string(text)? where !text.isEmpty:
            fields["content"] = .array([
                .object([
                    "type": .string("text"),
                    "text": .string(text),
                    field: marker,
                ]),
            ])
        case var .array(parts)? where !parts.isEmpty:
            guard case var .object(last) = parts[parts.count - 1] else { return false }
            last[field] = marker
            parts[parts.count - 1] = .object(last)
            fields["content"] = .array(parts)
        default:
            return false
        }
        message = .object(fields)
        return true
    }
}
