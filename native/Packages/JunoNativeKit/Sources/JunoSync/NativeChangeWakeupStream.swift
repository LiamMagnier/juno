import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage

public protocol NativeAuthenticatedByteStreaming: Sendable {
    func stream(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPByteStreamResponse
}

extension NativeAuthRuntime: NativeAuthenticatedByteStreaming {}

public enum NativeChangeWakeup: Equatable, Sendable {
    case ready(after: String)
    case cursor(String)
    case done
}

public enum NativeChangeWakeupError: Error, Equatable, Sendable {
    case invalidCursor(String)
    case server(statusCode: Int, code: String?)
    case invalidContentType
    case malformedEvent
    case eventLineTooLarge
    case errorBodyTooLarge
}

public struct NativeChangeWakeupClient: Sendable {
    private let streamer: any NativeAuthenticatedByteStreaming

    public init(streamer: any NativeAuthenticatedByteStreaming) {
        self.streamer = streamer
    }

    public func wakeups(
        after: String,
        for accountID: AccountID
    ) async throws -> AsyncThrowingStream<NativeChangeWakeup, any Error> {
        try requireCursor(after)
        let response = try await streamer.stream(
            try NativeBearerRequest(
                path: "/api/v1/changes/stream",
                queryItems: [URLQueryItem(name: "after", value: after)],
                headers: HTTPHeaders(["Accept": "text/event-stream"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            var body = Data()
            for try await byte in response.bytes {
                guard body.count < 64 * 1_024 else {
                    throw NativeChangeWakeupError.errorBodyTooLarge
                }
                body.append(byte)
            }
            let code = try? JSONDecoder().decode(
                NativeAPIErrorEnvelope.self,
                from: body
            ).error.code
            throw NativeChangeWakeupError.server(
                statusCode: response.statusCode,
                code: code
            )
        }
        guard response.headers["content-type"]?.lowercased()
            .hasPrefix("text/event-stream") == true
        else { throw NativeChangeWakeupError.invalidContentType }

        return AsyncThrowingStream { continuation in
            let relay = Task {
                do {
                    var parser = SSEParser()
                    for try await byte in response.bytes {
                        for event in try parser.consume(byte) {
                            continuation.yield(try decode(event))
                        }
                    }
                    for event in try parser.finish() {
                        continuation.yield(try decode(event))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in relay.cancel() }
        }
    }

    private func decode(_ event: SSEParser.Event) throws -> NativeChangeWakeup {
        switch event.name {
        case "ready":
            let payload = try JSONDecoder().decode(ReadyWire.self, from: Data(event.data.utf8))
            try requireCursor(payload.after)
            return .ready(after: payload.after)
        case "cursor":
            let payload = try JSONDecoder().decode(CursorWire.self, from: Data(event.data.utf8))
            try requireCursor(payload.cursor)
            return .cursor(payload.cursor)
        case "done":
            guard (try? JSONSerialization.jsonObject(with: Data(event.data.utf8))) != nil else {
                throw NativeChangeWakeupError.malformedEvent
            }
            return .done
        default:
            throw NativeChangeWakeupError.malformedEvent
        }
    }

    private func requireCursor(_ cursor: String) throws {
        guard cursor == "0" || (cursor.first != "0" && !cursor.isEmpty
            && cursor.utf8.allSatisfy { (48...57).contains($0) })
        else { throw NativeChangeWakeupError.invalidCursor(cursor) }
    }
}

private struct ReadyWire: Decodable { let after: String }
private struct CursorWire: Decodable { let cursor: String }

private struct SSEParser {
    struct Event {
        let name: String
        let data: String
    }

    private var line = Data()
    private var eventName: String?
    private var dataLines: [String] = []

    mutating func consume(_ byte: UInt8) throws -> [Event] {
        guard byte == 0x0A else {
            guard line.count < 8_192 else {
                throw NativeChangeWakeupError.eventLineTooLarge
            }
            line.append(byte)
            return []
        }
        return try finishLine()
    }

    mutating func finish() throws -> [Event] {
        var result: [Event] = []
        if !line.isEmpty { result.append(contentsOf: try finishLine()) }
        if eventName != nil || !dataLines.isEmpty {
            result.append(try dispatch())
        }
        return result
    }

    private mutating func finishLine() throws -> [Event] {
        if line.last == 0x0D { line.removeLast() }
        guard let value = String(data: line, encoding: .utf8) else {
            throw NativeChangeWakeupError.malformedEvent
        }
        line.removeAll(keepingCapacity: true)
        if value.isEmpty {
            guard eventName != nil || !dataLines.isEmpty else { return [] }
            return [try dispatch()]
        }
        if value.hasPrefix(":") { return [] }
        let pieces = value.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let field = String(pieces[0])
        var fieldValue = pieces.count == 2 ? String(pieces[1]) : ""
        if fieldValue.first == " " { fieldValue.removeFirst() }
        switch field {
        case "event": eventName = fieldValue
        case "data": dataLines.append(fieldValue)
        default: break
        }
        return []
    }

    private mutating func dispatch() throws -> Event {
        guard let eventName, !eventName.isEmpty, !dataLines.isEmpty else {
            throw NativeChangeWakeupError.malformedEvent
        }
        let event = Event(name: eventName, data: dataLines.joined(separator: "\n"))
        self.eventName = nil
        dataLines.removeAll(keepingCapacity: true)
        return event
    }
}

/// Maintains sync liveness until cancellation: initial catch-up, real SSE
/// wakeups, authoritative page fetches, and reconnect backoff after network loss.
public actor NativeSyncMonitor<Repository: AccountScopedRepository> {
    private let coordinator: NativeSyncCoordinator<Repository>
    private let wakeupClient: NativeChangeWakeupClient
    private let policy: NativeSyncBackoffPolicy

    public init(
        coordinator: NativeSyncCoordinator<Repository>,
        streamer: any NativeAuthenticatedByteStreaming,
        policy: NativeSyncBackoffPolicy = NativeSyncBackoffPolicy()
    ) {
        self.coordinator = coordinator
        wakeupClient = NativeChangeWakeupClient(streamer: streamer)
        self.policy = policy
    }

    public func run(
        for accountID: AccountID,
        startingAt initialResult: NativeSyncResult? = nil,
        sleeper: any NativeSyncSleeping = SystemNativeSyncSleeper(),
        jitter: any NativeSyncJitterSource = SystemNativeSyncJitterSource(),
        onSynchronized: @escaping @Sendable (NativeSyncResult) async -> Void = { _ in }
    ) async throws {
        var result: NativeSyncResult
        if let initialResult {
            result = initialResult
        } else {
            result = try await coordinator.synchronizeWithRetry(for: accountID)
            await onSynchronized(result)
        }
        var reconnectAttempt = 0
        while !Task.isCancelled {
            do {
                let stream = try await wakeupClient.wakeups(
                    after: result.cursor,
                    for: accountID
                )
                reconnectAttempt = 0
                streamLoop: for try await wakeup in stream {
                    switch wakeup {
                    case .ready: break
                    case .cursor:
                        result = try await coordinator.synchronizeWithRetry(for: accountID)
                        await onSynchronized(result)
                    case .done:
                        break streamLoop
                    }
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                guard Self.isReconnectable(error) else { throw error }
                let delay = policy.delay(
                    attempt: reconnectAttempt,
                    randomUnit: await jitter.nextUnit()
                )
                reconnectAttempt += 1
                try await sleeper.sleep(seconds: delay)
            }
        }
        throw CancellationError()
    }

    private static func isReconnectable(_ error: any Error) -> Bool {
        if error is URLError { return true }
        if let transport = error as? URLSessionTransportError {
            switch transport {
            case .invalidResponse, .invalidHeaders: return true
            case .invalidConfiguration, .requestBodyTooLarge, .responseBodyTooLarge: return false
            }
        }
        if case NativeChangeWakeupError.server(let statusCode, _) = error {
            return statusCode == 429 || statusCode >= 500
        }
        return false
    }
}
