import CryptoKit
import Foundation
import XCTest
@testable import JunoAgentProtocol

/// The Swift half of the canonical agent protocol, held to the golden
/// transcripts in `contracts/agent/fixtures` — the same files
/// `tests/agent-protocol.test.ts` holds the TypeScript half to. Read by path
/// rather than copied into the bundle, so there is one set of fixtures and no
/// copy to drift.
final class AgentProtocolFixtureTests: XCTestCase {
    private static let repository = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // …/JunoAgentProtocolTests
        .deletingLastPathComponent()  // …/Tests
        .deletingLastPathComponent()  // …/JunoNativeKit
        .deletingLastPathComponent()  // …/Packages
        .deletingLastPathComponent()  // …/native
        .deletingLastPathComponent()  // the repository
    private static let fixtures = repository.appendingPathComponent("contracts/agent/fixtures")

    private func transcripts() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: Self.fixtures.path)
            .filter { $0.hasSuffix(".jsonl") && $0 != "commands.jsonl" }
            .map { String($0.dropLast(".jsonl".count)) }
            .sorted()
    }

    private func lines(_ name: String) throws -> [String] {
        try String(contentsOf: Self.fixtures.appendingPathComponent("\(name).jsonl"), encoding: .utf8)
            .split(separator: "\n")
            .map(String.init)
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private func object(_ data: Data) throws -> NSObject {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? NSObject)
    }

    func testTheFixturesAreThere() throws {
        let names = try transcripts()
        XCTAssertGreaterThanOrEqual(names.count, 9, "the golden transcripts moved: \(Self.fixtures.path)")
        XCTAssertTrue(names.contains("forward-compat"))
    }

    func testEveryLineAProducerSendsDecodesAndRoundTrips() throws {
        for name in try transcripts() where name != "forward-compat" {
            for (index, line) in try lines(name).enumerated() {
                let event = try XCTUnwrap(AgentEvent.decode(line: line), "\(name).jsonl line \(index + 1) did not decode")
                XCTAssertTrue(event.isKnown, "\(name).jsonl line \(index + 1) decoded as unknown: \(event.type)")
                let original = try object(Data(line.utf8))
                let encoded = try object(try event.jsonData())
                XCTAssertEqual(encoded, original, "\(name).jsonl line \(index + 1) did not round-trip")
            }
        }
    }

    func testEveryTranscriptFoldsToTheSameViewAsTheWeb() throws {
        for name in try transcripts() {
            let events = try lines(name).compactMap { AgentEvent.decode(line: $0) }
            let view = AgentSessionFold.fold(events)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let folded = try object(try encoder.encode(view))
            let golden = try object(Data(contentsOf: Self.fixtures.appendingPathComponent("\(name).folded.json")))
            XCTAssertEqual(folded, golden, "\(name) folds differently in Swift than in TypeScript")
        }
    }

    func testAnOlderReaderSurvivesANewerProducer() throws {
        let raw = try lines("forward-compat")
        func line(_ id: String) throws -> String {
            try XCTUnwrap(raw.first { $0.contains("\"id\":\"\(id)\"") })
        }

        // A type from a future minor is kept whole.
        let hologram = try XCTUnwrap(AgentEvent.decode(line: try line("fc-4")))
        guard case .unknown(let type, let body) = hologram.payload else {
            return XCTFail("an unknown type must decode as .unknown")
        }
        XCTAssertEqual(type, "item.hologram")
        XCTAssertEqual(body["frames"], .number(24))
        XCTAssertEqual(try object(try hologram.jsonData()), try object(Data(try line("fc-4").utf8)))

        // Unknown enum values read as .unknown; a malformed optional is dropped.
        let call = try XCTUnwrap(AgentEvent.decode(line: try line("fc-5")))
        guard case .itemToolCall(let tool) = call.payload else { return XCTFail("tool call") }
        XCTAssertEqual(tool.toolKind, .unknown)
        XCTAssertEqual(tool.risk, .unknown)
        let result = try XCTUnwrap(AgentEvent.decode(line: try line("fc-6")))
        guard case .itemToolResult(let outcome) = result.payload else { return XCTFail("tool result") }
        XCTAssertNil(outcome.durationMs)
        XCTAssertEqual(outcome.exitCode, 0)

        // A newer minor is read; another major, or no envelope, is not an event.
        XCTAssertEqual(AgentEvent.decode(line: try line("fc-7"))?.type, "item.assistant_text")
        XCTAssertNil(AgentEvent.decode(line: try line("fc-9")))
        XCTAssertNil(AgentEvent.decode(line: #"{"hello":"world"}"#))

        // A known type missing a required field is kept, as unknown.
        XCTAssertEqual(AgentEvent.decode(line: try line("fc-8"))?.isKnown, false)
    }

    func testToolOutcomesAreTyped() throws {
        let view = AgentSessionFold.fold(try lines("interrupted-and-failed").compactMap { AgentEvent.decode(line: $0) })
        XCTAssertEqual(view.items.filter { $0.kind == .tool }.map(\.toolStatus), [.unknown, .unknown])
        XCTAssertEqual(view.state, .failed)
        XCTAssertEqual(view.lastError?.code, .providerOverload)
    }

    func testAPendingApprovalIsTheOneAReaderCanAnswer() throws {
        let events = try lines("approvals").compactMap { AgentEvent.decode(line: $0) }
        let firstRequest = try XCTUnwrap(events.firstIndex { $0.type == "approval.requested" })
        let waiting = AgentSessionFold.fold(events[...firstRequest])
        XCTAssertEqual(waiting.state, .awaitingApproval)
        XCTAssertEqual(waiting.pendingApproval?.summary, "rm -rf build")
        let answered = AgentSessionFold.fold(events[...(firstRequest + 1)])
        XCTAssertEqual(answered.state, .running)
        XCTAssertNil(answered.pendingApproval)
    }

    func testCommandsDecodeAndRoundTrip() throws {
        for line in try lines("commands") {
            let command = try JSONDecoder().decode(AgentCommand.self, from: Data(line.utf8))
            XCTAssertTrue(command.isKnown, "\(command.type) decoded as unknown")
            let encoder = JSONEncoder()
            XCTAssertEqual(try object(try encoder.encode(command)), try object(Data(line.utf8)))
        }
    }

    func testTheGeneratedCodeIsFromThisContract() throws {
        let contract = try Data(contentsOf: Self.repository.appendingPathComponent("contracts/agent/juno-agent-protocol-v1.json"))
        let digest = SHA256.hash(data: contract).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(digest, JunoAgentProtocol.digest, "regenerate: npm run agent:protocol")
    }
}
