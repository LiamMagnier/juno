import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// A rewind puts the goal, the todo list and the run journal back with the
/// conversation, so a rewound goal keeps no evidence from turns that are
/// gone, and it warns about files a command changed (CODE_AGENT_SPEC §5.6).
@MainActor
final class RewindGoalStateTests: XCTestCase {
    private func todos(_ items: [(String, String)]) -> JSONValue {
        .object(["todos": .array(items.map { id, status in
            .object(["id": .string(id), "content": .string("Step \(id)"), "status": .string(status)])
        })])
    }

    private func latestTodos(_ events: [SessionEvent]) -> [String] {
        let list = events.lazy.reversed().compactMap { event -> TodoListEvent? in
            if case let .todosUpdated(list) = event.payload { return list }
            return nil
        }.first
        return list?.items.map { "\($0.id):\($0.status.rawValue)" } ?? []
    }

    func testRewindingRestoresTheGoalTheTodosAndTheLedger() async throws {
        let model = ShipScriptedModel([
            ShipScriptedModel.call("t1", "todo_write", todos([("a", "in_progress"), ("b", "pending")])),
            ShipScriptedModel.reply("Started."),
            ShipScriptedModel.call("t2", "todo_write", todos([("a", "completed"), ("b", "completed")])),
            ShipScriptedModel.reply("Finished."),
        ])
        let fixture = try await ShipFixture.make(model: model)
        defer { fixture.remove() }
        let (session, controller) = try await fixture.session()
        let store = fixture.workbench.sessionStore
        let goalURL = store.sessionFileURL("goal.json", for: session.id)
        let ledgerURL = store.sessionFileURL("run.json", for: session.id)

        try await fixture.send("Start the work", on: controller)
        // The goal and the ledger as the first turn left them: Lane A writes
        // these; their bytes are all a rewind needs.
        try #"{"status":"active","evidence":[]}"#.write(to: goalURL, atomically: true, encoding: .utf8)
        try #"{"workspaceRevision":1}"#.write(to: ledgerURL, atomically: true, encoding: .utf8)
        XCTAssertEqual(latestTodos(controller.events), ["a:in_progress", "b:pending"])

        try await fixture.send("Finish it", on: controller)
        // The second turn met the goal with evidence from its own checks.
        try #"{"status":"achieved","evidence":["v7"]}"#.write(to: goalURL, atomically: true, encoding: .utf8)
        try #"{"workspaceRevision":4}"#.write(to: ledgerURL, atomically: true, encoding: .utf8)
        XCTAssertEqual(latestTodos(controller.events), ["a:completed", "b:completed"])

        let second = try XCTUnwrap(controller.rewindTurns.last)
        let outcome = await controller.rewind(to: second.id, restoring: .conversation)
        XCTAssertEqual(outcome, .rewound(restoredPaths: []))

        XCTAssertEqual(
            try String(contentsOf: goalURL, encoding: .utf8),
            #"{"status":"active","evidence":[]}"#,
            "the goal is as it stood before the rewound turn, without its evidence"
        )
        XCTAssertEqual(try String(contentsOf: ledgerURL, encoding: .utf8), #"{"workspaceRevision":1}"#)
        XCTAssertEqual(latestTodos(controller.events), ["a:in_progress", "b:pending"], "the todo list goes back too")
    }

    func testAGoalThatDidNotExistBeforeTheTurnIsRemoved() async throws {
        let model = ShipScriptedModel([ShipScriptedModel.reply("One."), ShipScriptedModel.reply("Two.")])
        let fixture = try await ShipFixture.make(model: model)
        defer { fixture.remove() }
        let (session, controller) = try await fixture.session()
        let goalURL = fixture.workbench.sessionStore.sessionFileURL("goal.json", for: session.id)
        try await fixture.send("First", on: controller)
        try await fixture.send("Second", on: controller)
        try #"{"status":"active"}"#.write(to: goalURL, atomically: true, encoding: .utf8)

        let second = try XCTUnwrap(controller.rewindTurns.last)
        _ = await controller.rewind(to: second.id, restoring: .conversation)
        XCTAssertFalse(FileManager.default.fileExists(atPath: goalURL.path), "a goal set in a rewound turn goes")
    }

    func testARewindOverTurnsThatRanCommandsWarns() async throws {
        let model = ShipScriptedModel([
            ShipScriptedModel.reply("Looked."),
            ShipScriptedModel.call("gen", "run_command", ["command": "touch generated.txt"]),
            ShipScriptedModel.reply("Generated."),
        ])
        let fixture = try await ShipFixture.make(model: model)
        defer { fixture.remove() }
        let (_, controller) = try await fixture.session(.fullAccess)
        try await fixture.send("Look around", on: controller)
        try await fixture.send("Generate the file", on: controller)

        let first = try XCTUnwrap(controller.rewindTurns.first)
        let second = try XCTUnwrap(controller.rewindTurns.last)
        let warning = try XCTUnwrap(controller.rewindShellWarning(for: first.id))
        XCTAssertEqual(warning, "These turns ran `touch generated.txt`. Files those commands changed are not restored.")
        XCTAssertNotNil(controller.rewindShellWarning(for: second.id))

        let quiet = ShipScriptedModel([ShipScriptedModel.reply("Only words.")])
        let other = try await ShipFixture.make(model: quiet)
        defer { other.remove() }
        let (_, talker) = try await other.session()
        try await other.send("Just talk", on: talker)
        XCTAssertNil(talker.rewindShellWarning(for: try XCTUnwrap(talker.rewindTurns.first).id))
    }
}
