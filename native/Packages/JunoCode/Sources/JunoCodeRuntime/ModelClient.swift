import Foundation
import JunoCodeCore

/// An ephemeral image sent to a vision-capable model. Screenshot bytes are
/// deliberately stripped before conversation persistence.
public struct ModelImage: Hashable, Codable, Sendable {
    public enum Detail: String, Hashable, Codable, Sendable {
        case low
        case high
        case auto
        /// Kept at the size sent. OpenAI's Responses wire sends it as is, so
        /// a screenshot the harness already scaled is not resized again and
        /// the model's coordinates stay in Juno's frame (CU-04); Chat
        /// Completions has no such value and gets `high` with an image
        /// already inside the box `high` resizes to.
        case original
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
    /// A reasoning block exactly as the provider returned it, signature and
    /// all.
    ///
    /// Anthropic requires the thinking that preceded a `tool_use` to come back
    /// unmodified in the next request of the same tool loop; without it a model
    /// with thinking enabled either rejects the request or reasons from
    /// scratch every step. Providers that have no such contract ignore it.
    case assistantThinking(text: String, signature: String)
    /// A reasoning block the provider encrypted. Opaque; replayed verbatim.
    case assistantRedactedThinking(data: String)
    case toolCall(id: String, name: String, input: JSONValue)
    case toolCallWithExtra(id: String, name: String, input: JSONValue, extraContent: JSONValue)
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
    /// A ceiling on the reply below the client's own, or nil for the client's
    /// default.
    ///
    /// Agent turns leave it nil: a long edit must not be cut off. The
    /// compaction summary sets it, because a length the model was merely asked
    /// for is not a bound, and a summary that runs on unchecked costs the very
    /// context it was meant to free.
    public let maximumOutputTokens: Int?

    public init(
        sessionID: CodeSessionID,
        systemPrompt: String,
        messages: [ModelMessage],
        tools: [ModelToolDescriptor],
        modelID: String,
        reasoningEffort: ReasoningEffort?,
        maximumOutputTokens: Int? = nil
    ) {
        self.sessionID = sessionID
        self.systemPrompt = systemPrompt
        self.messages = messages
        self.tools = tools
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.maximumOutputTokens = maximumOutputTokens
    }
}

/// Why a model call was made, for the accounting that sums them.
public enum ModelCallPurpose: String, Equatable, Sendable {
    /// A step of the agent's own run.
    case turn
    /// The summary written when older turns are folded away.
    case compactionSummary
}

/// What one model call was billed for, as the provider reported it.
public struct ModelCallUsage: Equatable, Sendable {
    public let purpose: ModelCallPurpose
    /// The whole prompt: fresh input, cache reads and cache writes together.
    public let inputTokens: Int?
    public let outputTokens: Int?
    /// The part of the prompt read from the provider's cache, billed at a
    /// fraction of the input rate.
    public let cacheReadTokens: Int?
    /// The part written to the cache, billed at a premium (Anthropic).
    public let cacheWriteTokens: Int?
    /// The model that answered, which is what the call is priced by.
    public let modelID: String?

    public init(
        purpose: ModelCallPurpose,
        inputTokens: Int?,
        outputTokens: Int?,
        cacheReadTokens: Int? = nil,
        cacheWriteTokens: Int? = nil,
        modelID: String? = nil
    ) {
        self.purpose = purpose
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.modelID = modelID
    }
}

/// Every model call a session made, summed.
///
/// Distinct from the context size a meter shows. That is one number the
/// newest turn replaces; this is what the session has spent, and a call that
/// is not an agent step — the compaction summary — belongs in it as much as
/// any turn does, but must never be mistaken for the size of the context.
public struct ModelUsageTotals: Equatable, Codable, Sendable {
    /// Whole prompts, cache reads and writes included.
    public private(set) var inputTokens = 0
    public private(set) var outputTokens = 0
    public private(set) var cacheReadTokens = 0
    public private(set) var cacheWriteTokens = 0
    /// Calls that reported any usage at all.
    public private(set) var requests = 0

    public init() {}

    /// Input billed at the full rate: the prompts less what the cache served
    /// or stored. Counting cached prompt tokens as full input overstated a
    /// cached session's spend about tenfold.
    public var freshInputTokens: Int {
        max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
    }

    public mutating func record(_ usage: ModelCallUsage) {
        guard usage.inputTokens != nil || usage.outputTokens != nil else { return }
        inputTokens += usage.inputTokens ?? 0
        outputTokens += usage.outputTokens ?? 0
        cacheReadTokens += usage.cacheReadTokens ?? 0
        cacheWriteTokens += usage.cacheWriteTokens ?? 0
        requests += 1
    }

