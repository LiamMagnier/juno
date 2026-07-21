import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage

public enum NativeJSONValue: Equatable, Sendable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([NativeJSONValue])
    case object([String: NativeJSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([NativeJSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: NativeJSONValue].self)) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

public struct NativeEntityReference: Equatable, Sendable {
    public let type: String
    public let id: String
    public let revision: UInt64
}

public struct NativeEntityIndexPage: Equatable, Sendable {
    public let items: [NativeEntityReference]
    public let nextAfter: String?
    public let hasMore: Bool
}

public struct NativeHydratedEntity: Equatable, Sendable {
    public let type: String
    public let id: String
    public let revision: UInt64
    public let deletedAt: Date?
    public let data: NativeJSONValue?

    public func storedRecord(accountID: StorageAccountID) throws -> StoredRecord {
        let timestamp = deletedAt ?? data?.preferredTimestamp
            ?? Date(timeIntervalSince1970: TimeInterval(revision))
        let payload: Data?
        if let data {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            payload = try encoder.encode(persistableData(data))
        } else {
            payload = nil
        }
        return StoredRecord(
            accountID: accountID,
            key: RecordKey(namespace: type, id: id),
            revision: revision,
            updatedAt: timestamp,
            isTombstone: data == nil,
            payload: payload
        )
    }

    private func persistableData(_ value: NativeJSONValue) -> NativeJSONValue {
        // Attachment view URLs are short-lived signatures, not entity state.
        // Persisting them would make identical revisions differ across a
        // bootstrap/catch-up race. The attachment access flow rehydrates a
        // fresh URL when the user opens the file.
        guard type == "attachment", case .object(var object) = value else {
            return value
        }
        object.removeValue(forKey: "url")
        return .object(object)
    }
}

public struct NativeAccountChange: Equatable, Sendable {
    public enum Operation: String, Equatable, Sendable { case upsert, delete }

    public let cursor: String
    public let entityType: String
    public let entityID: String
    public let parentEntityID: String?
    public let revision: UInt64
    public let operation: Operation
    public let changedAt: Date
}

public struct NativeChangePage: Equatable, Sendable {
    public let after: String
    public let changes: [NativeAccountChange]
    public let nextCursor: String
    public let compactionFloorCursor: String
    public let hasMore: Bool
}

public enum NativeSyncAPIError: Error, Equatable, LocalizedError, Sendable {
    case server(statusCode: Int, code: String?, retryable: Bool, retryAfterMilliseconds: Int?)
    case cursorCompacted(floor: String?)
    case malformedResponse
    case invalidCursor(String)
    case invalidEntityType(String)
    case invalidEntityBatch
    case missingEntity(type: String, id: String)
    case duplicateEntity(type: String, id: String)

    public var errorDescription: String? {
        switch self {
        case .server(_, let code, _, _): "Juno sync failed (\(code ?? "server_error"))."
        case .cursorCompacted: "The local change cursor must be rebuilt."
        case .malformedResponse: "Juno returned malformed synchronization data."
        case .invalidCursor: "Juno returned an invalid synchronization cursor."
        case .invalidEntityType: "Juno returned an unknown synchronization entity."
        case .invalidEntityBatch: "The synchronization entity batch is invalid."
        case .missingEntity: "Juno omitted an entity required to advance synchronization."
        case .duplicateEntity: "Juno returned a duplicate synchronization entity."
        }
    }

    public var isRetryable: Bool {
        if case .server(_, _, let retryable, _) = self { return retryable }
        return false
    }
}

public struct NativeSyncAPIClient: Sendable {
    public static let entityTypes: Set<String> = [
        "profile", "settings", "subscription", "folder", "conversation",
        "message", "message_version", "attachment", "artifact",
        "artifact_version", "project", "memory", "saved_prompt", "connection",
        "usage", "share", "announcement_dismissal", "scheduled_task",
        "code_device", "code_task", "code_task_event", "code_workspace",
    ]

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func entityIndex(
        after: String? = nil,
        limit: Int = 200,
        for accountID: AccountID
    ) async throws -> NativeEntityIndexPage {
        guard (1...500).contains(limit) else { throw NativeSyncAPIError.invalidEntityBatch }
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let after { query.append(URLQueryItem(name: "after", value: after)) }
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/v1/entities/index", queryItems: query),
            for: accountID
        )
        try requireSuccess(response)
        let wire: EntityIndexWire = try decode(response.body)
        guard wire.hasMore == (wire.nextAfter != nil), !wire.hasMore || !wire.items.isEmpty else {
            throw NativeSyncAPIError.malformedResponse
        }
        var seen = Set<String>()
        var previous: (String, String)?
        let items = try wire.items.map { item -> NativeEntityReference in
            try requireEntityType(item.type)
            guard validIdentifier(item.id) else { throw NativeSyncAPIError.malformedResponse }
            let compound = item.type + "\u{0}" + item.id
            guard seen.insert(compound).inserted else {
                throw NativeSyncAPIError.duplicateEntity(type: item.type, id: item.id)
            }
            if let previous, !(previous.0 < item.type || (previous.0 == item.type && previous.1 < item.id)) {
                throw NativeSyncAPIError.malformedResponse
            }
            previous = (item.type, item.id)
            return NativeEntityReference(type: item.type, id: item.id, revision: item.revision)
        }
        return NativeEntityIndexPage(items: items, nextAfter: wire.nextAfter, hasMore: wire.hasMore)
    }

    public func entities(
        type: String,
        ids: [String],
        for accountID: AccountID
    ) async throws -> [NativeHydratedEntity] {
        try requireEntityType(type)
        let uniqueIDs = Array(Set(ids))
        guard uniqueIDs.count == ids.count, (1...100).contains(ids.count),
            ids.allSatisfy(validIdentifier)
        else { throw NativeSyncAPIError.invalidEntityBatch }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/v1/entities",
                queryItems: [
                    URLQueryItem(name: "type", value: type),
                    URLQueryItem(name: "ids", value: ids.joined(separator: ",")),
                ]
            ),
            for: accountID
        )
        try requireSuccess(response)
        let wire: EntitiesWire = try decode(response.body)
        let requested = Set(ids)
        var seen = Set<String>()
        let entities = try wire.entities.map { item -> NativeHydratedEntity in
            guard item.type == type, requested.contains(item.id), validIdentifier(item.id) else {
                throw NativeSyncAPIError.malformedResponse
            }
            guard seen.insert(item.id).inserted else {
                throw NativeSyncAPIError.duplicateEntity(type: type, id: item.id)
            }
            let deletedAt = try item.deletedAt.map(parseDate)
            guard (item.data == nil) == (deletedAt != nil) else {
                throw NativeSyncAPIError.malformedResponse
            }
            return NativeHydratedEntity(
                type: type,
                id: item.id,
                revision: item.revision,
                deletedAt: deletedAt,
                data: item.data
            )
        }
        for id in ids where !seen.contains(id) {
            throw NativeSyncAPIError.missingEntity(type: type, id: id)
        }
        let byID = Dictionary(uniqueKeysWithValues: entities.map { ($0.id, $0) })
        return ids.compactMap { byID[$0] }
    }

    public func changes(
        after: String,
        limit: Int = 200,
        for accountID: AccountID
    ) async throws -> NativeChangePage {
        try requireCursor(after)
        guard (1...500).contains(limit) else { throw NativeSyncAPIError.invalidEntityBatch }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/v1/changes",
                queryItems: [
                    URLQueryItem(name: "after", value: after),
                    URLQueryItem(name: "limit", value: String(limit)),
                ]
            ),
            for: accountID
        )
        try requireSuccess(response)
        let wire: ChangesWire = try decode(response.body)
        guard wire.after == after else { throw NativeSyncAPIError.malformedResponse }
        try requireCursor(wire.nextCursor)
        try requireCursor(wire.compactionFloorCursor)
        guard compareCursor(wire.nextCursor, after) != .orderedAscending,
            compareCursor(wire.compactionFloorCursor, wire.nextCursor) != .orderedDescending,
            !wire.hasMore || !wire.changes.isEmpty
        else { throw NativeSyncAPIError.malformedResponse }

        var previousCursor = after
        let changes = try wire.changes.map { item -> NativeAccountChange in
            try requireCursor(item.cursor)
            try requireEntityType(item.entityType)
            guard validIdentifier(item.entityId), item.revision > 0,
                compareCursor(item.cursor, previousCursor) == .orderedDescending,
                compareCursor(item.cursor, wire.nextCursor) != .orderedDescending,
                let operation = NativeAccountChange.Operation(rawValue: item.operation)
            else { throw NativeSyncAPIError.malformedResponse }
            previousCursor = item.cursor
            return NativeAccountChange(
                cursor: item.cursor,
                entityType: item.entityType,
                entityID: item.entityId,
                parentEntityID: item.parentEntityId,
                revision: item.revision,
                operation: operation,
                changedAt: try parseDate(item.changedAt)
            )
        }
        return NativeChangePage(
            after: wire.after,
            changes: changes,
            nextCursor: wire.nextCursor,
            compactionFloorCursor: wire.compactionFloorCursor,
            hasMore: wire.hasMore
        )
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let envelope = try? JSONDecoder().decode(ErrorWire.self, from: response.body)
        if response.statusCode == 410, envelope?.error.code == "cursor_compacted" {
            let floor: String?
            if case .object(let details)? = envelope?.error.details,
                case .string(let value)? = details["compactionFloorCursor"]
            { floor = value } else { floor = nil }
            throw NativeSyncAPIError.cursorCompacted(floor: floor)
        }
        throw NativeSyncAPIError.server(
            statusCode: response.statusCode,
            code: envelope?.error.code,
            retryable: envelope?.error.retryable ?? (response.statusCode >= 500),
            retryAfterMilliseconds: envelope?.error.retryAfterMs
        )
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw NativeSyncAPIError.malformedResponse }
    }

    private func requireEntityType(_ value: String) throws {
        guard Self.entityTypes.contains(value) else { throw NativeSyncAPIError.invalidEntityType(value) }
    }

    private func validIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 200 && !value.contains(",")
    }

    private func requireCursor(_ value: String) throws {
        guard value == "0" || (value.first != "0" && !value.isEmpty
            && value.utf8.allSatisfy { (48...57).contains($0) })
        else { throw NativeSyncAPIError.invalidCursor(value) }
    }

    private func compareCursor(_ lhs: String, _ rhs: String) -> ComparisonResult {
        if lhs.count != rhs.count { return lhs.count < rhs.count ? .orderedAscending : .orderedDescending }
        if lhs == rhs { return .orderedSame }
        return lhs < rhs ? .orderedAscending : .orderedDescending
    }

    private func parseDate(_ value: String) throws -> Date {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: value) { return date }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        guard let date = ordinary.date(from: value) else { throw NativeSyncAPIError.malformedResponse }
        return date
    }
}

