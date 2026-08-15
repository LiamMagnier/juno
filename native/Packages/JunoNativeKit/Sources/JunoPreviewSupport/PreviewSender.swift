#if DEBUG
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoSync

/// A request sender for the UI Preview harness that performs **no real
/// network I/O**. It returns canned in-process responses (or fails, for the
/// offline/error scenarios) so the real screens exercise their real code paths
/// against local fixtures. It holds no URLSession, no token, and no transport.
public actor PreviewSender: NativeChatRequestSending {
    private let fails: Bool
    /// Whether the account has no content. Work's fixtures are served from here
    /// rather than seeded into the repository, because Work is a relay-backed
    /// product with no local store — so "empty" has to be answered by the
    /// transport the same way the server would answer it.
    private let empty: Bool
    private(set) public var sentRequestCount = 0
    private(set) public var streamRequestCount = 0

    public init(networkFails: Bool, empty: Bool = false) {
        self.fails = networkFails
        self.empty = empty
    }

    public func send(
        _ request: NativeBearerRequest,
        for _: AccountID
    ) async throws -> HTTPResponse {
        sentRequestCount += 1
        if fails { throw URLError(.notConnectedToInternet) }
        if request.path.hasPrefix("/api/work/artifacts/") && request.path.hasSuffix("/download") {
            return HTTPResponse(
                statusCode: 200,
                headers: try HTTPHeaders([
                    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "content-length": String(PreviewWorkFixtures.artifactDownloadBytes.count),
                    "x-juno-artifact-version": "2",
                    "x-juno-validated": "true",
                ]),
                body: PreviewWorkFixtures.artifactDownloadBytes
            )
        }
        return HTTPResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "application/json"]),
            body: cannedBody(for: request.path)
        )
    }

    public func stream(
        _ request: NativeBearerRequest,
        for _: AccountID
    ) async throws -> HTTPByteStreamResponse {
        streamRequestCount += 1
        if fails { throw URLError(.notConnectedToInternet) }
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "text/event-stream"]),
            bytes: streamBytes(for: request.path)
        )
    }

    /// The bytes a stream request gets.
    ///
    /// Everything except a live Work task hands back an immediately-finished
    /// stream, which is what the harness has always done and what keeps a chat
    /// or change stream from hanging.
    ///
    /// A Work task that is *not* terminal is the exception, and it has to be:
    /// `NativeWorkModel.follow` reconnects as soon as a stream ends and only
    /// stops when the task reaches a terminal status. Finishing the stream for a
    /// running task therefore puts the model into a 200ms reconnect loop that
    /// burns a core for as long as the window is open — during which every
    /// screenshot is taken against a view that is being rebuilt underneath it.
    /// Holding the stream open is also the more faithful fixture: a running task
    /// really does have a stream that has not ended.
    private nonisolated func streamBytes(for path: String) -> AsyncThrowingStream<UInt8, any Error> {
        guard path.hasPrefix("/api/work/sessions/"), path.hasSuffix("/events"),
            PreviewWorkFixtures.liveSessionIDs.contains(Self.workSessionID(in: path) ?? "")
        else {
            return AsyncThrowingStream { $0.finish() }
        }
        // Deliberately never finished. The consuming task is cancelled when the
        // model closes the stream, which terminates this one with it.
        return AsyncThrowingStream { _ in }
    }

    /// `wk-invoices` out of `/api/work/sessions/wk-invoices/events`.
    private nonisolated static func workSessionID(in path: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count >= 4, parts[0] == "api", parts[1] == "work", parts[2] == "sessions"
        else { return nil }
        return String(parts[3])
    }

    /// Minimal, valid canned bodies keyed by path so any incidental call from a
    /// real code path decodes cleanly. Never fetched from a server.
    private func cannedBody(for path: String) -> Data {
        if path == "/api/work/artifacts" {
            return PreviewWorkFixtures.artifactsBody(sessionID: PreviewWorkFixtures.openSessionID)
        }
        if path.hasPrefix("/api/work/artifacts/") {
            return PreviewWorkFixtures.artifactDetailBody(id: "art-exceptions")
        }
        if path.hasPrefix("/api/work/hosts") {
            return PreviewWorkFixtures.hostsBody(empty: empty)
        }
        // Both before the session route, which matches the same prefix and would
        // otherwise answer a start with a session and a message with a task
        // list — bodies whose own decoders correctly refuse them.
        if path.hasPrefix("/api/work/sessions"), path.hasSuffix("/runs") {
            return PreviewWorkFixtures.startedRunBody(
                sessionID: Self.workSessionID(in: path) ?? PreviewWorkFixtures.openSessionID
            )
        }
        if path.hasPrefix("/api/work/sessions"), path.hasSuffix("/answer") {
            return PreviewWorkFixtures.instructionOutcomeBody
        }
        if path.hasPrefix("/api/work/sessions") {
            if let sessionID = Self.workSessionID(in: path) {
                return PreviewWorkFixtures.sessionBody(id: sessionID, empty: empty)
            }
            return PreviewWorkFixtures.sessionsBody(empty: empty)
        }
        if path.contains("/memory") {
            return Data(#"{"memories":[],"summary":null}"#.utf8)
        }
        if path.hasPrefix("/api/library") {
            return Data(#"{"items":[],"attachments":[]}"#.utf8)
        }
        if path.contains("/mutations") {
            return Data(#"{"entity":{"id":"preview","revision":1},"entityMappings":{}}"#.utf8)
        }
        if path.hasSuffix("/models") {
            return Data(PreviewModelCatalog.json.utf8)
        }
        return Data("{}".utf8)
    }
}

/// A synthetic model manifest in the exact v1 wire shape, covering every state
/// the pickers have to render: Auto, a full reasoning ladder, a restricted
/// two-tier model, an on/off model, a model with no reasoning at all, a
/// plan-gated model, a coming-soon model, and a deliberately long name. It
/// exists so those states can be inspected without an account or a network.
public enum PreviewModelCatalog {
    public static let json = """
    {
      "manifestVersion": "v1-preview",
      "contractDigest": "\(String(repeating: "a", count: 64))",
      "generatedAt": "2026-07-20T12:00:00.000Z",
      "models": [
        \(model(
            id: "juno:auto", provider: "juno", providerName: "Juno", name: "Auto",
            description: "Picks the cheapest model and thinking depth that can handle each prompt.",
            highlights: [
                "Short or simple asks go to budget models, answered instantly.",
                "Coding and analysis go to the mid tier with light thinking.",
                "Hard reasoning goes to a flagship with deep thinking.",
            ],
            context: nil, cost: nil, speed: nil, intelligence: nil,
            efforts: [], canDisable: true, reasoning: true, automatic: true
        )),
        \(model(
            id: "anthropic:claude-opus-4-8", provider: "anthropic",
            providerName: "Anthropic · Claude", name: "Claude Opus 4.8",
            description: "Anthropic's most capable model for deep reasoning and long agentic work.",
            context: 500_000, cost: "premium", speed: 3, intelligence: 10,
            efforts: ["low", "medium", "high", "xhigh", "max"], canDisable: true, reasoning: true,
            // The one Anthropic model with a real fast tier, so the preview
            // harness actually renders a Flash toggle. It stamped every model
            // with no modes at all, which would have let a screenshot review
            // report "no regression" for a feature that never drew.
            fastRateMultiplier: 2
        )),
        \(model(
            id: "anthropic:claude-haiku-4-5", provider: "anthropic",
            providerName: "Anthropic · Claude", name: "Claude Haiku 4.5",
            description: "Fast and cheap, with a single thinking mode rather than depths.",
            context: 200_000, cost: "economy", speed: 9, intelligence: 6,
            efforts: [], canDisable: true, reasoning: true, onOffOnly: true
        )),
        \(model(
            id: "openai:gpt-5-6", provider: "openai", providerName: "OpenAI · GPT",
            name: "GPT-5.6",
            description: "OpenAI's flagship with a six-step effort ladder.",
            context: 400_000, cost: "standard", speed: 6, intelligence: 9,
            efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
            canDisable: true, reasoning: true,
            // The only line with both, so the preview shows the two toggles
            // side by side — the layout most likely to clip.
            proMode: true, fastRateMultiplier: 2
        )),
        \(model(
            id: "openai:gpt-5-4-pro", provider: "openai", providerName: "OpenAI · GPT",
            name: "GPT-5.4 Pro",
            description: "Always reasons; only the deeper half of the ladder is available.",
            context: 400_000, cost: "premium", speed: 2, intelligence: 10,
            efforts: ["medium", "high", "xhigh"], canDisable: false, reasoning: true,
            legacy: true, released: "2026-03"
        )),
        \(model(
            id: "google:gemini-3-flash", provider: "google", providerName: "Google · Gemini",
            name: "Gemini 3 Flash",
            description: "A quick non-reasoning model for everyday questions.",
            context: 1_000_000, cost: "economy", speed: 10, intelligence: 6,
            efforts: [], canDisable: true, reasoning: false,
            legacy: true, released: "2025-12"
        )),
        \(model(
            id: "moonshot:kimi-k3", provider: "moonshot", providerName: "Moonshot · Kimi",
            name: "Kimi K3",
            description: "Moonshot's flagship — a 2.5T-parameter reasoner with 1M context.",
            context: 1_000_000, cost: "premium", speed: 2, intelligence: 10,
            efforts: ["low", "high", "max"], canDisable: false, reasoning: true
        )),
        \(model(
            id: "xai:grok-5", provider: "xai", providerName: "xAI · Grok", name: "Grok 5",
            description: "Plan-gated in this fixture so the locked state can be inspected.",
            context: 256_000, cost: "premium", speed: 5, intelligence: 9,
            efforts: ["low", "high"], canDisable: true, reasoning: true,
            availability: "requires_plan", requiredPlan: "max"
        )),
        \(model(
            id: "meta:llama-5-405b-instruct-preview", provider: "meta",
            providerName: "Meta · Llama",
            name: "Llama 5 405B Instruct Preview (Research Release)",
            description: "A deliberately long name, for truncation behaviour.",
            context: 128_000, cost: "standard", speed: 4, intelligence: 8,
            efforts: [], canDisable: true, reasoning: false,
            legacy: true, released: "2025-10"
        )),
        \(model(
            id: "mistral:mistral-large-3", provider: "mistral",
            providerName: "Mistral · Le Chat", name: "Mistral Large 3",
            description: "Announced but not yet callable.",
            context: 256_000, cost: "standard", speed: 7, intelligence: 7,
            efforts: [], canDisable: true, reasoning: false,
            availability: "coming_soon"
        )),
        \(model(
            id: "deepseek:deepseek-v4", provider: "deepseek", providerName: "DeepSeek",
            name: "DeepSeek V4",
            description: "An open-weight reasoner.",
            context: 128_000, cost: "economy", speed: 6, intelligence: 8,
            efforts: ["low", "medium", "high"], canDisable: true, reasoning: true
        ))
      ]
    }
    """

    // swiftlint:disable:next function_parameter_count
    private static func model(
        id: String,
        provider: String,
        providerName: String,
        name: String,
        description: String,
        highlights: [String] = [],
        context: Int?,
        cost: String?,
        speed: Int? = nil,
        intelligence: Int? = nil,
        efforts: [String],
        canDisable: Bool,
        reasoning: Bool,
        onOffOnly: Bool = false,
        automatic: Bool = false,
        availability: String = "available",
        requiredPlan: String = "free",
        modality: String = "chat",
        legacy: Bool = false,
        released: String? = nil,
        proMode: Bool = false,
        fastRateMultiplier: Double? = nil
    ) -> String {
        let highlightsJSON = highlights.isEmpty
            ? "null"
            : "[" + highlights.map { "\"\($0)\"" }.joined(separator: ",") + "]"
        let pricing = cost.map {
            """
            {"class":"\($0)","inputPerMillion":3,"outputPerMillion":15,"currency":"USD","source":"official"}
            """
        } ?? "null"
        let metrics = (speed != nil && intelligence != nil)
            ? "{\"speed\":\(speed!),\"intelligence\":\(intelligence!)}"
            : "null"
        return """
        {
          "id": "\(id)",
          "provider": {"id":"\(provider)","displayName":"\(providerName)"},
          "displayName": "\(name)",
          "description": "\(description)",
          "highlights": \(highlightsJSON),
          "lifecycle": "\(legacy ? "legacy" : "active")",
          "modality": "\(modality)",
          "legacy": \(legacy),
          "released": \(released.map { "\"\($0)\"" } ?? "null"),
          "availability": "\(availability)",
          "minimumPlan": "free",
          "requiredPlan": "\(requiredPlan)",
          "modalities": {"input":["text","image"],"output":["text"]},
          "contextWindowTokens": \(context.map(String.init) ?? "null"),
          "pricing": \(pricing),
          "metrics": \(metrics),
          "supportedReasoningEfforts": [\(efforts.map { "\"\($0)\"" }.joined(separator: ","))],
          "reasoning": {
            "supported": \(reasoning), "canDisable": \(canDisable),
            "onOffOnly": \(onOffOnly), "supportsProMode": \(proMode), "automatic": \(automatic)
          },
          "capabilities": {
            "tools": true, "vision": true, "webSearch": true,
            "attachments": true, "streaming": true
          },
          "fastMode": \(fastRateMultiplier.map { "{\"rateMultiplier\": \($0)}" } ?? "null"),
          "deprecationNote": null
        }
        """
    }
}
#endif
