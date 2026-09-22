import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// Counts every transcript line the store decodes, so "listing does not read
/// transcripts" is a number rather than a hope.
private final class DecodeCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func increment() {
        lock.lock()
        storage += 1
        lock.unlock()
    }

    var decoder: SessionEventLineDecoder {
        SessionEventLineDecoder { [self] line in
            increment()
            return SessionEventLineDecoder.standard.decode(line)
        }
    }
}

final class CodeSessionStoreSummaryTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-store-summary-\(UUID().uuidString)")
        directory = root
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    }

    // MARK: - Listing

    func testListingManySessionsDecodesNoTranscript() async throws {
        let seed = makeStore()
        var expected: [CodeSessionID: Int] = [:]
        for index in 0..<40 {
            let session = try await createSession(in: seed, title: "Session \(index)")
            for turn in 0..<(index % 5 + 1) {
                try await seed.appendEvent(
                    sessionID: session.id,
                    payload: .userPrompt(UserPromptEvent(text: "Prompt \(turn)"))
                )
                try await seed.appendEvent(
                    sessionID: session.id,
                    payload: .assistantMessage(AssistantMessageEvent(text: "Reply \(turn)"))
                )
            }
            expected[session.id] = 1 + (index % 5 + 1) * 2
        }
        await seed.saveTranscriptSummaries()

        let counter = DecodeCounter()
        let relaunched = makeStore(counter: counter)
        let listed = await relaunched.allSessions()
        XCTAssertEqual(listed.count, 40)
        // The launch pass checks every saved summary against its transcript;
        // with every summary current, that is a read of each file's last few
        // hundred bytes and no decoding at all.
        await relaunched.awaitTranscriptMaintenance()
        for session in listed {
            let summary = await relaunched.transcriptSummary(for: session.id)
            XCTAssertEqual(summary?.eventCount, expected[session.id])
            XCTAssertEqual(summary?.messageCount, (expected[session.id] ?? 1) - 1)
        }
        XCTAssertEqual(counter.count, 0, "listing sessions must not decode a single event")
    }

    // MARK: - Incremental maintenance

    func testSummaryFollowsEveryAppend() async throws {
        let counter = DecodeCounter()
        let store = makeStore(counter: counter)
        let session = try await createSession(in: store)
        let created = await store.transcriptSummary(for: session.id)
        XCTAssertEqual(created?.eventCount, 1, "the sessionCreated event")
        XCTAssertEqual(created?.messageCount, 0)

        try await store.appendEvent(
            sessionID: session.id,
            payload: .userPrompt(UserPromptEvent(text: "Tidy the parser"))
        )
        try await store.appendEvent(
            sessionID: session.id,
            payload: .userInstruction(UserInstructionEvent(text: "Skip the tests", kind: .steer))
        )
        try await store.appendEvent(
            sessionID: session.id,
            payload: .toolOutput(ToolOutputEvent(toolCallID: "call-1", channel: .stdout, text: "ok"))
        )
        try await store.appendEvent(
            sessionID: session.id,
            payload: .fileChanged(fileChange("Sources/Parser.swift", added: 3, removed: 1))
        )
        try await store.appendEvent(
            sessionID: session.id,
            payload: .fileChanged(fileChange("Sources/Parser.swift", added: 2, removed: 0))
        )
        try await store.appendEvent(
            sessionID: session.id,
            payload: .fileChanged(fileChange("Sources/Lexer.swift", added: 1, removed: 4))
        )
        let last = try await store.appendEvent(
            sessionID: session.id,
            payload: .assistantMessage(AssistantMessageEvent(text: "Done."))
        )

        // Bound before unwrapping: `XCTUnwrap` takes an autoclosure, which
        // cannot await.
        let maintained = await store.transcriptSummary(for: session.id)
        let summary = try XCTUnwrap(maintained)
        XCTAssertEqual(summary.eventCount, 8)
        XCTAssertEqual(last.sequence, 7)
        XCTAssertEqual(summary.messageCount, 3)
        XCTAssertEqual(summary.linesAdded, 6)
        XCTAssertEqual(summary.linesRemoved, 5)
        XCTAssertEqual(summary.filesChanged, 2, "a file edited twice is one file")
        XCTAssertEqual(summary.lastEventAt, last.timestamp)
        XCTAssertEqual(counter.count, 0, "an append folds in the event it wrote, never re-reads")

        // Written atomically on the save that follows appends, and read back
        // by the next launch as it is, without touching the transcript.
        await store.saveTranscriptSummaries()
        XCTAssertTrue(FileManager.default.fileExists(atPath: summaryURL(session.id).path))
        let relaunchCounter = DecodeCounter()
        let relaunched = makeStore(counter: relaunchCounter)
        let reread = await relaunched.transcriptSummary(for: session.id)
        XCTAssertEqual(reread?.eventCount, summary.eventCount)
        XCTAssertEqual(reread?.messageCount, summary.messageCount)
        XCTAssertEqual(reread?.linesAdded, summary.linesAdded)
        XCTAssertEqual(reread?.linesRemoved, summary.linesRemoved)
        XCTAssertEqual(reread?.filesChanged, summary.filesChanged)
        XCTAssertEqual(relaunchCounter.count, 0)
    }

    func testSummaryLeftBehindByACrashCatchesUpFromTheTail() async throws {
        let seed = makeStore()
        let session = try await createSession(in: seed)
        for index in 0..<10 {
            try await seed.appendEvent(
                sessionID: session.id,
                payload: .userPrompt(UserPromptEvent(text: "Prompt \(index)"))
            )
        }
        await seed.saveTranscriptSummaries()
        // Three more reach the transcript but not the summary: the app quit
        // inside the save delay.
        for index in 0..<3 {
            try await seed.appendEvent(
                sessionID: session.id,
                payload: .assistantMessage(AssistantMessageEvent(text: "Reply \(index)"))
            )
        }

        let counter = DecodeCounter()
        let relaunched = makeStore(counter: counter)
        _ = await relaunched.allSessions()
        await relaunched.awaitTranscriptMaintenance()
        let summary = await relaunched.transcriptSummary(for: session.id)
        XCTAssertEqual(summary?.eventCount, 14)
        XCTAssertEqual(summary?.messageCount, 13)
        XCTAssertEqual(counter.count, 3, "only the events the saved summary had not seen are read")

        let next = try await relaunched.appendEvent(
            sessionID: session.id,
            payload: .userPrompt(UserPromptEvent(text: "After relaunch"))
        )
        XCTAssertEqual(next.sequence, 14)
    }

    // MARK: - Self-healing

    func testMissingSummaryIsRebuiltInTheBackground() async throws {
        let seed = makeStore()
        let session = try await createSession(in: seed)
        for index in 0..<4 {
            try await seed.appendEvent(
                sessionID: session.id,
                payload: .userPrompt(UserPromptEvent(text: "Prompt \(index)"))
            )
        }
        await seed.saveTranscriptSummaries()
        try FileManager.default.removeItem(at: summaryURL(session.id))

        let counter = DecodeCounter()
        let relaunched = makeStore(counter: counter)
        let listed = await relaunched.allSessions()
        XCTAssertEqual(listed.map(\.id), [session.id], "listing does not wait for the rebuild")
        await relaunched.awaitTranscriptMaintenance()
        XCTAssertEqual(counter.count, 5, "rebuilt from the transcript, once")
        let summary = await relaunched.transcriptSummary(for: session.id)
        XCTAssertEqual(summary?.eventCount, 5)
        XCTAssertEqual(summary?.messageCount, 4)

        await relaunched.saveTranscriptSummaries()
        XCTAssertTrue(FileManager.default.fileExists(atPath: summaryURL(session.id).path))
        let thirdCounter = DecodeCounter()
        let third = makeStore(counter: thirdCounter)
        _ = await third.allSessions()
        await third.awaitTranscriptMaintenance()
        XCTAssertEqual(thirdCounter.count, 0, "a rebuilt summary is trusted from then on")
    }

    func testCorruptSummaryIsRebuilt() async throws {
        let seed = makeStore()
        let session = try await createSession(in: seed)
        try await seed.appendEvent(
            sessionID: session.id,
            payload: .userPrompt(UserPromptEvent(text: "Prompt"))
        )
        await seed.saveTranscriptSummaries()
        try Data("{\"formatVersion\": 1, \"byteCount\":".utf8).write(to: summaryURL(session.id))

        let counter = DecodeCounter()
        let relaunched = makeStore(counter: counter)
        _ = await relaunched.allSessions()
        await relaunched.awaitTranscriptMaintenance()
        let summary = await relaunched.transcriptSummary(for: session.id)
        XCTAssertEqual(summary?.eventCount, 2)
        XCTAssertEqual(summary?.messageCount, 1)
        XCTAssertEqual(counter.count, 2)
    }

    /// A summary is trusted for the bytes it covers only while they are still
    /// the bytes it saw. A transcript rewritten to exactly the same length —
    /// restored from a backup, say — must not keep the old account of itself.
    func testSummaryOfARewrittenTranscriptIsNotTrusted() async throws {
        let seed = makeStore()
        let session = try await createSession(in: seed)
        try await seed.appendEvent(
            sessionID: session.id,
            payload: .fileChanged(fileChange("README.md", added: 3, removed: 0))
        )
        await seed.saveTranscriptSummaries()

        let eventsURL = eventsURL(session.id)
        let original = try String(contentsOf: eventsURL, encoding: .utf8)
        let rewritten = original.replacingOccurrences(of: "\"linesAdded\":3", with: "\"linesAdded\":7")
        XCTAssertNotEqual(rewritten, original)
        XCTAssertEqual(rewritten.utf8.count, original.utf8.count)
        try rewritten.write(to: eventsURL, atomically: true, encoding: .utf8)

        let relaunched = makeStore()
        _ = await relaunched.allSessions()
        await relaunched.awaitTranscriptMaintenance()
        let summary = await relaunched.transcriptSummary(for: session.id)
        XCTAssertEqual(summary?.linesAdded, 7)
        XCTAssertEqual(summary?.eventCount, 2)
    }

    /// A session that was running when the app died is repaired at launch,
    /// which needs to know how its transcript ends — and only that.
    func testInterruptedSessionRepairReadsOnlyTheEndOfItsTranscript() async throws {
        let seed = makeStore()
        let session = try await createSession(in: seed)
        for index in 0..<200 {
            try await seed.appendEvent(
                sessionID: session.id,
                payload: .userPrompt(UserPromptEvent(text: "Prompt \(index)"))
            )
        }
        try await seed.setStatus(id: session.id, status: .running)
        await seed.saveTranscriptSummaries()

        let counter = DecodeCounter()
        let relaunched = makeStore(counter: counter)
        let listed = await relaunched.allSessions()
        XCTAssertEqual(listed.first?.status, .failed)
        XCTAssertEqual(counter.count, 2, "the last two events, not all two hundred and two")

        let summary = await relaunched.transcriptSummary(for: session.id)
        XCTAssertEqual(summary?.eventCount, 204, "the repair's two events are counted")
        let opened = await relaunched.events(for: session.id)
        XCTAssertEqual(opened.map(\.sequence), Array(0..<204))
    }

    // MARK: - Sessions saved before summaries existed

    func testLegacySessionIsListedWithoutDecodingAndSummarisedAfterwards() async throws {
        let session = CodeSession(
            workspaceID: WorkspaceID(),
            title: "Written by an older build",
            status: .completed,
            configuration: AgentConfiguration(modelID: "test-model"),
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_700_000_100)
        )
        let events: [SessionEventPayload] = [
            .userPrompt(UserPromptEvent(text: "Rename the module")),
            .fileChanged(fileChange("Package.swift", added: 1, removed: 1)),
            .assistantMessage(AssistantMessageEvent(text: "Renamed.")),
        ]
        // Three events, a line no build can decode, and one more event: the
        // unreadable line still took a sequence number when it was written.
        try writeLegacySession(session, lines: [
            try encodedLine(events[0], session: session.id, sequence: 0),
            try encodedLine(events[1], session: session.id, sequence: 1),
            try encodedLine(events[2], session: session.id, sequence: 2),
            Data("not an event".utf8),
            try encodedLine(
                .userPrompt(UserPromptEvent(text: "And the tests")),
                session: session.id,
                sequence: 4
            ),
        ])
        XCTAssertFalse(FileManager.default.fileExists(atPath: summaryURL(session.id).path))

        let counter = DecodeCounter()
        let store = makeStore(counter: counter)
        let listed = await store.allSessions()
        XCTAssertEqual(listed.map(\.title), ["Written by an older build"])
        await store.awaitTranscriptMaintenance()
        let summary = await store.transcriptSummary(for: session.id)
        XCTAssertEqual(summary?.eventCount, 5)
        XCTAssertEqual(summary?.messageCount, 3)
        XCTAssertEqual(summary?.linesAdded, 1)
        XCTAssertEqual(summary?.filesChanged, 1)

        await store.saveTranscriptSummaries()
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: summaryURL(session.id).path),
            "the launch pass writes the summary an older build never did"
        )

        let appended = try await store.appendEvent(
            sessionID: session.id,
            payload: .assistantMessage(AssistantMessageEvent(text: "Tests updated."))
        )
        XCTAssertEqual(appended.sequence, 5)
        let opened = await store.events(for: session.id)
        XCTAssertEqual(opened.map(\.sequence), [0, 1, 2, 4, 5])
    }

    func testFirstAppendToALegacySessionNumbersFromItsTranscript() async throws {
        let session = CodeSession(
            workspaceID: nil,
            title: "Older",
            configuration: AgentConfiguration(modelID: "test-model"),
            createdAt: Date(),
            updatedAt: Date()
        )
        try writeLegacySession(session, lines: try (0..<4).map { index in
            try encodedLine(
                .userPrompt(UserPromptEvent(text: "Prompt \(index)")),
                session: session.id,
                sequence: index
            )
        })

        // No wait for the launch pass: the append has to find the right number
        // on its own, whether or not the pass got there first.
        let store = makeStore()
        let appended = try await store.appendEvent(
            sessionID: session.id,
            payload: .assistantMessage(AssistantMessageEvent(text: "Reply"))
        )
        XCTAssertEqual(appended.sequence, 4)
        let opened = await store.events(for: session.id)
        XCTAssertEqual(opened.map(\.sequence), [0, 1, 2, 3, 4])
    }

    /// A crash mid-write leaves a line with no newline. The next event must
    /// start on a line of its own rather than be welded onto the fragment.
    func testAppendAfterAPartialLastLineStartsANewLine() async throws {
        let session = CodeSession(
            workspaceID: nil,
            title: "Interrupted write",
            configuration: AgentConfiguration(modelID: "test-model"),
            createdAt: Date(),
            updatedAt: Date()
        )
        let first = try encodedLine(
            .userPrompt(UserPromptEvent(text: "Prompt")),
            session: session.id,
            sequence: 0
        )
        let second = try encodedLine(
            .assistantMessage(AssistantMessageEvent(text: "Reply")),
            session: session.id,
            sequence: 1
        )
        try writeLegacySession(
            session,
            lines: [first, second],
            trailing: Data("{\"id\":\"cut-sh".utf8)
        )

        let store = makeStore()
        let appended = try await store.appendEvent(
            sessionID: session.id,
            payload: .userPrompt(UserPromptEvent(text: "Again"))
        )
        XCTAssertEqual(appended.sequence, 3, "the fragment still took a sequence number")
        let opened = await store.events(for: session.id)
        XCTAssertEqual(opened.map(\.sequence), [0, 1, 3])
        let summary = await store.transcriptSummary(for: session.id)
        XCTAssertEqual(summary?.eventCount, 4)
    }

    // MARK: - Opening and deleting

    func testOpeningAListedSessionReturnsItsWholeTranscript() async throws {
        let seed = makeStore()
        let session = try await createSession(in: seed)
        let other = try await createSession(in: seed, title: "Other")
        var written: [SessionEvent] = []
        for index in 0..<6 {
            written.append(try await seed.appendEvent(
                sessionID: session.id,
                payload: .userPrompt(UserPromptEvent(text: "Prompt \(index)"))
            ))
        }
        try await seed.appendEvent(
            sessionID: other.id,
            payload: .userPrompt(UserPromptEvent(text: "Elsewhere"))
        )
        await seed.saveTranscriptSummaries()

        let counter = DecodeCounter()
        let relaunched = makeStore(counter: counter)
        _ = await relaunched.allSessions()
        await relaunched.awaitTranscriptMaintenance()
        XCTAssertEqual(counter.count, 0)

        let opened = await relaunched.events(for: session.id)
        XCTAssertEqual(opened.count, 7)
        XCTAssertEqual(opened.map(\.sequence), Array(0..<7))
        XCTAssertEqual(Array(opened.dropFirst()).map(\.id), written.map(\.id))
        XCTAssertEqual(Array(opened.dropFirst()).map(\.payload), written.map(\.payload))
        XCTAssertEqual(counter.count, 7, "opening decodes that session's transcript and no other")
    }

    func testDeleteRemovesTranscriptAndSummary() async throws {
        let store = makeStore()
        let session = try await createSession(in: store)
        try await store.appendEvent(
            sessionID: session.id,
            payload: .userPrompt(UserPromptEvent(text: "Prompt"))
        )
        await store.saveTranscriptSummaries()
        XCTAssertTrue(FileManager.default.fileExists(atPath: eventsURL(session.id).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: summaryURL(session.id).path))

        // An append after the last save leaves a summary waiting to be written;
        // deleting must not let that write bring the directory back.
        try await store.appendEvent(
            sessionID: session.id,
            payload: .assistantMessage(AssistantMessageEvent(text: "Reply"))
        )
        try await store.deleteSession(id: session.id)
        await store.saveTranscriptSummaries()

        let directory = eventsURL(session.id).deletingLastPathComponent()
        XCTAssertFalse(FileManager.default.fileExists(atPath: eventsURL(session.id).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: summaryURL(session.id).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        let summary = await store.transcriptSummary(for: session.id)
        XCTAssertNil(summary)

        let relaunched = makeStore()
        let listed = await relaunched.allSessions()
        XCTAssertTrue(listed.isEmpty)
    }

    // MARK: - Helpers

    /// A save delay long enough that no timer fires inside a test: every write
    /// of a summary here is one the test asked for.
    private func makeStore(counter: DecodeCounter? = nil) -> CodeSessionStore {
        CodeSessionStore(
            directoryURL: directory,
            eventDecoder: counter?.decoder ?? .standard,
            transcriptSaveDelay: .seconds(3_600)
        )
    }

    private func createSession(
        in store: CodeSessionStore,
        title: String = "Summary tests"
    ) async throws -> CodeSession {
        try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Store",
            title: title,
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    private func fileChange(_ path: String, added: Int, removed: Int) -> FileChangedEvent {
        FileChangedEvent(
            path: try! WorkspacePath(path),
            kind: .modified,
            linesAdded: added,
            linesRemoved: removed,
            checkpointID: nil
        )
    }

    private func sessionDirectory(_ id: CodeSessionID) -> URL {
        directory.appendingPathComponent("sessions").appendingPathComponent(id.value)
    }

    private func eventsURL(_ id: CodeSessionID) -> URL {
        sessionDirectory(id).appendingPathComponent("events.jsonl")
    }

    private func summaryURL(_ id: CodeSessionID) -> URL {
        sessionDirectory(id).appendingPathComponent("summary.json")
    }

    /// The bytes an older build wrote for one event: the same encoder
    /// settings the store has always used.
    private func encodedLine(
        _ payload: SessionEventPayload,
        session: CodeSessionID,
        sequence: Int
    ) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(
            SessionEvent(sessionID: session, sequence: sequence, timestamp: Date(), payload: payload)
        )
    }

    /// Lays a session out on disk exactly as a build without summaries did:
    /// the record and the transcript, nothing else.
    private func writeLegacySession(
        _ session: CodeSession,
        lines: [Data],
        trailing: Data = Data()
    ) throws {
        let folder = sessionDirectory(session.id)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(session).write(to: folder.appendingPathComponent("session.json"))
        var transcript = Data()
        for line in lines {
            transcript.append(line)
            transcript.append(0x0A)
        }
        transcript.append(trailing)
        try transcript.write(to: folder.appendingPathComponent("events.jsonl"))
    }
}
