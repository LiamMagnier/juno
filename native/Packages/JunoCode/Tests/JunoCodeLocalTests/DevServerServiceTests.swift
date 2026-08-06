import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class DevServerServiceTests: XCTestCase {
    private var workspaceURL: URL!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-preview-service-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: workspaceURL,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    private func collectEvents(
        from service: DevServerService,
        command: String
    ) async -> [DevServerEvent] {
        var events: [DevServerEvent] = []
        for await event in service.start(command: command, workspaceRoot: workspaceURL) {
            events.append(event)
        }
        return events
    }

    func testEmptyCommandFailsWithoutStartingAProcess() async {
        let service = DevServerService()

        let events = await collectEvents(from: service, command: " \n\t ")

        XCTAssertEqual(events, [.state(.failed(reason: "No command to run."))])
        XCTAssertFalse(service.isRunning)
        XCTAssertNil(service.runningCommand)
    }

    func testForbiddenCommandIsRefusedBeforeLaunching() async {
        let service = DevServerService()

        let events = await collectEvents(from: service, command: "sudo id")

        XCTAssertEqual(
            events,
            [.state(.failed(reason: "'sudo' is never run by the agent."))]
        )
        XCTAssertFalse(service.isRunning)
    }

    func testShortLivedOutputIsSanitizedRedactedAndUsedForURLDetection() async throws {
        let service = DevServerService()
        let token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
        let command = "printf '%b\\n' '\\033[36mLocal: http://0.0.0.0:4567/ token=\(token)\\033[0m'"

        let events = await collectEvents(from: service, command: command)

        XCTAssertTrue(events.contains(.state(.starting)))
        XCTAssertTrue(
            events.contains(.state(.running(URL(string: "http://localhost:4567/")!)))
        )
        XCTAssertEqual(events.last, .state(.exited(code: 0)))

        let lines = events.compactMap { event -> DevServerLogLine? in
            guard case let .line(line) = event else { return nil }
            return line
        }
        let line = try XCTUnwrap(lines.first)
        XCTAssertTrue(line.text.contains("Local: http://0.0.0.0:4567/"))
        XCTAssertTrue(line.text.contains(SecretRedactor.placeholder))
        XCTAssertFalse(line.text.contains(token))
    }

    func testServerEnvironmentUsesAStableScrubbedPreviewEnvironment() {
        setenv("JUNO_TEST_SECRET_TOKEN", "must-not-leak", 1)
        defer { unsetenv("JUNO_TEST_SECRET_TOKEN") }

        let environment = DevServerService.serverEnvironment(workspaceRoot: workspaceURL.path)

        XCTAssertEqual(
            environment["PATH"],
            "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
        )
        XCTAssertEqual(environment["PWD"], workspaceURL.path)
        XCTAssertEqual(environment["BROWSER"], "none")
        XCTAssertEqual(environment["FORCE_COLOR"], "0")
        XCTAssertEqual(environment["NO_COLOR"], "1")
        XCTAssertEqual(environment["TERM"], "dumb")
       XCTAssertNil(environment["JUNO_TEST_SECRET_TOKEN"])
   }

    func testContainedFactoryReportsTheActualKernelBoundary() {
        let service = DevServerService.contained(workspaceRootURL: workspaceURL)
        XCTAssertEqual(service.isContained, CommandSandboxProfile.isAvailable)
    }

    func testFailureReasonExplainsMissingToolsWhenTheScrubbedPathIsLikely() {
        let reason = DevServerService.failureReason(
            exitCode: 127,
            wasSignal: false,
            recent: ["zsh: vite: command not found"]
        )

        XCTAssertTrue(reason.contains("Exited with code 127 without serving an address."))
        XCTAssertTrue(reason.contains("zsh: vite: command not found"))
        XCTAssertTrue(reason.contains("scrubbed PATH"))
    }
}
