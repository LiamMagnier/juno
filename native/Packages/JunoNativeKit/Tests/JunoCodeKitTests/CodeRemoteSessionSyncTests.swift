import Foundation
import JunoAuth
import JunoCore
import XCTest

@testable import JunoCodeKit

/// The return path of Remote: what a Mac uploads so a phone can see what its
/// commands did. These pin the properties a phone depends on — nothing leaves
/// while Remote is off, events arrive once and in order, and an outage or a
/// relaunch neither loses nor repeats anything.
final class CodeRemoteSessionSyncTests: XCTestCase {
    private let account = try! AccountID("account-a")

    // MARK: - Off means off

    func testNothingIsUploadedWhileRemoteIsSwitchedOff() async {
        let source = SyncSource([session("s1", events: 12)])
        let relay = SyncRelay()
        let sync = makeSync(source: source, relay: relay, enabled: false)

        let outcome = await sync.syncOnce()

        XCTAssertEqual(outcome, .complete)
        let requests = await relay.requestCount
        XCTAssertEqual(requests, 0, "a disabled host must not make a single request")
        let reads = await source.eventReads
        XCTAssertEqual(reads, 0, "nor read a transcript it is not going to send")
    }

    func testAStoppedSyncMakesNoFurtherRequests() async throws {
        let source = SyncSource([session("s1", events: 3)])
        let relay = SyncRelay()
        let sync = makeSync(source: source, relay: relay)

        await sync.start()
        try await settle { await relay.storedCount(for: "s1") == 3 }
        await sync.stop()
        try? await Task.sleep(for: .milliseconds(30))
        let before = await relay.requestCount

        await source.appendEvents(to: "s1", count: 5)
        await sync.noteChange()
        try? await Task.sleep(for: .milliseconds(60))

        let after = await relay.requestCount
        XCTAssertEqual(before, after, "a stopped sync must not upload what happens next")
    }

    // MARK: - The list

    func testTheListIsSentOnceAndThenOnlyWhenItChanges() async {
        let source = SyncSource([session("s1", events: 0)])
        let relay = SyncRelay()
        let sync = makeSync(source: source, relay: relay)

        _ = await sync.syncOnce()
        _ = await sync.syncOnce()
        var puts = await relay.puts
        XCTAssertEqual(puts.count, 1, "an unchanged list is not re-sent")

        await source.retitle("s1", "Fix the login flow")
        _ = await sync.syncOnce()
        puts = await relay.puts
        XCTAssertEqual(puts.count, 2)
        XCTAssertEqual(puts.map(\.listVersion), [1, 2], "each list is a new generation")
        XCTAssertEqual(puts.last?.titles, ["Fix the login flow"])
    }

    func testASessionThatLeavesTheListIsTombstonedNotLeftBehind() async {
        let source = SyncSource([session("s1", events: 0), session("s2", events: 0)])
        let relay = SyncRelay()
        let sync = makeSync(source: source, relay: relay)

        _ = await sync.syncOnce()
        await source.remove("s2")
        _ = await sync.syncOnce()

        let puts = await relay.puts
        XCTAssertEqual(puts.last?.sessionIDs, ["s1"])
        XCTAssertEqual(puts.last?.deleted, ["s2"])
    }

    func testRetractingTakesEverySessionOffThePhone() async {
        let source = SyncSource([session("s1", events: 2), session("s2", events: 0)])
        let relay = SyncRelay()
        let store = InMemoryCodeRemoteSyncStateStore()
        let sync = makeSync(source: source, relay: relay, store: store)

        _ = await sync.syncOnce()
        await sync.retract()

        let puts = await relay.puts
        XCTAssertEqual(puts.last?.sessionIDs, [])
        XCTAssertEqual(puts.last?.deleted, ["s1", "s2"])
        let saved = await store.state
        XCTAssertEqual(saved?.listedSessionIDs, [], "a retracted list is not remembered as listed")
    }