    public mutating func add(_ other: ModelUsageTotals) {
        inputTokens += other.inputTokens
        outputTokens += other.outputTokens
        cacheReadTokens += other.cacheReadTokens
        cacheWriteTokens += other.cacheWriteTokens
        requests += other.requests
    }

    private enum CodingKeys: String, CodingKey {
        case inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, requests
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        inputTokens = try container.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0
        outputTokens = try container.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
        cacheReadTokens = try container.decodeIfPresent(Int.self, forKey: .cacheReadTokens) ?? 0
        cacheWriteTokens = try container.decodeIfPresent(Int.self, forKey: .cacheWriteTokens) ?? 0
        requests = try container.decodeIfPresent(Int.self, forKey: .requests) ?? 0
    }
}

public enum ModelStopReason: Equatable, Sendable {
    /// The model finished its reply; no tools requested.
    case endTurn
    /// The model requested tool calls and is waiting for their results.
    case toolUse
    case maxTokens
    /// The model declined to go on with the request. Not a finished answer:
    /// what it wrote before stopping may be partial.
    case refusal
    /// The provider paused a long turn and expects the same conversation to
    /// be sent back so the model can carry on from its own last message.
    case pauseTurn
    /// The reply stopped because the context window was full. The answer is
    /// cut off, and only a shorter history lets the model finish.
    case contextWindowExceeded
}

public enum ModelStreamEvent: Sendable {
    case textDelta(String)
    /// Product-facing reasoning summary, never raw private reasoning.
    case reasoningSummary(String)
    /// A complete reasoning block with the signature the provider needs to see
    /// again. Emitted once per block, after its deltas, for replay only — the
    /// readable text already went out as ``reasoningSummary(_:)``.
    case thinkingBlock(text: String, signature: String)
    /// A complete encrypted reasoning block, for replay only.
    case redactedThinking(data: String)
    case toolCallRequested(id: String, name: String, input: JSONValue)
    case toolCallRequestedWithExtra(id: String, name: String, input: JSONValue, extraContent: JSONValue)
    /// A tool call whose arguments were not valid JSON: cut off by the
    /// output limit, or simply malformed. It is answered with an error naming
    /// the problem so the model can send it again, never run with `{}`.
    ///
    /// - Parameters:
    ///   - rawArguments: the arguments exactly as streamed.
    ///   - error: what the JSON parser said, with its position when it gave
    ///     one.
    ///   - extraContent: provider data that must come back with the call, as
    ///     for ``toolCallRequestedWithExtra(id:name:input:extraContent:)``;
    ///     Gemini refuses a history whose call lost its thought signature.
    case toolCallMalformed(
        id: String,
        name: String,
        rawArguments: String,
        error: String,
        extraContent: JSONValue?
    )
    /// Token accounting for the turn, as the provider reported it.
    ///
    /// `inputTokens` is the whole prompt the provider actually billed — system
    /// prompt, tool schemas and the full conversation so far — so it *is* the
    /// session's current context size, not a delta to accumulate. That is what
    /// makes a context meter possible without Juno re-tokenizing anything itself.
    /// Either field is nil when the provider did not report it.
    case usage(inputTokens: Int?, outputTokens: Int?)
    /// How much of the prompt the provider's cache served and stored, when it
    /// said. Both are already inside `usage`'s `inputTokens`; this splits
    /// them out so they are priced at their own rates.
    case cacheUsage(readTokens: Int?, writeTokens: Int?)
    case turnCompleted(ModelStopReason)
}

public enum AgentModelClientError: Error, Equatable, Sendable {
    /// A connection that failed or dropped, a timeout, a 5xx: nothing says it
    /// will fail again.
    case transport(message: String)
    case unauthorized
    /// The provider is throttling this account. `retryAfter` is how long it
    /// asked to be left alone, in seconds, when it said.
    case rateLimited(retryAfter: TimeInterval?)
    /// The provider is up but has no capacity right now (Anthropic's 529,
    /// a 503). Waiting is the fix.
    case overloaded(retryAfter: TimeInterval?)
    /// The request is longer than the model's context window. The same
    /// request will fail the same way; a shorter history will not.
    case contextWindowExceeded(message: String)
    /// The provider's own capacity or billing quota. Another model may work.
    case quotaExhausted(message: String)
    /// The Juno account's plan budget or usage window. Every model draws on
    /// the same allowance, so neither a retry nor a fallback can help; the
    /// honest answer is the message, which says when it frees up.
    case planLimitReached(message: String)
    case invalidResponse(message: String)
    /// Nothing can be sent at all: no transport is composed, the reader is
    /// signed out, the model cannot speak the tool protocol. Retrying the
    /// same request cannot help; the message says what will.
    case unavailable(message: String)
    /// The provider took the request and then went quiet, or never finished
    /// within the turn's deadline. Each attempt costs the whole deadline, so
    /// it is tried again once, not waited out like a rate limit.
    case stalled(message: String)
    /// The provider refused the request itself — a parameter it does not
    /// take, a model it does not know, a replayed block it will not accept
    /// (a 400, 404 or 422). Sent again it fails again, so it is not retried;
    /// another lab's model may well take it.
    case rejected(message: String)
}

/// How a failed model request is tried again.
///
/// Ported from the cloud runner (`runner/agent-core/src/loop.ts`,
/// `providers/errors.ts`), which learned it from a run that died fourteen
/// seconds in on one 429. A rate limit or an overload is waited out with
/// exponential backoff and jitter, honouring the provider's own
/// `retry-after` when it gave one, within a total budget; only once that is
/// spent does a fallback model — when the reader opted into one — get a turn.
/// A dropped connection is retried the same way. An error that retrying cannot
/// fix is not retried at all.
public struct ModelRetryPolicy: Equatable, Sendable {
    /// Retries after the first attempt, per model.
    public var maximumRetries: Int
    /// The first backoff; each later one doubles, up to `maximumDelay`.
    public var baseDelay: Duration
    public var maximumDelay: Duration
    /// The most one step may spend waiting across all its retries.
    public var maximumTotalWait: Duration
    /// The longest `retry-after` honoured as asked. A provider saying "come
    /// back in an hour" is saying to give up on it, not to hold the run that
    /// long; past this the retry is not attempted.
    public var maximumRetryAfter: Duration

