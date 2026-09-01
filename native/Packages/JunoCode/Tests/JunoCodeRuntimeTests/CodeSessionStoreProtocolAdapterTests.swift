import Foundation
import XCTest
@testable import JunoCodeCore
@testable import JunoCodeRuntime

final class CodeSessionStoreProtocolAdapterTests: XCTestCase {
    func testProtocolEventsPreserveIdsAndResumeFromOneBasedCursor() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-code-protocol-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = CodeSessionStore(directoryURL: directory)
        let session = try await store.createSession(
            workspaceID: nil,
            workspaceName: nil,
            title: "Protocol test",
            configuration: AgentConfiguration(modelID: "test"),
            gitBranch: nil
        )
        let second = try await store.appendEvent(
            sessionID: session.id,
            payload: .userPrompt(UserPromptEvent(text: "Resume safely"))
        )

        let all = await store.protocolEvents(
            after: CodeSessionEventCursor(sessionID: session.id, afterSequence: 0)
        )
        XCTAssertEqual(all.map(\.sequence), [1, 2])
        XCTAssertEqual(all[1].id, second.id)

        let resumed = await store.protocolEvents(
            after: CodeSessionEventCursor(sessionID: session.id, afterSequence: 1)
        )
        XCTAssertEqual(resumed.map(\.sequence), [2])
        XCTAssertEqual(resumed.first?.id, second.id)
    }
}