    /// A relaunch reaches the uploader before the host has read its sessions.
    /// An answer then is not "this Mac has no sessions": taking it at its word
    /// tombstoned every session the phone was showing and dropped every
    /// cursor, so the next pass re-sent each transcript's first batch.
    func testASourceThatHasNotLoadedChangesNothingOnTheRelay() async {
        let source = SyncSource(
            [session("s1", events: 40), session("s2", events: 12)], loaded: false
        )
        let relay = SyncRelay(stored: ["s1": 30, "s2": 12])
        let saved = CodeRemoteSyncState(
            deviceID: "device-1", cursors: ["s1": 30, "s2": 12],
            listedSessionIDs: ["s1", "s2"], listVersion: 7
        )
        let store = InMemoryCodeRemoteSyncStateStore(saved)
        let sync = makeSync(source: source, relay: relay, store: store)

        let outcome = await sync.syncOnce()

        XCTAssertEqual(outcome, .complete)
        let requests = await relay.requestCount
        XCTAssertEqual(requests, 0, "no list, no tombstones, no events")
        let afterUnloaded = await store.state
        XCTAssertEqual(afterUnloaded, saved, "the cursors and the listed set survive")

        await source.load()
        _ = await sync.syncOnce()

        let puts = await relay.puts
        XCTAssertEqual(puts.count, 1)
        XCTAssertEqual(puts.first?.sessionIDs, ["s1", "s2"])
        XCTAssertEqual(puts.first?.deleted, [], "nothing still here is taken off the phone")
        XCTAssertEqual(puts.first?.listVersion, 8, "the generation carries on from the saved one")
        let posts = await relay.posts
        XCTAssertEqual(posts.map(\.sessionID), ["s1"], "a session already uploaded is not sent again")
        XCTAssertEqual(posts.first?.seqs.first, 31, "the other resumes from its cursor")
    }

    // MARK: - Events

    func testEventsGoInOrderedBatchesFromTheCursor() async {
        let source = SyncSource([session("s1", events: 250)])
        let relay = SyncRelay()
        let store = InMemoryCodeRemoteSyncStateStore()
        let sync = makeSync(source: source, relay: relay, store: store)

        let outcome = await sync.syncOnce()

        XCTAssertEqual(outcome, .complete)
        let posts = await relay.posts
        XCTAssertEqual(posts.map(\.seqs.first), [1, 101, 201])
        XCTAssertEqual(posts.map(\.seqs.count), [100, 100, 50])
        XCTAssertTrue(posts.allSatisfy { $0.seqs.count <= CodeRemoteSessionSync.maximumBatch })
        let stored = await relay.storedSeqs(for: "s1")
        XCTAssertEqual(stored, Array(1...250))
        let saved = await store.state
        XCTAssertEqual(saved?.cursors["s1"], 250, "the cursor is saved as batches land")
    }

    func testABatchOfLargeEventsIsCutToWhatTheRelayAccepts() async {
        // A hundred 20 KB events is 2 MB: the relay refuses a body over 1 MB,
        // and the fallback for a refusal is one POST per event.
        let chunk = String(repeating: "x", count: 20_000)
        let source = SyncSource([session("s1", events: 100)], text: { _ in chunk })
        let relay = SyncRelay()
        let sync = makeSync(source: source, relay: relay)

        let outcome = await sync.syncOnce()

        XCTAssertEqual(outcome, .complete)
        let posts = await relay.posts
        XCTAssertGreaterThan(posts.count, 1)
        XCTAssertLessThan(posts.count, 10, "cut to fit, not sent one at a time")
        for post in posts {
            XCTAssertLessThanOrEqual(post.seqs.count * 20_000, CodeRemoteSessionSync.maximumBatchBytes)
        }
        let stored = await relay.storedSeqs(for: "s1")
        XCTAssertEqual(stored, Array(1...100), "every event, once, in order")
        XCTAssertEqual(CodeRemoteSessionSync.withinByteBudget([]).count, 0)
    }

    func testOnlyNewEventsAreSentOnTheNextPass() async {
        let source = SyncSource([session("s1", events: 10)])
        let relay = SyncRelay()
        let sync = makeSync(source: source, relay: relay)

        _ = await sync.syncOnce()
        await source.appendEvents(to: "s1", count: 4)
        _ = await sync.syncOnce()

        let posts = await relay.posts
        XCTAssertEqual(posts.last?.seqs, [11, 12, 13, 14])
    }

    func testAWorkingSessionIsSentBeforeABacklog() async {
        let source = SyncSource([
            session("old", events: 1_000),
            session("live", events: 3, status: "running"),
        ])
        let relay = SyncRelay()
        let sync = makeSync(source: source, relay: relay)

        let outcome = await sync.syncOnce()

        let posts = await relay.posts
        XCTAssertEqual(posts.first?.sessionID, "live", "the session being watched goes first")
        XCTAssertEqual(
            posts.filter { $0.sessionID == "old" }.count,
            CodeRemoteSessionSync.maximumBatchesPerSessionPerPass,
            "one long transcript cannot monopolise a pass"
        )
        XCTAssertEqual(outcome, .moreWork, "a backlog asks for another pass straight away")
    }

