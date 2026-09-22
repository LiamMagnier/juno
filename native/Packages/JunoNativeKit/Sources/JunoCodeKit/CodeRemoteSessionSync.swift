import Foundation
import JunoAuth
import JunoCore

// MARK: - What the host uploads

/// One session as a Mac lists it for Remote: metadata, never content.
///
/// Everything here is what a phone needs to draw a row and decide whether to
/// open it. The transcript itself travels separately, as the session's event
/// journal, so the list can be re-sent whenever a title or a status changes
/// without dragging a transcript along with it.
public struct CodeRemoteSessionUpload: Equatable, Hashable, Sendable {
    public enum Origin: String, Hashable, Sendable {
        /// Started at the Mac.
        case local
        /// Started from another device through the relay.
        case remote
    }

    public let sessionID: String
    /// The workspace's opaque identity — the same key the device registration
    /// advertises — so a phone can group by project without learning a path.
    public let workspaceKey: String?
    public let workspaceName: String?
    public let title: String
    public let modelID: String
    public let reasoningEffort: String?
    public let permissionMode: String
    public let origin: Origin
    public let createdAt: Date
    public let updatedAt: Date
    /// In the relay's vocabulary: `idle`, `running`, `awaiting_approval`,
    /// `completed`, `failed` or `interrupted`.
    public let status: String
    public let activeBranch: String?
    public let lastError: String?

    public init(
        sessionID: String, workspaceKey: String?, workspaceName: String?, title: String,
        modelID: String, reasoningEffort: String?, permissionMode: String, origin: Origin,
        createdAt: Date, updatedAt: Date, status: String, activeBranch: String?,
        lastError: String?
    ) {
        self.sessionID = sessionID
        self.workspaceKey = workspaceKey
        self.workspaceName = workspaceName
        self.title = title
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.permissionMode = permissionMode
        self.origin = origin
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.status = status
        self.activeBranch = activeBranch
        self.lastError = lastError
    }

    /// The body shape `PUT /api/code/devices/:id/sessions` validates. The
    /// search index is the title and the workspace's name only — a list entry
    /// must not become a side channel for the transcript it summarises.
    var relayJSON: JunoJSONValue {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        var object: [String: JunoJSONValue] = [
            "sessionId": .string(sessionID),
            "title": .string(String((trimmedTitle.isEmpty ? "Session" : trimmedTitle).prefix(500))),
            "modelId": .string(String(modelID.prefix(300))),
            "permissionMode": .string(String(permissionMode.prefix(100))),
            "origin": .string(origin.rawValue),
            "createdAt": .string(NativeCodeRemoteClient.timestamp(createdAt)),
            "updatedAt": .string(NativeCodeRemoteClient.timestamp(updatedAt)),
            "lastMessageAt": .string(NativeCodeRemoteClient.timestamp(updatedAt)),
            "currentStatus": .string(status),
            "isRunning": .bool(status == "running"),
            "isAwaitingApproval": .bool(status == "awaiting_approval"),
            "transcriptPolicy": .string("metadata"),
            "indexedSearch": .string(
                [trimmedTitle, workspaceName ?? ""].filter { !$0.isEmpty }.joined(separator: " ")
            ),
        ]
        object["workspaceKey"] = workspaceKey.map { .string(String($0.prefix(200))) } ?? .null
        object["workspaceName"] = workspaceName.map { .string(String($0.prefix(500))) } ?? .null
        object["reasoningEffort"] = reasoningEffort.map { .string(String($0.prefix(100))) } ?? .null
        object["activeBranch"] = activeBranch.map { .string(String($0.prefix(500))) } ?? .null
        object["lastError"] = lastError.map { .string(String($0.prefix(10_000))) } ?? .null
        return .object(object)
    }
}

/// A listed session together with how far its local journal reaches.
public struct CodeRemoteSyncedSession: Equatable, Sendable {
    public let summary: CodeRemoteSessionUpload
    /// The relay sequence the session's uploaded journal should reach: the
    /// number of events it holds locally.
    public let eventCount: Int

