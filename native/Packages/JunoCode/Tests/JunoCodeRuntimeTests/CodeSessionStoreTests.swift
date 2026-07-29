import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

final class CodeSessionStoreTests: XCTestCase {
    private let interruptionMessage = "Interrupted by app termination."

    func testFailedInterruptedRepairRollsBackAndRetriesOnSameStore() async throws {
        let directory = temporaryStoreDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let seedStore = CodeSessionStore(directoryURL: directory)
        let session = try await createSession(in: seedStore)
        try await seedStore.setStatus(id: session.id, status: .waitingForApproval)

        // Make the transcript target unwritable as a file. Startup can persist
        // the terminal session record, but its first repair event must fail.
        let eventsURL = eventsURL(for: session.id, in: directory)
        try FileManager.default.removeItem(at: eventsURL)
        try FileManager.default.createDirectory(
            at: eventsURL,
            withIntermediateDirectories: false
        )

        let reloadingStore = CodeSessionStore(directoryURL: directory)
        do {
            _ = try await reloadingStore.session(id: session.id)
            XCTFail("Expected the interrupted transcript repair to fail")
        } catch let error as SessionStoreError {
            guard case .persistenceFailed = error else {
                return XCTFail("Unexpected store error: \(error)")
            }
        }

        // Repair the disk obstruction and retry through the same actor. This
        // proves a failed load did not retain a partial index or loaded flag.
        try FileManager.default.removeItem(at: eventsURL)
        let restored = try await reloadingStore.session(id: session.id)
        XCTAssertEqual(restored.status, .failed)
        XCTAssertFalse(restored.hasPendingApproval)
        XCTAssertEqual(restored.lastErrorSummary, interruptionMessage)

        let repairedEvents = await reloadingStore.events(for: session.id)
        XCTAssertEqual(repairedEvents.count, 2)
        assertCanonicalInterruptionSuffix(repairedEvents)

        let secondReload = CodeSessionStore(directoryURL: directory)
        _ = try await secondReload.session(id: session.id)
        let secondReloadEvents = await secondReload.events(for: session.id)
        XCTAssertEqual(
            secondReloadEvents,
            repairedEvents,
            "A completed retry must remain idempotent on another launch"
        )
    }

    func testHalfWrittenInterruptedRepairAppendsOnlyMissingError() async throws {
        let directory = temporaryStoreDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let seedStore = CodeSessionStore(directoryURL: directory)
        let session = try await createSession(in: seedStore)
        try await seedStore.setStatus(id: session.id, status: .running)

        let firstReload = CodeSessionStore(directoryURL: directory)
        _ = try await firstReload.session(id: session.id)
        let completelyRepairedEvents = await firstReload.events(for: session.id)
        assertCanonicalInterruptionSuffix(completelyRepairedEvents)

        // Simulate termination after the failed status event reached disk but
        // before the matching recoverable error event did.
        let eventsURL = eventsURL(for: session.id, in: directory)
        let data = try Data(contentsOf: eventsURL)
        let lines = data.split(separator: 0x0A)
        XCTAssertGreaterThanOrEqual(lines.count, 2)
        var halfWrittenData = Data()
        for line in lines.dropLast() {
            halfWrittenData.append(contentsOf: line)
            halfWrittenData.append(0x0A)
        }
        try halfWrittenData.write(to: eventsURL, options: .atomic)

        let retryingStore = CodeSessionStore(directoryURL: directory)
        _ = try await retryingStore.session(id: session.id)
        let retriedEvents = await retryingStore.events(for: session.id)
        XCTAssertEqual(
            retriedEvents.count,
            completelyRepairedEvents.count,
            "Retry should append the missing error without duplicating failed status"
        )
        XCTAssertEqual(retriedEvents.map(\.sequence), Array(0..<retriedEvents.count))
        assertCanonicalInterruptionSuffix(retriedEvents)

        let finalReload = CodeSessionStore(directoryURL: directory)
        _ = try await finalReload.session(id: session.id)
        let finalReloadEvents = await finalReload.events(for: session.id)
        XCTAssertEqual(finalReloadEvents, retriedEvents)
    }

    private func createSession(in store: CodeSessionStore) async throws -> CodeSession {
        try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Store tests",
            title: "Interrupted session",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    private func temporaryStoreDirectory() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-store-\(UUID().uuidString)")
    }

    private func eventsURL(for sessionID: CodeSessionID, in directory: URL) -> URL {
        directory
            .appendingPathComponent("sessions")
            .appendingPathComponent(sessionID.value)
            .appendingPathComponent("events.jsonl")
    }

    private func assertCanonicalInterruptionSuffix(
        _ events: [SessionEvent],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard events.count >= 2 else {
            return XCTFail("Expected interruption repair events", file: file, line: line)
        }
        if case let .statusChanged(status) = events[events.count - 2].payload {
            XCTAssertEqual(status.status, .failed, file: file, line: line)
        } else {
            XCTFail("Expected failed status event", file: file, line: line)
        }
        if case let .errorOccurred(error) = events[events.count - 1].payload {
            XCTAssertEqual(error.message, interruptionMessage, file: file, line: line)
            XCTAssertTrue(error.isRecoverable, file: file, line: line)
        } else {
            XCTFail("Expected recoverable interruption error", file: file, line: line)
        }
    }
}