    // MARK: - Resuming

    func testARelaunchResumesFromTheSavedCursorWithoutReuploading() async {
        let source = SyncSource([session("s1", events: 150)])
        let relay = SyncRelay()
        let store = InMemoryCodeRemoteSyncStateStore()

        _ = await makeSync(source: source, relay: relay, store: store).syncOnce()
        let before = await relay.posts.count

        // A new process: same saved state, same relay, more local history.
        await source.appendEvents(to: "s1", count: 20)
        _ = await makeSync(source: source, relay: relay, store: store).syncOnce()

        let posts = await relay.posts
        XCTAssertEqual(posts.count, before + 1)
        XCTAssertEqual(posts.last?.seqs.first, 151, "resumes after the saved cursor")
        XCTAssertEqual(posts.last?.seqs.last, 170)
    }

    func testALostCursorCostsOneRoundTripNotAReupload() async {
        let source = SyncSource([session("s1", events: 170)])
        let relay = SyncRelay(stored: ["s1": 150])
        let sync = makeSync(source: source, relay: relay)

        _ = await sync.syncOnce()

        let posts = await relay.posts
        XCTAssertEqual(posts.map(\.seqs.first), [1, 151], "the relay's answer moves the cursor past what it holds")
        let stored = await relay.storedSeqs(for: "s1")
        XCTAssertEqual(stored, Array(1...170), "nothing is stored twice")
    }

    func testACursorAheadOfTheRelayRewindsToWhatItAsksFor() async {
        let source = SyncSource([session("s1", events: 180)])
        let relay = SyncRelay(stored: ["s1": 100])
        let store = InMemoryCodeRemoteSyncStateStore(
            CodeRemoteSyncState(deviceID: "device-1", cursors: ["s1": 150], listedSessionIDs: ["s1"])
        )
        let sync = makeSync(source: source, relay: relay, store: store)

        let outcome = await sync.syncOnce()

        XCTAssertEqual(outcome, .complete)
        let stored = await relay.storedSeqs(for: "s1")
        XCTAssertEqual(stored, Array(1...180), "the hole the saved cursor would have left is filled")
    }

    func testCursorsForAnotherDeviceAreNotTrusted() async {
        let source = SyncSource([session("s1", events: 5)])
        let relay = SyncRelay()
        let store = InMemoryCodeRemoteSyncStateStore(
            CodeRemoteSyncState(deviceID: "a-previous-pairing", cursors: ["s1": 5])
        )
        let sync = makeSync(source: source, relay: relay, store: store)

        _ = await sync.syncOnce()

        let stored = await relay.storedSeqs(for: "s1")
        XCTAssertEqual(stored, Array(1...5), "a re-paired Mac uploads to its new row from the start")
    }

    // MARK: - Failure

    func testATransientFailureSendsNothingTwiceAndResumes() async {
        let source = SyncSource([session("s1", events: 30)])
        let relay = SyncRelay()
        let sync = makeSync(source: source, relay: relay)
        await relay.failNextPosts(1, with: .server(statusCode: 503, message: "down", retryable: true))

        let first = await sync.syncOnce()
        XCTAssertEqual(first, .failed)
        var stored = await relay.storedSeqs(for: "s1")
        XCTAssertEqual(stored, [])

        let second = await sync.syncOnce()
        XCTAssertEqual(second, .complete)
        stored = await relay.storedSeqs(for: "s1")
        XCTAssertEqual(stored, Array(1...30))
        let posted = await relay.posts.flatMap(\.seqs)
        XCTAssertEqual(posted, Array(1...30), "the failed batch was not half-sent")
    }

