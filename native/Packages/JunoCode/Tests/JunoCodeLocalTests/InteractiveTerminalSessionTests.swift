import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class InteractiveTerminalSessionTests: XCTestCase {
    private var workspaceURL: URL!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-terminal-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: workspaceURL,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    func testShortLivedCommandStreamsOutputAndExitState() async {
        let terminal = InteractiveTerminalSession(workspaceRootURL: workspaceURL)
        var events: [InteractiveTerminalEvent] = []
        for await event in terminal.start(command: "printf 'ready\\n'") {
            events.append(event)
        }

        XCTAssertTrue(events.contains(.state(.starting)))
        XCTAssertTrue(events.contains { event in
            if case let .state(.running(processID)) = event { return processID > 0 }
            return false
        })
        let output = events.compactMap { event -> String? in
            guard case let .output(text) = event else { return nil }
            return text
        }.joined()
        XCTAssertTrue(output.contains("ready"), "PTY output was: \(output.debugDescription)")
        XCTAssertEqual(events.last, .state(.exited(code: 0)))
        XCTAssertFalse(terminal.state.isRunning)
    }

    func testForbiddenCommandIsRejectedBeforeLaunching() async {
        let terminal = InteractiveTerminalSession(workspaceRootURL: workspaceURL)
        var events: [InteractiveTerminalEvent] = []
        for await event in terminal.start(command: "sudo id") {
            events.append(event)
        }

        XCTAssertEqual(
            events,
            [.state(.starting), .state(.failed(reason: "'sudo' is never run by the agent."))]
        )
        XCTAssertFalse(terminal.state.isRunning)
    }
}
