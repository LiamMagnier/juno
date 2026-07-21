import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage

public struct NativeMutationResult: Equatable, Sendable {
    public let entityID: String
    public let revision: UInt64
    public let deleted: Bool
    public let entityMappings: [String: String]
}

public enum NativeMutationAPIError: Error, Equatable, Sendable {
    case invalidMutation
    case malformedResponse
    case revisionConflict(currentRevision: UInt64?, deleted: Bool)
    case server(statusCode: Int, code: String?, retryable: Bool, retryAfterMilliseconds: Int?)

    public var isRetryable: Bool {
        if case .server(_, _, let retryable, _) = self { return retryable }
        return false
    }
}

public struct NativeMutationAPIClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func submit(
        _ mutation: MutationDraft,
        baseRevision: UInt64,
        for accountID: AccountID
    ) async throws -> NativeMutationResult {
        guard mutation.accountID.rawValue == accountID.rawValue,
            UUID(uuidString: mutation.idempotencyKey.rawValue) != nil,
            mutation.payload.count <= 512 * 1_024,
            let operation = try? JSONSerialization.jsonObject(with: mutation.payload) as? [String: Any],
            operation["type"] as? String == mutation.operation,
            JSONSerialization.isValidJSONObject(operation)
        else { throw NativeMutationAPIError.invalidMutation }
        let requestObject: [String: Any] = [
            "clientMutationId": mutation.idempotencyKey.rawValue,
            "baseRevision": baseRevision,
            "operation": operation,
        ]
        let body: Data
        do { body = try JSONSerialization.data(withJSONObject: requestObject, options: [.sortedKeys]) }
        catch { throw NativeMutationAPIError.invalidMutation }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/v1/mutations",
                method: .post,
                headers: HTTPHeaders(["Content-Type": "application/json"]),
                body: body
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(response)
        }
        do {
            let wire = try JSONDecoder().decode(ResultWire.self, from: response.body)
            guard !wire.entity.id.isEmpty, wire.entity.id.utf8.count <= 200 else {
                throw NativeMutationAPIError.malformedResponse
            }
            return NativeMutationResult(
                entityID: wire.entity.id,
                revision: wire.entity.revision,
                deleted: wire.entity.deleted ?? false,
                entityMappings: wire.entityMappings ?? [:]
            )
        } catch let error as NativeMutationAPIError { throw error }
        catch { throw NativeMutationAPIError.malformedResponse }
    }

    private func serverError(_ response: HTTPResponse) -> NativeMutationAPIError {
        let envelope = try? JSONDecoder().decode(ErrorWire.self, from: response.body)
        if response.statusCode == 409, envelope?.error.code == "revision_conflict" {
            let currentRevision: UInt64?
            let deleted: Bool
            if case .object(let details)? = envelope?.error.details {
                if case .number(let value)? = details["currentRevision"],
                    value >= 0, value <= Double(UInt64.max), value.rounded() == value
                { currentRevision = UInt64(value) } else { currentRevision = nil }
                if case .bool(let value)? = details["deleted"] { deleted = value }
                else { deleted = false }
            } else {
                currentRevision = nil
                deleted = false
            }
            return .revisionConflict(currentRevision: currentRevision, deleted: deleted)
        }
        return .server(
            statusCode: response.statusCode,
            code: envelope?.error.code,
            retryable: envelope?.error.retryable ?? (response.statusCode >= 500),
            retryAfterMilliseconds: envelope?.error.retryAfterMs
        )
    }
}

private struct ResultWire: Decodable {
    struct Entity: Decodable {
        let id: String
        let revision: UInt64
        let deleted: Bool?
    }
    let entity: Entity
    let entityMappings: [String: String]?
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

public struct NativeMutationDrainResult: Equatable, Sendable {
    public let leased: Int
    public let acknowledged: Int
    public let retryScheduled: Int
    public let conflicted: Int
}

public actor NativeMutationDrainer<Repository: AccountScopedRepository> {
    private let repository: Repository
    private let outbox: any MutationOutboxRepository
    private let client: NativeMutationAPIClient
    private let policy: NativeSyncBackoffPolicy

    public init(
        repository: Repository,
        outbox: any MutationOutboxRepository,
        sender: any NativeAuthenticatedRequestSending,
        policy: NativeSyncBackoffPolicy = NativeSyncBackoffPolicy()
    ) {
        self.repository = repository
        self.outbox = outbox
        client = NativeMutationAPIClient(sender: sender)
        self.policy = policy
    }

    public func drain(
        for accountID: AccountID,
        owner: String,
        now: Date = Date(),
        leaseDuration: TimeInterval = 60,
        limit: Int = 20,
        jitter: any NativeSyncJitterSource = SystemNativeSyncJitterSource()
    ) async throws -> NativeMutationDrainResult {
        let storageAccountID = StorageAccountID(accountID.rawValue)
        let token = UUID().uuidString.lowercased()
        let leased = try await outbox.lease(
            accountID: storageAccountID,
            owner: owner,
            token: token,
            now: now,
            duration: leaseDuration,
            limit: limit
        )
        var acknowledged = 0
        var retries = 0
        var conflicts = 0
        for mutation in leased {
            let snapshot = try await repository.snapshot(for: storageAccountID)
            let baseRevision = snapshot.records[mutation.draft.entity]?.revision ?? 0
            do {
                _ = try await client.submit(
                    mutation.draft,
                    baseRevision: baseRevision,
                    for: accountID
                )
                try await outbox.acknowledge(
                    id: mutation.draft.id,
                    accountID: storageAccountID,
                    owner: owner,
                    token: token,
                    now: now
                )
                acknowledged += 1
            } catch NativeMutationAPIError.revisionConflict(let serverRevision, _) {
                try await outbox.markConflict(
                    id: mutation.draft.id,
                    accountID: storageAccountID,
                    owner: owner,
                    token: token,
                    now: now,
                    localRevision: baseRevision,
                    serverRevision: serverRevision,
                    reason: "revision_conflict"
                )
                conflicts += 1
            } catch {
                if Self.isRetryable(error) {
                    var delay = policy.delay(
                        attempt: max(0, Int(mutation.attemptCount) - 1),
                        randomUnit: await jitter.nextUnit()
                    )
                    if case NativeMutationAPIError.server(_, _, _, let retryAfter?) = error {
                        delay = max(delay, TimeInterval(retryAfter) / 1_000)
                    }
                    try await outbox.scheduleRetry(
                        id: mutation.draft.id,
                        accountID: storageAccountID,
                        owner: owner,
                        token: token,
                        now: now,
                        eligibleAt: now.addingTimeInterval(delay),
                        errorCode: Self.errorCode(error)
                    )
                    retries += 1
                } else {
                    try await outbox.markConflict(
                        id: mutation.draft.id,
                        accountID: storageAccountID,
                        owner: owner,
                        token: token,
                        now: now,
                        localRevision: baseRevision,
                        serverRevision: nil,
                        reason: Self.errorCode(error)
                    )
                    conflicts += 1
                }
            }
        }
        return NativeMutationDrainResult(
            leased: leased.count,
            acknowledged: acknowledged,
            retryScheduled: retries,
            conflicted: conflicts
        )
    }

    private static func isRetryable(_ error: any Error) -> Bool {
        if let mutationError = error as? NativeMutationAPIError {
            return mutationError.isRetryable
        }
        return error is URLError
    }

    private static func errorCode(_ error: any Error) -> String {
        if case NativeMutationAPIError.server(_, let code, _, _) = error {
            return code ?? "server_unavailable"
        }
        if error is URLError { return "offline" }
        return "mutation_rejected"
    }
}
