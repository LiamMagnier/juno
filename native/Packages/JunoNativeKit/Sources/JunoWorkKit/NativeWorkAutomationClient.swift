import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// REST client for Juno Work's durable automations.
///
/// This is separate from `NativeWorkClient` because schedules are an account
/// control plane, while that client owns a session's live stream and run
/// controls. Keeping the seams separate makes it possible to refresh a list of
/// schedules without opening or disturbing a task's SSE connection.
public struct NativeWorkAutomationClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func schedules(
        limit: Int = 30,
        enabled: Bool? = nil,
        sessionID: String? = nil,
        for accountID: AccountID
    ) async throws -> [NativeWorkSchedule] {
        var query = [URLQueryItem(name: "limit", value: String(min(100, max(1, limit))))]
        if let enabled { query.append(URLQueryItem(name: "enabled", value: enabled ? "true" : "false")) }
        if let sessionID {
            try validate(sessionID)
            query.append(URLQueryItem(name: "sessionId", value: sessionID))
        }
        let response = try await get("/api/work/schedules", query: query, for: accountID)
        guard let root = try object(response), case .array(let values)? = root["schedules"] else {
            throw WorkRemoteError.malformedResponse
        }
        return try values.map(decodeSchedule)
    }

    public func create(
        _ draft: NativeWorkScheduleDraft,
        for accountID: AccountID
    ) async throws -> NativeWorkSchedule {
        let response = try await send(
            .post,
            "/api/work/schedules",
            body: .object(scheduleBody(draft, includeNullHost: false)),
            for: accountID
        )
        return try decodeSchedule(try require(response, named: "schedule"))
    }

    /// Replaces the editable schedule fields in one request. The route expects
    /// a full trigger set, so an edit never accidentally leaves a deleted
    /// trigger active on the server.
    public func update(
        id: String,
        _ draft: NativeWorkScheduleDraft,
        for accountID: AccountID
    ) async throws -> NativeWorkSchedule {
        try validate(id)
        let response = try await send(
            .patch,
            "/api/work/schedules/\(id)",
            body: .object(scheduleBody(draft, includeNullHost: true)),
            for: accountID
        )
        return try decodeSchedule(try require(response, named: "schedule"))
    }

    public func setEnabled(
        id: String,
        enabled: Bool,
        for accountID: AccountID
    ) async throws -> NativeWorkSchedule {
        try validate(id)
        let response = try await send(
            .patch,
            "/api/work/schedules/\(id)",
            body: .object(["enabled": .bool(enabled)]),
            for: accountID
        )
        return try decodeSchedule(try require(response, named: "schedule"))
    }

    public func delete(id: String, for accountID: AccountID) async throws {
        try validate(id)
        _ = try await send(.delete, "/api/work/schedules/\(id)", body: nil, for: accountID)
    }

    /// Starts one manual fire without moving the schedule's next clock fire.
    /// The caller supplies the key so a lost response can be safely retried.
    public func runNow(
        id: String,
        idempotencyKey: String,
        for accountID: AccountID
    ) async throws -> NativeWorkScheduleRunResult {
        try validate(id)
        try validate(idempotencyKey)
        let response = try await send(
            .post,
            "/api/work/schedules/\(id)/run-now",
            body: .object(["idempotencyKey": .string(idempotencyKey)]),
            for: accountID
        )
        guard let root = try object(response), let runValue = root["run"] else {
            throw WorkRemoteError.malformedResponse
        }
        let selection = try decodeSelection(root["selection"])
        return NativeWorkScheduleRunResult(
            run: try decodeRun(runValue),
            selection: selection,
            nextRunAt: root["nextRunAt"]?.date,
            replay: root["replay"]?.boolValue ?? false
        )
    }

    public func runs(
        for scheduleID: String,
        limit: Int = 20,
        before: Date? = nil,
        accountID: AccountID
    ) async throws -> [NativeWorkScheduleRun] {
        try validate(scheduleID)
        var query = [URLQueryItem(name: "limit", value: String(min(100, max(1, limit))))]
        if let before {
            query.append(URLQueryItem(name: "before", value: Self.iso8601String(from: before)))
        }
        let response = try await get(
            "/api/work/schedules/\(scheduleID)/runs", query: query, for: accountID
        )
        guard let root = try object(response), case .array(let values)? = root["runs"] else {
            throw WorkRemoteError.malformedResponse
        }
        return try values.map(decodeRun)
    }

    // MARK: - Wire

    private func scheduleBody(
        _ draft: NativeWorkScheduleDraft,
        includeNullHost: Bool
    ) -> [String: JunoJSONValue] {
        var body: [String: JunoJSONValue] = [
            "name": .string(draft.name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "instructions": .string(draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines)),
            "timezone": .string(draft.timezone.trimmingCharacters(in: .whitespacesAndNewlines)),
            "target": .string(draft.target.rawValue),
            "enabled": .bool(draft.enabled),
            "triggers": .array(draft.triggers.map { trigger in
                var value: [String: JunoJSONValue] = [
                    "kind": .string(trigger.kind),
                    "config": .object(trigger.config),
                    "enabled": .bool(trigger.enabled),
                ]
                if let dedupe = trigger.dedupeWindowSeconds {
                    value["dedupeWindowSec"] = .number(Double(max(0, dedupe)))
                }
                return .object(value)
            }),
            "budget": .object([
                "maxCostMicroUsd": .number(Double(max(0, draft.budget.maxCostMicroUSD))),
                "maxTokens": .number(Double(max(0, draft.budget.maxTokens))),
                "maxRuntimeMs": .number(Double(max(0, draft.budget.maxRuntimeMilliseconds))),
            ]),
            "unattendedPolicy": .string(draft.unattendedPolicy),
            "hostOfflinePolicy": .string(draft.hostOfflinePolicy),
            "missedRunPolicy": .string(draft.missedRunPolicy),
            "notifyPolicy": .string(draft.notifyPolicy),
            "maxConcurrentRuns": .number(Double(min(5, max(1, draft.maxConcurrentRuns)))),
        ]
        if let hostID = draft.hostID {
            body["hostId"] = .string(hostID)
        } else if includeNullHost {
            body["hostId"] = .null
        }
        if let model = draft.model, !model.isEmpty {
            body["model"] = .string(model)
        } else if includeNullHost {
            // PATCH has no useful "default" sentinel. Null is the explicit
            // instruction to remove a schedule override and return to the
            // account's model policy.
            body["model"] = .null
        }
        // An empty array is meaningful on full edit: it clears a capability
        // requirement that was previously attached to the schedule.
        body["requiredCapabilities"] = .array(
            draft.requiredCapabilities.map { .string($0) }
        )
        return body
    }

    private func get(
        _ path: String,
        query: [URLQueryItem] = [],
        for accountID: AccountID
    ) async throws -> HTTPResponse {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path,
                queryItems: query,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        return response
    }

    private func send(
        _ method: HTTPMethod,
        _ path: String,
        body: JunoJSONValue?,
        for accountID: AccountID
    ) async throws -> HTTPResponse {
        var headers = ["accept": "application/json"]
        if body != nil { headers["content-type"] = "application/json" }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path,
                method: method,
                headers: try HTTPHeaders(headers),
                body: try body.map { try JSONEncoder().encode($0) }
            ),
            for: accountID
        )
        try requireSuccess(response)
        return response
    }

    private func validate(_ identifier: String) throws {
        guard !identifier.isEmpty, identifier.count <= 200,
            !identifier.contains("/"), !identifier.contains("\\"),
            !identifier.contains(".."), !identifier.contains("%"),
            !identifier.contains("?"), !identifier.contains("#"),
            identifier.allSatisfy({ !$0.isWhitespace && !$0.isNewline })
        else { throw WorkRemoteError.invalidIdentifier }
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let detail = try? object(response)
        let message = detail?["message"]?.stringValue
            ?? detail?["error"]?.stringValue
            ?? "Juno could not update Work automations (\(response.statusCode))."
        throw WorkRemoteError.server(
            statusCode: response.statusCode,
            message: message,
            retryable: (500...599).contains(response.statusCode) || response.statusCode == 429
        )
    }

    private func object(_ response: HTTPResponse) throws -> [String: JunoJSONValue]? {
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: response.body),
            case .object(let root) = value
        else { return nil }
        return root
    }

    private func object(_ value: JunoJSONValue?) throws -> [String: JunoJSONValue] {
        guard case .object(let object)? = value else { throw WorkRemoteError.malformedResponse }
        return object
    }

    private func require(
        _ response: HTTPResponse,
        named key: String
    ) throws -> JunoJSONValue {
        guard let root = try object(response), let value = root[key] else {
            throw WorkRemoteError.malformedResponse
        }
        return value
    }

    private func decodeSchedule(_ value: JunoJSONValue) throws -> NativeWorkSchedule {
        let root = try object(value)
        let id = try string(root, "id")
        let sessionID = try string(root, "sessionId")
        let name = try string(root, "name")
        let instructions = try string(root, "instructions")
        let target = try string(root, "target")
        let timezone = try string(root, "timezone")
        let createdAt = try date(root, "createdAt")
        let updatedAt = try date(root, "updatedAt")
        let config = try object(root["runConfig"] ?? .object([:]))
        let budgetObject = try object(root["budget"] ?? .object([:]))
        guard case .array(let triggerValues)? = root["triggers"] else {
            throw WorkRemoteError.malformedResponse
        }
        let triggers = try triggerValues.map(decodeTrigger)
        return NativeWorkSchedule(
            id: id,
            sessionID: sessionID,
            name: name,
            enabled: root["enabled"]?.boolValue ?? false,
            instructions: instructions,
            instructionsVersion: integer(root["instructionsVersion"]),
            target: target,
            hostID: root["hostId"]?.stringValue,
            timezone: timezone,
            runConfig: config,
            runConfigVersion: integer(root["runConfigVersion"]),
            budget: NativeWorkScheduleBudget(
                maxCostMicroUSD: integer(budgetObject["maxCostMicroUsd"]),
                maxTokens: integer(budgetObject["maxTokens"]),
                maxRuntimeMilliseconds: integer(budgetObject["maxRuntimeMs"])
            ),
            unattendedPolicy: optionalString(root["unattendedPolicy"]) ?? "pause_for_approval",
            hostOfflinePolicy: optionalString(root["hostOfflinePolicy"]) ?? "skip",
            maxConcurrentRuns: integer(root["maxConcurrentRuns"], fallback: 1),
            notifyPolicy: optionalString(root["notifyPolicy"]) ?? "on_attention",
            missedRunPolicy: optionalString(root["missedRunPolicy"]) ?? "run_once",
            retryPolicy: root["retryPolicy"] ?? .object([:]),
            lastRunAt: root["lastRunAt"]?.date,
            nextRunAt: root["nextRunAt"]?.date,
            legacyScheduledTaskID: root["legacyScheduledTaskId"]?.stringValue,
            createdAt: createdAt,
            updatedAt: updatedAt,
            triggers: triggers
        )
    }

    private func decodeTrigger(_ value: JunoJSONValue) throws -> NativeWorkScheduleTrigger {
        let root = try object(value)
        guard case .object(let config)? = root["config"] else {
            throw WorkRemoteError.malformedResponse
        }
        return NativeWorkScheduleTrigger(
            id: try string(root, "id"),
            kind: try string(root, "kind"),
            config: config,
            configVersion: integer(root["configVersion"]),
            enabled: root["enabled"]?.boolValue ?? false,
            lastFiredAt: root["lastFiredAt"]?.date,
            dedupeWindowSeconds: integer(root["dedupeWindowSec"])
        )
    }

    private func decodeRun(_ value: JunoJSONValue) throws -> NativeWorkScheduleRun {
        let root = try object(value)
        return NativeWorkScheduleRun(
            id: try string(root, "id"),
            sessionID: try string(root, "sessionId"),
            scheduleID: root["scheduleId"]?.stringValue,
            origin: optionalString(root["origin"]) ?? "schedule",
            status: optionalString(root["status"]) ?? "queued",
            requestedTarget: optionalString(root["requestedTarget"]) ?? "automatic",
            effectiveTarget: root["effectiveTarget"]?.stringValue,
            hostID: root["hostId"]?.stringValue,
            createdAt: root["createdAt"]?.date,
            startedAt: root["startedAt"]?.date,
            finishedAt: root["finishedAt"]?.date
        )
    }

    private func decodeSelection(_ value: JunoJSONValue?) throws -> NativeWorkScheduleSelection {
        let root = try object(value)
        return NativeWorkScheduleSelection(
            target: optionalString(root["target"]) ?? "cloud",
            hostID: root["hostId"]?.stringValue,
            explanation: root["explanation"]?.stringValue,
            missing: strings(root["missing"]),
            degradation: strings(root["degradation"])
        )
    }

    private func string(
        _ object: [String: JunoJSONValue],
        _ key: String
    ) throws -> String { try string(object[key], required: key) }

    private func string(_ value: JunoJSONValue?, required key: String? = nil) throws -> String {
        guard let value, let string = value.stringValue, !string.isEmpty else {
            throw WorkRemoteError.malformedResponse
        }
        return string
    }

    private func optionalString(_ value: JunoJSONValue?) -> String? {
        guard let value, let string = value.stringValue, !string.isEmpty else { return nil }
        return string
    }

    private func date(
        _ object: [String: JunoJSONValue],
        _ key: String
    ) throws -> Date {
        guard let date = object[key]?.date else { throw WorkRemoteError.malformedResponse }
        return date
    }

    private func integer(_ value: JunoJSONValue?, fallback: Int = 0) -> Int {
        guard let number = value?.numberValue, number.isFinite else { return fallback }
        if number >= Double(Int.max) { return Int.max }
        if number <= Double(Int.min) { return Int.min }
        return Int(number)
    }

    private func strings(_ value: JunoJSONValue?) -> [String] {
        guard case .array(let values)? = value else { return [] }
        return values.compactMap(\.stringValue)
    }

    private static func iso8601String(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
