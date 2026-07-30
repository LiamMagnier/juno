import Foundation
import JunoCodeCore

public enum SessionStoreError: Error, Equatable, Sendable {
    case sessionNotFound(id: String)
    case goalAlreadyExists(sessionID: String)
    case goalNotFound(sessionID: String)
    case persistenceFailed(message: String)
}

/// Disk-backed store for sessions, transcripts and model conversations.
///
/// Layout under the store directory:
/// `sessions/<id>/session.json` — the session record;
/// `sessions/<id>/events.jsonl` — append-only transcript events;
/// `sessions/<id>/conversation.json` — resumable model context with ephemeral
/// screenshot bytes redacted before they reach disk.
public actor CodeSessionStore {
    private let directoryURL: URL
    private var sessions: [CodeSessionID: CodeSession] = [:]
    private var eventCounts: [CodeSessionID: Int] = [:]
    private var observers: [UUID: @Sendable (StoreUpdate) -> Void] = [:]
    private var loaded = false

    public enum StoreUpdate: Sendable {
        case sessionChanged(CodeSession)
        case sessionRemoved(CodeSessionID)
        case eventAppended(SessionEvent)
    }

    public init(directoryURL: URL) {
        self.directoryURL = directoryURL
    }

    // MARK: - Observation

    @discardableResult
    public func addObserver(
        _ observer: @escaping @Sendable (StoreUpdate) -> Void
    ) -> UUID {
        let id = UUID()
        observers[id] = observer
        return id
    }

    public func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
    }

    private func notify(_ update: StoreUpdate) {
        for observer in observers.values {
            observer(update)
        }
    }

    // MARK: - Sessions

    /// - Parameters:
    ///   - workspaceID: nil for a conversation started with no project. The
    ///     session is created, persisted and streamed exactly as any other; it
    ///     simply has no folder, which the runtime reads as "no file or shell
    ///     tools" rather than as a missing value to fill in later.
    public func createSession(
        workspaceID: WorkspaceID?,
        workspaceName: String?,
        title: String,
        configuration: AgentConfiguration,
        gitBranch: String?
    ) throws -> CodeSession {
        try loadIfNeeded()
        let now = Date()
        let session = CodeSession(
            workspaceID: workspaceID,
            title: title,
            configuration: configuration,
            gitBranch: gitBranch,
            createdAt: now,
            updatedAt: now
        )
        sessions[session.id] = session
        try persist(session)
        notify(.sessionChanged(session))
        _ = try appendEvent(
            sessionID: session.id,
            payload: .sessionCreated(
                SessionCreatedEvent(
                    workspaceID: workspaceID,
                    workspaceName: workspaceName,
                    configuration: configuration
                )
            )
        )
        return session
    }

    public func session(id: CodeSessionID) throws -> CodeSession {
        try loadIfNeeded()
        guard let session = sessions[id] else {
            throw SessionStoreError.sessionNotFound(id: id.value)
        }
        return session
    }

    /// All sessions, most recently updated first.
    public func allSessions() -> [CodeSession] {
        try? loadIfNeeded()
        return sessions.values.sorted { $0.updatedAt > $1.updatedAt }
    }

    public func updateSession(
        id: CodeSessionID,
        mutate: @Sendable (inout CodeSession) -> Void
    ) throws -> CodeSession {
        try loadIfNeeded()
        guard var session = sessions[id] else {
            throw SessionStoreError.sessionNotFound(id: id.value)
        }
        mutate(&session)
        session.updatedAt = Date()
        sessions[id] = session
        try persist(session)
        notify(.sessionChanged(session))
        return session
    }

    public func setStatus(id: CodeSessionID, status: SessionStatus) throws {
        _ = try updateSession(id: id) { session in
            session.status = status
            if status != .waitingForApproval {
                session.hasPendingApproval = false
            }
        }
        _ = try appendEvent(
            sessionID: id,
            payload: .statusChanged(StatusChangedEvent(status: status))
        )
    }

    // MARK: - Durable goals

    public func goal(for sessionID: CodeSessionID) throws -> SessionGoal? {
        try loadIfNeeded()
        guard let session = sessions[sessionID] else {
            throw SessionStoreError.sessionNotFound(id: sessionID.value)
        }
        return session.goal
    }

    /// Creates the one durable goal owned by a session.
    ///
    /// A goal starts active, with ordered pending steps. Replacing an existing
    /// goal is deliberately rejected so an agent cannot erase its completion
    /// contract or audit trail.
    @discardableResult
    public func createGoal(
        sessionID: CodeSessionID,
        objective: String,
        steps: [String],
        at timestamp: Date = Date()
    ) throws -> SessionGoal {
        try loadIfNeeded()
        guard let session = sessions[sessionID] else {
            throw SessionStoreError.sessionNotFound(id: sessionID.value)
        }
        guard session.goal == nil else {
            throw SessionStoreError.goalAlreadyExists(sessionID: sessionID.value)
        }
        let goal = SessionGoal(
            objective: objective.trimmingCharacters(in: .whitespacesAndNewlines),
            steps: steps.map {
                GoalStep(
                    title: $0.trimmingCharacters(in: .whitespacesAndNewlines),
                    createdAt: timestamp
                )
            },
            createdAt: timestamp
        )
        try goal.validate()
        return try persistGoalUpdate(
            sessionID: sessionID,
            goal: goal,
            kind: .created
        )
    }

    /// Applies one validated state-machine transition and appends its complete
    /// resulting snapshot to the session transcript.
    @discardableResult
    public func updateGoal(
        sessionID: CodeSessionID,
        mutation: GoalMutation,
        at timestamp: Date = Date()
    ) throws -> SessionGoal {
        try loadIfNeeded()
        guard let session = sessions[sessionID] else {
            throw SessionStoreError.sessionNotFound(id: sessionID.value)
        }
        guard var goal = session.goal else {
            throw SessionStoreError.goalNotFound(sessionID: sessionID.value)
        }
        try goal.apply(mutation, at: timestamp)

        let kind: GoalUpdatedEvent.Kind
        switch mutation {
        case .setObjective:
            kind = .objectiveChanged
        case .setLifecycle:
            kind = .lifecycleChanged
        case .addStep:
            kind = .stepAdded
        case .setStepStatus:
            kind = .stepStatusChanged
        case .addVerificationEvidence:
            kind = .verificationAdded
        }
        return try persistGoalUpdate(
            sessionID: sessionID,
            goal: goal,
            kind: kind
        )
    }

    public func deleteSession(id: CodeSessionID) throws {
        try loadIfNeeded()
        guard sessions[id] != nil else { return }
        let directory = sessionDirectory(id)
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
        sessions.removeValue(forKey: id)
        eventCounts.removeValue(forKey: id)
        notify(.sessionRemoved(id))
    }

    // MARK: - Events

    @discardableResult
    public func appendEvent(
        sessionID: CodeSessionID,
        payload: SessionEventPayload
    ) throws -> SessionEvent {
        try loadIfNeeded()
        return try appendLoadedEvent(sessionID: sessionID, payload: payload)
    }

    /// Appends while the store's in-memory index is already populated.
    ///
    /// Startup repair uses this path so `loadIfNeeded()` can leave `loaded`
    /// false until every session and repair write succeeds, without recursively
    /// entering itself through the public `appendEvent` API.
    private func appendLoadedEvent(
        sessionID: CodeSessionID,
        payload: SessionEventPayload
    ) throws -> SessionEvent {
        guard sessions[sessionID] != nil else {
            throw SessionStoreError.sessionNotFound(id: sessionID.value)
        }
        let sequence = eventCounts[sessionID, default: 0]
        let event = SessionEvent(
            sessionID: sessionID,
            sequence: sequence,
            timestamp: Date(),
            payload: payload
        )
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            var line = try encoder.encode(event)
            line.append(0x0A)
            let url = eventsURL(sessionID)
            if let handle = FileHandle(forWritingAtPath: url.path) {
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: line)
            } else {
                try line.write(to: url, options: .atomic)
            }
        } catch {
            throw SessionStoreError.persistenceFailed(message: String(describing: error))
        }
        eventCounts[sessionID] = sequence + 1
        notify(.eventAppended(event))
        return event
    }

    public func events(for sessionID: CodeSessionID) -> [SessionEvent] {
        try? loadIfNeeded()
        guard let data = try? Data(contentsOf: eventsURL(sessionID)) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return data.split(separator: 0x0A).compactMap {
            try? decoder.decode(SessionEvent.self, from: Data($0))
        }
    }

    // MARK: - Conversation persistence

    public func saveConversation(
        sessionID: CodeSessionID,
        messages: [ModelMessage]
    ) throws {
        try loadIfNeeded()
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(messages.map(\.persistenceSafe))
            try data.write(to: conversationURL(sessionID), options: .atomic)
        } catch {
            throw SessionStoreError.persistenceFailed(message: String(describing: error))
        }
    }

    public func loadConversation(sessionID: CodeSessionID) -> [ModelMessage] {
        guard let data = try? Data(contentsOf: conversationURL(sessionID)) else { return [] }
        return (try? JSONDecoder().decode([ModelMessage].self, from: data)) ?? []
    }

    // MARK: - Persistence

    private func loadIfNeeded() throws {
        guard !loaded else { return }
        sessions.removeAll(keepingCapacity: true)
        eventCounts.removeAll(keepingCapacity: true)

        do {
            let interruptionMessage = "Interrupted by app termination."
            let sessionsDirectory = directoryURL.appendingPathComponent("sessions")
            try FileManager.default.createDirectory(
                at: sessionsDirectory,
                withIntermediateDirectories: true
            )
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let children = try FileManager.default.contentsOfDirectory(
                at: sessionsDirectory,
                includingPropertiesForKeys: nil
            )
            var repairedSessions: [CodeSession] = []

            for child in children {
                let sessionFile = child.appendingPathComponent("session.json")
                guard let data = try? Data(contentsOf: sessionFile),
                      var session = try? decoder.decode(CodeSession.self, from: data)
                else { continue }

                let eventsFile = child.appendingPathComponent("events.jsonl")
                let eventsData = try? Data(contentsOf: eventsFile)
                let eventLines = eventsData?.split(separator: 0x0A) ?? []
                let persistedEvents = eventLines.compactMap {
                    try? decoder.decode(SessionEvent.self, from: Data($0))
                }

                // A session that was mid-run when the app died is interrupted,
                // not silently running. A terminal session carrying the exact
                // interruption marker may be a prior repair that persisted the
                // session record before one or both transcript events; finish
                // that repair on retry.
                let wasInterrupted = session.status.isActive
                let requiresRepair =
                    wasInterrupted
                    || (
                        session.status == .failed
                            && session.lastErrorSummary == interruptionMessage
                    )
                if wasInterrupted {
                    session.status = .failed
                    session.hasPendingApproval = false
                    session.lastErrorSummary = interruptionMessage
                    session.updatedAt = Date()
                }

                sessions[session.id] = session
                eventCounts[session.id] = eventLines.count
                guard requiresRepair else { continue }

                // Persisting the terminal session first prevents a relaunch
                // from presenting stale active work. Repair events are added
                // only when the canonical terminal suffix is incomplete, so a
                // retry after a half-written repair is idempotent.
                try persist(session)
                switch interruptionRepairState(
                    events: persistedEvents,
                    interruptionMessage: interruptionMessage
                ) {
                case .complete:
                    break
                case .missingError:
                    _ = try appendLoadedEvent(
                        sessionID: session.id,
                        payload: .errorOccurred(
                            ErrorEvent(message: interruptionMessage, isRecoverable: true)
                        )
                    )
                case .missingStatusAndError:
                    _ = try appendLoadedEvent(
                        sessionID: session.id,
                        payload: .statusChanged(StatusChangedEvent(status: .failed))
                    )
                    _ = try appendLoadedEvent(
                        sessionID: session.id,
                        payload: .errorOccurred(
                            ErrorEvent(message: interruptionMessage, isRecoverable: true)
                        )
                    )
                }
                repairedSessions.append(session)
            }

            loaded = true
            for session in repairedSessions {
                notify(.sessionChanged(session))
            }
        } catch {
            // Never expose or reuse a partially populated index. In particular,
            // a failed interruption repair must retry from durable state on the
            // next call rather than leaving this actor permanently "loaded".
            sessions.removeAll(keepingCapacity: true)
            eventCounts.removeAll(keepingCapacity: true)
            loaded = false
            if let storeError = error as? SessionStoreError {
                throw storeError
            }
            throw SessionStoreError.persistenceFailed(message: String(describing: error))
        }
    }

    private enum InterruptionRepairState {
        case complete
        case missingError
        case missingStatusAndError
    }

    private func interruptionRepairState(
        events: [SessionEvent],
        interruptionMessage: String
    ) -> InterruptionRepairState {
        guard let last = events.last else {
            return .missingStatusAndError
        }
        if case let .errorOccurred(error) = last.payload,
           error.message == interruptionMessage,
           error.isRecoverable,
           events.count >= 2,
           case let .statusChanged(status) = events[events.count - 2].payload,
           status.status == .failed
        {
            return .complete
        }
        if case let .statusChanged(status) = last.payload,
           status.status == .failed
        {
            return .missingError
        }
        return .missingStatusAndError
    }

    private func persist(_ session: CodeSession) throws {
        do {
            let directory = sessionDirectory(session.id)
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(session)
            try data.write(to: directory.appendingPathComponent("session.json"), options: .atomic)
        } catch {
            throw SessionStoreError.persistenceFailed(message: String(describing: error))
        }
    }

    private func persistGoalUpdate(
        sessionID: CodeSessionID,
        goal: SessionGoal,
        kind: GoalUpdatedEvent.Kind
    ) throws -> SessionGoal {
        guard var session = sessions[sessionID] else {
            throw SessionStoreError.sessionNotFound(id: sessionID.value)
        }
        let previous = session
        session.goal = goal
        session.updatedAt = goal.updatedAt
        sessions[sessionID] = session
        do {
            try persist(session)
            _ = try appendEvent(
                sessionID: sessionID,
                payload: .goalUpdated(GoalUpdatedEvent(kind: kind, goal: goal))
            )
        } catch {
            sessions[sessionID] = previous
            try? persist(previous)
            throw error
        }
        notify(.sessionChanged(session))
        return goal
    }

    private func sessionDirectory(_ id: CodeSessionID) -> URL {
        directoryURL.appendingPathComponent("sessions").appendingPathComponent(id.value)
    }

    private func eventsURL(_ id: CodeSessionID) -> URL {
        sessionDirectory(id).appendingPathComponent("events.jsonl")
    }

    private func conversationURL(_ id: CodeSessionID) -> URL {
        sessionDirectory(id).appendingPathComponent("conversation.json")
    }
}
