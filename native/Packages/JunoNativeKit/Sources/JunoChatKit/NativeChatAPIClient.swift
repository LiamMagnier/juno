import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

public enum NativeReasoningEffort: String, CaseIterable, Codable, Identifiable,
    Sendable
{
    case minimal
    case low
    case medium
    case high
    case xhigh
    case max

    public var id: String { rawValue }
}

/// The 1–10 grades the server publishes for a model. Never synthesized on the
/// client: a model without real numbers (Auto, which is a router) has none.
public struct NativeModelGrades: Equatable, Sendable {
    public let speed: Int
    public let intelligence: Int

    public init(speed: Int, intelligence: Int) {
        self.speed = speed
        self.intelligence = intelligence
    }
}

public struct NativeModelPricing: Equatable, Sendable {
    /// "economy" | "standard" | "premium" — the server's relative cost class.
    public let priceClass: String
    public let inputPerMillion: Double
    public let outputPerMillion: Double
    public let currency: String

    public init(
        priceClass: String,
        inputPerMillion: Double,
        outputPerMillion: Double,
        currency: String
    ) {
        self.priceClass = priceClass
        self.inputPerMillion = inputPerMillion
        self.outputPerMillion = outputPerMillion
        self.currency = currency
    }
}

/// Why a model in the manifest cannot be selected right now. The server decides
/// this — the client only renders the explanation.
public enum NativeModelUnavailability: Equatable, Sendable {
    case comingSoon
    /// The account's plan cannot call it; the payload names the plan that can.
    case requiresPlan(String)
    /// Present in the manifest but not a streaming chat model (image/video gen).
    case notAChatModel
}

public struct NativeChatModelOption: Identifiable, Equatable, Sendable {
    public let id: String
    public let providerID: String
    public let providerName: String
    public let displayName: String
    public let summary: String?
    /// Product-authored bullets. Non-empty only for Auto today.
    public let highlights: [String]
    public let minimumPlan: String
    /// The plan the chat route actually enforces (paid models are Pro-floored).
    public let requiredPlan: String
    public let availability: String
    public let lifecycle: String
    /// What the model produces: "chat", "image" or "video". Drives the picker's
    /// top-level sections.
    public let modality: String
    /// Superseded within its family — collapsed behind "Older models" rather
    /// than interleaved with the current generation.
    public let isLegacy: Bool
    /// "YYYY-MM", or nil when the lab never published one.
    public let released: String?
    public let contextWindowTokens: Int?
    public let pricing: NativeModelPricing?
    public let grades: NativeModelGrades?
    public let supportedReasoningEfforts: [NativeReasoningEffort]
    public let canDisableReasoning: Bool
    public let supportsReasoning: Bool
    /// One thinking state rather than depths (GLM-4.6, Haiku 4.5): the server
    /// takes `high` as "on" and nothing as "off", and publishes no tiers.
    public let isOnOffReasoningOnly: Bool
    /// True only for Auto: the server picks the thinking depth per message, so
    /// the client must offer no slider and send no effort.
    public let choosesReasoningAutomatically: Bool
    public let supportsStreaming: Bool
    public let supportsVision: Bool
    public let supportsWebSearch: Bool
    public let supportsTools: Bool
    public let supportsAttachments: Bool
    public let deprecationNote: String?

    /// A streaming chat model — the only kind this composer can send to. Image
    /// and video generation entries share the manifest but are not selectable
    /// here, and are not "unavailable" either; they are a different product.
    public var isChatCapable: Bool { supportsStreaming }

    public var isAvailable: Bool {
        availability == "available" && supportsStreaming
    }

    public var unavailability: NativeModelUnavailability? {
        if !supportsStreaming { return .notAChatModel }
        switch availability {
        case "available": return nil
        case "coming_soon": return .comingSoon
        default: return .requiresPlan(requiredPlan)
        }
    }

