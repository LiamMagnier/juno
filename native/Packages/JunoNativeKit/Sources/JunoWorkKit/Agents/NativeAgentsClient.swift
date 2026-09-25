import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoSync

/// REST client for Agents: `/api/agents/**`, bearer-authenticated exactly like
/// `/api/work/**`.
///
/// Separate from the Work clients because an agent is an account-level
/// identity — a name, a face, a brief, goals and a memory — and its tasks are
/// ordinary Work sessions that `NativeWorkClient` already follows. This client
/// never opens a stream; the agent's page is a read of the server's derived
/// state, refreshed on a clock, and everything live about a task is one tap
/// away in its thread.
///
/// Built in the shape of ``NativeWorkAutomationClient`` on purpose — the same
/// request seams, the same identifier checks, the same manual decoding over
/// ``JunoJSONValue`` — so a reader who knows one knows both.
public struct NativeAgentsClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    // MARK: - Roster and page

    public func agents(for accountID: AccountID) async throws -> [NativeAgent] {
        let response = try await get("/api/agents", for: accountID)
        guard let root = try object(response), case .array(let values)? = root["agents"] else {
            throw WorkRemoteError.malformedResponse
        }
        return try values.map(decodeAgent)
    }

    /// Hires an agent: the agent, its thread, and its first goal when one was
    /// given, in one request.
    public func hire(_ draft: NativeAgentDraft, for accountID: AccountID) async throws -> NativeAgent {
        let response = try await send(
            .post,
            "/api/agents",
            body: .object(hireBody(draft)),
            for: accountID
        )
        return try decodeAgent(try require(response, named: "agent"))
    }

    public func detail(id: String, for accountID: AccountID) async throws -> NativeAgentDetail {
        try validate(id)
        let response = try await get("/api/agents/\(id)", for: accountID)
        guard let root = try object(response), let agentValue = root["agent"] else {
            throw WorkRemoteError.malformedResponse
        }
        return NativeAgentDetail(
            agent: try decodeAgent(agentValue),
            goals: list(root["goals"], decodeGoal),
            ideas: list(root["ideas"], decodeIdea),
            notes: list(root["notes"], decodeNote),
            routines: list(root["routines"], decodeRoutine),
            tasks: list(root["tasks"], decodeTask)
        )
    }

    /// Edits the profile, the autonomy and the apps, or pauses and resumes it.
    public func update(
        id: String,
        _ patch: NativeAgentPatch,
        for accountID: AccountID
    ) async throws -> NativeAgent {
        try validate(id)
        let response = try await send(
            .patch,
            "/api/agents/\(id)",
            body: .object(patchBody(patch)),
            for: accountID
        )
        return try decodeAgent(try require(response, named: "agent"))
    }

    /// Retires it. Its routines stop; its thread and its tasks stay, as
    /// ordinary chats and tasks.
    public func retire(id: String, for accountID: AccountID) async throws {
        try validate(id)
        _ = try await send(.delete, "/api/agents/\(id)", body: nil, for: accountID)
    }

    /// The agent's thread, created the first time anything asks for it. A
    /// POST, because the first call writes a conversation.
    public func thread(id: String, for accountID: AccountID) async throws -> String {
        try validate(id)
        let response = try await send(.post, "/api/agents/\(id)/thread", body: nil, for: accountID)
        guard let root = try object(response) else { throw WorkRemoteError.malformedResponse }
        return try string(root, "conversationId")
    }

    // MARK: - Goals

    public func goals(agentID: String, for accountID: AccountID) async throws -> [NativeAgentGoal] {
        try validate(agentID)
        let response = try await get("/api/agents/\(agentID)/goals", for: accountID)
        guard let root = try object(response) else { throw WorkRemoteError.malformedResponse }
        return list(root["goals"], decodeGoal)
    }

    public func createGoal(
        agentID: String,
        _ draft: NativeAgentGoalDraft,
        for accountID: AccountID
    ) async throws -> NativeAgentGoal {
        try validate(agentID)
        var body: [String: JunoJSONValue] = [
            "title": .string(draft.title.trimmingCharacters(in: .whitespacesAndNewlines)),
            "cadence": .string(draft.cadence.rawValue),
        ]
        let detail = draft.detail.trimmingCharacters(in: .whitespacesAndNewlines)
        if !detail.isEmpty { body["detail"] = .string(detail) }
        let response = try await send(
            .post,
            "/api/agents/\(agentID)/goals",
            body: .object(body),
            for: accountID
        )
        return try decodeGoal(try require(response, named: "goal"))
    }

    public func setGoalStatus(
        agentID: String,
        goalID: String,
        status: NativeAgentGoalStatus,
        for accountID: AccountID
    ) async throws -> NativeAgentGoal {
        try validate(agentID)
        try validate(goalID)
        let response = try await send(
            .patch,
            "/api/agents/\(agentID)/goals/\(goalID)",
            body: .object(["status": .string(status.rawValue)]),
            for: accountID
        )
        return try decodeGoal(try require(response, named: "goal"))
    }

    public func deleteGoal(agentID: String, goalID: String, for accountID: AccountID) async throws {
        try validate(agentID)
        try validate(goalID)
        _ = try await send(.delete, "/api/agents/\(agentID)/goals/\(goalID)", body: nil, for: accountID)
    }

    // MARK: - What it knows

    public func notes(agentID: String, for accountID: AccountID) async throws -> [NativeAgentNote] {
        try validate(agentID)
        let response = try await get("/api/agents/\(agentID)/notes", for: accountID)
        guard let root = try object(response) else { throw WorkRemoteError.malformedResponse }
        return list(root["notes"], decodeNote)
    }

    public func createNote(
        agentID: String,
        content: String,
        for accountID: AccountID
    ) async throws -> NativeAgentNote {
        try validate(agentID)
        let response = try await send(
            .post,
            "/api/agents/\(agentID)/notes",
            body: .object(["content": .string(content.trimmingCharacters(in: .whitespacesAndNewlines))]),
            for: accountID
        )
        return try decodeNote(try require(response, named: "note"))
    }

    public func updateNote(
        agentID: String,
        noteID: String,
        content: String,
        for accountID: AccountID
    ) async throws -> NativeAgentNote {
        try validate(agentID)
        try validate(noteID)
        let response = try await send(
            .patch,
            "/api/agents/\(agentID)/notes/\(noteID)",
            body: .object(["content": .string(content.trimmingCharacters(in: .whitespacesAndNewlines))]),
            for: accountID
        )
        return try decodeNote(try require(response, named: "note"))
    }

    public func deleteNote(agentID: String, noteID: String, for accountID: AccountID) async throws {
        try validate(agentID)
        try validate(noteID)
        _ = try await send(.delete, "/api/agents/\(agentID)/notes/\(noteID)", body: nil, for: accountID)
    }

    // MARK: - Ideas, tasks and reflection

    /// Starts or dismisses an idea. Starting may answer
    /// ``NativeAgentStartOutcome/needsConfirmation(estimatedCostMicroUSD:message:)``;
    /// ask the person, then call again with `confirmExpensive`. The server keys
    /// the task on the idea, so a retried start is the same task.
    public func decideIdea(
        agentID: String,
        ideaID: String,
        action: NativeAgentIdeaAction,
        confirmExpensive: Bool = false,
        for accountID: AccountID
    ) async throws -> NativeAgentStartOutcome {
        try validate(agentID)
        try validate(ideaID)
        var body: [String: JunoJSONValue] = ["action": .string(action.rawValue)]
        if confirmExpensive { body["confirmExpensive"] = .bool(true) }
        let answer = try await sendConfirmable(
            .patch,
            "/api/agents/\(agentID)/ideas/\(ideaID)",
            body: .object(body),
            for: accountID
        )
        switch answer {
        case .confirmation(let outcome):
            return outcome
        case .response(let response):
            let root = try object(response)
            return .accepted(
                sessionID: optionalString(root?["sessionId"]),
                conversationID: optionalString(root?["conversationId"])
            )
        }
    }

    /// Starts a task as the agent, in its thread, under its autonomy. The
    /// caller supplies the key so a lost response — or a second press after
    /// the cost question — lands on the same task.
    public func startTask(
        agentID: String,
        title: String,
        goal: String,
        idempotencyKey: String,
        confirmExpensive: Bool = false,
        for accountID: AccountID
    ) async throws -> NativeAgentStartOutcome {
        try validate(agentID)
        try validate(idempotencyKey)
        var body: [String: JunoJSONValue] = [
            "title": .string(String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(NativeAgentLimits.taskTitle))),
            "goal": .string(goal.trimmingCharacters(in: .whitespacesAndNewlines)),
            "idempotencyKey": .string(idempotencyKey),
        ]
        if confirmExpensive { body["confirmExpensive"] = .bool(true) }
        let answer = try await sendConfirmable(
            .post,
            "/api/agents/\(agentID)/tasks",
            body: .object(body),
            for: accountID
        )
        switch answer {
        case .confirmation(let outcome):
            return outcome
        case .response(let response):
            guard let root = try object(response) else { throw WorkRemoteError.malformedResponse }
            return .accepted(
                sessionID: optionalString(root["sessionId"]),
                conversationID: optionalString(root["conversationId"])
            )
        }
    }

    /// Asks the agent to reflect. Without `force` it is the lazy trigger a page
    /// fires on open and a no-op until six hours have passed; with it, it is
    /// the person pressing "Think it over".
    public func reflect(
        agentID: String,
        force: Bool,
        for accountID: AccountID
    ) async throws -> NativeAgentReflectOutcome {
        try validate(agentID)
        let response = try await send(
            .post,
            "/api/agents/\(agentID)/reflect",
            body: .object(["force": .bool(force)]),
            for: accountID
        )
        let outcome = try object(try require(response, named: "outcome"))
        if optionalString(outcome["kind"]) == "reflected" {
            return .reflected(
                ideas: integer(outcome["ideas"]),
                checkIns: integer(outcome["checkIns"]),
                notes: integer(outcome["notes"])
            )
        }
        return .skipped(reason: optionalString(outcome["reason"]) ?? "not_due")
    }

    // MARK: - Routines and the log

    public func routines(agentID: String, for accountID: AccountID) async throws -> [NativeAgentRoutine] {
        try validate(agentID)
        let response = try await get("/api/agents/\(agentID)/routines", for: accountID)
        guard let root = try object(response) else { throw WorkRemoteError.malformedResponse }
        return list(root["routines"], decodeRoutine)
    }

    /// Creates a real `WorkSchedule` under the agent. Full editing lives in
    /// Automations.
    public func createRoutine(
        agentID: String,
        _ draft: NativeAgentRoutineDraft,
        for accountID: AccountID
    ) async throws -> NativeAgentRoutine {
        try validate(agentID)
        let response = try await send(
            .post,
            "/api/agents/\(agentID)/routines",
            body: .object(routineBody(draft)),
            for: accountID
        )
        return try decodeRoutine(try require(response, named: "routine"))
    }

    public func activity(
        agentID: String,
        limit: Int = 60,
        for accountID: AccountID
    ) async throws -> [NativeAgentActivity] {
        try validate(agentID)
        let query = [URLQueryItem(name: "limit", value: String(min(200, max(1, limit))))]
        let response = try await get("/api/agents/\(agentID)/activity", query: query, for: accountID)
        guard let root = try object(response), case .array(let values)? = root["activity"] else {
            throw WorkRemoteError.malformedResponse
        }
        return values.compactMap { try? decodeActivity($0) }
    }

    // MARK: - Wire

    private func hireBody(_ draft: NativeAgentDraft) -> [String: JunoJSONValue] {
        var body: [String: JunoJSONValue] = [
            "name": .string(draft.name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "role": .string(draft.role.trimmingCharacters(in: .whitespacesAndNewlines)),
            "avatar": avatarBody(draft.avatar),
            "style": .string(draft.style.rawValue),
            "instructions": .string(draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines)),
            "approvalMode": .string(draft.approvalMode.rawValue),
            "connectorIds": .array(draft.connectorIDs.map { .string($0) }),
        ]
        if let template = draft.template, !template.isEmpty {
            body["template"] = .string(template)
        }
        // Absent rather than empty: `firstGoal` is `min(1)` on the server, and
        // no goal is a real answer to the fourth question.
        let firstGoal = draft.firstGoal.trimmingCharacters(in: .whitespacesAndNewlines)
        if !firstGoal.isEmpty { body["firstGoal"] = .string(firstGoal) }
        return body
    }

    private func patchBody(_ patch: NativeAgentPatch) -> [String: JunoJSONValue] {
        var body: [String: JunoJSONValue] = [:]
        if let name = patch.name {
            body["name"] = .string(name.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if let role = patch.role {
            body["role"] = .string(role.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if let avatar = patch.avatar { body["avatar"] = avatarBody(avatar) }
        if let style = patch.style { body["style"] = .string(style.rawValue) }
        if let instructions = patch.instructions {
            body["instructions"] = .string(instructions.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if let approvalMode = patch.approvalMode {
            body["approvalMode"] = .string(approvalMode.rawValue)
        }
        if let connectorIDs = patch.connectorIDs {
            body["connectorIds"] = .array(connectorIDs.map { .string($0) })
        }
        if let status = patch.status { body["status"] = .string(status.rawValue) }
        if let proactive = patch.proactive { body["proactive"] = .bool(proactive) }
        return body
    }

    private func avatarBody(_ avatar: JunoAgentAvatar) -> JunoJSONValue {
        .object([
            "shape": .string(avatar.shape.rawValue),
            "tone": .string(avatar.tone.rawValue),
            "eyes": .string(avatar.eyes.rawValue),
            "mark": .string(avatar.mark.rawValue),
        ])
    }

    private func routineBody(_ draft: NativeAgentRoutineDraft) -> [String: JunoJSONValue] {
        var body: [String: JunoJSONValue] = [
            "name": .string(draft.name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "instructions": .string(draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines)),
            "cadence": .string(draft.cadence.rawValue),
            "hour": .number(Double(min(23, max(0, draft.hour)))),
            "minute": .number(Double(min(59, max(0, draft.minute)))),
            "timezone": .string(draft.timezone),
        ]
        // Only the field the cadence reads. The server defaults the others and
        // a stray weekday on a daily routine is a value nobody can see.
        switch draft.cadence {
        case .weekly:
            body["weekday"] = .number(Double(min(6, max(0, draft.weekday))))
        case .monthly:
            body["monthday"] = .number(Double(min(31, max(1, draft.monthday))))
        case .hourly, .daily, .weekdays:
            break
        }
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
        let response = try await transmit(method, path, body: body, for: accountID)
        try requireSuccess(response)
        return response
    }

    /// A response that may be the server asking for a yes before it spends.
    private enum ConfirmableResponse {
        case response(HTTPResponse)
        case confirmation(NativeAgentStartOutcome)
    }

    /// `send`, except that `409 confirm_expensive` is returned as the question
    /// it is rather than thrown as a failure. Any other 409 — a paused agent,
    /// say — is still an error with the server's own sentence.
    private func sendConfirmable(
        _ method: HTTPMethod,
        _ path: String,
        body: JunoJSONValue?,
        for accountID: AccountID
    ) async throws -> ConfirmableResponse {
        let response = try await transmit(method, path, body: body, for: accountID)
        if response.statusCode == 409,
            let detail = try? object(response),
            detail["error"]?.stringValue == "confirm_expensive"
        {
            return .confirmation(
                .needsConfirmation(
                    estimatedCostMicroUSD: integer(detail["estimatedCostMicroUsd"]),
                    message: optionalString(detail["message"])
                        ?? "This will use a noticeable part of your usage window. Start it?"
                )
            )
        }
        try requireSuccess(response)
        return .response(response)
    }

    private func transmit(
        _ method: HTTPMethod,
        _ path: String,
        body: JunoJSONValue?,
        for accountID: AccountID
    ) async throws -> HTTPResponse {
        var headers = ["accept": "application/json"]
        if body != nil { headers["content-type"] = "application/json" }
        return try await sender.send(
            try NativeBearerRequest(
                path: path,
                method: method,
                headers: try HTTPHeaders(headers),
                body: try body.map { try JSONEncoder().encode($0) }
            ),
            for: accountID
        )
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
            ?? "Juno could not update your agents (\(response.statusCode))."
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

    /// Decodes a list leniently. One malformed goal must not blank the page it
    /// sits on; the rows this build can read are still worth drawing.
    private func list<Value>(
        _ value: JunoJSONValue?,
        _ decode: (JunoJSONValue) throws -> Value
    ) -> [Value] {
        guard case .array(let values)? = value else { return [] }
        return values.compactMap { try? decode($0) }
    }

    private func decodeAgent(_ value: JunoJSONValue) throws -> NativeAgent {
        let root = try object(value)
        let id = try string(root, "id")
        let face = try? object(root["avatar"])
        return NativeAgent(
            id: id,
            name: try string(root, "name"),
            role: optionalString(root["role"]) ?? "",
            avatar: JunoAgentAvatar(
                shape: face?["shape"]?.stringValue,
                tone: face?["tone"]?.stringValue,
                eyes: face?["eyes"]?.stringValue,
                mark: face?["mark"]?.stringValue,
                seed: id
            ),
            style: optionalString(root["style"]).flatMap(NativeAgentStyle.init(rawValue:)) ?? .warm,
            instructions: optionalString(root["instructions"]) ?? "",
            model: optionalString(root["model"]),
            reasoningEffort: optionalString(root["reasoningEffort"]),
            approvalMode: optionalString(root["approvalMode"])
                .flatMap(JunoWorkPermissionPolicy.init(rawValue:)) ?? .balanced,
            connectorIDs: strings(root["connectorIds"]),
            projectID: optionalString(root["projectId"]),
            conversationID: optionalString(root["conversationId"]),
            status: optionalString(root["status"]) == NativeAgentStatus.paused.rawValue ? .paused : .active,
            proactive: root["proactive"]?.boolValue ?? true,
            template: optionalString(root["template"]),
            lastReflectedAt: root["lastReflectedAt"]?.date,
            sortOrder: integer(root["sortOrder"]),
            createdAt: try date(root, "createdAt"),
            updatedAt: try date(root, "updatedAt"),
            state: optionalString(root["state"]).flatMap(JunoAgentState.init(rawValue:)) ?? .idle,
            stateSentence: optionalString(root["stateSentence"]) ?? "",
            task: root["task"].flatMap { try? decodeTask($0) },
            needsYou: integer(root["needsYou"]),
            nextRoutine: root["nextRoutine"].flatMap { try? decodeRoutineGlance($0) },
            newIdeas: integer(root["newIdeas"])
        )
    }

    private func decodeTask(_ value: JunoJSONValue) throws -> NativeAgentTask {
        let root = try object(value)
        return NativeAgentTask(
            sessionID: try string(root, "sessionId"),
            title: optionalString(root["title"]) ?? "Untitled task",
            status: optionalString(root["status"]) ?? "queued",
            needsAttention: root["needsAttention"]?.boolValue ?? false,
            lastActivityAt: root["lastActivityAt"]?.date,
            conversationID: optionalString(root["conversationId"])
        )
    }

    private func decodeRoutineGlance(_ value: JunoJSONValue) throws -> NativeAgentRoutineGlance {
        let root = try object(value)
        return NativeAgentRoutineGlance(
            scheduleID: try string(root, "scheduleId"),
            name: try string(root, "name"),
            nextRunAt: root["nextRunAt"]?.date
        )
    }

    private func decodeGoal(_ value: JunoJSONValue) throws -> NativeAgentGoal {
        let root = try object(value)
        return NativeAgentGoal(
            id: try string(root, "id"),
            agentID: optionalString(root["agentId"]) ?? "",
            title: try string(root, "title"),
            detail: optionalString(root["detail"]) ?? "",
            status: optionalString(root["status"]).flatMap(NativeAgentGoalStatus.init(rawValue:)) ?? .active,
            cadence: optionalString(root["cadence"]).flatMap(NativeAgentGoalCadence.init(rawValue:)) ?? .weekly,
            lastCheckInAt: root["lastCheckInAt"]?.date,
            lastCheckInNote: optionalString(root["lastCheckInNote"]),
            dueAt: root["dueAt"]?.date,
            createdAt: root["createdAt"]?.date,
            updatedAt: root["updatedAt"]?.date
        )
    }

    private func decodeIdea(_ value: JunoJSONValue) throws -> NativeAgentIdea {
        let root = try object(value)
        return NativeAgentIdea(
            id: try string(root, "id"),
            agentID: optionalString(root["agentId"]) ?? "",
            title: try string(root, "title"),
            detail: optionalString(root["detail"]) ?? "",
            prompt: optionalString(root["prompt"]) ?? "",
            status: optionalString(root["status"]) ?? "new",
            goalID: optionalString(root["goalId"]),
            createdAt: root["createdAt"]?.date,
            decidedAt: root["decidedAt"]?.date
        )
    }

    private func decodeNote(_ value: JunoJSONValue) throws -> NativeAgentNote {
        let root = try object(value)
        return NativeAgentNote(
            id: try string(root, "id"),
            agentID: optionalString(root["agentId"]) ?? "",
            content: try string(root, "content"),
            source: optionalString(root["source"]) ?? "agent",
            createdAt: root["createdAt"]?.date,
            updatedAt: root["updatedAt"]?.date
        )
    }

    private func decodeRoutine(_ value: JunoJSONValue) throws -> NativeAgentRoutine {
        let root = try object(value)
        return NativeAgentRoutine(
            id: try string(root, "id"),
            sessionID: optionalString(root["sessionId"]) ?? "",
            name: try string(root, "name"),
            instructions: optionalString(root["instructions"]) ?? "",
            enabled: root["enabled"]?.boolValue ?? false,
            timezone: optionalString(root["timezone"]) ?? TimeZone.current.identifier,
            schedule: optionalString(root["schedule"]) ?? "",
            nextRunAt: root["nextRunAt"]?.date,
            lastRunAt: root["lastRunAt"]?.date
        )
    }

    private func decodeActivity(_ value: JunoJSONValue) throws -> NativeAgentActivity {
        let root = try object(value)
        let kind = optionalString(root["kind"]) ?? "updated"
        return NativeAgentActivity(
            id: try string(root, "id"),
            kind: kind,
            // The server titles every line it writes. A line without one is
            // still a thing the agent did, and is said in general words rather
            // than dropped from the log.
            title: optionalString(root["title"]) ?? NativeAgentActivity.fallbackTitle(for: kind),
            detail: optionalString(root["detail"]),
            at: root["at"]?.date,
            sessionID: optionalString(root["sessionId"]),
            tone: optionalString(root["tone"]).flatMap(NativeAgentActivityTone.init(rawValue:)) ?? .neutral
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
}