private extension NativeJSONValue {
    var preferredTimestamp: Date? {
        guard case .object(let object) = self else { return nil }
        for key in ["updatedAt", "lastMessageAt", "createdAt"] {
            guard case .string(let value)? = object[key] else { continue }
            let precise = ISO8601DateFormatter()
            precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = precise.date(from: value) { return date }
            let ordinary = ISO8601DateFormatter()
            ordinary.formatOptions = [.withInternetDateTime]
            if let date = ordinary.date(from: value) { return date }
        }
        return nil
    }
}

private struct EntityIndexWire: Decodable {
    struct Item: Decodable { let type: String; let id: String; let revision: UInt64 }
    let items: [Item]
    let nextAfter: String?
    let hasMore: Bool
}

private struct EntitiesWire: Decodable {
    struct Item: Decodable {
        let type: String
        let id: String
        let revision: UInt64
        let deletedAt: String?
        let data: NativeJSONValue?
    }
    let entities: [Item]
}

private struct ChangesWire: Decodable {
    struct Item: Decodable {
        let cursor: String
        let entityType: String
        let entityId: String
        let parentEntityId: String?
        let revision: UInt64
        let operation: String
        let changedAt: String
    }
    let after: String
    let changes: [Item]
    let nextCursor: String
    let compactionFloorCursor: String
    let hasMore: Bool
}

private struct ErrorWire: Decodable {
    struct Payload: Decodable {
        let code: String
        let retryable: Bool
        let retryAfterMs: Int?
        let details: NativeJSONValue?
    }
    let error: Payload
}
