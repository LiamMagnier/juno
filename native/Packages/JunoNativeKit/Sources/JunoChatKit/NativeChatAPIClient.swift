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

public struct NativeChatModelOption: Identifiable, Equatable, Sendable {
    public let id: String
    public let providerID: String
    public let providerName: String
    public let displayName: String
    public let minimumPlan: String
    public let availability: String
    public let supportedReasoningEfforts: [NativeReasoningEffort]
    public let canDisableReasoning: Bool
    public let supportsStreaming: Bool

    public var isAvailable: Bool {
        availability == "available" && supportsStreaming
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

    public init(
        conversationID: String,
        modelID: String,
        reasoningEffort: NativeReasoningEffort?,
        generationID: String
    ) {
        self.conversationID = conversationID
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.generationID = generationID
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
            return NativeChatModelOption(
                id: model.id,
                providerID: model.provider.id,
                providerName: model.provider.displayName,
                displayName: model.displayName,
                minimumPlan: model.minimumPlan,
                availability: model.availability,
                supportedReasoningEfforts: efforts,
                canDisableReasoning: model.reasoning.canDisable,
                supportsStreaming: model.capabilities.streaming
            )
        }
        return NativeChatModelCatalog(
            manifestVersion: wire.manifestVersion,
            contractDigest: wire.contractDigest,
            generatedAt: generatedAt,
            models: models.sorted {
                $0.providerName == $1.providerName
                    ? $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
                    : $0.providerName.localizedCaseInsensitiveCompare($1.providerName) == .orderedAscending
            }
        )
    }

    public func appendUserMessage(
        conversationID: String,
        clientID: String,
        content: String,
        for accountID: AccountID
    ) async throws -> NativeAppendedUserMessage {
        try requireIdentifier(conversationID)
        try requireIdentifier(clientID)
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw NativeChatAPIError.invalidMessage }
        let requestBody = AppendRequestWire(turns: [AppendTurnWire(
            clientId: clientID,
            role: "USER",
            content: trimmed
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
            client: "app"
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
        case "ping", "activity", "progress":
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
        struct Reasoning: Decodable { let canDisable: Bool }
        struct Capabilities: Decodable { let streaming: Bool }
        let id: String
        let provider: Provider
        let displayName: String
        let availability: String
        let minimumPlan: String
        let supportedReasoningEfforts: [String]
        let reasoning: Reasoning
        let capabilities: Capabilities
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
}
private struct CancelRequestWire: Encodable { let generationId: String }
private struct CancelResponseWire: Decodable { let ok: Bool; let cancelled: Bool }

private struct SourceWire: Decodable {
    let title: String
    let url: String
    let snippet: String
}

private struct EventEnvelopeWire: Decodable {
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
    let error: String?
    let finishReason: String?

    private enum CodingKeys: String, CodingKey {
        case type, conversationId, userMessageId, title, generationId, text,
             sources, message, error, finishReason
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