    public init(summary: CodeRemoteSessionUpload, eventCount: Int) {
        self.summary = summary
        self.eventCount = eventCount
    }

    /// Working and waiting sessions go first, because those are the ones
    /// somebody holding a phone is actually watching.
    var isActive: Bool {
        summary.status == "running" || summary.status == "awaiting_approval"
    }
}

// MARK: - Seams

/// Where the host's sessions and journals come from.
///
/// A seam rather than a dependency on the Code runtime: this package sits below
/// it, and the uploader's real work — ordering, batching, cursors, retries —
/// is testable only if the transcript can be a fixture.
public protocol CodeRemoteSyncSource: Sendable {
    /// Every session this host lets Remote see, and nothing else. What that set
    /// is belongs to the source; the uploader never widens it.
    ///
    /// Nil when the source cannot say yet — its sessions have not been read.
    /// That is not an empty list: a session missing from an answer is taken
    /// off the phone and loses its cursor, so an answer given before loading
    /// would retract everything this host listed before a relaunch.
    func remoteVisibleSessions() async -> [CodeRemoteSyncedSession]?

    /// Up to `limit` relay events with `seq > afterSequence`, oldest first and
    /// contiguous. The mapping from the local transcript must be deterministic:
    /// the same local history always yields the same events with the same
    /// numbers, which is what lets a retried or re-sent batch be recognised by
    /// the relay as a replay rather than stored twice.
    func relayEvents(
        sessionID: String, after afterSequence: Int, limit: Int
    ) async -> [CodeRemoteSessionEvent]
}

/// The two relay calls the uploader makes.
public protocol CodeRemoteSyncTransport: Sendable {
    func putSessions(
        deviceID: String,
        listVersion: Int,
        sessions: [CodeRemoteSessionUpload],
        deletedSessionIDs: [String],
        for accountID: AccountID
    ) async throws

    /// Returns the relay's high-water mark for the session after the append.
    func postEvents(
        deviceID: String,
        sessionID: String,
        events: [CodeRemoteSessionEvent],
        for accountID: AccountID
    ) async throws -> Int
}

extension NativeCodeRemoteClient: CodeRemoteSyncTransport {}

/// What the uploader remembers across launches.
///
/// Small on purpose: a cursor per session and the set of sessions the relay was
/// last told about. That is enough to resume after a relaunch without
/// re-uploading anything, and to tell the relay which sessions left the list.
public struct CodeRemoteSyncState: Codable, Equatable, Sendable {
    /// The device these cursors describe. A re-paired Mac is a new device with
    /// a new relay row, and a cursor carried across would claim uploads that
    /// row never received.
    public var deviceID: String
    /// Session id → the highest relay sequence the relay has acknowledged.
    public var cursors: [String: Int]
    public var listedSessionIDs: Set<String>
    /// Monotone across launches; the relay records it as the list generation.
    public var listVersion: Int

    public init(
        deviceID: String, cursors: [String: Int] = [:],
        listedSessionIDs: Set<String> = [], listVersion: Int = 0
    ) {
        self.deviceID = deviceID
        self.cursors = cursors
        self.listedSessionIDs = listedSessionIDs
        self.listVersion = listVersion
    }
}

public protocol CodeRemoteSyncStateStoring: Sendable {
    func load() async -> CodeRemoteSyncState?
    func save(_ state: CodeRemoteSyncState) async
}

/// Persists the uploader's state as one encoded blob through two closures, so
/// the app decides where it lives (its preferences) without this package
/// naming a storage API.
public struct CodeRemoteSyncDataStore: CodeRemoteSyncStateStoring {
    private let read: @Sendable () -> Data?
    private let write: @Sendable (Data) -> Void

    public init(
        read: @escaping @Sendable () -> Data?,
        write: @escaping @Sendable (Data) -> Void
    ) {
        self.read = read
        self.write = write
    }

    public func load() async -> CodeRemoteSyncState? {
        guard let data = read() else { return nil }
        return try? JSONDecoder().decode(CodeRemoteSyncState.self, from: data)
    }

