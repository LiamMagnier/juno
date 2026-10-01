import Foundation
import JunoCodeCore

public enum SessionStoreError: Error, Equatable, Sendable {
    case sessionNotFound(id: String)
    /// A caller-chosen id already names a session. Refused rather than
    /// overwritten: an id arriving from another device must never be able to
    /// replace a transcript that is already here.
    case sessionAlreadyExists(id: String)
    case goalAlreadyExists(sessionID: String)
    case goalNotFound(sessionID: String)
    case persistenceFailed(message: String)
}

/// Disk-backed store for sessions, transcripts and model conversations.
///
/// Layout under the store directory:
/// `sessions/<id>/session.json` — the session record;
/// `sessions/<id>/events.jsonl` — append-only transcript events, cut back only
/// by a rewind the reader asked for (`rewindConversation`);
/// `sessions/<id>/summary.json` — what the transcript amounts to (see
/// `SessionTranscriptSummary`), derived from `events.jsonl` and rebuilt from
/// it whenever it cannot be trusted;
/// `sessions/<id>/conversation.json` — resumable model context with ephemeral
/// screenshot bytes redacted before they reach disk.
///
/// Sequence numbers only ever go up. The next event takes one past the highest
/// sequence the transcript holds, which is its line count until a rewind cuts
/// lines away without giving their numbers back; the summary keeps both, so
/// numbering an append never needs the transcript decoded.
///
/// Launch reads the session records and nothing else. Every list surface is
/// drawn from them, and a transcript can run to tens of thousands of events,
/// so decoding one is the cost of opening that session — never of listing it.
/// The only exception is a session that was mid-run when the app died, whose
/// repair needs to see how its transcript ends and to number the events that
/// close it: it decodes the last two events, read from the end of the file,
/// and counts lines without decoding them — only those written after the
/// saved summary when that summary is intact, every line when it is not. The
/// summary itself is left to the background pass, as every other one is.
public actor CodeSessionStore {
    private let directoryURL: URL
    private var sessions: [CodeSessionID: CodeSession] = [:]
    /// The transcript summaries this store has read, rebuilt or kept up to date
    /// since launch. A session without an entry has not been needed yet; the
    /// background pass started by `loadIfNeeded()` fills them in. Each one's
    /// `nextSequence` is the sequence that session's next event takes.
    private var transcripts: [CodeSessionID: TranscriptIndex] = [:]
    /// Summaries that changed in memory since they were last written.
    private var unsavedTranscripts: Set<CodeSessionID> = []
    private var transcriptSaveTask: Task<Void, Never>?
    private var transcriptMaintenance: Task<Void, Never>?
    private let transcriptSaveDelay: Duration
    private let eventDecoder: SessionEventLineDecoder
    private var observers: [UUID: @Sendable (StoreUpdate) -> Void] = [:]
    private var loaded = false
    /// Each session's spend as read from or written to `usage.json`, so a
    /// session's ledger is read from disk once.
    private var usageLedgers: [CodeSessionID: SessionUsageLedger] = [:]

    public enum StoreUpdate: Sendable {
        case sessionChanged(CodeSession)
        case sessionRemoved(CodeSessionID)
        case eventAppended(SessionEvent)
        /// A session's spend grew: its own calls, or a sub-agent's.
        case usageChanged(CodeSessionID, SessionUsageLedger)
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
    ///   - id: the session's identity, when the caller must choose it — a
    ///     session a phone asked for is opened under the id the phone already
    ///     shows. Every other caller lets the store mint one.
    public func createSession(
        id: CodeSessionID = CodeSessionID(),
        workspaceID: WorkspaceID?,
        executionRootPath: String? = nil,
        workspaceName: String?,
        title: String,
        configuration: AgentConfiguration,
        gitBranch: String?,
        parentSessionID: CodeSessionID? = nil
    ) throws -> CodeSession {
        try loadIfNeeded()
        guard sessions[id] == nil else {
            throw SessionStoreError.sessionAlreadyExists(id: id.value)
        }
        let now = Date()
        let session = CodeSession(
            id: id,
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

    /// Creates the session's durable goal, or its next one.
    ///
    /// A goal starts active, with ordered pending steps. A goal that is still
    /// open — active, paused or blocked — cannot be replaced, so an agent
    /// cannot erase a completion contract it has not met. A completed goal
    /// can: it has met its contract, its every transition is already in the
    /// transcript, and a session that finished one task used to be told to
    /// set a goal for the next that it could never create.
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
        if let existing = session.goal, existing.lifecycle != .completed {
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

    /// Clears the session's goal at the reader's word (`/goal clear`): it
    /// stops being the session's contract, and a `goal.status` of `cleared`
    /// records that it was set aside, not met. The transcript keeps every
    /// earlier snapshot, so the goal stays readable as history. Returns the
    /// goal that was cleared, or nil when there was none.
    @discardableResult
    public func clearGoal(sessionID: CodeSessionID, reason: String? = nil) throws -> SessionGoal? {
        try loadIfNeeded()
        guard var session = sessions[sessionID] else {
            throw SessionStoreError.sessionNotFound(id: sessionID.value)
        }
        guard let goal = session.goal else { return nil }
        session.goal = nil
        session.updatedAt = Date()
        sessions[sessionID] = session
        try persist(session)
        _ = try appendEvent(
            sessionID: sessionID,
            payload: .goalStatus(GoalStatusEvent(goalID: goal.id, status: .cleared, reason: reason))
        )
        notify(.sessionChanged(session))
        return goal
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
        usageLedgers.removeValue(forKey: id)
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
    private func appendLoadedEvent(
        sessionID: CodeSessionID,
        payload: SessionEventPayload
    ) throws -> SessionEvent {
        guard sessions[sessionID] != nil else {
            throw SessionStoreError.sessionNotFound(id: sessionID.value)
        }
        var index = TranscriptIndex.empty
        let (event, line) = try writeEvent(sessionID: sessionID, payload: payload) { end in
            index = transcriptIndex(for: sessionID, fileLength: end)
            // Not the line count: after a rewind the transcript holds fewer
            // lines than the numbers it has handed out.
            return index.summary.nextSequence
        }
        index.absorb(event, writtenAs: line)
        transcripts[sessionID] = index
        scheduleTranscriptSave(for: sessionID)
        notify(.eventAppended(event))
        return event
    }

    /// Appends the events that close an interrupted run, from inside
    /// `loadIfNeeded()` — which leaves `loaded` false until every session and
    /// repair write succeeds, so this must not re-enter it through the public
    /// `appendEvent` API.
    ///
    /// Numbered from a count of the transcript's lines and the sequence its
    /// last line carries, rather than from its summary. The session list waits
    /// for this, and the summary is the one thing launch must not have to
    /// build: for a session saved before summaries existed, or whose summary a
    /// crash cut short, building it means decoding the whole transcript. None
    /// is installed, then; the launch pass that follows catches the saved one
    /// up with these events, or rebuilds it, off the actor like every other.
    private func appendRepairEvents(
        sessionID: CodeSessionID,
        payloads: [SessionEventPayload]
    ) throws {
        var next: Int?
        for payload in payloads {
            let (event, _) = try writeEvent(sessionID: sessionID, payload: payload) { _ in
                // Counted once: each event written here is one more line.
                let sequence = next ?? TranscriptFiles.nextSequence(
                    eventsURL: eventsURL(sessionID),
                    summaryURL: summaryURL(sessionID)
                )
                next = sequence + 1
                return sequence
            }
            notify(.eventAppended(event))
        }
    }

    /// Writes one event as the transcript's next line.
    ///
    /// - Parameter sequence: the event's sequence, given the file's length
    ///   before the write.
    /// - Returns: the event and the bytes written for it.
    private func writeEvent(
        sessionID: CodeSessionID,
        payload: SessionEventPayload,
        sequence: (Int) -> Int
    ) throws -> (SessionEvent, Data) {
        let url = eventsURL(sessionID)
        do {
            // Opened for update rather than for writing: the last byte has to
            // be read before anything is appended after it.
            let handle = FileManager.default.fileExists(atPath: url.path)
                ? try FileHandle(forUpdating: url)
                : nil
            defer { try? handle?.close() }
            let end = try handle.map { Int(try $0.seekToEnd()) } ?? 0
            let event = SessionEvent(
                sessionID: sessionID,
                sequence: sequence(end),
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
            return (event, line)
        } catch {
            throw SessionStoreError.persistenceFailed(message: String(describing: error))
        }
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

    /// The sequence the session's next event will get: one past the highest
    /// it has used. The relay numbers what it uploads from this and counts its
    /// cursor against it, so it must not be the line count — a rewound
    /// transcript holds fewer lines than the numbers it has handed out, and a
    /// cursor measured against the count would stop uploading until the
    /// transcript grew past where it was before the cut. Read from the
    /// summary, where `events(for:)` would decode the whole file.
    public func nextSequence(for sessionID: CodeSessionID) async -> Int {
        await transcriptSummary(for: sessionID)?.nextSequence ?? 0
    }


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
    /// only for a session whose saved summary is missing or failed its checks
    /// — most often one saved before summaries existed. Launch itself never
    /// comes here: see `appendRepairEvents(sessionID:payloads:)`.
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

    // MARK: - Usage

    /// What the session has spent, as recorded. Empty for a session that has
    /// made no call, or was recorded before the ledger existed.
    public func usageLedger(for id: CodeSessionID) -> SessionUsageLedger {
        if let cached = usageLedgers[id] { return cached }
        let ledger = (try? Data(contentsOf: usageURL(id)))
            .flatMap { try? JSONDecoder().decode(SessionUsageLedger.self, from: $0) }
            ?? SessionUsageLedger()
        usageLedgers[id] = ledger
        return ledger
    }

    /// Adds `usage` to the session's ledger and saves it.
    @discardableResult
    public func recordUsage(_ usage: SessionUsageLedger, for id: CodeSessionID) throws -> SessionUsageLedger {
        try loadIfNeeded()
        guard sessions[id] != nil else {
            throw SessionStoreError.sessionNotFound(id: id.value)
        }
        guard !usage.isEmpty else { return usageLedger(for: id) }
        var ledger = usageLedger(for: id)
        ledger.add(usage)
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(ledger).write(to: usageURL(id), options: .atomic)
        } catch {
            throw SessionStoreError.persistenceFailed(message: String(describing: error))
        }
        usageLedgers[id] = ledger
        notify(.usageChanged(id, ledger))
        return ledger
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

    // MARK: - Rewind

    /// What rewinding the session to just before `turnID` would keep, with
    /// nothing changed. Throws ``ConversationRewindError`` when it cannot be
    /// rewound there.
    public func conversationRewindPlan(
        sessionID: CodeSessionID,
        to turnID: String
    ) async throws -> ConversationRewindPlan {
        try await rewindReading(sessionID: sessionID, to: turnID).plan
    }

    /// The rewind plan, and the transcript length it was made from.
    ///
    /// The transcript is read whole, off the actor, as `events(for:)` reads
    /// it, and that read is also its summary: the plan numbers the restart
    /// from the summary's `nextSequence`, one past the highest sequence the
    /// session ever used, which a transcript rewound before holds fewer lines
    /// than.
    private func rewindReading(
        sessionID: CodeSessionID,
        to turnID: String
    ) async throws -> (plan: ConversationRewindPlan, length: Int) {
        try loadIfNeeded()
        guard sessions[sessionID] != nil else {
            throw SessionStoreError.sessionNotFound(id: sessionID.value)
        }
        let url = eventsURL(sessionID)
        let length = TranscriptFiles.regularFileLength(url) ?? 0
        let decoder = eventDecoder
        let read = await Task.detached(priority: .userInitiated) {
            TranscriptFiles.events(in: url, length: length, decoder: decoder)
        }.value
        let plan = try ConversationRewind.plan(
            rewindingTo: turnID,
            events: read.events,
            conversation: loadConversation(sessionID: sessionID),
            nextSequence: read.index.summary.nextSequence
        )
        return (plan, length)
    }

    /// Cuts the conversation and the transcript back to just before `turnID`.
    ///
    /// The one place the transcript is rewritten rather than appended to, and
    /// only because the reader asked for exactly that. Sequence numbers still
    /// only go up: the cut transcript opens with a ``TranscriptRewoundEvent``
    /// numbered past everything before it, so a reader polling from any
    /// cursor (`protocolEvents(after:)`) receives the restart next rather
    /// than skipping new events whose numbers it has already seen. Observers
    /// in this process are told only that the session changed; a controller
    /// showing this session reloads its events.
    ///
    /// The conversation is written before the transcript. Cut short between
    /// the two, the model has forgotten turns the reader can still see, and a
    /// second rewind refuses as out of sync — rather than the reverse, where
    /// the model would quietly remember turns the reader has removed.
    ///
    /// The transcript is read off the actor, so appends can land while the
    /// plan is made. It is written only if the file is still the length that
    /// was read — checked on the actor, with nothing between the check and the
    /// write — since writing the plan over a longer file would drop what was
    /// appended meanwhile. The summary is then rebuilt from the events
    /// written: the counts, the last activity and the lines and files changed
    /// describe the kept transcript, and `nextSequence` carries on from the
    /// restart.
    @discardableResult
    public func rewindConversation(
        sessionID: CodeSessionID,
        to turnID: String
    ) async throws -> ConversationRewindPlan {
        let (plan, length) = try await rewindReading(sessionID: sessionID, to: turnID)
        guard (TranscriptFiles.regularFileLength(eventsURL(sessionID)) ?? 0) == length else {
            throw SessionStoreError.persistenceFailed(
                message: "The session changed while it was being rewound. Try again."
            )
        }
        try saveConversation(sessionID: sessionID, messages: plan.messages)
        var index = TranscriptIndex.empty
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            var data = Data()
            for event in plan.events {
                var line = try encoder.encode(event)
                line.append(0x0A)
                index.absorb(event, writtenAs: line)
                data.append(line)
            }
            try data.write(to: eventsURL(sessionID), options: .atomic)
        } catch {
            throw SessionStoreError.persistenceFailed(message: String(describing: error))
        }
        transcripts[sessionID] = index
        scheduleTranscriptSave(for: sessionID)
        _ = try updateSession(id: sessionID) { session in
            session.status = plan.status
            session.hasPendingApproval = false
            session.goal = plan.goal
            if plan.status != .failed {
                session.lastErrorSummary = nil
            }
        }
        return plan
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
                // is two events long, so two events are all that is decoded.
                try persist(session)
                let trailingEvents = TranscriptFiles.trailingEvents(
                    in: eventsURL(session.id),
                    limit: 2,
                    decoder: eventDecoder
                )
                let interruption = SessionEventPayload.errorOccurred(
                    ErrorEvent(message: interruptionMessage, isRecoverable: true)
                )
                switch interruptionRepairState(
                    events: trailingEvents,
                    interruptionMessage: interruptionMessage
                ) {
                case .complete:
                    break
                case .missingError:
                    try appendRepairEvents(sessionID: session.id, payloads: [interruption])
                case .missingStatusAndError:
                    try appendRepairEvents(
                        sessionID: session.id,
                        payloads: [
                            .statusChanged(StatusChangedEvent(status: .failed)),
                            interruption,
                        ]
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

    /// The session's transcript on disk, when one has been written — what a
    /// hook receives as `transcript_path`. Nonisolated because it is only a
    /// path: a hook that reads it reads the file, not this actor's memory.
    public nonisolated func transcriptURL(for id: CodeSessionID) -> URL? {
        let url = eventsURL(id)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Where a session's long command output is saved in full, so the model
    /// can page through what did not fit its result. Inside the session's
    /// folder, so it goes when the session does.
    public nonisolated func commandOutputDirectory(for id: CodeSessionID) -> URL {
        sessionDirectory(id).appendingPathComponent("command-output", isDirectory: true)
    }

    private nonisolated func sessionDirectory(_ id: CodeSessionID) -> URL {
        directoryURL.appendingPathComponent("sessions").appendingPathComponent(id.value)
    }

    private nonisolated func eventsURL(_ id: CodeSessionID) -> URL {
        sessionDirectory(id).appendingPathComponent("events.jsonl")
    }

    private func summaryURL(_ id: CodeSessionID) -> URL {
        sessionDirectory(id).appendingPathComponent(TranscriptFiles.summaryFileName)
    }

    private func conversationURL(_ id: CodeSessionID) -> URL {
        sessionDirectory(id).appendingPathComponent("conversation.json")
    }

    private func usageURL(_ id: CodeSessionID) -> URL {
        sessionDirectory(id).appendingPathComponent("usage.json")
    }
}