    public init(
        id: String,
        providerID: String,
        providerName: String,
        displayName: String,
        summary: String? = nil,
        highlights: [String] = [],
        minimumPlan: String,
        requiredPlan: String = "",
        availability: String,
        lifecycle: String = "active",
        modality: String = "chat",
        isLegacy: Bool = false,
        released: String? = nil,
        contextWindowTokens: Int? = nil,
        pricing: NativeModelPricing? = nil,
        grades: NativeModelGrades? = nil,
        supportedReasoningEfforts: [NativeReasoningEffort],
        canDisableReasoning: Bool,
        supportsReasoning: Bool = false,
        isOnOffReasoningOnly: Bool = false,
        choosesReasoningAutomatically: Bool = false,
        supportsStreaming: Bool,
        supportsVision: Bool = false,
        supportsWebSearch: Bool = false,
        supportsTools: Bool = false,
        supportsAttachments: Bool = false,
        deprecationNote: String? = nil
    ) {
        self.id = id
        self.providerID = providerID
        self.providerName = providerName
        self.displayName = displayName
        self.summary = summary
        self.highlights = highlights
        self.minimumPlan = minimumPlan
        self.requiredPlan = requiredPlan.isEmpty ? minimumPlan : requiredPlan
        self.availability = availability
        self.lifecycle = lifecycle
        self.modality = modality
        self.isLegacy = isLegacy
        self.released = released
        self.contextWindowTokens = contextWindowTokens
        self.pricing = pricing
        self.grades = grades
        self.supportedReasoningEfforts = supportedReasoningEfforts
        self.canDisableReasoning = canDisableReasoning
        self.supportsReasoning = supportsReasoning
        self.isOnOffReasoningOnly = isOnOffReasoningOnly
        self.choosesReasoningAutomatically = choosesReasoningAutomatically
        self.supportsStreaming = supportsStreaming
        self.supportsVision = supportsVision
        self.supportsWebSearch = supportsWebSearch
        self.supportsTools = supportsTools
        self.supportsAttachments = supportsAttachments
        self.deprecationNote = deprecationNote
    }
}

public struct NativeChatModelCatalog: Equatable, Sendable {
    public let manifestVersion: String
    public let contractDigest: String
    public let generatedAt: Date
    public let models: [NativeChatModelOption]
}

public struct NativeAppendedUserMessage: Equatable, Sendable {
    public let id: String
    public let clientID: String
    public let content: String
    public let createdAt: Date
}

public struct NativeChatSource: Equatable, Sendable {
    public let title: String
    public let url: URL
    public let snippet: String
}

public enum NativeChatFinishReason: String, Equatable, Sendable {
    case stop
    case length
    case networkError = "network_error"
    case contextWindowExceeded = "model_context_window_exceeded"
    case sensitive
    case toolCalls = "tool_calls"
    case userStopped = "user_stopped"
    case error
    case unknown
}

public struct NativeCompletedChatMessage: Equatable, Sendable {
    public let id: String
    public let content: String
    public let reasoning: String?
    public let model: String?
    public let createdAt: Date
    public let sources: [NativeChatSource]
    public let finishReason: NativeChatFinishReason
}

/// A step the server reports while working, mirroring the web's
/// `ClientActivityEvent`.
///
/// Deep research is where these matter: PLAN → SEARCH → READ runs for tens of
/// seconds before a single token of the report is streamed, and without these
/// the screen shows an empty bubble and a spinner for the whole prep phase. The
/// same events also carry the warning emitted when research degrades to plain
/// chat, which the reader has to see or the answer silently is not researched.
public struct NativeChatActivity: Equatable, Sendable, Identifiable {
    public enum Kind: String, Equatable, Sendable {
        case context, model, reasoning, search, visit, write, usage, done, warning, tool
        /// A kind this build does not know. Kept rather than dropped so a
        /// server that adds one does not make the step vanish from the screen.
        case unknown
    }

    public let id: String
    public let kind: Kind
    public let title: String
    public let detail: String?
    public let url: String?

    public init(id: String, kind: Kind, title: String, detail: String?, url: String?) {
        self.id = id
        self.kind = kind
        self.title = title
        self.detail = detail
        self.url = url
    }
}