    public func save(_ state: CodeRemoteSyncState) async {
        guard let data = try? JSONEncoder().encode(state) else { return }
        write(data)
    }
}

public actor InMemoryCodeRemoteSyncStateStore: CodeRemoteSyncStateStoring {
    public private(set) var state: CodeRemoteSyncState?
    public private(set) var saveCount = 0

    public init(_ state: CodeRemoteSyncState? = nil) {
        self.state = state
    }

    public func load() async -> CodeRemoteSyncState? { state }

    public func save(_ state: CodeRemoteSyncState) async {
        self.state = state
        saveCount += 1
    }
}

// MARK: - The uploader

/// Keeps the relay's copy of this Mac's sessions current: the list, and each
/// listed session's journal, incrementally.
///
/// Without it a phone could send a Mac commands and never see what they did —
/// the Mac claimed and acknowledged, and nothing came back. This is the return
/// path.
///
/// The shape of the problem decides the design:
///
/// - **The local transcript is the buffer.** Events are read from the session's
///   own append-only record when they are sent, not queued in memory as they
///   happen, so an outage or a relaunch loses nothing and there is no queue to
///   overflow.
/// - **Sequences are the host's.** Relay sequence *n* is the session's *n*-th
///   local event, so a batch sent twice carries the same numbers twice and the
///   relay stores it once. The cursor is only an optimisation on top of that:
///   losing it costs one round trip, because the relay answers with the
///   sequence it already holds.
/// - **Explicitly on.** It runs only between `start()` and `stop()`, and checks
///   `isEnabled` before every request, because turning Remote off has to mean
///   nothing further leaves the Mac — including the request that was about to.
public actor CodeRemoteSessionSync {
    public enum Phase: Equatable, Sendable {
        case inactive
        case syncing
        /// The last pass reached the relay and sent everything it had.
        case synced(Date)
        /// The last pass failed; `attempt` drives the delay before the next.
        case retrying(attempt: Int)
        /// Stopped and will not retry — switched off, or the relay no longer
        /// knows this device.
        case stopped(reason: String)
    }

    enum PassOutcome: Equatable {
        /// Everything listed has been sent.
        case complete
        /// A session still has a backlog; run again soon rather than waiting
        /// for the next change.
        case moreWork
        case failed
        case stopped
    }

    public private(set) var phase: Phase = .inactive {
        didSet { reportIfChanged() }
    }
    public private(set) var lastError: String? {
        didSet { reportIfChanged() }
    }
    /// Events the relay has accepted during this process's lifetime.
    public private(set) var uploadedEventCount = 0

    /// One POST. The relay accepts up to 500, and a smaller batch keeps a
    /// single refusal or timeout cheap to repeat.
    public static let maximumBatch = 100
    /// Per session per pass, so one long transcript being backfilled cannot
    /// hold up the session somebody is actually watching.
    static let maximumBatchesPerSessionPerPass = 5
    static let baseBackoff = Duration.seconds(2)
    static let maximumBackoff = Duration.seconds(120)

    private let deviceID: String
    private let accountID: AccountID
    private let source: any CodeRemoteSyncSource
    private let transport: any CodeRemoteSyncTransport
    private let stateStore: any CodeRemoteSyncStateStoring
    private let isEnabled: @Sendable () async -> Bool
    private let debounce: Duration
    private let reconcileInterval: Duration
    private let sleep: @Sendable (Duration) async throws -> Void
    private let jitter: @Sendable () -> Double
    private let now: @Sendable () -> Date
    /// Told when the outcome a person would care about changes — working,
    /// failing, stopped — and not on every pass, so a settings row can say
    /// "your phone is not getting updates" without being told every second
    /// that it is.
    private let onStatus: (@Sendable (Status) -> Void)?
    private var lastReported: Status?

    /// What the uploader's state means to the reader.
    public enum Status: Equatable, Sendable {
        case working
        case failing(String)
        case stopped(String)
    }

    private var state: CodeRemoteSyncState?
    /// What the relay was last told the list is, this launch. Nil after a
    /// relaunch, so the first pass always re-sends it once.
    private var lastListed: [CodeRemoteSessionUpload]?
    private var listDirty = false
    private var changePending = false
    private var loop: Task<Void, Never>?
    private var wake: CheckedContinuation<Void, Never>?
    private var wakeToken = 0

    public init(
        deviceID: String,
        accountID: AccountID,
        source: any CodeRemoteSyncSource,
        transport: any CodeRemoteSyncTransport,
        stateStore: any CodeRemoteSyncStateStoring,
        isEnabled: @escaping @Sendable () async -> Bool = { true },
        debounce: Duration = .milliseconds(750),
        reconcileInterval: Duration = .seconds(60),
        sleep: @escaping @Sendable (Duration) async throws -> Void = {
            try await Task.sleep(for: $0)
        },
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0.5...1.5) },
        now: @escaping @Sendable () -> Date = { Date() },
        onStatus: (@Sendable (Status) -> Void)? = nil
    ) {
        self.deviceID = deviceID
        self.accountID = accountID
        self.source = source
        self.transport = transport
        self.stateStore = stateStore
        self.isEnabled = isEnabled
        self.debounce = debounce
        self.reconcileInterval = reconcileInterval
        self.sleep = sleep
        self.jitter = jitter
        self.now = now
        self.onStatus = onStatus
    }

    private func reportIfChanged() {
        let status: Status? = switch phase {
        case .inactive: nil
        case .syncing: lastReported
        case .synced: .working
        case .retrying: .failing(lastError ?? "Juno could not be reached.")
        case .stopped(let reason): .stopped(reason)
        }
        guard let status, status != lastReported else { return }
        lastReported = status
        onStatus?(status)
    }

    // MARK: Lifecycle

    public func start() {
        guard loop == nil else { return }
        phase = .syncing
        lastError = nil
        changePending = true
        loop = Task { await self.run() }
    }

    /// Stops uploading. Nothing is retracted: the relay keeps what it has, and
    /// a later `start()` resumes from the saved cursors.
    public func stop(reason: String = "Stopped") {
        loop?.cancel()
        loop = nil
        resumeWaiter()
        phase = .stopped(reason: reason)
    }

    /// Stops, then tells the relay to drop every session this Mac listed.
    ///
    /// For the reader switching Remote off at this Mac: "stop sharing" should
    /// take this Mac's sessions off the phone, not leave them there frozen. It
    /// is a single metadata request — tombstones, no content — and best effort:
    /// a Mac that is offline at that moment cannot reach the relay, and says so
    /// through `lastError` rather than pretending it did.
    public func retract() async {
        stop(reason: "Remote was switched off")
        var current = await loadedState()
        guard !current.listedSessionIDs.isEmpty else { return }
        current.listVersion += 1
        do {
            try await transport.putSessions(
                deviceID: deviceID,
                listVersion: current.listVersion,
                sessions: [],
                deletedSessionIDs: current.listedSessionIDs.sorted(),
                for: accountID
            )
            current.listedSessionIDs = []
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
        state = current
        lastListed = nil
        await stateStore.save(current)
    }

    /// Something in a session or the list changed. The next pass runs after
    /// the debounce, so a streaming reply becomes a few batches rather than one
    /// request per token.
    public func noteChange() {
        changePending = true
        resumeWaiter()
    }

    public func backoffDelay(attempt: Int) -> Duration {
        let doublings = min(max(attempt - 1, 0), 6)
        let scaled = Self.baseBackoff * Int(pow(2.0, Double(doublings)))
        return min(scaled, Self.maximumBackoff).scaled(by: jitter())
    }

    // MARK: The loop

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            let outcome = await syncOnce()
            if Task.isCancelled { return }
            switch outcome {
            case .stopped:
                loop = nil
                return
            case .failed:
                attempt += 1
                phase = .retrying(attempt: attempt)
                // A change does not cut a backoff short: the relay that just
                // failed is not more likely to answer because a token arrived.
                try? await sleep(backoffDelay(attempt: attempt))
            case .moreWork:
                attempt = 0
                try? await sleep(debounce)
            case .complete:
                attempt = 0
                await waitForChange()
                if Task.isCancelled { return }
                try? await sleep(debounce)
            }
        }
    }

    /// Parks until `noteChange()` or the reconcile interval, whichever comes
    /// first. The interval is the safety net: a change notification that was
    /// missed still reaches the relay within a minute.
    private func waitForChange() async {
        guard !changePending else { return }
        wakeToken += 1
        let token = wakeToken
        let interval = reconcileInterval
        let sleep = sleep
        let timer = Task { [weak self] in
            try? await sleep(interval)
            await self?.wakeIfCurrent(token)
        }
        await withCheckedContinuation { continuation in
            if changePending || Task.isCancelled {
                continuation.resume()
            } else {
                wake = continuation
            }
        }
        timer.cancel()
    }

    private func wakeIfCurrent(_ token: Int) {
        guard token == wakeToken else { return }
        resumeWaiter()
    }

    private func resumeWaiter() {
        guard let waiter = wake else { return }
        wake = nil
        waiter.resume()
    }

    private func loadedState() async -> CodeRemoteSyncState {
        if let state, state.deviceID == deviceID { return state }
        var loaded = CodeRemoteSyncState(deviceID: deviceID)
        if let stored = await stateStore.load(), stored.deviceID == deviceID {
            loaded = stored
        }
        state = loaded
        return loaded
    }

    // MARK: One pass

    /// Sends the list if it changed, then each listed session's new events.
    func syncOnce() async -> PassOutcome {
        changePending = false
        // Disabled means no request at all, not a request that is ignored.
        guard await isEnabled() else { return .complete }
        phase = .syncing
        var current = await loadedState()
        // Nothing is sent and nothing forgotten until the source can answer:
        // the relay keeps the list and the cursors stay as they were saved.
        // The next change, or the reconcile, asks again.
        guard let sessions = await source.remoteVisibleSessions() else { return .complete }
        let summaries = sessions.map(\.summary)
        let visible = Set(summaries.map(\.sessionID))

        do {
            let leaving = current.listedSessionIDs.subtracting(visible)
            if listDirty || lastListed != summaries || !leaving.isEmpty {
                guard await isEnabled() else { return .complete }
                current.listVersion += 1
                do {
                    try await transport.putSessions(
                        deviceID: deviceID,
                        listVersion: current.listVersion,
                        sessions: summaries,
                        deletedSessionIDs: leaving.sorted(),
                        for: accountID
                    )
                } catch let error as CodeRemoteError
                    where error.statusCode == 404 || error.statusCode == 403
                {
                    // The list route answers 404 only when the device row is
                    // gone: this Mac was unpaired, and nothing it sends will
                    // be stored again until it pairs anew.
                    throw Unpaired(message: error.localizedDescription)
                }
                lastListed = summaries
                listDirty = false
                current.listedSessionIDs = visible
                // A session that left the list keeps no cursor. If it comes
                // back, the relay still holds its journal and says so in the
                // first answer, which costs one batch.
                current.cursors = current.cursors.filter { visible.contains($0.key) }
                state = current
                await stateStore.save(current)
            }

            var backlog = false
            let ordered = sessions.enumerated().sorted { lhs, rhs in
                lhs.element.isActive != rhs.element.isActive
                    ? lhs.element.isActive
                    : lhs.offset < rhs.offset
            }.map(\.element)
            for session in ordered {
                guard await isEnabled() else { return .complete }
                if try await uploadEvents(for: session) { backlog = true }
            }
            phase = .synced(now())
            lastError = nil
            return backlog ? .moreWork : .complete
        } catch let unpaired as Unpaired {
            lastError = unpaired.message
            phase = .stopped(reason: unpaired.message)
            return .stopped
        } catch is CancellationError {
            return .failed
        } catch {
            lastError = error.localizedDescription
            return .failed
        }
    }

    /// Sends one session's events past its cursor. Returns whether any remain.
    private func uploadEvents(for session: CodeRemoteSyncedSession) async throws -> Bool {
        let sessionID = session.summary.sessionID
        var cursor = state?.cursors[sessionID] ?? 0
        var batches = 0
        var rewinds = 0
        while cursor < session.eventCount, batches < Self.maximumBatchesPerSessionPerPass {
            let events = await source.relayEvents(
                sessionID: sessionID, after: cursor, limit: Self.maximumBatch
            )
            guard let last = events.last, events.first?.seq == cursor + 1 else { break }
            guard await isEnabled() else { return false }
            do {
                let acknowledged = try await post(events, sessionID: sessionID)
                // The relay may already hold more than this batch — a cursor
                // lost with the preferences, a second pass racing the first —
                // and its answer is authoritative up to what exists here.
                cursor = max(last.seq, min(acknowledged, session.eventCount))
                batches += 1
            } catch CodeRemoteError.eventSequenceConflict(let expected) {
                // The relay has less than the cursor claims: rewind to what it
                // asked for. Bounded, so two disagreeing answers cannot loop.
                guard rewinds < 2, expected >= 1 else { throw CodeRemoteError.eventSequenceConflict(expectedSequence: expected) }
                rewinds += 1
                cursor = expected - 1
            } catch let error as CodeRemoteError where error.statusCode == 404 {
                // No relay row for this session yet — the list has not landed,
                // or the relay dropped it. Re-list on the next pass.
                listDirty = true
                return false
            } catch let error as CodeRemoteError where error.statusCode == 403 {
                throw Unpaired(message: error.localizedDescription)
            }
            var current = await loadedState()
            current.cursors[sessionID] = cursor
            state = current
            await stateStore.save(current)
        }
        return cursor < session.eventCount
    }

    /// Posts a batch, and if the relay refuses its content, sends it one event
    /// at a time so only the offending event is replaced.
    ///
    /// A refused event cannot simply be skipped — the relay rejects a gap by
    /// design — and it cannot be retried forever, because it will be refused
    /// forever. A small, honest stand-in keeps the journal contiguous and tells
    /// the phone something is missing rather than stalling every later event.
    private func post(_ events: [CodeRemoteSessionEvent], sessionID: String) async throws -> Int {
        do {
            let acknowledged = try await transport.postEvents(
                deviceID: deviceID, sessionID: sessionID, events: events, for: accountID
            )
            uploadedEventCount += events.count
            return acknowledged
        } catch let error as CodeRemoteError where Self.refusesContent(error) {
            var acknowledged = 0
            for event in events {
                do {
                    acknowledged = try await transport.postEvents(
                        deviceID: deviceID, sessionID: sessionID, events: [event], for: accountID
                    )
                } catch let error as CodeRemoteError where Self.refusesContent(error) {
                    acknowledged = try await transport.postEvents(
                        deviceID: deviceID, sessionID: sessionID,
                        events: [Self.standIn(for: event)], for: accountID
                    )
                }
                uploadedEventCount += 1
            }
            return acknowledged
        }
    }

    static func standIn(for event: CodeRemoteSessionEvent) -> CodeRemoteSessionEvent {
        CodeRemoteSessionEvent(
            seq: event.seq,
            kind: "error",
            payload: [
                "message": .string("An update from this Mac was too large to show here. It is on the Mac.")
            ],
            createdAt: event.createdAt
        )
    }

    /// 400 and 413 are about this request's body; retrying it verbatim can
    /// only be refused again.
    static func refusesContent(_ error: CodeRemoteError) -> Bool {
        error.statusCode == 400 || error.statusCode == 413
    }

    /// The device row is gone or no longer this account's. Stopping, rather
    /// than backing off, is the point: retrying is how a revoked Mac keeps
    /// posting at a relay that has already refused it.
    private struct Unpaired: Error {
        let message: String
    }
}
