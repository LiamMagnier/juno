import Foundation
import JunoCodeCore

public enum SessionStoreError: Error, Equatable, Sendable {
    case sessionNotFound(id: String)
    case persistenceFailed(message: String)
}

/// Disk-backed store for sessions, transcripts and model conversations.
///
/// Layout under the store directory:
/// `sessions/<id>/session.json` — the session record;
/// `sessions/<id>/events.jsonl` — append-only transcript events;
/// `sessions/<id>/conversation.json` — exact model context for resume.
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

    public func createSession(
        workspaceID: WorkspaceID,
        workspaceName: String,
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

    public func deleteSession(id: CodeSessionID) throws {
        try loadIfNeeded()
        guard sessions.removeValue(forKey: id) != nil else { return }
        eventCounts.removeValue(forKey: id)
        try? FileManager.default.removeItem(at: sessionDirectory(id))
        notify(.sessionRemoved(id))
    }

    // MARK: - Events

    @discardableResult
    public func appendEvent(
        sessionID: CodeSessionID,
        payload: SessionEventPayload
    ) throws -> SessionEvent {
        try loadIfNeeded()
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
        eventCounts[sessionID] = sequence + 1
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
            let data = try encoder.encode(messages)
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
        loaded = true
        let sessionsDirectory = directoryURL.appendingPathComponent("sessions")
        try? FileManager.default.createDirectory(
            at: sessionsDirectory,
            withIntermediateDirectories: true
        )
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let children = (try? FileManager.default.contentsOfDirectory(
            at: sessionsDirectory,
            includingPropertiesForKeys: nil
        )) ?? []
        for child in children {
            let sessionFile = child.appendingPathComponent("session.json")
            guard let data = try? Data(contentsOf: sessionFile),
                  var session = try? decoder.decode(CodeSession.self, from: data)
            else { continue }
            // A session that was mid-run when the app died is interrupted,
            // not silently running.
            if session.status.isActive {
                session.status = .failed
                session.lastErrorSummary = "Interrupted by app termination."
            }
            sessions[session.id] = session
            // Restore the next sequence from the persisted transcript.
            if let eventsData = try? Data(contentsOf: child.appendingPathComponent("events.jsonl")) {
                eventCounts[session.id] = eventsData.split(separator: 0x0A).count
            }
        }
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