public enum NativeChatServerEvent: Equatable, Sendable {
    case metadata(
        conversationID: String,
        userMessageID: String?,
        title: String,
        generationID: String?
    )
    case title(conversationID: String, title: String)
    case textDelta(String)
    case reasoningDelta(String)
    case sources([NativeChatSource])
    case activity(NativeChatActivity)
    case completed(NativeCompletedChatMessage)
    case failed(
        message: String,
        finishReason: NativeChatFinishReason,
        generationID: String?,
        userMessageID: String?
    )
    case ping
}

public struct NativeChatGenerationRequest: Equatable, Sendable {
    public let conversationID: String
    public let modelID: String
    public let reasoningEffort: NativeReasoningEffort?
    public let generationID: String
    /// Runs the server's PLAN → SEARCH → READ → SYNTHESIS pipeline instead of a
    /// plain turn. This is the same switch the web sets; the research itself is
    /// server-side, so parity is sending the flag and rendering what comes
    /// back, not reimplementing the pipeline.
    public let deepResearch: Bool

    public init(
        conversationID: String,
        modelID: String,
        reasoningEffort: NativeReasoningEffort?,
        generationID: String,
        deepResearch: Bool = false
    ) {
        self.conversationID = conversationID
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.generationID = generationID
        self.deepResearch = deepResearch
    }
}

public enum NativeChatAPIError: Error, Equatable, LocalizedError, Sendable {
    case invalidIdentifier(String)
    case invalidMessage
    case malformedResponse
    case invalidContentType
    case eventLineTooLarge
    case eventPayloadTooLarge
    case streamEndedWithoutTerminalEvent
    case server(
        statusCode: Int,
        code: String?,
        message: String,
        retryable: Bool
    )

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier:
            "Juno could not safely address this conversation."
        case .invalidMessage:
            "Enter a message before sending."
        case .malformedResponse, .invalidContentType,
             .eventLineTooLarge, .eventPayloadTooLarge:
            "Juno returned an invalid chat response."
        case .streamEndedWithoutTerminalEvent:
            "The live response was interrupted. Juno is reconnecting to saved data."
        case .server(_, _, let message, _):
            message
        }
    }

    public var isRetryable: Bool {
        switch self {
        case .server(_, _, _, let retryable): retryable
        case .streamEndedWithoutTerminalEvent: true
        default: false
        }
    }
}

public protocol NativeChatRequestSending: NativeAuthenticatedRequestSending,
    NativeAuthenticatedByteStreaming {}

extension NativeAuthRuntime: NativeChatRequestSending {}

