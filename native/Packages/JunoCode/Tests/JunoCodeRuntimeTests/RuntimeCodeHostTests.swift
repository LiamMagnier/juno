import Foundation
import XCTest
@testable import JunoCodeCore
@testable import JunoCodeRuntime

final class RuntimeCodeHostTests: XCTestCase {
    func testReplayExecutesOnceAndReturnsOriginalReceipt() async throws {
        let calls = Counter()
        let target = target()
        let host = RuntimeCodeHost(
            targets: { [target] },
            events: { _ in [] },
            execute: { command in
                await calls.increment()
                return CodeSessionCommandReceipt(
                    commandID: command.id, idempotencyKey: command.idempotencyKey,
                    disposition: .completed, result: ["accepted": true]
                )
            }
        )
        let command = command(targetID: target.id)
        let first = try await host.submit(command)
        let second = try await host.submit(command)
        XCTAssertEqual(first, second)
        let count = await calls.value
        XCTAssertEqual(count, 1)
    }

    func testOfflineTargetCannotExecute() async throws {
        var configuredTarget = target()
        configuredTarget.connectionState = .offline
        let offline = configuredTarget
        let host = RuntimeCodeHost(targets: { [offline] }, events: { _ in [] }, execute: { _ in
            XCTFail("offline target must not execute")
            throw CancellationError()
        })
        await XCTAssertThrowsErrorAsync(try await host.submit(command(targetID: offline.id))) { error in
            XCTAssertEqual(error as? RuntimeCodeHostError, .unavailableTarget(offline.id))
        }
    }

    func testSessionsAreHostOwnedAndDeterministicallyOrdered() async throws {
        let target = target()
        let older = Date(timeIntervalSince1970: 100)
        let newer = Date(timeIntervalSince1970: 200)
        let host = RuntimeCodeHost(
            targets: { [target] },
            sessions: {
                [
                    CodeSessionSummary(
                        id: CodeSessionID(value: "older"), targetID: target.id, title: "Older",
                        status: .idle, modelID: "model-a", reasoningEffort: nil,
                        lastEventSequence: 2, updatedAt: older
                    ),
                    CodeSessionSummary(
                        id: CodeSessionID(value: "newer"), targetID: target.id, title: "Newer",
                        status: .running, modelID: "model-a", reasoningEffort: nil,
                        lastEventSequence: 3, updatedAt: newer
                    ),
                ]
            },
            events: { _ in [] }, execute: { _ in throw CancellationError() }
        )

        let sessions = try await host.sessions()
        XCTAssertEqual(sessions.map(\.id.value), ["newer", "older"])
    }

    private func target() -> ExecutionTarget {
        ExecutionTarget(
            id: ExecutionTargetID(value: "host-a"), kind: .local, displayName: "This Mac",
            hostID: "host-a", capabilities: [.workspaceAccess, .approvals, .sessionResume],
            connectionState: .online, protocolVersion: .current
        )
    }

    private func command(targetID: ExecutionTargetID) -> CodeSessionCommandEnvelope {
        CodeSessionCommandEnvelope(
            id: "command-a", idempotencyKey: "retry-a", targetID: targetID,
            sessionID: CodeSessionID(value: "session-a"), kind: .cancel
        )
    }
}

private actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}

private func XCTAssertThrowsErrorAsync(
    _ expression: @autoclosure () async throws -> some Any,
    _ handler: (any Error) -> Void
) async {
    do { _ = try await expression(); XCTFail("expected error") }
    catch { handler(error) }
}