    func testTheLoopBacksOffAfterAFailure() async throws {
        let source = SyncSource([session("s1", events: 2)])
        let relay = SyncRelay()
        await relay.failNextPosts(2, with: .server(statusCode: 502, message: "down", retryable: true))
        let sleeps = SleepRecorder()
        let sync = CodeRemoteSessionSync(
            deviceID: "device-1", accountID: account, source: source, transport: relay,
            stateStore: InMemoryCodeRemoteSyncStateStore(),
            debounce: .milliseconds(1), reconcileInterval: .seconds(60),
            sleep: { duration in
                await sleeps.record(duration)
                try await Task.sleep(for: .milliseconds(1))
            },
            jitter: { 1 }
        )

        await sync.start()
        try await settle { await relay.storedCount(for: "s1") == 2 }
        await sync.stop()

        let recorded = await sleeps.durations
        XCTAssertTrue(recorded.contains(.seconds(2)), "first retry waits the base delay")
        XCTAssertTrue(recorded.contains(.seconds(4)), "the second waits longer")
        let capped = await sync.backoffDelay(attempt: 40)
        XCTAssertLessThanOrEqual(capped, CodeRemoteSessionSync.maximumBackoff)
    }

    /// A settings row says "your phone is not getting updates" from this, so
    /// it must report a failure once, and the recovery once — not every pass.
    func testStatusIsReportedOnlyWhenItChanges() async throws {
        let source = SyncSource([session("s1", events: 2)])
        let relay = SyncRelay()
        await relay.failNextPosts(2, with: .server(statusCode: 503, message: "Relay down", retryable: true))
        let reports = StatusRecorder()
        let sync = CodeRemoteSessionSync(
            deviceID: "device-1", accountID: account, source: source, transport: relay,
            stateStore: InMemoryCodeRemoteSyncStateStore(),
            debounce: .milliseconds(1), reconcileInterval: .milliseconds(20),
            sleep: { _ in try await Task.sleep(for: .milliseconds(1)) },
            jitter: { 1 },
            onStatus: { reports.record($0) }
        )

        await sync.start()
        try await settle { await relay.storedCount(for: "s1") == 2 }
        try? await Task.sleep(for: .milliseconds(40))
        await sync.stop()
        try? await Task.sleep(for: .milliseconds(20))

        let statuses = reports.statuses
        XCTAssertEqual(
            Array(statuses.prefix(2)),
            [.failing("Relay down"), .working],
            "one report for the outage, one for the recovery"
        )
    }

    func testARefusedEventIsReplacedSoLaterEventsStillArrive() async {
        let source = SyncSource([session("s1", events: 10)])
        let relay = SyncRelay()
        await relay.refuseContent(ofSeq: 5)
        let sync = makeSync(source: source, relay: relay)

        let outcome = await sync.syncOnce()

        XCTAssertEqual(outcome, .complete)
        let stored = await relay.storedSeqs(for: "s1")
        XCTAssertEqual(stored, Array(1...10), "one oversized event does not stall the journal")
        let standIn = await relay.storedKind(for: "s1", seq: 5)
        XCTAssertEqual(standIn, "error", "the gap is announced rather than hidden")
    }

    func testAMissingRelayRowIsListedAgainOnTheNextPass() async {
        let source = SyncSource([session("s1", events: 3)])
        let relay = SyncRelay()
        await relay.forgetSession("s1")
        let sync = makeSync(source: source, relay: relay)

        _ = await sync.syncOnce()
        var puts = await relay.puts.count
        XCTAssertEqual(puts, 1)
        _ = await sync.syncOnce()
        puts = await relay.puts.count
        XCTAssertEqual(puts, 2, "a 404 on events re-sends the list even though it did not change")
    }

    func testAnUnpairedMacStopsInsteadOfRetrying() async {
        let source = SyncSource([session("s1", events: 3)])
        let relay = SyncRelay()
        await relay.refuseList(status: 404)
        let sync = makeSync(source: source, relay: relay)

        let outcome = await sync.syncOnce()

        XCTAssertEqual(outcome, .stopped)
        guard case .stopped = await sync.phase else {
            return XCTFail("a device the relay no longer has must stop the sync")
        }
    }

