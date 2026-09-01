import Foundation
import XCTest
@testable import JunoCodeCore

final class JunoCodeCommandLineTests: XCTestCase {
    func testSessionsAndStatusReadOnlyUseHostInventory() async throws {
        let host = CLIHost()
        let client = JunoCodeCommandLine(host: host)

        let sessions = try await client.execute(arguments: ["sessions"])
        let status = try await client.execute(arguments: ["status", "session-a"])

        guard case .sessions(let all) = sessions, case .sessions(let one) = status else {
            return XCTFail("expected session results")
        }
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(one.map(\.id.value), ["session-a"])
        let submitted = await host.submitted
        XCTAssertTrue(submitted.isEmpty)
    }

    func testCancelAndApprovalUseCanonicalEnvelopes() async throws {
        let host = CLIHost()
        let client = JunoCodeCommandLine(host: host)

        _ = try await client.execute(arguments: ["cancel", "host-a", "session-a"])
        _ = try await client.execute(arguments: ["approvals", "host-a", "session-a", "request-a", "true"])

        let submitted = await host.submitted
        XCTAssertEqual(submitted.map(\.kind), [.cancel, .approvalDecision])
        XCTAssertEqual(submitted[1].payload["approvalId"], .string("request-a"))
        XCTAssertEqual(submitted[1].payload["approved"], .bool(true))
    }

    func testRunCreatesAHostSessionWithItsInitialPrompt() async throws {
        let host = CLIHost(createSessionID: "created-a")
        let client = JunoCodeCommandLine(host: host)

        _ = try await client.execute(arguments: ["run", "host-a", "workspace-a", "fix tests"])

        let submitted = await host.submitted
        XCTAssertEqual(submitted.map(\.kind), [.createSession])
        XCTAssertEqual(submitted[0].payload["workspaceId"], .string("workspace-a"))
        XCTAssertEqual(submitted[0].payload["initialMessage"], .string("fix tests"))
    }

    func testRunForwardsModelAndReasoningToTheHost() async throws {
        let host = CLIHost(createSessionID: "created-a")
        let client = JunoCodeCommandLine(host: host)
        _ = try await client.execute(arguments: [
            "run", "host-a", "workspace-a", "fix tests", "--model", "openai:gpt-5", "--reasoning", "high",
        ])
        let submitted = await host.submitted
        let create = try XCTUnwrap(submitted.first)
        XCTAssertEqual(create.payload["modelId"], .string("openai:gpt-5"))
        XCTAssertEqual(create.payload["reasoning"], .string("high"))
    }

    func testInvalidRunOptionNeverCreatesASession() async throws {
        let host = CLIHost(createSessionID: "created-a")
        let client = JunoCodeCommandLine(host: host)
        do {
            _ = try await client.execute(arguments: ["run", "host-a", "workspace-a", "fix", "--unsafe"])
            XCTFail("unknown options must fail before host submission")
        } catch let error as JunoCodeCLIError {
            guard case .usage = error else { return XCTFail("expected usage error") }
        }
        let submitted = await host.submitted
        XCTAssertTrue(submitted.isEmpty)
    }
}

private actor CLIHost: JunoCodeHosting {
    private let createSessionID: String?
    private(set) var submitted: [CodeSessionCommandEnvelope] = []

    init(createSessionID: String? = nil) { self.createSessionID = createSessionID }

    func executionTargets() async throws -> [ExecutionTarget] {
        [ExecutionTarget(id: .init(value: "host-a"), kind: .local, displayName: "This Mac", connectionState: .online)]
    }

    func sessions() async throws -> [CodeSessionSummary] {
        [CodeSessionSummary(
            id: .init(value: "session-a"), targetID: .init(value: "host-a"), title: "Test",
            status: .idle, modelID: "model-a", reasoningEffort: nil, lastEventSequence: 2,
            updatedAt: Date(timeIntervalSince1970: 1)
        )]
    }

    func events(after _: CodeSessionEventCursor) async throws -> [CodeSessionEventEnvelope] { [] }

    func submit(_ command: CodeSessionCommandEnvelope) async throws -> CodeSessionCommandReceipt {
        submitted.append(command)
        let result: [String: JSONValue]? = command.kind == .createSession
            ? createSessionID.map { ["sessionId": .string($0)] } : nil
        return .init(commandID: command.id, idempotencyKey: command.idempotencyKey,
                     disposition: .completed, result: result)
    }
}