    public init(
        maximumRetries: Int = 4,
        baseDelay: Duration = .seconds(1),
        maximumDelay: Duration = .seconds(20),
        maximumTotalWait: Duration = .seconds(90),
        maximumRetryAfter: Duration = .seconds(60)
    ) {
        self.maximumRetries = max(0, maximumRetries)
        self.baseDelay = baseDelay
        self.maximumDelay = maximumDelay
        self.maximumTotalWait = maximumTotalWait
        self.maximumRetryAfter = maximumRetryAfter
    }

    public static let standard = ModelRetryPolicy()

    /// How long to wait before retry number `retry` (1-based), or nil when the
    /// policy says to stop: out of retries, out of waiting budget, or asked to
    /// wait longer than it honours.
    ///
    /// - Parameters:
    ///   - retryAfter: what the provider asked for, in seconds, if anything.
    ///   - waited: the time already spent waiting in this step.
    ///   - jitter: a number in 0..<1. Several sessions meeting the same
    ///     per-minute limit at once must not all come back at once, or the
    ///     retry is the thundering herd that caused the limit, rearranged.
    public func delay(
        forRetry retry: Int,
        retryAfter: TimeInterval?,
        waited: Duration,
        jitter: Double
    ) -> Duration? {
        guard retry >= 1, retry <= maximumRetries else { return nil }
        let delay: Duration
        if let retryAfter, retryAfter >= 0 {
            let asked = Duration.milliseconds(Int64((retryAfter * 1_000).rounded(.up)))
            guard asked <= maximumRetryAfter else { return nil }
            delay = asked
        } else {
            var backoff = baseDelay
            for _ in 1..<retry {
                backoff = min(backoff * 2, maximumDelay)
            }
            backoff = min(backoff, maximumDelay)
            // Full jitter over the top half: never less than half the backoff.
            delay = backoff * (0.5 + 0.5 * min(max(jitter, 0), 1))
        }
        guard waited + delay <= maximumTotalWait else { return nil }
        return delay
    }
}

/// The transport that produces model turns. The production implementation
/// lives behind the Juno backend (composed at the app root through the
/// authenticated HTTP transport); tests use scripted clients. No provider
/// credential ever reaches this package.
public protocol AgentModelClient: Sendable {
    func streamTurn(
        _ request: ModelTurnRequest
    ) -> AsyncThrowingStream<ModelStreamEvent, Error>

    /// Whether the provider serving `modelID` reads a request's leading
    /// system prompt, tools and messages from a cache when an earlier request
    /// began the same way.
    ///
    /// Decides how a compaction summary is asked for: as a continuation of
    /// the session's own request, which such a provider bills mostly at the
    /// cached rate, or as a standalone transcript, which is cheaper wherever
    /// nothing is cached.
    func cachesPromptPrefix(for modelID: String) -> Bool
}

public extension AgentModelClient {
    func cachesPromptPrefix(for _: String) -> Bool { false }
}
