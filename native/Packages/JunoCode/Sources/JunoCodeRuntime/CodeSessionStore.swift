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
/// `sessions/<id>/summary.json` — what the transcript amounts to (see
/// `SessionTranscriptSummary`), derived from `events.jsonl` and rebuilt from
/// it whenever it cannot be trusted;
/// `sessions/<id>/conversation.json` — resumable model context with ephemeral
/// screenshot bytes redacted before they reach disk.
///
/// Launch reads the session records and nothing else. Every list surface is
/// drawn from them, and a transcript can run to tens of thousands of events,
/// so decoding one is the cost of opening that session — never of listing it.
/// The only exception is a session that was mid-run when the app died, whose
/// repair needs to see how its transcript ends; it reads the last two events
/// from the end of the file.
public actor CodeSessionStore {
    private let directoryURL: URL
    private var sessions: [CodeSessionID: CodeSession] = [:]
    /// The transcript summaries this store has read, rebuilt or kept up to date
    /// since launch. A session without an entry has not been needed yet; the
    /// background pass started by `loadIfNeeded()` fills them in.
    private var transcripts: [CodeSessionID: TranscriptIndex] = [:]
    /// Summaries that changed in memory since they were last written.
    private var unsavedTranscripts: Set<CodeSessionID> = []
    private var transcriptSaveTask: Task<Void, Never>?
    private var transcriptMaintenance: Task<Void, Never>?
    private let transcriptSaveDelay: Duration
    private let eventDecoder: SessionEventLineDecoder
    private var observers: [UUID: @Sendable (StoreUpdate) -> Void] = [:]
    private var loaded = false

    public enum StoreUpdate: Sendable {
        case sessionChanged(CodeSession)
        case sessionRemoved(CodeSessionID)
        case eventAppended(SessionEvent)
    }

    public init(directoryURL: URL) {
        self.init(directoryURL: directoryURL, eventDecoder: .standard)
    }

    /// - Parameter transcriptSaveDelay: how long a changed summary may sit in
    ///   memory before it is written. See `scheduleTranscriptSave(for:)`.
    init(
        directoryURL: URL,
        eventDecoder: SessionEventLineDecoder,
        transcriptSaveDelay: Duration = .seconds(1)
    ) {
        self.directoryURL = directoryURL
        self.eventDecoder = eventDecoder
        self.transcriptSaveDelay = transcriptSaveDelay
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
    ///   - parentSessionID: the session that delegated this one. Non-nil marks a
    ///     sub-agent, which every list surface hides so a delegation cannot
    ///     surface as a second conversation. It is still persisted, still
    ///     notified and still readable by id — a hidden session that could not
    ///     be opened would be a session the reader could never inspect or
    ///     delete.
    public func createSession(
        workspaceID: WorkspaceID?,
        executionRootPath: String? = nil,
        workspaceName: String?,
        title: String,
        configuration: AgentConfiguration,
        gitBranch: String?,
        parentSessionID: CodeSessionID? = nil
    ) throws -> CodeSession {
        try loadIfNeeded()
        let now = Date()
        let session = CodeSession(
            workspaceID: workspaceID,
            executionRootPath: executionRootPath,
            parentSessionID: parentSessionID,
            title: title,
            configuration: configuration,
            gitBranch: gitBranch,
            createdAt: now,
            updatedAt: now
        )
        sessions[session.id] = session
        // A new session has no transcript yet, so there is nothing to read or
        // rebuild: its summary starts empty and grows with every append.
        transcripts[session.id] = .empty
        try persist(session)
        notify(.sessionChanged(session))
        _ = try appendEvent(
            sessionID: session.id,
            payload: .sessionCreated(
                SessionCreatedEvent(
                    workspaceID: workspaceID,
                    executionRootPath: executionRootPath,
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

    /// The sub-agent sessions `id` delegated, oldest first.
    ///
    /// Children are hidden from every list the reader browses, which means
    /// deleting a parent is the only occasion they can be reached for cleanup.
    /// Without this they would accumulate on disk with no surface able to name
    /// them.
    public func childSessions(of id: CodeSessionID) -> [CodeSession] {
        try? loadIfNeeded()
        return sessions.values
            .filter { $0.parentSessionID == id }
            // Tie-broken on the identifier because concurrent sub-agents are
            // created within the same millisecond, and a dictionary's iteration
            // order is not stable — without this the same run would return the
            // same children in a different order each time it was read.
            .sorted {
                $0.createdAt == $1.createdAt
                    ? $0.id.value < $1.id.value
                    : $0.createdAt < $1.createdAt
            }
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
        // One directory holds the record, the transcript, its summary and the
        // conversation, so removing it removes all four together.
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
        sessions.removeValue(forKey: id)
        transcripts.removeValue(forKey: id)
        unsavedTranscripts.remove(id)
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
        let url = eventsURL(sessionID)
        let event: SessionEvent
        var index: TranscriptIndex
        do {
            // Opened for update rather than for writing: the last byte has to
            // be read before anything is appended after it.
            let handle = FileManager.default.fileExists(atPath: url.path)
                ? try FileHandle(forUpdating: url)
                : nil
            defer { try? handle?.close() }
            let end = try handle.map { Int(try $0.seekToEnd()) } ?? 0
            index = transcriptIndex(for: sessionID, fileLength: end)
            event = SessionEvent(
                sessionID: sessionID,
                sequence: index.summary.eventCount,
                timestamp: Date(),
                payload: payload
            )
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            var line = try encoder.encode(event)
            line.append(0x0A)
            if let handle {
                // A line cut short by a crash mid-write has no newline.
                // Appending straight after it would weld this event onto it
                // and lose both; ending it first costs one unreadable line
                // instead of two, and keeps the summary's line count true.
                if end > 0 {
                    try handle.seek(toOffset: UInt64(end - 1))
                    if try handle.read(upToCount: 1) != Data([0x0A]) {
                        line.insert(0x0A, at: line.startIndex)
                    }
                    try handle.seek(toOffset: UInt64(end))
                }
                try handle.write(contentsOf: line)
            } else {
                try line.write(to: url, options: .atomic)
            }
            index.absorb(event, writtenAs: line)
        } catch {
            throw SessionStoreError.persistenceFailed(message: String(describing: error))
        }
        transcripts[sessionID] = index
        scheduleTranscriptSave(for: sessionID)
        notify(.eventAppended(event))
        return event
    }

    /// The whole transcript, decoded: the cost of opening a session.
    ///
    /// The length is taken on the actor and the bytes are read and decoded on
    /// a detached task, so a long transcript does not hold up appends to every
    /// other session while it is read. Appends happen only on the actor, which
    /// makes that length exactly the transcript at the moment of the call — the
    /// same snapshot this returned when it read on the actor.
    ///
    /// Nothing is cached here. The caller that opened the session holds the
    /// events for as long as it shows them; the store keeps only the summary.
    public func events(for sessionID: CodeSessionID) async -> [SessionEvent] {
        try? loadIfNeeded()
        let url = eventsURL(sessionID)
        guard let length = TranscriptFiles.regularFileLength(url), length > 0 else {
            return []
        }
        let decoder = eventDecoder
        let read = await Task.detached(priority: .userInitiated) {
            TranscriptFiles.events(in: url, length: length, decoder: decoder)
        }.value
        // Reading every line is also a rebuild of the summary, so a session
        // opened before the launch pass reached it is not read twice.
        if read.index.byteCount == length {
            adoptTranscriptIndex(
                TranscriptFiles.Loaded(index: read.index, needsSave: true),
                for: sessionID
            )
        }
        return read.events
    }

    // MARK: - Transcript summaries

    /// What a session's transcript amounts to, without decoding it; nil for a
    /// session this store does not have.
    ///
    /// Usually already in memory. When the launch pass has not reached this
    /// session yet, the saved summary is checked — or the transcript read, for
    /// a session that has none — on a detached task, as that pass would have.
    public func transcriptSummary(
        for sessionID: CodeSessionID
    ) async -> SessionTranscriptSummary? {
        try? loadIfNeeded()
        guard sessions[sessionID] != nil else { return nil }
        if let index = transcripts[sessionID] {
            return index.summary
        }
        let eventsURL = eventsURL(sessionID)
        let summaryURL = summaryURL(sessionID)
        let decoder = eventDecoder
        let loaded = await Task.detached(priority: .userInitiated) {
            TranscriptFiles.loadIndex(
                eventsURL: eventsURL,
                summaryURL: summaryURL,
                decoder: decoder
            )
        }.value
        adoptTranscriptIndex(loaded, for: sessionID)
        // Read back rather than returning `loaded`: an append while the read
        // was under way installed a summary that is newer than it.
        return transcripts[sessionID]?.summary
    }

    /// Writes every summary that changed since it was last written. Runs on a
    /// short timer after appends; a host about to let the store go calls it so
    /// the next launch finds nothing to catch up.
    public func saveTranscriptSummaries() {
        transcriptSaveTask?.cancel()
        transcriptSaveTask = nil
        let pending = unsavedTranscripts
        unsavedTranscripts.removeAll()
        for id in pending {
            guard sessions[id] != nil, let index = transcripts[id] else { continue }
            // Not an error anyone could act on: the summary is derived, and the
            // next launch rebuilds whatever did not reach the disk.
            try? TranscriptFiles.save(index, to: summaryURL(id))
        }
    }

    /// Waits for the launch pass over saved summaries (test support).
    func awaitTranscriptMaintenance() async {
        try? loadIfNeeded()
        await transcriptMaintenance?.value
    }

    /// The summary an append numbers its event from: the one in memory while
    /// it still describes the file, otherwise the saved one checked against
    /// the file, then caught up or rebuilt.
    ///
    /// On the actor, not on a detached task like every other read here,
    /// because an append must not suspend. Two appends that each waited on a
    /// read could resume in either order, and a transcript's order is the
    /// order its appends were called in. The cost falls only on the first
    /// append to a session the launch pass has not reached, and is a full read
    /// only for a session saved before summaries existed.
    private func transcriptIndex(for id: CodeSessionID, fileLength: Int) -> TranscriptIndex {
        if let index = transcripts[id], index.byteCount == fileLength {
            return index
        }
        // Absent, or describing a file that changed without this store: some
        // other writer, or a restore from a backup. Either way the file wins.
        let loaded = TranscriptFiles.loadIndex(
            eventsURL: eventsURL(id),
            summaryURL: summaryURL(id),
            decoder: eventDecoder
        )
        transcripts[id] = loaded.index
        return loaded.index
    }

    /// Installs a summary read off the actor, unless one got there first.
    ///
    /// "First" is decisive because every append installs the summary it
    /// numbered from before it writes. A summary already present is therefore
    /// at least as new as anything read concurrently, and a read that raced a
    /// write — and may have seen half a line — is the one discarded.
    private func adoptTranscriptIndex(_ loaded: TranscriptFiles.Loaded, for id: CodeSessionID) {
        guard sessions[id] != nil, transcripts[id] == nil else { return }
        transcripts[id] = loaded.index
        if loaded.needsSave {
            scheduleTranscriptSave(for: id)
        }
    }

    private func needsTranscriptIndex(_ id: CodeSessionID) -> Bool {
        sessions[id] != nil && transcripts[id] == nil
    }

    /// Marks a summary as changed and makes sure it is written soon.
    ///
    /// Not written on every append: a command streaming output appends an
    /// event per chunk, and rewriting the summary for each would double the
    /// store's disk traffic for a file nobody reads until the next launch. The
    /// summary in memory is always exact; the copy on disk trails it by at most
    /// the delay, and a copy left behind by a crash is caught up from the end
    /// of the transcript on the next launch.
    private func scheduleTranscriptSave(for id: CodeSessionID) {
        unsavedTranscripts.insert(id)
        guard transcriptSaveTask == nil else { return }
        let delay = transcriptSaveDelay
        transcriptSaveTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            // Cancelled means a direct call already wrote everything pending.
            guard !Task.isCancelled else { return }
            await self?.saveTranscriptSummaries()
        }
    }

    /// Checks every saved summary against its transcript, off the actor and
    /// most recently updated first — the sessions a reader is likeliest to
    /// reach for.
    ///
    /// Started once the session records are loaded, so it never delays the
    /// list. A session saved before summaries existed is read in full here,
    /// once; its summary is then written and the next launch only checks it.
    private func startTranscriptMaintenance() {
        guard transcriptMaintenance == nil else { return }
        let pending = sessions.values
            .filter { transcripts[$0.id] == nil }
            .sorted { $0.updatedAt > $1.updatedAt }
            .map { (id: $0.id, events: eventsURL($0.id), summary: summaryURL($0.id)) }
        guard !pending.isEmpty else { return }
        let decoder = eventDecoder
        transcriptMaintenance = Task.detached(priority: .utility) { [weak self] in
            for entry in pending {
                guard !Task.isCancelled, let store = self else { return }
                // An append, an open or a listing may have needed this session
                // first and read it already.
                guard await store.needsTranscriptIndex(entry.id) else { continue }
                let loaded = TranscriptFiles.loadIndex(
                    eventsURL: entry.events,
                    summaryURL: entry.summary,
                    decoder: decoder
                )
                await store.adoptTranscriptIndex(loaded, for: entry.id)
            }
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

    /// Reads every session record — and, apart from interrupted sessions, only
    /// the records. See the type's documentation for why transcripts wait.
    private func loadIfNeeded() throws {
        guard !loaded else { return }
        sessions.removeAll(keepingCapacity: true)
        transcripts.removeAll(keepingCapacity: true)
        unsavedTranscripts.removeAll()

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
                guard requiresRepair else { continue }

                // Persisting the terminal session first prevents a relaunch
                // from presenting stale active work. Repair events are added
                // only when the canonical terminal suffix is incomplete, so a
                // retry after a half-written repair is idempotent. That suffix
                // is two events long, so two events are all that is read.
                try persist(session)
                let trailingEvents = TranscriptFiles.trailingEvents(
                    in: eventsURL(session.id),
                    limit: 2,
                    decoder: eventDecoder
                )
                switch interruptionRepairState(
                    events: trailingEvents,
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
            startTranscriptMaintenance()
        } catch {
            // Never expose or reuse a partially populated index. In particular,
            // a failed interruption repair must retry from durable state on the
            // next call rather than leaving this actor permanently "loaded".
            sessions.removeAll(keepingCapacity: true)
            transcripts.removeAll(keepingCapacity: true)
            unsavedTranscripts.removeAll()
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

    private func summaryURL(_ id: CodeSessionID) -> URL {
        sessionDirectory(id).appendingPathComponent(TranscriptFiles.summaryFileName)
    }

    private func conversationURL(_ id: CodeSessionID) -> URL {
        sessionDirectory(id).appendingPathComponent("conversation.json")
    }
}