/// Uses the existing bearer-capable Web chat routes. User turns are first
/// appended through the existing idempotent transcript endpoint; `/api/chat`
/// then regenerates from that authoritative final user row. A dropped SSE is
/// never re-POSTed automatically, so reconnect cannot duplicate or double-bill
/// a generation that continues on the server.
public struct NativeChatAPIClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending
    private let streamer: any NativeAuthenticatedByteStreaming

    public init(
        sender: any NativeAuthenticatedRequestSending,
        streamer: any NativeAuthenticatedByteStreaming
    ) {
        self.sender = sender
        self.streamer = streamer
    }

    public init(transport: any NativeChatRequestSending) {
        sender = transport
        streamer = transport
    }

    public func modelCatalog(for accountID: AccountID) async throws
        -> NativeChatModelCatalog
    {
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/v1/models"),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(response)
        }
        let wire: ModelCatalogWire
        do { wire = try JSONDecoder().decode(ModelCatalogWire.self, from: response.body) }
        catch { throw NativeChatAPIError.malformedResponse }
        guard validText(wire.manifestVersion, maximum: 128),
            wire.contractDigest.count == 64,
            wire.contractDigest.utf8.allSatisfy(Self.isLowercaseHex),
            let generatedAt = parseDate(wire.generatedAt),
            wire.models.count <= 1_000
        else { throw NativeChatAPIError.malformedResponse }

        var identifiers = Set<String>()
        let models = try wire.models.map { model -> NativeChatModelOption in
            guard validText(model.id, maximum: 200), identifiers.insert(model.id).inserted,
                validText(model.provider.id, maximum: 100),
                validText(model.provider.displayName, maximum: 200),
                validText(model.displayName, maximum: 300),
                validText(model.minimumPlan, maximum: 40),
                validText(model.availability, maximum: 40)
            else { throw NativeChatAPIError.malformedResponse }
            let efforts = try model.supportedReasoningEfforts.map { value in
                guard let effort = NativeReasoningEffort(rawValue: value) else {
                    throw NativeChatAPIError.malformedResponse
                }
                return effort
            }
            guard Set(efforts).count == efforts.count else {
                throw NativeChatAPIError.malformedResponse
            }
            // Grades are presentation-critical (the detail panel draws bars from
            // them), so a nonsense range is a malformed manifest rather than
            // something to clamp into looking real.
            if let metrics = model.metrics {
                guard (1...10).contains(metrics.speed),
                    (1...10).contains(metrics.intelligence)
                else { throw NativeChatAPIError.malformedResponse }
            }
            if let context = model.contextWindowTokens, context <= 0 {
                throw NativeChatAPIError.malformedResponse
            }
            let automatic = model.reasoning.automatic ?? false
            // A model that routes its own thinking must not also publish tiers —
            // the two together have no coherent meaning for the slider.
            guard !automatic || efforts.isEmpty else {
                throw NativeChatAPIError.malformedResponse
            }
            return NativeChatModelOption(
                id: model.id,
                providerID: model.provider.id,
                providerName: model.provider.displayName,
                displayName: model.displayName,
                summary: nonEmpty(model.description, maximum: 600),
                highlights: (model.highlights ?? []).compactMap {
                    nonEmpty($0, maximum: 300)
                },
                minimumPlan: model.minimumPlan,
                requiredPlan: nonEmpty(model.requiredPlan, maximum: 40) ?? model.minimumPlan,
                availability: model.availability,
                lifecycle: nonEmpty(model.lifecycle, maximum: 40) ?? "active",
                modality: nonEmpty(model.modality, maximum: 40) ?? "chat",
                // A manifest without the flag is an older server; fall back to
                // the lifecycle it has always sent.
                isLegacy: model.legacy ?? (model.lifecycle.map { $0 != "active" } ?? false),
                released: nonEmpty(model.released, maximum: 20),
                contextWindowTokens: model.contextWindowTokens,
                pricing: model.pricing.map {
                    NativeModelPricing(
                        priceClass: $0.class,
                        inputPerMillion: $0.inputPerMillion,
                        outputPerMillion: $0.outputPerMillion,
                        currency: $0.currency
                    )
                },
                grades: model.metrics.map {
                    NativeModelGrades(speed: $0.speed, intelligence: $0.intelligence)
                },
                supportedReasoningEfforts: efforts,
                canDisableReasoning: model.reasoning.canDisable,
                supportsReasoning: model.reasoning.supported ?? !efforts.isEmpty,
                isOnOffReasoningOnly: model.reasoning.onOffOnly ?? false,
                choosesReasoningAutomatically: automatic,
                supportsStreaming: model.capabilities.streaming,
                supportsVision: model.capabilities.vision ?? false,
                supportsWebSearch: model.capabilities.webSearch ?? false,
                supportsTools: model.capabilities.tools ?? false,
                supportsAttachments: model.capabilities.attachments ?? false,
                deprecationNote: nonEmpty(model.deprecationNote, maximum: 400)
            )
        }
        return NativeChatModelCatalog(
            manifestVersion: wire.manifestVersion,
            contractDigest: wire.contractDigest,
            generatedAt: generatedAt,
            // Server order, verbatim. The manifest is already sorted the way the
            // web selector sorts (lab, then intelligence), and Auto leads it;
            // re-sorting here would put Auto under "J" and make the app's list
            // disagree with the website's for the same account.
            models: models
        )
    }

    public func appendUserMessage(
        conversationID: String,
        clientID: String,
        content: String,
        attachmentIDs: [String] = [],
        for accountID: AccountID
    ) async throws -> NativeAppendedUserMessage {
        try requireIdentifier(conversationID)
        try requireIdentifier(clientID)
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw NativeChatAPIError.invalidMessage }
        let requestBody = AppendRequestWire(turns: [AppendTurnWire(
            clientId: clientID,
            role: "USER",
            content: trimmed,
            attachmentIds: attachmentIDs.isEmpty ? nil : attachmentIDs
        )])
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/conversations/\(conversationID)/messages",
                method: .post,
                headers: try HTTPHeaders(["Content-Type": "application/json"]),
                body: try JSONEncoder().encode(requestBody)
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(response)
        }
        let wire: AppendResponseWire
        do { wire = try JSONDecoder().decode(AppendResponseWire.self, from: response.body) }
        catch { throw NativeChatAPIError.malformedResponse }
        guard wire.conversationId == conversationID, wire.messages.count == 1,
            let message = wire.messages.first,
            message.clientId == clientID, message.role == "USER",
            validText(message.id, maximum: 256),
            let createdAt = parseDate(message.createdAt)
        else { throw NativeChatAPIError.malformedResponse }
        return NativeAppendedUserMessage(
            id: message.id,
            clientID: clientID,
            content: message.content,
            createdAt: createdAt
        )
    }

    public func generationEvents(
        _ request: NativeChatGenerationRequest,
        for accountID: AccountID
    ) async throws -> AsyncThrowingStream<NativeChatServerEvent, any Error> {
        try requireIdentifier(request.conversationID)
        try requireIdentifier(request.modelID)
        try requireIdentifier(request.generationID)
        let body = GenerationRequestWire(
            conversationId: request.conversationID,
            model: request.modelID,
            regenerate: true,
            reasoningEffort: request.reasoningEffort?.rawValue,
            generationId: request.generationID,
            client: "app",
            deepResearch: request.deepResearch ? true : nil
        )
        let response = try await streamer.stream(
            try NativeBearerRequest(
                path: "/api/chat",
                method: .post,
                headers: try HTTPHeaders([
                    "Accept": "text/event-stream",
                    "Content-Type": "application/json",
                ]),
                body: try JSONEncoder().encode(body)
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw try await serverError(response)
        }
        guard response.headers["content-type"]?.lowercased()
            .hasPrefix("text/event-stream") == true
        else { throw NativeChatAPIError.invalidContentType }

        return AsyncThrowingStream { continuation in
            let relay = Task {
                do {
                    var parser = ChatSSEParser()
                    var terminal = false
                    for try await byte in response.bytes {
                        for payload in try parser.consume(byte) {
                            let event = try decodeEvent(payload)
                            continuation.yield(event)
                            if event.isTerminal { terminal = true }
                        }
                    }
                    for payload in try parser.finish() {
                        let event = try decodeEvent(payload)
                        continuation.yield(event)
                        if event.isTerminal { terminal = true }
                    }
                    guard terminal else {
                        throw NativeChatAPIError.streamEndedWithoutTerminalEvent
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in relay.cancel() }
        }
    }

    public func cancelGeneration(
        id: String,
        for accountID: AccountID
    ) async throws -> Bool {
        try requireIdentifier(id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/chat/cancel",
                method: .post,
                headers: try HTTPHeaders(["Content-Type": "application/json"]),
                body: try JSONEncoder().encode(CancelRequestWire(generationId: id))
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(response)
        }
        guard let wire = try? JSONDecoder().decode(CancelResponseWire.self, from: response.body),
            wire.ok
        else { throw NativeChatAPIError.malformedResponse }
        return wire.cancelled
    }

    private func decodeEvent(_ payload: Data) throws -> NativeChatServerEvent {
        let envelope: EventEnvelopeWire
        do { envelope = try JSONDecoder().decode(EventEnvelopeWire.self, from: payload) }
        catch { throw NativeChatAPIError.malformedResponse }
        switch envelope.type {
        case "meta":
            guard let conversationID = envelope.conversationId,
                let title = envelope.title,
                validText(conversationID, maximum: 256),
                validText(title, maximum: 1_000)
            else { throw NativeChatAPIError.malformedResponse }
            return .metadata(
                conversationID: conversationID,
                userMessageID: envelope.userMessageId,
                title: title,
                generationID: envelope.generationId
            )
        case "title":
            guard let conversationID = envelope.conversationId,
                let title = envelope.title,
                validText(conversationID, maximum: 256),
                validText(title, maximum: 1_000)
            else { throw NativeChatAPIError.malformedResponse }
            return .title(conversationID: conversationID, title: title)
        case "delta":
            guard let text = envelope.text,
                text.utf8.count <= 64 * 1_024
            else { throw NativeChatAPIError.malformedResponse }
            return .textDelta(text)
        case "reasoning":
            guard let text = envelope.text,
                text.utf8.count <= 64 * 1_024
            else { throw NativeChatAPIError.malformedResponse }
            return .reasoningDelta(text)
        case "sources":
            guard let sources = envelope.sources, sources.count <= 100 else {
                throw NativeChatAPIError.malformedResponse
            }
            return .sources(try sources.map(decodeSource))
        case "done":
            guard let message = envelope.message,
                validText(message.id, maximum: 256),
                message.role == "ASSISTANT",
                message.content.utf8.count <= 4 * 1_024 * 1_024,
                let createdAt = parseDate(message.createdAt)
            else { throw NativeChatAPIError.malformedResponse }
            let reason = NativeChatFinishReason(
                rawValue: envelope.finishReason ?? message.finishReason ?? "unknown"
            ) ?? .unknown
            return .completed(NativeCompletedChatMessage(
                id: message.id,
                content: message.content,
                reasoning: message.reasoning,
                model: message.model,
                createdAt: createdAt,
                sources: try (message.sources ?? envelope.sources ?? []).map(decodeSource),
                finishReason: reason
            ))
        case "error":
            guard let message = envelope.messageText ?? envelope.error,
                validText(message, maximum: 32 * 1_024)
            else { throw NativeChatAPIError.malformedResponse }
            return .failed(
                message: message,
                finishReason: NativeChatFinishReason(
                    rawValue: envelope.finishReason ?? "error"
                ) ?? .error,
                generationID: envelope.generationId,
                userMessageID: envelope.userMessageId
            )
        case "activity":
            guard let event = envelope.event else { return .ping }
            return .activity(NativeChatActivity(
                id: event.id,
                kind: NativeChatActivity.Kind(rawValue: event.kind) ?? .unknown,
                title: event.title,
                detail: event.detail,
                url: event.url
            ))
        case "ping", "progress":
            return .ping
        default:
            throw NativeChatAPIError.malformedResponse
        }
    }

    private func decodeSource(_ wire: SourceWire) throws -> NativeChatSource {
        guard validText(wire.title, maximum: 2_000),
            wire.snippet.utf8.count <= 32 * 1_024,
            let url = URL(string: wire.url),
            let scheme = url.scheme?.lowercased(),
            scheme == "https" || scheme == "http",
            url.host != nil
        else { throw NativeChatAPIError.malformedResponse }
        return NativeChatSource(title: wire.title, url: url, snippet: wire.snippet)
    }

    private func serverError(_ response: HTTPResponse) -> NativeChatAPIError {
        let body = try? JSONDecoder().decode(ServerErrorWire.self, from: response.body)
        let message = body?.message ?? body?.error ?? HTTPURLResponse.localizedString(
            forStatusCode: response.statusCode
        )
        return .server(
            statusCode: response.statusCode,
            code: body?.code,
            message: message,
            retryable: body?.retryable ?? (
                response.statusCode == 408
                    || response.statusCode == 409
                    || response.statusCode == 429
                    || response.statusCode >= 500
            )
        )
    }

    private func serverError(_ response: HTTPByteStreamResponse) async throws
        -> NativeChatAPIError
    {
        var data = Data()
        for try await byte in response.bytes {
            guard data.count < 64 * 1_024 else {
                throw NativeChatAPIError.eventPayloadTooLarge
            }
            data.append(byte)
        }
        return serverError(HTTPResponse(
            statusCode: response.statusCode,
            headers: response.headers,
            body: data
        ))
    }

    private func requireIdentifier(_ value: String) throws {
        guard validText(value, maximum: 256), value.utf8.allSatisfy({ byte in
            switch byte {
            case 48...57, 65...90, 97...122, 45, 46, 58, 95: true
            default: false
            }
        }) else { throw NativeChatAPIError.invalidIdentifier(value) }
    }

    private func validText(_ value: String, maximum: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= maximum
            && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    /// Optional descriptive copy: absent, blank, or over-long all collapse to
    /// nil. These fields decorate the UI rather than drive it, so an oversized
    /// one is dropped instead of failing the whole manifest.
    private func nonEmpty(_ value: String?, maximum: Int) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard validText(trimmed, maximum: maximum) else { return nil }
        return trimmed
    }

    private func parseDate(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = precise.date(from: value) { return value }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value)
    }

    private static func isLowercaseHex(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (97...102).contains(byte)
    }
}

private extension NativeChatServerEvent {
    var isTerminal: Bool {
        switch self {
        case .completed, .failed: true
        default: false
        }
    }
}

private struct ModelCatalogWire: Decodable {
    struct Model: Decodable {
        struct Provider: Decodable { let id: String; let displayName: String }
        struct Reasoning: Decodable {
            let supported: Bool?
            let canDisable: Bool
            let onOffOnly: Bool?
            let automatic: Bool?
        }
        struct Capabilities: Decodable {
            let streaming: Bool
            let vision: Bool?
            let webSearch: Bool?
            let tools: Bool?
            let attachments: Bool?
        }
        struct Pricing: Decodable {
            let `class`: String
            let inputPerMillion: Double
            let outputPerMillion: Double
            let currency: String
        }
        struct Metrics: Decodable { let speed: Int; let intelligence: Int }
        let id: String
        let provider: Provider
        let displayName: String
        let description: String?
        let highlights: [String]?
        let availability: String
        let lifecycle: String?
        let modality: String?
        let legacy: Bool?
        let released: String?
        let minimumPlan: String
        let requiredPlan: String?
        let contextWindowTokens: Int?
        let pricing: Pricing?
        let metrics: Metrics?
        let supportedReasoningEfforts: [String]
        let reasoning: Reasoning
        let capabilities: Capabilities
        let deprecationNote: String?
    }
    let manifestVersion: String
    let contractDigest: String
    let generatedAt: String
    let models: [Model]
}

private struct AppendRequestWire: Encodable { let turns: [AppendTurnWire] }
private struct AppendTurnWire: Encodable {
    let clientId: String
    let role: String
    let content: String
    /// Omitted entirely when empty — the route's schema is `.strict()`, and an
    /// empty array would still be a claim of zero attachments rather than no
    /// claim at all.
    let attachmentIds: [String]?
}
private struct AppendResponseWire: Decodable {
    struct Message: Decodable {
        let clientId: String
        let id: String
        let role: String
        let content: String
        let createdAt: String
    }
    let conversationId: String
    let messages: [Message]
}
private struct GenerationRequestWire: Encodable {
    let conversationId: String
    let model: String
    let regenerate: Bool
    let reasoningEffort: String?
    let generationId: String
    let client: String
    /// Omitted when false so a plain turn's body is byte-identical to what it
    /// was before deep research existed.
    let deepResearch: Bool?
}
private struct CancelRequestWire: Encodable { let generationId: String }
private struct CancelResponseWire: Decodable { let ok: Bool; let cancelled: Bool }

private struct SourceWire: Decodable {
    let title: String
    let url: String
    let snippet: String
}

private struct EventEnvelopeWire: Decodable {
    struct ActivityWire: Decodable {
        let id: String
        let kind: String
        let title: String
        let detail: String?
        let url: String?
    }
    struct Message: Decodable {
        let id: String
        let role: String
        let content: String
        let reasoning: String?
        let model: String?
        let createdAt: String
        let sources: [SourceWire]?
        let finishReason: String?
    }
    let type: String
    let conversationId: String?
    let userMessageId: String?
    let title: String?
    let generationId: String?
    let text: String?
    let sources: [SourceWire]?
    let message: Message?
    let messageText: String?
    let event: ActivityWire?
    let error: String?
    let finishReason: String?

    private enum CodingKeys: String, CodingKey {
        case type, conversationId, userMessageId, title, generationId, text,
             sources, message, event, error, finishReason
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
        userMessageId = try container.decodeIfPresent(String.self, forKey: .userMessageId)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        generationId = try container.decodeIfPresent(String.self, forKey: .generationId)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        sources = try container.decodeIfPresent([SourceWire].self, forKey: .sources)
        message = try? container.decodeIfPresent(Message.self, forKey: .message)
        messageText = try? container.decodeIfPresent(String.self, forKey: .message)
        // Tolerant on purpose: an activity payload this build cannot read must
        // not fail the whole stream, since the report itself is unaffected.
        event = try? container.decodeIfPresent(ActivityWire.self, forKey: .event)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        finishReason = try container.decodeIfPresent(String.self, forKey: .finishReason)
    }
}

private struct ServerErrorWire: Decodable {
    private struct Detail: Decodable {
        let code: String?
        let message: String?
        let retryable: Bool?
    }

    let error: String?
    let message: String?
    let code: String?
    let retryable: Bool?

    private enum CodingKeys: String, CodingKey {
        case error, message, code, retryable
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let detail = try? container.decodeIfPresent(Detail.self, forKey: .error)
        error = try? container.decodeIfPresent(String.self, forKey: .error)
        message = (try? container.decodeIfPresent(String.self, forKey: .message))
            ?? detail?.message
        code = (try? container.decodeIfPresent(String.self, forKey: .code))
            ?? detail?.code
        retryable = (try? container.decodeIfPresent(Bool.self, forKey: .retryable))
            ?? detail?.retryable
    }
}

private struct ChatSSEParser {
    // A done frame repeats the authoritative final message after the deltas.
    // Leave bounded JSON overhead above the 4 MiB message-content ceiling.
    private static let maximumLineBytes = 5 * 1_024 * 1_024
    private static let maximumEventBytes = 5 * 1_024 * 1_024
    private var line = Data()
    private var dataLines: [Data] = []
    private var eventBytes = 0

    mutating func consume(_ byte: UInt8) throws -> [Data] {
        guard byte == 0x0A else {
            guard line.count < Self.maximumLineBytes else {
                throw NativeChatAPIError.eventLineTooLarge
            }
            line.append(byte)
            return []
        }
        return try finishLine()
    }

    mutating func finish() throws -> [Data] {
        var events: [Data] = []
        if !line.isEmpty { events.append(contentsOf: try finishLine()) }
        if !dataLines.isEmpty { events.append(try dispatch()) }
        return events
    }

    private mutating func finishLine() throws -> [Data] {
        if line.last == 0x0D { line.removeLast() }
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            return dataLines.isEmpty ? [] : [try dispatch()]
        }
        if line.first == 0x3A { return [] }
        let separator = line.firstIndex(of: 0x3A)
        let field = separator.map { line[..<$0] } ?? line[...]
        guard field.elementsEqual(Data("data".utf8)) else { return [] }
        var value = separator.map { Data(line[line.index(after: $0)...]) } ?? Data()
        if value.first == 0x20 { value.removeFirst() }
        eventBytes += value.count
        guard eventBytes <= Self.maximumEventBytes else {
            throw NativeChatAPIError.eventPayloadTooLarge
        }
        dataLines.append(value)
        return []
    }

    private mutating func dispatch() throws -> Data {
        guard !dataLines.isEmpty else { throw NativeChatAPIError.malformedResponse }
        var payload = Data()
        for (index, value) in dataLines.enumerated() {
            if index > 0 { payload.append(0x0A) }
            payload.append(value)
        }
        dataLines.removeAll(keepingCapacity: true)
        eventBytes = 0
        guard !payload.isEmpty else { throw NativeChatAPIError.malformedResponse }
        return payload
    }
}