    func testTheListCarriesNoPathOrTranscript() {
        let upload = CodeRemoteSessionUpload(
            sessionID: "s1", workspaceKey: "ws-key", workspaceName: "juno", title: "Fix login",
            modelID: "anthropic:claude-sonnet-5", reasoningEffort: "high",
            permissionMode: "askBeforeChanges", origin: .remote,
            createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 60),
            status: "awaiting_approval", activeBranch: "main", lastError: nil
        )
        guard case .object(let object) = upload.relayJSON else { return XCTFail("not an object") }
        XCTAssertEqual(object["sessionId"], .string("s1"))
        XCTAssertEqual(object["workspaceKey"], .string("ws-key"))
        XCTAssertEqual(object["isAwaitingApproval"], .bool(true))
        XCTAssertEqual(object["isRunning"], .bool(false))
        XCTAssertEqual(object["origin"], .string("remote"))
        XCTAssertEqual(object["transcriptPolicy"], .string("metadata"))
        XCTAssertEqual(object["indexedSearch"], .string("Fix login juno"))
        XCTAssertNil(object["transcript"])
        XCTAssertNil(object["workspacePath"])
    }

    // MARK: - Helpers

    private func session(
        _ id: String, events: Int, status: String = "idle", title: String = "Session"
    ) -> CodeRemoteSyncedSession {
        CodeRemoteSyncedSession(
            summary: CodeRemoteSessionUpload(
                sessionID: id, workspaceKey: "ws-1", workspaceName: "juno", title: title,
                modelID: "model", reasoningEffort: nil, permissionMode: "askBeforeChanges",
                origin: .local, createdAt: Date(timeIntervalSince1970: 0),
                updatedAt: Date(timeIntervalSince1970: 0), status: status,
                activeBranch: nil, lastError: nil
            ),
            eventCount: events
        )
    }

    private func makeSync(
        source: SyncSource,
        relay: SyncRelay,
        store: InMemoryCodeRemoteSyncStateStore = InMemoryCodeRemoteSyncStateStore(),
        enabled: Bool = true
    ) -> CodeRemoteSessionSync {
        CodeRemoteSessionSync(
            deviceID: "device-1",
            accountID: account,
            source: source,
            transport: relay,
            stateStore: store,
            isEnabled: { enabled },
            debounce: .milliseconds(1),
            reconcileInterval: .milliseconds(20),
            sleep: { try await Task.sleep(for: min($0, .milliseconds(2))) },
            jitter: { 1 }
        )
    }

    private func settle(_ condition: @escaping () async -> Bool) async throws {
        for _ in 0..<400 {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("condition never became true")
    }
}

// MARK: - Fixtures

/// Records synchronously, in the order the uploader reported.
private final class StatusRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [CodeRemoteSessionSync.Status] = []

    var statuses: [CodeRemoteSessionSync.Status] { lock.withLock { recorded } }
    func record(_ status: CodeRemoteSessionSync.Status) { lock.withLock { recorded.append(status) } }
}

private actor SleepRecorder {
    private(set) var durations: [Duration] = []
    func record(_ duration: Duration) { durations.append(duration) }
}

/// A host's sessions, with journals that are a pure function of their length —
/// the determinism the real projection promises.
private actor SyncSource: CodeRemoteSyncSource {
    private var sessions: [CodeRemoteSyncedSession]
    /// False plays a host whose sessions have not been read yet.
    private var isLoaded: Bool
    /// The text each event carries; a long one plays a reply or a terminal tail.
    private let text: @Sendable (Int) -> String
    private(set) var eventReads = 0

    init(_ sessions: [CodeRemoteSyncedSession], loaded: Bool = true, text: @escaping @Sendable (Int) -> String = { "e\($0)" }) {
        self.sessions = sessions
        self.isLoaded = loaded
        self.text = text
    }

    func remoteVisibleSessions() async -> [CodeRemoteSyncedSession]? {
        isLoaded ? sessions : nil
    }

    func load() { isLoaded = true }

    func relayEvents(
        sessionID: String, after afterSequence: Int, limit: Int
    ) async -> [CodeRemoteSessionEvent] {
        eventReads += 1
        guard let count = sessions.first(where: { $0.summary.sessionID == sessionID })?.eventCount,
            afterSequence < count
        else { return [] }
        let end = min(count, afterSequence + limit)
        return ((afterSequence + 1)...end).map { seq in
            CodeRemoteSessionEvent(
                seq: seq, kind: "text_delta", payload: ["text": .string(text(seq))],
                createdAt: Date(timeIntervalSince1970: TimeInterval(seq))
            )
        }
    }

    func appendEvents(to sessionID: String, count: Int) {
        guard let index = sessions.firstIndex(where: { $0.summary.sessionID == sessionID }) else { return }
        let current = sessions[index]
        sessions[index] = CodeRemoteSyncedSession(summary: current.summary, eventCount: current.eventCount + count)
    }

    func retitle(_ sessionID: String, _ title: String) {
        guard let index = sessions.firstIndex(where: { $0.summary.sessionID == sessionID }) else { return }
        let old = sessions[index].summary
        sessions[index] = CodeRemoteSyncedSession(
            summary: CodeRemoteSessionUpload(
                sessionID: old.sessionID, workspaceKey: old.workspaceKey, workspaceName: old.workspaceName,
                title: title, modelID: old.modelID, reasoningEffort: old.reasoningEffort,
                permissionMode: old.permissionMode, origin: old.origin, createdAt: old.createdAt,
                updatedAt: old.updatedAt, status: old.status, activeBranch: old.activeBranch,
                lastError: old.lastError
            ),
            eventCount: sessions[index].eventCount
        )
    }

    func remove(_ sessionID: String) {
        sessions.removeAll { $0.summary.sessionID == sessionID }
    }
}

/// The relay's append rules, as `planSessionEventAppend` implements them: a
/// replay is skipped, a gap is refused with the sequence it needs.
private actor SyncRelay: CodeRemoteSyncTransport {
    struct Put: Equatable {
        let listVersion: Int
        let sessionIDs: [String]
        let titles: [String]
        let deleted: [String]
    }

    struct Post: Equatable {
        let sessionID: String
        let seqs: [Int]
    }

    private(set) var puts: [Put] = []
    private(set) var posts: [Post] = []
    private(set) var requestCount = 0
    private var stored: [String: [Int: String]] = [:]
    private var pendingFailures: [CodeRemoteError] = []
    private var refusedSeqs: Set<Int> = []
    private var forgotten: Set<String> = []
    private var listRefusal: Int?

    init(stored: [String: Int] = [:]) {
        for (session, last) in stored where last > 0 {
            self.stored[session] = Dictionary(uniqueKeysWithValues: (1...last).map { ($0, "text_delta") })
        }
    }

    func failNextPosts(_ count: Int, with error: CodeRemoteError) {
        pendingFailures.append(contentsOf: Array(repeating: error, count: count))
    }

    func refuseContent(ofSeq seq: Int) { refusedSeqs.insert(seq) }
    func forgetSession(_ id: String) { forgotten.insert(id) }
    func refuseList(status: Int) { listRefusal = status }

    func storedSeqs(for sessionID: String) -> [Int] { (stored[sessionID] ?? [:]).keys.sorted() }
    func storedCount(for sessionID: String) -> Int { stored[sessionID]?.count ?? 0 }
    func storedKind(for sessionID: String, seq: Int) -> String? { stored[sessionID]?[seq] }

    func putSessions(
        deviceID: String, listVersion: Int, sessions: [CodeRemoteSessionUpload],
        deletedSessionIDs: [String], for accountID: AccountID
    ) async throws {
        requestCount += 1
        if let listRefusal {
            throw CodeRemoteError.server(statusCode: listRefusal, message: "Not found", retryable: false)
        }
        puts.append(Put(
            listVersion: listVersion, sessionIDs: sessions.map(\.sessionID),
            titles: sessions.map(\.title), deleted: deletedSessionIDs
        ))
    }

    func postEvents(
        deviceID: String, sessionID: String, events: [CodeRemoteSessionEvent],
        for accountID: AccountID
    ) async throws -> Int {
        requestCount += 1
        if !pendingFailures.isEmpty { throw pendingFailures.removeFirst() }
        if forgotten.contains(sessionID) {
            forgotten.remove(sessionID)
            throw CodeRemoteError.server(statusCode: 404, message: "Session not found", retryable: false)
        }
        if events.contains(where: { refusedSeqs.contains($0.seq) && $0.kind != "error" }) {
            throw CodeRemoteError.server(statusCode: 400, message: "Invalid input", retryable: false)
        }
        posts.append(Post(sessionID: sessionID, seqs: events.map(\.seq)))
        var journal = stored[sessionID] ?? [:]
        let last = journal.keys.max() ?? 0
        var expected = last + 1
        for event in events.sorted(by: { $0.seq < $1.seq }) where event.seq > last {
            guard event.seq == expected else {
                throw CodeRemoteError.eventSequenceConflict(expectedSequence: expected)
            }
            expected += 1
        }
        for event in events where event.seq > last { journal[event.seq] = event.kind }
        stored[sessionID] = journal
        return journal.keys.max() ?? 0
    }
}
